import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesModule } from './companies/companies.module';
import { TerminalsModule } from './terminals/terminals.module';
import { PaymentsModule } from './payments/payments.module';
import { RedisModule } from './common/redis.module';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (c: ConfigService) => ({ uri: c.get<string>('MONGODB_URI', 'mongodb://localhost:27017/paymore_simulator') }) }),
    RedisModule, CompaniesModule, TerminalsModule, PaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
