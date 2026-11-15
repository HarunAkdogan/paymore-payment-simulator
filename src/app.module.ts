import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { CompaniesModule } from './companies/companies.module';
import { TerminalsModule } from './terminals/terminals.module';
import { PaymentsModule } from './payments/payments.module';
import { RedisModule } from './common/redis.module';
import { HealthController } from './common/health.controller';
import { AuthModule } from './auth/auth.module';
import { MqttModule } from './common/mqtt/mqtt.module';
import { RabbitMqModule } from './common/rabbitmq/rabbitmq.module';
import { NotificationModule } from './notifications/notification.module';
import { OutboxModule } from './outbox/outbox.module';
import { ScheduleModule } from '@nestjs/schedule';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (c: ConfigService) => ({ uri: c.get<string>('MONGODB_URI', 'mongodb://localhost:27017/paymore_simulator') }) }),
        RedisModule, CompaniesModule, TerminalsModule, PaymentsModule, AuthModule, MqttModule, RabbitMqModule, NotificationModule, OutboxModule, ScheduleModule.forRoot(),
  ],
  controllers: [HealthController],
})
export class AppModule {}
