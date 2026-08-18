import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MessageType } from '@prisma/client';
import { ChatService } from './chat.service';
import { FakeRedis } from '../common/testing/fake-redis';

describe('ChatService', () => {
  let prisma: any;
  let redis: FakeRedis;
  let service: ChatService;
  let tx: any;

  const ALICE = 1;
  const BOB = 2;
  const CONVERSATION = 100;
  const member = {
    conversationId: CONVERSATION,
    userId: ALICE,
    role: 'MEMBER',
    lastReadAt: null,
  };

  beforeEach(() => {
    tx = {
      message: { create: jest.fn().mockResolvedValue({ id: 500 }) },
      conversation: { update: jest.fn() },
      conversationMember: { update: jest.fn() },
    };
    prisma = {
      user: { findMany: jest.fn() },
      conversation: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      conversationMember: { findUnique: jest.fn(), update: jest.fn() },
      message: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((run: any) => run(tx)),
    };
    redis = new FakeRedis();
    service = new ChatService(prisma, redis as any);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ensureConversationMember', () => {
    it('queries the database on a cache miss and caches the membership', async () => {
      prisma.conversationMember.findUnique.mockResolvedValue(member);

      await expect(
        service.ensureConversationMember(CONVERSATION, ALICE),
      ).resolves.toEqual(member);
      expect(
        redis.ttlOf(`chat:member:${CONVERSATION}:${ALICE}`),
      ).toBeGreaterThan(0);
    });

    it('serves a cache hit without querying the database', async () => {
      redis.seed(`chat:member:${CONVERSATION}:${ALICE}`, member);

      await expect(
        service.ensureConversationMember(CONVERSATION, ALICE),
      ).resolves.toEqual(member);
      expect(prisma.conversationMember.findUnique).not.toHaveBeenCalled();
    });

    it('forbids a user who is not a member', async () => {
      prisma.conversationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.ensureConversationMember(CONVERSATION, 99),
      ).rejects.toThrow(ForbiddenException);
      expect(redis.keys()).toHaveLength(0);
    });

    it('keys the cache per conversation and per user', async () => {
      prisma.conversationMember.findUnique.mockResolvedValue(member);

      await service.ensureConversationMember(CONVERSATION, ALICE);
      await service.ensureConversationMember(CONVERSATION, BOB);
      await service.ensureConversationMember(101, ALICE);

      expect(redis.keys().sort()).toEqual([
        'chat:member:100:1',
        'chat:member:100:2',
        'chat:member:101:1',
      ]);
    });

    // The membership cache has no invalidation hook, so a removal only takes effect once
    // the TTL lapses. Pinned here so a future "remove member" feature has to deal with it.
    it('keeps serving a cached membership until the entry expires', async () => {
      redis.seed(`chat:member:${CONVERSATION}:${ALICE}`, member);
      prisma.conversationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.ensureConversationMember(CONVERSATION, ALICE),
      ).resolves.toEqual(member);

      redis.expire(`chat:member:${CONVERSATION}:${ALICE}`);

      await expect(
        service.ensureConversationMember(CONVERSATION, ALICE),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('createDirectConversation', () => {
    it('refuses a conversation with yourself', async () => {
      await expect(
        service.createDirectConversation(ALICE, ALICE),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('refuses when the other participant does not exist', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: ALICE }]);

      await expect(
        service.createDirectConversation(ALICE, 404),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('reuses the existing direct conversation instead of creating a second one', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: ALICE }, { id: BOB }]);
      const existing = {
        id: CONVERSATION,
        members: [{ userId: ALICE }, { userId: BOB }],
      };
      prisma.conversation.findFirst.mockResolvedValue(existing);

      await expect(service.createDirectConversation(ALICE, BOB)).resolves.toBe(
        existing,
      );
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('creates a conversation when the only match is a half-built one', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: ALICE }, { id: BOB }]);
      prisma.conversation.findFirst.mockResolvedValue({
        id: CONVERSATION,
        members: [{ userId: ALICE }],
      });
      prisma.conversation.create.mockResolvedValue({ id: 200 });

      await expect(
        service.createDirectConversation(ALICE, BOB),
      ).resolves.toEqual({ id: 200 });
    });

    it('makes the initiator the owner and the participant a member', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: ALICE }, { id: BOB }]);
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 200 });

      await service.createDirectConversation(ALICE, BOB);

      expect(
        prisma.conversation.create.mock.calls[0][0].data.members.create,
      ).toEqual([
        { userId: ALICE, role: 'OWNER' },
        { userId: BOB, role: 'MEMBER' },
      ]);
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      prisma.conversationMember.findUnique.mockResolvedValue(member);
    });

    it('rejects a message with neither content nor attachment', async () => {
      await expect(
        service.sendMessage(ALICE, CONVERSATION, { content: '   ' }),
      ).rejects.toThrow('Message content or attachmentUrl is required');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a TEXT message carrying only an attachment', async () => {
      await expect(
        service.sendMessage(ALICE, CONVERSATION, {
          type: MessageType.TEXT,
          attachmentUrl: 'https://example.com/a.png',
        }),
      ).rejects.toThrow('Text messages require content');
    });

    it('accepts a non-text message carrying only an attachment', async () => {
      await expect(
        service.sendMessage(ALICE, CONVERSATION, {
          type: MessageType.IMAGE,
          attachmentUrl: 'https://example.com/a.png',
        }),
      ).resolves.toMatchObject({ conversationId: CONVERSATION });
    });

    it('refuses to post into a conversation the sender does not belong to', async () => {
      prisma.conversationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.sendMessage(99, CONVERSATION, { content: 'hi' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('skips the membership lookup when the caller already resolved it', async () => {
      await service.sendMessage(
        ALICE,
        CONVERSATION,
        { content: 'hi' },
        member as any,
      );

      expect(prisma.conversationMember.findUnique).not.toHaveBeenCalled();
    });

    it('trims content and stores the message, conversation pointer and read marker atomically', async () => {
      const result = await service.sendMessage(ALICE, CONVERSATION, {
        content: '  hello  ',
      });

      expect(tx.message.create.mock.calls[0][0].data).toMatchObject({
        conversationId: CONVERSATION,
        senderId: ALICE,
        type: MessageType.TEXT,
        content: 'hello',
        attachmentUrl: null,
      });
      expect(tx.conversation.update).toHaveBeenCalledWith({
        where: { id: CONVERSATION },
        data: { lastMessageId: 500 },
      });
      expect(tx.conversationMember.update).toHaveBeenCalled();
      expect(result).toMatchObject({
        conversationId: CONVERSATION,
        senderMemberRole: 'MEMBER',
      });
    });

    it('refreshes the cached membership with the new read marker', async () => {
      await service.sendMessage(ALICE, CONVERSATION, { content: 'hi' });

      const cached = JSON.parse(
        redis.store.get(`chat:member:${CONVERSATION}:${ALICE}`)!.value,
      );
      expect(cached.lastReadAt).not.toBeNull();
    });
  });

  describe('getMessages', () => {
    beforeEach(() => {
      prisma.conversationMember.findUnique.mockResolvedValue(member);
    });

    it('returns messages oldest-first even though they are fetched newest-first', async () => {
      prisma.message.findMany.mockResolvedValue([
        { id: 3 },
        { id: 2 },
        { id: 1 },
      ]);

      await expect(service.getMessages(ALICE, CONVERSATION)).resolves.toEqual([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);
    });

    it.each([
      [undefined, 50],
      [0, 1],
      [-5, 1],
      [10, 10],
      [500, 100],
    ])('clamps a limit of %p to %p', async (limit, expected) => {
      await service.getMessages(ALICE, CONVERSATION, { limit });

      expect(prisma.message.findMany.mock.calls[0][0].take).toBe(expected);
    });

    it('skips the cursor row itself when paginating', async () => {
      await service.getMessages(ALICE, CONVERSATION, { cursorId: 42 });

      const args = prisma.message.findMany.mock.calls[0][0];
      expect(args.cursor).toEqual({ id: 42 });
      expect(args.skip).toBe(1);
    });

    it('omits cursor arguments on the first page', async () => {
      await service.getMessages(ALICE, CONVERSATION);

      const args = prisma.message.findMany.mock.calls[0][0];
      expect(args).not.toHaveProperty('cursor');
      expect(args).not.toHaveProperty('skip');
    });

    it('refuses to read a conversation the caller does not belong to', async () => {
      prisma.conversationMember.findUnique.mockResolvedValue(null);

      await expect(service.getMessages(99, CONVERSATION)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });
  });
});
