import type http from 'node:http';
import { errorMessage } from '@wom/shared';
import type { Kysely } from 'kysely';
import type { ChatProvider } from './ai/provider.ts';
import { createApp } from './app.ts';
import type { Config } from './config.ts';
import { openAppDatabase } from './db/open.ts';
import type { DB } from './db/schema.ts';
import { listenLocal } from './http/listen.ts';

/** A problem that stops the server from starting, worded for the person running it. */
export class StartError extends Error {
  name = 'StartError';
}

/** Answers while the database opens; the app takes over as soon as it's ready. */
const startingUp: http.RequestListener = (_req, res) => {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' });
  res.end('Wise Old Model is starting. Try again in a moment.');
};

/**
 * Claims the port first, so a second copy stops there before it can touch (and migrate) the
 * database under the copy that's already running; then opens the database and hands the port
 * to the app, its chat answered by `deps.providers`.
 */
export async function startServer(
  config: Config,
  deps: { providers?: ChatProvider[] } = {},
): Promise<{ server: http.Server; db: Kysely<DB> }> {
  let server: http.Server;
  try {
    server = await listenLocal(startingUp, config.port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new StartError(
      code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Close the program using it, or set PORT in .env.`
        : `Couldn't start on 127.0.0.1:${config.port}: ${errorMessage(error)}`,
    );
  }

  let db: Kysely<DB>;
  try {
    db = await openAppDatabase(config.dataDir, () => new Date());
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw new StartError(`Couldn't open the database in ${config.dataDir}: ${errorMessage(error)}`);
  }

  server.off('request', startingUp);
  server.on('request', createApp({ config, db, providers: deps.providers }));
  return { server, db };
}
