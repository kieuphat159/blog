const redisInstances: any[] = [];
const RedisMock = jest.fn().mockImplementation((...args: unknown[]) => {
  const instance = {
    args,
    status: 'ready',
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    disconnect: jest.fn(),
  };
  redisInstances.push(instance);
  return instance;
});

jest.mock('ioredis', () => ({ __esModule: true, default: RedisMock }));

import { RedisService } from './redis.service';

describe('RedisService', () => {
  let config: { get: jest.Mock };
  let service: RedisService;

  const client = () => redisInstances[redisInstances.length - 1];

  beforeEach(() => {
    redisInstances.length = 0;
    RedisMock.mockClear();
    config = { get: jest.fn() };
    service = new RedisService(config as any);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('connects with REDIS_URL when one is configured', () => {
      config.get.mockImplementation((key: string) =>
        key === 'REDIS_URL' ? 'redis://cache:6379' : undefined,
      );

      service.onModuleInit();

      expect(client().args[0]).toBe('redis://cache:6379');
    });

    it('falls back to host and port', () => {
      config.get.mockImplementation((key: string, fallback?: unknown) => {
        if (key === 'REDIS_URL') return undefined;
        if (key === 'REDIS_HOST') return 'localhost';
        if (key === 'REDIS_PORT') return 6379;
        return fallback;
      });

      service.onModuleInit();

      expect(client().args[0]).toMatchObject({ host: 'localhost', port: 6379 });
    });

    it('gives up reconnecting after three attempts', () => {
      service.onModuleInit();
      const { retryStrategy } = client().args[0].retryStrategy
        ? client().args[0]
        : client().args[1];

      expect(retryStrategy(1)).toBe(100);
      expect(retryStrategy(3)).toBe(300);
      expect(retryStrategy(4)).toBeNull();
    });

    // A Redis outage must not take the whole API process down at boot.
    it('logs connection errors instead of letting them escape', () => {
      service.onModuleInit();
      const [event, handler] = client().on.mock.calls[0];

      expect(event).toBe('error');
      expect(() => handler(new Error('ECONNREFUSED'))).not.toThrow();
    });
  });

  describe('get / set', () => {
    beforeEach(() => {
      config.get.mockReturnValue(undefined);
      service.onModuleInit();
    });

    it('round-trips a value through Redis', async () => {
      await service.set('k', 'v');
      client().get.mockResolvedValue('v');

      await expect(service.get('k')).resolves.toBe('v');
      expect(client().set).toHaveBeenCalledWith('k', 'v');
    });

    it('passes a TTL through as an EX expiry', async () => {
      await service.set('k', 'v', 30);

      expect(client().set).toHaveBeenCalledWith('k', 'v', 'EX', 30);
    });

    it('returns null for a key nobody has written', async () => {
      await expect(service.get('missing')).resolves.toBeNull();
    });

    // The in-process fallback is what keeps the app usable during an outage.
    it('serves the last written value from memory while Redis is down', async () => {
      await service.set('k', 'v');
      client().status = 'end';

      await expect(service.get('k')).resolves.toBe('v');
      expect(client().get).not.toHaveBeenCalled();
    });

    it('still records the value locally when the Redis write throws', async () => {
      client().set.mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.set('k', 'v')).resolves.toBeUndefined();
      client().status = 'end';
      await expect(service.get('k')).resolves.toBe('v');
    });

    it('falls back to memory when the Redis read throws', async () => {
      await service.set('k', 'v');
      client().get.mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.get('k')).resolves.toBe('v');
    });

    it('expires the local copy once the TTL elapses', async () => {
      jest.useFakeTimers();
      await service.set('k', 'v', 1);
      client().status = 'end';

      jest.advanceTimersByTime(1001);

      await expect(service.get('k')).resolves.toBeNull();
    });

    /**
     * Known limitation: `set` always writes to the local map, but `get` consults it
     * whenever Redis has no value. On a healthy multi-instance deployment an entry another
     * instance deleted still resolves locally until its TTL lapses.
     */
    it('serves a stale local copy when Redis reports the key as absent', async () => {
      await service.set('k', 'v', 60);
      client().get.mockResolvedValue(null);

      await expect(service.get('k')).resolves.toBe('v');
    });
  });

  describe('del', () => {
    beforeEach(() => {
      config.get.mockReturnValue(undefined);
      service.onModuleInit();
    });

    it('removes the key from Redis and from the local copy', async () => {
      await service.set('k', 'v');

      await service.del('k');

      expect(client().del).toHaveBeenCalledWith('k');
      client().status = 'end';
      await expect(service.get('k')).resolves.toBeNull();
    });

    it('still drops the local copy when the Redis delete throws', async () => {
      await service.set('k', 'v');
      client().del.mockRejectedValue(new Error('ECONNRESET'));

      await service.del('k');

      client().status = 'end';
      await expect(service.get('k')).resolves.toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('exposes the raw client for the socket.io adapter', () => {
      config.get.mockReturnValue(undefined);
      service.onModuleInit();

      expect(service.getClient()).toBe(client());
    });

    it('disconnects on shutdown', () => {
      config.get.mockReturnValue(undefined);
      service.onModuleInit();

      service.onModuleDestroy();

      expect(client().disconnect).toHaveBeenCalled();
    });
  });
});
