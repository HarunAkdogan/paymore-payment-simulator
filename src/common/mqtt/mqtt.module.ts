import { Global, Module } from '@nestjs/common';
import { PaymentsModule } from '../../payments/payments.module';
import { MqttService } from './mqtt.service';

@Global()
@Module({
    imports: [PaymentsModule],
    providers: [MqttService],
    exports: [MqttService],
})
export class MqttModule { }