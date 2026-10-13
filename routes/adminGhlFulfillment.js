const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminGhlFulfillmentController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/ghl-fulfillment', controller.list);
router.post('/ghl-fulfillment/import-env', controller.importEnvSubAccounts);
router.post('/ghl-fulfillment/sub-accounts', controller.saveSubAccount);
router.put('/ghl-fulfillment/sub-accounts/:id', controller.saveSubAccount);
router.delete('/ghl-fulfillment/sub-accounts/:id', controller.deleteSubAccount);
router.post('/ghl-fulfillment/rules', controller.saveRule);
router.put('/ghl-fulfillment/rules/:productId/:subAccountId', controller.saveRule);
router.delete('/ghl-fulfillment/rules/:productId/:subAccountId', controller.deleteRule);

module.exports = router;
