import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;
  let connect: jest.SpyInstance;
  let disconnect: jest.SpyInstance;

  beforeEach(() => {
    service = new PrismaService();
    connect = jest
      .spyOn(service, '$connect')
      .mockResolvedValue(undefined as never);
    disconnect = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('connects when the module boots', async () => {
    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects when the module shuts down', async () => {
    await service.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  describe('query timing middleware', () => {
    it('registers a middleware when the client supports $use', async () => {
      const use = jest.fn();
      (service as any).$use = use;

      await service.onModuleInit();

      expect(use).toHaveBeenCalledTimes(1);
      expect(typeof use.mock.calls[0][0]).toBe('function');
    });

    // Prisma dropped $use in newer client versions; booting must not blow up without it.
    it('boots without a middleware when $use is unavailable', async () => {
      (service as any).$use = undefined;

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('passes the query result through untouched', async () => {
      const use = jest.fn();
      (service as any).$use = use;
      await service.onModuleInit();
      const middleware = use.mock.calls[0][0];

      const result = await middleware(
        { model: 'Post', action: 'findMany' },
        async () => ['a', 'b'],
      );

      expect(result).toEqual(['a', 'b']);
    });

    it('lets a query error propagate rather than reporting a timing for it', async () => {
      const use = jest.fn();
      (service as any).$use = use;
      await service.onModuleInit();
      const middleware = use.mock.calls[0][0];

      await expect(
        middleware({ model: 'Post', action: 'findMany' }, async () => {
          throw new Error('connection lost');
        }),
      ).rejects.toThrow('connection lost');
    });
  });
});
