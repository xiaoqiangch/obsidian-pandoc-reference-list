jest.mock('shell-path', () => () => Promise.resolve(''));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { SemanticIndexer, SemanticIndexerSettings } from '../semanticIndexer';

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

describe('SemanticIndexer read-only mode', () => {
  test('buildAll is a no-op when embedding service is unavailable', async () => {
    const app = makeApp();
    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    indexer.embeddingAvailable = false;

    // Should return immediately without touching vault files or writing cache.
    await indexer.buildAll();
    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(0);
  });

  test('incrementalUpdate is a no-op when embedding service is unavailable', async () => {
    const app = makeApp();
    const indexer = new SemanticIndexer(app, 'literature', makeSettings());
    indexer.embeddingAvailable = false;

    await indexer.incrementalUpdate();
    expect(indexer.building).toBe(false);
    expect(indexer.index.docCount).toBe(0);
  });
});
