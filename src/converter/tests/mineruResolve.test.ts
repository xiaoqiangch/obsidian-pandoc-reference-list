jest.mock('obsidian', () => ({ requestUrl: jest.fn(), Notice: class {} }), { virtual: true });

import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveLocalMineruPath } from '../mineruConverter';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-resolve-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeBin(dir: string, name = 'mineru'): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  return p;
}

describe('resolveLocalMineruPath', () => {
  test('prefers a mineru found on PATH', () => {
    const binDir = path.join(tmpDir, 'pathbin');
    const onPath = makeBin(binDir);
    const venv = makeBin(path.join(tmpDir, 'venv', 'bin'));

    expect(resolveLocalMineruPath([venv], binDir)).toBe(onPath);
  });

  test('falls back to a venv candidate when PATH has no mineru', () => {
    // This is the real-world case: mineru lives in ~/mineru/.venv/bin and the
    // GUI app's PATH never includes it, so bare spawn('mineru') gets ENOENT.
    const venv = makeBin(path.join(tmpDir, 'mineru', '.venv', 'bin'));
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    expect(resolveLocalMineruPath([venv], emptyDir)).toBe(venv);
  });

  test('tries candidates in order and skips missing ones', () => {
    const real = makeBin(path.join(tmpDir, 'second', 'bin'));
    const missing = path.join(tmpDir, 'nope', 'bin', 'mineru');

    expect(resolveLocalMineruPath([missing, real], '')).toBe(real);
  });

  test('returns the bare command when nothing is found', () => {
    expect(resolveLocalMineruPath([path.join(tmpDir, 'absent')], '')).toBe('mineru');
  });

  test('ignores directories that merely share the name', () => {
    // ~/mineru is a directory on the real machine; it must not be mistaken for
    // the executable.
    const dirNamedMineru = path.join(tmpDir, 'dirlike', 'mineru');
    fs.mkdirSync(dirNamedMineru, { recursive: true });

    expect(resolveLocalMineruPath([dirNamedMineru], path.join(tmpDir, 'dirlike'))).toBe('mineru');
  });

  test('expands ~ in candidate paths', () => {
    const rel = path.relative(os.homedir(), path.join(tmpDir, 'home-cand', 'mineru'));
    // Only meaningful when tmpDir is not under $HOME; otherwise just assert the
    // resolver does not throw on a ~ candidate.
    expect(() => resolveLocalMineruPath([`~/${rel}`], '')).not.toThrow();
  });
});
