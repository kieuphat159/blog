import { ServiceUnavailableException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { ChatGateway } from './chat.gateway';

/** Let every already-queued promise callback run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ChatGateway', () => {
  let chatService: any;
  let jwtService: { verifyAsync: jest.Mock };
  let rateLimit: { consume: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let emit: jest.Mock;
  let to: jest.Mock;
  let gateway: ChatGateway;

  const USER = 7;
  const CONVERSATION = 100;
  const member = { conversationId: CONVERSATION, userId: USER, role: 'MEMBER' };

  const socketOf = (userId?: number) =>
    ({
      data: userId === undefined ? {} : { user: { id: userId } },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
    }) as any;

  beforeEach(() => {
    chatService = {
      findUserById: jest.fn().mockResolvedValue({ id: USER, name: 'Ada' }),
      ensureConversationMember: jest.fn().mockResolvedValue(member),
      sendMessage: jest.fn().mockResolvedValue({
        message: { id: 500, content: 'hi' },
        conversationId: CONVERSATION,
        senderMemberRole: 'MEMBER',
      }),
      getConversationMembers: jest
        .fn()
        .mockResolvedValue([{ userId: USER }, { userId: 8 }]),
      markConversationRead: jest
        .fn()
        .mockResolvedValue({ lastReadAt: new Date('2024-01-01') }),
    };
    jwtService = { verifyAsync: jest.fn() };
    rateLimit = {
      consume: jest
        .fn()
        .mockReturnValue({ allowed: true, remaining: 7, retryAfterMs: 0 }),
    };
    queue = { enqueue: jest.fn((task: () => Promise<unknown>) => task()) };
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });

    gateway = new ChatGateway(
      chatService,
      jwtService as any,
      rateLimit as any,
      queue as any,
    );
    gateway.server = { to } as any;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleConnection', () => {
    const connecting = (token?: string) => ({
      ...socketOf(),
      handshake: { auth: token ? { token } : {}, headers: {} },
      disconnect: jest.fn(),
    });

    it('joins the user room once the token and the user both check out', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: USER });
      const client = connecting('good.jwt');

      await gateway.handleConnection(client);

      expect(client.data.user).toEqual({ id: USER, name: 'Ada' });
      expect(client.join).toHaveBeenCalledWith(`user:${USER}`);
    });

    it('disconnects a socket with no token', async () => {
      const client = connecting();

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('disconnects a socket whose token does not verify', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('bad signature'));
      const client = connecting('forged.jwt');

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    // A token can outlive the account it was issued for.
    it('disconnects when the token is valid but the user is gone', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: USER });
      chatService.findUserById.mockResolvedValue(null);
      const client = connecting('good.jwt');

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });
  });

  describe('conversation:join', () => {
    it('joins the conversation room after the membership check passes', async () => {
      const client = socketOf(USER);

      const result = await gateway.joinConversation(client, {
        conversationId: CONVERSATION,
      } as any);

      expect(chatService.ensureConversationMember).toHaveBeenCalledWith(
        CONVERSATION,
        USER,
      );
      expect(client.join).toHaveBeenCalledWith(`conversation:${CONVERSATION}`);
      expect(result).toMatchObject({ event: 'conversation:joined' });
    });

    it('does not join the room when the membership check fails', async () => {
      chatService.ensureConversationMember.mockRejectedValue(
        new Error('You are not a member of this conversation'),
      );
      const client = socketOf(USER);

      await expect(
        gateway.joinConversation(client, {
          conversationId: CONVERSATION,
        } as any),
      ).rejects.toThrow();
      expect(client.join).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated socket', async () => {
      await expect(
        gateway.joinConversation(socketOf(), {
          conversationId: CONVERSATION,
        } as any),
      ).rejects.toThrow(WsException);
    });
  });

  describe('message:send', () => {
    const body = {
      conversationId: CONVERSATION,
      content: 'hi',
      tempId: 'temp-1',
    } as any;

    it('acknowledges the send and broadcasts the message to the room', async () => {
      const client = socketOf(USER);

      const ack = await gateway.sendMessage(client, body);
      await flush();

      expect(ack).toMatchObject({
        ok: true,
        tempId: 'temp-1',
        conversationId: CONVERSATION,
      });
      expect(to).toHaveBeenCalledWith(`conversation:${CONVERSATION}`);
      expect(emit).toHaveBeenCalledWith(
        'message:new',
        expect.objectContaining({ id: 500, tempId: 'temp-1' }),
      );
    });

    it('nudges every participant to refresh their conversation list', async () => {
      await gateway.sendMessage(socketOf(USER), body);
      await flush();

      expect(to).toHaveBeenCalledWith(`user:${USER}`);
      expect(to).toHaveBeenCalledWith('user:8');
      expect(emit).toHaveBeenCalledWith('conversation:updated', {
        conversationId: CONVERSATION,
      });
    });

    it('reuses the membership it already resolved instead of looking it up twice', async () => {
      await gateway.sendMessage(socketOf(USER), body);
      await flush();

      expect(chatService.ensureConversationMember).toHaveBeenCalledTimes(1);
      expect(chatService.sendMessage).toHaveBeenCalledWith(
        USER,
        CONVERSATION,
        body,
        member,
      );
    });

    it('refuses the send once the sender trips the rate limit', async () => {
      rateLimit.consume.mockReturnValue({
        allowed: false,
        remaining: 0,
        retryAfterMs: 2400,
      });

      const ack = await gateway.sendMessage(socketOf(USER), body);

      expect(ack).toMatchObject({ ok: false, tempId: 'temp-1' });
      expect(ack.error).toContain('3s');
      expect(chatService.ensureConversationMember).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('rate limits per sender', async () => {
      await gateway.sendMessage(socketOf(USER), body);

      expect(rateLimit.consume).toHaveBeenCalledWith(
        `message:send:${USER}`,
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('reports back rather than throwing when the queue sheds load', async () => {
      queue.enqueue.mockImplementation(() => {
        throw new ServiceUnavailableException('Chat queue is full.');
      });

      const ack = await gateway.sendMessage(socketOf(USER), body);

      expect(ack).toMatchObject({ ok: false, tempId: 'temp-1' });
      expect(ack.error).toContain('Chat queue is full.');
    });

    // The ack goes out as soon as the work is queued, so a later failure can only reach
    // the sender through message:error - never as a rejected ack.
    it('tells the sender directly when the queued send fails', async () => {
      chatService.sendMessage.mockRejectedValue(new Error('db down'));
      const client = socketOf(USER);

      const ack = await gateway.sendMessage(client, body);
      await flush();

      expect(ack).toMatchObject({ ok: true });
      expect(client.emit).toHaveBeenCalledWith('message:error', {
        tempId: 'temp-1',
        conversationId: CONVERSATION,
        error: 'db down',
      });
      expect(emit).not.toHaveBeenCalledWith('message:new', expect.anything());
    });

    it('rejects an unauthenticated socket before consuming any allowance', async () => {
      await expect(gateway.sendMessage(socketOf(), body)).rejects.toThrow(
        WsException,
      );
      expect(rateLimit.consume).not.toHaveBeenCalled();
    });
  });

  describe('conversation:read', () => {
    it('acknowledges and echoes the read marker to the user own devices', async () => {
      const result = await gateway.markConversationRead(socketOf(USER), {
        conversationId: CONVERSATION,
        readAt: '2024-01-01T00:00:00.000Z',
      } as any);

      expect(chatService.markConversationRead).toHaveBeenCalledWith(
        USER,
        CONVERSATION,
        '2024-01-01T00:00:00.000Z',
      );
      expect(to).toHaveBeenCalledWith(`user:${USER}`);
      expect(emit).toHaveBeenCalledWith(
        'conversation:read',
        expect.objectContaining({ conversationId: CONVERSATION }),
      );
      expect(result).toMatchObject({ event: 'conversation:read:ack' });
    });

    it('requires a conversationId', async () => {
      await expect(
        gateway.markConversationRead(socketOf(USER), {} as any),
      ).rejects.toThrow('conversationId is required');
      expect(chatService.markConversationRead).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated socket', async () => {
      await expect(
        gateway.markConversationRead(socketOf(), {
          conversationId: CONVERSATION,
        } as any),
      ).rejects.toThrow(WsException);
    });
  });

  describe('handleDisconnect', () => {
    it('leaves the user room', () => {
      const client = socketOf(USER);

      gateway.handleDisconnect(client);

      expect(client.leave).toHaveBeenCalledWith(`user:${USER}`);
    });

    it('is a no-op for a socket that never authenticated', () => {
      const client = socketOf();

      gateway.handleDisconnect(client);

      expect(client.leave).not.toHaveBeenCalled();
    });
  });
});
