'use strict';

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole } = require('../middlewares/roleMiddleware');
const { createRateLimiter } = require('../middlewares/rateLimitMiddleware');

const CASHIER_ROLES = ['Cashier', 'BranchManager', 'RestaurantAdmin'];

/**
 * Middleware xác thực tùy chọn: nếu có Bearer token thì decode JWT vào req.user;
 * nếu không có thì cho qua để tầng service kiểm tra sessionToken của khách hàng.
 */
const optionalStaffAuth = (req, res, next) => {
  // Nếu request từ khách hàng gửi kèm sessionToken, ưu tiên xác thực theo sessionToken (tránh vướng JWT nhân viên hết hạn trong localStorage)
  if (req.body?.sessionToken || req.headers['x-session-token']) {
    return next();
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticate(req, res, (err) => {
      if (err) return next(err);
      if (!CASHIER_ROLES.includes(req.user?.roleCode)) {
        return res.status(403).json({
          success: false,
          message: `Bạn không có quyền thực hiện hành động này. Yêu cầu quyền: [${CASHIER_ROLES.join(', ')}].`,
        });
      }
      return next();
    });
  }
  return next();
};

const vnpayCreateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  message: 'Bạn đã yêu cầu tạo giao dịch VNPay quá nhiều lần. Vui lòng đợi 1 phút rồi thử lại.',
});

// ── Customer, VNPay & SePay Endpoints ─────────────────────────
router.post('/customer/preview', paymentController.customerPreviewCheckout);
router.post('/vnpay/create', vnpayCreateLimiter, optionalStaffAuth, paymentController.createVnpayPayment);
router.post('/sepay/create', vnpayCreateLimiter, optionalStaffAuth, paymentController.createSepayPayment);
router.post('/sepay/webhook', paymentController.sepayWebhook);
router.get('/vnpay/return', paymentController.vnpayReturn);
router.get('/vnpay/ipn', paymentController.vnpayIpn);
router.post('/vnpay/status', optionalStaffAuth, paymentController.getVnpayStatus);
router.post('/vnpay/querydr', authenticate, requireRole(...CASHIER_ROLES), paymentController.queryVnpayTransaction);
router.get('/vnpay/transactions', authenticate, requireRole(...CASHIER_ROLES), paymentController.listVnpayTransactions);

// ── Existing Cashier / Admin Endpoints ────────────────────────
router.get('/preview', authenticate, requireRole(...CASHIER_ROLES), paymentController.previewCheckout);
router.post('/checkout', authenticate, requireRole(...CASHIER_ROLES), paymentController.checkoutSession);
router.put('/:paymentId/complete', authenticate, requireRole(...CASHIER_ROLES), paymentController.completePayment);
router.get('/:paymentId/invoice', authenticate, requireRole(...CASHIER_ROLES), paymentController.getInvoice);

module.exports = router;
