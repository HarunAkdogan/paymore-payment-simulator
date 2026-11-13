
import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { RedisService } from '../common/redis.module';
import { Terminal, TerminalDocument } from '../terminals/terminal.schema';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { Payment, PaymentDocument, PaymentStatus } from './payment.schema';
import { MockProviderService } from './providers/mock-provider.service';

@Injectable()
export class PaymentsService {
    constructor(
        @InjectModel(Payment.name)
        private readonly payments: Model<PaymentDocument>,

        @InjectModel(Terminal.name)
        private readonly terminals: Model<TerminalDocument>,

        private readonly provider: MockProviderService,
        private readonly redis: RedisService,
    ) { }

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
            throw new BadRequestException('Invalid companyId or terminalId');
        }

        // Terminal bu þirkete ait mi ve aktif mi?
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
            const existing = await this.payments
                .findOne({
                    companyId: new Types.ObjectId(dto.companyId),
                    merchantReference: dto.merchantReference,
                })
                .lean();

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

        const existingReference = await this.payments
            .findOne({
                companyId: new Types.ObjectId(dto.companyId),
                merchantReference: dto.merchantReference,
            })
            .lean();

        if (existingReference) {
            throw new ConflictException('merchantReference already exists');
        }

        const payment = await this.payments.create({
            ...dto,
            companyId: new Types.ObjectId(dto.companyId),
            terminalId: new Types.ObjectId(dto.terminalId),
            status: PaymentStatus.PENDING,
        });

        const result = await this.provider.sale({
            companyId: dto.companyId,
            merchantReference: dto.merchantReference,
            amount: dto.amount,
            scenario: dto.scenario,
        });

        payment.status = result.status as PaymentStatus;
        payment.providerReference = result.providerReference;
        payment.failureReason = result.reason;

        await payment.save();

        return payment.toObject();
    }

    async findOne(id: string, companyId: string) {
        if (
            !Types.ObjectId.isValid(id) ||
            !Types.ObjectId.isValid(companyId)
        ) {
            throw new NotFoundException('Payment not found');
        }

        const payment = await this.payments
            .findOne({
                _id: id,
                companyId: new Types.ObjectId(companyId),
            })
            .lean();

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        return payment;
    }

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

        payment.inquiryAttempts += 1;
        payment.lastInquiryAt = new Date();

        if (result.status !== 'UNKNOWN') {
            payment.status = result.status as PaymentStatus;
        }

        if (result.providerReference) {
            payment.providerReference = result.providerReference;
        }

        payment.failureReason = result.reason;

        await payment.save();

        return payment.toObject();
    }

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
            throw new ConflictException('Provider reference is missing');
        }

        const result = await this.provider.void(
            payment.providerReference,
        );

        if (!result.success) {
            throw new ConflictException('Provider rejected void');
        }

        payment.status = PaymentStatus.VOIDED;

        await payment.save();

        return payment.toObject();
    }

    async refund(id: string, companyId: string, amount: number) {
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
            ![
                PaymentStatus.SUCCESS,
                PaymentStatus.PARTIALLY_REFUNDED,
            ].includes(payment.status)
        ) {
            throw new ConflictException(
                'Only successful payments can be refunded',
            );
        }

        const remaining = payment.amount - payment.refundedAmount;

        if (amount > remaining) {
            throw new BadRequestException(
                `Refund exceeds remaining amount: ${remaining}`,
            );
        }

        if (!payment.providerReference) {
            throw new ConflictException('Provider reference is missing');
        }

        const result = await this.provider.refund(
            payment.providerReference,
            amount,
        );

        if (!result.success) {
            throw new ConflictException('Provider rejected refund');
        }

        const updated = await this.payments.findOneAndUpdate(
            {
                _id: payment._id,
                companyId: new Types.ObjectId(companyId),
                refundedAmount: payment.refundedAmount,
                amount: { $gte: payment.refundedAmount + amount },
                status: {
                    $in: [
                        PaymentStatus.SUCCESS,
                        PaymentStatus.PARTIALLY_REFUNDED,
                    ],
                },
            },
            [
                {
                    $set: {
                        refundedAmount: {
                            $add: ['$refundedAmount', amount],
                        },
                        status: {
                            $cond: [
                                {
                                    $eq: [
                                        { $add: ['$refundedAmount', amount] },
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
            { new: true },
        );

        if (!updated) {
            throw new ConflictException(
                'Payment changed concurrently; provider refund requires reconciliation',
            );
        }

        return updated.toObject();
    }

    async listByCompany(companyId: string) {
        if (!Types.ObjectId.isValid(companyId)) {
            throw new BadRequestException('Invalid companyId');
        }

        return this.payments
            .find({ companyId: new Types.ObjectId(companyId) })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
    }


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
            throw new BadRequestException('Invalid paymentId or terminalId');
        }

        if (
            !messageId ||
            messageId.trim().length === 0 ||
            messageId.length > 128
        ) {
            throw new BadRequestException('Invalid messageId');
        }

        // Provider durumlarýný uygulamanýn PaymentStatus deðerlerine dönüþtür.
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

            let result: 'UPDATED' | 'DUPLICATE' | 'IGNORED' | 'CONFLICT';

            if (incomingStatus === 'PENDING') {
                if (current.status === PaymentStatus.PENDING) {
                    result = 'DUPLICATE';
                } else if (current.status === PaymentStatus.CREATED) {
                    result = 'UPDATED';
                } else {
                    // PENDING mesajý mevcut UNKNOWN veya kesin sonucu geriye almaz.
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
