
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RefundDocument = HydratedDocument<Refund>;

export enum RefundStatus {
    PROCESSING = 'PROCESSING',
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILED',
    UNKNOWN = 'UNKNOWN',
}

@Schema({ timestamps: true })
export class Refund {
    @Prop({
        type: Types.ObjectId,
        ref: 'Payment',
        required: true,
        index: true,
    })
    paymentId!: Types.ObjectId;

    @Prop({
        type: Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true,
    })
    companyId!: Types.ObjectId;

    @Prop({ required: true })
    idempotencyKey!: string;

    @Prop({ required: true, min: 1, validate: Number.isInteger })
    amount!: number;

    @Prop({
        required: true,
        enum: RefundStatus,
        default: RefundStatus.PROCESSING,
        index: true,
    })
    status!: RefundStatus;

    @Prop()
    providerReference?: string;

    @Prop()
    failureReason?: string;
}

export const RefundSchema = SchemaFactory.createForClass(Refund);

RefundSchema.index(
    { companyId: 1, idempotencyKey: 1 },
    { unique: true },
);
