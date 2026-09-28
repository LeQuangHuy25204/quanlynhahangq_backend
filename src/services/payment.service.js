'use strict';

const paymentModel = require('../models/payment.model');
const orderModel   = require('../models/order.model');
const promotionModel = require('../models/promotion.model');
const { PAYMENT_STATUS, ORDER_STATUS, ORDER_LINE_STATUS } = require('../constants/status');

/**
 * Thu ngân tạo hóa đơn (Checkout) cho toàn bộ phiên bàn.
 *
 * @param {number} sessionId
 * @param {object} actorUser - (Thu ngân, Quản lý)
 * @param {number|null} promotionId - Mã khuyến mãi (tùy chọn)
 */
const checkoutSession = async (sessionId, actorUser, promotionId = null) => {
  // 1. Lấy cấu hình chi nhánh của Session
  const branchConfig = await paymentModel.getBranchConfigBySessionId(sessionId);
  if (!branchConfig) {
    const err = new Error('Không thể lấy thông tin chi nhánh cho Session này.');
    err.statusCode = 404;
    throw err;
  }

  // Bảo mật BR-18: Thu ngân chỉ thanh toán cho bàn của chi nhánh mình
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    if (branchConfig.BranchID !== actorUser.branchId) {
      const err = new Error('Bạn không có quyền thao tác trên Session của chi nhánh khác.');
      err.statusCode = 403;
      throw err;
    }
  }

  // 2. Tính SubTotal từ các món ăn hợp lệ của toàn Session
  const validOrderLines = await paymentModel.findValidOrderLinesBySessionId(sessionId);
  if (!validOrderLines || validOrderLines.length === 0) {
    const err = new Error('Không có món ăn nào hợp lệ để thanh toán trong phiên này.');
    err.statusCode = 400;
    throw err;
  }

  let subTotal = 0;
  for (const line of validOrderLines) {
    subTotal += parseFloat(line.LineTotal || (line.Quantity * line.UnitPrice));
  }

  // 3. Tính thuế và phí
  const vatRate = parseFloat(branchConfig.VATRate) || 0;
  const serviceFeeRate = parseFloat(branchConfig.ServiceFeeRate) || 0;

  const vatAmount = subTotal * (vatRate / 100);
  const serviceFeeAmount = subTotal * (serviceFeeRate / 100);

  // 4. Tính khuyến mãi (nếu có)
  let discountAmount = 0;
  if (promotionId) {
    const promotion = await promotionModel.findActivePromotion(promotionId, actorUser.restaurantId);
    if (!promotion) {
      const err = new Error('Mã khuyến mãi không hợp lệ hoặc đã hết hạn.');
      err.statusCode = 400; throw err;
    }

    // Tăng UsedCount với Optimistic Locking
    const incrementSuccess = await promotionModel.incrementPromotionUsage(promotionId, promotion.Version);
    if (!incrementSuccess) {
      const err = new Error('Mã khuyến mãi đã hết lượt sử dụng hoặc đang có nhiều giao dịch dùng cùng lúc. Vui lòng thử lại.');
      err.statusCode = 409; throw err;
    }
    if (promotion.DiscountType === 'PERCENT') {
      discountAmount = subTotal * (parseFloat(promotion.DiscountValue) / 100);
    } else { // FIXED
      discountAmount = Math.min(parseFloat(promotion.DiscountValue), subTotal);
    }
  }

  const totalAmount = subTotal + vatAmount + serviceFeeAmount - discountAmount;

  // 5. Tạo Invoice (Hóa đơn)
  const { invoiceId, invoiceNumber } = await paymentModel.createInvoice({
    sessionId: sessionId,
    branchId: branchConfig.BranchID,
    promotionId: promotionId,
    subTotal,
    vatAmount,
    serviceFeeAmount,
    discountAmount,
    totalAmount
  });

  // 6. Lưu Snapshot InvoiceLines
  await paymentModel.createInvoiceLines(invoiceId, validOrderLines);

  // 7. Tạo Payment (Giao dịch chờ thanh toán)
  const paymentId = await paymentModel.createPayment({
    invoiceId: invoiceId,
    amount:    totalAmount,
    paymentMethod: 'CASH', // Mặc định tiền mặt, có thể đổi khi complete
    status:    PAYMENT_STATUS.PENDING,
    note:      'Tạo hóa đơn tạm tính'
  });

  return {
    paymentId,
    invoiceId,
    invoiceNumber,
    subTotal,
    vatAmount,
    serviceFeeAmount,
    discountAmount,
    totalAmount,
    status: PAYMENT_STATUS.PENDING
  };
};

/**
 * Xác nhận hoàn tất thanh toán (Khách đã đưa tiền).
 *
 * @param {number} paymentId
 * @param {object} actorUser
 * @param {string} paymentMethod (CASH, CARD, TRANSFER...)
 * @param {string} transactionNo
 */
const completePayment = async (paymentId, actorUser, paymentMethod = 'CASH', transactionNo = null) => {
  const payment = await paymentModel.findPaymentWithInvoice(paymentId);
  if (!payment) {
    const err = new Error('Không tìm thấy giao dịch thanh toán.');
    err.statusCode = 404;
    throw err;
  }

  if (payment.Status === PAYMENT_STATUS.PAID) {
    const err = new Error('Giao dịch này đã được thanh toán rồi.');
    err.statusCode = 409;
    throw err;
  }

  // Xác nhận thanh toán
  await paymentModel.completePayment(paymentId, PAYMENT_STATUS.PAID, transactionNo);

  // Tùy nghiệp vụ, có thể đóng luôn Session.
  // const sessionModel = require('../models/session.model');
  // await sessionModel.updateSessionStatus(payment.SessionID, SESSION_STATUS.CLOSED);

  return { paymentId, status: PAYMENT_STATUS.PAID, message: 'Thanh toán thành công!' };
};

module.exports = { checkoutSession, completePayment };
