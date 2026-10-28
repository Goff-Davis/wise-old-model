import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { listenLocal } from './listen.ts';

describe('listenLocal', () => {
  it('resolves once the server is listening on 127.0.0.1', async () => {
    const server = await listenLocal(express(), 0);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
    server.close();
  });

  it('rejects with EADDRINUSE when the port is taken, and never reports listening', async () => {
    const blocker = net.createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const { port } = blocker.address() as AddressInfo;

    await expect(listenLocal(express(), port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    blocker.close();
  });
});
