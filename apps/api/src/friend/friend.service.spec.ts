import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FriendService } from './friend.service';
import { FriendshipRelationStatus } from './enums/friendship-relation-status.enum';
import { NotificationType } from 'src/notification/entities/notification.entity';

describe('FriendService', () => {
  let prisma: any;
  let notifications: { create: jest.Mock };
  let service: FriendService;

  const ALICE = 1;
  const BOB = 2;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn() },
      friendship: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    notifications = { create: jest.fn() };
    service = new FriendService(prisma, notifications as any);
  });

  describe('sendFriendRequest', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: BOB });
      prisma.friendship.create.mockResolvedValue({
        id: 10,
        requesterId: ALICE,
        receiverId: BOB,
        status: 'PENDING',
      });
    });

    it('creates a pending request and notifies the receiver', async () => {
      const result = await service.sendFriendRequest({
        requesterId: ALICE,
        receiverId: BOB,
      });

      expect(result).toMatchObject({ id: 10, status: 'PENDING' });
      expect(notifications.create).toHaveBeenCalledWith({
        recipientId: BOB,
        actorId: ALICE,
        type: NotificationType.FRIEND_REQUEST_RECEIVED,
      });
    });

    it('refuses a self-request before touching the database', async () => {
      await expect(
        service.sendFriendRequest({ requesterId: ALICE, receiverId: ALICE }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a request to a user that does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.sendFriendRequest({ requesterId: ALICE, receiverId: 404 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a duplicate request while one is already pending', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'PENDING',
      });

      await expect(
        service.sendFriendRequest({ requesterId: ALICE, receiverId: BOB }),
      ).rejects.toThrow('Friend request already pending');
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('refuses a request between users who are already friends', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'ACCEPTED',
      });

      await expect(
        service.sendFriendRequest({ requesterId: ALICE, receiverId: BOB }),
      ).rejects.toThrow('You are already friends');
    });

    it('revives a previously rejected friendship and flips the direction', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'REJECTED',
      });
      prisma.friendship.update.mockResolvedValue({ id: 10, status: 'PENDING' });

      await service.sendFriendRequest({ requesterId: BOB, receiverId: ALICE });

      expect(prisma.friendship.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 10 },
          data: expect.objectContaining({
            requesterId: BOB,
            receiverId: ALICE,
            status: 'PENDING',
          }),
        }),
      );
      expect(prisma.friendship.create).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalled();
    });

    // Reachable today only if a new FriendshipStatus is added; the branch silently
    // returns undefined instead of failing, so pin the behaviour down.
    it('does not notify when no friendship row was produced', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'SOMETHING_NEW',
      });

      await expect(
        service.sendFriendRequest({ requesterId: ALICE, receiverId: BOB }),
      ).resolves.toBeUndefined();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('acceptFriendRequest', () => {
    const pending = {
      id: 10,
      requesterId: ALICE,
      receiverId: BOB,
      status: 'PENDING',
    };

    it('lets the receiver accept and notifies the requester', async () => {
      prisma.friendship.findUnique.mockResolvedValue(pending);
      prisma.friendship.update.mockResolvedValue({
        ...pending,
        status: 'ACCEPTED',
      });

      const result = await service.acceptFriendRequest({
        userId: BOB,
        friendshipId: 10,
      });

      expect(result.status).toBe('ACCEPTED');
      expect(notifications.create).toHaveBeenCalledWith({
        recipientId: ALICE,
        actorId: BOB,
        type: NotificationType.FRIEND_REQUEST_ACCEPTED,
      });
    });

    it('forbids the requester from accepting their own request', async () => {
      prisma.friendship.findUnique.mockResolvedValue(pending);

      await expect(
        service.acceptFriendRequest({ userId: ALICE, friendshipId: 10 }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.friendship.update).not.toHaveBeenCalled();
    });

    it('forbids an unrelated user from accepting', async () => {
      prisma.friendship.findUnique.mockResolvedValue(pending);

      await expect(
        service.acceptFriendRequest({ userId: 99, friendshipId: 10 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to accept a request that is no longer pending', async () => {
      prisma.friendship.findUnique.mockResolvedValue({
        ...pending,
        status: 'ACCEPTED',
      });

      await expect(
        service.acceptFriendRequest({ userId: BOB, friendshipId: 10 }),
      ).rejects.toThrow('This friend request is no longer pending');
    });

    it('reports a missing friendship', async () => {
      prisma.friendship.findUnique.mockResolvedValue(null);

      await expect(
        service.acceptFriendRequest({ userId: BOB, friendshipId: 404 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('rejectFriendRequest', () => {
    it('lets the receiver reject without notifying anyone', async () => {
      prisma.friendship.findUnique.mockResolvedValue({
        id: 10,
        requesterId: ALICE,
        receiverId: BOB,
        status: 'PENDING',
      });

      await expect(
        service.rejectFriendRequest({ userId: BOB, friendshipId: 10 }),
      ).resolves.toBe(true);
      expect(prisma.friendship.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { status: 'REJECTED' },
      });
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('forbids the requester from rejecting their own request', async () => {
      prisma.friendship.findUnique.mockResolvedValue({
        id: 10,
        requesterId: ALICE,
        receiverId: BOB,
        status: 'PENDING',
      });

      await expect(
        service.rejectFriendRequest({ userId: ALICE, friendshipId: 10 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('cancelFriendRequest', () => {
    const pending = {
      id: 10,
      requesterId: ALICE,
      receiverId: BOB,
      status: 'PENDING',
    };

    it('lets the requester delete the pending row', async () => {
      prisma.friendship.findUnique.mockResolvedValue(pending);

      await expect(
        service.cancelFriendRequest({ userId: ALICE, friendshipId: 10 }),
      ).resolves.toBe(true);
      expect(prisma.friendship.delete).toHaveBeenCalledWith({
        where: { id: 10 },
      });
    });

    it('forbids the receiver from cancelling', async () => {
      prisma.friendship.findUnique.mockResolvedValue(pending);

      await expect(
        service.cancelFriendRequest({ userId: BOB, friendshipId: 10 }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.friendship.delete).not.toHaveBeenCalled();
    });
  });

  describe('removeFriend', () => {
    it('deletes an accepted friendship in either direction', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'ACCEPTED',
      });

      await expect(
        service.removeFriend({ userId: BOB, friendId: ALICE }),
      ).resolves.toBe(true);
      expect(prisma.friendship.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [
            { requesterId: BOB, receiverId: ALICE },
            { requesterId: ALICE, receiverId: BOB },
          ],
        },
      });
    });

    it('refuses when the friendship is only pending', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'PENDING',
      });

      await expect(
        service.removeFriend({ userId: ALICE, friendId: BOB }),
      ).rejects.toThrow('You are not friends with this user');
      expect(prisma.friendship.delete).not.toHaveBeenCalled();
    });

    it('refuses when there is no friendship at all', async () => {
      await expect(
        service.removeFriend({ userId: ALICE, friendId: BOB }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getFriends', () => {
    it('returns the other side of each accepted friendship', async () => {
      prisma.friendship.findMany.mockResolvedValue([
        {
          requesterId: ALICE,
          receiverId: BOB,
          requester: { id: ALICE, name: 'Alice' },
          receiver: { id: BOB, name: 'Bob' },
        },
        {
          requesterId: 3,
          receiverId: ALICE,
          requester: { id: 3, name: 'Carol' },
          receiver: { id: ALICE, name: 'Alice' },
        },
      ]);

      const friends = await service.getFriends(ALICE);

      expect(friends.map((friend: any) => friend.name)).toEqual([
        'Bob',
        'Carol',
      ]);
    });
  });

  describe('getFriendshipStatus', () => {
    it('reports NONE for yourself without querying', async () => {
      await expect(
        service.getFriendshipStatus({ userId: ALICE, targetUserId: ALICE }),
      ).resolves.toEqual({
        status: FriendshipRelationStatus.NONE,
        friendshipId: null,
      });
      expect(prisma.friendship.findFirst).not.toHaveBeenCalled();
    });

    it('reports NONE when there is no row', async () => {
      await expect(
        service.getFriendshipStatus({ userId: ALICE, targetUserId: BOB }),
      ).resolves.toEqual({
        status: FriendshipRelationStatus.NONE,
        friendshipId: null,
      });
    });

    it('reports FRIENDS for an accepted friendship', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'ACCEPTED',
        requesterId: ALICE,
      });

      await expect(
        service.getFriendshipStatus({ userId: ALICE, targetUserId: BOB }),
      ).resolves.toEqual({
        status: FriendshipRelationStatus.FRIENDS,
        friendshipId: 10,
      });
    });

    it('distinguishes a request you sent from one you received', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'PENDING',
        requesterId: ALICE,
      });

      await expect(
        service.getFriendshipStatus({ userId: ALICE, targetUserId: BOB }),
      ).resolves.toMatchObject({
        status: FriendshipRelationStatus.PENDING_SENT,
      });
      await expect(
        service.getFriendshipStatus({ userId: BOB, targetUserId: ALICE }),
      ).resolves.toMatchObject({
        status: FriendshipRelationStatus.PENDING_RECEIVED,
      });
    });

    it('treats a rejected friendship as NONE so a new request is possible', async () => {
      prisma.friendship.findFirst.mockResolvedValue({
        id: 10,
        status: 'REJECTED',
        requesterId: ALICE,
      });

      await expect(
        service.getFriendshipStatus({ userId: ALICE, targetUserId: BOB }),
      ).resolves.toEqual({
        status: FriendshipRelationStatus.NONE,
        friendshipId: null,
      });
    });
  });

  describe('searchUsers', () => {
    it('short-circuits a blank query without querying', async () => {
      await expect(
        service.searchUsers({ userId: ALICE, query: '   ' }),
      ).resolves.toEqual([]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('trims the query and excludes the searcher', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.searchUsers({ userId: ALICE, query: '  bob  ' });

      const where = prisma.user.findMany.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: ALICE });
      expect(where.OR).toEqual([
        { name: { contains: 'bob', mode: 'insensitive' } },
        { email: { contains: 'bob', mode: 'insensitive' } },
      ]);
    });
  });
});
