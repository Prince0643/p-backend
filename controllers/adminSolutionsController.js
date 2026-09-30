const digitalSolutionsStore = require('../utils/digitalSolutionsStore');
const couponStore = require('../utils/couponStore');
const ghlService = require('../services/ghlService');

/** Adds the Global/Main key for a GHL row's location id (null when it isn't a tracked location). */
function withLocation(transaction) {
    if (transaction.type !== 'ghl_order') return transaction;
    const location = ghlService.getTrackedLocations().find((l) => l.locationId === transaction.ghlLocationId);
    return { ...transaction, ghlLocationKey: location ? location.key : null };
}

/** active = credited and standing, refunded = released after a GHL refund, flagged = needs manual review (paid-out or partial refund). */
function redemptionState(redemption) {
    if (redemption.needsReview) return 'flagged';
    if (redemption.status === 'released' && redemption.refundedAt) return 'refunded';
    return redemption.status === 'paid' ? 'active' : redemption.status;
}

exports.list = async (req, res) => {
    try {
        const { type, status, companyId, email, isTest } = req.query;
        const transactions = await digitalSolutionsStore.listTransactions({
            type, status, companyId, email,
            isTest: isTest === 'true' ? true : isTest === 'false' ? false : undefined
        });
        res.json({ success: true, transactions: transactions.map(withLocation) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list digital solution transactions' });
    }
};

exports.getOne = async (req, res) => {
    try {
        const transaction = await digitalSolutionsStore.findByTransactionId(req.params.transactionId);
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        const body = { success: true, transaction: withLocation(transaction) };
        if (transaction.type === 'ghl_order') {
            // Audit link: the coupon_redemptions row (if any) that credited this order's affiliate.
            const redemption = await couponStore.findRedemptionByPaymentReference(transaction.transactionId);
            body.redemption = redemption
                ? {
                    id: redemption.id,
                    code: redemption.code,
                    status: redemption.status,
                    state: redemptionState(redemption),
                    affiliateEmail: redemption.affiliateEmail || null,
                    commissionBase: redemption.commissionBase,
                    affiliateFeeAmount: redemption.affiliateFeeAmount,
                    baseAmount: redemption.baseAmount,
                    discountAmount: redemption.discountAmount,
                    currency: redemption.currency,
                    refundedAt: redemption.refundedAt,
                    needsReview: redemption.needsReview
                }
                : null;
        }
        res.json(body);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get transaction' });
    }
};
