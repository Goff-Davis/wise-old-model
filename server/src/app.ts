import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VITE_DEV_PORT } from '@wom/shared';
import express, { type Express, type RequestHandler, Router } from 'express';
import type { Kysely } from 'kysely';
import { createChatService } from './ai/chatService.ts';
import type { ChatProvider, ToolDef } from './ai/provider.ts';
import { providerInfos } from './ai/providerInfo.ts';
import { buildTools } from './ai/tools/index.ts';
import { type Config, userAgent } from './config.ts';
import type { DB } from './db/schema.ts';
import { HttpError, jsonErrors } from './http/errors.ts';
import { localOnly } from './http/localOnly.ts';
import { createRequester, type Requester } from './http/requester.ts';
import { accountRoutes } from './routes/accounts.ts';
import { chatRoutes } from './routes/chats.ts';
import { goalRoutes } from './routes/goals.ts';
import { iconRoutes } from './routes/icons.ts';
import { settingsRoutes } from './routes/settings.ts';
import { createFreshnessMemory } from './services/freshness.ts';
import { createIconStore } from './sources/icons.ts';

export type AppDeps = {
  config: Config;
  db: Kysely<DB>;
  /** Where the built client lives; defaults to client/dist. Tests point it elsewhere. */
  clientDist?: string;
  /** How the server talks to other sites; tests pass a fake. */
  req?: Requester;
  /**
   * The AIs .env sets up (none in tests that don't chat: a turn then says so), and the tools
   * they may use (by default, all of them).
   */
  providers?: ChatProvider[];
  tools?: ToolDef[];
};

const DEFAULT_CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

/** Other sites may not frame the app (clickjacking) or read its files cross-origin. */
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
};

/**
 * Serves the built client; app pages (paths without a file extension) get index.html. Only
 * GET and HEAD reach the fallbacks (Express's `.get` matches both).
 */
function clientFiles(dist: string): Router {
  const router = Router();
  if (!existsSync(dist)) {
    console.warn(`The client isn't built yet (${dist} is missing). Run "npm run build" first.`);
    router.get('/{*path}', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send("Wise Old Model's page hasn't been built yet. Run npm run build, then npm start.");
    });
    return router;
  }
  router.use(express.static(dist));
  router.get('/{*path}', (req, res, next) => {
    if (path.extname(req.path) !== '') {
      next();
      return;
    }
    res.sendFile(path.join(dist, 'index.html'));
  });
  return router;
}

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(localOnly(config.isDev ? [config.port, VITE_DEV_PORT] : [config.port]));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: config.version });
  });

  // One requester for the whole app, so each site's queue and spacing cover every request.
  const req = deps.req ?? createRequester({ userAgent: userAgent(config) });
  const providers = deps.providers ?? [];
  const infos = providerInfos(providers);
  app.use('/api', settingsRoutes(deps.db, config, infos));
  const accountDeps = {
    db: deps.db,
    req,
    memory: createFreshnessMemory(),
    runeliteDir: config.runeliteDir,
  };
  const chats = createChatService({
    ...accountDeps,
    providers,
    tools: deps.tools ?? buildTools(accountDeps),
  });
  app.use('/api', accountRoutes(accountDeps, { beforeDelete: (row) => chats.stopAccount(row.id) }));
  app.use('/api', goalRoutes(accountDeps));
  app.use('/api', chatRoutes(deps.db, chats, infos));
  app.use('/api', iconRoutes(createIconStore(req, config.dataDir)));

  app.use('/api', (_req, _res, next) => {
    next(new HttpError(404, 'Not found'));
  });

  if (!config.isDev) app.use(clientFiles(deps.clientDist ?? DEFAULT_CLIENT_DIST));
  app.use(jsonErrors);

  return app;
}
