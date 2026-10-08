#!/usr/bin/env node
// hermes-compact — on-demand Jev compaction for Hermes Agent transcripts.
// Part of hermes-jev-compaction (https://github.com/deadczarvc/hermes-jev-compaction).
//
// Reads an OpenAI-chat-format transcript (JSON array of messages, or an
// object with a `messages` array; JSONL also accepted), compacts it with the
// fast-jev-compaction library, and writes the compacted transcript.
//
// The API key comes from the TYPESAFE_API_KEY environment variable (never
// pass it as an argument). Default model `jev-latest` (currently resolves to
// jev-1.13.0); pin explicitly with --model jev-1.13.0.

import { readFileSync, writeFileSync } from 'node:fs';
import { collectToolCalls, compactMessages, resolveJevEndpoint, resolveOptions, selectJevApiKey } from '../dist/index.js';
import { fromHermes, hermesGoal, toHermes } from '../dist/hermes.js';

function usage(code) {
  const lines = [
    'Usage: hermes-compact <transcript.json> [options]',
    '',
    'Input: JSON array of OpenAI-chat messages, {"messages": [...]} or JSONL.',
    'Output: JSON {"messages": [...], "stats": {...}} (compacted transcript).',
    '',
    'Options:',
    '  -o, --out <file>          output file (default: stdout)',
    '  --model <name>            Jev model (default: jev-latest; pin jev-1.13.0)',
    '  --goal <text>             explicit goal (default: system texts, then last user prompts)',
    '  --keep-threshold <n>      min keep probability (default 0.5)',
    '  --preserve-recent <n>     newest messages never touched (default 6)',
    '  --max-state-tokens <n>    state token ceiling (default 25000)',
    '  --max-request-tokens <n>  request token ceiling (default 30000)',
    '  --truncate-head <n>       chars kept of a dropped result (default 200)',
    '  --provider <name>         typesafe | openrouter | vercel | luna | liquid | solar | custom (default typesafe)',
    '  --allow-third-party       required for every non-typesafe provider before any key read or HTTP',
    '  --dry-run                 map and report only; no Jev requests, no key needed',
    '  -h, --help                this help',
    '',
    'Env: the selected provider\'s key namespace — TYPESAFE_API_KEY (default), OPENROUTER_API_KEY,',
    'AI_GATEWAY_API_KEY, OPENAI_API_KEY (luna), LIQUID_API_KEY (liquid), UPSTAGE_API_KEY (solar).',
  ];
  console.error(lines.join('\n'));
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { model: null, provider: null, allowThirdParty: false, out: null, goal: '', dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`missing value for ${arg}`);
        usage(2);
      }
      return value;
    };
    const number = () => {
      const value = Number(next());
      if (!Number.isFinite(value)) {
        console.error(`not a number for ${arg}`);
        usage(2);
      }
      return value;
    };
    switch (arg) {
      case '--model': opts.model = next(); break;
      case '--provider': opts.provider = next(); break;
      case '--allow-third-party': opts.allowThirdParty = true; break;
      case '--out': case '-o': opts.out = next(); break;
      case '--goal': opts.goal = next(); break;
      case '--keep-threshold': opts.keepThreshold = number(); break;
      case '--preserve-recent': opts.preserveRecentMessages = number(); break;
      case '--max-state-tokens': opts.maxStateTokens = number(); break;
      case '--max-request-tokens': opts.maxRequestTokens = number(); break;
      case '--truncate-head': opts.truncateHeadChars = number(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': usage(0); break;
      default:
        if (arg.startsWith('-')) {
          console.error(`unknown option: ${arg}`);
          usage(2);
        }
        positional.push(arg);
    }
  }
  return { opts, positional };
}

function loadTranscript(file) {
  const raw = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) return parsed.messages;
  console.error('input must be a JSON array of messages, {"messages": [...]}, or JSONL');
  process.exit(2);
}

const { opts, positional } = parseArgs(process.argv.slice(2));
if (positional.length !== 1) usage(2);

const hermesMessages = loadTranscript(positional[0]);
const transcript = fromHermes(hermesMessages);
const { messages, systemTexts } = transcript;
const goal = hermesGoal(systemTexts, opts.goal);

if (opts.dryRun) {
  const resolved = resolveOptions({ goal, ...opts });
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const stats = {
    dryRun: true,
    messages: messages.length,
    systemTexts: systemTexts.length,
    toolCalls: calls.length,
    candidates: calls.filter((call) => !call.pinned).length,
    pinned: calls.filter((call) => call.pinned).length,
  };
  const payload = JSON.stringify({ messages: toHermes(messages, transcript), stats }, null, 2);
  if (opts.out) writeFileSync(opts.out, payload);
  else console.log(payload);
  console.error(`dry-run: ${stats.toolCalls} tool calls, ${stats.candidates} candidates, ${stats.pinned} pinned`);
  process.exit(0);
}

// Provider/key policy lives in the library (resolveJevEndpoint/selectJevApiKey): the provider
// flag only selects it. luna speaks the OpenAI Decisions wire (POST /v1/decisions); the rest
// speak System One. The key comes from the selected provider's env namespace (never an argument).
const providerOptions = {
  ...(opts.provider === null ? {} : { provider: opts.provider }),
  ...(opts.allowThirdParty ? { allowThirdPartyEgress: true } : {}),
  ...(opts.model === null ? {} : { model: opts.model }),
};

if (!opts.dryRun) {
  const probe = resolveJevEndpoint({ ...providerOptions });
  const envKey = selectJevApiKey(probe, undefined, process.env);
  if (!envKey) {
    console.error(
      probe.keyEnv === null
        ? 'apiKey is required for custom provider'
        : `${probe.keyEnv} is not configured`,
    );
    process.exit(2);
  }
}

try {
  const result = await compactMessages(messages, {
    ...providerOptions,
    goal,
    keepThreshold: opts.keepThreshold,
    preserveRecentMessages: opts.preserveRecentMessages,
    maxStateTokens: opts.maxStateTokens,
    maxRequestTokens: opts.maxRequestTokens,
    truncateHeadChars: opts.truncateHeadChars,
  });
  const payload = JSON.stringify({ messages: toHermes(result.messages, transcript), stats: result.stats }, null, 2);
  if (opts.out) writeFileSync(opts.out, payload);
  else console.log(payload);
  const s = result.stats;
  const reduction =
    s.charsBefore === 0 ? 0 : Math.round(((s.charsBefore - s.charsAfter) / s.charsBefore) * 100);
  console.error(
    `kept ${s.kept}, results truncated ${s.resultsDropped}, calls dropped ${s.callsDropped}, ` +
      `pinned ${s.pinned}; ${reduction}% reduction; state ~${s.stateTokens} tokens ` +
      `(${s.stateStage}) in ${s.requests} request(s), ${s.ms} ms`,
  );
} catch (error) {
  console.error(`compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
