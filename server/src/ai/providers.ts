import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.ts';
import { claudeFolder, createClaudeProvider } from './claudeProvider.ts';
import type { ChatProvider } from './provider.ts';

/**
 * The providers .env sets up, each started once for the app: Claude always (through Claude
 * Code, in its own folder of the data folder), the OpenAI-compatible API when its address is
 * set, and Gemini when its key is. Their SDKs are loaded only when they're set up, as loading
 * one takes seconds on a slow drive.
 */
export async function createProviders(
  config: Config,
  env: NodeJS.ProcessEnv,
): Promise<ChatProvider[]> {
  const providers = [
    createClaudeProvider({
      query,
      cwd: claudeFolder(config.dataDir),
      env,
      apiKey: config.anthropicApiKey,
    }),
  ];
  if (config.openAiCompat) {
    const { createOpenAiProvider, openAiClient } = await import('./openaiProvider.ts');
    const client = openAiClient(config.openAiCompat);
    providers.push(createOpenAiProvider({ client, config: config.openAiCompat }));
  }
  if (config.gemini) {
    const { createGeminiProvider, geminiClient } = await import('./geminiProvider.ts');
    const client = geminiClient(config.gemini);
    providers.push(createGeminiProvider({ client, config: config.gemini }));
  }
  return providers;
}
