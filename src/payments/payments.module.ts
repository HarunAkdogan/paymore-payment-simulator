import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Payment, PaymentSchema } from './payment.schema';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockProviderService } from './providers/mock-provider.service';
import { RateLimitGuard } from '../common/rate-limit.guard';
@Module({ imports: [MongooseModule.forFeature([{ name: Payment.name, schema: PaymentSchema }])], controllers: [PaymentsController], providers: [PaymentsService, MockProviderService, RateLimitGuard] })
export class PaymentsModule {}
