'use strict';

const paymentService = require('../services/payment.service');
const orderModel = require('../models/order.model');

/**
 * GET /api/payments/preview?sessionId=1&promotionId=2
 * Xem trước hóa đơn (không ghi DB).
 */
const previewCheckout = async (req, res, next) => {
  try {
    let { sessionId, orderId, promotionId } = req.query;
    if (!sessionId && orderId) {
      const order = await orderModel.findOrderWithLines(orderId);
      if (order) sessionId = order.SessionID;
    }
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId là bắt buộc.' });
    }
    const data = await paymentService.previewCheckout(
      parseInt(sessionId, 10),
      req.user,
      promotionId ? parseInt(promotionId, 10) : null
    );
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/payments/checkout
 * Body: { sessionId?: number, orderId?: number, promotionId?: number }
 */
const checkoutSession = async (req, res, next) => {
  try {
    let { sessionId, orderId, promotionId } = req.body;
    if (!sessionId && orderId) {
      const order = await orderModel.findOrderWithLines(orderId);
      if (order) sessionId = order.SessionID;
    }
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId là bắt buộc.' });
    }
    const data = await paymentService.checkoutSession(parseInt(sessionId, 10), req.user, promotionId || null);
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

/**
 * GET /api/payments/:paymentId/invoice
 */
const getInvoice = async (req, res, next) => {
  try {
    const data = await paymentService.getInvoiceByPayment(req.params.paymentId, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

module.exports = { previewCheckout, checkoutSession, completePayment, getInvoice };
