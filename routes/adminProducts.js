const express = require('express');
const router = express.Router();
const adminProductsController = require('../controllers/adminProductsController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/products', adminProductsController.list);
router.get('/products/:id', adminProductsController.getOne);
router.get('/products/:id/snippet', adminProductsController.snippet);
router.post('/products', adminProductsController.create);
router.put('/products/:id', adminProductsController.update);
router.delete('/products/:id', adminProductsController.remove);

module.exports = router;

