import { describe, expect, it } from 'vitest';
import { factLines } from '../src/compact.js';
import { tokenValues, valueLines } from '../src/value-select.js';

const filler = Array.from({ length: 400 }, (_, i) => `node 10.0.${i % 250}.${i % 200}:8${String(i).padStart(3, '0')} pid ${50000 + i} size 1${i} bytes deadbeef${i.toString(16).padStart(4, '0')} /srv/app/v1.2.${i}/x.log`);
filler[230] = 'artifact ready: build/out_cafe.tar';
filler[260] = 'step three failed: permission denied';
const text = filler.join('\n');
const ctx = { input: '{"command":"make"}', user: 'build it', dist: 2, reused: new Set(['build/out_cafe.tar']) };
const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

describe('valueLines (V4)', () => {
  it('keeps a token the agent reused and every error piece, within the regex lines size', () => {
    for (const budget of [360, 1200, 12_000]) {
      const regex = factLines(text, budget);
      const v4 = valueLines(text, budget, tokenValues(text, ctx));
      expect(regex).not.toContain('artifact ready: build/out_cafe.tar');
      expect(v4).toContain('artifact ready: build/out_cafe.tar');
      expect(v4).toContain('step three failed: permission denied');
      expect(size(v4)).toBeLessThanOrEqual(size(regex));
    }
  });

  it('values a reused token above the same token unused', () => {
    const used = tokenValues(text, ctx).get('build/out_cafe.tar')!;
    const unused = tokenValues(text, { ...ctx, reused: new Set<string>() }).get('build/out_cafe.tar')!;
    expect(used).toBeGreaterThan(unused);
  });
});
