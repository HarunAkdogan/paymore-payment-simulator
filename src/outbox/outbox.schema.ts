import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
    HydratedDocument,
    Schema as MongooseSchema,
    Types,
} from 'mongoose';

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;

export enum OutboxEventStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    PROCESSED = 'PROCESSED',
    FAILED = 'FAILED',
}

@Schema({
    timestamps: true,
    collection: 'outbox_events',
})
export class OutboxEvent {

    _id: Types.ObjectId;

    @Prop({ required: true, unique: true })
    eventId: string;

    @Prop({ required: true })
    eventType: string;

    @Prop({ required: true })
    aggregateId: string;

    @Prop({ type: MongooseSchema.Types.Mixed, required: true })
    payload: Record<string, any>;

    @Prop({
        type: String,
        enum: OutboxEventStatus,
        default: OutboxEventStatus.PENDING,
    })
    status: OutboxEventStatus;

    @Prop({ default: 0 })
    attempts: number;

    @Prop({ default: Date.now })
    nextAttemptAt: Date;

    @Prop()
    processedAt?: Date;

    @Prop()
    lastError?: string;

    @Prop()
    lockedAt?: Date;
}

export const OutboxEventSchema =
    SchemaFactory.createForClass(OutboxEvent);

OutboxEventSchema.index({ status: 1, nextAttemptAt: 1 });