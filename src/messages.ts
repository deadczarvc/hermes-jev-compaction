import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import { resolveJevEndpoint, selectJevApiKey } from './providers.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & JevClientOptions;

/** Compact with the selected provider's endpoint, model and credential policy. */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  const endpoint = resolveJevEndpoint(options);
  const apiKey = selectJevApiKey(endpoint, options.apiKey, process.env);
  // Mask the selected key before cutting history; a missing key must not trigger another ambient lookup.
  const secrets = [...(options.secrets ?? []), ...(apiKey ? [apiKey] : [])];
  const client = new JevClient({ ...options, ...endpoint, apiKey: apiKey ?? '' });
  return compact(messages, client, { ...options, secrets });
}
