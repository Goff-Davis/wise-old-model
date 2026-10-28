import { describe, expect, it } from 'vitest';
import { checkLocalRequest } from './localOnly.ts';

const ports = [4747];

describe('checkLocalRequest', () => {
  it('accepts reads addressed to localhost or 127.0.0.1 on our port', () => {
    expect(checkLocalRequest({ method: 'GET', host: 'localhost:4747' }, ports)).toBe('ok');
    expect(checkLocalRequest({ method: 'GET', host: '127.0.0.1:4747' }, ports)).toBe('ok');
    expect(checkLocalRequest({ method: 'GET', host: 'LOCALHOST:4747' }, ports)).toBe('ok');
  });

  it('rejects any other host, port or a missing host', () => {
    expect(checkLocalRequest({ method: 'GET', host: 'evil.example:4747' }, ports)).toBe('bad-host');
    expect(checkLocalRequest({ method: 'GET', host: 'localhost:9999' }, ports)).toBe('bad-host');
    expect(checkLocalRequest({ method: 'GET', host: 'localhost' }, ports)).toBe('bad-host');
    expect(checkLocalRequest({ method: 'GET' }, ports)).toBe('bad-host');
  });

  it('accepts writes only from our own page', () => {
    const host = 'localhost:4747';
    expect(
      checkLocalRequest({ method: 'POST', host, origin: 'http://localhost:4747' }, ports),
    ).toBe('ok');
    expect(checkLocalRequest({ method: 'POST', host, origin: 'http://evil.example' }, ports)).toBe(
      'bad-origin',
    );
    expect(checkLocalRequest({ method: 'POST', host }, ports)).toBe('bad-origin');
    expect(checkLocalRequest({ method: 'DELETE', host, origin: 'null' }, ports)).toBe('bad-origin');
  });

  it('checks the host before the origin', () => {
    expect(
      checkLocalRequest(
        { method: 'POST', host: 'evil.example', origin: 'http://localhost:4747' },
        ports,
      ),
    ).toBe('bad-host');
  });

  it('on port 80, accepts the bare names browsers send without a port', () => {
    expect(checkLocalRequest({ method: 'GET', host: 'localhost' }, [80])).toBe('ok');
    expect(
      checkLocalRequest({ method: 'POST', host: '127.0.0.1', origin: 'http://127.0.0.1' }, [80]),
    ).toBe('ok');
    expect(checkLocalRequest({ method: 'GET', host: 'localhost' }, [4747])).toBe('bad-host');
  });

  it('turns away requests the browser marks as from another site, unless they open a page', () => {
    const host = 'localhost:4747';
    const marked = (method: string, fetchSite: string, fetchMode: string, fetchDest: string) =>
      checkLocalRequest({ method, host, fetchSite, fetchMode, fetchDest }, ports);

    // An <img> or fetch() on another site, or on another localhost port (same-site).
    expect(marked('GET', 'cross-site', 'no-cors', 'image')).toBe('cross-site');
    expect(marked('GET', 'same-site', 'cors', 'empty')).toBe('cross-site');
    expect(marked('GET', 'cross-site', 'navigate', 'iframe')).toBe('cross-site');
    expect(marked('POST', 'cross-site', 'navigate', 'document')).toBe('cross-site');

    // A link, bookmark or typed address that opens the app, and our own page.
    expect(marked('GET', 'cross-site', 'navigate', 'document')).toBe('ok');
    expect(marked('GET', 'none', 'navigate', 'document')).toBe('ok');
    expect(marked('GET', 'same-origin', 'cors', 'empty')).toBe('ok');
    expect(checkLocalRequest({ method: 'GET', host }, ports)).toBe('ok');
  });

  it('allows the Vite dev server port when it is in the list', () => {
    expect(
      checkLocalRequest(
        { method: 'POST', host: 'localhost:5173', origin: 'http://localhost:5173' },
        [4747, 5173],
      ),
    ).toBe('ok');
  });
});
