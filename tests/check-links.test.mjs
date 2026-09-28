import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../.github/scripts/check-links.mjs');

// Run the checker in a fresh Git repository holding `files` (path -> content), all tracked.
async function check(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-links-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), content);
    }
    for (const args of [['init', '-q'], ['add', '-A']]) {
      assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
    }
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    return { status: run.status, stderr: run.stderr };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const fence = (marker, info = '') => `${marker}${info}\n`;

test('a relative link with a query string resolves to the file before the query', async () => {
  const result = await check({
    'ci.yml': 'on: push\n',
    'README.md': '[workflow](ci.yml?plain=1) and [anchored](ci.yml?plain=1#L3)\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a longer fence is not closed by a shorter nested fence', async () => {
  const result = await check({
    'README.md':
      fence('````', 'markdown') +
      fence('```', 'md') +
      '[example](not-a-real-file.md)\n' +
      fence('```') +
      fence('````'),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a fence is not closed by a marker carrying an info string', async () => {
  const result = await check({
    'README.md': fence('```') + fence('```', 'js') + '[example](not-a-real-file.md)\n' + fence('```'),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a link destination with balanced or escaped parentheses resolves in full', async () => {
  const result = await check({
    'docs/run(1).md': '# one\n',
    'docs/run(2).md': '# two\n',
    'docs/run (3).md': '# three\n',
    'README.md':
      '[balanced](docs/run(1).md) [escaped](docs/run\\(2\\).md "title") [pointy](<docs/run (3).md>)\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('link-like text inside a title is not checked as a link', async () => {
  const result = await check({
    'exists.md': '# here\n',
    'README.md': '[doc](exists.md "See [other](missing.md)")\n',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('broken relative links still fail, including after each fixed case', async () => {
  const result = await check({
    'docs/run(1).md': '# one\n',
    'README.md':
      '[plain](missing.md)\n' +
      '[query](missing.yml?plain=1)\n' +
      '[parens](docs/run(9).md)\n' +
      '[titled](absent.md "the \\"quoted\\" doc")\n' +
      fence('````') + fence('```') + fence('````') +
      '[after fence](gone.md)\n',
  });
  assert.equal(result.status, 1);
  assert.deepEqual(result.stderr.trim().split('\n').slice(1), [
    'README.md:1: missing.md',
    'README.md:2: missing.yml?plain=1',
    'README.md:3: docs/run(9).md',
    'README.md:4: absent.md',
    'README.md:8: gone.md',
  ]);
});
