#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'tradeblocks', 'oo-captures');
const sourceKeys = ['savedBacktestId', 'runId'];
const sort = { sortBy: 'opened', direction: 'asc', limit: 100 };

function fail(reason, detail) { throw new Error(`${reason}: ${detail}`); }
function validSession(id) { if (!/^[a-zA-Z0-9_-]+$/.test(id || '')) fail('SESSION_ID', 'provide the Claude Code session ID'); return id; }
function activePath(id) { return path.join(root, 'active', `${validSession(id)}.json`); }
function capturePath(id) { if (!/^[a-f0-9-]{36}$/.test(id || '')) fail('CAPTURE_ID', 'invalid capture ID'); return path.join(root, id); }
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function captureJson(file) {
  try { return await json(file); }
  catch (error) { fail('MISSING_CAPTURE_FILE', `${file}: ${error.message}`); }
}
async function saveJson(file, value) { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
async function marker(session) { try { return await json(activePath(session)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export async function start(session) {
  validSession(session);
  if (await marker(session)) fail('ALREADY_ARMED', 'stop the current capture first');
  const id = randomUUID();
  const dir = capturePath(id);
  await fs.mkdir(path.join(dir, 'responses'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'active'), { recursive: true, mode: 0o700 });
  const state = { id, session, status: 'armed', startedAt: new Date().toISOString() };
  await saveJson(path.join(dir, 'manifest.json'), state);
  await saveJson(activePath(session), { id, startedAt: state.startedAt });
  return { id, directory: dir, message: 'Capturing OO headline and paged trade-log JSON, tool arguments, and failures here until stopped. Retained until explicitly deleted.' };
}
async function event(dir, entry) {
  // One file per tool call avoids losing concurrent calls to a manifest read/modify/write race.
  await saveJson(path.join(dir, 'responses', `${randomUUID()}.json`), entry);
}
export async function hook(input) {
  const match = /^mcp__[^_]+(?:_[^_]+)*__(get_trade_log|get_saved_backtest|get_backtest_results)$/.exec(input.tool_name || '');
  if (!match || !input.session_id) return null;
  const armed = await marker(input.session_id);
  if (!armed) return null;
  const dir = capturePath(armed.id);
  const entry = { toolName: input.tool_name, toolInput: input.tool_input, toolUseId: input.tool_use_id ?? null, recordedAt: new Date().toISOString() };
  try {
    const response = input.tool_response;
    let text;
    let origin = 'inline';
    const content = Array.isArray(response) ? response : response && typeof response === 'object' && !response.isError ? response.content : null;
    if (typeof response === 'string' && isJson(response)) text = response;
    else if (Array.isArray(content) && content.length === 1 && content[0].type === 'text' && typeof content[0].text === 'string' && isJson(content[0].text)) text = content[0].text;
    else {
      const message = Array.isArray(content) && content.length === 1 && content[0].type === 'text' ? content[0].text : typeof response === 'string' ? response : JSON.stringify(response);
      const transcript = input.transcript_path;
      if (!transcript || !input.session_id || !path.isAbsolute(transcript)) fail('SESSION_PATH', 'hook has no session transcript path');
      const parent = path.dirname(transcript);
      // Look only for this session's documented tool-results directory, spelled natively, so a home
      // directory with spaces or a Windows path is found and nothing outside the session can match.
      const paths = new Set();
      for (const dir of [path.join(parent, input.session_id, 'tool-results'), path.join(parent, 'tool-results')]) {
        const prefix = dir + path.sep;
        for (let at = message.indexOf(prefix); at !== -1; at = message.indexOf(prefix, at + 1)) {
          const name = /^[^\s"'`<>\\/]+\.txt/.exec(message.slice(at + prefix.length));
          if (name) paths.add(prefix + name[0]);
        }
      }
      if (paths.size !== 1) fail(paths.size ? 'AMBIGUOUS_SAVED_FILE' : message.includes('tool-results') ? 'FOREIGN_SAVED_FILE' : 'UNRECOGNISED_RESULT', 'expected exactly one saved result path in this session tool-results directory');
      const [candidate] = paths;
      const toolSlug = input.tool_name.slice('mcp__'.length).replace('__', '-');
      if (!path.basename(candidate).startsWith(`mcp-${toolSlug}-`)) fail('FOREIGN_SAVED_FILE', 'saved filename does not identify this tool');
      const stat = await fs.lstat(candidate).catch((error) => { if (error.code === 'ENOENT') fail('MISSING_SAVED_FILE', candidate); throw error; });
      if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_SAVED_FILE', 'result must be a regular file');
      if (stat.mtimeMs < Date.parse(armed.startedAt) - 1000 || stat.mtimeMs > Date.now() + 1000) fail('EXPIRED_SAVED_FILE', 'saved file is not fresh for this capture');
      if (input.tool_use_id && path.basename(candidate).includes('toolu_') && !path.basename(candidate).includes(input.tool_use_id)) fail('FOREIGN_SAVED_FILE', 'tool use ID disagrees with saved filename');
      text = await fs.readFile(candidate, 'utf8');
      if (!isJson(text)) fail('INVALID_SAVED_FILE', 'saved response is not JSON');
      origin = 'saved-file';
    }
    const rawFile = `${randomUUID()}.txt`;
    await fs.writeFile(path.join(dir, 'responses', rawFile), text, { flag: 'wx', mode: 0o600 });
    await event(dir, { ...entry, rawFile, origin });
    const data = JSON.parse(text);
    const page = entry.toolName.endsWith('__get_trade_log') && Number.isInteger(data.offset) && Array.isArray(data.items) && Number.isInteger(data.totalCount)
      ? { offset: data.offset, itemCount: data.items.length, totalCount: data.totalCount, nextOffset: data.nextOffset ?? null }
      : null;
    return { captureId: armed.id, origin, toolName: entry.toolName, page };
  } catch (error) {
    const reason = error.message.match(/^([A-Z_]+):/)?.[1] || 'CAPTURE_IO_FAILURE';
    await event(dir, { ...entry, failure: reason, detail: error.message });
    return { captureId: armed.id, failure: reason, detail: error.message };
  }
}
function isJson(text) { try { JSON.parse(text); return true; } catch { return false; } }
export async function stop(session) {
  const armed = await marker(session);
  if (!armed) fail('NOT_ARMED', 'capture has not started');
  const dir = capturePath(armed.id);
  await fs.unlink(activePath(session));
  const state = await json(path.join(dir, 'manifest.json'));
  state.status = 'stopped';
  state.stoppedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(state, null, 2)}\n`);
  return { id: armed.id, directory: dir, status: 'stopped' };
}
function money(value, name) { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) fail('INVALID_ECONOMICS', `${name} must be a finite cent amount`); return Math.round(value * 100); }
function csv(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
const columns = ['Date Opened', 'Time Opened', 'Opening Price', 'Legs', 'Premium', 'Closing Price', 'Date Closed', 'Time Closed', 'Avg. Closing Cost', 'Reason For Close', 'P/L', 'P/L Basis', 'No. of Contracts', 'Funds at Close', 'Margin Req.', 'Strategy', 'Opening Commissions + Fees', 'Closing Commissions + Fees'];
function dollars(value, name) { return (money(value, name) / 100).toFixed(2); }
// TradeBlocks builds a local Date from Y-M-D, which rolls an impossible day (2026-02-30) into the next month, so refuse it here.
function calendarDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}
function row(trade) {
  if (!calendarDate(trade.dateOpened) || !calendarDate(trade.dateClosed)) fail('INVALID_TRADE', 'economic trade needs valid open and close dates');
  if (!Number.isInteger(trade.numberOfContracts) || trade.numberOfContracts < 1) fail('INVALID_TRADE', 'numberOfContracts must be positive integer');
  if (!Array.isArray(trade.legs)) fail('INVALID_TRADE', 'legs must be an array');
  // OO sends a nullable property by omitting it, so an absent fee is its documented null: none charged.
  if ([trade.openingFees, trade.closingFees].some((fee) => fee != null && (typeof fee !== 'number' || !Number.isFinite(fee)))) fail('UNKNOWN_FEES', 'OO fee fields must be numbers, null or omitted (no fee charged)');
  for (const leg of trade.legs) dollars(leg.pricePerContract, 'leg pricePerContract');
  const legs = trade.legs.map((leg) => `${leg.buySell} ${leg.numberOfContracts} ${leg.expiration ?? ''} ${leg.strike} ${leg.optionType} @ ${dollars(leg.pricePerContract, 'leg pricePerContract')}`).join('; ');
  const fields = [trade.dateOpened, trade.timeOpened, trade.openingUnderlyingPrice, legs, dollars(trade.premiumPerContract, 'premiumPerContract'), trade.closingUnderlyingPrice, trade.dateClosed, trade.timeClosed, dollars(trade.averageClosingCostPerContract, 'averageClosingCostPerContract'), trade.reasonClosed, dollars(trade.profit, 'profit'), 'net_includes_fees', trade.numberOfContracts, trade.fundsAtClose, trade.buyingPowerRequired, trade.strategyName, dollars(trade.openingFees ?? 0, 'openingFees'), dollars(trade.closingFees ?? 0, 'closingFees')];
  return fields.map(csv).join(',');
}
export async function verify(id) {
  const dir = capturePath(id);
  const manifest = await captureJson(path.join(dir, 'manifest.json'));
  if (manifest.status !== 'stopped') fail('INTERRUPTED_CAPTURE', 'stop capture before verification');
  const names = await fs.readdir(path.join(dir, 'responses')).catch((error) => fail('MISSING_CAPTURE_FILE', error.message));
  const events = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => captureJson(path.join(dir, 'responses', name))));
  const failure = events.find((entry) => entry.failure);
  if (failure) fail(failure.failure, failure.detail);
  const records = await Promise.all(events.map(async (entry) => ({ ...entry, data: await captureJson(path.join(dir, 'responses', entry.rawFile)) })));
  const headlines = records.filter((entry) => /__(get_saved_backtest|get_backtest_results)$/.test(entry.toolName));
  if (headlines.length !== 1) fail('HEADLINE_COUNT', 'expected exactly one OO headline response');
  const headline = headlines[0];
  const sourceKey = headline.toolName.endsWith('get_saved_backtest') ? 'savedBacktestId' : 'runId';
  const sourceId = headline.toolInput?.[sourceKey];
  if (typeof sourceId !== 'string' || !sourceId || (headline.toolName.endsWith('get_saved_backtest') && headline.data.id !== sourceId)) fail('SOURCE_MISMATCH', 'headline identity does not match recorded call');
  const result = sourceKey === 'runId' ? headline.data : headline.data.result;
  if (!result || !Number.isInteger(result.numberOfTrades) || !Number.isInteger(result.numberOfOpenTrades) || result.numberOfTrades < 0 || result.numberOfOpenTrades < 0) fail('INVALID_HEADLINE', 'OO count/open-at-end figures unavailable');
  const expectedProfit = money(result.profit, 'OO profit');
  // Two OO servers (e.g. production and staging) can reuse an id, so every page must come from the headline's server.
  const server = headline.toolName.slice(0, headline.toolName.lastIndexOf('__'));
  const pages = records.filter((entry) => entry.toolName.endsWith('__get_trade_log'));
  if (!pages.length) fail('MISSING_PAGE', 'no trade-log pages captured');
  if (pages.some((page) => page.toolName !== `${server}__get_trade_log`)) fail('SOURCE_MISMATCH', 'trade-log page from a different OO server than the headline');
  for (const page of pages) {
    const args = page.toolInput || {};
    if (args[sourceKey] !== sourceId || sourceKeys.some((key) => key !== sourceKey && args[key] != null) || args.savedPortfolioId != null) fail('SOURCE_MISMATCH', 'trade-log page from another source');
    if (['outcome', 'reasonClosed', 'strategyIds'].some((key) => Object.hasOwn(args, key))) fail('FILTERED_LOG', 'trade-log filter arguments are not permitted');
    if (Object.entries(sort).some(([key, value]) => args[key] !== value)) fail('SORT_MISMATCH', 'limit/sort differs from fixed ascending opening order');
    if (!Number.isInteger(args.offset) || args.offset < 0 || page.data.offset !== args.offset || !Array.isArray(page.data.items) || !Number.isInteger(page.data.totalCount)) fail('INVALID_PAGE', 'offset, count or items malformed');
    if (page.data.sortedBy !== sort.sortBy || page.data.direction !== sort.direction) fail('SORT_MISMATCH', 'OO returned a different sort');
  }
  pages.sort((a, b) => a.toolInput.offset - b.toolInput.offset);
  for (let i = 1; i < pages.length; i++) if (pages[i].toolInput.offset === pages[i - 1].toolInput.offset) fail('DUPLICATE_PAGE', `offset ${pages[i].toolInput.offset} repeated`);
  let offset = 0;
  const count = pages[0].data.totalCount;
  const all = [];
  for (const page of pages) {
    if (page.toolInput.offset < offset) fail('DUPLICATE_PAGE', `offset ${page.toolInput.offset} overlaps prior page`);
    if (page.toolInput.offset > offset) fail('MISSING_PAGE', `expected offset ${offset}, got ${page.toolInput.offset}`);
    if (page.data.totalCount !== count) fail('UNSTABLE_TOTAL', 'totalCount changed between pages');
    const nextOffset = page.data.nextOffset ?? null;
    if (page.data.items.length > 100 || (nextOffset !== null && page.data.items.length !== 100)) fail('INVALID_PAGE', 'non-terminal page must contain 100 trades');
    offset += page.data.items.length;
    if (nextOffset !== (offset === count ? null : offset)) fail('INTERRUPTED_CAPTURE', `nextOffset incorrect or terminal page absent at ${offset}`);
    all.push(...page.data.items);
  }
  if (offset !== count || pages.at(-1).data.nextOffset != null) fail('INTERRUPTED_CAPTURE', 'last page not terminal');
  const economic = all.filter((item) => item.isIgnored !== true);
  if (economic.length !== result.numberOfTrades) fail('TRADE_COUNT_MISMATCH', `${economic.length} economic rows vs OO ${result.numberOfTrades}`);
  const profit = economic.reduce((sum, trade) => sum + money(trade.profit, 'trade profit'), 0);
  if (profit !== expectedProfit) fail('PROFIT_MISMATCH', `${profit} cents vs OO ${expectedProfit} cents`);
  const lines = [columns.join(','), ...economic.map(row)];
  if (!economic.length) fail('EMPTY_BLOCK', 'import_csv cannot import an empty trade log');
  // verify is a pure function of the saved responses, so a re-run (after success or an interruption) rewrites both files.
  const csvPath = path.join(dir, 'tradelog.csv');
  await fs.writeFile(csvPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  const summary = { id, csvPath, source: { [sourceKey]: sourceId }, trades: economic.length, ignoredRows: all.length - economic.length, openAtEnd: result.numberOfOpenTrades, ooProfit: (expectedProfit / 100).toFixed(2), csvPlBasis: 'net_includes_fees', reconciliation: 'count and net profit match OO to the cent' };
  await fs.writeFile(path.join(dir, 'verification.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}
export async function list() {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return await Promise.all(entries.filter((item) => item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name)).map(async (item) => {
      const state = await json(path.join(root, item.name, 'manifest.json'));
      return { id: item.name, status: state.status, directory: path.join(root, item.name), startedAt: state.startedAt, verified: await fs.access(path.join(root, item.name, 'verification.json')).then(() => true, () => false) };
    }));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function remove(id) {
  const dir = capturePath(id);
  const state = await json(path.join(dir, 'manifest.json'));
  if (await marker(state.session)?.then((armed) => armed?.id === id)) fail('ARMED_CAPTURE', 'stop this capture before deletion');
  await fs.rm(dir, { recursive: true });
  return { deleted: id, note: 'Imported TradeBlocks blocks are separate; delete one with its normal TradeBlocks block action.' };
}
// Compare native real paths: a URL pathname is percent-escaped and a symlinked install differs from its target.
const cli = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (cli) {
  const [command, arg] = process.argv.slice(2);
  try {
    const result = command === 'start' ? await start(arg) : command === 'stop' ? await stop(arg) : command === 'verify' ? await verify(arg) : command === 'list' ? await list() : command === 'delete' ? await remove(arg) : fail('COMMAND', 'use start|stop|verify|list|delete');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
