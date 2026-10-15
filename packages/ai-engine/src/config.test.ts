import { describe, expect, it } from 'vitest';
import { loadGatewayConfig, resolveRoute } from './config.js';

describe('gateway config', () => {
  it('defaults to OpenAI until Claude is switched on', () => {
    const config = loadGatewayConfig({});
    expect(resolveRoute(config, 'chat')).toEqual({
      provider: 'openai',
      model: 'gpt-6-astra',
      effort: 'medium',
    });
  });

  it('uses Claude Opus 5.5 when a route is switched to Anthropic', () => {
    const config = loadGatewayConfig({ LLM_ROUTES: '{"expert":{"provider":"anthropic"}}' });
    expect(resolveRoute(config, 'expert')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
    expect(resolveRoute(config, 'chat').provider).toBe('openai');
  });

  it('only keeps keys that are set', () => {
    expect(loadGatewayConfig({ OPENAI_API_KEY: 'sk-test' }).apiKeys).toEqual({ openai: 'sk-test' });
  });

  it('rejects unknown routes and fields', () => {
    expect(() => loadGatewayConfig({ LLM_ROUTES: '{"nope":{}}' })).toThrow(/LLM_ROUTES/);
    expect(() => loadGatewayConfig({ LLM_ROUTES: '{"chat":{"temperature":1}}' })).toThrow(
      /LLM_ROUTES/,
    );
    expect(() => loadGatewayConfig({ LLM_ROUTES: 'not json' })).toThrow(/LLM_ROUTES/);
  });

  it('names bad variables without echoing their values', () => {
    const secret = 'sk-should-not-appear';
    try {
      loadGatewayConfig({ OPENAI_API_KEY: secret, LLM_DEFAULT_PROVIDER: secret });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('LLM_DEFAULT_PROVIDER');
      expect(String(err)).not.toContain(secret);
    }
  });
});
