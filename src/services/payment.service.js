'use strict';

const paymentModel = require('../models/payment.model');
const orderModel   = require('../models/order.model');
const promotionModel = require('../models/promotion.model');
const { PAYMENT_STATUS, ORDER_STATUS, ORDER_LINE_STATUS } = require('../constants/status');

/**
 * Thu ngân tạo hóa đơn (Checkout).
 *
 * @param {number} orderId
 * @param {object} actorUser - (Thu ngân, Quản lý)
 * @param {number|null} promotionId - Mã khuyến mãi (tùy chọn)
 */
const checkoutOrder = async (orderId, actorUser, promotionId = null) => {
  const order = await orderModel.findOrderWithLines(orderId);
  if (!order) {
    const err = new Error('Không tìm thấy Order.');
    err.statusCode = 404;
    throw err;
  }

  // Bảo mật BR-18: Thu ngân chỉ thanh toán cho bàn của chi nhánh mình
  const branchConfig = await paymentModel.getBranchConfigByOrderId(orderId);
  if (!branchConfig) {
    const err = new Error('Không thể lấy cấu hình chi nhánh của Order này.');
    err.statusCode = 500;
    throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    if (branchConfig.BranchID !== actorUser.branchId) {
      const err = new Error('Bạn không có quyền thao tác trên Order của chi nhánh khác.');
      err.statusCode = 403;
      throw err;
    }
  }

  // Chỉ checkout nếu Order đang ở trạng thái WAITING_PAYMENT hoặc PENDING/CONFIRMED
  if (order.Status === ORDER_STATUS.CANCELLED) {
    const err = new Error('Order này đã bị hủy, không thể thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  // 1. Tính SubTotal từ các món ăn hợp lệ (không bị hủy)
  let subTotal = 0;
  for (const line of order.lines) {
    if (line.Status !== ORDER_LINE_STATUS.CANCELLED) {
      subTotal += parseFloat(line.Quantity) * parseFloat(line.UnitPrice);
    }
  }

  if (subTotal === 0) {
    const err = new Error('Đơn hàng không có món ăn nào hợp lệ để thanh toán.');
    err.statusCode = 400;
    throw err;
  }

  // 2. Tính thuế và phí
  const vatRate = parseFloat(branchConfig.VATRate) || 0;
  const serviceFeeRate = parseFloat(branchConfig.ServiceFeeRate) || 0;

  const vatAmount = subTotal * (vatRate / 100);
  const serviceFeeAmount = subTotal * (serviceFeeRate / 100);
  // 2. Tính khuyến mãi (nếu có)
  let discountAmount = 0;
  if (promotionId) {
    const promotion = await promotionModel.findActivePromotion(promotionId, actorUser.restaurantId);
    if (!promotion) {
      const err = new Error('Mã khuyến mãi không hợp lệ hoặc đã hết hạn.');
      err.statusCode = 400; throw err;
    }
    if (promotion.DiscountType === 'PERCENT') {
      discountAmount = subTotal * (parseFloat(promotion.DiscountValue) / 100);
    } else { // FIXED
      discountAmount = Math.min(parseFloat(promotion.DiscountValue), subTotal);
    }
  }

  const totalAmount = subTotal + vatAmount + serviceFeeAmount - discountAmount;

  // 3. Tạo Payment
  const paymentId = await paymentModel.createPayment({
    orderId:       orderId,
    amount:        totalAmount,
    paymentMethod: 'CASH', // Mặc định tiền mặt, có thể đổi khi complete
    status:        PAYMENT_STATUS.PENDING,
    note:          'Tạo hóa đơn tạm tính'
  });

  // 4. Tạo Invoice
  const { invoiceId, invoiceNumber } = await paymentModel.createInvoice({
    paymentId,
    subTotal,
    vatAmount,
    serviceFeeAmount,
    discountAmount,
    totalAmount
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

  // Lấy Order để đóng
  const order = await orderModel.findOrderWithLines(payment.OrderID);
  if (order) {
    // Nếu có thể, đóng order. Hiện tại không có trạng thái CLOSED cho order,
    // nhưng mình có thể thêm hoặc tạm để CONFIRMED/PAID.
    // Tùy nghiệp vụ, có thể đóng luôn Session nếu đây là order cuối.
  }

  return { paymentId, status: PAYMENT_STATUS.PAID, message: 'Thanh toán thành công!' };
};

module.exports = { checkoutOrder, completePayment };
