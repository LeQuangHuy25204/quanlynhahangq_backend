'use strict';

const express = require('express');
const router  = express.Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

const CASHIER_ROLES = ['Cashier', 'BranchManager', 'RestaurantAdmin'];

/**
 * @route   GET /api/payments/preview?sessionId=X&promotionId=Y
 * @desc    Xem trước hóa đơn tạm tính (không ghi DB)
 * @access  Protected (Cashier, BranchManager, RestaurantAdmin)
 */
router.get('/preview', authenticate, requireRole(...CASHIER_ROLES), paymentController.previewCheckout);

/**
 * @route   POST /api/payments/checkout
 * @desc    Thu ngân tạo hóa đơn tạm tính (tính tiền)
 * @access  Protected (Cashier, BranchManager, RestaurantAdmin)
 * @body    { sessionId: number, promotionId?: number }
 */
router.post('/checkout', authenticate, requireRole(...CASHIER_ROLES), paymentController.checkoutSession);

/**
 * @route   PUT /api/payments/:paymentId/complete
 * @desc    Thu ngân xác nhận đã nhận tiền, đóng giao dịch và đóng phiên bàn
 * @access  Protected (Cashier, BranchManager, RestaurantAdmin)
 * @body    { paymentMethod?: 'CASH'|'BANK_TRANSFER'|'CARD', transactionNo?: string }
 */
router.put('/:paymentId/complete', authenticate, requireRole(...CASHIER_ROLES), paymentController.completePayment);

/**
 * @route   GET /api/payments/:paymentId/invoice
 * @desc    Chi tiết hóa đơn (để in)
 * @access  Protected (Cashier, BranchManager, RestaurantAdmin)
 */
router.get('/:paymentId/invoice', authenticate, requireRole(...CASHIER_ROLES), paymentController.getInvoice);

module.exports = router;
