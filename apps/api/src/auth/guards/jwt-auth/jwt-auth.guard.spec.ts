import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;

  beforeEach(() => {
    guard = new JwtAuthGuard();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const contextOf = (type: string, request: unknown): ExecutionContext =>
    ({
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => request }),
      getArgs: () => [],
      getArgByIndex: () => undefined,
    }) as any;

  describe('getRequest', () => {
    it('reads the request straight off an HTTP context', () => {
      const request = { headers: { authorization: 'Bearer token' } };

      expect(guard.getRequest(contextOf('http', request))).toBe(request);
    });

    // GraphQL resolvers hand Passport a different shape; without this branch the guard
    // would look for an Authorization header on an object that has none.
    it('digs the request out of the GraphQL context', () => {
      const request = { headers: { authorization: 'Bearer token' } };
      jest
        .spyOn(GqlExecutionContext, 'create')
        .mockReturnValue({ getContext: () => ({ req: request }) } as any);

      expect(guard.getRequest(contextOf('graphql', {}))).toBe(request);
    });
  });

  describe('canActivate', () => {
    it('returns whatever Passport decides', async () => {
      jest
        .spyOn(AuthGuard('jwt').prototype, 'canActivate')
        .mockResolvedValue(true);

      await expect(guard.canActivate(contextOf('http', {}))).resolves.toBe(
        true,
      );
    });

    it('lets a Passport rejection propagate instead of swallowing it', async () => {
      jest
        .spyOn(AuthGuard('jwt').prototype, 'canActivate')
        .mockRejectedValue(new Error('Unauthorized'));

      await expect(guard.canActivate(contextOf('http', {}))).rejects.toThrow(
        'Unauthorized',
      );
    });

    it('logs the elapsed time whether or not the check succeeded', async () => {
      const log = jest.spyOn(console, 'log');
      jest
        .spyOn(AuthGuard('jwt').prototype, 'canActivate')
        .mockRejectedValue(new Error('Unauthorized'));

      await expect(guard.canActivate(contextOf('http', {}))).rejects.toThrow();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('JwtAuthGuard'));
    });
  });
});
