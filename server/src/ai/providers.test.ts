import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers.ts';
import { createProviders } from './providers.ts';

describe('createProviders', () => {
  // It loads the providers' SDKs, which takes seconds on a slow drive.
  it('sets up Claude always, and each other AI that .env sets up, with its name and model', async () => {
    expect((await createProviders(testConfig(), {})).map((provider) => provider.info)).toEqual([
      { id: 'claude', name: 'Claude', choosesBilling: true, defaultModel: null },
    ]);
    const config = testConfig({
      openAiCompat: {
        baseUrl: 'http://localhost:11434/v1',
        apiKey: null,
        name: 'Ollama',
        model: 'qwen3:14b',
      },
      gemini: { apiKey: 'AIza-test', model: null },
    });
    expect((await createProviders(config, {})).map((provider) => provider.info)).toEqual([
      { id: 'claude', name: 'Claude', choosesBilling: true, defaultModel: null },
      { id: 'openai', name: 'Ollama', choosesBilling: false, defaultModel: 'qwen3:14b' },
      { id: 'gemini', name: 'Gemini', choosesBilling: false, defaultModel: null },
    ]);
  }, 30_000);
});
