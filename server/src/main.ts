import os from 'node:os';
import { createProviders } from './ai/providers.ts';
import { ConfigError, loadConfig } from './config.ts';
import { StartError, startServer } from './start.ts';

try {
  const config = loadConfig(process.env, process.platform, os.homedir());
  // Every AI .env sets up; Settings → AI picks which answers.
  await startServer(config, { providers: await createProviders(config, process.env) });
  console.log(`Wise Old Model is running at http://127.0.0.1:${config.port}`);
} catch (error) {
  if (!(error instanceof ConfigError || error instanceof StartError)) throw error;
  console.error(error.message);
  process.exit(1);
}
