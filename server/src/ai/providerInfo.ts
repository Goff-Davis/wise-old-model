import { PROVIDERS, type ProviderId, ProviderIdSchema, type ProviderInfo } from '@wom/shared';
import type { ChatProvider } from './provider.ts';

/** A provider that isn't set up, as Settings shows it: its name and what .env needs. */
export const notSetUp = (id: ProviderId): ProviderInfo => ({
  id,
  ...PROVIDERS[id],
  configured: false,
  choosesBilling: false,
});

/**
 * Every provider, as Settings → AI lists them: the ones in `ready` as they are, and for each of
 * the others, what to add to .env. Never a key. (Apart from the providers themselves, so what
 * uses it needs none of their SDKs.)
 */
export function providerInfos(ready: ChatProvider[]): ProviderInfo[] {
  return ProviderIdSchema.options.map((id) => {
    const provider = ready.find((one) => one.info.id === id);
    if (!provider) return notSetUp(id);
    const { name, choosesBilling } = provider.info;
    return { id, name, configured: true, choosesBilling, setup: null };
  });
}
