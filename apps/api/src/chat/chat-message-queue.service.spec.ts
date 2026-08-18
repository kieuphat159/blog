import { ServiceUnavailableException } from '@nestjs/common';
import { ChatMessageQueueService } from './chat-message-queue.service';

/** A task whose completion the test controls. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ChatMessageQueueService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const buildService = (concurrency: number, maxPending?: number) => {
    process.env.CHAT_QUEUE_CONCURRENCY = String(concurrency);
    if (maxPending !== undefined) {
      process.env.CHAT_QUEUE_MAX_PENDING = String(maxPending);
    }
    return new ChatMessageQueueService();
  };

  it('resolves with the task result', async () => {
    const service = buildService(2);

    await expect(service.enqueue(async () => 'sent')).resolves.toBe('sent');
  });

  it('propagates a task failure to its own caller only', async () => {
    const service = buildService(2);

    const failing = service.enqueue(async () => {
      throw new Error('db down');
    });
    const succeeding = service.enqueue(async () => 'ok');

    await expect(failing).rejects.toThrow('db down');
    await expect(succeeding).resolves.toBe('ok');
  });

  it('runs no more than `concurrency` tasks at a time', async () => {
    const service = buildService(2);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const results = gates.map((gate) =>
      service.enqueue(async () => {
        started += 1;
        await gate.promise;
        return started;
      }),
    );

    await Promise.resolve();
    expect(started).toBe(2);

    gates[0].resolve();
    await results[0];
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(3);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(results);
  });

  it('keeps draining after a task rejects', async () => {
    const service = buildService(1);
    const order: string[] = [];

    const first = service.enqueue(async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = service.enqueue(async () => {
      order.push('second');
      return 'done';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('done');
    expect(order).toEqual(['first', 'second']);
  });

  it('preserves FIFO order for queued tasks', async () => {
    const service = buildService(1);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        service.enqueue(async () => {
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('sheds load once the pending queue is full', async () => {
    const service = buildService(1, 2);
    const gate = deferred();
    const inFlight: Promise<unknown>[] = [];

    // 1 running + 2 pending is the ceiling; the fourth must be rejected outright.
    for (let i = 0; i < 3; i++) {
      inFlight.push(service.enqueue(() => gate.promise));
    }
    await Promise.resolve();

    expect(() => service.enqueue(async () => 'overflow')).toThrow(
      ServiceUnavailableException,
    );

    gate.resolve();
    await Promise.all(inFlight);
  });

  it('accepts work again after the backlog drains', async () => {
    const service = buildService(1, 2);
    const gate = deferred();
    const inFlight = [1, 2, 3].map(() => service.enqueue(() => gate.promise));

    gate.resolve();
    await Promise.all(inFlight);

    await expect(service.enqueue(async () => 'later')).resolves.toBe('later');
  });

  it('never drops below a concurrency of one, whatever the env says', async () => {
    const service = buildService(0);

    await expect(service.enqueue(async () => 'still runs')).resolves.toBe(
      'still runs',
    );
  });
});
