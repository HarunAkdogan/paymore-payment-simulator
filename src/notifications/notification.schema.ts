
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NotificationDocument =
    HydratedDocument<Notification>;

@Schema({ timestamps: true })
export class Notification {
    @Prop({ required: true, unique: true })
    eventId!: string;

    @Prop({ required: true })
    paymentId!: string;

    @Prop({ required: true })
    companyId!: string;

    @Prop({ required: true })
    merchantReference!: string;

    @Prop({ required: true })
    amount!: number;

    @Prop({ required: true })
    currency!: string;

    @Prop({ required: true })
    status!: string;
}

export const NotificationSchema =
    SchemaFactory.createForClass(Notification);
