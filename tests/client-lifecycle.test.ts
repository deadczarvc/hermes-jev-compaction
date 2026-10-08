import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildJevRequest, JevClient } from '../src/index.js';

const RESPONSE = { answers: {} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('JevClient native connection lifetime', () => {
  it('default native fetch sends connection close and closes its socket without server destruction', async () => {
    const peerClosed = deferred<void>();
    const clientClosed = deferred<void>();
    let connection: string | undefined;
    let peerSocket: Socket | undefined;
    let clientSocket: Socket | undefined;
    const server = createServer((request, response) => {
      connection = request.headers.connection;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(RESPONSE));
    });
    server.on('connection', (socket) => {
      peerSocket = socket;
      socket.once('close', () => peerClosed.resolve());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const connected = channel('undici:client:connected');
    const observe = (message: unknown) => {
      const { socket } = message as { socket: Socket };
      if (socket.remotePort !== port) return;
      clientSocket = socket;
      socket.once('close', () => clientClosed.resolve());
    };
    connected.subscribe(observe);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = new JevClient({ apiKey: 'test-key', provider: 'custom', baseUrl: `http://127.0.0.1:${port}/systemone` });
      await expect(client.ask('state', {})).resolves.toEqual(RESPONSE);
      expect(connection).toBe('close');
      expect(clientSocket).toBeDefined();
      await Promise.race([
        Promise.all([peerClosed.promise, clientClosed.promise]),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('native fetch socket remained open')), 1000);
        }),
      ]);
      expect(clientSocket?.destroyed).toBe(true);
      expect(peerSocket?.destroyed).toBe(true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      connected.unsubscribe(observe);
      // Cleanup runs only after the natural-close assertions, including on a failed regression.
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('injected fetch keeps the original request headers without connection close', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(RESPONSE), { status: 200 }));
    const client = new JevClient({ apiKey: 'test-key', fetch: fetcher });
    await expect(client.ask('state', {})).resolves.toEqual(RESPONSE);
    expect(fetcher).toHaveBeenCalledOnce();
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.headers).toEqual(buildJevRequest({ apiKey: 'test-key' }, 'state', {}).headers);
    expect(new Headers(init?.headers).has('connection')).toBe(false);
  });
});
