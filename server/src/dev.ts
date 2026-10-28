// `npm run dev:server`: the server, started again whenever its code or the shared code changes.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changesIn, runWatched } from './watch.ts';

const stop = runWatched({
  start: () =>
    spawn(
      process.execPath,
      ['--env-file-if-exists=.env', fileURLToPath(new URL('main.ts', import.meta.url))],
      { stdio: 'inherit' },
    ),
  changed: changesIn([
    fileURLToPath(new URL('.', import.meta.url)),
    fileURLToPath(new URL('../../shared/src', import.meta.url)),
  ]),
  everyMs: 1000,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop();
    process.exit();
  });
}
