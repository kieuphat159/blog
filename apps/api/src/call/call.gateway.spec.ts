import { CallGateway } from './call.gateway';

describe('CallGateway', () => {
  let callService: { canInitiateCall: jest.Mock };
  let jwtService: { verifyAsync: jest.Mock };
  let emit: jest.Mock;
  let to: jest.Mock;
  let gateway: CallGateway;

  const socketOf = (userId: number | undefined) =>
    ({ data: userId === undefined ? {} : { user: { id: userId } } }) as any;

  beforeEach(() => {
    callService = { canInitiateCall: jest.fn().mockResolvedValue(true) };
    jwtService = { verifyAsync: jest.fn() };
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    gateway = new CallGateway(callService as any, jwtService as any);
    gateway.server = { to } as any;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleConnection', () => {
    const connectingSocket = (token?: string) =>
      ({
        data: {},
        handshake: { auth: token ? { token } : {}, headers: {} },
        join: jest.fn(),
        disconnect: jest.fn(),
      }) as any;

    it('joins the caller room for a valid token', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 7 });
      const client = connectingSocket('good.jwt');

      await gateway.handleConnection(client);

      expect(client.data.user).toEqual({ id: 7 });
      expect(client.join).toHaveBeenCalledWith('user:7');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects a socket with no token', async () => {
      const client = connectingSocket();

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.user).toBeUndefined();
    });

    it('disconnects a socket whose token does not verify', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('bad signature'));
      const client = connectingSocket('forged.jwt');

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('accepts a bearer-prefixed token from the Authorization header', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 9 });
      const client = {
        data: {},
        handshake: { auth: {}, headers: { authorization: 'Bearer  hdr.jwt ' } },
        join: jest.fn(),
        disconnect: jest.fn(),
      } as any;

      await gateway.handleConnection(client);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('hdr.jwt');
      expect(client.data.user).toEqual({ id: 9 });
    });
  });

  describe('call:invite', () => {
    it('rings the target when both users share the conversation', async () => {
      const result = await gateway.handleInvite(socketOf(1), {
        conversationId: 100,
        targetUserId: 2,
      });

      expect(callService.canInitiateCall).toHaveBeenCalledWith(100, 1, 2);
      expect(to).toHaveBeenCalledWith('user:2');
      expect(emit).toHaveBeenCalledWith(
        'call:incoming',
        expect.objectContaining({ conversationId: 100, fromUserId: 1 }),
      );
      expect(result).toMatchObject({ event: 'call:invite:sent' });
    });

    it('does not ring anyone when the users share no conversation', async () => {
      callService.canInitiateCall.mockResolvedValue(false);

      const result = await gateway.handleInvite(socketOf(1), {
        conversationId: 100,
        targetUserId: 2,
      });

      expect(emit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ event: 'call:invite:failed' });
    });
  });

  /**
   * Every signalling event must re-check conversation membership. Only call:invite used to
   * do so, which let any authenticated socket push WebRTC offers, answers and ICE
   * candidates at an arbitrary user it had no relationship with.
   */
  describe('signalling authorization', () => {
    const signals: Array<{
      name: string;
      send: (client: any, peerId: number) => Promise<unknown>;
      emitted: string;
      /** Key of the emitted payload that carries the authenticated sender's id. */
      senderField: string;
    }> = [
      {
        name: 'call:accept',
        emitted: 'call:accepted',
        senderField: 'toUserId',
        send: (client, peerId) =>
          gateway.handleAccept(client, {
            conversationId: 100,
            fromUserId: peerId,
          }),
      },
      {
        name: 'call:reject',
        emitted: 'call:rejected',
        senderField: 'fromUserId',
        send: (client, peerId) =>
          gateway.handleReject(client, {
            conversationId: 100,
            fromUserId: peerId,
          }),
      },
      {
        name: 'call:offer',
        emitted: 'call:offer',
        senderField: 'fromUserId',
        send: (client, peerId) =>
          gateway.handleOffer(client, {
            conversationId: 100,
            targetUserId: peerId,
            offer: { sdp: 'x' },
          }),
      },
      {
        name: 'call:answer',
        emitted: 'call:answer',
        senderField: 'fromUserId',
        send: (client, peerId) =>
          gateway.handleAnswer(client, {
            conversationId: 100,
            targetUserId: peerId,
            answer: { sdp: 'y' },
          }),
      },
      {
        name: 'call:ice-candidate',
        emitted: 'call:ice-candidate',
        senderField: 'fromUserId',
        send: (client, peerId) =>
          gateway.handleIceCandidate(client, {
            conversationId: 100,
            targetUserId: peerId,
            candidate: { candidate: 'z' },
          }),
      },
      {
        name: 'call:hangup',
        emitted: 'call:ended',
        senderField: 'fromUserId',
        send: (client, peerId) =>
          gateway.handleHangup(client, {
            conversationId: 100,
            targetUserId: peerId,
          }),
      },
    ];

    describe.each(signals)('$name', ({ send, emitted, senderField }) => {
      it('forwards to the peer when membership checks out', async () => {
        await send(socketOf(1), 2);

        expect(callService.canInitiateCall).toHaveBeenCalledWith(100, 1, 2);
        expect(to).toHaveBeenCalledWith('user:2');
        expect(emit).toHaveBeenCalledWith(
          emitted,
          expect.objectContaining({ [senderField]: 1 }),
        );
      });

      it('drops the signal when the sender shares no conversation with the peer', async () => {
        callService.canInitiateCall.mockResolvedValue(false);

        const result = await send(socketOf(1), 2);

        expect(emit).not.toHaveBeenCalled();
        expect(result).toMatchObject({ event: 'call:unauthorized' });
      });

      it('drops the signal without hitting the database when aimed at self', async () => {
        const result = await send(socketOf(1), 1);

        expect(callService.canInitiateCall).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(result).toMatchObject({ event: 'call:unauthorized' });
      });

      it('rejects a socket that never authenticated', async () => {
        await expect(send(socketOf(undefined), 2)).rejects.toThrow(
          'Unauthorized socket',
        );
        expect(emit).not.toHaveBeenCalled();
      });
    });

    it('drops a signal carrying a non-numeric conversationId', async () => {
      const result = await gateway.handleOffer(socketOf(1), {
        conversationId: Number('not-a-number'),
        targetUserId: 2,
        offer: {},
      });

      expect(callService.canInitiateCall).not.toHaveBeenCalled();
      expect(result).toMatchObject({ event: 'call:unauthorized' });
    });

    it('trusts the socket identity rather than any id supplied in the payload', async () => {
      await gateway.handleOffer(
        { data: { user: { id: 1 } } } as any,
        {
          conversationId: 100,
          targetUserId: 2,
          fromUserId: 999,
          offer: {},
        } as any,
      );

      expect(emit).toHaveBeenCalledWith(
        'call:offer',
        expect.objectContaining({ fromUserId: 1 }),
      );
    });
  });

  describe('handleDisconnect', () => {
    it('leaves the user room', () => {
      const client = { data: { user: { id: 4 } }, leave: jest.fn() } as any;

      gateway.handleDisconnect(client);

      expect(client.leave).toHaveBeenCalledWith('user:4');
    });

    it('is a no-op for a socket that never authenticated', () => {
      const client = { data: {}, leave: jest.fn() } as any;

      gateway.handleDisconnect(client);

      expect(client.leave).not.toHaveBeenCalled();
    });
  });
});
