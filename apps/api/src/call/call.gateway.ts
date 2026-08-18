import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { AuthJwtPayload } from '../auth/types/auth.jwtPayload';
import { CallService } from './call.service';

type AuthedSocket = Socket & {
  data: {
    user?: {
      id: number;
    };
  };
};

function logWSTiming(
  event: string,
  durationMs: number,
  meta?: Record<string, unknown>,
): void {
  console.log(
    `[⏱ WS][${event}] ${durationMs}ms${meta ? ` | ${JSON.stringify(meta)}` : ''}`,
  );
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  },
})
export class CallGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly callService: CallService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    const start = Date.now();
    let connected = false;

    const token = this.extractToken(client);

    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      const payload = await this.jwtService.verifyAsync<AuthJwtPayload>(token);
      client.data.user = { id: payload.sub };
      client.join(this.userRoom(payload.sub));
      connected = true;
    } catch {
      client.disconnect(true);
    } finally {
      logWSTiming('connection', Date.now() - start, {
        connected,
        userId: client.data.user?.id,
      });
    }
  }

  handleDisconnect(client: AuthedSocket) {
    if (client.data.user) {
      client.leave(this.userRoom(client.data.user.id));
    }
  }

  @SubscribeMessage('call:invite')
  async handleInvite(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { conversationId: number; targetUserId: number },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);
    const canInitiate = await this.callService.canInitiateCall(
      body.conversationId,
      user.id,
      body.targetUserId,
    );

    if (!canInitiate) {
      logWSTiming('call:invite', Date.now() - start, {
        result: 'failed',
        conversationId: body.conversationId,
      });
      return {
        event: 'call:invite:failed',
        data: { message: 'Unable to start call' },
      };
    }

    this.server.to(this.userRoom(body.targetUserId)).emit('call:incoming', {
      conversationId: body.conversationId,
      fromUserId: user.id,
      fromUserName: user.id,
    });

    logWSTiming('call:invite', Date.now() - start, {
      result: 'sent',
      conversationId: body.conversationId,
    });
    return {
      event: 'call:invite:sent',
      data: { targetUserId: body.targetUserId },
    };
  }

  @SubscribeMessage('call:accept')
  async handleAccept(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { conversationId: number; fromUserId: number },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);

    if (!(await this.isCallPeer(body.conversationId, user.id, body.fromUserId))) {
      return this.denySignal('call:accept', start, body.conversationId);
    }

    this.server.to(this.userRoom(body.fromUserId)).emit('call:accepted', {
      conversationId: body.conversationId,
      toUserId: user.id,
    });

    logWSTiming('call:accept', Date.now() - start, {
      conversationId: body.conversationId,
    });
    return {
      event: 'call:accepted:ack',
      data: { conversationId: body.conversationId },
    };
  }

  @SubscribeMessage('call:offer')
  async handleOffer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody()
    body: { conversationId: number; targetUserId: number; offer: unknown },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);

    if (!(await this.isCallPeer(body.conversationId, user.id, body.targetUserId))) {
      return this.denySignal('call:offer', start, body.conversationId);
    }

    this.server.to(this.userRoom(body.targetUserId)).emit('call:offer', {
      fromUserId: user.id,
      offer: body.offer,
    });
    logWSTiming('call:offer', Date.now() - start, {
      targetUserId: body.targetUserId,
    });
  }

  @SubscribeMessage('call:answer')
  async handleAnswer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody()
    body: { conversationId: number; targetUserId: number; answer: unknown },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);

    if (!(await this.isCallPeer(body.conversationId, user.id, body.targetUserId))) {
      return this.denySignal('call:answer', start, body.conversationId);
    }

    this.server.to(this.userRoom(body.targetUserId)).emit('call:answer', {
      fromUserId: user.id,
      answer: body.answer,
    });
    logWSTiming('call:answer', Date.now() - start, {
      targetUserId: body.targetUserId,
    });
  }

  @SubscribeMessage('call:reject')
  async handleReject(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { conversationId: number; fromUserId: number },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);

    if (!(await this.isCallPeer(body.conversationId, user.id, body.fromUserId))) {
      return this.denySignal('call:reject', start, body.conversationId);
    }

    this.server.to(this.userRoom(body.fromUserId)).emit('call:rejected', {
      conversationId: body.conversationId,
      fromUserId: user.id,
    });

    logWSTiming('call:reject', Date.now() - start, {
      conversationId: body.conversationId,
    });
    return {
      event: 'call:rejected:ack',
      data: { conversationId: body.conversationId },
    };
  }

  @SubscribeMessage('call:ice-candidate')
  async handleIceCandidate(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody()
    body: { conversationId: number; targetUserId: number; candidate: unknown },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);

    if (!(await this.isCallPeer(body.conversationId, user.id, body.targetUserId))) {
      return this.denySignal('call:ice-candidate', start, body.conversationId);
    }

    this.server
      .to(this.userRoom(body.targetUserId))
      .emit('call:ice-candidate', {
        fromUserId: user.id,
        candidate: body.candidate,
      });
    logWSTiming('call:ice-candidate', Date.now() - start);
  }

  @SubscribeMessage('call:hangup')
  async handleHangup(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { conversationId: number; targetUserId: number },
  ) {
    const start = Date.now();
    const user = this.requireUser(client);

    if (!(await this.isCallPeer(body.conversationId, user.id, body.targetUserId))) {
      return this.denySignal('call:hangup', start, body.conversationId);
    }

    this.server.to(this.userRoom(body.targetUserId)).emit('call:ended', {
      conversationId: body.conversationId,
      fromUserId: user.id,
    });
  }

  private extractToken(client: AuthedSocket) {
    const authToken = client.handshake.auth?.token as string | undefined;
    const headerToken = client.handshake.headers.authorization;
    const token = authToken ?? headerToken;

    if (!token) {
      return null;
    }

    if (token.startsWith('Bearer ')) {
      return token.slice(7).trim();
    }

    return token.trim();
  }

  /**
   * Every signalling event must be re-authorized, not just call:invite. Otherwise any
   * authenticated socket could push WebRTC offers/answers/ICE candidates at an arbitrary
   * targetUserId without ever sharing a conversation with them.
   */
  private isCallPeer(
    conversationId: number,
    userId: number,
    peerUserId: number,
  ) {
    if (
      !Number.isInteger(conversationId) ||
      !Number.isInteger(peerUserId) ||
      peerUserId === userId
    ) {
      return Promise.resolve(false);
    }

    return this.callService.canInitiateCall(conversationId, userId, peerUserId);
  }

  private denySignal(event: string, start: number, conversationId: number) {
    logWSTiming(event, Date.now() - start, {
      result: 'unauthorized',
      conversationId,
    });

    return {
      event: 'call:unauthorized',
      data: { message: 'Unable to signal this call' },
    };
  }

  private requireUser(client: AuthedSocket) {
    if (!client.data.user) {
      throw new Error('Unauthorized socket');
    }

    return client.data.user;
  }

  private userRoom(userId: number) {
    return `user:${userId}`;
  }
}
