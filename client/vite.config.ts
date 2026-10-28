import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import { DEFAULT_PORT, VITE_DEV_PORT } from '@wom/shared';
import { defineConfig } from 'vite';

/** The repo root's .env, the one the server reads. */
export const ROOT_ENV_FILE = new URL('../.env', import.meta.url);

/** The port the server listens on, found the way the server finds it: PORT, then the .env file. */
export function serverPort(envFile: URL = ROOT_ENV_FILE): string {
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')).PORT : undefined;
  return (process.env.PORT ?? fromFile)?.trim() || String(DEFAULT_PORT);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: VITE_DEV_PORT,
    strictPort: true,
    // changeOrigin: false keeps the browser's Host, which the server's local-only check needs
    // (Vite's string shorthand rewrites it). With cors off, pages on other localhost ports
    // can't read API answers through the proxy.
    proxy: { '/api': { target: `http://127.0.0.1:${serverPort()}`, changeOrigin: false } },
    cors: false,
  },
  build: { outDir: 'dist' },
});
