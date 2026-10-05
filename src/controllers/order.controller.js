'use strict';

const orderService = require('../services/order.service');

/**
 * POST /api/orders
 * Body: { sessionToken, participantId, branchId, items }
 * restaurantId lấy từ process.env — không cần client truyền.
 */
const placeOrder = async (req, res, next) => {
  try {
    const { sessionToken, participantId, items, branchId } = req.body;
    const result = await orderService.placeOrder({ sessionToken, participantId, items, branchId });
    res.status(201).json({ success: true, message: 'Đặt món thành công.', data: result });
  } catch (err) { next(err); }
};

/**
 * PUT /api/orders/lines/:orderLineId/weight
 * Body: { quantity: number (decimal) }
 */
const updateOrderLineWeight = async (req, res, next) => {
  try {
    const { orderLineId } = req.params;
    const { quantity } = req.body;
    // Truyền req.user vào để phân quyền chi nhánh (BR-18)
    const result = await orderService.updateOrderLineWeight(orderLineId, quantity, req.user);
    res.status(200).json({ success: true, message: 'Cập nhật trọng lượng và chuyển bếp thành công.', data: result });
  } catch (err) { next(err); }
};

/**
 * PUT /api/orders/lines/:orderLineId/status
 * Body: { status: number }
 */
const updateOrderLineStatus = async (req, res, next) => {
  try {
    const { orderLineId } = req.params;
    const { status } = req.body;
    const data = await orderService.updateOrderLineStatus(orderLineId, status, req.user);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

/**
 * POST /api/orders/:orderId/request-payment
 * Body: { sessionToken: string }
 */
const requestPayment = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { sessionToken } = req.body;
    const data = await orderService.requestPayment(orderId, sessionToken);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

/**
 * POST /api/orders/:orderId/staff-request-payment
 */
const staffRequestPayment = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const data = await orderService.staffRequestPayment(orderId, req.user);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

const cancelOrderLine = async (req, res, next) => {
  try {
    const { orderLineId } = req.params;
    const { cancelReason } = req.body;
    const data = await orderService.cancelOrderLine(orderLineId, cancelReason, req.user);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

const getOrderLinesBySession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const data = await orderService.getOrderLinesBySession(sessionId);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

const getOrdersByBranch = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.user.branchId;
    const status = req.query.status !== undefined ? req.query.status : null;
    const data = await orderService.getOrdersByBranch(branchId, status);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

const trackOrderByToken = async (req, res, next) => {
  try {
    const { sessionToken } = req.params;
    const data = await orderService.trackOrderByToken(sessionToken);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

module.exports = { placeOrder, updateOrderLineWeight, updateOrderLineStatus, requestPayment, staffRequestPayment, cancelOrderLine, getOrderLinesBySession, getOrdersByBranch, trackOrderByToken };
