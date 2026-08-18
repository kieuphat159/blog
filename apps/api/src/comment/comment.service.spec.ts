import { CommentService } from './comment.service';
import { CreateCommentInput } from './dto/create-comment.input';
import { NotificationType } from 'src/notification/entities/notification.entity';
import { DEFAULT_PAGE_SIZE } from 'src/constant';

describe('CommentService', () => {
  let prisma: any;
  let notifications: { create: jest.Mock };
  let service: CommentService;

  const AUTHOR = 10;
  const POST_AUTHOR = 20;
  const PARENT_AUTHOR = 30;

  beforeEach(() => {
    prisma = {
      comment: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 100 }),
        findUnique: jest.fn(),
      },
      post: { findUnique: jest.fn() },
    };
    notifications = { create: jest.fn() };
    service = new CommentService(prisma, notifications as any);
  });

  describe('findOneByPost', () => {
    const argsOf = () => prisma.comment.findMany.mock.calls[0][0];

    it('returns only top-level comments, with their replies attached', async () => {
      await service.findOneByPost({ postId: 1 });

      expect(argsOf().where).toEqual({ postId: 1, parentId: null });
      expect(argsOf().include.replies).toBeDefined();
    });

    it('shows newest threads first but replies within a thread oldest first', async () => {
      await service.findOneByPost({ postId: 1 });

      expect(argsOf().orderBy).toEqual({ createdAt: 'desc' });
      expect(argsOf().include.replies.orderBy).toEqual({ createdAt: 'asc' });
    });

    it('falls back to the default page size', async () => {
      await service.findOneByPost({ postId: 1 });

      expect(argsOf().take).toBe(DEFAULT_PAGE_SIZE);
      expect(argsOf().skip).toBe(0);
    });

    it('honours explicit pagination', async () => {
      await service.findOneByPost({ postId: 1, skip: 20, take: 5 });

      expect(argsOf().take).toBe(5);
      expect(argsOf().skip).toBe(20);
    });
  });

  describe('count', () => {
    it('counts replies as well as top-level comments', async () => {
      prisma.comment.count.mockResolvedValue(5);

      await expect(service.count(1)).resolves.toBe(5);
      expect(prisma.comment.count).toHaveBeenCalledWith({
        where: { postId: 1 },
      });
    });
  });

  describe('create', () => {
    const topLevel: CreateCommentInput = { postId: 1, content: 'Nice post!' };
    const reply: CreateCommentInput = {
      postId: 1,
      content: 'Thank you!',
      parentId: 50,
    };

    it('links a top-level comment to its post and author, with no parent', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: POST_AUTHOR });

      await expect(service.create(topLevel, AUTHOR)).resolves.toEqual({
        id: 100,
      });

      const data = prisma.comment.create.mock.calls[0][0].data;
      expect(data).toEqual({
        content: 'Nice post!',
        post: { connect: { id: 1 } },
        author: { connect: { id: AUTHOR } },
      });
    });

    it('links a reply to its parent comment', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: PARENT_AUTHOR });

      await service.create(reply, AUTHOR);

      expect(prisma.comment.create.mock.calls[0][0].data.parent).toEqual({
        connect: { id: 50 },
      });
    });

    it('notifies the post author for a top-level comment', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: POST_AUTHOR });

      await service.create(topLevel, AUTHOR);

      expect(notifications.create).toHaveBeenCalledWith({
        recipientId: POST_AUTHOR,
        actorId: AUTHOR,
        type: NotificationType.POST_COMMENTED,
        postId: 1,
        commentId: 100,
      });
    });

    it('notifies the parent comment author for a reply, not the post author', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: PARENT_AUTHOR });

      await service.create(reply, AUTHOR);

      expect(prisma.post.findUnique).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: PARENT_AUTHOR }),
      );
    });

    it('does not notify you about your own comment on your own post', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: AUTHOR });

      await service.create(topLevel, AUTHOR);

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('does not notify you about replying to yourself', async () => {
      prisma.comment.findUnique.mockResolvedValue({ authorId: AUTHOR });

      await service.create(reply, AUTHOR);

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('still returns the comment when the post row cannot be read', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      await expect(service.create(topLevel, AUTHOR)).resolves.toEqual({
        id: 100,
      });
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('still returns the reply when the parent comment cannot be read', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(service.create(reply, AUTHOR)).resolves.toEqual({ id: 100 });
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('treats parentId 0 as no parent', async () => {
      prisma.post.findUnique.mockResolvedValue({ authorId: POST_AUTHOR });

      await service.create({ ...topLevel, parentId: 0 }, AUTHOR);

      expect(prisma.comment.create.mock.calls[0][0].data).not.toHaveProperty(
        'parent',
      );
      expect(prisma.post.findUnique).toHaveBeenCalled();
    });
  });
});
