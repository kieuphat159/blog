import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    const options = {
      maxRetriesPerRequest: null,
      retryStrategy(times: number) {
        if (times > 3) {
          return null; // Dừng thử kết nối lại
        }
        return Math.min(times * 100, 1000);
      },
    };

    if (redisUrl) {
      this.client = new Redis(redisUrl, options);
    } else {
      const host = this.configService.get<string>('REDIS_HOST', 'localhost');
      const port = this.configService.get<number>('REDIS_PORT', 6379);
      this.client = new Redis({
        host,
        port,
        ...options,
      });
    }

    this.client.on('error', (err) => {
      // Log connection failures without crashing NestJS start

      console.error('Redis connection error:', err);
    });
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  private fallbackMap = new Map<string, string>();

  getClient(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    try {
      // Chỉ đọc từ Redis nếu client đã sẵn sàng và kết nối thành công
      if (this.client && this.client.status === 'ready') {
        const val = await this.client.get(key);
        if (val !== null) return val;
      }
    } catch {
      // Bỏ qua lỗi kết nối
    }
    return this.fallbackMap.get(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (this.client && this.client.status === 'ready') {
        if (ttlSeconds) {
          await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.client.set(key, value);
        }
      }
    } catch {
      // Bỏ qua lỗi kết nối
    }

    // Luôn lưu vào fallback map để phòng hờ
    this.fallbackMap.set(key, value);
    if (ttlSeconds) {
      // unref so a pending cache expiry never keeps the Node event loop alive on its own.
      setTimeout(() => {
        this.fallbackMap.delete(key);
      }, ttlSeconds * 1000).unref();
    }
  }

  async del(key: string): Promise<void> {
    try {
      if (this.client && this.client.status === 'ready') {
        await this.client.del(key);
      }
    } catch {
      // Bỏ qua lỗi kết nối
    }
    this.fallbackMap.delete(key);
  }
}
