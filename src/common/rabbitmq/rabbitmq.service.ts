
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type {
    ChannelModel,
    ConfirmChannel,
    ConsumeMessage,
} from 'amqplib';

export interface PaymentCompletedEvent {
    eventId: string;
    paymentId: string;
    companyId: string;
    terminalId: string;
    merchantReference: string;
    amount: number;
    currency: string;
    occurredAt: string;
}

@Injectable()
export class RabbitMqService
    implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RabbitMqService.name);

    private connection?: ChannelModel;
    private channel?: ConfirmChannel;

    constructor(private readonly config: ConfigService) { }

    async onModuleInit(): Promise<void> {
        const url = this.config.get<string>(
            'RABBITMQ_URL',
            'amqp://localhost:5672',
        );

        this.connection = await amqp.connect(url);
        this.channel = await this.connection.createConfirmChannel();

        await this.channel.assertExchange(
            'payments.events',
            'topic',
            { durable: true },
        );

        this.logger.log('Connected to RabbitMQ');
    }


    async consumePaymentCompleted(
        handler: (event: PaymentCompletedEvent) => Promise<void>,
    ): Promise<void> {
        if (!this.channel) {
            throw new Error('RabbitMQ channel is not available');
        }

        const queue = 'notifications.payment-completed';

        // Retry mesajlarý için exchange
        await this.channel.assertExchange(
            'payments.retry',
            'direct',
            { durable: true },
        );

        // Baþarýsýz mesajlar için exchange
        await this.channel.assertExchange(
            'payments.dlx',
            'direct',
            { durable: true },
        );

        // Dead Letter Queue
        const deadLetterQueue = 'notifications.payment-completed.dlq';

        await this.channel.assertQueue(deadLetterQueue, {
            durable: true,
        });

        await this.channel.bindQueue(
            deadLetterQueue,
            'payments.dlx',
            'payment.failed',
        );

        // Retry kuyruklarý
        const retryDelays = [5000, 15000, 30000];

        for (const delay of retryDelays) {
            const retryQueue = `notifications.payment-completed.retry.${delay}`;

            await this.channel.assertQueue(retryQueue, {
                durable: true,
                arguments: {
                    'x-message-ttl': delay,
                    'x-dead-letter-exchange': 'payments.events',
                    'x-dead-letter-routing-key': 'payment.completed',
                },
            });

            await this.channel.bindQueue(
                retryQueue,
                'payments.retry',
                `retry.${delay}`,
            );
        }


        await this.channel.assertQueue(queue, {
            durable: true,
        });

        await this.channel.bindQueue(
            queue,
            'payments.events',
            'payment.completed',
        );

        await this.channel.prefetch(1);

        await this.channel.consume(
            queue,
            async (message: ConsumeMessage | null) => {
                if (!message) {
                    return;
                }

                try {
                    const event = JSON.parse(
                        message.content.toString(),
                    ) as PaymentCompletedEvent;

                    await handler(event);

                    // Ýþlem baþarýlýysa mesajý ACK et.
                    this.channel!.ack(message);
                } catch (error) {
                    const reason =
                        error instanceof Error ? error.message : 'Unknown error';

                    this.logger.error(
                        `Notification consumer failed: ${reason}`,
                    );

                    try {
                        await this.routeFailedMessage(message);

                        // Yeni kuyruða gönderim onaylandýktan sonra
                        // orijinal mesajý ACK ediyoruz.
                        this.channel!.ack(message);
                    } catch (retryError) {
                        const retryReason =
                            retryError instanceof Error
                                ? retryError.message
                                : 'Unknown retry error';

                        this.logger.error(
                            `Failed to route message: ${retryReason}`,
                        );

                        // Yönlendirme baþarýsýzsa orijinal mesajý kaybetme.
                        this.channel!.nack(message, false, true);
                    }
                } noAck: false },
        );

        this.logger.log(`Consuming queue: ${queue}`);
    }


    async publishPaymentCompleted(
        event: PaymentCompletedEvent,
    ): Promise<void> {
        if (!this.channel) {
            throw new ServiceUnavailableException(
                'RabbitMQ channel is not available',
            );
        }

        const message = Buffer.from(JSON.stringify(event));

        await new Promise<void>((resolve, reject) => {
            this.channel!.publish(
                'payments.events',
                'payment.completed',
                message,
                {
                    persistent: true,
                    contentType: 'application/json',
                    messageId: event.eventId,
                    timestamp: Date.now(),
                },
                (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                },
            );
        });

        this.logger.log(
            `PaymentCompleted published: ${event.eventId}`,
        );
    }

    private async routeFailedMessage(
        message: ConsumeMessage,
    ): Promise<void> {
        if (!this.channel) {
            throw new Error('RabbitMQ channel is not available');
        }

        const headers = message.properties.headers ?? {};
        const retryCount = Number(headers['x-retry-count'] ?? 0);

        const retryDelays = [5000, 15000, 30000];

        const nextRetryCount = retryCount + 1;

        const options = {
            persistent: true,
            contentType: message.properties.contentType,
            messageId: message.properties.messageId,
            headers: {
                ...headers,
                'x-retry-count': nextRetryCount,
            },
        };

        if (retryCount < retryDelays.length) {
            const delay = retryDelays[retryCount];

            await new Promise<void>((resolve, reject) => {
                this.channel!.publish(
                    'payments.retry',
                    `retry.${delay}`,
                    message.content,
                    options,
                    (error) => {
                        if (error) reject(error);
                        else resolve();
                    },
                );
            });

            this.logger.warn(
                `Message scheduled for retry ${nextRetryCount} after ${delay}ms`,
            );
        } else {
            await new Promise<void>((resolve, reject) => {
                this.channel!.publish(
                    'payments.dlx',
                    'payment.failed',
                    message.content,
                    options,
                    (error) => {
                        if (error) reject(error);
                        else resolve();
                    },
                );
            });

            this.logger.error(
                `Message moved to DLQ after ${retryCount} retries`,
            );
        }
    }

    async onModuleDestroy(): Promise<void> {
        await this.channel?.close();
        await this.connection?.close();
    }
}
