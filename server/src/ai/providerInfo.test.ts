import { describe, expect, it } from 'vitest';
import { createFakeProvider } from './fakeProvider.ts';
import { providerInfos } from './providerInfo.ts';

describe('providerInfos', () => {
  it('lists every AI in order, saying what .env needs for each one not set up', () => {
    const gemini = createFakeProvider([], { id: 'gemini', name: 'Gemini', choosesBilling: false });
    expect(providerInfos([gemini.provider])).toEqual([
      {
        id: 'claude',
        name: 'Claude',
        configured: false,
        choosesBilling: false,
        setup: 'This copy of Wise Old Model was started without it.',
      },
      {
        id: 'openai',
        name: 'OpenAI-compatible',
        configured: false,
        choosesBilling: false,
        setup:
          'Set OPENAI_COMPAT_BASE_URL in .env (and OPENAI_COMPAT_API_KEY if the API needs a key), then restart Wise Old Model.',
      },
      { id: 'gemini', name: 'Gemini', configured: true, choosesBilling: false, setup: null },
    ]);
  });
});
