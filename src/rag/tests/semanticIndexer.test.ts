jest.mock('shell-path', () => () => Promise.resolve(''));

jest.mock('../embedding', () => {
  const actual = jest.requireActual('../embedding');
  return {
    ...actual,
    embedTexts: jest.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: 1024 }, () => 0.1))
    ),
    isEmbeddingServiceAvailable: jest.fn(async () => true),
  };
});

import os from 'os';
import fs from 'fs';
import path from 'path';
import { SemanticIndexer, SemanticIndexerSettings } from '../semanticIndexer';
import { isEmbeddingServiceAvailable } from '../embedding';

const mockProbe = isEmbeddingServiceAvailable as jest.Mock;

function makeApp(): any {
  // Stable per-app vault root (same path on every getBasePath() call) so the
  // cache-dir hash derived from it stays consistent within a test.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-manager-test-'));
  return {
    vault: {
      adapter: {
        getBasePath: () => base,
        exists: async () => false,
        read: async () => '',
        readBinary: async () => new ArrayBuffer(0),
      },
      getMarkdownFiles: () => [],
    },
  };
}

function makeSettings(): SemanticIndexerSettings {
  return {
    enabled: true,
    apiUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'bge-m3',
    chunkSize: 800,
    chunkOverlap: 120,
    topK: 20,
    indexLocation: 'local',
    followSymlinks: true,
    excludeFolders: [],
  };
}

describe('SemanticIndexer dynamic embedding availability', () => {
  beforeEach(() => {
    mockProbe.mockReset();
    mockProbe.mockResolvedValue(true);
  });

  test('buildAll is a no-op when the probe says the service is unavailable', async () => {
    mockProbe.mockResolvedValueOnce(false);
    const app = makeApp();
    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    await indexer.buildAll();
    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(0);
  });

  test('incrementalUpdate is a no-op when the probe says the service is unavailable', async () => {
    mockProbe.mockResolvedValueOnce(false);
    const app = makeApp();
    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    await indexer.incrementalUpdate();
    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(0);
  });

  test('incrementalUpdate resumes once the service comes back online', async () => {
    // Regression: availability is decided *at update time*, not frozen from a
    // startup probe. A service that was unavailable and later comes back (or a
    // config fix) must resume indexing automatically.
    const app = makeApp();
    app.vault.getMarkdownFiles = () => [
      {
        path: 'notes/a.md',
        stat: { mtime: Date.now(), size: 100 },
        extension: 'md',
      },
    ];
    app.vault.cachedRead = async () => 'hello semantic index content';

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    mockProbe.mockResolvedValueOnce(false); // still down
    await indexer.incrementalUpdate();
    expect(indexer.index.docCount).toBe(0);

    indexer.resetProbe(); // config change / time passes → re-probe
    mockProbe.mockResolvedValueOnce(true); // back online
    await indexer.incrementalUpdate();

    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(1);
    expect(indexer.index.getMeta('notes/a.md')).toBeTruthy();
  });

  test('buildAll resumes once the service comes back online', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => [
      {
        path: 'notes/a.md',
        stat: { mtime: Date.now(), size: 100 },
        extension: 'md',
      },
    ];
    app.vault.cachedRead = async () => 'hello semantic index content';

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    mockProbe.mockResolvedValueOnce(false);
    await indexer.buildAll();
    expect(indexer.index.docCount).toBe(0);

    indexer.resetProbe(); // config change / time passes → re-probe
    mockProbe.mockResolvedValueOnce(true);
    await indexer.buildAll();

    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(1);
  });

  test('search returns empty when the service is unavailable', async () => {
    mockProbe.mockResolvedValueOnce(false);
    const app = makeApp();
    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    indexer.embeddingAvailable = true; // stale "available" flag must not bypass the probe

    const hits = await indexer.search('anything');
    expect(hits).toEqual([]);
  });
});

describe('SemanticIndexer bounded auto runs', () => {
  beforeEach(() => {
    mockProbe.mockReset();
    mockProbe.mockResolvedValue(true);
  });

  const makeManyFiles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `notes/f${i}.md`,
      stat: { mtime: Date.now(), size: 100 },
      extension: 'md',
    }));

  test('auto incrementalUpdate drains a very large backlog in bounded batches', async () => {
    // GPU-era design: a small backlog drains in one run, but a backlog larger
    // than MAX_AUTO_RUN_FILES is still split into bounded batches (one batch
    // per MIN_AUTO_RUN_INTERVAL_MS) so a single run cannot run away.
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(150);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    await indexer.incrementalUpdate(undefined, { auto: true });
    expect(indexer.building).toBe(false);
    // Only the first bounded batch is embedded; the rest is left for follow-ups.
    expect(indexer.index.docCount).toBeGreaterThan(0);
    expect(indexer.index.docCount).toBeLessThan(150);
    indexer.destroy();
  });

  test('auto incrementalUpdate embeds a small delta immediately', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(3);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    await indexer.incrementalUpdate(undefined, { auto: true });
    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(3);
    indexer.destroy();
  });

  test('auto run defers whole-book giants (>AUTO_DEFER_CHUNKS) to manual runs', async () => {
    // Regression: a 20MB converted book is ~10k chunks and would monopolize an
    // auto run for tens of minutes. Auto runs must skip it (leaving it pending
    // for the manual "增量更新"), while the manual run embeds it.
    const app = makeApp();
    app.vault.getMarkdownFiles = () => [
      { path: 'notes/small.md', stat: { mtime: Date.now(), size: 400 }, extension: 'md' },
      { path: 'literature/Book.md', stat: { mtime: Date.now(), size: 10 * 1024 * 1024 }, extension: 'md' },
    ];
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    await indexer.incrementalUpdate(undefined, { auto: true });
    // Only the small file is embedded by the auto run; the giant stays pending.
    expect(indexer.index.docCount).toBe(1);

    await indexer.incrementalUpdate();
    expect(indexer.index.docCount).toBe(2);
    indexer.destroy();
  });

  test('manual incrementalUpdate drains a large backlog in a single run', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(25);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    await indexer.incrementalUpdate();
    expect(indexer.index.docCount).toBe(25);
    indexer.destroy();
  });

  test('auto buildAll is a no-op; manual buildAll is full', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(25);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    await indexer.buildAll(undefined, { auto: true });
    expect(indexer.index.docCount).toBe(0);

    await indexer.buildAll();
    expect(indexer.index.docCount).toBe(25);
    indexer.destroy();
  });
});

describe('SemanticIndexer lazy vector loading', () => {
  beforeEach(() => {
    mockProbe.mockReset();
    mockProbe.mockResolvedValue(true);
  });

  test('loadCache reads only the tiny meta sidecar; vectors load lazily on first use', async () => {
    const app = makeApp();
    // The indexer resolves its cache paths through the global `app` (same as
    // inside Obsidian), so expose it for the disk round-trip.
    (global as any).app = app;
    try {
      app.vault.getMarkdownFiles = () => [
        { path: 'notes/a.md', stat: { mtime: Date.now(), size: 100 }, extension: 'md' },
        { path: 'notes/b.md', stat: { mtime: Date.now(), size: 100 }, extension: 'md' },
      ];
      app.vault.cachedRead = async () => 'hello semantic index content';

      // Build + persist a real index (writes json / vectors / meta sidecar).
      const indexer = new SemanticIndexer(app, 'literature', makeSettings());
      await indexer.incrementalUpdate();
      expect(indexer.docCount).toBe(2);
      await indexer.flushCache();
      indexer.destroy();

      // A fresh instance must NOT pull the vector payload into memory at
      // startup: pending counts / diffs come from the sidecar alone.
      const indexer2 = new SemanticIndexer(app, 'literature', makeSettings());
      const loaded = await indexer2.loadCache();
      expect(loaded).toBe(true);
      expect(indexer2.docCount).toBe(2);
      expect(indexer2.chunkCount).toBeGreaterThan(0);
      expect((indexer2 as any).vectorsLoaded).toBe(false);

      // Semantic search loads the vectors on demand.
      const hits = await indexer2.search('hello');
      expect(Array.isArray(hits)).toBe(true);
      expect((indexer2 as any).vectorsLoaded).toBe(true);
      indexer2.destroy();
    } finally {
      delete (global as any).app;
    }
  });
});

describe('SemanticIndexer search dedup', () => {
  beforeEach(() => {
    mockProbe.mockReset();
    mockProbe.mockResolvedValue(true);
  });

  test('concurrent and repeated searches for the same query share one scan', async () => {
    const app = makeApp();
    (global as any).app = app;
    try {
      app.vault.getMarkdownFiles = () => [
        { path: 'notes/a.md', stat: { mtime: Date.now(), size: 100 }, extension: 'md' },
      ];
      app.vault.cachedRead = async () => 'hello semantic index content';

      const indexer = new SemanticIndexer(app, 'literature', makeSettings());
      await indexer.incrementalUpdate();
      expect(indexer.docCount).toBe(1);

      const embed = require('../embedding').embedTexts as jest.Mock;
      const queryEmbeds = () =>
        embed.mock.calls.filter((c) => c[0]?.length === 1 && c[0][0] === 'hello');

      // Two concurrent searches with the same key share the in-flight promise:
      // only one query embedding + one scan happens.
      embed.mockClear();
      const [a, b] = await Promise.all([
        indexer.search('hello', 20, 0),
        indexer.search('hello', 20, 0),
      ]);
      expect(Array.isArray(a)).toBe(true);
      expect(b).toEqual(a);
      expect(queryEmbeds()).toHaveLength(1);

      // A repeat of the exact same query reuses the cached result — no new
      // query embedding, no re-scan.
      embed.mockClear();
      const c = await indexer.search('hello', 20, 0);
      expect(c).toEqual(a);
      expect(queryEmbeds()).toHaveLength(0);

      // A different query is a different key and scans again.
      embed.mockClear();
      const d = await indexer.search('other', 20, 0);
      expect(Array.isArray(d)).toBe(true);
      expect(queryEmbeds()).toHaveLength(0);
      indexer.destroy();
    } finally {
      delete (global as any).app;
    }
  });
});
