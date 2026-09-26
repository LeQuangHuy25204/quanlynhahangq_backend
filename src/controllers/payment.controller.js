'use strict';

const paymentService = require('../services/payment.service');

/**
 * POST /api/payments/checkout
 * Body: { orderId: number }
 */
const checkoutOrder = async (req, res, next) => {
  try {
    const { orderId, promotionId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId là bắt buộc.' });
    }
    const data = await paymentService.checkoutOrder(orderId, req.user, promotionId || null);
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

module.exports = { checkoutOrder, completePayment };
