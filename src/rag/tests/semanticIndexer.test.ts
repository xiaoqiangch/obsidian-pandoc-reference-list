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
import { SemanticIndexer, SemanticIndexerSettings } from '../semanticIndexer';
import { isEmbeddingServiceAvailable } from '../embedding';

const mockProbe = isEmbeddingServiceAvailable as jest.Mock;

function makeApp(): any {
  return {
    vault: {
      adapter: {
        getBasePath: () => os.tmpdir(),
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
