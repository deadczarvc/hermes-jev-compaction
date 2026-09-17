import { compactMessages, type Message } from '../src/index.js';

const messages: Message[] = [
  { role: 'system', content: 'You are a careful coding agent. Work in the repository and explain changes.' },
  { role: 'user', content: 'Fix the failing parser test in the checkout service.' },
  { role: 'assistant', content: 'I will inspect the test and the parser implementation first.' },
  { role: 'tool', content: 'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts\npackage.json' },
  { role: 'assistant', content: 'The failure is in parser.test.ts, and the legacy parser is unrelated.' },
  { role: 'tool', content: 'FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false' },
  { role: 'tool', content: 'Error: expected true to be true\n    at src/parser.test.ts:42:11\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)' },
  { role: 'user', content: 'Do not touch legacy/. Keep the public parser API backward compatible.' },
  { role: 'assistant', content: 'I will limit the change to the public parser and its focused test.' },
  { role: 'tool', content: 'git status --short\n M src/parser.ts' },
  { role: 'assistant', content: 'The parser rejects a comma before the closing brace because the token loop stops too early.' },
  { role: 'assistant', content: 'I am adding one transition for a trailing comma without changing the exported API.' },
  { role: 'tool', content: 'diff -- src/parser.ts\n+ if (token === COMMA && next === CLOSE_BRACE) continue;' },
  { role: 'assistant', content: 'The focused test now passes locally.' },
  { role: 'tool', content: 'PASS src/parser.test.ts\n  parser\n    ✓ accepts a trailing comma (4 ms)\nTests: 1 passed, 1 total' },
  { role: 'user', content: 'Please run the full test suite too.' },
  { role: 'assistant', content: 'I will run the full suite and check formatting.' },
  { role: 'tool', content: 'npm test\nPASS src/parser.test.ts\nPASS src/checkout.test.ts\nTest Suites: 2 passed, 2 total' },
  { role: 'tool', content: 'npm run format:check\nAll files use the expected formatting.' },
  { role: 'assistant', content: 'Everything passes. The change is isolated to the parser.' },
  { role: 'user', content: 'Great, thanks.' },
  { role: 'assistant', content: 'You are welcome.' },
  { role: 'user', content: 'One more thing: remember the compatibility constraint for future work.' },
  { role: 'assistant', content: 'Understood. The public parser API remains unchanged.' },
  { role: 'tool', content: 'git diff --check\nNo whitespace errors found.' },
];

const result = await compactMessages(messages, {
  goal: 'Fix the trailing-comma parser test without touching legacy/ or breaking the public API.',
});

console.log('id | action | reason | drop p | kind | first 60 chars');
for (const decision of result.result.decisions) {
  const chunk = result.result.kept.find(({ id }) => id === decision.id)
    ?? result.result.dropped.find(({ id }) => id === decision.id);
  console.log(
    `${decision.id} | ${decision.action} | ${decision.reason} | ${decision.drop.toFixed(3)} | ${decision.kind} | ${(chunk?.text ?? '').slice(0, 60)}`,
  );
}
console.log('');
console.log('stats:', JSON.stringify(result.result.stats));
const saved = result.result.stats.charsBefore === 0
  ? 0
  : (1 - result.result.stats.charsAfter / result.result.stats.charsBefore) * 100;
console.log(`chars saved: ${saved.toFixed(1)}%`);
console.log(`messages after compaction: ${result.messages.length}`);
