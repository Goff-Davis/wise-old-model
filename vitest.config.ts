import { defineConfig } from 'vitest/config';

// Spies, stubbed globals and stubbed environment variables are put back before every test, so
// tests don't restore them by hand.
const restore = { restoreMocks: true, unstubGlobals: true, unstubEnvs: true };

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './shared', environment: 'node', ...restore } },
      { test: { name: 'server', root: './server', environment: 'node', ...restore } },
      {
        extends: './client/vite.config.ts',
        test: {
          name: 'client',
          root: './client',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          ...restore,
        },
      },
    ],
  },
});
