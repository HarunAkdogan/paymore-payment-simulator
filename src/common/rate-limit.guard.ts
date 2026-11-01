import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.module';
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly redis: RedisService, private readonly config: ConfigService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ ip?: string }>();
    const key = `rate:${request.ip ?? 'unknown'}`;
    const max = Number(this.config.get('RATE_LIMIT_MAX', 60));
    const window = Number(this.config.get('RATE_LIMIT_WINDOW_SECONDS', 60));
    const count = await this.redis.incrementWithExpiry(key, window);
    if (count !== null && count > max) throw new HttpException(
  'Too many requests',
  HttpStatus.TOO_MANY_REQUESTS
);
    return true; // Redis outage: fail open for availability; production policy may choose fail closed.
  }
}
