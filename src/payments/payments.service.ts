
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

        const fingerprint =
            `${dto.companyId}:${dto.terminalId}:${dto.amount}:${dto.currency}:${dto.merchantReference}`;

        const reservation = await this.redis.reserveIdempotency(
            idempotencyKey,
            fingerprint,
            86400,
        );

        if (reservation === 'CONFLICT') {
            throw new ConflictException(
                'Idempotency key was already used with a different request',
            );
        }

        if (reservation === 'EXISTS') {

            const existing = await this.payments.findOne({
                companyId: new Types.ObjectId(dto.companyId),
                merchantReference: dto.merchantReference,
            }).lean();

            if (existing) {
                return existing;
            }

            throw new ConflictException(
                'Request with this idempotency key is already being processed',
            );
        }

        if (reservation === 'UNAVAILABLE') {
            throw new ServiceUnavailableException(
                'Idempotency store unavailable; retry safely with the same key',
            );
        }

        const existingReference = await this.payments.findOne({
            companyId: new Types.ObjectId(dto.companyId),
            merchantReference: dto.merchantReference,
        }).lean();

        if (existingReference) {
            throw new ConflictException(
                'merchantReference already exists',
            );
        }

        let payment: PaymentDocument;

        try {

            payment = await this.payments.create({
                ...dto,
                companyId: new Types.ObjectId(dto.companyId),
                terminalId: new Types.ObjectId(dto.terminalId),
                status: PaymentStatus.PENDING,
            });

        } catch (error) {

            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 11000
            ) {
                throw new ConflictException(
                    'merchantReference already exists',
                );
            }

            throw error;
        }

        const result = await this.provider.sale({
            companyId: dto.companyId,
            merchantReference: dto.merchantReference,
            amount: dto.amount,
            scenario: dto.scenario,
        });

        payment.status = result.status as PaymentStatus;
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

        const result = await this.provider.inquiry(
            payment.companyId.toString(),
            payment.merchantReference,
        );

        const setFields: Record<string, unknown> = {
            lastInquiryAt: new Date(),
        };

        if (result.status !== 'UNKNOWN') {
            setFields.status = result.status;
        }

        if (result.providerReference) {
            setFields.providerReference = result.providerReference;
        }

        if (result.reason) {
            setFields.failureReason = result.reason;
        } else if (result.status !== 'UNKNOWN') {
            setFields.failureReason = null;
        }

        const updated = await this.payments.findOneAndUpdate(
            {
                _id: payment._id,
                companyId: new Types.ObjectId(companyId),
                status: payment.status,
            },
            {
                $set: setFields,
                $inc: { inquiryAttempts: 1 },
            },
            { new: true },
        );

        if (!updated) {

            const latest = await this.payments.findOne({
                _id: payment._id,
                companyId: new Types.ObjectId(companyId),
            });

            if (!latest) {
                throw new NotFoundException('Payment not found');
            }

            return latest.toObject();
        }

        return updated.toObject();
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

        payment.status = PaymentStatus.VOIDED;

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

        // Ayný idempotency key daha önce kullanýlmýþ mý?
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

        // Refund kaydýný oluþtur.
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

        // Ýade tutarýný atomik þekilde rezerve et.
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

            // Sonuç belirsiz. Rezervasyonu serbest býrakmýyoruz.
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

        // Provider baþarýlý dedi ama beklenmeyen sonuç döndürdü.
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

                                status: {
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

            // Provider baþarýlý olmuþ olabilir.
            // Rezervasyonu serbest býrakmýyoruz.
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

        return completedRefund;
    }


    // --------------------------------------------------
    // LIST PAYMENTS
    // --------------------------------------------------

    async listByCompany(companyId: string) {

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
                .select('status processedMqttMessageIds')
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

            const update = {
                $addToSet: {
                    processedMqttMessageIds: messageId,
                },

                ...(result === 'UPDATED' && targetStatus
                    ? { $set: { status: targetStatus } }
                    : {}),
            };

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

}
