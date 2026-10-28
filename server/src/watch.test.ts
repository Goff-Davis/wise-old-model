import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/helpers.ts';
import { changesIn, runWatched } from './watch.ts';

describe('changesIn', () => {
  it('says when a source file changes, appears or goes, but not for tests or other files', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'sub'));
    const file = path.join(dir, 'sub', 'a.ts');
    writeFileSync(file, '');
    const changed = changesIn([dir]);
    expect(changed()).toBe(false);

    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(changed()).toBe(true);
    expect(changed()).toBe(false);

    writeFileSync(path.join(dir, 'b.ts'), '');
    expect(changed()).toBe(true);
    rmSync(path.join(dir, 'b.ts'));
    expect(changed()).toBe(true);

    writeFileSync(path.join(dir, 'a.test.ts'), '');
    writeFileSync(path.join(dir, 'notes.md'), '');
    expect(changed()).toBe(false);
  });
});

/** A server process: it records being killed, and exits when the test says. */
class FakeServer extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills = 0;

  kill(): boolean {
    this.kills += 1;
    return true;
  }

  /** Ends the process, as a kill does (no code) or a crash does (an exit code). */
  exit(code: number | null = null): void {
    if (code === null) this.signalCode = 'SIGTERM';
    else this.exitCode = code;
    this.emit('exit');
  }
}

/** runWatched over fake servers and a fake clock; `change()` makes the next check see a change. */
function watched() {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const servers: FakeServer[] = [];
  let pending = false;
  const stop = runWatched({
    start: () => {
      const server = new FakeServer();
      servers.push(server);
      return server;
    },
    changed: () => {
      const was = pending;
      pending = false;
      return was;
    },
    everyMs: 1000,
  });
  return {
    servers,
    stop,
    change: () => (pending = true),
    tick: () => vi.advanceTimersByTime(1000),
  };
}

describe('runWatched', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the server, and starts it again after a change once the old one has exited', () => {
    const { servers, change, tick } = watched();
    expect(servers).toHaveLength(1);
    tick();
    expect(servers[0]?.kills).toBe(0);

    change();
    tick();
    expect(servers[0]?.kills).toBe(1);
    // The new one waits, so the old one has freed the port.
    expect(servers).toHaveLength(1);
    servers[0]?.exit();
    expect(servers).toHaveLength(2);
  });

  it('starts a server that crashed again at the next change', () => {
    const { servers, change, tick } = watched();
    servers[0]?.exit(1);
    tick();
    expect(servers).toHaveLength(1);
    change();
    tick();
    expect(servers).toHaveLength(2);
    expect(servers[0]?.kills).toBe(0);
  });

  it('starts one server for changes made while the old one is still stopping', () => {
    const { servers, change, tick } = watched();
    change();
    tick();
    change();
    tick();
    expect(servers[0]?.kills).toBe(1);
    servers[0]?.exit();
    tick();
    expect(servers).toHaveLength(2);
  });

  it('stops the server and the checks when stopped, even in the middle of a restart', () => {
    const { servers, stop, change, tick } = watched();
    change();
    tick();
    stop();
    servers[0]?.exit();
    change();
    tick();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.kills).toBe(2);
  });
});
