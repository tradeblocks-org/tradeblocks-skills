#!/usr/bin/env node
import { hook } from './oo-capture.mjs';

try {
  let input = '';
  for await (const part of process.stdin) input += part;
  const result = await hook(JSON.parse(input));
  if (result) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.failure ? `OO capture ${result.captureId} FAILED ${result.failure}: ${result.detail}. Stop capture; verification must refuse publication.` : `OO capture ${result.captureId}: ${result.toolName} saved ${result.origin}.` } }));
} catch (error) {
  console.error(`OO_CAPTURE_HOOK_FAILURE: ${error.stack || error}`);
  process.exitCode = 2;
}
