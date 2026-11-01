import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { RedisService } from '../common/redis.module';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { Payment, PaymentDocument, PaymentStatus } from './payment.schema';
import { MockProviderService } from './providers/mock-provider.service';

@Injectable()
export class PaymentsService {
  constructor(@InjectModel(Payment.name) private readonly payments: Model<PaymentDocument>, private readonly provider: MockProviderService, private readonly redis: RedisService) {}

  async create(dto: CreatePaymentDto, idempotencyKey: string) {
    if (!idempotencyKey || idempotencyKey.length > 128) throw new BadRequestException('A valid Idempotency-Key header is required');
    const fingerprint = `${dto.companyId}:${dto.terminalId}:${dto.amount}:${dto.currency}:${dto.merchantReference}`;
    const reservation = await this.redis.reserveIdempotency(idempotencyKey, fingerprint, 86400);
    if (reservation === 'CONFLICT') throw new ConflictException('Idempotency key was already used with a different request');
    if (reservation === 'EXISTS') {
      const existing = await this.payments.findOne({ merchantReference: dto.merchantReference }).lean();
      if (existing) return existing;
      throw new ConflictException('Request with this idempotency key is already being processed');
    }
    if (reservation === 'UNAVAILABLE') throw new ServiceUnavailableException('Idempotency store unavailable; retry safely with the same key');

    const existingReference = await this.payments.findOne({ merchantReference: dto.merchantReference }).lean();
    if (existingReference) throw new ConflictException('merchantReference already exists');
    const payment = await this.payments.create({ ...dto, companyId: new Types.ObjectId(dto.companyId), terminalId: new Types.ObjectId(dto.terminalId), status: PaymentStatus.PENDING });
    const result = await this.provider.sale({ merchantReference: dto.merchantReference, amount: dto.amount, scenario: dto.scenario });
    payment.status = result.status as PaymentStatus;
    payment.providerReference = result.providerReference;
    payment.failureReason = result.reason;
    await payment.save();
    return payment.toObject();
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Payment not found');
    const payment = await this.payments.findById(id).lean();
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async inquiry(id: string) {
    const payment = await this.payments.findById(id);
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== PaymentStatus.UNKNOWN && payment.status !== PaymentStatus.PENDING) return payment.toObject();
    const result = await this.provider.inquiry(payment.merchantReference);
    payment.inquiryAttempts += 1;
    payment.lastInquiryAt = new Date();
    if (result.status !== 'UNKNOWN') payment.status = result.status as PaymentStatus;
    if (result.providerReference) payment.providerReference = result.providerReference;
    payment.failureReason = result.reason;
    await payment.save();
    return payment.toObject();
  }

  async void(id: string) {
    const payment = await this.payments.findById(id);
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== PaymentStatus.PENDING) throw new ConflictException('Only pending/authorized payments can be voided in this simulator');
    if (!payment.providerReference) throw new ConflictException('Provider reference is missing');
    const result = await this.provider.void(payment.providerReference);
    if (!result.success) throw new ConflictException('Provider rejected void');
    payment.status = PaymentStatus.VOIDED;
    await payment.save();
    return payment.toObject();
  }

  async refund(id: string, amount: number) {
    const payment = await this.payments.findById(id);
    if (!payment) throw new NotFoundException('Payment not found');
    if (![PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED].includes(payment.status)) throw new ConflictException('Only captured successful payments can be refunded');
    const remaining = payment.amount - payment.refundedAmount;
    if (amount > remaining) throw new BadRequestException(`Refund exceeds remaining refundable amount: ${remaining}`);
    if (!payment.providerReference) throw new ConflictException('Provider reference is missing');
    const result = await this.provider.refund(payment.providerReference, amount);
    if (!result.success) throw new ConflictException('Provider rejected refund');
    // Atomic conditional update prevents cumulative refunds exceeding captured amount.
    const updated = await this.payments.findOneAndUpdate(
      { _id: payment._id, refundedAmount: payment.refundedAmount, amount: { $gte: payment.refundedAmount + amount }, status: { $in: [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED] } },
      [{ $set: { refundedAmount: { $add: ['$refundedAmount', amount] }, status: { $cond: [{ $eq: [{ $add: ['$refundedAmount', amount] }, '$amount'] }, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] } } }],
      { new: true },
    );
    if (!updated) throw new ConflictException('Payment changed concurrently; reconcile provider refund before retrying');
    return updated.toObject();
  }

  async listByCompany(companyId: string) {
    if (!Types.ObjectId.isValid(companyId)) throw new BadRequestException('Invalid companyId');
    return this.payments.find({ companyId: new Types.ObjectId(companyId) }).sort({ createdAt: -1 }).limit(100).lean();
  }
}
