
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { PaymentAnalyticsService } from './payment-analytics.service';
import {
    Payment,
    PaymentSchema,
    PaymentStatus,
} from './payment.schema';

describe('PaymentAnalyticsService Integration', () => {
    let service: PaymentAnalyticsService;
    let paymentModel: Model<Payment>;
    let module: TestingModule;

    beforeAll(async () => {
        const mongoUri = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017/paymore_test?replicaSet=rs0';

        module = await Test.createTestingModule({
            imports: [
                MongooseModule.forRoot(mongoUri),
                MongooseModule.forFeature([
                    { name: Payment.name, schema: PaymentSchema },
                ]),
            ],
            providers: [PaymentAnalyticsService],
        }).compile();

        await module.init();

        service = module.get<PaymentAnalyticsService>(
            PaymentAnalyticsService,
        );

        paymentModel = module.get<Model<Payment>>(
            getModelToken(Payment.name),
        );
    }, 30000);

    afterAll(async () => {
        if (module) {
            await module.close();
        }
    });

    it('gerçek MongoDB üzerinden þirketin ödeme sayýsýný bulmalý', async () => {
        const companyId = new Types.ObjectId();
        const terminalId = new Types.ObjectId();

        try {
            await paymentModel.create([
                {
                    companyId,
                    terminalId,
                    merchantReference: `INTEGRATION-${new Types.ObjectId()}`,
                    amount: 10000,
                    currency: 'TRY',
                    status: PaymentStatus.SUCCESS,
                },
                {
                    companyId,
                    terminalId,
                    merchantReference: `INTEGRATION-${new Types.ObjectId()}`,
                    amount: 20000,
                    currency: 'TRY',
                    status: PaymentStatus.PENDING,
                },
            ]);

            const result = await service.getCompanyPaymentCount(
                companyId.toString(),
            );

            expect(result).toBe(2);
        } finally {
            await paymentModel.deleteMany({ companyId });
        }
    });
});
