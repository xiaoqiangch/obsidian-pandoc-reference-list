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

  test('auto incrementalUpdate only embeds the run cap and leaves the backlog for follow-ups', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(25);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    // Background/auto run is capped: only MAX_AUTO_RUN_FILES (20) are embedded.
    await indexer.incrementalUpdate(undefined, { auto: true });
    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(20);

    // Manual runs are unbounded and drain the remaining backlog.
    await indexer.incrementalUpdate();
    expect(indexer.index.docCount).toBe(25);

    indexer.destroy();
  });

  test('manual incrementalUpdate embeds everything in a single run', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(25);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    await indexer.incrementalUpdate();
    expect(indexer.index.docCount).toBe(25);

    indexer.destroy();
  });

  test('auto buildAll is capped; manual buildAll is full', async () => {
    const app = makeApp();
    app.vault.getMarkdownFiles = () => makeManyFiles(25);
    app.vault.cachedRead = async () => 'content x'.repeat(50);

    const indexer = new SemanticIndexer(app, 'literature', makeSettings());

    await indexer.buildAll(undefined, { auto: true });
    expect(indexer.index.docCount).toBe(20);

    await indexer.buildAll();
    expect(indexer.index.docCount).toBe(25);

    indexer.destroy();
  });
});
