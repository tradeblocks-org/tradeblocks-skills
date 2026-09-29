#!/usr/bin/env node
import { hook } from './oo-capture.mjs';

try {
  let input = '';
  for await (const part of process.stdin) input += part;
  const result = await hook(JSON.parse(input));
  if (result) {
    const pagination = result.page ? ` Page ${result.page.source}, sort=${result.page.sortedBy} ${result.page.direction}, offset=${result.page.offset}, trades=${result.page.tradeCount}, totalCount=${result.page.totalCount}, nextOffset=${result.page.nextOffset === null ? 'terminal' : result.page.nextOffset}.` : '';
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.failure ? `OO capture ${result.captureId} FAILED ${result.failure}: ${result.detail}. Stop capture; verification must refuse publication.` : `OO capture ${result.captureId}: ${result.toolName} saved ${result.origin}.${pagination}` } }));
  }
} catch (error) {
  console.error(`OO_CAPTURE_HOOK_FAILURE: ${error.stack || error}`);
  process.exitCode = 2;
}
