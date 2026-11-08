
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Types } from 'mongoose';

describe('PaymentsService', () => {
    const payment = {
        _id: '507f1f77bcf86cd799439011',
        companyId: new Types.ObjectId(),
        amount: 10000,
        refundedAmount: 7000,
        status: 'SUCCESS',
        merchantReference: 'ORDER-1001',
        providerReference: 'mock-ref',
        save: jest.fn(),
        toObject: jest.fn(),
    };

    const model: any = {
        findById: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        findOneAndUpdate: jest.fn(),
    };

    const terminals: any = {
        findOne: jest.fn(),
    };

    const provider: any = {
        sale: jest.fn(),
        refund: jest.fn(),
        inquiry: jest.fn(),
        void: jest.fn(),
    };

    const redis: any = {
        reserveIdempotency: jest.fn(),
    };

    const service = new PaymentsService(
        model,
        terminals,
        provider,
        redis,
    );

    const dto: any = {
        companyId: '507f1f77bcf86cd799439012',
        terminalId: '507f1f77bcf86cd799439013',
        merchantReference: 'ORDER-1001',
        amount: 10000,
        currency: 'TRY',
        scenario: 'SUCCESS',
    };

    beforeEach(() => {
        jest.clearAllMocks();

        redis.reserveIdempotency.mockResolvedValue('RESERVED');

        model.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue(null),
        });

        terminals.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue({
                _id: new Types.ObjectId(),
                isActive: true,
            }),
        });

        payment.save.mockResolvedValue(payment);
        payment.toObject.mockReturnValue(payment);

        model.create.mockResolvedValue(payment);

        provider.sale.mockResolvedValue({
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        });
    });

    it('ödeme baþarýyla oluþturulmalý', async () => {
        const result = await service.create(dto, 'key-1001');

        expect(model.create).toHaveBeenCalled();
        expect(provider.sale).toHaveBeenCalled();
        expect(result.status).toBe('SUCCESS');
    });

    it('idempotency key olmadan ödeme oluþturmamalý', async () => {
        await expect(
            service.create(dto, ''),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(model.create).not.toHaveBeenCalled();
    });

    it('ayný key farklý istekle kullanýlýrsa hata vermeli', async () => {
        redis.reserveIdempotency.mockResolvedValueOnce('CONFLICT');

        await expect(
            service.create(dto, 'key-1001'),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(model.create).not.toHaveBeenCalled();
    });

    it('Redis kullanýlamýyorsa ödeme oluþturmamalý', async () => {
        redis.reserveIdempotency.mockResolvedValueOnce('UNAVAILABLE');

        await expect(
            service.create(dto, 'key-1001'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(model.create).not.toHaveBeenCalled();
    });

    it('iade tutarý kalan tutarý aþarsa hata vermeli', async () => {
        model.findOne.mockResolvedValue(payment);

        await expect(
            service.refund(
                payment._id.toString(),
                payment.companyId.toString(),
                4000,
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(provider.refund).not.toHaveBeenCalled();
    });

    it('baþarýsýz ödeme için iade yapýlmamalý', async () => {
        model.findOne.mockResolvedValue({
            ...payment,
            status: 'FAILED',
        });

        await expect(
            service.refund(
                payment._id.toString(),
                payment.companyId.toString(),
                1000,
            ),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('farklý þirketler ayný merchantReference deðerini kullanabilmeli', async () => {
        const companyA = '507f1f77bcf86cd799439012';
        const companyB = '507f1f77bcf86cd799439014';

        model.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue(null),
        });

        await service.create(
            { ...dto, companyId: companyA },
            'key-company-a',
        );

        await service.create(
            { ...dto, companyId: companyB },
            'key-company-b',
        );

        expect(model.create).toHaveBeenCalledTimes(2);
    });
});
