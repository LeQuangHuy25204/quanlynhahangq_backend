'use strict';

const express = require('express');
const router  = express.Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   POST /api/payments/checkout
 * @desc    Thu ngân tạo hóa đơn tạm tính (tính tiền)
 * @access  Protected (Cashier, BranchManager, RestaurantAdmin)
 * @body    { orderId: number }
 */
router.post(
  '/checkout',
  authenticate,
  requireRole('Cashier', 'BranchManager', 'RestaurantAdmin'),
  paymentController.checkoutOrder
);

/**
 * @route   PUT /api/payments/:paymentId/complete
 * @desc    Thu ngân xác nhận đã nhận tiền, đóng giao dịch
 * @access  Protected (Cashier, BranchManager, RestaurantAdmin)
 * @body    { paymentMethod?: string, transactionNo?: string }
 */
router.put(
  '/:paymentId/complete',
  authenticate,
  requireRole('Cashier', 'BranchManager', 'RestaurantAdmin'),
  paymentController.completePayment
);

module.exports = router;
