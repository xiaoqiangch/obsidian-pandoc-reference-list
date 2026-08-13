/**
 * convert-all-cli: batch-convert every PDF / EPUB attachment referenced by the
 * loaded bibliography (and Zotero) into markdown, exactly like clicking
 * "转换MD" per entry in the Bib Manager plugin.
 *
 * This CLI is a thin wrapper around the plugin's own batch-conversion module
 * (src/converter/convertAll.ts), so it shares the exact same enumeration,
 * state tracking, MinerU quota handling, and progress logic as the
 * "一键批量转换" button in the plugin settings panel. It runs in a standalone
 * Node process by constructing a plugin-shaped object from the vault's
 * data.json + bibliography, then delegating to convertAll.ts.
 *
 * It shares the same ConversionStateManager cache
 * (~/.bib-manager-index/<vaultHash>/conversion-state.json), so conversions
 * already completed in the plugin are skipped and interrupted runs resume.
 *
 * Usage:
 *   node convert-all.cjs [--dry-run] [--limit N] [--only a,b] [--start-from k] [--force]
 *
 * Configuration is read from the Obsidian vault plugin data.json by default
 * (discovered under the vault root) and can be overridden via env:
 *   BIB_MANAGER_VAULT_ROOT  absolute vault root
 *   MINERU_API_TOKEN        MinerU token (falls back to data.json mineruApiToken)
 *   CONVERT_OUTPUT_PATH     default 'literature'
 *
 * PDFs prefer the MinerU cloud API and automatically fall back to the local
 * mineru CLI when the cloud is unavailable.
 */
import { setGlobalApp } from './obsidian-shim';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ---- Plugin pipeline imports (reused verbatim) ----
import { bibToCSL, getItemJSONFromCiteKeys, isZoteroRunning, parseBibFileField } from '../src/bib/helpers';
import { collectAttachmentStats, buildBatchQueue, runBatchConversion, getBatchProgress } from '../src/converter/convertAll';
import type { PartialCSLEntry } from '../src/bib/types';

// pdf.js needs a worker to load PDF metadata. In the standalone CLI we point
// it at a locally-shipped copy of the worker (placed next to the bundle by the
// build script).
let _pdfjsConfigured = false;
function configurePdfjsWorker(): void {
  if (_pdfjsConfigured) return;
  _pdfjsConfigured = true;
  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const candidates = [
      path.join(__dirname, 'pdf.worker.min.js'),
      path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        pdfjs.GlobalWorkerOptions.workerSrc = c;
        return;
      }
    }
  } catch {
    // fall back to the plugin build's worker resolution
  }
}

interface VaultSettings {
  pathToPandoc?: string;
  pathToBibliography?: string;
  bibliographyPaths?: string[];
  convertOutputPath?: string;
  mineruApiToken?: string;
  deepseekApiKey?: string;
  zoteroPort?: string;
  zoteroGroups?: { id: number; name: string }[];
  pullFromZotero?: boolean;
}

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'PROGRESS', msg: string, data?: any): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function resolveVaultRoot(): Promise<string> {
  if (process.env.BIB_MANAGER_VAULT_ROOT) return process.env.BIB_MANAGER_VAULT_ROOT;
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'Obsidian_Brain'),
    path.join(home, 'Documents', 'Obsidian'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.obsidian'))) return c;
  }
  throw new Error(
    'Cannot locate the Obsidian vault. Set BIB_MANAGER_VAULT_ROOT to the vault root.'
  );
}

async function loadSettings(vaultRoot: string): Promise<VaultSettings> {
  const dataPath = path.join(vaultRoot, '.obsidian', 'plugins', 'bib-manager-obsidian', 'data.json');
  if (!fs.existsSync(dataPath)) {
    log('WARN', `Plugin data.json not found at ${dataPath}; using defaults + env.`);
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    return raw as VaultSettings;
  } catch (e: any) {
    log('ERROR', `Failed to parse plugin data.json: ${e.message}`);
    return {};
  }
}

interface CliOptions {
  dryRun: boolean;
  limit?: number;
  force: boolean;
  startFrom?: string;
  only?: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit' || a === '-n') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--start-from') opts.startFrom = argv[++i];
    else if (a === '--only') opts.only = argv[++i].split(',');
  }
  return opts;
}

/**
 * Build the Zotero attachment links map (citekey -> [paths]) for entries that
 * have no local bib `file` field, mirroring the plugin's getZLinksForKeys.
 * Returns early if Zotero is not running.
 */
async function buildZoteroAttachmentMap(
  entries: PartialCSLEntry[],
  settings: VaultSettings
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!settings.pullFromZotero) return map;
  const port = settings.zoteroPort || '23119';
  if (!(await isZoteroRunning(port))) {
    log('WARN', 'Zotero is not running; skipping Zotero attachment lookup.');
    return map;
  }

  const needZotero = entries.filter(
    (e) => !parseBibFileField(e.file || '', '').some((p) => fs.existsSync(p))
  );
  log('INFO', `Looking up Zotero attachments for ${needZotero.length} entries without a local file.`);

  for (const group of settings.zoteroGroups || []) {
    // Query in batches of 50 citekeys to avoid huge JSON-RPC payloads.
    for (let i = 0; i < needZotero.length; i += 50) {
      const keys = needZotero.slice(i, i + 50).map((e) => e.id);
      try {
        const items = await getItemJSONFromCiteKeys(port, keys, group.id);
        if (items?.length) {
          for (const item of items) {
            const key = item.citekey || item.citationKey;
            const atts = (item.attachments || [])
              .map((a: any) => a.path || '')
              .filter((p: string) => /\.(pdf|epub)$/i.test(p));
            if (key && atts.length) {
              map.set(key, atts);
            }
          }
        }
      } catch (e: any) {
        log('WARN', `Zotero lookup failed for group ${group.id}`, { error: e.message });
      }
    }
  }
  return map;
}

async function main(): Promise<void> {
  configurePdfjsWorker();
  const opts = parseArgs(process.argv.slice(2));
  const vaultRoot = await resolveVaultRoot();
  setGlobalApp(vaultRoot);
  log('INFO', 'Bib Manager bulk convert-all starting', { vaultRoot });

  const settings = await loadSettings(vaultRoot);

  // Apply env overrides before constructing the plugin-shaped object.
  if (process.env.MINERU_API_TOKEN) settings.mineruApiToken = process.env.MINERU_API_TOKEN;
  if (process.env.CONVERT_OUTPUT_PATH) settings.convertOutputPath = process.env.CONVERT_OUTPUT_PATH;
  // A dedicated bibliography override lets the batch run independently of the
  // plugin data.json (which Obsidian may rewrite from stale in-memory state).
  if (process.env.BIB_MANAGER_BIB) {
    settings.pathToBibliography = undefined;
    settings.bibliographyPaths = process.env.BIB_MANAGER_BIB.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const bibPaths: string[] = [];
  if (settings.pathToBibliography) bibPaths.push(settings.pathToBibliography);
  if (Array.isArray(settings.bibliographyPaths)) bibPaths.push(...settings.bibliographyPaths);
  log('INFO', 'Bibliography paths', bibPaths);

  const entries: PartialCSLEntry[] = [];
  const seen = new Set<string>();
  for (const bibPath of bibPaths) {
    try {
      const list = await bibToCSL(bibPath, settings.pathToPandoc || '/opt/homebrew/bin/pandoc');
      if (list?.length) {
        for (const e of list) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            entries.push(e);
          }
        }
        log('INFO', `Loaded ${list.length} entries from ${bibPath}`);
      }
    } catch (e: any) {
      log('ERROR', `Failed to load bibliography ${bibPath}: ${e.message}`);
    }
  }

  if (entries.length === 0) {
    log('ERROR', 'No bibliography entries found. Check pathToBibliography / bibliographyPaths.');
    process.exit(1);
  }
  log('INFO', `Total bibliography entries: ${entries.length}`);

  // Build the Zotero attachment map (mirrors plugin.zCitekeyToAttachmentLinks).
  const zAttachmentMap = await buildZoteroAttachmentMap(entries, settings);

  const bibCache = new Map<string, PartialCSLEntry>();
  for (const e of entries) bibCache.set(e.id, e);

  // Construct the same plugin-shaped object the settings panel uses, so the
  // exact same convertAll.ts code runs here.
  const fakePlugin: any = {
    settings,
    bibManager: {
      bibCache,
      zCitekeyToAttachmentLinks: zAttachmentMap,
      parseBibFileField: (fileField: string) => parseBibFileField(fileField, vaultRoot),
    },
  };

  // Stats first.
  const stats = await collectAttachmentStats(fakePlugin);
  log('INFO', 'Attachment statistics', stats);

  // Build the queue (honouring --only / --start-from).
  const all = await buildBatchQueue(fakePlugin);
  let queue = all.filter((i) => i.status === 'pending');

  const onlySet = opts.only ? new Set(opts.only) : null;
  if (onlySet) queue = queue.filter((i) => onlySet.has(i.entry.id));
  if (opts.startFrom) {
    const idx = queue.findIndex((i) => i.entry.id === opts.startFrom);
    if (idx >= 0) queue = queue.slice(idx);
  }
  if (opts.limit !== undefined && queue.length > opts.limit) {
    log('INFO', `Trimming to --limit ${opts.limit}`);
    queue = queue.slice(0, opts.limit);
  }

  if (opts.dryRun) {
    log('INFO', 'Dry run — no conversions performed. Planned tasks:');
    for (const t of queue) {
      console.log(`  - ${t.entry.id}\t${t.attachment}`);
    }
    return;
  }

  if (opts.force) {
    // Clear completed state + files for entries in the queue so they re-run.
    const { forceReconvert } = await import('../src/converter/index');
    for (const t of queue) forceReconvert(t.entry.id, settings.convertOutputPath || 'literature');
    log('INFO', `Force-reconverting ${queue.length} entries (state + files cleared).`);
  }

  log('INFO', `Starting batch conversion of ${queue.length} entries.`);
  const progress = getBatchProgress();
  const timer = setInterval(() => {
    const b = getBatchProgress();
    if (b.running) {
      log('PROGRESS', `Batch ${b.done}/${b.total} (failed ${b.failed})${b.currentCitekey ? ` — ${b.currentCitekey}` : ''}`);
    }
  }, 5000);

  await runBatchConversion(fakePlugin, {
    only: opts.only ? new Set(opts.only) : undefined,
    limit: opts.limit,
  });

  clearInterval(timer);
  const final = progress;
  log('INFO', 'Batch complete', {
    processed: final.done,
    failed: final.failed,
    total: final.total,
  });
  if (final.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  log('ERROR', `Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
