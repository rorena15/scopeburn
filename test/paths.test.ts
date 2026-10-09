import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsFromCommand, pathsFromToolInput, toNative } from '../src/paths.ts';

const WIN = process.platform === 'win32';

test('tool input: only path-like fields are read', () => {
  assert.deepEqual(pathsFromToolInput({ file_path: '/a/b.ts', content: '/should/not/count', old_string: 'C:\\x' }), ['/a/b.ts']);
  assert.deepEqual(pathsFromToolInput(null), []);
});

test('command: quoted paths keep spaces, bare paths stop at shell punctuation', () => {
  const got = pathsFromCommand(`cd "E:\\Git Project\\my app" && cat /e/repo/x.txt | grep y; ls ~/notes`);
  assert.deepEqual(got, ['E:\\Git Project\\my app', '/e/repo/x.txt', '~/notes']);
});

test('command: ignores URLs and relative words', () => {
  assert.deepEqual(pathsFromCommand('curl https://example.com/a && npm run build'), []);
});

test('toNative: Git Bash and WSL drive spellings map to the same Windows path', { skip: !WIN }, () => {
  assert.equal(toNative('/e/Git_Project/x'), 'E:\\Git_Project\\x');
  assert.equal(toNative('/mnt/e/Git_Project/x'), 'E:\\Git_Project\\x');
  assert.equal(toNative('E:/Git_Project/x'), 'E:\\Git_Project\\x');
});

test('toNative: relative paths resolve against cwd, and need one', () => {
  const base = WIN ? 'C:\\work' : '/work';
  assert.equal(toNative('src/a.ts', base), WIN ? 'C:\\work\\src\\a.ts' : '/work/src/a.ts');
  assert.equal(toNative('src/a.ts'), null);
});
