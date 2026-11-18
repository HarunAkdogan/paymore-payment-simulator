
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
    NotFoundException,
} from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { Types } from 'mongoose';
import { OutboxEvent } from '../outbox/outbox.schema';

describe('PaymentsService', () => {
    const payment = {
        _id: '507f1f77bcf86cd799439011',
        companyId: new Types.ObjectId(),
        terminalId: new Types.ObjectId(),
        amount: 10000,
        refundedAmount: 7000,
        status: 'SUCCESS',
        merchantReference: 'ORDER-1001',
        providerReference: 'mock-ref',
        save: jest.fn(),
        toObject: jest.fn(),
    };

    const session: any = {
        withTransaction: jest.fn(async (callback) => {
            await callback();
        }),
        endSession: jest.fn().mockResolvedValue(undefined),
    };

    const model: any = {
        findById: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        findOneAndUpdate: jest.fn(),
        db: {
            startSession: jest.fn().mockResolvedValue(session),
        },
        updateOne: jest.fn().mockResolvedValue({
            matchedCount: 1,
        }),
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
        reserveIdempotency: jest.fn().mockResolvedValue({
            reserved: true,
        }),
    };

    const rabbitMq = {
        publishPaymentCompleted: jest.fn().mockResolvedValue(undefined),
    } as any;

    const outbox = {
        create: jest.fn().mockResolvedValue([]),
    };

    const refund = {
        create: jest.fn(),
        findOne: jest.fn(),
        findById: jest.fn(),
        updateOne: jest.fn(),
    } as any;

    const service = new PaymentsService(
        model,
        terminals,
        outbox as any,
        refund,
        provider,
        redis,
        rabbitMq,
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
                'refund-test-002',
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
                'refund-test-002',
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


    it('provider timeout olursa ödeme UNKNOWN olmalý', async () => {
        provider.sale.mockRejectedValueOnce(
            new Error('Provider timeout'),
        );

        await expect(
            service.create(dto, 'key-timeout-001'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(provider.sale).toHaveBeenCalledTimes(1);
        expect(payment.status).toBe('UNKNOWN');
        expect(payment.save).toHaveBeenCalledTimes(1);
    });

    it('ayný ödeme isteði tekrar gelirse mevcut ödeme dönmeli', async () => {
        const idempotencyKey = 'key-repeat-001';

        // Ýlk istekte ödeme henüz bulunmuyor.
        // Ýkinci istekte mevcut ödeme bulunuyor.
        model.findOne
            .mockReturnValueOnce({
                lean: jest.fn().mockResolvedValue(null),
            })
            .mockReturnValueOnce({
                lean: jest.fn().mockResolvedValue(payment),
            });

        // Ýlk istek yeni kayýt oluþturur.
        // Ýkinci istek ayný anahtarýn daha önce kullanýldýðýný görür.
        redis.reserveIdempotency
            .mockResolvedValueOnce('RESERVED')
            .mockResolvedValueOnce('EXISTS');

        // Ýlk istek
        await service.create(dto, idempotencyKey);

        // Ýkinci, yani tekrarlanan istek
        const secondResult = await service.create(dto, idempotencyKey);

        expect(secondResult).toEqual(payment);

        // Yalnýzca bir ödeme oluþturulmalý.
        expect(model.create).toHaveBeenCalledTimes(1);

        // Saðlayýcýya yalnýzca bir kez ödeme isteði gönderilmeli.
        expect(provider.sale).toHaveBeenCalledTimes(1);

        // Redis'e iki kez kontrol yapýlmalý.
        expect(redis.reserveIdempotency).toHaveBeenCalledTimes(2);
    });

    it('baþarýlý refund iþlemi yapmalý', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-key-001';

        const paymentDocument = {
            ...payment,
            refundedAmount: 7000,
            refundPendingAmount: 0,
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        };

        const refundRecord = {
            _id: new Types.ObjectId(),
            paymentId: new Types.ObjectId(paymentId),
            companyId: payment.companyId,
            idempotencyKey,
            amount,
            status: 'PROCESSING',
        };

        const completedRefund = {
            ...refundRecord,
            status: 'SUCCESS',
            providerReference: 'refund-ref-001',
        };

        // Ödeme bulundu.
        model.findOne.mockResolvedValue(paymentDocument);

        // Daha önce ayný idempotency key ile refund yapýlmamýþ.
        refund.findOne.mockResolvedValue(null);

        // Yeni refund kaydý oluþturuldu.
        refund.create.mockResolvedValue(refundRecord);

        // Ýlk çaðrý: tutar rezerve edildi.
        // Ýkinci çaðrý: transaction içerisinde ödeme güncellendi.
        model.findOneAndUpdate
            .mockResolvedValueOnce({
                ...paymentDocument,
                refundPendingAmount: amount,
            })
            .mockResolvedValueOnce({
                ...paymentDocument,
                refundedAmount: 8000,
                refundPendingAmount: 0,
                status: 'PARTIALLY_REFUNDED',
            });

        // Provider iadeyi baþarýlý tamamladý.
        provider.refund.mockResolvedValue({
            success: true,
            refundedAmount: amount,
            refundReference: 'refund-ref-001',
        });

        // Refund kaydýnýn baþarýlý duruma güncellenmesi.
        refund.updateOne.mockResolvedValue({
            matchedCount: 1,
        });

        // Ýþlem sonunda tamamlanmýþ refund kaydý okunacak.
        refund.findById.mockReturnValue({
            lean: jest.fn().mockResolvedValue(completedRefund),
        });

        const result = await service.refund(
            paymentId,
            companyId,
            amount,
            idempotencyKey,
        );

        // Dönen refund baþarýlý olmalý.
        expect(result.status).toBe('SUCCESS');

        // Refund kaydý bir kez oluþturulmalý.
        expect(refund.create).toHaveBeenCalledTimes(1);

        // Provider'a bir kez iade isteði gönderilmeli.
        expect(provider.refund).toHaveBeenCalledTimes(1);

        // Ödeme iki kez güncellenmeli:
        // 1. Ýade tutarýný rezerve etmek.
        // 2. Transaction içinde kesin iade tutarýný iþlemek.
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

        // MongoDB transaction çalýþmalý.
        expect(session.withTransaction).toHaveBeenCalledTimes(1);

        // Session kapatýlmalý.
        expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('ayný refund isteði tekrar gelirse mevcut refund dönmeli', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-key-repeat-001';

        const paymentDocument = {
            ...payment,
            status: 'SUCCESS',
            providerReference: 'mock-ref',
            refundedAmount: 1000,
            refundPendingAmount: 0,
        };

        const existingRefund = {
            _id: new Types.ObjectId(),
            paymentId: new Types.ObjectId(paymentId),
            companyId: payment.companyId,
            idempotencyKey,
            amount,
            status: 'SUCCESS',
            providerReference: 'refund-ref-001',
            toObject: jest.fn().mockReturnValue({
                status: 'SUCCESS',
                amount,
                providerReference: 'refund-ref-001',
            }),
        };

        // Ödeme MongoDB'de bulundu.
        model.findOne.mockResolvedValueOnce(paymentDocument);

        // Ayný idempotency key ile daha önce baþarýlý refund yapýlmýþ.
        refund.findOne.mockResolvedValueOnce(existingRefund);

        const result = await service.refund(
            paymentId,
            companyId,
            amount,
            idempotencyKey,
        );

        // Mevcut refund dönmeli.
        expect(result.status).toBe('SUCCESS');
        expect(result.amount).toBe(amount);

        // Yeni refund oluþturulmamalý.
        expect(refund.create).not.toHaveBeenCalled();

        // Provider tekrar çaðrýlmamalý.
        expect(provider.refund).not.toHaveBeenCalled();

        // Ödeme tutarý yeniden rezerve edilmemeli.
        expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('eþzamanlý iki refund isteðinden yalnýzca biri baþarýlý olmalý', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 2000;

        const paymentDocument = {
            ...payment,
            amount: 10000,
            refundedAmount: 7000,
            refundPendingAmount: 0,
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        };

        // Ýki isteðin de ayný ödemeyi bulmasýný saðla.
        model.findOne.mockResolvedValue(paymentDocument);

        // Daha önce bu idempotency key'lerle refund yapýlmamýþ.
        refund.findOne.mockResolvedValue(null);

        // Ýki ayrý refund kaydý oluþturulacak.
        refund.create.mockImplementation(async (data: any) => ({
            ...data,
            _id: new Types.ObjectId(),
        }));

        // Provider cevabýný kontrollü þekilde bekletiyoruz.
        let resolveProvider: (value: any) => void;

        const providerPromise = new Promise<any>((resolve) => {
            resolveProvider = resolve;
        });

        provider.refund.mockReturnValue(providerPromise);

        // Ýki rezervasyon isteðini simüle et:
        // Ýlk rezervasyon baþarýlý, ikincisi baþarýsýz.
        let reservationCount = 0;

        model.findOneAndUpdate.mockImplementation(async () => {
            reservationCount++;

            if (reservationCount === 1) {
                return {
                    ...paymentDocument,
                    refundPendingAmount: amount,
                };
            }

            if (reservationCount === 2) {
                return null;
            }

            // Ýlk refund'ýn transaction içindeki güncellemesi.
            return {
                ...paymentDocument,
                refundedAmount: 9000,
                refundPendingAmount: 0,
                status: 'PARTIALLY_REFUNDED',
            };
        });

        let resolveFailedReservation: () => void;

        const failedReservation = new Promise<void>((resolve) => {
            resolveFailedReservation = resolve;
        });

        refund.updateOne.mockImplementation(
            async (_filter: any, update: any) => {
                if (update.$set?.status === 'FAILED') {
                    resolveFailedReservation();
                }

                return { matchedCount: 1 };
            },
        );

        const firstRequest = service.refund(
            paymentId,
            companyId,
            amount,
            'refund-key-concurrent-001',
        );

        const secondRequest = service.refund(
            paymentId,
            companyId,
            amount,
            'refund-key-concurrent-002',
        );

        // Ýkinci rezervasyonun baþarýsýz olmasýný bekle.
        await failedReservation;

        // Ýlk provider isteðine baþarýlý cevap ver.
        resolveProvider!({
            success: true,
            refundedAmount: amount,
            refundReference: 'refund-ref-001',
        });

        const results = await Promise.allSettled([
            firstRequest,
            secondRequest,
        ]);

        const successfulRequests = results.filter(
            (result) => result.status === 'fulfilled',
        );

        const failedRequests = results.filter(
            (result) => result.status === 'rejected',
        );

        expect(successfulRequests).toHaveLength(1);
        expect(failedRequests).toHaveLength(1);

        expect(provider.refund).toHaveBeenCalledTimes(1);
        expect(refund.create).toHaveBeenCalledTimes(2);
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);

        expect(session.withTransaction).toHaveBeenCalledTimes(1);
    });


    it('provider baþarýlý olsa bile DB transaction baþarýsýzsa refund UNKNOWN olmalý', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-db-failure-001';

        const paymentDocument = {
            ...payment,
            amount: 10000,
            refundedAmount: 7000,
            refundPendingAmount: 0,
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        };

        const refundRecord = {
            _id: new Types.ObjectId(),
            paymentId: new Types.ObjectId(paymentId),
            companyId: payment.companyId,
            idempotencyKey,
            amount,
            status: 'PROCESSING',
        };

        // Ödeme bulundu.
        model.findOne.mockResolvedValue(paymentDocument);

        // Daha önce ayný refund yapýlmamýþ.
        refund.findOne.mockResolvedValue(null);

        // Refund kaydý oluþturuldu.
        refund.create.mockResolvedValue(refundRecord);

        // Ýlk çaðrý: rezervasyon baþarýlý.
        // Ýkinci çaðrý: transaction sýrasýnda DB güncellemesi baþarýsýz.
        model.findOneAndUpdate
            .mockResolvedValueOnce({
                ...paymentDocument,
                refundPendingAmount: amount,
            })
            .mockResolvedValueOnce(null);

        // Provider iadeyi baþarýlý gerçekleþtirdi.
        provider.refund.mockResolvedValue({
            success: true,
            refundedAmount: amount,
            refundReference: 'refund-ref-001',
        });

        refund.updateOne.mockResolvedValue({
            matchedCount: 1,
        });

        // Ýþlemi gerçekleþtir.
        await expect(
            service.refund(
                paymentId,
                companyId,
                amount,
                idempotencyKey,
            ),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        // Provider gerçekten çaðrýlmýþ olmalý.
        expect(provider.refund).toHaveBeenCalledTimes(1);

        // Ýlk çaðrý rezervasyon, ikinci çaðrý transaction güncellemesi.
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

        // Refund UNKNOWN olarak iþaretlenmeli.
        expect(refund.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: refundRecord._id,
                status: 'PROCESSING',
            }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'UNKNOWN',
                    failureReason: 'Database update requires reconciliation',
                }),
            }),
        );

        // Transaction çalýþmýþ olmalý.
        expect(session.withTransaction).toHaveBeenCalledTimes(1);

        // Session kapatýlmalý.
        expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('provider refund iþlemini reddederse refund FAILED olmalý', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-provider-fail-001';

        const paymentDocument = {
            ...payment,
            amount: 10000,
            refundedAmount: 7000,
            refundPendingAmount: 0,
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        };

        const refundRecord = {
            _id: new Types.ObjectId(),
            paymentId: new Types.ObjectId(paymentId),
            companyId: payment.companyId,
            idempotencyKey,
            amount,
            status: 'PROCESSING',
        };

        // Ödeme bulundu.
        model.findOne.mockResolvedValue(paymentDocument);

        // Önceden ayný refund yapýlmamýþ.
        refund.findOne.mockResolvedValue(null);

        // Refund kaydý oluþturuldu.
        refund.create.mockResolvedValue(refundRecord);

        // Ýade tutarý rezerve edildi.
        model.findOneAndUpdate.mockResolvedValueOnce({
            ...paymentDocument,
            refundPendingAmount: amount,
        });

        // Provider iadeyi reddetti.
        provider.refund.mockResolvedValueOnce({
            success: false,
            refundedAmount: 0,
        });

        refund.updateOne.mockResolvedValue({
            matchedCount: 1,
        });

        await expect(
            service.refund(
                paymentId,
                companyId,
                amount,
                idempotencyKey,
            ),
        ).rejects.toBeInstanceOf(ConflictException);

        // Provider bir kez çaðrýldý.
        expect(provider.refund).toHaveBeenCalledTimes(1);

        // Refund FAILED yapýlmalý.
        expect(refund.updateOne).toHaveBeenCalledWith(
            { _id: refundRecord._id },
            {
                $set: {
                    status: 'FAILED',
                    failureReason: 'Provider rejected refund',
                },
            },
        );

        // Rezervasyon geri alýnmalý.
        expect(model.updateOne).toHaveBeenCalledWith(
            {
                _id: expect.any(Types.ObjectId),
                refundPendingAmount: { $gte: amount },
            },
            {
                $inc: {
                    refundPendingAmount: -amount,
                },
            },
        );

        // Transaction baþlatýlmamalý.
        expect(session.withTransaction).not.toHaveBeenCalled();
    });

    it('baþka firmaya ait terminal kullanýlýrsa ödeme reddedilmeli', async () => {
        // Terminal bu firmaya ait olmadýðý için bulunamýyor.
        terminals.findOne.mockReturnValueOnce({
            lean: jest.fn().mockResolvedValue(null),
        });

        await expect(
            service.create(dto, 'key-wrong-company-001'),
        ).rejects.toBeInstanceOf(NotFoundException);

        // Terminal sorgusunda firma ID kontrol edilmeli.
        expect(terminals.findOne).toHaveBeenCalledWith({
            _id: new Types.ObjectId(dto.terminalId),
            companyId: new Types.ObjectId(dto.companyId),
            isActive: true,
        });

        // Ödeme oluþturulmamalý.
        expect(model.create).not.toHaveBeenCalled();

        // Provider'a istek gönderilmemeli.
        expect(provider.sale).not.toHaveBeenCalled();

        // Redis idempotency kontrolüne bile geçilmemeli.
        expect(redis.reserveIdempotency).not.toHaveBeenCalled();
    });

    it('backend yeniden baþladýktan sonra yarým kalan refund tekrar gönderilmemeli', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-recovery-001';

        const paymentDocument = {
            ...payment,
            amount: 10000,
            refundedAmount: 7000,
            refundPendingAmount: 1000,
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        };

        // MongoDB'de ödeme hâlâ mevcut.
        model.findOne.mockResolvedValueOnce(paymentDocument);

        // Önceki backend çalýþmasýndan kalan refund kaydý.
        const existingRefund = {
            _id: new Types.ObjectId(),
            paymentId: new Types.ObjectId(paymentId),
            companyId: payment.companyId,
            idempotencyKey,
            amount,
            status: 'PROCESSING',
        };

        refund.findOne.mockResolvedValueOnce(existingRefund);

        await expect(
            service.refund(
                paymentId,
                companyId,
                amount,
                idempotencyKey,
            ),
        ).rejects.toBeInstanceOf(ConflictException);

        // Yeni refund kaydý oluþturulmamalý.
        expect(refund.create).not.toHaveBeenCalled();

        // Provider'a tekrar iade isteði gönderilmemeli.
        expect(provider.refund).not.toHaveBeenCalled();

        // Yeni rezervasyon yapýlmamalý.
        expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

});
