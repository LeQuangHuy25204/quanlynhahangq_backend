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
const {
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  VNPAY_TX_STATUS,
  ORDER_LINE_STATUS,
  SESSION_STATUS,
  ROLE_CODE,
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
  return withSessionPaymentLock(sessionId, () =>
    ensureInvoiceAndPayment(sessionId, actorUser, promotionId, PAYMENT_METHOD.CASH)
  );
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
  const vnpayTransactions = await paymentModel.findVnpayTransactions({ invoiceId: detail.InvoiceID });
  return { ...detail, lines, vnpayTransactions };
};

/**
 * Tạo giao dịch VNPay (hỗ trợ cả Khách hàng có sessionToken và Thu ngân có JWT).
 * Mỗi lần gọi tạo 1 PaymentTransaction mới với VnpTxnRef duy nhất, không ghi đè lịch sử cũ.
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

    await paymentModel.createPaymentTransaction({
      paymentId: invoiceData.paymentId,
      invoiceId: invoiceData.invoiceId,
      provider: 'VNPAY',
      vnpTxnRef,
      amount: invoiceData.totalAmount,
      amountVnp,
      status: VNPAY_TX_STATUS.PENDING,
      vnpOrderInfo: orderInfo,
      ipAddress: normalizedIp,
    });

    const paymentUrl = vnpayService.buildPaymentUrl({
      txnRef: vnpTxnRef,
      amountVnp,
      orderInfo,
      ipAddr: normalizedIp,
    });

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
 * Xử lý kết quả giao dịch VNPay trong DB Transaction (dùng chung cho IPN và QueryDR).
 * Đảm bảo:
 * - Xác minh TmnCode, TxnRef, số tiền nguyên BigInt, quan hệ 3 bảng.
 * - Idempotent: IPN lặp lại trả RspCode '02'.
 * - Chống thanh toán trùng: nếu Payment đã PAID bởi giao dịch khác -> đánh dấu DUPLICATE_CONFLICT + NeedReconcile = 1.
 * - Atomicity: cập nhật PaymentTransaction, Payment và đóng Session trong 1 transaction.
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
  const vnpBankTranNo = vnpData?.vnp_BankTranNo ? String(vnpData.vnp_BankTranNo).trim() : null;
  const vnpCardType = vnpData?.vnp_CardType ? String(vnpData.vnp_CardType).trim() : null;
  const vnpPayDate = vnpData?.vnp_PayDate ? String(vnpData.vnp_PayDate).trim() : null;

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

  const sanitizedRaw = JSON.stringify(vnpayService.sanitizeLogPayload(vnpData));

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    const tx = await pModel.findTransactionWithLockByTxnRef(vnpTxnRef, { forUpdate: true }, conn);
    if (!tx) {
      await conn.rollback();
      return { RspCode: '01', Message: 'Order not found' };
    }

    // Đối chiếu số tiền bằng số nguyên BigInt (VNĐ * 100), không dùng float
    const expectedAmountVnp = BigInt(tx.AmountVnp);
    if (receivedAmountVnp !== expectedAmountVnp) {
      await conn.rollback();
      console.warn(`[VNPAY_${source}] Lệch số tiền cho ${vnpTxnRef}: expected=${expectedAmountVnp}, got=${receivedAmountVnp}`);
      return { RspCode: '04', Message: 'Invalid amount' };
    }

    // Idempotency: nếu giao dịch này đã được xử lý xong trước đó
    if (tx.Status !== VNPAY_TX_STATUS.PENDING) {
      await conn.rollback();
      return { RspCode: '02', Message: 'Order already confirmed' };
    }

    const isSuccess = vnpResponseCode === '00' && vnpTransactionStatus === '00';

    if (!isSuccess) {
      const failStatus = vnpResponseCode === '24' ? VNPAY_TX_STATUS.CANCELLED : VNPAY_TX_STATUS.FAILED;
      await pModel.updatePaymentTransactionResult(tx.PaymentTransactionID, {
        status: failStatus,
        vnpTransactionNo,
        vnpBankCode,
        vnpBankTranNo,
        vnpCardType,
        vnpResponseCode,
        vnpTransactionStatus,
        vnpPayDate,
        needReconcile: 0,
        rawIpnPayload: sanitizedRaw,
        setIpnReceivedAt: source === 'IPN',
      }, conn);

      // Chỉ chuyển Payment sang FAILED nếu hiện tại đang PENDING (không bao giờ hạ từ PAID xuống FAILED)
      await pModel.markPaymentFailedIfPending(tx.PaymentID, conn);

      await conn.commit();
      return { RspCode: '00', Message: 'Confirm Success', resultStatus: failStatus };
    }

    // Giao dịch báo THÀNH CÔNG (00/00), kiểm tra chống thanh toán trùng cho cùng 1 Invoice
    if (tx.PaymentStatus === PAYMENT_STATUS.PAID) {
      const note = `Giao dịch ${vnpTxnRef} báo thành công trễ sau khi hóa đơn ${tx.InvoiceNumber} đã PAID. Cần đối soát hoàn tiền.`;
      await pModel.updatePaymentTransactionResult(tx.PaymentTransactionID, {
        status: VNPAY_TX_STATUS.DUPLICATE_CONFLICT,
        vnpTransactionNo,
        vnpBankCode,
        vnpBankTranNo,
        vnpCardType,
        vnpResponseCode,
        vnpTransactionStatus,
        vnpPayDate,
        needReconcile: 1,
        reconcileNote: note,
        rawIpnPayload: sanitizedRaw,
        setIpnReceivedAt: source === 'IPN',
      }, conn);

      console.warn(`[VNPAY_DUPLICATE_CONFLICT] ${note}`);
      await conn.commit();
      return { RspCode: '00', Message: 'Confirm Success', resultStatus: VNPAY_TX_STATUS.DUPLICATE_CONFLICT };
    }

    // Hợp lệ hoàn toàn: cập nhật PaymentTransaction -> Payment PAID -> đóng Session trong cùng Transaction
    await pModel.updatePaymentTransactionResult(tx.PaymentTransactionID, {
      status: VNPAY_TX_STATUS.SUCCESS,
      vnpTransactionNo,
      vnpBankCode,
      vnpBankTranNo,
      vnpCardType,
      vnpResponseCode,
      vnpTransactionStatus,
      vnpPayDate,
      needReconcile: 0,
      rawIpnPayload: sanitizedRaw,
      setIpnReceivedAt: source === 'IPN',
    }, conn);

    await pModel.completePayment(
      tx.PaymentID,
      PAYMENT_STATUS.PAID,
      vnpTransactionNo || vnpTxnRef,
      PAYMENT_METHOD.VNPAY,
      conn
    );

    await sModel.updateSessionStatus(tx.SessionID, SESSION_STATUS.CLOSED, conn);

    await conn.commit();
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

  const tx = await paymentModel.findTransactionWithLockByTxnRef(txnRef);
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
    vnpTransactionNo: tx.VnpTransactionNo || queryParams?.vnp_TransactionNo || null,
    vnpBankCode: tx.VnpBankCode || queryParams?.vnp_BankCode || null,
    vnpPayDate: tx.VnpPayDate || queryParams?.vnp_PayDate || null,
  };
};

/**
 * Lấy trạng thái giao dịch VNPay (hỗ trợ poll từ trang kết quả của khách hoặc màn hình Thu ngân).
 */
const getVnpayStatus = async ({ txnRef, sessionToken = null, actorUser = null }) => {
  if (!txnRef) throw httpError('Mã giao dịch (txnRef) là bắt buộc.', 400);

  const tx = await paymentModel.findTransactionWithLockByTxnRef(txnRef);
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
    paymentId: tx.PaymentID,
    invoiceId: tx.InvoiceID,
    invoiceNumber: tx.InvoiceNumber,
    tableName: tx.TableName,
    amount: parseFloat(tx.Amount),
    paymentMethod: tx.PaymentMethod,
    status: tx.Status,
    paymentStatus: tx.PaymentStatus,
    sessionStatus: tx.SessionStatus,
    needReconcile: Boolean(tx.NeedReconcile),
    reconcileNote: tx.ReconcileNote || null,
    vnpTransactionNo: tx.VnpTransactionNo,
    vnpBankCode: tx.VnpBankCode,
    vnpCardType: tx.VnpCardType,
    vnpResponseCode: tx.VnpResponseCode,
    vnpPayDate: tx.VnpPayDate,
    createdAt: tx.CreatedAt,
    ipnReceivedAt: tx.IpnReceivedAt,
    processedAt: tx.ProcessedAt,
    isPendingTimedOut,
  };
};

/**
 * Thu ngân / Quản lý chủ động truy vấn VNPay querydr cho giao dịch PENDING chậm IPN.
 */
const queryVnpayTransaction = async ({ txnRef, actorUser, ipAddr = '127.0.0.1' }) => {
  if (!txnRef) throw httpError('Mã giao dịch (txnRef) là bắt buộc.', 400);

  const tx = await paymentModel.findTransactionWithLockByTxnRef(txnRef);
  if (!tx) throw httpError('Không tìm thấy giao dịch.', 404);

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && tx.BranchID !== actorUser.branchId) {
    throw httpError('Bạn không có quyền đối soát giao dịch của chi nhánh khác.', 403);
  }

  const transactionDate = vnpayService.formatVnpDate(new Date(tx.CreatedAt));
  const queryResult = await vnpayService.queryTransaction({
    txnRef: tx.VnpTxnRef,
    transactionDate,
    orderInfo: tx.VnpOrderInfo || `Doi soat giao dich ${tx.VnpTxnRef}`,
    ipAddr,
  });

  await paymentModel.updateTransactionLastQueryAt(tx.PaymentTransactionID);

  // Nếu VNPay trả kết quả xác thực (RspCode = 00) và giao dịch đã có kết quả cuối (00: thành công, 02: lỗi)
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
      'QUERYDR'
    );
  }

  return await getVnpayStatus({ txnRef: tx.VnpTxnRef, actorUser });
};

/**
 * Lấy danh sách giao dịch VNPay để đối soát.
 */
const listVnpayTransactions = async ({ invoiceId = null, branchId = null, status = null, needReconcile = null, actorUser }) => {
  const targetBranchId = actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN
    ? (branchId ? parseInt(branchId, 10) : null)
    : actorUser.branchId;

  return await paymentModel.findVnpayTransactions({
    invoiceId: invoiceId ? parseInt(invoiceId, 10) : null,
    branchId: targetBranchId,
    status: status || null,
    needReconcile,
  });
};

module.exports = {
  computeTotals,
  previewCheckout,
  customerPreviewCheckout,
  checkoutSession,
  completePayment,
  getInvoiceByPayment,
  createVnpayPayment,
  processVnpayResultInTransaction,
  handleVnpayIpn,
  handleVnpayReturn,
  getVnpayStatus,
  queryVnpayTransaction,
  listVnpayTransactions,
};
