import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PaymentDocument = HydratedDocument<Payment>;
export enum PaymentStatus { CREATED='CREATED', PENDING='PENDING', SUCCESS='SUCCESS', FAILED='FAILED', UNKNOWN='UNKNOWN', VOIDED='VOIDED', PARTIALLY_REFUNDED='PARTIALLY_REFUNDED', REFUNDED='REFUNDED' }
@Schema({ timestamps: true })
export class Payment {
    @Prop({ type: [String], default: [] })
    processedMqttMessageIds!: string[];
  @Prop({ type: Types.ObjectId, ref: 'Company', required: true, index: true }) companyId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Terminal', required: true, index: true }) terminalId!: Types.ObjectId;
    @Prop({ required: true })
    merchantReference!: string;
    @Prop({ required: true, min: 1, validate: Number.isInteger })
    amount!: number; // minor units: 100 = 1.00 TRY
  @Prop({ required: true, default: 'TRY' }) currency!: string;
  @Prop({ enum: PaymentStatus, default: PaymentStatus.CREATED, index: true }) status!: PaymentStatus;
  @Prop() providerReference?: string;
  @Prop({ default: 0, min: 0 }) refundedAmount!: number;
  @Prop() failureReason?: string;
  @Prop({ default: 0 }) inquiryAttempts!: number;
  @Prop() lastInquiryAt?: Date;
}
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ companyId: 1, createdAt: -1 });
PaymentSchema.index({ terminalId: 1, status: 1, createdAt: -1 });
PaymentSchema.index(
    { companyId: 1, merchantReference: 1 },
    { unique: true }
);
