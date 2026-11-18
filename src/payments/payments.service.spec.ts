
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
    NotFoundException,
} from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { Types } from 'mongoose';
import { OutboxEvent } from '../outbox/outbox.schema';
import { CreatePaymentDto } from './dto/create-payment.dto';

describe('PaymentsService', () => {
    const payment = {
        _id: '507f1f77bcf86cd799439011',
        companyId: new Types.ObjectId(),
        terminalId: new Types.ObjectId(),
        amount: 10000,
        refundedAmount: 7000,
        refundPendingAmount: 0,
        requestFingerprint: '',
        statusHistory: [] as any[],
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
        payment.companyId = new Types.ObjectId(dto.companyId);
        payment.terminalId = new Types.ObjectId(dto.terminalId);
        payment.status = 'SUCCESS';
        payment.statusHistory = [];
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

        model.create.mockImplementation(async (data: any) => {
            Object.assign(payment, data);
            return payment;
        });

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
        expect(result.statusHistory.map((entry: any) => entry.status)).toEqual([
            'PENDING',
            'SUCCESS',
        ]);
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
        expect(payment.statusHistory.map((entry: any) => entry.status)).toEqual([
            'PENDING',
            'UNKNOWN',
        ]);
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

    it('MQTT ödeme durumu değişikliğini status history içine eklemeli', async () => {
        const currentPayment: any = {
            ...payment,
            status: 'CREATED',
            processedMqttMessageIds: [],
            statusHistory: [],
            createdAt: new Date('2026-01-01T10:00:00.000Z'),
        };

        model.findOne.mockReturnValueOnce({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(currentPayment),
            }),
        });
        model.findOneAndUpdate.mockResolvedValueOnce({
            ...currentPayment,
            status: 'PENDING',
        });

        const result = await service.applyMqttStatus(
            payment._id.toString(),
            payment.terminalId.toString(),
            'mqtt-message-status-history-001',
            'PENDING',
        );

        expect(result).toBe('UPDATED');

        const update = model.findOneAndUpdate.mock.calls[0][1];
        expect(update.$push.statusHistory.$each.map(
            (entry: any) => entry.status,
        )).toEqual(['CREATED', 'PENDING']);
    });

    it('inquiry durum değişikliğini status history içine eklemeli', async () => {
        const paymentDocument: any = {
            ...payment,
            status: 'PENDING',
            statusHistory: [
                { status: 'PENDING', changedAt: new Date('2026-01-01T10:00:00.000Z') },
            ],
            toObject: jest.fn(),
        };
        paymentDocument.toObject.mockReturnValue(paymentDocument);

        model.findOne.mockResolvedValueOnce(paymentDocument);
        provider.inquiry.mockResolvedValueOnce({
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        });

        model.findOneAndUpdate.mockImplementationOnce(
            async (_filter: any, update: any) => {
                const appendedEntries =
                    update.$push?.statusHistory?.$each ?? [];
                const updated: any = {
                    ...paymentDocument,
                    status: update.$set.status,
                    statusHistory: [
                        ...paymentDocument.statusHistory,
                        ...appendedEntries,
                    ],
                    toObject: jest.fn(),
                };
                updated.toObject.mockReturnValue(updated);
                return updated;
            },
        );

        const result = await service.inquiry(
            paymentDocument._id.toString(),
            paymentDocument.companyId.toString(),
        );

        expect(result.status).toBe('SUCCESS');
        expect(result.statusHistory.map((entry: any) => entry.status)).toEqual([
            'PENDING',
            'SUCCESS',
        ]);
        expect(outbox.create).toHaveBeenCalledTimes(1);
    });

    it('void başarılı olduğunda VOIDED durumunu history içine eklemeli', async () => {
        payment.status = 'PENDING';
        payment.statusHistory = [
            { status: 'PENDING', changedAt: new Date('2026-01-01T10:00:00.000Z') },
        ];

        model.findOne.mockResolvedValueOnce(payment);
        provider.void.mockResolvedValueOnce({ success: true });

        const result = await service.void(
            payment._id.toString(),
            payment.companyId.toString(),
        );

        expect(result.status).toBe('VOIDED');
        expect(result.statusHistory.map((entry: any) => entry.status)).toEqual([
            'PENDING',
            'VOIDED',
        ]);
        expect(payment.save).toHaveBeenCalledTimes(1);
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

        const refundPaymentUpdate = model.findOneAndUpdate.mock.calls[1][1];
        expect(refundPaymentUpdate[0].$set).toHaveProperty('statusHistory');

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

    it('provider refund timeout olursa refund UNKNOWN olmali ve rezervasyon korunmali', async () => {
        const paymentId = payment._id;
        const companyId = payment.companyId.toString();
        const amount = 1000;
        const idempotencyKey = 'refund-provider-timeout-001';

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

        model.findOne.mockResolvedValue(paymentDocument);
        refund.findOne.mockResolvedValue(null);
        refund.create.mockResolvedValue(refundRecord);

        // Iade tutari once atomik olarak rezerve edilir.
        model.findOneAndUpdate.mockResolvedValueOnce({
            ...paymentDocument,
            refundPendingAmount: amount,
        });

        // Provider istegi timeout olur: sonuc belirsizdir.
        provider.refund.mockRejectedValueOnce(
            new Error('Provider timeout'),
        );

        refund.updateOne.mockResolvedValue({ matchedCount: 1 });

        await expect(
            service.refund(
                paymentId,
                companyId,
                amount,
                idempotencyKey,
            ),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(provider.refund).toHaveBeenCalledTimes(1);

        // Refund sonucu UNKNOWN olarak kaydedilmeli.
        expect(refund.updateOne).toHaveBeenCalledWith(
            { _id: refundRecord._id },
            {
                $set: {
                    status: 'UNKNOWN',
                    failureReason: 'Provider refund outcome is unknown',
                },
            },
        );

        // Sonuc belirsiz oldugu icin ayrilan tutar serbest birakilmamali.
        expect(model.updateOne).not.toHaveBeenCalled();
        expect(session.withTransaction).not.toHaveBeenCalled();

        // Transaction baslamadan onceki rezervasyon yapilmis olmali.
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });


    it('provider PENDING döndürürse payment PENDING kalmalı ve Outbox oluşturulmamalı', async()=>{

        provider.sale.mockResolvedValueOnce({
            status: 'PENDING',
            providerReference: 'mock-ref',
        });

        const idempotencyKey = 'key-repeat-001';
        const result = await service.create(dto, idempotencyKey);

        

        payment.status = "PENDING";
        model.create.mockResolvedValue(payment);

        expect(result.status).toBe("PENDING");
        expect(provider.sale).toHaveBeenCalledTimes(1);
        expect(model.create).toHaveBeenCalledTimes(1);
        expect(outbox.create).not.toHaveBeenCalled();
    });


    it('UNKNOWN ödeme Inquiry ile SUCCESS olduğunda Outbox kaydı oluşturulmalı', async () => {
        // 1. Ödeme oluşturulurken provider UNKNOWN dönsün.
        provider.sale.mockResolvedValueOnce({
            status: 'UNKNOWN',
            providerReference: 'mock-ref',
        });

        const idempotencyKey = 'key-unknown-inquiry-001';

        // 2. Ödemeyi oluştur.
        const result = await service.create(dto, idempotencyKey);

        // 3. İlk aşamada ödeme UNKNOWN olmalı ve Outbox kaydı oluşmamalı.
        expect(result.status).toBe('UNKNOWN');
        expect(outbox.create).not.toHaveBeenCalled();

        // 4. Inquiry sırasında provider SUCCESS dönsün.
        provider.inquiry.mockResolvedValueOnce({
            status: 'SUCCESS',
            providerReference: 'mock-ref',
        });

        // 5. Inquiry metodunun bulacağı ödeme belgesini hazırla.
        const paymentDocument = {
            ...payment,
            status: 'UNKNOWN',
            companyId: result.companyId,
            toObject: jest.fn(),
        };

        paymentDocument.toObject.mockReturnValue(paymentDocument);

        model.findOne.mockResolvedValueOnce(paymentDocument);

        // 6. Inquiry sonrasında MongoDB'nin döndüreceği güncel ödeme.
        const updatedPayment = {
            ...paymentDocument,
            status: 'SUCCESS',
            toObject: jest.fn(),
        };

        updatedPayment.toObject.mockReturnValue(updatedPayment);

        model.findOneAndUpdate.mockResolvedValueOnce(updatedPayment);

        // 7. Inquiry çağrısını gerçekleştir.
        const result2 = await service.inquiry(
            result._id.toString(),
            result.companyId.toString(),
        );

        // 8. Sonucun SUCCESS olduğunu doğrula.
        expect(result2.status).toBe('SUCCESS');

        // 9. Provider inquiry çağrısını doğrula.
        expect(provider.inquiry).toHaveBeenCalledTimes(1);

        // 10. SUCCESS sonrası Outbox kaydı oluşturulduğunu doğrula.
        expect(outbox.create).toHaveBeenCalledTimes(1);

        expect(outbox.create).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    eventType: 'payment.completed',
                    status: 'PENDING',
                }),
            ],
            expect.anything(),
        );
    });



    it('PENDING ödeme Inquiry ile FAILED olduğunda ödeme durumunun güncellenmeli ve Outbox kaydı oluşturulmamalı', async () => {

        provider.sale.mockResolvedValueOnce({
            status: 'PENDING',
            providerReference: 'mock-ref',
        });

        const idempotencyKey = 'key-failed-inquiry-001';

        const result = await service.create(dto, idempotencyKey);

        expect(result.status).toBe('PENDING');
        expect(outbox.create).not.toHaveBeenCalled();

        provider.inquiry.mockResolvedValueOnce({
            status: 'FAILED',
            providerReference: 'mock-ref',
        });

        // Inquiry öncesindeki ödeme belgesi.
        const paymentDocument = {
            ...payment,
            status: 'PENDING',
            companyId: result.companyId,
            toObject: jest.fn(),
        };

        paymentDocument.toObject.mockReturnValue(paymentDocument);

        model.findOne.mockResolvedValueOnce(paymentDocument);

        // Inquiry sonrasındaki güncel ödeme.
        const updatedPayment = {
            ...paymentDocument,
            status: 'FAILED',
            toObject: jest.fn(),
        };

        updatedPayment.toObject.mockReturnValue(updatedPayment);

        model.findOneAndUpdate.mockResolvedValueOnce(updatedPayment);

        const result2 = await service.inquiry(
            result._id.toString(),
            result.companyId.toString(),
        );

        // Ödeme FAILED durumuna geçmiş olmalı.
        expect(result2.status).toBe('FAILED');

        // Provider sorgulanmış olmalı.
        expect(provider.inquiry).toHaveBeenCalledTimes(1);

        // Ödeme başarısız olduğu için Outbox kaydı oluşmamalı.
        expect(outbox.create).not.toHaveBeenCalled();
    });


});
