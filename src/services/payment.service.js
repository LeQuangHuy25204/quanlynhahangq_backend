'use strict';

const paymentModel   = require('../models/payment.model');
const promotionModel = require('../models/promotion.model');
const sessionModel   = require('../models/session.model');
const { PAYMENT_STATUS, ORDER_LINE_STATUS, SESSION_STATUS, ROLE_CODE } = require('../constants/status');

const ALLOWED_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD'];

const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

/**
 * Tính tiền cho toàn bộ phiên bàn (không ghi gì vào DB).
 * Dùng chung cho cả xem trước (preview) lẫn chốt hóa đơn (checkout).
 *
 * @param {number} sessionId
 * @param {object} actorUser
 * @param {number|null} promotionId
 */
const computeTotals = async (sessionId, actorUser, promotionId = null) => {
  const branchConfig = await paymentModel.getBranchConfigBySessionId(sessionId);
  if (!branchConfig) throw httpError('Không thể lấy thông tin chi nhánh cho Session này.', 404);

  // Bảo mật BR-18: Thu ngân chỉ thanh toán cho bàn của chi nhánh mình
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && branchConfig.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền thao tác trên Session của chi nhánh khác.', 403);
  }

  const validOrderLines = await paymentModel.findValidOrderLinesBySessionId(sessionId);
  if (!validOrderLines || validOrderLines.length === 0) {
    throw httpError('Không có món ăn nào hợp lệ để thanh toán trong phiên này.', 400);
  }

  // Món theo cân chưa có số cân thật thì chưa biết thành tiền → chặn chốt bill.
  if (validOrderLines.some((l) => l.Status === ORDER_LINE_STATUS.WAITING_WEIGH)) {
    throw httpError('Còn món tính theo cân chưa được cân. Vui lòng báo phục vụ cân món trước khi thanh toán.', 409);
  }

  // Thành tiền luôn = số lượng thật × đơn giá đã chốt (BR-07) — kể cả món cân.
  const lines = validOrderLines.map((l) => ({
    ...l,
    Amount: Math.round(parseFloat(l.Quantity) * parseFloat(l.UnitPrice) * 100) / 100,
  }));
  const subTotal = lines.reduce((sum, l) => sum + l.Amount, 0);

  const vatRate = parseFloat(branchConfig.VATRate) || 0;
  const serviceFeeRate = parseFloat(branchConfig.ServiceFeeRate) || 0;
  const vatAmount = subTotal * (vatRate / 100);
  const serviceFeeAmount = subTotal * (serviceFeeRate / 100);

  let promotion = null;
  let discountAmount = 0;
  if (promotionId) {
    promotion = await promotionModel.findActivePromotion(promotionId, actorUser.restaurantId);
    if (!promotion) throw httpError('Mã khuyến mãi không hợp lệ hoặc đã hết hạn.', 400);
    discountAmount = promotion.DiscountType === 'PERCENT'
      ? subTotal * (parseFloat(promotion.DiscountValue) / 100)
      : Math.min(parseFloat(promotion.DiscountValue), subTotal);
  }

  const totalAmount = subTotal + vatAmount + serviceFeeAmount - discountAmount;

  return {
    branchConfig, lines, promotion,
    subTotal, vatRate, serviceFeeRate, vatAmount, serviceFeeAmount, discountAmount, totalAmount,
  };
};

/**
 * Xem trước hóa đơn (không tạo gì) để Thu ngân kiểm tra trước khi chốt.
 */
const previewCheckout = async (sessionId, actorUser, promotionId = null) => {
  const existing = await paymentModel.findInvoiceBySessionId(sessionId);
  if (existing && existing.PaymentStatus === PAYMENT_STATUS.PAID) {
    throw httpError('Phiên này đã được thanh toán.', 409);
  }
  const t = await computeTotals(sessionId, actorUser, promotionId);
  return {
    sessionId: parseInt(sessionId, 10),
    lines: t.lines.map((l) => ({
      orderLineId: l.OrderLineID,
      menuItemName: l.MenuItemName,
      quantity: parseFloat(l.Quantity),
      unitPrice: parseFloat(l.UnitPrice),
      amount: l.Amount,
      note: l.Note,
    })),
    subTotal: t.subTotal,
    vatRate: t.vatRate,
    vatAmount: t.vatAmount,
    serviceFeeRate: t.serviceFeeRate,
    serviceFeeAmount: t.serviceFeeAmount,
    discountAmount: t.discountAmount,
    totalAmount: t.totalAmount,
    promotionName: t.promotion ? t.promotion.Name : null,
  };
};

/**
 * Thu ngân tạo hóa đơn (Checkout) cho toàn bộ phiên bàn.
 * Idempotent: nếu phiên đã có hóa đơn chờ thanh toán thì trả lại chính hóa đơn đó
 * (UQ_Invoice_SessionID chỉ cho phép 1 hóa đơn / phiên).
 */
const checkoutSession = async (sessionId, actorUser, promotionId = null) => {
  const existing = await paymentModel.findInvoiceBySessionId(sessionId);
  if (existing) {
    if (existing.PaymentStatus === PAYMENT_STATUS.PAID) {
      throw httpError('Phiên này đã được thanh toán.', 409);
    }
    const detail = await paymentModel.findInvoiceDetailByPaymentId(existing.PaymentID);
    return {
      paymentId: detail.PaymentID,
      invoiceId: detail.InvoiceID,
      invoiceNumber: detail.InvoiceNumber,
      subTotal: parseFloat(detail.SubTotal),
      vatAmount: parseFloat(detail.VATAmount),
      serviceFeeAmount: parseFloat(detail.ServiceFeeAmount),
      discountAmount: parseFloat(detail.DiscountAmount),
      totalAmount: parseFloat(detail.TotalAmount),
      status: PAYMENT_STATUS.PENDING,
      reused: true,
    };
  }

  const t = await computeTotals(sessionId, actorUser, promotionId);

  if (t.promotion) {
    // Tăng UsedCount với Optimistic Locking
    const ok = await promotionModel.incrementPromotionUsage(promotionId, t.promotion.Version);
    if (!ok) {
      throw httpError('Mã khuyến mãi đã hết lượt sử dụng hoặc đang có nhiều giao dịch dùng cùng lúc. Vui lòng thử lại.', 409);
    }
  }

  const { invoiceId, invoiceNumber } = await paymentModel.createInvoice({
    sessionId,
    branchId: t.branchConfig.BranchID,
    promotionId,
    subTotal: t.subTotal,
    vatAmount: t.vatAmount,
    serviceFeeAmount: t.serviceFeeAmount,
    discountAmount: t.discountAmount,
    totalAmount: t.totalAmount,
  });

  await paymentModel.createInvoiceLines(invoiceId, t.lines);

  const paymentId = await paymentModel.createPayment({
    invoiceId,
    amount: t.totalAmount,
    paymentMethod: 'CASH',
    status: PAYMENT_STATUS.PENDING,
    note: 'Tạo hóa đơn tạm tính',
  });

  return {
    paymentId,
    invoiceId,
    invoiceNumber,
    subTotal: t.subTotal,
    vatAmount: t.vatAmount,
    serviceFeeAmount: t.serviceFeeAmount,
    discountAmount: t.discountAmount,
    totalAmount: t.totalAmount,
    status: PAYMENT_STATUS.PENDING,
  };
};

/**
 * Xác nhận hoàn tất thanh toán (khách đã đưa tiền) và đóng phiên bàn → bàn trống trở lại.
 */
const completePayment = async (paymentId, actorUser, paymentMethod = 'CASH', transactionNo = null) => {
  const payment = await paymentModel.findPaymentWithInvoice(paymentId);
  if (!payment) throw httpError('Không tìm thấy giao dịch thanh toán.', 404);

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && payment.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền thao tác giao dịch của chi nhánh khác.', 403);
  }
  if (payment.Status === PAYMENT_STATUS.PAID) {
    throw httpError('Giao dịch này đã được thanh toán rồi.', 409);
  }
  if (!ALLOWED_METHODS.includes(paymentMethod)) {
    throw httpError('Phương thức thanh toán không hợp lệ.', 400);
  }

  await paymentModel.completePayment(paymentId, PAYMENT_STATUS.PAID, transactionNo, paymentMethod);

  // Đóng phiên → bàn về trạng thái trống, khách không gọi thêm được nữa.
  await sessionModel.updateSessionStatus(payment.SessionID, SESSION_STATUS.CLOSED);

  return { paymentId: parseInt(paymentId, 10), status: PAYMENT_STATUS.PAID, message: 'Thanh toán thành công!' };
};

/**
 * Hóa đơn chi tiết (để in) theo PaymentID.
 */
const getInvoiceByPayment = async (paymentId, actorUser) => {
  const detail = await paymentModel.findInvoiceDetailByPaymentId(paymentId);
  if (!detail) throw httpError('Không tìm thấy hóa đơn.', 404);
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && detail.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền xem hóa đơn của chi nhánh khác.', 403);
  }
  const lines = await paymentModel.findInvoiceLines(detail.InvoiceID);
  return { ...detail, lines };
};

module.exports = { previewCheckout, checkoutSession, completePayment, getInvoiceByPayment };
