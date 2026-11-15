
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
    OutboxEvent,
    OutboxEventSchema,
} from './outbox.schema';

import { OutboxService } from './outbox.service';
import { RabbitMqModule } from '../common/rabbitmq/rabbitmq.module';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: OutboxEvent.name,
                schema: OutboxEventSchema,
            },
        ]),
        RabbitMqModule,
    ],
    providers: [OutboxService],
    exports: [OutboxService, MongooseModule],
})
export class OutboxModule { }
