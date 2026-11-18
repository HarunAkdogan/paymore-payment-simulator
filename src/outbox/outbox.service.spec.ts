
import { OutboxService } from './outbox.service';
import { OutboxEventStatus } from './outbox.schema';

describe('OutboxService', () => {
    let service: OutboxService;

    const event: any = {
        _id: 'outbox-id-001',
        eventId: 'event-001',
        eventType: 'payment.completed',
        aggregateId: 'payment-001',
        payload: {
            paymentId: 'payment-001',
            status: 'SUCCESS',
        },
        status: OutboxEventStatus.PROCESSING,
        attempts: 1,
    };

    const outbox: any = {
        findOneAndUpdate: jest.fn(),
        updateOne: jest.fn(),
        updateMany: jest.fn(),
    };

    const rabbitMq: any = {
        publishPaymentCompleted: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();

        service = new OutboxService(outbox, rabbitMq);

        outbox.updateMany.mockResolvedValue({ modifiedCount: 0 });
        outbox.updateOne.mockResolvedValue({ modifiedCount: 1 });

        outbox.findOneAndUpdate.mockReturnValue({
            exec: jest.fn().mockResolvedValue(event),
        });

        rabbitMq.publishPaymentCompleted.mockResolvedValue(undefined);
    });

    it('bekleyen event bulunamazsa iþlem yapmamalý', async () => {
        outbox.findOneAndUpdate.mockReturnValue({
            exec: jest.fn().mockResolvedValue(null),
        });

        await service.processPendingEvent();

        expect(rabbitMq.publishPaymentCompleted).not.toHaveBeenCalled();
        expect(outbox.updateOne).not.toHaveBeenCalled();
    });

    it('event RabbitMQya baþarýyla gönderilirse PROCESSED olmalý', async () => {
        await service.processPendingEvent();

        expect(rabbitMq.publishPaymentCompleted)
            .toHaveBeenCalledWith(event.payload);

        expect(outbox.updateOne).toHaveBeenCalledWith(
            { _id: event._id },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: OutboxEventStatus.PROCESSED,
                    processedAt: expect.any(Date),
                }),
            }),
        );
    });

    it('RabbitMQ gönderimi baþarýsýzsa event tekrar denenmek üzere PENDING olmalý', async () => {
        rabbitMq.publishPaymentCompleted.mockRejectedValueOnce(
            new Error('RabbitMQ connection failed'),
        );

        await service.processPendingEvent();

        expect(outbox.updateOne).toHaveBeenCalledWith(
            { _id: event._id },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: OutboxEventStatus.PENDING,
                    lastError: 'RabbitMQ connection failed',
                    nextAttemptAt: expect.any(Date),
                }),
            }),
        );
    });

    it('maksimum deneme sayýsýna ulaþýlmýþsa event FAILED olmalý', async () => {
        const failedEvent = {
            ...event,
            attempts: 5,
        };

        outbox.findOneAndUpdate.mockReturnValue({
            exec: jest.fn().mockResolvedValue(failedEvent),
        });

        rabbitMq.publishPaymentCompleted.mockRejectedValueOnce(
            new Error('RabbitMQ unavailable'),
        );

        await service.processPendingEvent();

        expect(outbox.updateOne).toHaveBeenCalledWith(
            { _id: failedEvent._id },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: OutboxEventStatus.FAILED,
                    lastError: 'RabbitMQ unavailable',
                }),
            }),
        );
    });

    it('event claim edilirken PROCESSING durumuna alýnmalý ve attempts artýrýlmalý', async () => {
        await service.claimEvent();

        expect(outbox.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                attempts: { $lt: 5 },
                $or: expect.any(Array),
            }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: OutboxEventStatus.PROCESSING,
                    lockedAt: expect.any(Date),
                }),
                $inc: { attempts: 1 },
            }),
            {
                sort: { createdAt: 1 },
                new: true,
            },
        );
    });
});
