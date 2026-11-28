'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');
const paymentModel = require('../models/payment.model');
const promotionModel = require('../models/promotion.model');
const promotionService = require('./promotion.service');
const sessionModel = require('../models/session.model');
const orderModel = require('../models/order.model');
const { prepareSessionForPayment } = require('./order.service');
const vnpayService = require('./vnpay.service');
const activityLogService = require('./activityLog.service');
const {
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  VNPAY_TX_STATUS,
  ORDER_LINE_STATUS,
  SESSION_STATUS,
  ROLE_CODE,
  LOG_SEVERITY,
} = require('../constants/status');

const MANUAL_ALLOWED_METHODS = [
  PAYMENT_METHOD.CASH,
  PAYMENT_METHOD.BANK_TRANSFER,
  PAYMENT_METHOD.CARD,
];

const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Khóa đồng bộ theo SessionID để chống double-submit / tạo trùng Invoice khi 2 request đến cùng lúc
const sessionPaymentLocks = new Map();
const withSessionPaymentLock = async (sessionId, fn) => {
  const lockKey = `pay_session_${sessionId}`;
  const prev = sessionPaymentLocks.get(lockKey) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  sessionPaymentLocks.set(lockKey, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionPaymentLocks.get(lockKey) === next) {
      sessionPaymentLocks.delete(lockKey);
    }
  }
};

/**
 * Tính tiền cho toàn bộ phiên bàn (không ghi gì vào DB).
 * Dùng chung cho cả xem trước (preview) lẫn chốt hóa đơn (checkout).
 */
const computeTotals = async (sessionId, actorUser, promotionId = null) => {
  const branchConfig = await paymentModel.getBranchConfigBySessionId(sessionId);
  if (!branchConfig) throw httpError('Không thể lấy thông tin chi nhánh cho Session này.', 404);

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && branchConfig.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền thao tác trên Session của chi nhánh khác.', 403);
  }

  const validOrderLines = await paymentModel.findValidOrderLinesBySessionId(sessionId);
  if (!validOrderLines || validOrderLines.length === 0) {
    throw httpError('Không có món ăn nào hợp lệ để thanh toán trong phiên này.', 400);
  }

  if (validOrderLines.some((l) => l.Status === ORDER_LINE_STATUS.WAITING_WEIGH)) {
    throw httpError('Còn món tính theo cân chưa được cân. Vui lòng báo phục vụ cân món trước khi thanh toán.', 409);
  }

  const lines = validOrderLines.map((l) => ({
    ...l,
    Amount: Math.round(parseFloat(l.Quantity) * parseFloat(l.UnitPrice) * 100) / 100,
  }));
  const subTotal = lines.reduce((sum, l) => sum + l.Amount, 0);

  const vatRate = parseFloat(branchConfig.VATRate) || 0;
  const serviceFeeRate = parseFloat(branchConfig.ServiceFeeRate) || 0;
  const vatAmount = Math.round(subTotal * (vatRate / 100));
  const serviceFeeAmount = Math.round(subTotal * (serviceFeeRate / 100));

  let promotion = null;
  let discountAmount = 0;
  if (promotionId) {
    promotion = await promotionModel.findActivePromotion(promotionId, actorUser.restaurantId || 1, branchConfig.BranchID);
    if (!promotion) throw httpError('Mã khuyến mãi không hợp lệ, đã hết hạn hoặc không áp dụng cho chi nhánh này.', 400);

    const menuItemIds = promotion.ApplyLevel === 'MENU_ITEM'
      ? await promotionModel.findPromotionMenuItemIds(promotion.PromotionID)
      : [];
    const result = promotionService.evaluatePromotion(promotion, lines, subTotal, menuItemIds);
    if (!result.ok) throw httpError(result.reason, 400);
    discountAmount = Math.round(result.discountAmount);
  }

  const totalAmount = Math.max(0, Math.round(subTotal + vatAmount + serviceFeeAmount - discountAmount));

  return {
    branchConfig,
    lines,
    promotion,
    subTotal,
    vatRate,
    serviceFeeRate,
    vatAmount,
    serviceFeeAmount,
    discountAmount,
    totalAmount,
  };
};

/**
 * Xem trước hóa đơn cho Thu ngân (không ghi DB).
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
    momoEnabled: true,
  };
};

/**
 * Khách hàng tại bàn xem trước hóa đơn chi tiết bằng sessionToken (gửi qua POST body).
 */
const customerPreviewCheckout = async (sessionToken, promotionId = null) => {
  if (!sessionToken) {
    throw httpError('Thiếu mã phiên bàn (sessionToken).', 401);
  }
  const session = await sessionModel.findSessionByToken(sessionToken);
  if (!session) {
    throw httpError('Phiên bàn không hợp lệ hoặc không tồn tại.', 403);
  }
  if (session.Status === SESSION_STATUS.CLOSED) {
    throw httpError('Phiên bàn này đã đóng.', 409);
  }
  if (session.Status !== SESSION_STATUS.OPEN) {
    throw httpError('Bàn chưa được nhân viên mở phục vụ.', 409);
  }

  const existing = await paymentModel.findInvoiceBySessionId(session.SessionID);
  if (existing && existing.PaymentStatus === PAYMENT_STATUS.PAID) {
    throw httpError('Phiên này đã được thanh toán.', 409);
  }

  const systemActor = {
    roleCode: ROLE_CODE.RESTAURANT_ADMIN,
    branchId: session.BranchID,
    restaurantId: session.RestaurantID || 1,
  };

  if (existing) {
    const detail = await paymentModel.findInvoiceDetailByPaymentId(existing.PaymentID);
    const lines = await paymentModel.findInvoiceLines(existing.InvoiceID);
    return {
      sessionId: session.SessionID,
      tableName: session.TableName,
      invoiceId: detail.InvoiceID,
      invoiceNumber: detail.InvoiceNumber,
      lines: lines.map((l) => ({
        orderLineId: l.OrderLineID,
        menuItemName: l.MenuItemName,
        quantity: parseFloat(l.Quantity),
        unitPrice: parseFloat(l.UnitPrice),
        amount: parseFloat(l.Amount),
        note: l.Note,
      })),
      subTotal: parseFloat(detail.SubTotal),
      vatRate: parseFloat(detail.VATRate),
      vatAmount: parseFloat(detail.VATAmount),
      serviceFeeRate: parseFloat(detail.ServiceFeeRate),
      serviceFeeAmount: parseFloat(detail.ServiceFeeAmount),
      discountAmount: parseFloat(detail.DiscountAmount),
      totalAmount: parseFloat(detail.TotalAmount),
      promotionName: detail.PromotionName || null,
      momoEnabled: true,
    };
  }

  const t = await computeTotals(session.SessionID, systemActor, promotionId);
  return {
    sessionId: session.SessionID,
    tableName: session.TableName,
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
    momoEnabled: true,
  };
};

/**
 * Tạo Invoice + Payment (dùng chung trong transaction hoặc lock).
 */
const ensureInvoiceAndPayment = async (sessionId, actorUser, promotionId = null, defaultMethod = PAYMENT_METHOD.CASH) => {
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
      status: detail.PaymentStatus,
      reused: true,
    };
  }

  const t = await computeTotals(sessionId, actorUser, promotionId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (t.promotion) {
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
    }, conn);

    await paymentModel.createInvoiceLines(invoiceId, t.lines, conn);

    const paymentId = await paymentModel.createPayment({
      invoiceId,
      amount: t.totalAmount,
      paymentMethod: defaultMethod,
      status: PAYMENT_STATUS.PENDING,
      note: 'Tạo hóa đơn tạm tính',
    }, conn);

    await conn.commit();

    return {
      paymentId,
      invoiceId,
      invoiceNumber,
      branchId: t.branchConfig.BranchID,
      subTotal: t.subTotal,
      vatAmount: t.vatAmount,
      serviceFeeAmount: t.serviceFeeAmount,
      discountAmount: t.discountAmount,
      totalAmount: t.totalAmount,
      status: PAYMENT_STATUS.PENDING,
      reused: false,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * Thu ngân tạo hóa đơn (Checkout) cho toàn bộ phiên bàn.
 */
const checkoutSession = async (sessionId, actorUser, promotionId = null) => {
  return withSessionPaymentLock(sessionId, async () => {
    const result = await ensureInvoiceAndPayment(sessionId, actorUser, promotionId, PAYMENT_METHOD.CASH);
    if (!result.reused) {
      await activityLogService.logStaffAction(actorUser, {
        branchId: result.branchId || actorUser.branchId,
        entityType: 'Invoice',
        entityId: result.invoiceId,
        action: 'INVOICE_CHECKOUT',
        severity: LOG_SEVERITY.INFO,
        description: `Tạo hóa đơn ${result.invoiceNumber} cho Phiên #${sessionId} (Tổng ${result.totalAmount.toLocaleString('vi-VN')}đ).`,
        newValue: {
          invoiceId: result.invoiceId,
          invoiceNumber: result.invoiceNumber,
          sessionId: Number(sessionId),
          promotionId: promotionId || null,
          subTotal: result.subTotal,
          vatAmount: result.vatAmount,
          serviceFeeAmount: result.serviceFeeAmount,
          discountAmount: result.discountAmount,
          totalAmount: result.totalAmount,
        },
      });
    }
    return result;
  });
};

/**
 * Xác nhận hoàn tất thanh toán thủ công tại quầy (CASH / BANK_TRANSFER / CARD) và đóng phiên bàn.
 * Chặn tự ý đánh dấu VNPAY thành công nếu chưa có IPN/querydr xác minh.
 */
const completePayment = async (paymentId, actorUser, paymentMethod = PAYMENT_METHOD.CASH, transactionNo = null) => {
  const payment = await paymentModel.findPaymentWithInvoice(paymentId);
  if (!payment) throw httpError('Không tìm thấy giao dịch thanh toán.', 404);

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && payment.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền thao tác giao dịch của chi nhánh khác.', 403);
  }
  if (payment.Status === PAYMENT_STATUS.PAID) {
    throw httpError('Giao dịch này đã được thanh toán rồi.', 409);
  }
  if (paymentMethod === PAYMENT_METHOD.VNPAY) {
    throw httpError('Không thể xác nhận thủ công thanh toán VNPay. Giao dịch VNPay chỉ được xác nhận qua IPN hoặc đối soát VNPay.', 400);
  }
  if (!MANUAL_ALLOWED_METHODS.includes(paymentMethod)) {
    throw httpError('Phương thức thanh toán không hợp lệ.', 400);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await paymentModel.completePayment(paymentId, PAYMENT_STATUS.PAID, transactionNo, paymentMethod, conn);
    await sessionModel.updateSessionStatus(payment.SessionID, SESSION_STATUS.CLOSED, conn);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await activityLogService.logStaffAction(actorUser, {
    branchId: payment.BranchID,
    entityType: 'Payment',
    entityId: parseInt(paymentId, 10),
    action: 'PAYMENT_COMPLETE',
    severity: LOG_SEVERITY.CRITICAL,
    description: `Xác nhận thanh toán hoàn tất (${paymentMethod}) cho Hóa đơn ${payment.InvoiceNumber} (${parseFloat(payment.Amount).toLocaleString('vi-VN')}đ) và đóng Phiên #${payment.SessionID}.`,
    oldValue: {
      paymentStatus: payment.Status,
      paymentMethod: payment.PaymentMethod,
      sessionId: payment.SessionID,
    },
    newValue: {
      paymentStatus: PAYMENT_STATUS.PAID,
      paymentMethod,
      amount: parseFloat(payment.Amount),
      transactionNo: transactionNo || null,
      invoiceNumber: payment.InvoiceNumber,
      sessionId: payment.SessionID,
    },
  });

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

/**
 * Tạo giao dịch VNPay (hỗ trợ cả Khách hàng có sessionToken và Thu ngân có JWT).
 * Lưu mã giao dịch trực tiếp vào bảng payment gốc (cột TransactionNo, Note).
 */
const createVnpayPayment = async ({
  sessionToken = null,
  sessionId = null,
  orderId = null,
  promotionId = null,
  actorUser = null,
  ipAddr = '127.0.0.1',
}) => {
  let session;
  let effectiveActor = actorUser;

  if (actorUser) {
    let targetSessionId = sessionId;
    if (!targetSessionId && orderId) {
      const order = await orderModel.findOrderWithLines(orderId);
      if (order) targetSessionId = order.SessionID;
    }
    if (!targetSessionId) {
      throw httpError('sessionId hoặc orderId là bắt buộc.', 400);
    }
    session = await sessionModel.findSessionById(targetSessionId);
    if (!session) throw httpError('Không tìm thấy phiên bàn.', 404);
    if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && session.BranchID !== actorUser.branchId) {
      throw httpError('Bạn không có quyền thao tác trên phiên của chi nhánh khác.', 403);
    }
  } else {
    if (!sessionToken) {
      throw httpError('Thiếu sessionToken để xác thực phiên bàn.', 401);
    }
    session = await sessionModel.findSessionByToken(sessionToken);
    if (!session) {
      throw httpError('sessionToken không hợp lệ hoặc phiên không tồn tại.', 403);
    }
    effectiveActor = {
      roleCode: ROLE_CODE.RESTAURANT_ADMIN,
      branchId: session.BranchID,
      restaurantId: session.RestaurantID || 1,
    };
  }

  if (session.Status === SESSION_STATUS.CLOSED) {
    throw httpError('Phiên bàn này đã đóng, không thể tạo giao dịch mới.', 409);
  }
  if (session.Status !== SESSION_STATUS.OPEN) {
    throw httpError('Phiên bàn chưa ở trạng thái đang phục vụ.', 409);
  }

  return withSessionPaymentLock(session.SessionID, async () => {
    const existing = await paymentModel.findInvoiceBySessionId(session.SessionID);
    if (existing && existing.PaymentStatus === PAYMENT_STATUS.PAID) {
      throw httpError('Hóa đơn của phiên này đã được thanh toán thành công.', 409);
    }

    if (!existing) {
      await prepareSessionForPayment(session.SessionID, actorUser || null);
      await orderModel.updateAllOrdersStatusInSession(session.SessionID, 3); // WAITING_PAYMENT
    }

    const invoiceData = await ensureInvoiceAndPayment(
      session.SessionID,
      effectiveActor,
      promotionId || null,
      PAYMENT_METHOD.VNPAY
    );

    if (invoiceData.status === PAYMENT_STATUS.PAID) {
      throw httpError('Hóa đơn của phiên này đã được thanh toán thành công.', 409);
    }

    const amountVnp = vnpayService.parseAmountToVnpInt(invoiceData.totalAmount);
    if (amountVnp <= 0n) {
      throw httpError('Số tiền thanh toán phải lớn hơn 0.', 400);
    }

    const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const vnpTxnRef = `VNP${invoiceData.paymentId}T${Date.now()}${randomSuffix}`;
    const orderInfo = `Thanh toan hoa don ${invoiceData.invoiceNumber} ban ${session.TableName || session.SessionID}`;
    const normalizedIp = vnpayService.normalizeIp(ipAddr);

    await paymentModel.saveGatewayTransactionToPayment({
      paymentId: invoiceData.paymentId,
      provider: PAYMENT_METHOD.VNPAY,
      txnRef: vnpTxnRef,
      orderInfo,
    });

    const paymentUrl = vnpayService.buildPaymentUrl({
      txnRef: vnpTxnRef,
      amountVnp,
      orderInfo,
      ipAddr: normalizedIp,
    });

    const vnpLogPayload = {
      branchId: session.BranchID,
      entityType: 'Payment',
      entityId: invoiceData.paymentId,
      action: 'VNPAY_CREATE',
      severity: LOG_SEVERITY.INFO,
      description: `Khởi tạo thanh toán VNPay ${vnpTxnRef} cho ${invoiceData.invoiceNumber} (${invoiceData.totalAmount.toLocaleString('vi-VN')}đ).`,
      newValue: {
        txnRef: vnpTxnRef,
        invoiceNumber: invoiceData.invoiceNumber,
        amount: invoiceData.totalAmount,
        sessionId: session.SessionID,
      },
    };
    if (actorUser) {
      await activityLogService.logStaffAction(actorUser, vnpLogPayload);
    } else {
      await activityLogService.logGuestAction({
        restaurantId: session.RestaurantID || 1,
        actorName: `Khách tại ${session.TableName || `bàn #${session.TableID}`}`,
        ...vnpLogPayload,
      });
    }

    return {
      paymentUrl,
      txnRef: vnpTxnRef,
      paymentId: invoiceData.paymentId,
      invoiceId: invoiceData.invoiceId,
      invoiceNumber: invoiceData.invoiceNumber,
      amount: invoiceData.totalAmount,
      tableName: session.TableName,
    };
  });
};

/**
 * Xử lý kết quả giao dịch VNPay trực tiếp trên bảng payment gốc trong DB Transaction.
 */
const processVnpayResultInTransaction = async (vnpData, source = 'IPN', deps = {}) => {
  const dbPool = deps.pool || pool;
  const pModel = deps.paymentModel || paymentModel;
  const sModel = deps.sessionModel || sessionModel;
  const config = vnpayService.getVnpConfig();

  const vnpTmnCode = String(vnpData?.vnp_TmnCode || '').trim();
  const vnpTxnRef = String(vnpData?.vnp_TxnRef || '').trim();
  const vnpResponseCode = String(vnpData?.vnp_ResponseCode || '').trim();
  const vnpTransactionStatus = String(vnpData?.vnp_TransactionStatus || '').trim();
  const vnpTransactionNo = vnpData?.vnp_TransactionNo ? String(vnpData.vnp_TransactionNo).trim() : null;
  const vnpBankCode = vnpData?.vnp_BankCode ? String(vnpData.vnp_BankCode).trim() : null;

  if (!vnpTxnRef) {
    return { RspCode: '01', Message: 'Order not found' };
  }

  if (config.tmnCode && vnpTmnCode && vnpTmnCode !== config.tmnCode) {
    console.warn(`[VNPAY_${source}] TmnCode không khớp: ${vnpTmnCode}`);
    return { RspCode: '99', Message: 'Invalid TmnCode' };
  }

  const receivedAmountVnp = vnpayService.parseVnpInteger(vnpData?.vnp_Amount);
  if (receivedAmountVnp === null) {
    return { RspCode: '04', Message: 'Invalid amount' };
  }

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const tx = await pModel.findPaymentByTxnRef(vnpTxnRef, { forUpdate: true }, conn);
    if (!tx) {
      await conn.rollback();
      return { RspCode: '01', Message: 'Order not found' };
    }

    const expectedAmountVnp = BigInt(tx.AmountVnp);
    if (receivedAmountVnp !== expectedAmountVnp) {
      await conn.rollback();
      console.warn(`[VNPAY_${source}] Lệch số tiền cho ${vnpTxnRef}: expected=${expectedAmountVnp}, got=${receivedAmountVnp}`);
      return { RspCode: '04', Message: 'Invalid amount' };
    }

    if (tx.PaymentStatus === PAYMENT_STATUS.PAID) {
      await conn.rollback();
      return { RspCode: '02', Message: 'Order already confirmed' };
    }

    const isSuccess = vnpResponseCode === '00' && vnpTransactionStatus === '00';

    if (!isSuccess) {
      const failStatus = vnpResponseCode === '24' ? VNPAY_TX_STATUS.CANCELLED : VNPAY_TX_STATUS.FAILED;
      const failNote = `[REF:${vnpTxnRef}] VNPay ${failStatus} (Mã phản hồi: ${vnpResponseCode})`;
      await pModel.markPaymentFailedIfPending(tx.PaymentID, failNote, conn);

      await conn.commit();
      const logger = deps.activityLog || (deps.pool ? null : activityLogService);
      if (logger) {
        await logger.logSystemAction({
          branchId: tx.BranchID ?? null,
          actorName: source === 'QUERYDR' && deps.actorUser
            ? `${deps.actorUser.fullName || deps.actorUser.username || 'Thu ngân'}`
            : `VNPay ${source}`,
          actorType: source === 'QUERYDR' && deps.actorUser ? deps.actorUser.roleCode : 'System',
          staffId: source === 'QUERYDR' && deps.actorUser ? deps.actorUser.staffId : null,
          entityType: 'Payment',
          entityId: tx.PaymentID,
          action: 'VNPAY_IPN_FAILED',
          severity: LOG_SEVERITY.WARNING,
          description: `Giao dịch VNPay ${vnpTxnRef} (${failStatus}, mã ${vnpResponseCode}) cho hóa đơn ${tx.InvoiceNumber}.`,
          newValue: { txnRef: vnpTxnRef, resultStatus: failStatus, responseCode: vnpResponseCode },
        });
      }
      return { RspCode: '00', Message: 'Confirm Success', resultStatus: failStatus };
    }

    const successNote = `[REF:${vnpTxnRef}] Thanh toán VNPay thành công${vnpBankCode ? ` (${vnpBankCode})` : ''} - Mã GD: ${vnpTransactionNo || vnpTxnRef}`;
    await pModel.completePayment(
      tx.PaymentID,
      PAYMENT_STATUS.PAID,
      vnpTransactionNo || vnpTxnRef,
      PAYMENT_METHOD.VNPAY,
      successNote,
      conn
    );

    await sModel.updateSessionStatus(tx.SessionID, SESSION_STATUS.CLOSED, conn);

    await conn.commit();
    const logger = deps.activityLog || (deps.pool ? null : activityLogService);
    if (logger) {
      const logPayload = {
        branchId: tx.BranchID ?? null,
        entityType: 'Payment',
        entityId: tx.PaymentID,
        action: 'VNPAY_IPN_PAID',
        severity: LOG_SEVERITY.CRITICAL,
        description: `VNPay (${source}) xác nhận thanh toán thành công ${vnpTxnRef} cho ${tx.InvoiceNumber} (${parseFloat(tx.Amount).toLocaleString('vi-VN')}đ) và đóng Phiên #${tx.SessionID}.`,
        oldValue: { paymentStatus: tx.PaymentStatus },
        newValue: {
          paymentStatus: PAYMENT_STATUS.PAID,
          txnRef: vnpTxnRef,
          bankTransactionNo: vnpTransactionNo || null,
          bankCode: vnpBankCode || null,
          amount: parseFloat(tx.Amount),
        },
      };
      if (source === 'QUERYDR' && deps.actorUser) {
        await logger.logStaffAction(deps.actorUser, logPayload);
      } else {
        await logger.logSystemAction({ actorName: `VNPay ${source}`, ...logPayload });
      }
    }
    return { RspCode: '00', Message: 'Confirm Success', resultStatus: VNPAY_TX_STATUS.SUCCESS };
  } catch (err) {
    await conn.rollback();
    console.error(`[VNPAY_${source}_ERROR] TxnRef=${vnpTxnRef}:`, err.message);
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * Xử lý IPN từ máy chủ VNPay.
 */
const handleVnpayIpn = async (queryParams) => {
  try {
    if (!vnpayService.verifySignature(queryParams)) {
      return { RspCode: '97', Message: 'Invalid signature' };
    }
    return await processVnpayResultInTransaction(queryParams, 'IPN');
  } catch (_err) {
    return { RspCode: '99', Message: 'Unknown error' };
  }
};

/**
 * Xử lý Return URL (CHỈ xác minh chữ ký và đọc trạng thái để hiển thị, KHÔNG tự chốt PAID).
 */
const handleVnpayReturn = async (queryParams) => {
  const signatureValid = vnpayService.verifySignature(queryParams);
  const txnRef = String(queryParams?.vnp_TxnRef || '').trim();
  const vnpResponseCode = String(queryParams?.vnp_ResponseCode || '').trim();

  if (!txnRef) {
    return {
      signatureValid: false,
      txnRef: null,
      vnpResponseCode,
      status: 'INVALID',
      message: 'Thiếu mã giao dịch.',
    };
  }

  const tx = await paymentModel.findPaymentByTxnRef(txnRef);
  if (!tx) {
    return {
      signatureValid,
      txnRef,
      vnpResponseCode,
      status: 'NOT_FOUND',
      message: 'Không tìm thấy giao dịch trong hệ thống.',
    };
  }

  return {
    signatureValid,
    txnRef: tx.VnpTxnRef,
    vnpResponseCode,
    status: tx.Status,
    paymentStatus: tx.PaymentStatus,
    paymentId: tx.PaymentID,
    invoiceNumber: tx.InvoiceNumber,
    tableName: tx.TableName,
    amount: parseFloat(tx.Amount),
    vnpTransactionNo: tx.TransactionNo || queryParams?.vnp_TransactionNo || null,
    vnpBankCode: queryParams?.vnp_BankCode || null,
    vnpPayDate: queryParams?.vnp_PayDate || null,
  };
};

/**
 * Lấy trạng thái giao dịch VNPay / MoMo trực tiếp từ bảng payment gốc.
 */
const getVnpayStatus = async ({ txnRef, sessionToken = null, actorUser = null }) => {
  if (!txnRef) throw httpError('Mã giao dịch (txnRef) là bắt buộc.', 400);

  let tx = await paymentModel.findPaymentByTxnRef(txnRef);
  if (!tx) throw httpError('Không tìm thấy giao dịch.', 404);

  if (actorUser) {
    if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && tx.BranchID !== actorUser.branchId) {
      throw httpError('Bạn không có quyền xem giao dịch của chi nhánh khác.', 403);
    }
  } else {
    if (!sessionToken || tx.SessionToken !== sessionToken) {
      throw httpError('Không có quyền truy cập thông tin giao dịch này.', 403);
    }
  }

  const config = vnpayService.getVnpConfig();
  const createdTime = new Date(tx.CreatedAt).getTime();
  const isPendingTimedOut =
    tx.Status === VNPAY_TX_STATUS.PENDING &&
    Date.now() - createdTime > config.pendingTimeoutMinutes * 60 * 1000;

  return {
    txnRef: tx.VnpTxnRef,
    provider: tx.PaymentMethod === 'BANK_TRANSFER' ? 'SEPAY' : (tx.PaymentMethod || 'VNPAY'),
    paymentId: tx.PaymentID,
    invoiceId: tx.InvoiceID,
    invoiceNumber: tx.InvoiceNumber,
    tableName: tx.TableName,
    amount: parseFloat(tx.Amount),
    paymentMethod: tx.PaymentMethod,
    status: tx.Status,
    paymentStatus: tx.PaymentStatus,
    sessionStatus: tx.SessionStatus,
    needReconcile: false,
    reconcileNote: tx.Note || null,
    vnpTransactionNo: tx.TransactionNo,
    vnpBankCode: tx.PaymentMethod === 'BANK_TRANSFER' ? 'MBBank' : 'VNPAY',
    vnpCardType: 'QR',
    vnpResponseCode: tx.PaymentStatus === PAYMENT_STATUS.PAID ? '00' : null,
    vnpPayDate: tx.PaidAt,
    createdAt: tx.CreatedAt,
    ipnReceivedAt: tx.PaidAt,
    processedAt: tx.PaidAt,
    isPendingTimedOut,
  };
};

/**
 * Thu ngân / Quản lý chủ động truy vấn VNPay querydr cho giao dịch PENDING chậm IPN.
 */
const queryVnpayTransaction = async ({ txnRef, actorUser, ipAddr = '127.0.0.1' }) => {
  if (!txnRef) throw httpError('Mã giao dịch (txnRef) là bắt buộc.', 400);

  const tx = await paymentModel.findPaymentByTxnRef(txnRef);
  if (!tx) throw httpError('Không tìm thấy giao dịch.', 404);

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && tx.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền đối soát giao dịch của chi nhánh khác.', 403);
  }

  const transactionDate = vnpayService.formatVnpDate(new Date(tx.CreatedAt));
  const queryResult = await vnpayService.queryTransaction({
    txnRef: tx.VnpTxnRef,
    transactionDate,
    orderInfo: `Doi soat giao dich ${tx.VnpTxnRef}`,
    ipAddr,
  });

  if (
    queryResult?.vnp_ResponseCode === '00' &&
    tx.Status === VNPAY_TX_STATUS.PENDING &&
    (queryResult.vnp_TransactionStatus === '00' || queryResult.vnp_TransactionStatus === '02')
  ) {
    await processVnpayResultInTransaction(
      {
        ...queryResult,
        vnp_TmnCode: queryResult.vnp_TmnCode || vnpayService.getVnpConfig().tmnCode,
        vnp_TxnRef: tx.VnpTxnRef,
        vnp_Amount: queryResult.vnp_Amount || String(tx.AmountVnp),
        vnp_ResponseCode: queryResult.vnp_TransactionStatus === '00' ? '00' : '99',
      },
      'QUERYDR',
      { actorUser }
    );
  }

  return await getVnpayStatus({ txnRef: tx.VnpTxnRef, actorUser });
};

/**
 * Lấy danh sách giao dịch trực tuyến từ bảng payment.
 */
const listVnpayTransactions = async ({ invoiceId = null, branchId = null, status = null, actorUser }) => {
  const targetBranchId = actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN
    ? (branchId ? parseInt(branchId, 10) : null)
    : actorUser.branchId;

  return await paymentModel.findVnpayTransactions({
    invoiceId: invoiceId ? parseInt(invoiceId, 10) : null,
    branchId: targetBranchId,
    status: status || null,
  });
};

/**
 * Tạo link ảnh VietQR chuẩn SePay cho MB Bank (hoặc ngân hàng cấu hình trong .env).
 */
const buildVietQrWithCode = ({ amount, code }) => {
  const bankId = (process.env.VIETQR_BANK_ID || 'MBBank').trim();
  const accountNo = (process.env.VIETQR_ACCOUNT_NO || 'VQRQANXJH4626').trim();
  const accountName = (process.env.VIETQR_ACCOUNT_NAME || 'LE QUANG HUY').trim();
  const amountInt = Math.round(Number(amount || 0));
  const params = new URLSearchParams({
    acc: accountNo,
    bank: bankId,
    amount: String(amountInt),
    des: code,
  });
  return {
    bankId,
    accountNo,
    accountName,
    transferContent: code,
    qrUrl: `https://qr.sepay.vn/img?${params.toString()}`,
  };
};

/**
 * Tạo giao dịch thanh toán chuyển khoản VietQR (MB Bank) tự động xác nhận qua SePay Webhook.
 * Lưu mã BBQ{PaymentID} trực tiếp vào bảng payment gốc (không cần bảng paymenttransaction).
 */
const createSepayPayment = async ({
  sessionToken = null,
  sessionId = null,
  orderId = null,
  promotionId = null,
  actorUser = null,
}) => {
  let session;
  let effectiveActor = actorUser;

  if (actorUser) {
    let targetSessionId = sessionId;
    if (!targetSessionId && orderId) {
      const order = await orderModel.findOrderWithLines(orderId);
      if (order) targetSessionId = order.SessionID;
    }
    if (!targetSessionId) throw httpError('sessionId hoặc orderId là bắt buộc.', 400);
    session = await sessionModel.findSessionById(targetSessionId);
    if (!session) throw httpError('Không tìm thấy phiên bàn.', 404);
    if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && session.BranchID !== actorUser.branchId) {
      throw httpError('Bạn không có quyền thao tác trên phiên của chi nhánh khác.', 403);
    }
  } else {
    if (!sessionToken) throw httpError('Thiếu sessionToken để xác thực phiên bàn.', 401);
    session = await sessionModel.findSessionByToken(sessionToken);
    if (!session) throw httpError('sessionToken không hợp lệ hoặc phiên không tồn tại.', 403);
    effectiveActor = {
      roleCode: ROLE_CODE.RESTAURANT_ADMIN,
      branchId: session.BranchID,
      restaurantId: session.RestaurantID || 1,
    };
  }

  if (session.Status === SESSION_STATUS.CLOSED) {
    throw httpError('Phiên bàn này đã đóng, không thể tạo giao dịch mới.', 409);
  }
  if (session.Status !== SESSION_STATUS.OPEN) {
    throw httpError('Phiên bàn chưa ở trạng thái đang phục vụ.', 409);
  }

  return withSessionPaymentLock(session.SessionID, async () => {
    const existing = await paymentModel.findInvoiceBySessionId(session.SessionID);
    if (existing && existing.PaymentStatus === PAYMENT_STATUS.PAID) {
      throw httpError('Hóa đơn của phiên này đã được thanh toán thành công.', 409);
    }

    if (!existing) {
      await prepareSessionForPayment(session.SessionID, actorUser || null);
      await orderModel.updateAllOrdersStatusInSession(session.SessionID, 3);
    }

    const invoiceData = await ensureInvoiceAndPayment(
      session.SessionID,
      effectiveActor,
      promotionId || null,
      PAYMENT_METHOD.BANK_TRANSFER
    );

    if (invoiceData.status === PAYMENT_STATUS.PAID) {
      throw httpError('Hóa đơn của phiên này đã được thanh toán thành công.', 409);
    }

    const sepayCode = `BBQ${invoiceData.paymentId}`;
    const orderInfo = `Chuyen khoan SePay ${sepayCode} hoa don ${invoiceData.invoiceNumber} ban ${session.TableName || session.SessionID}`;

    await paymentModel.saveGatewayTransactionToPayment({
      paymentId: invoiceData.paymentId,
      provider: PAYMENT_METHOD.BANK_TRANSFER,
      txnRef: sepayCode,
      orderInfo,
    });

    const vietQr = buildVietQrWithCode({ amount: invoiceData.totalAmount, code: sepayCode });

    const sepayLogPayload = {
      branchId: session.BranchID,
      entityType: 'Payment',
      entityId: invoiceData.paymentId,
      action: 'SEPAY_CREATE',
      severity: LOG_SEVERITY.INFO,
      description: `Khởi tạo VietQR SePay ${sepayCode} cho ${invoiceData.invoiceNumber} (${invoiceData.totalAmount.toLocaleString('vi-VN')}đ).`,
      newValue: {
        txnRef: sepayCode,
        invoiceNumber: invoiceData.invoiceNumber,
        amount: invoiceData.totalAmount,
        sessionId: session.SessionID,
      },
    };
    if (actorUser) {
      await activityLogService.logStaffAction(actorUser, sepayLogPayload);
    } else {
      await activityLogService.logGuestAction({
        restaurantId: session.RestaurantID || 1,
        actorName: `Khách tại ${session.TableName || `bàn #${session.TableID}`}`,
        ...sepayLogPayload,
      });
    }

    return {
      txnRef: sepayCode,
      transferCode: sepayCode,
      paymentId: invoiceData.paymentId,
      invoiceId: invoiceData.invoiceId,
      invoiceNumber: invoiceData.invoiceNumber,
      amount: invoiceData.totalAmount,
      tableName: session.TableName,
      qrImageUrl: vietQr.qrUrl,
      vietQr,
    };
  });
};

/**
 * Xử lý Webhook từ SePay khi có tiền chuyển vào tài khoản MB Bank.
 * Lưu trực tiếp vào bảng payment gốc (Status = 1 - PAID) và đóng phiên bàn.
 */
const handleSepayWebhook = async (authHeader, payload = {}, deps = {}) => {
  const dbPool = deps.pool || pool;
  const pModel = deps.paymentModel || paymentModel;
  const sModel = deps.sessionModel || sessionModel;

  const configuredKey = (process.env.SEPAY_WEBHOOK_API_KEY || '').trim();
  if (configuredKey && authHeader) {
    const expectedHeader = `Apikey ${configuredKey}`;
    if (String(authHeader).trim() !== expectedHeader && String(authHeader).trim() !== configuredKey) {
      throw httpError('Unauthorized SePay Webhook API Key.', 401);
    }
  }

  const transferType = String(payload?.transferType || 'in').trim().toLowerCase();
  if (transferType !== 'in') {
    return { matched: false, message: 'Ignored non-incoming transaction.' };
  }

  const rawText = `${payload?.code || ''} ${payload?.content || ''} ${payload?.description || ''}`.toUpperCase();
  const match = rawText.match(/BBQ(?:PAY)?\d+(?:R\d+)?/);
  if (!match) {
    return { matched: false, message: 'No BBQ payment code found in content.' };
  }

  const rawCode = match[0];
  const idMatch = rawCode.match(/\d+/);
  const sepayCode = idMatch ? `BBQ${idMatch[0]}` : rawCode;
  const bankRef = payload?.referenceCode ? String(payload.referenceCode).trim() : `SEPAY-${payload?.id || Date.now()}`;
  const gateway = payload?.gateway ? String(payload.gateway).trim() : 'MBBank';
  const transferAmount = Math.round(Number(payload?.transferAmount || payload?.amount || 0));

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const tx = await pModel.findPaymentByTxnRef(sepayCode, { forUpdate: true }, conn);
    if (!tx) {
      await conn.rollback();
      return { matched: false, message: `Order code ${sepayCode} not found.` };
    }

    if (tx.PaymentStatus === PAYMENT_STATUS.PAID) {
      await conn.rollback();
      return { matched: true, alreadyConfirmed: true, txnRef: sepayCode, paymentId: tx.PaymentID };
    }

    const expectedAmount = Math.round(Number(tx.Amount));
    if (transferAmount > 0 && transferAmount < expectedAmount) {
      await conn.rollback();
      return {
        matched: true,
        underpaid: true,
        message: `Chuyển thiếu tiền qua SePay: nhận ${transferAmount}đ, cần ${expectedAmount}đ.`,
      };
    }

    const successNote = `[REF:${sepayCode}] Thanh toán SePay (${gateway}) thành công - Mã GD: ${bankRef}`;
    await pModel.completePayment(
      tx.PaymentID,
      PAYMENT_STATUS.PAID,
      bankRef,
      PAYMENT_METHOD.BANK_TRANSFER,
      successNote,
      conn
    );

    await sModel.updateSessionStatus(tx.SessionID, SESSION_STATUS.CLOSED, conn);

    await conn.commit();
    const logger = deps.activityLog || (deps.pool ? null : activityLogService);
    if (logger) {
      await logger.logSystemAction({
        branchId: tx.BranchID ?? null,
        actorName: `SePay Webhook (${gateway})`,
        entityType: 'Payment',
        entityId: tx.PaymentID,
        action: 'SEPAY_WEBHOOK_PAID',
        severity: LOG_SEVERITY.CRITICAL,
        description: `SePay Webhook (${gateway}) xác nhận nhận ${transferAmount || expectedAmount}đ cho ${sepayCode} (${tx.InvoiceNumber}) và đóng Phiên #${tx.SessionID}.`,
        oldValue: { paymentStatus: tx.PaymentStatus },
        newValue: {
          paymentStatus: PAYMENT_STATUS.PAID,
          txnRef: sepayCode,
          bankRef,
          gateway,
          amount: transferAmount || expectedAmount,
          invoiceNumber: tx.InvoiceNumber,
        },
      });
    }
    console.log(`[SEPAY_WEBHOOK] ✅ Xác nhận thanh toán thành công ${sepayCode} (${transferAmount}đ) qua ${gateway}`);
    return { matched: true, success: true, txnRef: sepayCode, paymentId: tx.PaymentID };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = {
  computeTotals,
  previewCheckout,
  customerPreviewCheckout,
  checkoutSession,
  completePayment,
  getInvoiceByPayment,
  createVnpayPayment,
  createSepayPayment,
  handleSepayWebhook,
  processVnpayResultInTransaction,
  handleVnpayIpn,
  handleVnpayReturn,
  getVnpayStatus,
  queryVnpayTransaction,
  listVnpayTransactions,
};
