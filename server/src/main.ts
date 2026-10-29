import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeFolder, createClaudeProvider } from './ai/claudeProvider.ts';
import { ConfigError, loadConfig } from './config.ts';
import { StartError, startServer } from './start.ts';

try {
  const config = loadConfig(process.env, process.platform, os.homedir());
  // Claude through the Agent SDK, in its own folder of the data folder.
  const provider = createClaudeProvider({
    query,
    cwd: claudeFolder(config.dataDir),
    env: process.env,
    apiKey: config.anthropicApiKey,
  });
  await startServer(config, { provider });
  console.log(`Wise Old Model is running at http://127.0.0.1:${config.port}`);
} catch (error) {
  if (!(error instanceof ConfigError || error instanceof StartError)) throw error;
  console.error(error.message);
  process.exit(1);
}
