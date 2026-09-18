const express = require('express');
const router = express.Router();
const adminSolutionsController = require('../controllers/adminSolutionsController');
const { requireAdminAuth } = require('../middleware/adminAuth');

router.use(requireAdminAuth);

router.get('/solutions', adminSolutionsController.list);
router.get('/solutions/:transactionId', adminSolutionsController.getOne);

module.exports = router;
