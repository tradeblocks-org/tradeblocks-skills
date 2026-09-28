import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-capture-test-'));
process.env.XDG_DATA_HOME = home;
const { start, stop, hook, verify, list, remove } = await import('../scripts/oo-capture.mjs');
after(async () => fs.rm(home, { recursive: true, force: true }));
let serial = 0;
function trade(n, overrides = {}) {
  return { dateOpened: '2026-01-02', timeOpened: '10:00:00', dateClosed: '2026-01-03', timeClosed: '10:01:00', numberOfContracts: 2, legs: [{ buySell: 'Sell', numberOfContracts: 2, expiration: '2026-02-01', strike: 5000, optionType: 'Put', pricePerContract: 125 }], openingUnderlyingPrice: 5000, closingUnderlyingPrice: 5001, averageClosingCostPerContract: 10, premiumPerContract: 200, profit: n, openingFees: 1.25, closingFees: 1.25, isIgnored: false, ...overrides };
}
function event(session, name, toolInput, output) {
  return { tool_name: `mcp__my_oo__${name}`, session_id: session, tool_input: toolInput, tool_response: JSON.stringify(output), tool_use_id: `toolu_${serial++}` };
}
async function capture({ rows = [trade(19), trade(900, { isIgnored: true })], headline = {}, pages, pageMutator, stopCapture = true } = {}) {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  const source = { savedBacktestId: 'backtest-1' };
  await hook(event(session, 'get_saved_backtest', source, { id: 'backtest-1', parameters: { name: 'fixture' }, result: { numberOfTrades: 1, numberOfOpenTrades: 2, profit: 19, ...headline } }));
  const chunks = pages || [rows];
  for (let i = 0, offset = 0; i < chunks.length; i++) {
    const args = { ...source, sortBy: 'opened', direction: 'asc', limit: 100, offset };
    const data = { offset, items: chunks[i], totalCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0), sortedBy: 'opened', direction: 'asc', nextOffset: i === chunks.length - 1 ? null : offset + chunks[i].length };
    pageMutator?.(args, data, i);
    await hook(event(session, 'get_trade_log', args, data));
    offset += chunks[i].length;
  }
  if (stopCapture) await stop(session);
  return { id, session };
}
function refusal(label, setup, reason) {
  test(label, async () => {
    const { id } = await capture(setup);
    await assert.rejects(verify(id), (error) => error.message.startsWith(`${reason}:`));
    await assert.rejects(fs.access(path.join(home, 'tradeblocks', 'oo-captures', id, 'tradelog.csv')));
  });
}
test('verified OO economic log excludes ignored profits, keeps net fees, decimal premium, and open count', async () => {
  const { id } = await capture();
  const result = await verify(id);
  assert.deepEqual([result.trades, result.ignoredRows, result.openAtEnd, result.ooProfit, result.csvPlBasis], [1, 1, 2, '19.00', 'net_includes_fees']);
  const csv = await fs.readFile(result.csvPath, 'utf8');
  assert.match(csv, /,200\.00,/);
  assert.match(csv, /,19\.00,net_includes_fees,2,/);
  assert.match(csv, /,1\.25,1\.25\n/);
  assert.equal(csv.split('\n').length, 3);
  assert.equal((await list()).find((entry) => entry.id === id).verified, true);
  await remove(id);
  assert.equal((await list()).some((entry) => entry.id === id), false);
});
test('hook outside start and after stop saves nothing', async () => {
  const session = `session_${serial++}`;
  const input = event(session, 'get_trade_log', { savedBacktestId: 'backtest-1' }, { items: [] });
  assert.equal(await hook(input), null);
  const { id } = await start(session);
  await stop(session);
  assert.equal(await hook(input), null);
  assert.deepEqual(await fs.readdir(path.join(home, 'tradeblocks', 'oo-captures', id, 'responses')), []);
});
refusal('missing page', { pages: [Array.from({ length: 100 }, () => trade(0)), [trade(19)]], pageMutator: (args, data, i) => { if (i === 1) { args.offset = 102; data.offset = 102; } }, headline: { numberOfTrades: 101 } }, 'MISSING_PAGE');
refusal('duplicate page', { pages: [Array.from({ length: 100 }, () => trade(0)), [trade(19)]], pageMutator: (args, data, i) => { if (i === 1) { args.offset = 0; data.offset = 0; } }, headline: { numberOfTrades: 101 } }, 'DUPLICATE_PAGE');
refusal('foreign source', { pageMutator: (args) => { args.savedBacktestId = 'backtest-2'; } }, 'SOURCE_MISMATCH');
refusal('filtered log', { pageMutator: (args) => { args.outcome = 'winners'; } }, 'FILTERED_LOG');
refusal('started but not stopped', { stopCapture: false }, 'INTERRUPTED_CAPTURE');
refusal('stopped mid-paging', { rows: Array.from({ length: 100 }, (_, index) => trade(index === 0 ? 19 : 0)), headline: { numberOfTrades: 100 }, pageMutator: (args, data) => { data.totalCount = 101; data.nextOffset = 100; } }, 'INTERRUPTED_CAPTURE');
refusal('profit mismatch', { headline: { profit: 18.99 } }, 'PROFIT_MISMATCH');
test('OO null fees mean no fee charged, preserve reported net profit', async () => {
  const { id } = await capture({ rows: [trade(19, { openingFees: null, closingFees: null })] });
  const result = await verify(id);
  const csv = await fs.readFile(result.csvPath, 'utf8');
  assert.match(csv, /,19\.00,net_includes_fees,2,/);
  assert.match(csv, /,0\.00,0\.00\n/);
});
test('absent OO fee field refuses publication', async () => {
  const item = trade(19);
  delete item.closingFees;
  const { id } = await capture({ rows: [item] });
  await assert.rejects(verify(id), /UNKNOWN_FEES:/);
  await assert.rejects(fs.access(path.join(home, 'tradeblocks', 'oo-captures', id, 'tradelog.csv')));
});
refusal('filter key present but null', { pageMutator: (args) => { args.outcome = null; } }, 'FILTERED_LOG');
test('expired saved file is a recorded named failure, not publication', async () => {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  const parent = path.join(home, 'session');
  const fileDir = path.join(parent, session, 'tool-results');
  await fs.mkdir(fileDir, { recursive: true });
  const file = path.join(fileDir, 'mcp-my_oo-get_trade_log-123.txt');
  await fs.writeFile(file, JSON.stringify({ offset: 0, items: [] }));
  const old = new Date('2001-01-01');
  await fs.utimes(file, old, old);
  const result = await hook({ ...event(session, 'get_trade_log', {}, {}), transcript_path: path.join(parent, `${session}.jsonl`), tool_response: `Full result saved to ${file}` });
  assert.equal(result.failure, 'EXPIRED_SAVED_FILE');
  await stop(session);
  await assert.rejects(verify(id), /EXPIRED_SAVED_FILE:/);
});
test('MCP text-array inline and saved-file responses retain exact JSON bytes', async () => {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  const parent = path.join(home, 'session');
  const fileDir = path.join(parent, session, 'tool-results');
  await fs.mkdir(fileDir, { recursive: true });
  const saved = path.join(fileDir, 'mcp-my_oo-get_trade_log-123.txt');
  const original = '{ "offset": 0, "items": [1], "note": "é" }\n';
  await fs.writeFile(saved, original);
  const base = { ...event(session, 'get_trade_log', {}, {}), transcript_path: path.join(parent, `${session}.jsonl`) };
  assert.equal((await hook({ ...base, tool_response: [{ type: 'text', text: original }] })).origin, 'inline');
  assert.equal((await hook({ ...base, tool_response: [{ type: 'text', text: `Result saved to ${saved}; inspect ${saved}` }] })).origin, 'saved-file');
  const files = await fs.readdir(path.join(home, 'tradeblocks', 'oo-captures', id, 'responses'));
  const raw = await Promise.all(files.filter((name) => name.endsWith('.txt')).map((name) => fs.readFile(path.join(home, 'tradeblocks', 'oo-captures', id, 'responses', name), 'utf8')));
  assert.deepEqual(raw, [original, original]);
  await stop(session);
});
test('runId source binds results and pages without a saved-backtest ID', async () => {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  await hook(event(session, 'get_backtest_results', { runId: 'run-7' }, { numberOfTrades: 1, numberOfOpenTrades: 3, profit: 19 }));
  await hook(event(session, 'get_trade_log', { runId: 'run-7', offset: 0, limit: 100, sortBy: 'opened', direction: 'asc' }, { offset: 0, totalCount: 1, items: [trade(19)], nextOffset: null, sortedBy: 'opened', direction: 'asc' }));
  await stop(session);
  assert.deepEqual((await verify(id)).source, { runId: 'run-7' });
});
test('missing provenance file cannot be published', async () => {
  const { id } = await capture();
  const dir = path.join(home, 'tradeblocks', 'oo-captures', id);
  const files = await fs.readdir(path.join(dir, 'responses'));
  await fs.unlink(path.join(dir, 'responses', files.find((name) => name.endsWith('.txt'))));
  await assert.rejects(verify(id), /MISSING_CAPTURE_FILE:/);
});
