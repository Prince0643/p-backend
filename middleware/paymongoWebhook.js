const crypto = require('crypto');

// PayMongo signs webhook payloads via the `Paymongo-Signature` header, formatted as
// `t=<unix timestamp>,te=<test-mode hmac>,li=<live-mode hmac>`. Per PayMongo's docs, for an
// event generated in LIVE mode `li` is populated and `te` is empty; for a TEST-mode event `te`
// is populated and `li` is empty. The signed payload is `${timestamp}.${rawBody}`, HMAC-SHA256'd
// with the signing secret of the webhook that delivered it - and live and test webhooks have
// different secrets (PAYMONGO_WEBHOOK_SECRET vs PAYMONGO_TEST_WEBHOOK_SECRET).
// Docs: https://developers.paymongo.com/docs/webhooks#section-verifying-webhook-signature
//
// So: `li` is verified ONLY against the live secret, `te` ONLY against the test secret, and the
// mode that verified must equal the event's own `data.attributes.livemode` - a mismatch is
// rejected. req.paymongoWebhookMode ('live' | 'test') is set for the controller.
function parseSignatureHeader(header) {
    const parts = String(header || '').split(',').reduce((acc, part) => {
        const [key, value] = part.split('=');
        if (key && value) acc[key.trim()] = value.trim();
        return acc;
    }, {});
    return parts;
}

function signatureMatches(secret, timestamp, rawBody, providedSignature) {
    if (!secret || !providedSignature) return false;
    const expectedSignature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const providedBuf = Buffer.from(providedSignature, 'hex');
    return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function verifyPaymongoWebhookSignature(req, res, next) {
    const liveSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    const testSecret = process.env.PAYMONGO_TEST_WEBHOOK_SECRET;

    if (!liveSecret) {
        // In production, an unconfigured secret must not silently allow unsigned
        // webhook processing - that's exactly the hole this middleware exists to close.
        // Fail closed instead of forwarding the request.
        if (process.env.NODE_ENV === 'production') {
            console.error('PAYMONGO_WEBHOOK_SECRET is not configured in production — rejecting webhook request.');
            return res.status(500).json({ error: 'Webhook verification is not configured' });
        }

        // Outside production (dev/test) with NO secrets at all, fail-open with a loud warning so
        // local work isn't blocked by a secret that hasn't been set up yet. If only the test
        // secret is configured, fall through and verify test-mode signatures (live ones can't verify).
        if (!testSecret) {
            console.warn('PAYMONGO_WEBHOOK_SECRET is not configured — webhook signature is NOT being verified.');
            return next();
        }
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

    if (!timestamp || !(liveSignature || testSignature)) {
        console.warn('Rejected webhook request: malformed Paymongo-Signature header');
        return res.status(401).json({ error: 'Malformed webhook signature' });
    }

    let signatureMode = null;
    if (liveSignature && signatureMatches(liveSecret, timestamp, req.rawBody, liveSignature)) {
        signatureMode = 'live';
    } else if (testSignature && signatureMatches(testSecret, timestamp, req.rawBody, testSignature)) {
        signatureMode = 'test';
    }

    if (!signatureMode) {
        console.warn('Rejected webhook request: signature mismatch');
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // The signature proves which webhook (mode) delivered this. An explicit payload `livemode`
    // must agree; if it is missing / not a boolean we trust the verified signature mode.
    const livemode = req.body?.data?.attributes?.livemode;
    if (typeof livemode !== 'boolean') {
        console.warn(`Webhook payload has no boolean livemode - using ${signatureMode} from the verified signature`);
    } else if ((livemode ? 'live' : 'test') !== signatureMode) {
        console.warn(`Rejected webhook request: ${signatureMode} signature but payload livemode=${livemode}`);
        return res.status(400).json({ error: 'Webhook livemode does not match signature mode' });
    }

    req.paymongoWebhookMode = signatureMode;
    next();
}

module.exports = { verifyPaymongoWebhookSignature };
