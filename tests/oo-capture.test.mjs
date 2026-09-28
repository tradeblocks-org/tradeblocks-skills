import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-capture-test-'));
process.env.XDG_DATA_HOME = home;
const { start, stop, hook, verify, combine, list, remove } = await import('../scripts/oo-capture.mjs');
after(async () => fs.rm(home, { recursive: true, force: true }));
let serial = 0;
function trade(n, overrides = {}) {
  return { dateOpened: '2026-01-02', timeOpened: '10:00:00', dateClosed: '2026-01-03', timeClosed: '10:01:00', numberOfContracts: 2, legs: [{ buySell: 'Sell', numberOfContracts: 2, expiration: '2026-02-01', strike: 5000, optionType: 'Put', pricePerContract: 125 }], openingUnderlyingPrice: 5000, closingUnderlyingPrice: 5001, averageClosingCostPerContract: 10, premiumPerContract: 200, profit: n, openingFees: 1.25, closingFees: 1.25, isIgnored: false, ...overrides };
}
function event(session, name, toolInput, output) {
  return { tool_name: `mcp__my_oo__${name}`, session_id: session, tool_input: toolInput, tool_response: JSON.stringify(output), tool_use_id: `toolu_${serial++}` };
}
async function capture({ rows = [trade(19), trade(900, { isIgnored: true })], headline = {}, pages, pageMutator, stopCapture = true, curveMutator, range = ['2026-01-02', '2026-01-05'], extraCurveWindows = [], noCurve = false } = {}) {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  const source = { savedBacktestId: 'backtest-1' };
  await hook(event(session, 'get_saved_backtest', source, { id: 'backtest-1', name: 'Fixture Default', parameters: { name: 'fixture', rangeStart: range[0], rangeEnd: range[1] }, result: { numberOfTrades: 1, numberOfOpenTrades: 2, profit: 19, ...headline } }));
  const chunks = pages || [rows];
  for (let i = 0, offset = 0; i < chunks.length; i++) {
    const args = { ...source, sortBy: 'opened', direction: 'asc', limit: 100, offset };
    const data = { offset, items: chunks[i], totalCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0), sortedBy: 'opened', direction: 'asc', nextOffset: i === chunks.length - 1 ? null : offset + chunks[i].length };
    pageMutator?.(args, data, i);
    await hook(event(session, 'get_trade_log', args, data));
    offset += chunks[i].length;
  }
  const args = { parameters: { ...source, seriesStart: '2026-01-02', seriesEnd: '2026-01-05' } };
  const data = { seriesStart: '2026-01-02', seriesEnd: '2026-01-05', pointColumns: ['date', 'netLiquidity', 'startingLiquidity', 'realizedFunds', 'tradingFunds', 'profitLoss', 'profitLossPercentage', 'drawdownPercentage'], points: [
    ['2026-01-02', 1000, 1000, 1000, 1000, 0, 0, 0],
    ['2026-01-05', 990, 1000, 1000, 1000, -10, -1, -1],
  ] };
  curveMutator?.(args, data);
  if (!noCurve) {
    await hook(event(session, 'get_equity_curve', args, data));
    for (const window of extraCurveWindows) {
      const call = event(session, 'get_equity_curve', window.args, window.data);
      await hook(window.server ? { ...call, tool_name: `mcp__${window.server}__get_equity_curve` } : call);
    }
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
  assert.equal(result.curve.rows, 2);
  assert.equal(result.curve.maxDrawdownPct, '-1.00');
  assert.equal(result.dailyLogPath, path.join(home, 'tradeblocks', 'oo-captures', id, 'dailylog.csv'));
  assert.equal((await fs.readFile(result.dailyLogPath, 'utf8')).split('\n').length, 4);
  const csv = await fs.readFile(result.csvPath, 'utf8');
  assert.match(csv, /,200\.00,/);
  assert.match(csv, /,19\.00,net_includes_fees,2,/);
  assert.match(csv, /,1\.25,1\.25\n/);
  assert.equal(csv.split('\n').length, 3);
  assert.equal((await list()).find((entry) => entry.id === id).verified, true);
  await remove(id);
  assert.equal((await list()).some((entry) => entry.id === id), false);
  await assert.rejects(fs.access(result.dailyLogPath));
});
test('verified single-run CSV keeps each trade\'s OO strategy name in the Strategy column', async () => {
  const { id } = await capture({ rows: [trade(19, { strategyName: 'Iron Fly' })] });
  const result = await verify(id);
  const [header, line] = (await fs.readFile(result.csvPath, 'utf8')).trim().split('\n');
  assert.equal(line.split(',')[header.split(',').indexOf('Strategy')], 'Iron Fly');
});
test('chosen strategy reaches every economic row without changing reconciliation or curve', async () => {
  const { id } = await capture({ rows: [trade(12), trade(7), trade(900, { isIgnored: true })], headline: { numberOfTrades: 2 } });
  const baseline = await verify(id);
  const chosen = await verify(id, 'Daily, "Core"');
  const [header, ...rows] = parseCsv(await fs.readFile(chosen.csvPath, 'utf8'));
  assert.deepEqual(rows.map((fields) => fields[header.indexOf('Strategy')]), ['Daily, "Core"', 'Daily, "Core"']);
  assert.deepEqual([chosen.trades, chosen.ignoredRows, chosen.ooProfit, chosen.csvPlBasis, chosen.curve],
    [baseline.trades, baseline.ignoredRows, baseline.ooProfit, baseline.csvPlBasis, baseline.curve]);
  assert.deepEqual(chosen.strategy, { names: [{ name: 'Daily, "Core"', source: 'user', rows: 2 }], overriddenOoNames: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'tradeblocks', 'oo-captures', id, 'verification.json'), 'utf8')), chosen);
});
test('saved headline defaults the strategy, while a nameless run retains the import fallback', async () => {
  const { id } = await capture();
  const saved = await verify(id);
  const [savedHeader, savedTrade] = parseCsv(await fs.readFile(saved.csvPath, 'utf8'));
  assert.equal(savedTrade[savedHeader.indexOf('Strategy')], 'Fixture Default');
  assert.deepEqual(saved.strategy, { names: [{ name: 'Fixture Default', source: 'OO headline', rows: 1 }], overriddenOoNames: [] });
  const runId = await runCapture('run-nameless', [19]);
  const run = await verify(runId);
  const [runHeader, runTrade] = parseCsv(await fs.readFile(run.csvPath, 'utf8'));
  assert.equal(runTrade[runHeader.indexOf('Strategy')], '');
  assert.deepEqual(run.strategy, { names: [{ name: '', source: 'blank→blockId fallback', rows: 1 }], overriddenOoNames: [] });
});
test('OO strategy survives absent user choice; an explicit override records OO originals and a repeat clears it', async () => {
  const { id } = await capture({ rows: [trade(12, { strategyName: 'OO Alpha' }), trade(7, { strategyName: 'OO Beta' })], headline: { numberOfTrades: 2 } });
  const preserved = await verify(id);
  assert.deepEqual(preserved.strategy.names, [
    { name: 'OO Alpha', source: 'OO trade', rows: 1 }, { name: 'OO Beta', source: 'OO trade', rows: 1 },
  ]);
  const overridden = await verify(id, 'Live Strategy');
  assert.deepEqual(overridden.strategy, {
    names: [{ name: 'Live Strategy', source: 'user', rows: 2 }], overriddenOoNames: ['OO Alpha', 'OO Beta'],
  });
  const [header, ...rows] = parseCsv(await fs.readFile(overridden.csvPath, 'utf8'));
  assert.deepEqual(rows.map((fields) => fields[header.indexOf('Strategy')]), ['Live Strategy', 'Live Strategy']);
  const repeated = await verify(id);
  const [freshHeader, ...freshRows] = parseCsv(await fs.readFile(repeated.csvPath, 'utf8'));
  assert.deepEqual(freshRows.map((fields) => fields[freshHeader.indexOf('Strategy')]), ['OO Alpha', 'OO Beta']);
  assert.deepEqual(repeated.strategy, preserved.strategy);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'tradeblocks', 'oo-captures', id, 'verification.json'), 'utf8')), repeated);
});
test('CLI explicit strategy writes the returned name and rejects blank names', async () => {
  const { id } = await capture();
  const script = new URL('../scripts/oo-capture.mjs', import.meta.url).pathname;
  const call = spawnSync(process.execPath, [script, 'verify', id, '--strategy', 'Reporting Strategy'], { encoding: 'utf8', env: process.env });
  assert.equal(call.status, 0, call.stderr);
  const result = JSON.parse(call.stdout);
  const [header, row] = parseCsv(await fs.readFile(result.csvPath, 'utf8'));
  assert.equal(row[header.indexOf('Strategy')], 'Reporting Strategy');
  assert.deepEqual(result.strategy.names, [{ name: 'Reporting Strategy', source: 'user', rows: 1 }]);
  const blank = spawnSync(process.execPath, [script, 'verify', id, '--strategy', '  '], { encoding: 'utf8', env: process.env });
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /^INVALID_STRATEGY:/);
});
test('a strategy name with a line break is refused before any CSV is written', async () => {
  const chosen = await capture();
  await assert.rejects(verify(chosen.id, 'Daily, "Core"\nSecond line'), /^Error: INVALID_STRATEGY: user strategy name contains a line break/);
  await assert.rejects(fs.access(path.join(home, 'tradeblocks', 'oo-captures', chosen.id, 'tradelog.csv')));
  const fromOo = await capture({ rows: [trade(19, { strategyName: 'Iron\r\nFly' })] });
  await assert.rejects(verify(fromOo.id), /^Error: INVALID_STRATEGY: OO trade strategy name contains a line break/);
  assert.equal((await verify(fromOo.id, 'Iron Fly')).strategy.names[0].name, 'Iron Fly');
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
test('OO terminal page with omitted nextOffset publishes', async () => {
  const { id } = await capture({ pageMutator: (args, data) => { delete data.nextOffset; } });
  const summary = await verify(id);
  assert.deepEqual([summary.trades, summary.ignoredRows, summary.ooProfit], [1, 1, '19.00']);
});
refusal('omitted nextOffset before total count', { pageMutator: (args, data) => { delete data.nextOffset; data.totalCount += 1; } }, 'INTERRUPTED_CAPTURE');
test('hook message supplies page facts without opening saved result', async () => {
  const session = `session_${serial++}`;
  await start(session);
  const first = event(session, 'get_trade_log', { savedBacktestId: 'backtest-1', offset: 0, limit: 100, sortBy: 'opened', direction: 'asc' }, { offset: 0, items: Array(100).fill(trade(0)), totalCount: 101, nextOffset: 100, sortedBy: 'opened', direction: 'asc' });
  const firstCall = spawnSync(process.execPath, [new URL('../scripts/oo-capture-hook.mjs', import.meta.url).pathname], { input: JSON.stringify(first), encoding: 'utf8', env: process.env });
  assert.equal(firstCall.status, 0, firstCall.stderr);
  assert.match(JSON.parse(firstCall.stdout).hookSpecificOutput.additionalContext, /Page offset=0, items=100, totalCount=101, nextOffset=100/);
  const input = event(session, 'get_trade_log', { savedBacktestId: 'backtest-1', offset: 100, limit: 100, sortBy: 'opened', direction: 'asc' }, { offset: 100, items: [trade(19)], totalCount: 101, sortedBy: 'opened', direction: 'asc' });
  const completed = spawnSync(process.execPath, [new URL('../scripts/oo-capture-hook.mjs', import.meta.url).pathname], { input: JSON.stringify(input), encoding: 'utf8', env: process.env });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(JSON.parse(completed.stdout).hookSpecificOutput.additionalContext, /Page offset=100, items=1, totalCount=101, nextOffset=terminal/);
  await stop(session);
});
test('OO null fees mean no fee charged, preserve reported net profit', async () => {
  const { id } = await capture({ rows: [trade(19, { openingFees: null, closingFees: null })] });
  const result = await verify(id);
  const csv = await fs.readFile(result.csvPath, 'utf8');
  assert.match(csv, /,19\.00,net_includes_fees,2,/);
  assert.match(csv, /,0\.00,0\.00\n/);
});
test('omitted OO fee field means no fee charged, as OO omits null properties', async () => {
  // Observed on OO staging 2026-09-28: every trade of an all-expired 0DTE backtest omits closingFees
  // (no closing order, so no closing fee), and no trade-log property is ever sent as an explicit null.
  const item = trade(19);
  delete item.closingFees;
  const { id } = await capture({ rows: [item] });
  const csv = await fs.readFile((await verify(id)).csvPath, 'utf8');
  assert.match(csv, /,19\.00,net_includes_fees,2,/);
  assert.match(csv, /,1\.25,0\.00\n/);
});
refusal('non-numeric OO fee', { rows: [trade(19, { closingFees: '1.25' })] }, 'UNKNOWN_FEES');
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
  assert.equal((await verify(id)).curveMissingReason, 'OO headline reports no source date range');
});
test('run without OO-reported range refuses captured curve rather than silently ignoring it', async () => {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  await hook(event(session, 'get_backtest_results', { runId: 'run-7' }, { numberOfTrades: 1, numberOfOpenTrades: 0, profit: 19 }));
  await hook(event(session, 'get_trade_log', { runId: 'run-7', offset: 0, limit: 100, sortBy: 'opened', direction: 'asc' },
    { offset: 0, totalCount: 1, items: [trade(19)], sortedBy: 'opened', direction: 'asc' }));
  await hook(event(session, 'get_equity_curve', { parameters: { runId: 'run-7', seriesStart: '2026-01-02', seriesEnd: '2026-01-05' } }, {}));
  await stop(session);
  await assert.rejects(verify(id), /MISSING_CURVE_RANGE:/);
});
test('missing provenance file cannot be published', async () => {
  const { id } = await capture();
  const dir = path.join(home, 'tradeblocks', 'oo-captures', id);
  const files = await fs.readdir(path.join(dir, 'responses'));
  await fs.unlink(path.join(dir, 'responses', files.find((name) => name.endsWith('.txt'))));
  await assert.rejects(verify(id), /MISSING_CAPTURE_FILE:/);
});
test('CLI runs when installed under an escaped or symlinked path', async () => {
  // A plugin directory with a space percent-escapes import.meta.url; a symlinked install differs from its target.
  const dir = await fs.mkdtemp(path.join(home, 'plugin dir '));
  await fs.cp(new URL('../scripts', import.meta.url), path.join(dir, 'scripts'), { recursive: true });
  await fs.symlink(dir, path.join(home, 'linked-plugin'));
  for (const script of [path.join(dir, 'scripts', 'oo-capture.mjs'), path.join(home, 'linked-plugin', 'scripts', 'oo-capture.mjs')]) {
    const run = spawnSync(process.execPath, [script, 'list'], { encoding: 'utf8', env: process.env });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(Array.isArray(JSON.parse(run.stdout)), script);
  }
});
test('saved result under a session path with spaces is captured; one outside the session is foreign', async () => {
  const session = `session_${serial++}`;
  await start(session);
  const parent = path.join(home, 'Users', 'Jane Q Trader', 'project');
  const fileDir = path.join(parent, session, 'tool-results');
  await fs.mkdir(fileDir, { recursive: true });
  const saved = path.join(fileDir, 'mcp-my_oo-get_trade_log-9.txt');
  await fs.writeFile(saved, '{"offset":0,"items":[]}');
  const base = { ...event(session, 'get_trade_log', {}, {}), transcript_path: path.join(parent, `${session}.jsonl`) };
  assert.equal((await hook({ ...base, tool_response: `Output has been saved to ${saved}.` })).origin, 'saved-file');
  const foreignDir = path.join(home, 'other-session', 'tool-results');
  await fs.mkdir(foreignDir, { recursive: true });
  const foreign = path.join(foreignDir, 'mcp-my_oo-get_trade_log-9.txt');
  await fs.writeFile(foreign, '{}');
  assert.equal((await hook({ ...base, tool_response: `Output has been saved to ${foreign}.` })).failure, 'FOREIGN_SAVED_FILE');
  await stop(session);
});
test('verify can be re-run and gives the same result', async () => {
  const { id } = await capture({});
  assert.deepEqual(await verify(id), await verify(id));
});
refusal('impossible calendar date', { rows: [trade(19, { dateClosed: '2026-02-30' })] }, 'INVALID_TRADE');
refusal('out-of-range month', { rows: [trade(19, { dateOpened: '2026-13-01' })] }, 'INVALID_TRADE');
test('pages from another OO server with a colliding id and matching totals refuse', async () => {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  await hook(event(session, 'get_backtest_results', { runId: 'run-7' }, { numberOfTrades: 1, numberOfOpenTrades: 0, profit: 19 }));
  const page = event(session, 'get_trade_log', { runId: 'run-7', offset: 0, limit: 100, sortBy: 'opened', direction: 'asc' }, { offset: 0, totalCount: 1, items: [trade(19, { strike: 4000 })], nextOffset: null, sortedBy: 'opened', direction: 'asc' });
  await hook({ ...page, tool_name: 'mcp__oo_prod__get_trade_log' });
  await stop(session);
  await assert.rejects(verify(id), /SOURCE_MISMATCH:/);
});

const pointColumns = ['date', 'netLiquidity', 'startingLiquidity', 'realizedFunds', 'tradingFunds', 'profitLoss', 'profitLossPercentage', 'drawdownPercentage'];
function extra(from, through, points, source = 'backtest-1') {
  return { args: { parameters: { savedBacktestId: source, seriesStart: from, seriesEnd: through } },
    data: { seriesStart: points[0][0], seriesEnd: points.at(-1)[0], pointColumns, points } };
}
refusal('missing trading session inside window', { curveMutator: (_, data) => {
  data.points.pop(); data.seriesEnd = '2026-01-02';
} }, 'MISSING_CURVE_DAY');
refusal('missing trading session between windows', { range: ['2026-01-02', '2026-01-06'], curveMutator: (args, data) => {
  args.parameters.seriesEnd = '2026-01-02'; data.seriesEnd = '2026-01-02'; data.points.pop();
}, extraCurveWindows: [extra('2026-01-06', '2026-01-06', [['2026-01-06', 980, 990, 1000, 1000, -10, -1, -2]])] }, 'MISSING_CURVE_DAY');
refusal('duplicate date in a curve window', { curveMutator: (_, data) => data.points.push([...data.points[1]]) }, 'DUPLICATE_CURVE_DAY');
refusal('disagreeing overlap of two curve windows', { extraCurveWindows: [extra('2026-01-05', '2026-01-05', [['2026-01-05', 991, 1000, 1000, 1000, -9, -.9, -.9]])] }, 'DISAGREEING_CURVE_OVERLAP');
test('agreeing overlap is accepted once; withdrawal and percentage signs retain OO units', async () => {
  const { id } = await capture({ extraCurveWindows: [extra('2026-01-05', '2026-01-05', [['2026-01-05', 990, 1000, 1000, 1000, -10, -1, -1]])],
    curveMutator: (_, data) => { data.points[1][3] = 1010; data.points[1][4] = 1000; } });
  // An agreeing shared day must match all required OO values, not only net liquidity.
  await assert.rejects(verify(id), /DISAGREEING_CURVE_OVERLAP:/);
  const accepted = await capture({ extraCurveWindows: [extra('2026-01-05', '2026-01-05', [['2026-01-05', 990, 1000, 1010, 1000, -10, -1, -1]])],
    curveMutator: (_, data) => { data.points[1][3] = 1010; data.points[1][4] = 1000; } });
  const result = await verify(accepted.id);
  assert.equal(result.curve.rows, 2);
  assert.equal(result.curve.windows, 2);
  assert.equal(result.curve.maxDrawdownPct, '-1.00');
  assert.equal(await fs.readFile(result.dailyLogPath, 'utf8'),
    'Date,Net Liquidity,Current Funds,Withdrawn,Trading Funds,P/L,P/L %,Drawdown %\n2026-01-02,1000.00,1000.00,0.00,1000.00,0.00,0.00,0.00\n2026-01-05,990.00,1010.00,10.00,1000.00,-10.00,-1.00,-1.00\n');
});
refusal('foreign-run curve window', { curveMutator: (args) => { args.parameters.savedBacktestId = 'other'; } }, 'CURVE_SOURCE_MISMATCH');
refusal('foreign-server curve window', { extraCurveWindows: [{ ...extra('2026-01-05', '2026-01-05', [['2026-01-05', 990, 1000, 1000, 1000, -10, -1, -1]]), server: 'other_oo' }] }, 'CURVE_SOURCE_MISMATCH');
refusal('portfolio curve window', { curveMutator: (args) => { args.parameters.savedPortfolioId = 'portfolio'; } }, 'CURVE_SOURCE_MISMATCH');
refusal('curve window outside OO source range', { curveMutator: (args) => { args.parameters.seriesEnd = '2026-01-06'; } }, 'CURVE_OUT_OF_RANGE');
refusal('curve window longer than two years', { range: ['2024-01-02', '2026-01-05'], curveMutator: (args) => { args.parameters.seriesStart = '2024-01-02'; } }, 'CURVE_WINDOW_TOO_LONG');
refusal('pointColumns missing required name', { curveMutator: (_, data) => { data.pointColumns[1] = 'other'; } }, 'INVALID_POINT_COLUMNS');
refusal('pointColumns duplicate required name', { curveMutator: (_, data) => { data.pointColumns[1] = 'date'; } }, 'INVALID_POINT_COLUMNS');
refusal('curve continuity broken at window join', { range: ['2026-01-02', '2026-01-06'], curveMutator: (args, data) => {
  args.parameters.seriesEnd = '2026-01-05';
}, extraCurveWindows: [extra('2026-01-06', '2026-01-06', [['2026-01-06', 980, 1000, 1000, 1000, -20, -2, -2]])] }, 'CURVE_CONTINUITY');
refusal('curve P/L differs from daily net liquidity change', { curveMutator: (_, data) => { data.points[1][5] = -9; } }, 'CURVE_PROFIT_MISMATCH');
refusal('non-cent curve number', { curveMutator: (_, data) => { data.points[1][6] = -1.001; } }, 'INVALID_CURVE_VALUE');
refusal('non-finite curve number', { curveMutator: (_, data) => { data.points[1][4] = 'NaN'; } }, 'INVALID_CURVE_VALUE');
refusal('invalid curve date', { curveMutator: (_, data) => { data.points[1][0] = '2026-02-30'; } }, 'INVALID_CURVE_DATE');
refusal('saved backtest with no curve windows', { noCurve: true }, 'MISSING_CURVE');
test('NYSE holiday is not a missing day', async () => {
  const { id } = await capture({ range: ['2026-01-02', '2026-01-05'] });
  assert.equal((await verify(id)).curve.rows, 2);
  const holiday = await capture({ range: ['2025-01-09', '2025-01-10'], curveMutator: (args, data) => {
    args.parameters.seriesStart = '2025-01-09'; args.parameters.seriesEnd = '2025-01-10';
    data.seriesStart = '2025-01-10'; data.seriesEnd = '2025-01-10';
    data.points = [['2025-01-10', 1000, 1000, 1000, 1000, 0, 0, 0]];
  } });
  assert.equal((await verify(holiday.id)).curve.rows, 1);
});
test('curve hook retains inline and saved-file JSON bytes with arguments', async () => {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  const parent = path.join(home, 'curve-session');
  const dir = path.join(parent, session, 'tool-results');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'mcp-my_oo-get_equity_curve-123.txt');
  const text = '{ "seriesStart":"2026-01-02", "points":[], "note":"é" }\n';
  await fs.writeFile(file, text);
  const input = { ...event(session, 'get_equity_curve', { parameters: { savedBacktestId: 'backtest-1', seriesStart: '2026-01-02', seriesEnd: '2026-01-05' } }, {}),
    transcript_path: path.join(parent, `${session}.jsonl`) };
  await hook({ ...input, tool_response: text });
  await hook({ ...input, tool_response: [{ type: 'text', text: `Result saved to ${file}` }] });
  const responseDir = path.join(home, 'tradeblocks', 'oo-captures', id, 'responses');
  const entries = await Promise.all((await fs.readdir(responseDir)).filter((name) => name.endsWith('.json')).map((name) => fs.readFile(path.join(responseDir, name), 'utf8').then(JSON.parse)));
  assert.deepEqual(entries.map((entry) => entry.origin).sort(), ['inline', 'saved-file']);
  assert.ok(entries.every((entry) => entry.toolInput.parameters.savedBacktestId === 'backtest-1'));
  assert.deepEqual(await Promise.all(entries.map((entry) => fs.readFile(path.join(responseDir, entry.rawFile), 'utf8'))), [text, text]);
  await stop(session);
});

async function runCapture(runId, profits, server = 'my_oo', headline = {}) {
  const session = `session_${serial++}`;
  const { id } = await start(session);
  const send = (name, args, response) => hook({ ...event(session, name, args, response), tool_name: `mcp__${server}__${name}` });
  await send('get_backtest_results', { runId }, { numberOfTrades: profits.length, numberOfOpenTrades: 0, profit: profits.reduce((sum, n) => sum + n, 0), ...headline });
  await send('get_trade_log', { runId, offset: 0, limit: 100, sortBy: 'opened', direction: 'asc' },
    { offset: 0, totalCount: profits.length, items: profits.map((n) => trade(n)), nextOffset: null, sortedBy: 'opened', direction: 'asc' });
  await stop(session);
  return id;
}

function parseCsv(text) {
  const records = [];
  let fields = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { fields.push(field); field = ''; }
    else if (char === '\n' && !quoted) { fields.push(field); records.push(fields); fields = []; field = ''; }
    else field += char;
  }
  return records;
}

test('combine publishes one trade-only CSV with each verified run reconciled by its label', async (t) => {
  const best = await runCapture('run-best', [12.25, -2]);
  const centre = await runCapture('run-centre', [4.5]);
  const first = await verify(best);
  const second = await verify(centre);
  const invocation = spawnSync(process.execPath, [new URL('../scripts/oo-capture.mjs', import.meta.url).pathname, 'combine', best, 'best, "fast"', centre, 'centre\nslow'], { encoding: 'utf8', env: process.env });
  assert.equal(invocation.status, 0, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  const text = await fs.readFile(result.csvPath, 'utf8');
  const [header, ...rows] = parseCsv(text);
  const strategy = header.indexOf('Strategy'), pl = header.indexOf('P/L');
  const grouped = Object.groupBy(rows, (fields) => fields[strategy]);
  const sums = Object.fromEntries(Object.entries(grouped).map(([label, trades]) =>
    [label, { count: trades.length, cents: trades.reduce((sum, fields) => sum + Math.round(Number(fields[pl]) * 100), 0) }]));
  assert.deepEqual(sums, { 'best, "fast"': { count: 2, cents: 1025 }, 'centre\nslow': { count: 1, cents: 450 } });
  t.diagnostic(`CLI fixture per-arm count/net cents: ${JSON.stringify(sums)}`);
  assert.deepEqual(result.arms.map(({ label, runId, trades, ooProfit }) => [label, runId, trades, ooProfit]),
    [['best, "fast"', 'run-best', 2, '10.25'], ['centre\nslow', 'run-centre', 1, '4.50']]);
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.server, 'mcp__my_oo');
  assert.deepEqual(manifest.arms.map(({ captureId, runId, label, verification }) => [captureId, runId, label, verification.ooProfit]),
    [[best, 'run-best', 'best, "fast"', first.ooProfit], [centre, 'run-centre', 'centre\nslow', second.ooProfit]]);
  assert.equal((await list()).find((item) => item.id === result.id).verified, true);
  assert.equal(await fs.access(path.join(result.directory, 'dailylog.csv')).then(() => true, () => false), false);
  await remove(result.id);
  assert.equal((await list()).some((item) => item.id === result.id), false);
});

test('combine refuses missing, unverified, duplicate run, cross-server, different-basis and colliding labels without publishing', async () => {
  const a = await runCapture('run-a', [19]);
  const b = await runCapture('run-b', [8]);
  const same = await runCapture('run-a', [19]);
  const foreign = await runCapture('run-c', [8], 'oo_prod');
  const richer = await runCapture('run-d', [8], 'my_oo', { startingFunds: 700000 });
  await verify(a);
  await verify(same);
  await verify(foreign);
  await verify(richer);
  const saved = await capture();
  await verify(saved.id);
  const before = (await list()).length;
  for (const [ids, reason] of [
    [[a, 'best', '00000000-0000-0000-0000-000000000000', 'centre'], 'MISSING_CAPTURE_FILE'],
    [[a, 'best', b, 'centre'], 'UNVERIFIED_CAPTURE'],
    [[a, 'best', same, 'centre'], 'DUPLICATE_RUN'],
    [[a, 'best', foreign, 'centre'], 'SERVER_MISMATCH'],
    [[a, 'best', richer, 'centre'], 'BASIS_MISMATCH'],
    [[a, 'best', same, 'best'], 'LABEL_COLLISION'],
    [[a, 'best', saved.id, 'centre'], 'NOT_RUN_CAPTURE'],
    [[a, 'Best', same, 'best'], 'LABEL_COLLISION'],
  ]) await assert.rejects(combine(...ids), (error) => error.message.startsWith(`${reason}:`));
  assert.equal((await list()).length, before);
});
