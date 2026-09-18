const digitalSolutionsStore = require('../utils/digitalSolutionsStore');

exports.list = async (req, res) => {
    try {
        const { type, status, companyId, email } = req.query;
        const transactions = await digitalSolutionsStore.listTransactions({ type, status, companyId, email });
        res.json({ success: true, transactions });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list digital solution transactions' });
    }
};

exports.getOne = async (req, res) => {
    try {
        const transaction = await digitalSolutionsStore.findByTransactionId(req.params.transactionId);
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
        res.json({ success: true, transaction });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get transaction' });
    }
};
