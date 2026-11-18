
const mqtt = require('mqtt');
const readline = require('readline');
const { randomUUID } = require('crypto');

const brokerUrl = process.env.MQTT_URL || 'mqtt://localhost:1883';

const terminalId = process.argv[2];
const paymentId = process.argv[3];

if (!terminalId || !paymentId) {
    console.error(
        'Kullanim: node scripts/virtual-pos.js <terminalId> <paymentId>',
    );
    process.exit(1);
}

const clientId = `virtual-pos-${terminalId}`;
const ackTopic = `pos/payment/status/ack/${terminalId}`;
const commandTopic = 'pos/payment/command';

const messageId = randomUUID();

let client;
let connected = false;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function connectPos() {
    return new Promise((resolve, reject) => {
        console.log(`Connecting POS: ${clientId}`);

        client = mqtt.connect(brokerUrl, {
            clientId,
            clean: false,
            keepalive: 60,
            reconnectPeriod: 0,
            connectTimeout: 10000,
        });

        client.on('message', (topic, payload) => {
            console.log('\n[POS] Message received:', topic);

            let message;

            try {
                message = JSON.parse(payload.toString());
            } catch {
                console.error('[POS] Invalid JSON');
                return;
            }

            // Backend'den gelen ödeme komutu
            if (topic === commandTopic) {
                if (message.terminalId !== terminalId) {
                    return;
                }

                console.log('[POS] Payment command received:', message);

                const response = {
                    messageId: message.messageId,
                    paymentId: message.paymentId,
                    terminalId: message.terminalId,
                    status: 'SUCCESS',
                };

                setTimeout(() => {
                    client.publish(
                        'pos/payment/status',
                        JSON.stringify(response),
                        { qos: 1, retain: false },
                        (error) => {
                            if (error) {
                                console.error('[POS] Payment response failed:', error.message);
                                return;
                            }

                            console.log('[POS] Payment response published:', response);
                        },
                    );
                }, 1500);

                return;
            }

            // Backend'den gelen uygulama ACK'i
            if (topic === ackTopic) {
                console.log('[POS] Application ACK received:', message);
            }
        });

        client.once('error', (error) => {
            console.error('[POS] MQTT error:', error.message);
            reject(error);
        });

        client.once('connect', (packet) => {
            connected = true;

            console.log('[POS] Connected to MQTT broker');
            console.log('[POS] Existing session:', packet.sessionPresent);

            // Eski oturum olsa bile iki kanala da abone ol.
            client.subscribe(
                [ackTopic, commandTopic],
                { qos: 1 },
                (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    console.log('[POS] Subscribed:', ackTopic);
                    console.log('[POS] Subscribed:', commandTopic);
                    resolve();
                },
            );
        });


        client.on('close', () => {
            connected = false;
            console.log('[POS] Connection closed');
        });
    });
}

function publishPaymentStatus() {
    if (!connected) {
        console.log('[POS] Not connected. Cannot publish.');
        return;
    }

    const message = {
        messageId,
        paymentId,
        terminalId,
        status: 'SUCCESS',
    };

    client.publish(
        'pos/payment/status',
        JSON.stringify(message),
        { qos: 1, retain: false },
        (error) => {
            if (error) {
                console.error('[POS] Publish failed:', error.message);
                return;
            }

            console.log('[POS] Status published');
            console.log('[POS] Message ID:', messageId);
        },
    );
}

function disconnectPos() {
    if (!client || !connected) {
        console.log('[POS] Already disconnected');
        return;
    }

    console.log('[POS] Disconnecting...');

    client.end(false, {}, () => {
        connected = false;
        console.log('[POS] Disconnected. Session is preserved.');
    });
}

async function handleCommand(command) {
    switch (command.trim().toLowerCase()) {
        case 'publish':
            publishPaymentStatus();
            break;

        case 'disconnect':
            disconnectPos();
            break;

        case 'reconnect':
            if (connected) {
                console.log('[POS] Already connected');
                break;
            }

            try {
                await connectPos();
            } catch (error) {
                console.error('[POS] Reconnect failed:', error.message);
            }
            break;

        case 'exit':
            if (client) {
                client.end(true);
            }

            rl.close();
            process.exit(0);
            break;

        default:
            console.log('Commands: publish, disconnect, reconnect, exit');
    }
}

async function main() {
    try {
        await connectPos();

        console.log('\nAvailable commands:');
        console.log('publish     - Send payment status');
        console.log('disconnect  - Disconnect POS');
        console.log('reconnect   - Reconnect POS');
        console.log('exit        - Exit simulator\n');

        rl.on('line', handleCommand);
    } catch (error) {
        console.error('[POS] Startup failed:', error.message);
        process.exit(1);
    }
}

main();
