import { describe, it, expect } from 'vitest';
import { parseWorkerOutput } from '../../src/dispatch/parser.js';

describe('parseWorkerOutput', () => {
  it('parses valid JSON on last line (structured mode)', () => {
    const output = 'some preamble\n{"status":"ok","artifact":{"x":1}}';
    const result = parseWorkerOutput(output);
    expect(result).toEqual({ status: 'ok', artifact: { x: 1 } });
  });

  it('parses JSON embedded before trailing lines', () => {
    const output = '{"status":"ok","artifact":{}}\nDone.';
    const result = parseWorkerOutput(output);
    expect(result).toEqual({ status: 'ok', artifact: {} });
  });

  it('returns null for empty stdout', () => {
    expect(parseWorkerOutput('')).toBeNull();
    expect(parseWorkerOutput('   \n  ')).toBeNull();
  });

  it('returns null when no valid JSON found in last 20 lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `plain text ${i}`).join('\n');
    expect(parseWorkerOutput(lines)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseWorkerOutput('{bad json}')).toBeNull();
  });

  it('accepts error status', () => {
    const output = '{"status":"error","artifact":null}';
    const result = parseWorkerOutput(output);
    expect(result?.status).toBe('error');
  });

  it('parses votes field when present', () => {
    const votes = { recommendation: 'a', confidence: 0.9, rationale: 'r', dimensions: { x: 'agree' } };
    const output = JSON.stringify({ status: 'ok', artifact: {}, votes });
    expect(parseWorkerOutput(output)?.votes).toEqual(votes);
  });
});
