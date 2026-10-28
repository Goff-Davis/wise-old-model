import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT } from '@wom/shared';

export type Config = {
  contact: string;
  port: number;
  dataDir: string;
  runeliteDir: string;
  anthropicApiKey: string | null;
  isDev: boolean;
  version: string;
};

export class ConfigError extends Error {
  name = 'ConfigError';
}

/** The app's name: its package, its data folder and its User-Agent. */
const APP_NAME = 'wise-old-model';

/** An environment value with surrounding spaces removed; empty counts as unset. */
function value(env: Record<string, string | undefined>, key: string): string | null {
  const raw = env[key]?.trim();
  return raw ? raw : null;
}

function pathsFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function defaultDataDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string {
  const paths = pathsFor(platform);
  if (platform === 'win32') {
    return paths.join(value(env, 'LOCALAPPDATA') ?? paths.join(home, 'AppData', 'Local'), APP_NAME);
  }
  if (platform === 'darwin') {
    return paths.join(home, 'Library', 'Application Support', APP_NAME);
  }
  // The XDG spec says to ignore a relative XDG_DATA_HOME.
  const xdg = value(env, 'XDG_DATA_HOME');
  const base = xdg !== null && paths.isAbsolute(xdg) ? xdg : paths.join(home, '.local', 'share');
  return paths.join(base, APP_NAME);
}

/**
 * A folder setting, made safe to use on this OS: `~` expands to the home folder, and on Windows
 * a WSL path like /mnt/c/Users/me (from a .env shared with WSL) becomes C:\Users\me. Anything
 * that would quietly point somewhere unexpected stops the server with an explanation instead.
 */
function folderValue(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform,
  home: string,
): string | null {
  const raw = value(env, key);
  if (raw === null) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(raw)) {
    throw new ConfigError(
      `${key} contains a line break or other control character. In .env, write it without quotes, or use / instead of \\.`,
    );
  }
  const paths = pathsFor(platform);
  let folder = /^~(?:[/\\]|$)/.test(raw) ? paths.join(home, raw.slice(1)) : raw;

  if (platform === 'win32') {
    const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(folder);
    if (wsl) {
      folder = `${(wsl[1] as string).toUpperCase()}:\\${(wsl[2] ?? '').replaceAll('/', '\\')}`;
    } else if (folder.startsWith('/')) {
      throw new ConfigError(
        `${key} is a Linux path ("${raw}"), but this is Windows. Use a Windows path like C:\\Users\\you\\..., or leave it empty for the default.`,
      );
    }
  } else if (/^[a-zA-Z]:[/\\]/.test(folder)) {
    const drive = folder[0]?.toLowerCase();
    throw new ConfigError(
      `${key} is a Windows path ("${raw}"). On WSL, use the /mnt/${drive}/ form instead, e.g. /mnt/${drive}/Users/you/.runelite.`,
    );
  }

  if (!paths.isAbsolute(folder)) {
    throw new ConfigError(
      `${key} must be a full path (like ${platform === 'win32' ? 'C:\\Users\\you\\wise-old-model' : '/home/you/wise-old-model'}), but it is "${raw}".`,
    );
  }
  return paths.normalize(folder);
}

function parsePort(raw: string | null): number {
  if (raw === null) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a whole number from 1 to 65535, but it is "${raw}".`);
  }
  return port;
}

const ROOT_PACKAGE = new URL('../../package.json', import.meta.url);

/** The app's version, from the root package.json; refuses any other package.json. */
export function readVersion(file: URL = ROOT_PACKAGE): string {
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
  if (pkg.name !== APP_NAME || typeof pkg.version !== 'string') {
    throw new Error(
      `Expected the wise-old-model package.json at ${file.href}, found "${pkg.name}".`,
    );
  }
  return pkg.version;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): Config {
  const contact = value(env, 'CONTACT');
  if (contact === null) {
    throw new ConfigError(
      'CONTACT is missing. Set it in .env to your Discord name or email: it goes in the User-Agent so Wise Old Man, Temple and the wiki can reach you.',
    );
  }
  // It goes in an HTTP header, which only carries plain ASCII safely.
  if (!/^[\x20-\x7e]+$/.test(contact)) {
    throw new ConfigError(
      `CONTACT can only use plain letters, numbers and symbols (it goes in a web request header), but it is "${contact}". An email address works well.`,
    );
  }
  return {
    contact,
    port: parsePort(value(env, 'PORT')),
    dataDir: folderValue(env, 'DATA_DIR', platform, home) ?? defaultDataDir(env, platform, home),
    runeliteDir:
      folderValue(env, 'RUNELITE_DIR', platform, home) ??
      pathsFor(platform).join(home, '.runelite'),
    anthropicApiKey: value(env, 'ANTHROPIC_API_KEY'),
    isDev: env.NODE_ENV === 'development',
    version: readVersion(),
  };
}

export function userAgent(config: Pick<Config, 'version' | 'contact'>): string {
  return `${APP_NAME}/${config.version} (personal use; contact: ${config.contact})`;
}
