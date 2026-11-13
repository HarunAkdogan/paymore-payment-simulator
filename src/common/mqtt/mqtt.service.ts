import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, MqttClient } from 'mqtt';
import { PaymentsService } from '../../payments/payments.service';

type PaymentStatusMessage = {
    messageId: string;
    paymentId: string;
    terminalId: string;
    status: 'SUCCESS' | 'DECLINED' | 'PENDING' | 'TIMEOUT';
};

type MqttProcessingResult =
    | 'UPDATED'
    | 'DUPLICATE'
    | 'IGNORED'
    | 'CONFLICT';


function isPaymentStatusMessage(
    data: unknown,
): data is PaymentStatusMessage {
    if (typeof data !== 'object' || data === null) {
        return false;
    }

    const message = data as Record<string, unknown>;

    const validStatuses: PaymentStatusMessage['status'][] = [
        'SUCCESS',
        'DECLINED',
        'PENDING',
        'TIMEOUT',
    ];

    return (
        typeof message.messageId === 'string' &&
        message.messageId.trim().length > 0 &&
        message.messageId.length <= 128 &&
        typeof message.paymentId === 'string' &&
        typeof message.terminalId === 'string' &&
        typeof message.status === 'string' &&
        validStatuses.includes(
            message.status as PaymentStatusMessage['status'],
        )
    );
}


@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(MqttService.name);
    private client!: MqttClient;

    constructor(
        private readonly configService: ConfigService,
        private readonly paymentsService: PaymentsService,
    ) { }

    async onModuleInit(): Promise<void> {
        const brokerUrl = this.configService.get<string>(
            'MQTT_URL',
            'mqtt://localhost:1883',
        );

        const clientId = this.configService.get<string>(
            'MQTT_CLIENT_ID',
            'paymore-backend',
        );

        this.client = connect(brokerUrl, {
            clientId,
            clean: false,
            keepalive: 60,
            reconnectPeriod: 3000,
            connectTimeout: 30000,
        });

        this.client.on('connect', () => {
            this.logger.log('Connected to MQTT broker');

            this.client.subscribe(
                'pos/payment/status',
                { qos: 1 },
                (error) => {
                    if (error) {
                        this.logger.error(
                            `MQTT subscribe error: ${error.message}`,
                        );
                        return;
                    }

                    this.logger.log(
                        'Subscribed to pos/payment/status with QoS 1',
                    );
                },
            );
        });

        this.client.on('message', async (topic, payload) => {
            if (topic !== 'pos/payment/status') {
                return;
            }

            const rawMessage = payload.toString();

            let data: unknown;

            try {
                data = JSON.parse(rawMessage);
            } catch {
                this.logger.warn('Received invalid MQTT JSON');
                return;
            }

            if (!isPaymentStatusMessage(data)) {
                this.logger.warn('Received invalid payment status message');
                return;
            }

            try {
                const result = await this.paymentsService.applyMqttStatus(
                    data.paymentId,
                    data.terminalId,
                    data.messageId,
                    data.status,
                );

                this.logger.log(
                    `MQTT ${result}: messageId=${data.messageId}, paymentId=${data.paymentId}`,
                );

                await this.publishApplicationAck(data, result);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : 'Unknown error';

                this.logger.error(
                    `MQTT processing failed: messageId=${data.messageId}, error=${message}`,
                );

                // Bilerek uygulama ACK'i göndermiyoruz.
                // POS ayný messageId ile tekrar göndermeli.
            }
        });

        this.client.on('error', (error) => {
            this.logger.error(`MQTT connection error: ${error.message}`);
        });

        this.client.on('offline', () => {
            this.logger.warn('MQTT client is offline');
        });

        this.client.on('reconnect', () => {
            this.logger.warn('Reconnecting to MQTT broker');
        });
    }

    private async publishApplicationAck(
        message: PaymentStatusMessage,
        result: MqttProcessingResult,
    ): Promise<void> {
        const ackTopic = `pos/payment/status/ack/${message.terminalId}`;

        const ackResult = {
            messageId: message.messageId,
            paymentId: message.paymentId,
            terminalId: message.terminalId,
            result: this.mapAckResult(result),
            acknowledgedAt: new Date().toISOString(),
        };

        await new Promise<void>((resolve, reject) => {
            this.client.publish(
                ackTopic,
                JSON.stringify(ackResult),
                { qos: 1, retain: false },
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
            `Application ACK published: ${message.messageId}`,
        );
    }

    private mapAckResult(
        result: MqttProcessingResult,
    ): 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'RECONCILE' {
        switch (result) {
            case 'UPDATED':
                return 'PROCESSED';
            case 'DUPLICATE':
                return 'DUPLICATE';
            case 'IGNORED':
                return 'IGNORED';
            case 'CONFLICT':
                return 'RECONCILE';
        }
    }

    async onModuleDestroy(): Promise<void> {
        if (!this.client) {
            return;
        }

        await new Promise<void>((resolve) => {
            this.client.end(false, {}, () => {
                this.logger.log('MQTT connection closed');
                resolve();
            });
        });
    }
}