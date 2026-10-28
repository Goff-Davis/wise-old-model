import { once } from 'node:events';
import http from 'node:http';

/**
 * Listens on 127.0.0.1 only. Resolves once it's listening and rejects on a listen error (such
 * as EADDRINUSE). Express 5's own `app.listen` callback also fires on errors, which would
 * announce a server that never started.
 */
export async function listenLocal(
  handler: http.RequestListener,
  port: number,
): Promise<http.Server> {
  const server = http.createServer(handler).listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
