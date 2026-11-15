
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Interval } from '@nestjs/schedule';

import {
    OutboxEvent,
    OutboxEventStatus,
} from './outbox.schema';

import { RabbitMqService } from '../common/rabbitmq/rabbitmq.service';

@Injectable()
export class OutboxService {
    private readonly logger = new Logger(OutboxService.name);

    private readonly maxAttempts = 5;
    private readonly lockTimeoutMs = 60_000;

    private readonly retryDelays = [
        5000,
        15000,
        30000,
        60000,
        120000,
    ];

    constructor(
        @InjectModel(OutboxEvent.name)
        private readonly outbox: Model<OutboxEvent>,

        private readonly rabbitMq: RabbitMqService,
    ) { }

    async claimEvent(): Promise<OutboxEvent | null> {
        const now = new Date();
        const staleLockTime = new Date(
            now.getTime() - this.lockTimeoutMs,
        );

        return this.outbox.findOneAndUpdate(
            {
                attempts: { $lt: this.maxAttempts },
                $or: [
                    {
                        status: OutboxEventStatus.PENDING,
                        nextAttemptAt: { $lte: now },
                    },
                    {
                        status: OutboxEventStatus.PROCESSING,
                        lockedAt: { $lte: staleLockTime },
                    },
                ],
            },
            {
                $set: {
                    status: OutboxEventStatus.PROCESSING,
                    lockedAt: now,
                },
                $inc: {
                    attempts: 1,
                },
            },
            {
                sort: { createdAt: 1 },
                new: true,
            },
        ).exec();
    }

    @Interval(5000)
    async processPendingEvent(): Promise<void> {
        this.logger.log('Outbox worker tick');

        const staleLockTime = new Date(
            Date.now() - this.lockTimeoutMs,
        );

        // Maksimum denemeye ulaþmýþ ve takýlý kalmýþ kayýtlarý kapat.
        await this.outbox.updateMany(
            {
                status: OutboxEventStatus.PROCESSING,
                lockedAt: { $lte: staleLockTime },
                attempts: { $gte: this.maxAttempts },
            },
            {
                $set: {
                    status: OutboxEventStatus.FAILED,
                    lastError: 'Maximum attempts reached after stale lock',
                },
                $unset: {
                    lockedAt: 1,
                },
            },
        );

        const event = await this.claimEvent();

        if (!event) {
            return;
        }

        try {
            await this.rabbitMq.publishPaymentCompleted(
                event.payload as any,
            );

            await this.outbox.updateOne(
                { _id: event._id },
                {
                    $set: {
                        status: OutboxEventStatus.PROCESSED,
                        processedAt: new Date(),
                    },
                    $unset: {
                        lockedAt: 1,
                        lastError: 1,
                    },
                },
            );

            this.logger.log(
                `Outbox event processed: ${event.eventId}`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Unknown error';

            const failed = event.attempts >= this.maxAttempts;

            await this.outbox.updateOne(
                { _id: event._id },
                {
                    $set: {
                        status: failed
                            ? OutboxEventStatus.FAILED
                            : OutboxEventStatus.PENDING,
                        nextAttemptAt: failed
                            ? new Date()
                            : new Date(
                                Date.now() +
                                this.retryDelays[event.attempts - 1],
                            ),
                        lastError: message,
                    },
                    $unset: {
                        lockedAt: 1,
                    },
                },
            );

            this.logger.error(
                `Outbox event failed: ${event.eventId}. ${message}`,
            );
        }
    }
}
