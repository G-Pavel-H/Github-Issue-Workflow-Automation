import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from '../src/server.js';

describe('GET /health', () => {
  const server = createServer();
  const port = 0; // random available port
  let baseUrl: string;
  let httpServer: ReturnType<typeof server.listen>;

  // Start server on a random port
  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('returns 200 with status ok', async () => {
    httpServer = server.listen(port);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('unexpected address');
    baseUrl = `http://localhost:${address.port}`;

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
