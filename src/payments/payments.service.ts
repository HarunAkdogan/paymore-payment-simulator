
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';

import { RedisService } from '../common/redis.module';
import { RabbitMqService } from '../common/rabbitmq/rabbitmq.service';

import { Terminal, TerminalDocument } from '../terminals/terminal.schema';
import { CreatePaymentDto } from './dto/create-payment.dto';

import {
    Payment,
    PaymentDocument,
    PaymentStatus,
} from './payment.schema';

import { MockProviderService } from './providers/mock-provider.service';

import { OutboxEvent } from '../outbox/outbox.schema';
import { OutboxEventStatus } from '../outbox/outbox.schema';

import {
    Refund,
    RefundDocument,
    RefundStatus,
} from './refund.schema';


@Injectable()
export class PaymentsService {

    private readonly logger = new Logger(PaymentsService.name);

    /**
     * Keeps the payment's status history in sync with its current status.
     * For older documents without history, the current status is used as
     * the first history entry before recording the transition.
     */
    private recordStatusChange(
        payment: PaymentDocument,
        newStatus: PaymentStatus,
    ): void {
        if (!payment.statusHistory) {
            payment.statusHistory = [] as any;
        }

        if (payment.statusHistory.length === 0) {
            payment.statusHistory.push({
                status: payment.status,
                changedAt: (payment as any).createdAt ?? new Date(),
            } as any);
        }

        const lastEntry =
            payment.statusHistory[payment.statusHistory.length - 1];

        if (lastEntry.status !== newStatus) {
            payment.statusHistory.push({
                status: newStatus,
                changedAt: new Date(),
            } as any);
        }

        payment.status = newStatus;
    }

    constructor(
       

        @InjectModel(Payment.name)
        private readonly payments: Model<PaymentDocument>,

        @InjectModel(Terminal.name)
        private readonly terminals: Model<TerminalDocument>,

        @InjectModel(OutboxEvent.name)
        private readonly outbox: Model<OutboxEvent>,

        @InjectModel(Refund.name)
        private readonly refunds: Model<RefundDocument>,

        private readonly provider: MockProviderService,
        private readonly redis: RedisService,
        private readonly rabbitMq: RabbitMqService,
    ) { }


    // --------------------------------------------------
    // CREATE PAYMENT
    // --------------------------------------------------

    async create(dto: CreatePaymentDto, idempotencyKey: string) {

        if (!idempotencyKey || idempotencyKey.length > 128) {
            throw new BadRequestException(
                'A valid Idempotency-Key header is required',
            );
        }

        if (
            !Types.ObjectId.isValid(dto.companyId) ||
            !Types.ObjectId.isValid(dto.terminalId)
        ) {
            throw new BadRequestException(
                'Invalid companyId or terminalId',
            );
        }

        const terminal = await this.terminals.findOne({
            _id: new Types.ObjectId(dto.terminalId),
            companyId: new Types.ObjectId(dto.companyId),
            isActive: true,
        }).lean();

        if (!terminal) {
            throw new NotFoundException(
                'Active terminal not found for this company',
            );
        }
        const fingerprint = JSON.stringify({
            companyId: dto.companyId,
            terminalId: dto.terminalId,
            amount: dto.amount,
            currency: dto.currency,
            merchantReference: dto.merchantReference,
            scenario: dto.scenario,
        });

        // Redis prevents duplicate requests from reaching MongoDB and the provider.
        const reservation = await this.redis.reserveIdempotency(
            `payment:${dto.companyId}:${idempotencyKey}`,
            fingerprint,
            86400,
        );

        if (reservation === 'CONFLICT') {
            throw new ConflictException(
                'Idempotency key was already used with a different request',
            );
        }

        if (reservation === 'UNAVAILABLE') {
            throw new ServiceUnavailableException(
                'Idempotency store unavailable; retry safely with the same key',
            );
        }

        if (reservation === 'EXISTS') {
            const existing = await this.payments.findOne({
                companyId: new Types.ObjectId(dto.companyId),
                idempotencyKey,
            }).lean();

            if (existing) {
                if (existing.requestFingerprint !== fingerprint) {
                    throw new ConflictException(
                        'Idempotency key was already used with a different request',
                    );
                }

                return existing;
            }

            throw new ConflictException(
                'Request with this idempotency key is already being processed',
            );
        }

        let payment: PaymentDocument;

        try {
            payment = await this.payments.create({
                ...dto,
                companyId: new Types.ObjectId(dto.companyId),
                terminalId: new Types.ObjectId(dto.terminalId),
                idempotencyKey,
                requestFingerprint: fingerprint,
                status: PaymentStatus.PENDING,
                statusHistory: [
                    {
                        status: PaymentStatus.PENDING,
                        changedAt: new Date(),
                    },
                ],
            });
        } catch (error) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 11000
            ) {
                const existing = await this.payments.findOne({
                    companyId: new Types.ObjectId(dto.companyId),
                    idempotencyKey,
                }).lean();

                if (existing) {
                    if (existing.requestFingerprint !== fingerprint) {
                        throw new ConflictException(
                            'Idempotency key was already used with a different request',
                        );
                    }

                    return existing;
                }

                throw new ConflictException(
                    'merchantReference already exists',
                );
            }

            throw error;
        }
        

        let result;

        try {
            result = await this.provider.sale({
                companyId: dto.companyId,
                merchantReference: dto.merchantReference,
                amount: dto.amount,
                scenario: dto.scenario,
            });
        } catch (error) {
            this.recordStatusChange(payment, PaymentStatus.UNKNOWN);
            payment.failureReason = 'Provider outcome unknown';

            await payment.save();

            throw new ServiceUnavailableException(
                'Payment outcome is unknown; check payment status before retrying',
            );
        }

        this.recordStatusChange(
            payment,
            result.status as PaymentStatus,
        );
        payment.providerReference = result.providerReference;
        payment.failureReason = result.reason;

        let event: any = null;

        if (payment.status === PaymentStatus.SUCCESS) {

            event = {
                eventId: randomUUID(),
                paymentId: payment._id.toString(),
                companyId: payment.companyId.toString(),
                terminalId: payment.terminalId.toString(),
                merchantReference: payment.merchantReference,
                amount: payment.amount,
                currency: payment.currency,
                occurredAt: new Date().toISOString(),
            };

        }

        const session = await this.payments.db.startSession();

        try {

            await session.withTransaction(async () => {

                await payment.save({ session });

                if (event) {

                    await this.outbox.create(
                        [
                            {
                                eventId: event.eventId,
                                eventType: 'payment.completed',
                                aggregateId: payment._id.toString(),
                                payload: event,
                                status: OutboxEventStatus.PENDING,
                            },
                        ],
                        { session },
                    );

                }

            });

        } finally {
            await session.endSession();
        }

        return payment.toObject();
    }


    // --------------------------------------------------
    // FIND ONE
    // --------------------------------------------------

    async findOne(id: string, companyId: string) {

        if (
            !Types.ObjectId.isValid(id) ||
            !Types.ObjectId.isValid(companyId)
        ) {
            throw new NotFoundException('Payment not found');
        }

        const payment = await this.payments.findOne({
            _id: id,
            companyId: new Types.ObjectId(companyId),
        }).lean();

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        return payment;
    }


    // --------------------------------------------------
    // INQUIRY
    // --------------------------------------------------



    async inquiry(id: string, companyId: string) {
        if (
            !Types.ObjectId.isValid(id) ||
            !Types.ObjectId.isValid(companyId)
        ) {
            throw new NotFoundException('Payment not found');
        }

        const payment = await this.payments.findOne({
            _id: id,
            companyId: new Types.ObjectId(companyId),
        });

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        if (
            payment.status !== PaymentStatus.UNKNOWN &&
            payment.status !== PaymentStatus.PENDING
        ) {
            return payment.toObject();
        }

        // Provider'dan güncel sonucu öğren.
        const result = await this.provider.inquiry(
            payment.companyId.toString(),
            payment.merchantReference,
        );

        const session = await this.payments.db.startSession();

        const state: { updated: PaymentDocument | null } = {
            updated: null,
        };

        try {
            await session.withTransaction(async () => {
                const setFields: Record<string, unknown> = {
                    lastInquiryAt: new Date(),
                    status: result.status,
                };

                if (result.providerReference) {
                    setFields.providerReference = result.providerReference;
                }

                if (result.reason) {
                    setFields.failureReason = result.reason;
                } else if (result.status !== 'UNKNOWN') {
                    setFields.failureReason = null;
                }

                const statusHistoryEntries: Array<{
                    status: PaymentStatus;
                    changedAt: Date;
                }> = [];

                const existingHistory = payment.statusHistory ?? [];

                // Seed history for payments created before status history existed.
                if (existingHistory.length === 0) {
                    statusHistoryEntries.push({
                        status: payment.status,
                        changedAt: (payment as any).createdAt ?? new Date(),
                    });
                }

                if (payment.status !== result.status) {
                    statusHistoryEntries.push({
                        status: result.status as PaymentStatus,
                        changedAt: new Date(),
                    });
                }

                const update: Record<string, any> = {
                    $set: setFields,
                    $inc: { inquiryAttempts: 1 },
                };

                if (statusHistoryEntries.length > 0) {
                    update.$push = {
                        statusHistory: {
                            $each: statusHistoryEntries,
                        },
                    };
                }

                state.updated = await this.payments.findOneAndUpdate(
                    {
                        _id: payment._id,
                        companyId: new Types.ObjectId(companyId),
                        status: payment.status,
                    },
                    update,
                    {
                        new: true,
                        session,
                    },
                );

                // Başka bir işlem ödeme durumunu değiştirmiş.
                if (!state.updated) {
                    return;
                }

                // Başarılı ödeme için Outbox event oluştur.
                if (result.status === 'SUCCESS') {
                    const event = {
                        eventId: randomUUID(),
                        paymentId: state.updated._id.toString(),
                        companyId: state.updated.companyId.toString(),
                        terminalId: state.updated.terminalId.toString(),
                        merchantReference: state.updated.merchantReference,
                        amount: state.updated.amount,
                        currency: state.updated.currency,
                        occurredAt: new Date().toISOString(),
                    };

                    await this.outbox.create(
                        [
                            {
                                eventId: event.eventId,
                                eventType: 'payment.completed',
                                aggregateId: state.updated._id.toString(),
                                payload: event,
                                status: OutboxEventStatus.PENDING,
                            },
                        ],
                        { session },
                    );
                }
            });
        } finally {
            await session.endSession();
        }

        if (!state.updated) {
            const latest = await this.payments.findOne({
                _id: payment._id,
                companyId: new Types.ObjectId(companyId),
            });

            if (!latest) {
                throw new NotFoundException('Payment not found');
            }

            return latest.toObject();
        }

        return state.updated.toObject();
    }




    // --------------------------------------------------
    // VOID
    // --------------------------------------------------

    async void(id: string, companyId: string) {

        if (
            !Types.ObjectId.isValid(id) ||
            !Types.ObjectId.isValid(companyId)
        ) {
            throw new NotFoundException('Payment not found');
        }

        const payment = await this.payments.findOne({
            _id: id,
            companyId: new Types.ObjectId(companyId),
        });

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        if (payment.status !== PaymentStatus.PENDING) {
            throw new ConflictException(
                'Only pending payments can be voided',
            );
        }

        if (!payment.providerReference) {
            throw new ConflictException(
                'Provider reference is missing',
            );
        }

        const result = await this.provider.void(
            payment.providerReference,
        );

        if (!result.success) {
            throw new ConflictException(
                'Provider rejected void',
            );
        }

        this.recordStatusChange(payment, PaymentStatus.VOIDED);

        await payment.save();

        return payment.toObject();
    }


    // --------------------------------------------------
    // REFUND
    // --------------------------------------------------

    async refund(
        id: string,
        companyId: string,
        amount: number,
        idempotencyKey: string,
    ) {

        if (
            !Types.ObjectId.isValid(id) ||
            !Types.ObjectId.isValid(companyId)
        ) {
            throw new NotFoundException('Payment not found');
        }

        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new BadRequestException(
                'Invalid refund amount',
            );
        }

        if (
            !idempotencyKey ||
            idempotencyKey.trim().length === 0 ||
            idempotencyKey.length > 200
        ) {
            throw new BadRequestException(
                'Invalid idempotency key',
            );
        }

        const paymentId = new Types.ObjectId(id);
        const companyObjectId = new Types.ObjectId(companyId);

        const payment = await this.payments.findOne({
            _id: paymentId,
            companyId: companyObjectId,
        });

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        // Check idempotency before payment status and remaining-balance checks.
        // A retry of a completed full refund must return the original result.
        const existingRefund = await this.refunds.findOne({
            companyId: companyObjectId,
            idempotencyKey,
        });

        if (existingRefund) {
            if (
                existingRefund.paymentId.toString() !== id ||
                existingRefund.amount !== amount
            ) {
                throw new ConflictException(
                    'Idempotency key already used with different parameters',
                );
            }

            if (existingRefund.status === RefundStatus.SUCCESS) {
                return existingRefund.toObject();
            }

            if (existingRefund.status === RefundStatus.FAILED) {
                throw new ConflictException(
                    'This refund request has already failed',
                );
            }

            throw new ConflictException(
                'Refund is already being processed or requires reconciliation',
            );
        }

        if (
            payment.status !== PaymentStatus.SUCCESS &&
            payment.status !== PaymentStatus.PARTIALLY_REFUNDED
        ) {
            throw new ConflictException(
                'Only successful payments can be refunded',
            );
        }

        const remaining =
            payment.amount -
            (payment.refundedAmount ?? 0) -
            (payment.refundPendingAmount ?? 0);

        if (amount > remaining) {
            throw new BadRequestException(
                `Refund exceeds remaining amount: ${remaining}`,
            );
        }

        if (!payment.providerReference) {
            throw new ConflictException(
                'Provider reference is missing',
            );
        }

        // Refund kaydını oluştur.
        let refundRecord: RefundDocument;

        try {

            refundRecord = await this.refunds.create({
                paymentId,
                companyId: companyObjectId,
                idempotencyKey,
                amount,
                status: RefundStatus.PROCESSING,
            });

        } catch (error) {

            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 11000
            ) {
                throw new ConflictException(
                    'Refund request already exists',
                );
            }

            throw error;
        }

        // İade tutarını atomik şekilde rezerve et.
        const reservedPayment = await this.payments.findOneAndUpdate(
            {
                _id: paymentId,
                companyId: companyObjectId,

                status: {
                    $in: [
                        PaymentStatus.SUCCESS,
                        PaymentStatus.PARTIALLY_REFUNDED,
                    ],
                },

                $expr: {
                    $lte: [
                        {
                            $add: [
                                { $ifNull: ['$refundedAmount', 0] },
                                { $ifNull: ['$refundPendingAmount', 0] },
                                amount,
                            ],
                        },
                        '$amount',
                    ],
                },
            },
            {
                $inc: {
                    refundPendingAmount: amount,
                },
            },
            { new: true },
        );

        if (!reservedPayment) {

            await this.refunds.updateOne(
                { _id: refundRecord._id },
                {
                    $set: {
                        status: RefundStatus.FAILED,
                        failureReason: 'Insufficient refundable amount',
                    },
                },
            );

            throw new BadRequestException(
                'Refund exceeds remaining refundable amount',
            );
        }

        // Provider'a idempotency key ile istek gönder.
        let result: {
            success: boolean;
            refundedAmount: number;
            refundReference?: string;
        };

        try {

            result = await this.provider.refund(
                reservedPayment.providerReference!,
                amount,
                idempotencyKey,
            );

        } catch (error) {

            // Sonuç belirsiz. Rezervasyonu serbest bırakmıyoruz.
            await this.refunds.updateOne(
                { _id: refundRecord._id },
                {
                    $set: {
                        status: RefundStatus.UNKNOWN,
                        failureReason: 'Provider refund outcome is unknown',
                    },
                },
            );

            this.logger.error(
                `Refund outcome unknown: ${refundRecord._id}`,
                error instanceof Error ? error.stack : undefined,
            );

            throw new ServiceUnavailableException(
                'Refund outcome is unknown; reconciliation required',
            );
        }

        // Provider iadeyi reddetti.
        if (!result.success) {

            await this.refunds.updateOne(
                { _id: refundRecord._id },
                {
                    $set: {
                        status: RefundStatus.FAILED,
                        failureReason: 'Provider rejected refund',
                    },
                },
            );

            await this.payments.updateOne(
                {
                    _id: paymentId,
                    refundPendingAmount: { $gte: amount },
                },
                {
                    $inc: {
                        refundPendingAmount: -amount,
                    },
                },
            );

            throw new ConflictException(
                'Provider rejected refund',
            );
        }

        // Provider başarılı dedi ama beklenmeyen sonuç döndürdü.
        if (
            result.refundedAmount !== amount ||
            !result.refundReference
        ) {

            await this.refunds.updateOne(
                { _id: refundRecord._id },
                {
                    $set: {
                        status: RefundStatus.UNKNOWN,
                        failureReason: 'Unexpected provider refund result',
                    },
                },
            );

            throw new ConflictException(
                'Provider refund result requires reconciliation',
            );
        }

        // Payment ve Refund güncellemelerini tek transaction içinde yap.
        const session = await this.payments.db.startSession();

        try {

            await session.withTransaction(async () => {

                const historyTimestamp = new Date();
                const nextPaymentStatus = {
                    $cond: [
                        {
                            $eq: [
                                {
                                    $add: [
                                        { $ifNull: ['$refundedAmount', 0] },
                                        amount,
                                    ],
                                },
                                '$amount',
                            ],
                        },
                        PaymentStatus.REFUNDED,
                        PaymentStatus.PARTIALLY_REFUNDED,
                    ],
                };
                const currentHistory = {
                    $ifNull: ['$statusHistory', []],
                };
                const baseHistory = {
                    $cond: [
                        { $gt: [{ $size: currentHistory }, 0] },
                        currentHistory,
                        [
                            {
                                status: '$status',
                                changedAt: {
                                    $ifNull: ['$createdAt', historyTimestamp],
                                },
                            },
                        ],
                    ],
                };

                const updatedPayment = await this.payments.findOneAndUpdate(
                    {
                        _id: paymentId,
                        companyId: companyObjectId,
                        refundPendingAmount: { $gte: amount },
                    },
                    [
                        {
                            $set: {
                                refundedAmount: {
                                    $add: [
                                        { $ifNull: ['$refundedAmount', 0] },
                                        amount,
                                    ],
                                },

                                refundPendingAmount: {
                                    $subtract: [
                                        { $ifNull: ['$refundPendingAmount', 0] },
                                        amount,
                                    ],
                                },

                                status: nextPaymentStatus,
                                statusHistory: {
                                    $cond: [
                                        { $eq: ['$status', nextPaymentStatus] },
                                        baseHistory,
                                        {
                                            $concatArrays: [
                                                baseHistory,
                                                [
                                                    {
                                                        status: nextPaymentStatus,
                                                        changedAt: historyTimestamp,
                                                    },
                                                ],
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                    {
                        new: true,
                        session,
                    },
                );

                if (!updatedPayment) {
                    throw new Error(
                        'Payment refund update failed',
                    );
                }

                const refundUpdate = await this.refunds.updateOne(
                    {
                        _id: refundRecord._id,
                        status: RefundStatus.PROCESSING,
                    },
                    {
                        $set: {
                            status: RefundStatus.SUCCESS,
                            providerReference: result.refundReference,
                        },
                        $unset: {
                            failureReason: 1,
                        },
                    },
                    { session },
                );

                if (refundUpdate.matchedCount !== 1) {
                    throw new Error(
                        'Refund record update failed',
                    );
                }

            });

        } catch (error) {

            // Provider başarılı olmuş olabilir.
            // Rezervasyonu serbest bırakmıyoruz.
            await this.refunds.updateOne(
                {
                    _id: refundRecord._id,
                    status: RefundStatus.PROCESSING,
                },
                {
                    $set: {
                        status: RefundStatus.UNKNOWN,
                        failureReason: 'Database update requires reconciliation',
                    },
                },
            );

            this.logger.error(
                `Refund transaction failed: ${refundRecord._id}`,
                error instanceof Error ? error.stack : undefined,
            );

            throw new ServiceUnavailableException(
                'Provider refund succeeded but database confirmation requires reconciliation',
            );

        } finally {
            await session.endSession();
        }

        const completedRefund = await this.refunds.findById(
            refundRecord._id,
        ).lean();

        if (!completedRefund) {
            throw new ServiceUnavailableException(
                'Completed refund record could not be found',
            );
        }

        return completedRefund;
    }


    // --------------------------------------------------
    // LIST PAYMENTS
    // --------------------------------------------------

    async listByCompany(companyId: string,
        page: number,
        limit: number,) {

        if (!Types.ObjectId.isValid(companyId)) {
            throw new BadRequestException(
                'Invalid companyId',
            );
        }

        return this.payments
            .find({
                companyId: new Types.ObjectId(companyId),
            })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
    }


    // --------------------------------------------------
    // MQTT PAYMENT STATUS
    // --------------------------------------------------

    async applyMqttStatus(
        paymentId: string,
        terminalId: string,
        messageId: string,
        incomingStatus: 'SUCCESS' | 'DECLINED' | 'PENDING' | 'TIMEOUT',
    ): Promise<'UPDATED' | 'DUPLICATE' | 'IGNORED' | 'CONFLICT'> {

        if (
            !Types.ObjectId.isValid(paymentId) ||
            !Types.ObjectId.isValid(terminalId)
        ) {
            throw new BadRequestException(
                'Invalid paymentId or terminalId',
            );
        }

        if (
            !messageId ||
            messageId.trim().length === 0 ||
            messageId.length > 128
        ) {
            throw new BadRequestException(
                'Invalid messageId',
            );
        }

        const targetStatus: PaymentStatus | null = {
            SUCCESS: PaymentStatus.SUCCESS,
            DECLINED: PaymentStatus.FAILED,
            PENDING: PaymentStatus.PENDING,
            TIMEOUT: PaymentStatus.UNKNOWN,
        }[incomingStatus];

        for (let attempt = 0; attempt < 3; attempt++) {

            const current = await this.payments
                .findOne({
                    _id: new Types.ObjectId(paymentId),
                    terminalId: new Types.ObjectId(terminalId),
                })
                .select('status processedMqttMessageIds statusHistory createdAt')
                .lean();

            if (!current) {
                throw new NotFoundException(
                    'Payment not found for this terminal',
                );
            }

            if (current.processedMqttMessageIds?.includes(messageId)) {
                return 'DUPLICATE';
            }

            let result:
                'UPDATED' |
                'DUPLICATE' |
                'IGNORED' |
                'CONFLICT';

            if (incomingStatus === 'PENDING') {

                if (current.status === PaymentStatus.PENDING) {
                    result = 'DUPLICATE';
                } else if (current.status === PaymentStatus.CREATED) {
                    result = 'UPDATED';
                } else {
                    result = 'IGNORED';
                }

            } else if (incomingStatus === 'TIMEOUT') {

                if (current.status === PaymentStatus.PENDING) {
                    result = 'UPDATED';
                } else if (current.status === PaymentStatus.UNKNOWN) {
                    result = 'DUPLICATE';
                } else {
                    result = 'IGNORED';
                }

            } else if (
                current.status === PaymentStatus.PENDING ||
                current.status === PaymentStatus.UNKNOWN
            ) {

                result = 'UPDATED';

            } else if (current.status === targetStatus) {

                result = 'DUPLICATE';

            } else {

                result = 'CONFLICT';

            }

            const update: Record<string, any> = {
                $addToSet: {
                    processedMqttMessageIds: messageId,
                },
            };

            if (result === 'UPDATED' && targetStatus) {
                update.$set = { status: targetStatus };

                const historyEntries: Array<{
                    status: PaymentStatus;
                    changedAt: Date;
                }> = [];

                if (!current.statusHistory?.length) {
                    historyEntries.push({
                        status: current.status,
                        changedAt: (current as any).createdAt ?? new Date(),
                    });
                }

                if (current.status !== targetStatus) {
                    historyEntries.push({
                        status: targetStatus,
                        changedAt: new Date(),
                    });
                }

                if (historyEntries.length > 0) {
                    update.$push = {
                        statusHistory: {
                            $each: historyEntries,
                        },
                    };
                }
            }

            const updated = await this.payments.findOneAndUpdate(
                {
                    _id: new Types.ObjectId(paymentId),
                    terminalId: new Types.ObjectId(terminalId),
                    status: current.status,
                    processedMqttMessageIds: { $ne: messageId },
                },
                update,
                { new: true },
            );

            if (updated) {
                return result;
            }
        }

        throw new ConflictException(
            'Payment changed concurrently; MQTT message must be retried',
        );
    }

    async getCompanyPaymentSummary(companyId: string) {
        return this.payments.aggregate([
            {
                $match: {
                    companyId: new Types.ObjectId(companyId),
                    status: PaymentStatus.SUCCESS,
                },
            },
            {
                $group: {
                    _id: '$currency',
                    totalAmount: { $sum: '$amount' },
                    paymentCount: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    currency: '$_id',
                    totalAmount: 1,
                    paymentCount: 1,
                },
            },
        ]);
    }

}
