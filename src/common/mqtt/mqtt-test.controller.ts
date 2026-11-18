import { Body, Controller, Post } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { PublishPaymentCommandDto } from './dto/publish-payment-command.dto';

@Controller('test/mqtt')
export class MqttTestController {
    constructor(private readonly mqttService: MqttService) { }

    @Post('payment-command')
    async publishPaymentCommand(
        @Body() body: PublishPaymentCommandDto,
    ) {
        console.log('Received body:', body);

        await this.mqttService.publishPaymentCommand(body);

        return {
            success: true,
            message: 'Payment command published',
            messageId: body.messageId,
        };
    }
}