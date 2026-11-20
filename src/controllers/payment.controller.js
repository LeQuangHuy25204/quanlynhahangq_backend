'use strict';

const paymentService = require('../services/payment.service');
const vnpayService = require('../services/vnpay.service');
const orderModel = require('../models/order.model');

const extractClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  return vnpayService.normalizeIp(forwarded || req.socket?.remoteAddress || req.ip);
};

/**
 * GET /api/payments/preview?sessionId=1&promotionId=2
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
 * POST /api/payments/customer/preview
 * Body: { sessionToken, promotionId? } (không truyền sessionToken qua query string)
 */
const customerPreviewCheckout = async (req, res, next) => {
  try {
    const sessionToken = req.body?.sessionToken || req.headers['x-session-token'];
    const promotionId = req.body?.promotionId ? parseInt(req.body.promotionId, 10) : null;
    const data = await paymentService.customerPreviewCheckout(sessionToken, promotionId);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/payments/checkout
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

/**
 * POST /api/payments/vnpay/create
 * Hỗ trợ Khách hàng (sessionToken trong body/header) hoặc Thu ngân (JWT).
 */
const createVnpayPayment = async (req, res, next) => {
  try {
    const sessionToken = req.body?.sessionToken || req.headers['x-session-token'] || null;
    const { sessionId, orderId, promotionId } = req.body || {};

    const data = await paymentService.createVnpayPayment({
      sessionToken: req.user ? null : sessionToken,
      sessionId: sessionId ? parseInt(sessionId, 10) : null,
      orderId: orderId ? parseInt(orderId, 10) : null,
      promotionId: promotionId ? parseInt(promotionId, 10) : null,
      actorUser: req.user || null,
      ipAddr: extractClientIp(req),
    });

    res.status(201).json({
      success: true,
      message: 'Tạo liên kết thanh toán VNPay thành công.',
      data,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/payments/vnpay/return
 * Chỉ xác minh chữ ký và điều hướng sang giao diện kết quả Frontend (không chốt PAID).
 */
const vnpayReturn = async (req, res, next) => {
  try {
    const result = await paymentService.handleVnpayReturn(req.query);
    if (req.query.format === 'json') {
      return res.status(200).json({ success: true, data: result });
    }

    const { frontendReturnUrl } = vnpayService.getVnpConfig();
    const params = new URLSearchParams({
      txnRef: result.txnRef || '',
      sig: result.signatureValid ? '1' : '0',
      code: result.vnpResponseCode || '',
    });
    return res.redirect(`${frontendReturnUrl}?${params.toString()}`);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/payments/vnpay/ipn
 * Máy chủ VNPay gọi về để xác nhận giao dịch chính thức.
 */
const vnpayIpn = async (req, res) => {
  const result = await paymentService.handleVnpayIpn(req.query);
  return res.status(200).json({
    RspCode: result.RspCode,
    Message: result.Message,
  });
};

/**
 * POST /api/payments/vnpay/status
 * Body: { txnRef, sessionToken? }
 */
const getVnpayStatus = async (req, res, next) => {
  try {
    const sessionToken = req.body?.sessionToken || req.headers['x-session-token'] || null;
    const txnRef = req.body?.txnRef || req.params?.txnRef;
    const data = await paymentService.getVnpayStatus({
      txnRef,
      sessionToken: req.user ? null : sessionToken,
      actorUser: req.user || null,
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/payments/vnpay/querydr
 * Body: { txnRef }
 */
const queryVnpayTransaction = async (req, res, next) => {
  try {
    const { txnRef } = req.body || {};
    const data = await paymentService.queryVnpayTransaction({
      txnRef,
      actorUser: req.user,
      ipAddr: extractClientIp(req),
    });
    res.status(200).json({ success: true, message: 'Đã đối soát trạng thái giao dịch từ VNPay.', data });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/payments/vnpay/transactions?invoiceId=...&status=...&needReconcile=...
 */
const listVnpayTransactions = async (req, res, next) => {
  try {
    const { invoiceId, branchId, status, needReconcile } = req.query;
    const data = await paymentService.listVnpayTransactions({
      invoiceId,
      branchId,
      status,
      needReconcile,
      actorUser: req.user,
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  previewCheckout,
  customerPreviewCheckout,
  checkoutSession,
  completePayment,
  getInvoice,
  createVnpayPayment,
  vnpayReturn,
  vnpayIpn,
  getVnpayStatus,
  queryVnpayTransaction,
  listVnpayTransactions,
};
