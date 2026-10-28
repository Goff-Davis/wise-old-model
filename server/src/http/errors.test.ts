import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { call } from '../../test/helpers.ts';
import { HttpError, jsonErrors } from './errors.ts';

function appThatFails(error: Error) {
  const app = express();
  app.get('/fail', (_req, _res, next) => next(error));
  app.use(jsonErrors);
  return app;
}

describe('jsonErrors', () => {
  it('passes on an error meant for the client, such as an HttpError from a route', async () => {
    const res = await call(appThatFails(new HttpError(409, 'That name is taken.')), {
      path: '/fail',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'That name is taken.' });
  });

  it("keeps any other error's status and details in the server's console, a 4xx included", async () => {
    // How Express reports a missing file to send: status 404, but not meant for the client.
    const missing = Object.assign(
      new Error("ENOENT: no such file or directory, stat '/home/me/app/client/dist/index.html'"),
      { status: 404, expose: false },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(appThatFails(missing), { path: '/fail' });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('/home/me');
    expect(res.body).toEqual({
      error: "Something went wrong on Wise Old Model's server. Its console has the details.",
    });
    expect(log).toHaveBeenCalledWith(missing);
  });
});
