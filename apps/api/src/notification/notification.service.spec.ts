import { NotificationService } from './notification.service';
import { CreateNotificationInput } from './dto/create-notification.input';
import { NotificationType } from './entities/notification.entity';

describe('NotificationService', () => {
  let prisma: any;
  let gateway: { sendToUser: jest.Mock };
  let service: NotificationService;

  const RECIPIENT = 1;
  const ACTOR = 2;

  const input: CreateNotificationInput = {
    recipientId: RECIPIENT,
    actorId: ACTOR,
    type: NotificationType.POST_LIKED,
    postId: 10,
  };

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    gateway = { sendToUser: jest.fn() };
    service = new NotificationService(prisma, gateway as any);
  });

  describe('create', () => {
    it('stores the notification and pushes it to the recipient socket', async () => {
      const created = { id: 100, ...input };
      prisma.notification.create.mockResolvedValue(created);

      await expect(service.create(input)).resolves.toBe(created);

      expect(prisma.notification.create.mock.calls[0][0].data).toEqual({
        recipientId: RECIPIENT,
        actorId: ACTOR,
        type: NotificationType.POST_LIKED,
        postId: 10,
        commentId: undefined,
      });
      expect(gateway.sendToUser).toHaveBeenCalledWith(RECIPIENT, created);
    });

    // The notification list renders "<actor> liked <post>", so both relations must come
    // back with the row rather than needing a second round trip per notification.
    it('returns the actor and post the list needs to render', async () => {
      prisma.notification.create.mockResolvedValue({ id: 100 });

      await service.create(input);

      const include = prisma.notification.create.mock.calls[0][0].include;
      expect(include.actor.select).toMatchObject({ name: true, avatar: true });
      expect(include.post.select).toMatchObject({ title: true, slug: true });
    });

    it('drops a self-notification without writing or emitting anything', async () => {
      await expect(
        service.create({ ...input, actorId: RECIPIENT }),
      ).resolves.toBeNull();

      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(gateway.sendToUser).not.toHaveBeenCalled();
    });

    it('carries commentId through for comment notifications', async () => {
      prisma.notification.create.mockResolvedValue({ id: 100 });

      await service.create({
        ...input,
        type: NotificationType.POST_COMMENTED,
        commentId: 77,
      });

      expect(prisma.notification.create.mock.calls[0][0].data.commentId).toBe(
        77,
      );
    });
  });

  describe('findByUser', () => {
    const argsOf = () => prisma.notification.findMany.mock.calls[0][0];

    it('returns only the caller notifications, newest first', async () => {
      await service.findByUser(RECIPIENT);

      expect(argsOf().where).toEqual({ recipientId: RECIPIENT });
      expect(argsOf().orderBy).toEqual({ createdAt: 'desc' });
    });

    it('defaults to the first page of twenty', async () => {
      await service.findByUser(RECIPIENT);

      expect(argsOf().skip).toBe(0);
      expect(argsOf().take).toBe(20);
    });

    it('honours explicit pagination', async () => {
      await service.findByUser(RECIPIENT, 40, 5);

      expect(argsOf().skip).toBe(40);
      expect(argsOf().take).toBe(5);
    });
  });

  describe('countUnread', () => {
    it('counts only unread notifications for the caller', async () => {
      prisma.notification.count.mockResolvedValue(2);

      await expect(service.countUnread(RECIPIENT)).resolves.toBe(2);
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { recipientId: RECIPIENT, isRead: false },
      });
    });
  });

  describe('markAsRead', () => {
    it('marks a notification the caller owns', async () => {
      prisma.notification.findFirst.mockResolvedValue({ id: 100 });

      await expect(service.markAsRead(RECIPIENT, 100)).resolves.toBe(true);
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 100 },
        data: { isRead: true },
      });
    });

    // The ownership check lives in the lookup, so it has to filter on recipientId -
    // otherwise anyone could mark another user notifications as read.
    it('scopes the ownership lookup to the caller', async () => {
      prisma.notification.findFirst.mockResolvedValue({ id: 100 });

      await service.markAsRead(RECIPIENT, 100);

      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: { id: 100, recipientId: RECIPIENT },
      });
    });

    it('refuses a notification that does not exist or belongs to somebody else', async () => {
      prisma.notification.findFirst.mockResolvedValue(null);

      await expect(service.markAsRead(RECIPIENT, 100)).resolves.toBe(false);
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });
  });

  describe('markAllAsRead', () => {
    it('touches only the caller unread notifications', async () => {
      await expect(service.markAllAsRead(RECIPIENT)).resolves.toBe(true);
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { recipientId: RECIPIENT, isRead: false },
        data: { isRead: true },
      });
    });
  });
});
