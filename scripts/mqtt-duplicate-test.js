
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', () => {
    const payload = {
        messageId: 'mqtt-test-002',
        paymentId: '6afac0f1478b328ba6ca9fb6',
        terminalId: '6af71344b0c3506be0852853',
        status: 'SUCCESS',
    };

    client.publish(
        'pos/payment/status',
        JSON.stringify(payload),
        { qos: 1 },
        (error) => {
            if (error) {
                console.error('Publish error:', error);
            } else {
                console.log('Duplicate test message published');
            }

            client.end();
        },
    );
});
