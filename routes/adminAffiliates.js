const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliateController');
const { validateAdminApiKey } = require('../middleware/auth');

router.use(validateAdminApiKey);

router.get('/affiliates', affiliateController.list);
router.get('/affiliates/:id', affiliateController.getOne);

module.exports = router;
