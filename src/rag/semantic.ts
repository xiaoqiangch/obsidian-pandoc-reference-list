import { App } from 'obsidian';
import { LayoutHit } from './retrieval';
import { ragLog } from './log';

export interface SemanticHit {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  similarity: number;
  citekey?: string;
  layoutHits?: LayoutHit[];
}

/**
 * Optional semantic retrieval by reusing shadow-writer-plus' vault-wide vector
 * index at runtime. Returns [] when the plugin is unavailable, not configured,
 * or errors, so the caller can silently fall back to BM25.
 */
export async function semanticSearch(
  app: App,
  query: string,
  scopeFolder?: string
): Promise<SemanticHit[]> {
  try {
    const sp = (app.plugins.plugins as any)['shadow-writer-plus'];
    if (!sp || typeof sp.getRAGEngine !== 'function') return [];

    const rag = await sp.getRAGEngine();
    const results = await rag.processQuery({
      query,
      scope: scopeFolder ? { folders: [scopeFolder] } : undefined,
    });

    const hits: SemanticHit[] = [];
    for (const r of Array.isArray(results) ? results : []) {
      const meta = r.metadata || {};
      const startLine = typeof meta.startLine === 'number' ? meta.startLine : -1;
      const endLine = typeof meta.endLine === 'number' ? meta.endLine : -1;
      const citekey =
        r.path && r.path.startsWith(scopeFolder + '/') && r.path.endsWith('.md')
          ? r.path.replace(/\.md$/, '').split('/').pop()
          : undefined;
      hits.push({
        path: r.path,
        content: typeof r.content === 'string' ? r.content : '',
        startLine,
        endLine,
        similarity: typeof r.similarity === 'number' ? r.similarity : 0,
        citekey,
      });
    }
    return hits;
  } catch (e) {
    ragLog('RagSemantic', 'semanticSearch failed', e);
    return [];
  }
}
