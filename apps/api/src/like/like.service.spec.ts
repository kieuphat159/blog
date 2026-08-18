import { BadRequestException } from '@nestjs/common';
import { LikeService } from './like.service';
import { NotificationType } from 'src/notification/entities/notification.entity';

describe('LikeService', () => {
  let prisma: any;
  let notifications: { create: jest.Mock };
  let service: LikeService;

  beforeEach(() => {
    prisma = {
      like: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 1 }),
        count: jest.fn(),
        findUnique: jest.fn(),
      },
      post: { findUnique: jest.fn().mockResolvedValue({ authorId: 20 }) },
    };
    notifications = { create: jest.fn() };
    service = new LikeService(prisma, notifications as any);
  });

  describe('likePost', () => {
    it('records the like and notifies the post author', async () => {
      await expect(service.likePost({ postId: 5, userId: 10 })).resolves.toBe(
        true,
      );

      expect(prisma.like.create).toHaveBeenCalledWith({
        data: { postId: 5, userId: 10 },
      });
      expect(notifications.create).toHaveBeenCalledWith({
        recipientId: 20,
        actorId: 10,
        type: NotificationType.POST_LIKED,
        postId: 5,
      });
    });

    it('coerces a string userId so the like row stores a number', async () => {
      await service.likePost({ postId: 5, userId: '10' });

      expect(prisma.like.create).toHaveBeenCalledWith({
        data: { postId: 5, userId: 10 },
      });
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 10 }),
      );
    });

    it('does not notify an author who liked their own post', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: 10 });

      await service.likePost({ postId: 5, userId: 10 });

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('does not notify when the post disappeared', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      await expect(service.likePost({ postId: 5, userId: 10 })).resolves.toBe(
        true,
      );
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('reports a duplicate like as a bad request', async () => {
      prisma.like.create.mockRejectedValue(new Error('unique constraint'));

      await expect(service.likePost({ postId: 5, userId: 10 })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('unlikePost', () => {
    it('removes the like by its composite key', async () => {
      await expect(service.unlikePost({ postId: 5, userId: 10 })).resolves.toBe(
        true,
      );
      expect(prisma.like.delete).toHaveBeenCalledWith({
        where: { userId_postId: { userId: 10, postId: 5 } },
      });
    });

    it('reports unliking something that was never liked as a bad request', async () => {
      prisma.like.delete.mockRejectedValue(new Error('record not found'));

      await expect(
        service.unlikePost({ postId: 5, userId: 10 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('userLikedPost', () => {
    it.each([
      [{ id: 1 }, true],
      [null, false],
    ])('maps %p to %p', async (row, expected) => {
      prisma.like.findUnique.mockResolvedValue(row);

      await expect(
        service.userLikedPost({ postId: 5, userId: 10 }),
      ).resolves.toBe(expected);
    });
  });

  describe('getPostLikeCount', () => {
    it('counts likes scoped to the post', async () => {
      prisma.like.count.mockResolvedValue(3);

      await expect(service.getPostLikeCount(5)).resolves.toBe(3);
      expect(prisma.like.count).toHaveBeenCalledWith({ where: { postId: 5 } });
    });
  });
});
