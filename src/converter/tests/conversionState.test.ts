jest.mock('shell-path', () => () => Promise.resolve(''));

import fs from 'fs';
import os from 'os';
import path from 'path';

import { ConversionStateManager, ConversionState } from '../conversionState';
import { getCacheRoot } from '../../helpers';

jest.mock('../../helpers', () => {
  const actual = jest.requireActual('../../helpers');
  return {
    ...actual,
    getCacheRoot: jest.fn(),
  };
});

const mockedCacheRoot = getCacheRoot as jest.Mock;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convstate-'));
  mockedCacheRoot.mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(citekey: string, over: Partial<ConversionState> = {}): ConversionState {
  return {
    citekey,
    attachmentPath: `/x/${citekey}.pdf`,
    attachmentType: 'pdf',
    outputMdPath: path.join(tmpDir, `${citekey}.md`),
    bibPath: path.join(tmpDir, `${citekey}.bib`),
    imagesDir: path.join(tmpDir, 'images', citekey),
    totalPages: 10,
    convertedPages: 10,
    status: 'in_progress',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('reconcileStaleInProgress', () => {
  test('stale in_progress with output md becomes completed', () => {
    const m = new ConversionStateManager();
    const st = makeState('a');
    m.set('a', st);
    fs.writeFileSync(st.outputMdPath, '# done\n', 'utf-8');

    const res = m.reconcileStaleInProgress((s) => fs.existsSync(s.outputMdPath));

    expect(res).toEqual({ completed: 1, failed: 0 });
    expect(m.get('a')!.status).toBe('completed');
    expect(m.get('a')!.completedAt).toBeTruthy();
    expect(m.isInProgress('a')).toBe(false);
  });

  test('stale in_progress without output md becomes failed and re-convertible', () => {
    const m = new ConversionStateManager();
    m.set('b', makeState('b', { convertedPages: 0 }));

    const res = m.reconcileStaleInProgress((s) => fs.existsSync(s.outputMdPath));

    expect(res).toEqual({ completed: 0, failed: 1 });
    expect(m.get('b')!.status).toBe('failed');
    expect(m.get('b')!.error).toContain('中断');
    // Not in progress any more, so buildBatchQueue treats it as pending.
    expect(m.isInProgress('b')).toBe(false);
  });

  test('completed and failed entries are left untouched', () => {
    const m = new ConversionStateManager();
    m.set('c', makeState('c', { status: 'completed', completedAt: 'X' }));
    m.set('d', makeState('d', { status: 'failed', error: 'boom' }));

    const res = m.reconcileStaleInProgress(() => true);

    expect(res).toEqual({ completed: 0, failed: 0 });
    expect(m.get('c')!.completedAt).toBe('X');
    expect(m.get('d')!.error).toBe('boom');
  });

  test('repairs are persisted across manager instances', () => {
    const m = new ConversionStateManager();
    m.set('e', makeState('e'));
    m.reconcileStaleInProgress(() => false);

    // A fresh manager reads the same on-disk state file.
    const m2 = new ConversionStateManager();
    expect(m2.get('e')!.status).toBe('failed');
    expect(m2.isInProgress('e')).toBe(false);
  });

  test('is idempotent', () => {
    const m = new ConversionStateManager();
    m.set('f', makeState('f'));

    const first = m.reconcileStaleInProgress(() => false);
    const second = m.reconcileStaleInProgress(() => false);

    expect(first).toEqual({ completed: 0, failed: 1 });
    expect(second).toEqual({ completed: 0, failed: 0 });
  });
});
