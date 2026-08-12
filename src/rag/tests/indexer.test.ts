jest.mock(
  'obsidian',
  () => ({
    FileSystemAdapter: class FileSystemAdapter {},
    htmlToMarkdown: (html: string) => html,
  }),
  { virtual: true }
);

import { shouldIndexPath, docChanged } from '../indexer';

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpRoot: string;
let vaultRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bib-indexer-test-'));
  vaultRoot = path.join(tmpRoot, 'vault');
  fs.mkdirSync(vaultRoot, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('shouldIndexPath', () => {
  test('indexes regular markdown files', () => {
    fs.mkdirSync(path.join(vaultRoot, 'notes'), { recursive: true });
    expect(shouldIndexPath('notes/foo.md', vaultRoot)).toBe(true);
    expect(shouldIndexPath('foo.md', vaultRoot)).toBe(true);
  });

  test('skips non-markdown files', () => {
    expect(shouldIndexPath('notes/foo.txt', vaultRoot)).toBe(false);
    expect(shouldIndexPath('foo', vaultRoot)).toBe(false);
  });

  test('skips hidden paths and excluded dirs', () => {
    expect(shouldIndexPath('.obsidian/config.md', vaultRoot)).toBe(false);
    expect(shouldIndexPath('a/.hidden/foo.md', vaultRoot)).toBe(false);
    expect(shouldIndexPath('.git/COMMIT_EDITMSG.md', vaultRoot)).toBe(false);
    expect(shouldIndexPath('a/.trash/foo.md', vaultRoot)).toBe(false);
  });

  test('skips dependency directories even without symlinks', () => {
    expect(shouldIndexPath('proj/node_modules/pkg/README.md', vaultRoot)).toBe(false);
    expect(shouldIndexPath('proj/.yarn/cache/foo.md', vaultRoot)).toBe(false);
    expect(shouldIndexPath('proj/bower_components/foo.md', vaultRoot)).toBe(false);
  });

  test('indexes files inside a symlinked folder by default (followSymlinks)', () => {
    const projectDir = path.join(tmpRoot, 'external-project');
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'proj readme');
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'README.md'), 'pkg readme');
    fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'sub', 'notes.md'), 'sub notes');

    const link = path.join(vaultRoot, 'linked-project');
    fs.symlinkSync(projectDir, link, 'dir');

    expect(shouldIndexPath('linked-project/README.md', vaultRoot)).toBe(true);
    expect(shouldIndexPath('linked-project/sub/notes.md', vaultRoot)).toBe(true);
    // node_modules is still excluded via the folder-name list.
    expect(shouldIndexPath('linked-project/node_modules/pkg/README.md', vaultRoot)).toBe(false);
  });

  test('skips files inside a symlinked folder when followSymlinks is off', () => {
    const projectDir = path.join(tmpRoot, 'external-project');
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'proj readme');
    fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'sub', 'notes.md'), 'sub notes');

    const link = path.join(vaultRoot, 'linked-project');
    fs.symlinkSync(projectDir, link, 'dir');

    const opts = { followSymlinks: false, excludeFolders: [] };
    expect(shouldIndexPath('linked-project/README.md', vaultRoot, opts)).toBe(false);
    expect(shouldIndexPath('linked-project/sub/notes.md', vaultRoot, opts)).toBe(false);
  });

  test('configurable exclude folders override the defaults', () => {
    // Defaults exclude node_modules...
    expect(shouldIndexPath('proj/node_modules/pkg/README.md', vaultRoot)).toBe(false);
    // ...and a custom list can exclude other folders.
    expect(
      shouldIndexPath('proj/src/x.md', vaultRoot, { followSymlinks: true, excludeFolders: ['src'] })
    ).toBe(false);
    // An empty list disables the folder-name exclusions.
    expect(
      shouldIndexPath('proj/node_modules/pkg/README.md', vaultRoot, { followSymlinks: true, excludeFolders: [] })
    ).toBe(true);
  });

  test('still indexes files in a real folder with same name as the symlink', () => {
    const realDir = path.join(vaultRoot, 'real-project');
    fs.mkdirSync(path.join(realDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'notes.md'), 'real notes');

    expect(shouldIndexPath('real-project/notes.md', vaultRoot)).toBe(true);
    expect(shouldIndexPath('real-project/sub/other.md', vaultRoot)).toBe(true);
  });

  test('a file that is itself a symlink is indexed by default, skipped when followSymlinks is off', () => {
    fs.mkdirSync(path.join(vaultRoot, 'notes'), { recursive: true });
    const target = path.join(tmpRoot, 'external.md');
    fs.writeFileSync(target, 'external content');
    const link = path.join(vaultRoot, 'notes', 'link.md');
    fs.symlinkSync(target, link, 'file');

    expect(shouldIndexPath('notes/link.md', vaultRoot)).toBe(true);
    expect(
      shouldIndexPath('notes/link.md', vaultRoot, { followSymlinks: false, excludeFolders: [] })
    ).toBe(false);
  });

  test('sibling paths outside the symlink remain indexed', () => {
    const projectDir = path.join(tmpRoot, 'external-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'proj readme');
    const link = path.join(vaultRoot, 'linked-project');
    fs.symlinkSync(projectDir, link, 'dir');

    fs.mkdirSync(path.join(vaultRoot, 'vault-notes'), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, 'vault-notes', 'a.md'), 'vault note');

    expect(shouldIndexPath('vault-notes/a.md', vaultRoot)).toBe(true);
    expect(shouldIndexPath('linked-project/README.md', vaultRoot)).toBe(true);
    expect(
      shouldIndexPath('linked-project/README.md', vaultRoot, { followSymlinks: false, excludeFolders: [] })
    ).toBe(false);
  });
});

describe('docChanged', () => {
  const meta = { mtime: 1000, size: 500 };

  test('missing meta requires re-index', () => {
    expect(docChanged(null, { mtime: 1000, size: 500 })).toBe(true);
    expect(docChanged(undefined, { mtime: 1000, size: 500 })).toBe(true);
  });

  test('unchanged file stays indexed', () => {
    expect(docChanged(meta, { mtime: 1000, size: 500 })).toBe(false);
  });

  test('size change requires re-index even with nearby mtime', () => {
    expect(docChanged(meta, { mtime: 1001, size: 600 })).toBe(true);
  });

  test('size 0 placeholder requires re-index', () => {
    expect(docChanged(meta, { mtime: 1000, size: 0 })).toBe(true);
  });

  test('small mtime drift is tolerated when size is unchanged', () => {
    expect(docChanged(meta, { mtime: 1001, size: 500 })).toBe(false);
    expect(docChanged(meta, { mtime: 2999, size: 500 })).toBe(false);
  });

  test('large mtime drift re-indexes even with same size', () => {
    expect(docChanged(meta, { mtime: 4000, size: 500 })).toBe(true);
  });
});
