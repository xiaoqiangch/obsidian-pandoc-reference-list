jest.mock('shell-path', () => () => Promise.resolve(''));

import fs from 'fs';
import os from 'os';
import path from 'path';

import { collectAttachmentStats, buildBatchQueue } from '../convertAll';
import { getAttachmentPath } from '../index';
import { isConversionInProgress } from '../index';
import { getVaultRoot } from '../../helpers';

jest.mock('../index', () => {
  const actual = jest.requireActual('../index');
  return {
    ...actual,
    getAttachmentPath: jest.fn(),
    isConversionInProgress: jest.fn(),
  };
});

jest.mock('../../helpers', () => {
  const actual = jest.requireActual('../../helpers');
  return {
    ...actual,
    getVaultRoot: jest.fn(),
  };
});

const mockedGet = getAttachmentPath as jest.Mock;
const mockedInProgress = isConversionInProgress as jest.Mock;
const mockedVaultRoot = getVaultRoot as jest.Mock;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convertall-'));
  mockedGet.mockReset();
  mockedInProgress.mockReset();
  mockedInProgress.mockReturnValue(false);
  mockedVaultRoot.mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePlugin(entries: { id: string; file?: string }[]): any {
  const bibCache = new Map<string, any>();
  for (const e of entries) bibCache.set(e.id, { id: e.id, file: e.file, title: e.id });
  return { bibManager: { bibCache }, settings: { convertOutputPath: 'literature' } };
}

function writeConvertedMd(citekey: string): void {
  const dir = path.join(tmpDir, 'literature');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${citekey}.md`), '# converted\n', 'utf-8');
}

describe('collectAttachmentStats', () => {
  test('classifies converted (md on disk) / pending / no-attachment', async () => {
    const plugin = makePlugin([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mockedGet.mockImplementation(async (entry: any) =>
      entry.id === 'a' ? '/x/a.pdf' : entry.id === 'b' ? '/x/b.pdf' : null
    );
    writeConvertedMd('a');

    const stat = await collectAttachmentStats(plugin);
    expect(stat.total).toBe(3);
    expect(stat.converted).toBe(1);
    expect(stat.pending).toBe(1);
    expect(stat.noAttachment).toBe(1);
    expect(stat.inProgress).toBe(0);
  });

  test('a failed state with an md on disk still counts as converted (no re-convert)', async () => {
    const plugin = makePlugin([{ id: 'a' }]);
    mockedGet.mockResolvedValue('/x/a.pdf');
    // md exists even though state would be 'failed' (quota interruption)
    writeConvertedMd('a');

    const stat = await collectAttachmentStats(plugin);
    expect(stat.converted).toBe(1);
    expect(stat.pending).toBe(0);
  });

  test('counts in-progress entries that have no md on disk', async () => {
    const plugin = makePlugin([{ id: 'a' }]);
    mockedGet.mockResolvedValue('/x/a.pdf');
    mockedInProgress.mockReturnValue(true);

    const stat = await collectAttachmentStats(plugin);
    expect(stat.inProgress).toBe(1);
    expect(stat.pending).toBe(0);
  });
});

describe('buildBatchQueue', () => {
  test('orders pending items first, marks converted (md on disk) and no-attachment', async () => {
    const plugin = makePlugin([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mockedGet.mockImplementation(async (entry: any) =>
      entry.id === 'c' ? null : `/x/${entry.id}.pdf`
    );
    writeConvertedMd('b');

    const q = await buildBatchQueue(plugin);
    const byId = Object.fromEntries(q.map((i) => [i.entry.id, i.status]));
    expect(byId['a']).toBe('pending');
    expect(byId['b']).toBe('converted');
    expect(byId['c']).toBe('no_attachment');
  });

  test('pending even when state says in_progress but md is absent', async () => {
    const plugin = makePlugin([{ id: 'a' }]);
    mockedGet.mockResolvedValue('/x/a.pdf');
    mockedInProgress.mockReturnValue(true);

    const q = await buildBatchQueue(plugin);
    expect(q[0].status).toBe('in_progress');
  });
});
