import { UnauthorizedException } from '@nestjs/common';
import { hash } from 'argon2';
import { AuthService } from './auth.service';
import { FakeRedis } from '../common/testing/fake-redis';

describe('AuthService', () => {
  let prisma: any;
  let jwtService: any;
  let redis: FakeRedis;
  let service: AuthService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    jwtService = {
      signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
    };
    redis = new FakeRedis();
    service = new AuthService(prisma, jwtService, redis as any);
  });

  describe('validateLocalUser', () => {
    const credentials = { email: 'ada@example.com', password: 'correct-horse' };

    it('returns the user when the password matches', async () => {
      const passwordHash = await hash(credentials.password);
      prisma.user.findUnique.mockResolvedValue({
        id: 7,
        email: credentials.email,
        password: passwordHash,
      });

      await expect(
        service.validateLocalUser(credentials),
      ).resolves.toMatchObject({
        id: 7,
      });
    });

    it('rejects a wrong password', async () => {
      const passwordHash = await hash('something-else');
      prisma.user.findUnique.mockResolvedValue({
        id: 7,
        email: credentials.email,
        password: passwordHash,
      });

      await expect(service.validateLocalUser(credentials)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an unknown email without touching argon2', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.validateLocalUser(credentials)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // Regression: google.strategy.ts stores OAuth accounts with password: ''. Feeding that
    // to argon2.verify() throws, which used to surface as a 500 instead of a failed login.
    it('rejects a password login for an account created through OAuth', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 8,
        email: credentials.email,
        password: '',
      });

      await expect(service.validateLocalUser(credentials)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects rather than crashing when the stored hash is malformed', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 9,
        email: credentials.email,
        password: 'not-an-argon2-hash',
      });

      await expect(service.validateLocalUser(credentials)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('validateJwtUser', () => {
    it('reads through to the database on a cache miss and caches the result', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 42, name: 'Ada' });

      await expect(service.validateJwtUser(42)).resolves.toEqual({ id: 42 });
      expect(redis.store.get('jwt:user:42')?.value).toBe('{"id":42}');
      expect(redis.ttlOf('jwt:user:42')).toBeGreaterThanOrEqual(1);
    });

    it('serves a cache hit without querying the database', async () => {
      redis.seed('jwt:user:42', { id: 42 });

      await expect(service.validateJwtUser(42)).resolves.toEqual({ id: 42 });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the user no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.validateJwtUser(404)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(redis.keys()).toHaveLength(0);
    });
  });

  describe('validateGoogleUser', () => {
    const googleUser = {
      email: 'ada@example.com',
      name: 'Ada',
      password: '',
      avatar: 'https://example.com/a.png',
    } as any;

    it('returns the existing account without its password hash', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        email: googleUser.email,
        password: 'hashed',
        name: 'Ada',
      });

      const result = await service.validateGoogleUser(googleUser);

      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({ id: 1, email: googleUser.email });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates the account on first sign-in and still hides the password', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 2,
        ...googleUser,
      });

      const result = await service.validateGoogleUser(googleUser);

      expect(prisma.user.create).toHaveBeenCalledWith({ data: googleUser });
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('OAuth hand-off codes', () => {
    it('round-trips the payload and expires the code after one use', async () => {
      const payload = { id: 3, accessToken: 'abc' };
      const code = await service.generateTempOAuthCode(payload);

      await expect(service.exchangeOAuthCode(code)).resolves.toEqual(payload);
      await expect(service.exchangeOAuthCode(code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('stores the code with a short TTL', async () => {
      const code = await service.generateTempOAuthCode({ id: 3 });

      expect(redis.ttlOf(`oauth:code:${code}`)).toBe(30);
    });

    it('issues a distinct code per call', async () => {
      const codes = await Promise.all(
        Array.from({ length: 50 }, () =>
          service.generateTempOAuthCode({ id: 3 }),
        ),
      );

      expect(new Set(codes).size).toBe(codes.length);
    });

    it('rejects an unknown code', async () => {
      await expect(service.exchangeOAuthCode('nope')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('login', () => {
    it('returns a signed token alongside the public profile fields', async () => {
      const user = {
        id: 5,
        name: 'Ada',
        avatar: 'a.png',
        email: 'ada@example.com',
        password: 'hashed',
      } as any;

      const result = await service.login(user);

      expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: 5 });
      expect(result).toEqual({
        id: 5,
        name: 'Ada',
        avatar: 'a.png',
        accessToken: 'signed.jwt.token',
      });
      expect(result).not.toHaveProperty('password');
    });
  });
});
