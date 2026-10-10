import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { gracefulShutdown } from '@thali/service-kit';
import { testLogger } from '@thali/service-kit/testing';

describe('gracefulShutdown', () => {
  it('closes the server, runs closers in order once, then exits 0', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const order: string[] = [];
    const exit = vi.fn();
    const { shutdown } = gracefulShutdown({
      server,
      logger: testLogger(),
      closers: [async () => void order.push('relay'), async () => void order.push('mongo')],
      exit,
      signals: [],
    });
    await Promise.all([shutdown('test'), shutdown('again')]);
    expect(order).toEqual(['relay', 'mongo']);
    expect(server.listening).toBe(false);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when a closer fails (after running the rest)', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const exit = vi.fn();
    const ran: string[] = [];
    const { shutdown } = gracefulShutdown({
      server,
      logger: testLogger(),
      closers: [
        async () => {
          throw new Error('boom');
        },
        async () => void ran.push('second'),
      ],
      exit,
      signals: [],
    });
    await shutdown('test');
    expect(ran).toEqual(['second']);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
