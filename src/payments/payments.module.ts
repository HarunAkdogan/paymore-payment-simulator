
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { Payment, PaymentSchema } from './payment.schema';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MockProviderService } from './providers/mock-provider.service';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { Terminal, TerminalSchema } from '../terminals/terminal.schema';


@Module({
    imports: [
        AuthModule,
        MongooseModule.forFeature([
            { name: Payment.name, schema: PaymentSchema },
            { name: Terminal.name, schema: TerminalSchema },
        ]),
    ],
    exports: [PaymentsService],
    controllers: [PaymentsController],
    providers: [
        PaymentsService,
        MockProviderService,
        RateLimitGuard,
    ],
})
export class PaymentsModule { }
