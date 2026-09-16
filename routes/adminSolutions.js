const express = require('express');
const router = express.Router();
const adminSolutionsController = require('../controllers/adminSolutionsController');
const { validateAdminApiKey } = require('../middleware/auth');

router.use(validateAdminApiKey);

router.get('/solutions', adminSolutionsController.list);
router.get('/solutions/:transactionId', adminSolutionsController.getOne);

module.exports = router;
