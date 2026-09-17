import type {
  JevQuestions,
  JevResponse,
  JevState,
} from './types.js';

export interface JevClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class JevClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model ?? 'jev-latest';
    this.baseUrl =
      options.baseUrl ?? 'https://api.typesafe.ai/v1/systemone';
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const response = await this.fetcher(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        state,
        questions,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Jev request failed (${response.status} ${response.statusText}): ${await response.text()}`,
      );
    }

    return (await response.json()) as JevResponse;
  }
}
