import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  constructor(config: ConfigService) {
    this.client = new Redis({ host: config.get('REDIS_HOST', 'localhost'), port: Number(config.get('REDIS_PORT', 6379)), lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    this.client.on('error', (error) => this.logger.warn(`Redis unavailable: ${error.message}`));
    void this.client.connect().catch(() => this.logger.warn('Redis connection failed; API will use fallback behavior.'));
  }
  async onModuleDestroy(): Promise<void> { await this.client.quit().catch(() => undefined); }
  async get(key: string): Promise<string | null> { try { return await this.client.get(key); } catch { return null; } }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> { try { await this.client.set(key, value, 'EX', ttlSeconds); } catch { /* Redis is an optimization; caller continues without cache. */ } }
  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number | null> {
    try { const count = await this.client.incr(key); if (count === 1) await this.client.expire(key, ttlSeconds); return count; } catch { return null; }
  }
  async reserveIdempotency(key: string, fingerprint: string, ttlSeconds: number): Promise<'NEW' | 'EXISTS' | 'CONFLICT' | 'UNAVAILABLE'> {
    try {
      const result = await this.client.set(`idem:${key}`, JSON.stringify({ fingerprint }), 'EX', ttlSeconds, 'NX');
      if (result === 'OK') return 'NEW';
      const old = await this.client.get(`idem:${key}`);
      if (!old) return 'UNAVAILABLE';
      return JSON.parse(old).fingerprint === fingerprint ? 'EXISTS' : 'CONFLICT';
    } catch { return 'UNAVAILABLE'; }
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
