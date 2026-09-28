'use strict';

const paymentService = require('../services/payment.service');

/**
 * POST /api/payments/checkout
 * Body: { sessionId: number }
 */
const checkoutSession = async (req, res, next) => {
  try {
    const { sessionId, promotionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId là bắt buộc.' });
    }
    const data = await paymentService.checkoutSession(sessionId, req.user, promotionId || null);
    res.status(201).json({ success: true, message: 'Tạo hóa đơn thành công.', data });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/payments/:paymentId/complete
 * Body: { paymentMethod?: string, transactionNo?: string }
 */
const completePayment = async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { paymentMethod, transactionNo } = req.body;
    const data = await paymentService.completePayment(paymentId, req.user, paymentMethod, transactionNo);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) {
    next(err);
  }
};

module.exports = { checkoutSession, completePayment };
