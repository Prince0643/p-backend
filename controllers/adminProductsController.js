const {
    listProducts,
    findProduct,
    upsertProduct,
    deleteProduct,
    buildHtmlSnippet
} = require('../utils/productCatalog');

function getBackendUrl(req) {
    const configured = process.env.PUBLIC_BACKEND_URL || process.env.BACKEND_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}`.replace(/\/+$/, '');
}

exports.list = (req, res) => {
    try {
        const products = listProducts();
        res.json({ success: true, products });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list products' });
    }
};

exports.getOne = (req, res) => {
    try {
        const product = findProduct({ productId: req.params.id });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true, product });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get product' });
    }
};

exports.upsert = (req, res) => {
    try {
        const saved = upsertProduct({ ...req.body, id: req.params.id || req.body?.id });
        res.json({ success: true, product: saved });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save product' });
    }
};

exports.remove = (req, res) => {
    try {
        const ok = deleteProduct(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete product' });
    }
};

exports.snippet = (req, res) => {
    try {
        const product = findProduct({ productId: req.params.id });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const backendUrl = (req.query.backendUrl ? String(req.query.backendUrl) : getBackendUrl(req)).replace(/\/+$/, '');
        const snippet = buildHtmlSnippet(product, { backendUrl });
        res.json({ success: true, backendUrl, product, snippet });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to generate snippet' });
    }
};

