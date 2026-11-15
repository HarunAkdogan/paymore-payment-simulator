
import {
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    PaymentCompletedEvent,
    RabbitMqService,
} from '../common/rabbitmq/rabbitmq.service';

import {
    Notification,
    NotificationDocument,
} from './notification.schema';

@Injectable()
export class NotificationService implements OnModuleInit {
    private readonly logger =
        new Logger(NotificationService.name);

    constructor(
        private readonly rabbitMq: RabbitMqService,

        @InjectModel(Notification.name)
        private readonly notifications: Model<NotificationDocument>,
    ) { }

    async onModuleInit(): Promise<void> {
        await this.rabbitMq.consumePaymentCompleted(
            (event) => this.handlePaymentCompleted(event),
        );
    }

    private async handlePaymentCompleted(
        event: PaymentCompletedEvent,
    ): Promise<void> {


        try {

            await this.notifications.create({
                eventId: event.eventId,
                paymentId: event.paymentId,
                companyId: event.companyId,
                merchantReference: event.merchantReference,
                amount: event.amount,
                currency: event.currency,
                status: 'CREATED',
            });

            this.logger.log(
                `Notification created for payment ${event.paymentId}`,
            );
        } catch (error) {
            // MongoDB duplicate key: Bu event daha önce iþlendi.
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 11000
            ) {
                this.logger.warn(
                    `Duplicate event ignored: ${event.eventId}`,
                );

                return;
            }

            throw error;
        }
    }
}
