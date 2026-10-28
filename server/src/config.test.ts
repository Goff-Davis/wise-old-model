import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/helpers.ts';
import { ConfigError, loadConfig, readVersion, userAgent } from './config.ts';

const contact = { CONTACT: 'me#1234' };

/** loadConfig on Linux (and WSL) for /home/u, with CONTACT set unless a test overrides it. */
const onLinux = (env: Record<string, string> = {}) =>
  loadConfig({ ...contact, ...env }, 'linux', '/home/u');

/** The same on Windows for C:\Users\u. */
const onWindows = (env: Record<string, string> = {}) =>
  loadConfig({ ...contact, ...env }, 'win32', 'C:\\Users\\u');

describe('loadConfig', () => {
  it('requires CONTACT', () => {
    expect(() => loadConfig({}, 'linux', '/home/u')).toThrow(/CONTACT/);
    expect(() => loadConfig({}, 'linux', '/home/u')).toThrow(ConfigError);
    expect(() => loadConfig({ CONTACT: '   ' }, 'linux', '/home/u')).toThrow(/CONTACT/);
  });

  it('defaults on Linux', () => {
    const config = onLinux();
    expect(config.dataDir).toBe('/home/u/.local/share/wise-old-model');
    expect(config.runeliteDir).toBe('/home/u/.runelite');
    expect(config.port).toBe(4747);
    expect(onLinux({ XDG_DATA_HOME: '/x' }).dataDir).toBe('/x/wise-old-model');
  });

  it('defaults on macOS', () => {
    expect(loadConfig(contact, 'darwin', '/Users/u').dataDir).toBe(
      '/Users/u/Library/Application Support/wise-old-model',
    );
  });

  it('defaults on Windows', () => {
    const config = onWindows({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    expect(config.dataDir).toBe('C:\\Users\\u\\AppData\\Local\\wise-old-model');
    expect(config.runeliteDir).toBe('C:\\Users\\u\\.runelite');
  });

  it('uses LOCALAPPDATA on Windows, wherever it points', () => {
    expect(onWindows({ LOCALAPPDATA: 'D:\\Local' }).dataDir).toBe('D:\\Local\\wise-old-model');
  });

  it('falls back to AppData\\Local on Windows when LOCALAPPDATA is missing', () => {
    expect(onWindows().dataDir).toBe('C:\\Users\\u\\AppData\\Local\\wise-old-model');
  });

  it('ignores a relative XDG_DATA_HOME, as the XDG spec says', () => {
    expect(onLinux({ XDG_DATA_HOME: 'x' }).dataDir).toBe('/home/u/.local/share/wise-old-model');
  });

  it('translates a WSL path from the same .env when running on Windows', () => {
    const config = loadConfig(
      { ...contact, RUNELITE_DIR: '/mnt/c/Users/Davis/.runelite', DATA_DIR: '/mnt/d/wom' },
      'win32',
      'C:\\Users\\Davis',
    );
    expect(config.runeliteDir).toBe('C:\\Users\\Davis\\.runelite');
    expect(config.dataDir).toBe('D:\\wom');
  });

  it('rejects a Linux-only path on Windows', () => {
    expect(() => onWindows({ DATA_DIR: '/home/u/wom' })).toThrow(/DATA_DIR is a Linux path/);
  });

  it('rejects a Windows path on Linux and WSL, suggesting the /mnt form', () => {
    expect(() => onLinux({ RUNELITE_DIR: 'C:\\Users\\u\\.runelite' })).toThrow(
      /RUNELITE_DIR is a Windows path.*\/mnt\/c/,
    );
  });

  it('expands a leading ~ to the home folder', () => {
    expect(onLinux({ RUNELITE_DIR: '~/.runelite' }).runeliteDir).toBe('/home/u/.runelite');
    expect(onWindows({ DATA_DIR: '~\\wom' }).dataDir).toBe('C:\\Users\\u\\wom');
  });

  it('rejects a relative path', () => {
    expect(() => onLinux({ DATA_DIR: 'data' })).toThrow(/DATA_DIR must be a full path/);
  });

  it('rejects a path with a line break in it', () => {
    expect(() => onWindows({ DATA_DIR: 'C:\\Users\\nina\nwom' })).toThrow(/DATA_DIR/);
  });

  it('rejects a CONTACT that cannot go in a request header', () => {
    expect(() => loadConfig({ CONTACT: 'pete 🐉' }, 'linux', '/home/u')).toThrow(/CONTACT/);
    expect(() => loadConfig({ CONTACT: 'ピート' }, 'linux', '/home/u')).toThrow(/CONTACT/);
  });

  it('honours overrides', () => {
    const config = onLinux({
      PORT: '5000',
      DATA_DIR: '/d',
      RUNELITE_DIR: '/mnt/c/Users/u/.runelite',
    });
    expect(config.port).toBe(5000);
    expect(config.dataDir).toBe('/d');
    expect(config.runeliteDir).toBe('/mnt/c/Users/u/.runelite');
  });

  it('treats empty values like unset ones, as .env.example leaves them', () => {
    const config = onLinux({ PORT: '', DATA_DIR: '', RUNELITE_DIR: '', ANTHROPIC_API_KEY: '' });
    expect(config.port).toBe(4747);
    expect(config.dataDir).toBe('/home/u/.local/share/wise-old-model');
    expect(config.runeliteDir).toBe('/home/u/.runelite');
    expect(config.anthropicApiKey).toBeNull();
  });

  it('rejects a bad PORT', () => {
    expect(() => onLinux({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => onLinux({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => onLinux({ PORT: '0' })).toThrow(/PORT/);
  });

  it('keeps the API key and the development flag', () => {
    const config = onLinux({ ANTHROPIC_API_KEY: 'sk-test', NODE_ENV: 'development' });
    expect(config.anthropicApiKey).toBe('sk-test');
    expect(config.isDev).toBe(true);
    expect(onLinux().isDev).toBe(false);
  });

  it('reads the version from the root package.json', () => {
    const rootPackage = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(onLinux().version).toBe(rootPackage.version);
  });
});

describe('userAgent', () => {
  it('builds the User-Agent', () => {
    expect(userAgent({ version: '0.1.0', contact: 'me#1234' })).toBe(
      'wise-old-model/0.1.0 (personal use; contact: me#1234)',
    );
  });
});

describe('readVersion', () => {
  it("refuses a package.json that isn't the app's own", () => {
    const file = path.join(tempDir('wom-pkg-'), 'package.json');
    writeFileSync(file, JSON.stringify({ name: '@wom/server', version: '0.1.0' }));
    expect(() => readVersion(pathToFileURL(file))).toThrow(/wise-old-model/);
  });

  it("reads the version from the app's own package.json", () => {
    const file = path.join(tempDir('wom-pkg-'), 'package.json');
    writeFileSync(file, JSON.stringify({ name: 'wise-old-model', version: '9.8.7' }));
    expect(readVersion(pathToFileURL(file))).toBe('9.8.7');
  });
});
