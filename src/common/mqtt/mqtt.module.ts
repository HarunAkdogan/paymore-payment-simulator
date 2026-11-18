
import { Global, Module } from '@nestjs/common';
import { PaymentsModule } from '../../payments/payments.module';
import { MqttService } from './mqtt.service';
import { MqttTestController } from './mqtt-test.controller';

@Global()
@Module({
    imports: [PaymentsModule],
    controllers: [MqttTestController],
    providers: [MqttService],
    exports: [MqttService],
})
export class MqttModule { }
