const crypto = require('crypto');

// PayMongo signs webhook payloads via the `Paymongo-Signature` header, formatted as
// `t=<unix timestamp>,te=<test-mode hmac>,li=<live-mode hmac>`. The signed payload is
// `${timestamp}.${rawBody}`, HMAC-SHA256'd with the webhook's signing secret (shown once
// when the webhook is created in the PayMongo dashboard/API).
// Docs: https://developers.paymongo.com/docs/webhooks#section-verifying-webhook-signature
function parseSignatureHeader(header) {
    const parts = String(header || '').split(',').reduce((acc, part) => {
        const [key, value] = part.split('=');
        if (key && value) acc[key.trim()] = value.trim();
        return acc;
    }, {});
    return parts;
}

function verifyPaymongoWebhookSignature(req, res, next) {
    const secret = process.env.PAYMONGO_WEBHOOK_SECRET;

    if (!secret) {
        // In production, an unconfigured secret must not silently allow unsigned
        // webhook processing - that's exactly the hole this middleware exists to close.
        // Fail closed instead of forwarding the request.
        if (process.env.NODE_ENV === 'production') {
            console.error('PAYMONGO_WEBHOOK_SECRET is not configured in production — rejecting webhook request.');
            return res.status(500).json({ error: 'Webhook verification is not configured' });
        }

        // Outside production (dev/test), fail-open with a loud warning so local work
        // isn't blocked by a secret that hasn't been set up yet.
        console.warn('PAYMONGO_WEBHOOK_SECRET is not configured — webhook signature is NOT being verified.');
        return next();
    }

    const signatureHeader = req.get('paymongo-signature');
    if (!signatureHeader) {
        console.warn('Rejected webhook request: missing Paymongo-Signature header');
        return res.status(401).json({ error: 'Missing webhook signature' });
    }

    if (!req.rawBody) {
        console.error('Cannot verify webhook signature: raw body was not captured');
        return res.status(500).json({ error: 'Webhook verification misconfigured' });
    }

    const { t: timestamp, te: testSignature, li: liveSignature } = parseSignatureHeader(signatureHeader);
    const providedSignature = liveSignature || testSignature;

    if (!timestamp || !providedSignature) {
        console.warn('Rejected webhook request: malformed Paymongo-Signature header');
        return res.status(401).json({ error: 'Malformed webhook signature' });
    }

    const signedPayload = `${timestamp}.${req.rawBody}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const providedBuf = Buffer.from(providedSignature, 'hex');

    const isValid = expectedBuf.length === providedBuf.length
        && crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!isValid) {
        console.warn('Rejected webhook request: signature mismatch');
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    next();
}

module.exports = { verifyPaymongoWebhookSignature };
