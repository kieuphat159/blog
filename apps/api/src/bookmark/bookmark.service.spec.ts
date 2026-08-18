import { BadRequestException } from '@nestjs/common';
import { BookmarkService } from './bookmark.service';

describe('BookmarkService', () => {
  let prisma: any;
  let service: BookmarkService;

  const USER = 1;
  const POST = 2;
  const key = { userId_postId: { userId: USER, postId: POST } };

  beforeEach(() => {
    prisma = {
      bookmark: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 1 }),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn(),
      },
    };
    service = new BookmarkService(prisma);
  });

  describe('bookmarkPost', () => {
    it('records the bookmark', async () => {
      await expect(
        service.bookmarkPost({ userId: USER, postId: POST }),
      ).resolves.toBe(true);
      expect(prisma.bookmark.create).toHaveBeenCalledWith({
        data: { userId: USER, postId: POST },
      });
    });

    // The unique constraint on (userId, postId) and a missing post both surface here.
    it('reports a duplicate or missing post as a bad request', async () => {
      prisma.bookmark.create.mockRejectedValue(new Error('unique constraint'));

      await expect(
        service.bookmarkPost({ userId: USER, postId: POST }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeBookmark', () => {
    it('deletes by the composite key so one user cannot unbookmark for another', async () => {
      await expect(
        service.removeBookmark({ userId: USER, postId: POST }),
      ).resolves.toBe(true);
      expect(prisma.bookmark.delete).toHaveBeenCalledWith({ where: key });
    });

    it('reports removing a bookmark that is not there as a bad request', async () => {
      prisma.bookmark.delete.mockRejectedValue(new Error('record not found'));

      await expect(
        service.removeBookmark({ userId: USER, postId: POST }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('isBookmarked', () => {
    it.each([
      [{ id: 1 }, true],
      [null, false],
    ])('maps %p to %p', async (row, expected) => {
      prisma.bookmark.findUnique.mockResolvedValue(row);

      await expect(
        service.isBookmarked({ userId: USER, postId: POST }),
      ).resolves.toBe(expected);
      expect(prisma.bookmark.findUnique).toHaveBeenCalledWith({ where: key });
    });
  });

  describe('myBookmarks', () => {
    const argsOf = () => prisma.bookmark.findMany.mock.calls[0][0];

    it('returns only the caller bookmarks, newest first', async () => {
      const rows = [{ id: 1, post: {} }];
      prisma.bookmark.findMany.mockResolvedValue(rows);

      await expect(
        service.myBookmarks({ userId: USER, skip: 0, take: 5 }),
      ).resolves.toBe(rows);

      expect(argsOf().where).toEqual({ userId: USER });
      expect(argsOf().orderBy).toEqual({ createdAt: 'desc' });
    });

    it('honours pagination', async () => {
      await service.myBookmarks({ userId: USER, skip: 20, take: 5 });

      expect(argsOf().skip).toBe(20);
      expect(argsOf().take).toBe(5);
    });

    it('defaults to the first page', async () => {
      await service.myBookmarks({ userId: USER });

      expect(argsOf().skip).toBe(0);
      expect(argsOf().take).toBe(10);
    });

    // The bookmarks page renders each post with its author and its like/comment totals;
    // dropping either from the query turns the list into a wall of blanks.
    it('loads the post details the list needs in one query', async () => {
      await service.myBookmarks({ userId: USER });

      const post = argsOf().include.post.include;
      expect(post.author.select).toMatchObject({ id: true, name: true });
      expect(post._count.select).toMatchObject({
        comments: true,
        likes: true,
      });
    });
  });

  describe('myBookmarksCount', () => {
    it('counts only the caller bookmarks', async () => {
      prisma.bookmark.count.mockResolvedValue(3);

      await expect(service.myBookmarksCount(USER)).resolves.toBe(3);
      expect(prisma.bookmark.count).toHaveBeenCalledWith({
        where: { userId: USER },
      });
    });
  });
});
