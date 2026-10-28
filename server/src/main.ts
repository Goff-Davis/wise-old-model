import os from 'node:os';
import { ConfigError, loadConfig } from './config.ts';
import { StartError, startServer } from './start.ts';

try {
  const config = loadConfig(process.env, process.platform, os.homedir());
  await startServer(config);
  console.log(`Wise Old Model is running at http://127.0.0.1:${config.port}`);
} catch (error) {
  if (!(error instanceof ConfigError || error instanceof StartError)) throw error;
  console.error(error.message);
  process.exit(1);
}
