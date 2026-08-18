import { ConflictException } from '@nestjs/common';
import { Prisma } from '.prisma/client/default';
import { verify } from 'argon2';
import { UserService } from './user.service';

describe('UserService', () => {
  let prisma: any;
  let service: UserService;

  beforeEach(() => {
    prisma = {
      user: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 1 }),
      },
    };
    service = new UserService(prisma);
  });

  const dataOf = (call: jest.Mock) => call.mock.calls[0][0].data;

  describe('create', () => {
    const input = {
      email: 'ada@example.com',
      name: 'Ada',
      password: 'correct-horse',
    } as any;

    it('stores an argon2 hash, never the plaintext password', async () => {
      await service.create(input);

      const stored = dataOf(prisma.user.create).password;
      expect(stored).not.toBe(input.password);
      expect(stored.startsWith('$argon2')).toBe(true);
      await expect(verify(stored, input.password)).resolves.toBe(true);
    });

    it('keeps the remaining profile fields', async () => {
      await service.create(input);

      expect(dataOf(prisma.user.create)).toMatchObject({
        email: input.email,
        name: input.name,
      });
    });

    it('turns a duplicate email into a conflict rather than a 500', async () => {
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.create(input)).rejects.toThrow(ConflictException);
    });

    it('lets an unrelated database error propagate untouched', async () => {
      prisma.user.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(input)).rejects.toThrow('connection lost');
    });
  });

  describe('findByUsername', () => {
    it('matches the name case-insensitively', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await service.findByUsername('AdA');

      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        name: { equals: 'AdA', mode: 'insensitive' },
      });
    });

    it('never selects the password column', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await service.findByUsername('ada');

      const select = prisma.user.findFirst.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('password');
      expect(select).toMatchObject({ id: true, name: true, bio: true });
    });
  });

  describe('update', () => {
    it('applies profile changes as given', async () => {
      await service.update(1, { bio: 'Hello' } as any);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { bio: 'Hello' },
      });
    });

    // The id comes from the authenticated session, so an id in the payload must not be
    // able to redirect the write at another account.
    it('ignores an id supplied in the payload', async () => {
      await service.update(1, { id: 999, bio: 'Hello' } as any);

      expect(prisma.user.update.mock.calls[0][0].where).toEqual({ id: 1 });
      expect(dataOf(prisma.user.update)).not.toHaveProperty('id');
    });

    it('hashes a new password instead of storing it verbatim', async () => {
      await service.update(1, { password: 'new-secret' } as any);

      const stored = dataOf(prisma.user.update).password;
      expect(stored).not.toBe('new-secret');
      await expect(verify(stored, 'new-secret')).resolves.toBe(true);
    });

    it('leaves the password alone when none was supplied', async () => {
      await service.update(1, { bio: 'Hello' } as any);

      expect(dataOf(prisma.user.update)).not.toHaveProperty('password');
    });

    it('treats an empty password as no change rather than hashing it', async () => {
      await service.update(1, { password: '' } as any);

      expect(dataOf(prisma.user.update)).not.toHaveProperty('password');
    });
  });
});
