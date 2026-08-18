import { PostService } from './post.service';
import { FakeRedis } from '../common/testing/fake-redis';

describe('PostService', () => {
  let prisma: any;
  let redis: FakeRedis;
  let service: PostService;

  beforeEach(() => {
    prisma = {
      post: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({ id: 1 }),
        delete: jest.fn().mockResolvedValue({ id: 1 }),
        count: jest.fn(),
      },
    };
    redis = new FakeRedis();
    service = new PostService(prisma, redis as any);
  });

  const dataOf = (call: jest.Mock) => call.mock.calls[0][0].data;

  describe('update', () => {
    beforeEach(() => {
      prisma.post.findFirst.mockResolvedValue({ id: 1, authorId: 10 });
    });

    it('refuses to update a post the caller does not own', async () => {
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(
        service.update({
          userId: 99,
          updatePostInput: { postId: 1, title: 'Hijacked' },
        }),
      ).rejects.toThrow('You are not authorized to update this post.');
      expect(prisma.post.update).not.toHaveBeenCalled();
    });

    // Regression: UpdatePostInput is a PartialType, so `tags` may legitimately be absent.
    // The old code called updatePostInput.tags!.map(...) and crashed on undefined.
    it('applies a partial update that omits tags without touching the tag relation', async () => {
      await service.update({
        userId: 10,
        updatePostInput: { postId: 1, title: 'New title' },
      });

      const data = dataOf(prisma.post.update);
      expect(data).toEqual({ title: 'New title' });
      expect(data).not.toHaveProperty('tags');
    });

    it('replaces the whole tag set when tags are supplied', async () => {
      await service.update({
        userId: 10,
        updatePostInput: { postId: 1, tags: ['nest', 'prisma'] },
      });

      expect(dataOf(prisma.post.update).tags).toEqual({
        set: [],
        connectOrCreate: [
          { where: { name: 'nest' }, create: { name: 'nest' } },
          { where: { name: 'prisma' }, create: { name: 'prisma' } },
        ],
      });
    });

    it('clears the tags when an explicitly empty list is supplied', async () => {
      await service.update({
        userId: 10,
        updatePostInput: { postId: 1, tags: [] },
      });

      expect(dataOf(prisma.post.update).tags).toEqual({
        set: [],
        connectOrCreate: [],
      });
    });

    it('never forwards postId into the update payload', async () => {
      await service.update({
        userId: 10,
        updatePostInput: { postId: 1, title: 'x' },
      });

      expect(dataOf(prisma.post.update)).not.toHaveProperty('postId');
      expect(prisma.post.update.mock.calls[0][0].where).toEqual({ id: 1 });
    });

    it('invalidates the feed cache', async () => {
      redis.seed('posts:cache_version', 'v1');
      const before = await redis.get('posts:cache_version');

      await service.update({
        userId: 10,
        updatePostInput: { postId: 1, title: 'x' },
      });

      expect(await redis.get('posts:cache_version')).not.toBe(before);
    });
  });

  describe('deletePost', () => {
    it('deletes a post owned by the caller', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: 10 });

      await expect(service.deletePost({ userId: 10, postId: 1 })).resolves.toBe(
        true,
      );
      expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('refuses to delete a post owned by somebody else', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: 10 });

      await expect(
        service.deletePost({ userId: 99, postId: 1 }),
      ).rejects.toThrow('You are not the owner of this post.');
      expect(prisma.post.delete).not.toHaveBeenCalled();
    });

    it('reports a missing post distinctly from an ownership failure', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      await expect(
        service.deletePost({ userId: 10, postId: 404 }),
      ).rejects.toThrow('Post not found.');
    });
  });

  describe('create', () => {
    it('connects the author and upserts every tag', async () => {
      await service.create({
        authorId: 10,
        createPostInput: {
          title: 'Hello',
          content: 'Body',
          slug: 'hello',
          tags: ['nest'],
        } as any,
      });

      const data = dataOf(prisma.post.create);
      expect(data.author).toEqual({ connect: { id: 10 } });
      expect(data.tags).toEqual({
        connectOrCreate: [
          { where: { name: 'nest' }, create: { name: 'nest' } },
        ],
      });
    });

    it('invalidates the feed cache so the new post is visible', async () => {
      redis.seed('posts:cache_version', 'v1');

      await service.create({
        authorId: 10,
        createPostInput: {
          title: 'x',
          content: 'y',
          slug: 'x',
          tags: [],
        } as any,
      });

      expect(await redis.get('posts:cache_version')).not.toBe('v1');
    });
  });

  describe('findAll caching', () => {
    const post = {
      id: 1,
      title: 'Cached',
      createdAt: new Date('2024-01-02T03:04:05.000Z'),
      updatedAt: new Date('2024-02-02T03:04:05.000Z'),
      author: {
        id: 2,
        createdAt: new Date('2023-01-01T00:00:00.000Z'),
        updatedAt: new Date('2023-06-01T00:00:00.000Z'),
      },
    };

    it('queries the database on a cache miss and stores the result with a TTL', async () => {
      prisma.post.findMany.mockResolvedValue([post]);

      const result = await service.findAll({ skip: 0, take: 10 });

      expect(result).toEqual([post]);
      const cacheKey = redis
        .keys()
        .find((key) => key.startsWith('posts:feed:'));
      expect(cacheKey).toBeDefined();
      expect(redis.ttlOf(cacheKey!)).toBe(300);
    });

    // Regression: JSON round-tripping turns Dates into strings, which broke GraphQL
    // serialization on every cache hit until they were revived.
    it('revives Date objects when serving a cache hit', async () => {
      prisma.post.findMany.mockResolvedValue([post]);
      await service.findAll({ skip: 0, take: 10 });
      prisma.post.findMany.mockClear();

      const cached = await service.findAll({ skip: 0, take: 10 });

      expect(prisma.post.findMany).not.toHaveBeenCalled();
      expect(cached[0].createdAt).toBeInstanceOf(Date);
      expect(cached[0].updatedAt).toBeInstanceOf(Date);
      expect(cached[0].author.createdAt).toBeInstanceOf(Date);
      expect(cached[0].createdAt.toISOString()).toBe(
        post.createdAt.toISOString(),
      );
    });

    it('keys the cache per page so pages do not shadow each other', async () => {
      prisma.post.findMany.mockResolvedValue([post]);

      await service.findAll({ skip: 0, take: 10 });
      await service.findAll({ skip: 10, take: 10 });

      expect(prisma.post.findMany).toHaveBeenCalledTimes(2);
      expect(
        redis.keys().filter((key) => key.startsWith('posts:feed:')),
      ).toHaveLength(2);
    });

    it('misses the cache again after a write bumps the cache version', async () => {
      prisma.post.findMany.mockResolvedValue([post]);
      await service.findAll({ skip: 0, take: 10 });

      prisma.post.findFirst.mockResolvedValue({ id: 1, authorId: 10 });
      await service.update({
        userId: 10,
        updatePostInput: { postId: 1, title: 'changed' },
      });

      prisma.post.findMany.mockClear();
      await service.findAll({ skip: 0, take: 10 });

      expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('searchPosts', () => {
    it('only searches published posts, case-insensitively, across title and content', async () => {
      prisma.post.findMany.mockResolvedValue([]);

      await service.searchPosts({ query: 'graphql' });

      const where = prisma.post.findMany.mock.calls[0][0].where;
      expect(where.published).toBe(true);
      expect(where.OR).toEqual([
        { title: { contains: 'graphql', mode: 'insensitive' } },
        { content: { contains: 'graphql', mode: 'insensitive' } },
      ]);
    });
  });
});
