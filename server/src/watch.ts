/**
 * Starting the server again in development when its code changes. Node's own --watch waits for
 * the file system to report changes, which a WSL checkout on a Windows drive (/mnt/c/...) never
 * gets, so this compares the files' modified times instead, the same way on every OS.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Every source file in `folders` with its modified time, leaving out tests (`.test.ts`). */
function sourceState(folders: string[]): string {
  const lines: string[] = [];
  for (const folder of folders) {
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
        continue;
      }
      const file = path.join(entry.parentPath, entry.name);
      lines.push(`${file} ${statSync(file).mtimeMs}`);
    }
  }
  return lines.sort().join('\n');
}

/** A check that says whether a source file in `folders` changed, appeared or went since the last. */
export function changesIn(folders: string[]): () => boolean {
  let seen = sourceState(folders);
  return () => {
    const now = sourceState(folders);
    if (now === seen) return false;
    seen = now;
    return true;
  };
}

/** What runWatched needs of the server's process; a ChildProcess has it all. */
export type Watched = {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(): boolean;
  once(event: 'exit', listener: () => void): unknown;
};

/**
 * Runs the server `start` gives, checking `changed` every `everyMs`. After a change the server
 * is stopped and, once it has exited (freeing its port), started again; a server that crashed
 * is started again at the next change. Gives a function that stops the server and the checks.
 */
export function runWatched(opts: {
  start: () => Watched;
  changed: () => boolean;
  everyMs: number;
}): () => void {
  let server = opts.start();
  let restarting = false;
  let stopped = false;
  const begin = () => {
    restarting = false;
    if (!stopped) server = opts.start();
  };
  const timer = setInterval(() => {
    // A change while restarting needs nothing more: the new server starts after it.
    if (!opts.changed() || restarting) return;
    console.log('The code changed, so the server is starting again.');
    if (server.exitCode !== null || server.signalCode !== null) {
      begin();
      return;
    }
    restarting = true;
    server.once('exit', begin);
    server.kill();
  }, opts.everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    server.kill();
  };
}
