const digitalSolutionsStore = require('../utils/digitalSolutionsStore');

exports.list = (req, res) => {
    try {
        const { type, status, companyId, email } = req.query;
        const transactions = digitalSolutionsStore.listTransactions({ type, status, companyId, email });
        res.json({ success: true, transactions });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list digital solution transactions' });
    }
};

exports.getOne = (req, res) => {
    try {
        const transaction = digitalSolutionsStore.findByTransactionId(req.params.transactionId);
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
        res.json({ success: true, transaction });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get transaction' });
    }
};
