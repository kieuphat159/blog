import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SignInInput } from './dto/signin.input';
import { PrismaService } from 'src/prisma/prisma.service';
import { verify } from 'argon2';
import { JwtService } from '@nestjs/jwt';
import { AuthJwtPayload } from './types/auth.jwtPayload';
import { User } from '.prisma/client/default';
import { CreateUserInput } from 'src/user/dto/create-user.input';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class AuthService {
  private readonly jwtUserCacheTtlSeconds = Math.max(
    Math.floor(Number(process.env.AUTH_USER_CACHE_TTL_MS ?? 30000) / 1000),
    1,
  );

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
  ) {}
  async validateLocalUser({ email, password }: SignInInput) {
    const user = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Accounts created through OAuth (see google.strategy.ts) are stored with an empty
    // password, which is not a valid argon2 hash. Passing it to verify() throws, so reject
    // those up front and treat any malformed hash as a failed login rather than a 500.
    if (!user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    let passwordMatched: boolean;
    try {
      passwordMatched = await verify(user.password, password);
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!passwordMatched) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  async generateToken(userId: number) {
    const payload: AuthJwtPayload = { sub: userId };
    const accessToken = await this.jwtService.signAsync(payload);
    return { accessToken };
  }

  async login(user: User) {
    const { accessToken } = await this.generateToken(user.id);
    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      accessToken,
    };
  }

  async validateJwtUser(userId: number) {
    const __start = Date.now();
    try {
      const cacheKey = `jwt:user:${userId}`;
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as { id: number };
      }

      const user = await this.prisma.user.findUnique({
        where: {
          id: userId,
        },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      const currentUser = { id: user.id };
      await this.redisService.set(
        cacheKey,
        JSON.stringify(currentUser),
        this.jwtUserCacheTtlSeconds,
      );
      return currentUser;
    } finally {
      console.log(
        `[⏱ Service][AuthService.validateJwtUser] ${Date.now() - __start}ms`,
      );
    }
  }

  async validateGoogleUser(googleUser: CreateUserInput) {
    const user = await this.prisma.user.findUnique({
      where: {
        email: googleUser.email,
      },
    });

    if (user) {
      const { password, ...authUser } = user;
      return authUser;
    }

    const dbUser = await this.prisma.user.create({
      data: {
        ...googleUser,
      },
    });

    const { password, ...authUser } = dbUser;
    return authUser;
  }

  async generateTempOAuthCode(userData: any): Promise<string> {
    const code =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
    const cacheKey = `oauth:code:${code}`;
    await this.redisService.set(cacheKey, JSON.stringify(userData), 30);
    return code;
  }

  async exchangeOAuthCode(code: string): Promise<any> {
    const cacheKey = `oauth:code:${code}`;
    const cached = await this.redisService.get(cacheKey);
    if (!cached) {
      throw new UnauthorizedException('Invalid or expired authorization code');
    }
    await this.redisService.del(cacheKey);
    return JSON.parse(cached);
  }
}
