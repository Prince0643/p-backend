const {
    listProducts,
    findProduct,
    createProduct,
    updateProduct,
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

exports.list = async (req, res) => {
    try {
        const products = await listProducts();
        res.json({ success: true, products });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list products' });
    }
};

exports.getOne = async (req, res) => {
    try {
        const product = await findProduct({ productId: req.params.id });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true, product });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to get product' });
    }
};

exports.create = async (req, res) => {
    let saved;
    try {
        saved = await createProduct(req.body);
    } catch (err) {
        return res.status(400).json({ error: err.message || 'Failed to save product' });
    }
    if (!saved) return res.status(409).json({ error: 'A product with this id already exists' });
    res.json({ success: true, product: saved });
};

// The id in the URL is authoritative and never re-slugged from the name.
exports.update = async (req, res) => {
    let saved;
    try {
        saved = await updateProduct(req.params.id, req.body);
    } catch (err) {
        return res.status(400).json({ error: err.message || 'Failed to save product' });
    }
    if (!saved) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product: saved });
};

exports.remove = async (req, res) => {
    try {
        const ok = await deleteProduct(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete product' });
    }
};

exports.snippet = async (req, res) => {
    try {
        const product = await findProduct({ productId: req.params.id });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const backendUrl = (req.query.backendUrl ? String(req.query.backendUrl) : getBackendUrl(req)).replace(/\/+$/, '');
        const snippet = buildHtmlSnippet(product, { backendUrl });
        res.json({ success: true, backendUrl, product, snippet });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to generate snippet' });
    }
};
