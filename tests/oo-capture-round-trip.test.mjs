import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'csv-parse/sync';

// 4.6.1's exported test entry points at unbundled TS with workspace imports.
// Its shipped dist test bundle contains the actual block-loader, with those imports bundled.
// This version-specific layout is deliberately pinned; resolution failures must fail the test.
const { loadBlock } = await import(new URL('../dist/test-exports.js', import.meta.resolve('tradeblocks-mcp/test-exports')));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oo-round-trip-'));
process.env.XDG_DATA_HOME = home;
const { start, hook, stop, verify, combine } = await import('../scripts/oo-capture.mjs');
after(() => fs.rm(home, { recursive: true, force: true }));
let serial = 0;

// Public real OO export, unchanged from tradeblocks commit
// 80ffe620a9e437e9b455b224cddaff47c1899628, tests/data/ORB Test Data/orb-tradelog.csv.
// Provenance: https://github.com/tradeblocks-org/tradeblocks/pull/508.
// The MCP table below is reconstructed for these trades using the observed schema
// in fixtures/oo-trade-log-tables.json; it is not claimed to be a recorded response.
const exported = await fs.readFile(new URL('./fixtures/oo-orb-export.csv', import.meta.url), 'utf8');
const records = parse(exported, { columns: true, skip_empty_lines: true });
const optionalNames = ['openingVix', 'closingVix', 'gap', 'intradayMovement', 'highestProfitPercentage', 'highestLossPercentage'];
// VIX levels, underlying-point gap/movement, percentage-point excursion values.
// In particular Max Profit/Loss are neither dollar amounts nor fractional returns.
const optionalValues = [
  [24.75, 24.8, -14.36, 16.57, 100, 0],
  [16.96, 16.99, 23.51, 50.95, 79.41, 0],
  [14.86, 14.71, 30.93, 9.79, 64, -236],
  [22.7, 22.7, 41.74, 37.79, 60.71, -117.86],
  [17.35, 17.3, 34.92, 74.4, 100, 0],
];
const rows = records.map((r, i) => ({
  dateOpened: r['Date Opened'], timeOpened: r['Time Opened'], dateClosed: r['Date Closed'], timeClosed: r['Time Closed'],
  daysInTrade: Number(r['Days in Trade']), underlying: r.Underlying, legs: r.Legs,
  numberOfContracts: Number(r['No. of Contracts']), premiumPerContract: Number(r.Premium),
  averageClosingCostPerContract: Number(r['Avg. Closing Cost']), openingUnderlyingPrice: Number(r['Opening Price']), closingUnderlyingPrice: Number(r['Closing Price']),
  reasonClosed: r['Reason For Close'], profit: Number(r['P/L']), profitPercentage: Number(r['P/L %']),
  fundsAtClose: Number(r['Funds at Close']), buyingPowerRequired: Number(r['Margin Req.']),
  openingFees: Number(r['Opening Commissions + Fees']), closingFees: Number(r['Closing Commissions + Fees']),
  ...Object.fromEntries(optionalNames.map((key, at) => [key, optionalValues[i][at]])),
}));

async function capture(trades) {
  const session = `round_trip_${serial++}`, runId = session;
  const { id } = await start(session);
  const send = (name, args, data) => hook({ session_id: session, tool_name: `mcp__oo__${name}`, tool_input: args, tool_response: JSON.stringify(data) });
  const cents = trades.reduce((sum, trade) => sum + Math.round(trade.profit * 100), 0);
  await send('get_backtest_results', { runId }, { numberOfTrades: trades.length, numberOfOpenTrades: 0, profit: cents / 100 });
  const tradeColumns = [...new Set(trades.flatMap(Object.keys))];
  await send('get_trade_log', { runId, offset: 0, limit: 100, sortBy: 'opened', direction: 'asc' }, {
    tradeColumns, trades: trades.map((trade) => tradeColumns.map((key) => trade[key] ?? null)),
    offset: 0, totalCount: trades.length, nextOffset: null, sortedBy: 'opened', direction: 'asc',
  });
  await stop(session);
  return id;
}
async function loadCsv(csv, name) {
  const dir = path.join(home, 'blocks', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'tradelog.csv'), csv);
  return (await loadBlock(path.join(home, 'blocks'), name)).trades;
}
const values = (trades) => trades.map((t) => [t.openingVix, t.closingVix, t.gap, t.movement, t.maxProfit, t.maxLoss]);

test('capture → CSV → real block-loader matches the same trades in OO export, including units and zero', async () => {
  const id = await capture(rows);
  const summary = await verify(id);
  const actual = await loadCsv(await fs.readFile(summary.csvPath, 'utf8'), 'capture');
  const reference = await loadCsv(exported, 'oo-export');
  assert.deepEqual(values(reference), optionalValues);
  assert.deepEqual(values(actual), values(reference));
  assert.deepEqual(actual.map((t) => [t.pl, t.numContracts, t.premium]), reference.map((t) => [t.pl, t.numContracts, t.premium]));
});

test('absent columns and null cells remain absent, while combine preserves each arm independently', async () => {
  const absent = { ...rows[0] };
  for (const name of optionalNames) delete absent[name];
  const nulls = { ...rows[1], ...Object.fromEntries(optionalNames.map((name) => [name, null])) };
  const first = await capture([rows[0], nulls]);
  const second = await capture([absent]);
  await verify(first);
  const empty = await verify(second);
  assert.deepEqual(values(await loadCsv(await fs.readFile(empty.csvPath, 'utf8'), 'absent')), [Array(6).fill(undefined)]);
  const comparison = await combine(first, 'with data', second, 'without data');
  const csv = await fs.readFile(comparison.csvPath, 'utf8');
  assert.deepEqual(values(await loadCsv(csv, 'comparison')), [optionalValues[0], Array(6).fill(undefined), Array(6).fill(undefined)]);
  assert.deepEqual(parse(csv, { columns: true }).map((r) => r.Strategy), ['with data', 'with data', 'without data']);
});

for (const field of optionalNames) {
  test(`invalid ${field} refuses instead of becoming a plausible number in the loader`, async () => {
    const id = await capture([{ ...rows[0], [field]: 'not-a-number' }]);
    await assert.rejects(verify(id), new RegExp(`INVALID_TRADE: ${field}`));
    await assert.rejects(fs.access(path.join(home, 'tradeblocks', 'oo-captures', id, 'tradelog.csv')));
  });
}

test('recorded OO MCP table retains the observed units through the real block-loader', async () => {
  const { savedBacktest } = JSON.parse(await fs.readFile(new URL('./fixtures/oo-trade-log-tables.json', import.meta.url), 'utf8'));
  const trades = savedBacktest.trades.map((cells) => Object.fromEntries(savedBacktest.tradeColumns.map((key, i) => [key, cells[i]])));
  const summary = await verify(await capture(trades));
  const actual = await loadCsv(await fs.readFile(summary.csvPath, 'utf8'), 'recorded-mcp');
  assert.deepEqual(values(actual), [
    [28.4, 29.61, 26.97, 12.79, 56.89, -3.49],
    [27.89, 27.25, 5.87, 36.58, 44.32, -7.45],
    [26.48, 25.58, 19.59, 24.49, 71.25, -12.9],
  ]);
});
