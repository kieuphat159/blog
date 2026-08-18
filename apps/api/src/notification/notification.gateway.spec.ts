import { NotificationGateway } from './notification.gateway';

describe('NotificationGateway', () => {
  let jwtService: { verify: jest.Mock };
  let emit: jest.Mock;
  let to: jest.Mock;
  let gateway: NotificationGateway;

  const socketWith = (auth: any, headers: any = {}) =>
    ({
      data: {},
      handshake: { auth, headers },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    }) as any;

  beforeEach(() => {
    jwtService = { verify: jest.fn() };
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    gateway = new NotificationGateway(jwtService as any);
    gateway.server = { to } as any;
  });

  describe('handleConnection', () => {
    it('joins the personal room for a valid handshake token', async () => {
      jwtService.verify.mockReturnValue({ sub: 7 });
      const client = socketWith({ token: 'good.jwt' });

      await gateway.handleConnection(client);

      expect(client.data.userId).toBe(7);
      expect(client.join).toHaveBeenCalledWith('user:7');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('accepts a bearer token from the Authorization header', async () => {
      jwtService.verify.mockReturnValue({ sub: 7 });
      const client = socketWith({}, { authorization: 'Bearer hdr.jwt' });

      await gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith(
        'hdr.jwt',
        expect.any(Object),
      );
      expect(client.join).toHaveBeenCalledWith('user:7');
    });

    // Older tokens carry the user id as `id` rather than `sub`.
    it('falls back to the id claim when sub is absent', async () => {
      jwtService.verify.mockReturnValue({ id: 9 });
      const client = socketWith({ token: 'good.jwt' });

      await gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('user:9');
    });

    it('disconnects a handshake with no token', async () => {
      const client = socketWith({});

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalled();
      expect(jwtService.verify).not.toHaveBeenCalled();
    });

    it('disconnects when the token does not verify', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });
      const client = socketWith({ token: 'expired.jwt' });

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    });
  });

  describe('sendToUser', () => {
    it('emits into the recipient room only', () => {
      const notification = { id: 1, type: 'POST_LIKED' };

      gateway.sendToUser(7, notification);

      expect(to).toHaveBeenCalledWith('user:7');
      expect(emit).toHaveBeenCalledWith('notification', notification);
    });
  });

  describe('ping', () => {
    it('answers with a pong on the same socket', () => {
      const client = socketWith({});

      gateway.handlePing(client);

      expect(client.emit).toHaveBeenCalledWith('pong');
      expect(to).not.toHaveBeenCalled();
    });
  });

  it('disconnecting needs no explicit cleanup', () => {
    expect(() => gateway.handleDisconnect(socketWith({}))).not.toThrow();
  });
});
