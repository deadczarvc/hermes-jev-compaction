import { describe, expect, it } from 'vitest';
import {
  requireJevApiKey, resolveJevEndpoint, selectJevApiKey, wireOf,
  type JevProvider, type JevProviderOptions,
} from '../src/index.js';

const T = 'https://api.typesafe.ai/v1/systemone';
const D = 'https://api.openai.com/v1/decisions';
const L = 'https://api.liquid.ai/decisions/v1/systemone';
const U = 'https://api.upstage.ai/v1/systemone';
const E = resolveJevEndpoint;
const K = selectJevApiKey;

describe('decision-model providers: luna (OpenAI Decisions)', () => {
  it('consent ⇒ exact Decisions tuple', () => {
    const result = E({ provider: 'luna', allowThirdPartyEgress: true });
    expect(result).toEqual({ provider: 'luna', baseUrl: D, model: 'gpt-6-luna', keyEnv: 'OPENAI_API_KEY', thirdParty: true });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('without consent ⇒ deny before any key read', () => {
    expect(() => E({ provider: 'luna' })).toThrow('Third-party Jev egress is disabled');
  });

  it('baseUrl is pinned; a server mismatch never redirects', () => {
    expect(() => E({ provider: 'luna', allowThirdPartyEgress: true, baseUrl: T })).toThrow('baseUrl does not match selected Jev provider');
    expect(() => E({ provider: 'luna', allowThirdPartyEgress: true, baseUrl: D + '?x=1' })).toThrow('baseUrl does not match selected Jev provider');
  });

  it('only the public-beta model is accepted', () => {
    for (const model of ['gpt-6-luna2', 'gpt-6-luna ', 'gpt-6', 'luna']) {
      expect(() => E({ provider: 'luna', allowThirdPartyEgress: true, model })).toThrow('Unsupported Jev model for selected provider');
    }
    expect(E({ provider: 'luna', allowThirdPartyEgress: true, model: 'gpt-6-luna' }).model).toBe('gpt-6-luna');
  });

  it('reads only OPENAI_API_KEY', () => {
    const endpoint = E({ provider: 'luna', allowThirdPartyEgress: true });
    expect(K(endpoint, undefined, { OPENAI_API_KEY: 'fixtureOpenAi' })).toBe('fixtureOpenAi');
    expect(K(endpoint, undefined, { TYPESAFE_API_KEY: 'fixtureTypeSafe' })).toBeUndefined();
    expect(() => requireJevApiKey(endpoint, K(endpoint, undefined, {}))).toThrow('OPENAI_API_KEY is not configured');
  });
});

describe('decision-model providers: liquid (d1) and solar (solar-decide)', () => {
  it('liquid consent ⇒ Liquid d1 tuple', () => {
    expect(E({ provider: 'liquid', allowThirdPartyEgress: true })).toEqual({
      provider: 'liquid', baseUrl: L, model: 'd1', keyEnv: 'LIQUID_API_KEY', thirdParty: true,
    });
  });

  it('liquid accepts the model tag form and rejects others', () => {
    expect(E({ provider: 'liquid', allowThirdPartyEgress: true, model: 'd1:free' }).model).toBe('d1:free');
    for (const model of ['d2', 'D1', 'd1/', 'd1 x']) {
      expect(() => E({ provider: 'liquid', allowThirdPartyEgress: true, model })).toThrow('Unsupported Jev model for selected provider');
    }
  });

  it('solar consent ⇒ Upstage solar-decide tuple', () => {
    expect(E({ provider: 'solar', allowThirdPartyEgress: true })).toEqual({
      provider: 'solar', baseUrl: U, model: 'solar-decide', keyEnv: 'UPSTAGE_API_KEY', thirdParty: true,
    });
    expect(() => E({ provider: 'solar', allowThirdPartyEgress: true, model: 'solar-decide:beta' })).toThrow('Unsupported Jev model for selected provider');
  });

  it('both deny without consent and read only their own namespace', () => {
    expect(() => E({ provider: 'liquid' })).toThrow('Third-party Jev egress is disabled');
    expect(() => E({ provider: 'solar' })).toThrow('Third-party Jev egress is disabled');
    expect(K(E({ provider: 'liquid', allowThirdPartyEgress: true }), undefined, { LIQUID_API_KEY: 'fixtureLiquid' })).toBe('fixtureLiquid');
    expect(K(E({ provider: 'solar', allowThirdPartyEgress: true }), undefined, { UPSTAGE_API_KEY: 'fixtureUpstage' })).toBe('fixtureUpstage');
    expect(K(E({ provider: 'solar', allowThirdPartyEgress: true }), undefined, { LIQUID_API_KEY: 'fixtureLiquid' })).toBeUndefined();
  });
});

describe('openrouter also serves the decider catalog', () => {
  it('accepts solar-decide and d1 model ids', () => {
    for (const model of ['upstage/solar-decide', 'liquid/d1', 'liquid/d1:free']) {
      expect(E({ provider: 'openrouter', allowThirdPartyEgress: true, model }).model).toBe(model);
    }
  });

  it('rejects lookalikes and other vendors', () => {
    for (const model of ['upstage/solar-decide2', 'upstage/solar', 'liquid/', 'liquid/d1/2', 'liquid/d2']) {
      expect(() => E({ provider: 'openrouter', allowThirdPartyEgress: true, model })).toThrow('Unsupported Jev model for selected provider');
    }
  });
});

describe('wire selection', () => {
  it('luna speaks Decisions; every other provider speaks System One', () => {
    const table: Record<JevProvider, 'systemone' | 'decisions'> = {
      typesafe: 'systemone', openrouter: 'systemone', vercel: 'systemone',
      luna: 'decisions', liquid: 'systemone', solar: 'systemone', custom: 'systemone',
    };
    for (const [provider, wire] of Object.entries(table)) {
      expect(wireOf(provider as JevProvider)).toBe(wire);
    }
  });

  it('unknown providers still fail closed', () => {
    expect(() => E({ provider: 'gateway', allowThirdPartyEgress: true } as unknown as JevProviderOptions)).toThrow('Unknown Jev provider');
  });
});
