
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
        refundPendingAmount: 0,
        requestFingerprint: '',
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
        reserveIdempotency: jest.fn().mockResolvedValue('NEW'),
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

        redis.reserveIdempotency.mockResolvedValue('NEW');

        model.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue(null),
        });

        terminals.findOne.mockReturnValue({
            lean: jest.fn().mockResolvedValue({
                _id: new Types.ObjectId(),
                isActive: true,
            }),
        });

        // Reset mutable fixture fields between tests.
        payment.amount = 10000;
        payment.refundedAmount = 7000;
        payment.refundPendingAmount = 0;
        payment.status = 'SUCCESS';
        payment.providerReference = 'mock-ref';
        payment.requestFingerprint = JSON.stringify({
            companyId: dto.companyId,
            terminalId: dto.terminalId,
            amount: dto.amount,
            currency: dto.currency,
            merchantReference: dto.merchantReference,
            scenario: dto.scenario,
        });

        payment.save.mockResolvedValue(payment);
        payment.toObject.mockReturnValue(payment);

        model.create.mockResolvedValue(payment);

        provider.sale.mockResolvedValue({
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        });
    });

    it('ödeme başarıyla oluşturulmalı', async () => {
        const result = await service.create(dto, 'key-1001');

        expect(model.create).toHaveBeenCalled();
        expect(provider.sale).toHaveBeenCalled();
        expect(result.status).toBe('SUCCESS');
    });

    it('idempotency key olmadan ödeme oluşturmamalı', async () => {
        await expect(
            service.create(dto, ''),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(model.create).not.toHaveBeenCalled();
    });

    it('aynı key farklı istekle kullanılırsa hata vermeli', async () => {
        redis.reserveIdempotency.mockResolvedValueOnce('CONFLICT');

        await expect(
            service.create(dto, 'key-1001'),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(model.create).not.toHaveBeenCalled();
    });

    it('Redis kullanılamıyorsa ödeme oluşturmamalı', async () => {
        redis.reserveIdempotency.mockResolvedValueOnce('UNAVAILABLE');

        await expect(
            service.create(dto, 'key-1001'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(model.create).not.toHaveBeenCalled();
    });

    it('iade tutarı kalan tutarı aşarsa hata vermeli', async () => {
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

    it('başarısız ödeme için iade yapılmamalı', async () => {
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

    it('farklı şirketler aynı merchantReference değerini kullanabilmeli', async () => {
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


    it('provider timeout olursa ödeme UNKNOWN olmalı', async () => {
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

    it('aynı ödeme isteği tekrar gelirse mevcut ödeme dönmeli', async () => {
        const idempotencyKey = 'key-repeat-001';

        // Redis EXISTS sonucunda mevcut ödeme MongoDB'den okunur.
        model.findOne.mockReturnValueOnce({
            lean: jest.fn().mockResolvedValue(payment),
        });

        // İlk istek yeni kayıt oluşturur.
        // İkinci istek aynı anahtarın daha önce kullanıldığını görür.
        redis.reserveIdempotency
            .mockResolvedValueOnce('NEW')
            .mockResolvedValueOnce('EXISTS');

        // İlk istek
        await service.create(dto, idempotencyKey);

        // İkinci, yani tekrarlanan istek
        const secondResult = await service.create(dto, idempotencyKey);

        expect(secondResult).toEqual(payment);

        // Yalnızca bir ödeme oluşturulmalı.
        expect(model.create).toHaveBeenCalledTimes(1);

        // Sağlayıcıya yalnızca bir kez ödeme isteği gönderilmeli.
        expect(provider.sale).toHaveBeenCalledTimes(1);

        // Redis'e iki kez kontrol yapılmalı.
        expect(redis.reserveIdempotency).toHaveBeenCalledTimes(2);
    });

    it('başarılı refund işlemi yapmalı', async () => {
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

        // Daha önce aynı idempotency key ile refund yapılmamış.
        refund.findOne.mockResolvedValue(null);

        // Yeni refund kaydı oluşturuldu.
        refund.create.mockResolvedValue(refundRecord);

        // İlk çağrı: tutar rezerve edildi.
        // İkinci çağrı: transaction içerisinde ödeme güncellendi.
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

        // Provider iadeyi başarılı tamamladı.
        provider.refund.mockResolvedValue({
            success: true,
            refundedAmount: amount,
            refundReference: 'refund-ref-001',
        });

        // Refund kaydının başarılı duruma güncellenmesi.
        refund.updateOne.mockResolvedValue({
            matchedCount: 1,
        });

        // İşlem sonunda tamamlanmış refund kaydı okunacak.
        refund.findById.mockReturnValue({
            lean: jest.fn().mockResolvedValue(completedRefund),
        });

        const result = await service.refund(
            paymentId,
            companyId,
            amount,
            idempotencyKey,
        );

        // Dönen refund başarılı olmalı.
        expect(result.status).toBe('SUCCESS');

        // Refund kaydı bir kez oluşturulmalı.
        expect(refund.create).toHaveBeenCalledTimes(1);

        // Provider'a bir kez iade isteği gönderilmeli.
        expect(provider.refund).toHaveBeenCalledTimes(1);

        // Ödeme iki kez güncellenmeli:
        // 1. İade tutarını rezerve etmek.
        // 2. Transaction içinde kesin iade tutarını işlemek.
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

        // MongoDB transaction çalışmalı.
        expect(session.withTransaction).toHaveBeenCalledTimes(1);

        // Session kapatılmalı.
        expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('aynı refund isteği tekrar gelirse mevcut refund dönmeli', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-key-repeat-001';

        const paymentDocument = {
            ...payment,
            status: 'REFUNDED',
            providerReference: 'mock-ref',
            refundedAmount: 10000,
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

        // Aynı idempotency key ile daha önce başarılı refund yapılmış.
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

        // Yeni refund oluşturulmamalı.
        expect(refund.create).not.toHaveBeenCalled();

        // Provider tekrar çağrılmamalı.
        expect(provider.refund).not.toHaveBeenCalled();

        // Ödeme tutarı yeniden rezerve edilmemeli.
        expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('eşzamanlı iki refund isteğinden yalnızca biri başarılı olmalı', async () => {
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

        // İki isteğin de aynı ödemeyi bulmasını sağla.
        model.findOne.mockResolvedValue(paymentDocument);

        // Daha önce bu idempotency key'lerle refund yapılmamış.
        refund.findOne.mockResolvedValue(null);

        // İki ayrı refund kaydı oluşturulacak.
        refund.create.mockImplementation(async (data: any) => ({
            ...data,
            _id: new Types.ObjectId(),
        }));

        // Provider cevabını kontrollü şekilde bekletiyoruz.
        let resolveProvider: (value: any) => void;

        const providerPromise = new Promise<any>((resolve) => {
            resolveProvider = resolve;
        });

        provider.refund.mockReturnValue(providerPromise);

        // İki rezervasyon isteğini simüle et:
        // İlk rezervasyon başarılı, ikincisi başarısız.
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

            // İlk refund'ın transaction içindeki güncellemesi.
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

        // İkinci rezervasyonun başarısız olmasını bekle.
        await failedReservation;

        // İlk provider isteğine başarılı cevap ver.
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


    it('provider başarılı olsa bile DB transaction başarısızsa refund UNKNOWN olmalı', async () => {
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

        // Daha önce aynı refund yapılmamış.
        refund.findOne.mockResolvedValue(null);

        // Refund kaydı oluşturuldu.
        refund.create.mockResolvedValue(refundRecord);

        // İlk çağrı: rezervasyon başarılı.
        // İkinci çağrı: transaction sırasında DB güncellemesi başarısız.
        model.findOneAndUpdate
            .mockResolvedValueOnce({
                ...paymentDocument,
                refundPendingAmount: amount,
            })
            .mockResolvedValueOnce(null);

        // Provider iadeyi başarılı gerçekleştirdi.
        provider.refund.mockResolvedValue({
            success: true,
            refundedAmount: amount,
            refundReference: 'refund-ref-001',
        });

        refund.updateOne.mockResolvedValue({
            matchedCount: 1,
        });

        // İşlemi gerçekleştir.
        await expect(
            service.refund(
                paymentId,
                companyId,
                amount,
                idempotencyKey,
            ),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        // Provider gerçekten çağrılmış olmalı.
        expect(provider.refund).toHaveBeenCalledTimes(1);

        // İlk çağrı rezervasyon, ikinci çağrı transaction güncellemesi.
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

        // Refund UNKNOWN olarak işaretlenmeli.
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

        // Transaction çalışmış olmalı.
        expect(session.withTransaction).toHaveBeenCalledTimes(1);

        // Session kapatılmalı.
        expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it('provider refund işlemini reddederse refund FAILED olmalı', async () => {
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

        // Önceden aynı refund yapılmamış.
        refund.findOne.mockResolvedValue(null);

        // Refund kaydı oluşturuldu.
        refund.create.mockResolvedValue(refundRecord);

        // İade tutarı rezerve edildi.
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

        // Provider bir kez çağrıldı.
        expect(provider.refund).toHaveBeenCalledTimes(1);

        // Refund FAILED yapılmalı.
        expect(refund.updateOne).toHaveBeenCalledWith(
            { _id: refundRecord._id },
            {
                $set: {
                    status: 'FAILED',
                    failureReason: 'Provider rejected refund',
                },
            },
        );

        // Rezervasyon geri alınmalı.
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

        // Transaction başlatılmamalı.
        expect(session.withTransaction).not.toHaveBeenCalled();
    });

    it('başka firmaya ait terminal kullanılırsa ödeme reddedilmeli', async () => {
        // Terminal bu firmaya ait olmadığı için bulunamıyor.
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

        // Ödeme oluşturulmamalı.
        expect(model.create).not.toHaveBeenCalled();

        // Provider'a istek gönderilmemeli.
        expect(provider.sale).not.toHaveBeenCalled();

        // Redis idempotency kontrolüne bile geçilmemeli.
        expect(redis.reserveIdempotency).not.toHaveBeenCalled();
    });

    it('backend yeniden başladıktan sonra yarım kalan refund tekrar gönderilmemeli', async () => {
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

        // Önceki backend çalışmasından kalan refund kaydı.
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

        // Yeni refund kaydı oluşturulmamalı.
        expect(refund.create).not.toHaveBeenCalled();

        // Provider'a tekrar iade isteği gönderilmemeli.
        expect(provider.refund).not.toHaveBeenCalled();

        // Yeni rezervasyon yapılmamalı.
        expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

});
