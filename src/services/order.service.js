'use strict';

const orderModel   = require('../models/order.model');
const menuModel    = require('../models/menu.model');
const sessionModel = require('../models/session.model');
const { ORDER_STATUS, ORDER_LINE_STATUS, SESSION_STATUS } = require('../constants/status');

/**
 * Đặt món — luồng nghiệp vụ cốt lõi.
 *
 * Hệ thống 1 nhà hàng: restaurantId lấy từ process.env.RESTAURANT_ID.
 * Client chỉ cần truyền: sessionToken, participantId, branchId, items.
 *
 * Quy tắc BR-07 (Price Snapshot):
 *   Lấy giá hiện tại (BasePrice hoặc OverridePrice) và lưu vào UnitPrice
 *   của OrderLine ngay tại thời điểm đặt. Sau này không query lại menu.
 *
 * @param {object} payload
 *   - sessionToken:  string
 *   - participantId: number
 *   - branchId:      number   ← cách ly chi nhánh
 *   - items:         [{ menuItemId, quantity, note? }]
 */
const placeOrder = async ({ sessionToken, participantId, items, branchId }) => {
  if (!sessionToken || !participantId || !items || items.length === 0 || !branchId) {
    const err = new Error('sessionToken, participantId, branchId và items là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  // restaurantId cố định từ env
  const restaurantId = parseInt(process.env.RESTAURANT_ID, 10);

  // ── Kiểm tra Session ─────────────────────────────────────
  const session = await sessionModel.findSessionByToken(sessionToken);
  if (!session) {
    const err = new Error('Phiên không tồn tại.');
    err.statusCode = 404;
    throw err;
  }
  if (session.Status !== SESSION_STATUS.OPEN) {
    const err = new Error(
      session.Status === SESSION_STATUS.WAITING_OPEN
        ? 'Phiên chưa được nhân viên mở bàn. Vui lòng chờ.'
        : 'Phiên đã đóng, không thể đặt thêm món.'
    );
    err.statusCode = 409;
    throw err;
  }
  if (session.BranchID !== parseInt(branchId, 10)) {
    const err = new Error('Phiên không thuộc chi nhánh này.');
    err.statusCode = 403;
    throw err;
  }

  // ── BR-07: Snapshot giá từng món ─────────────────────────
  const orderLinesData = [];
  const errors         = [];

  for (const item of items) {
    const { menuItemId, quantity, note } = item;

    if (!menuItemId || !quantity || quantity <= 0) {
      errors.push(`Dữ liệu không hợp lệ cho menuItemId ${menuItemId}.`);
      continue;
    }

    // Lấy giá HIỆN TẠI: ưu tiên OverridePrice, fallback BasePrice
    const menuItem = await menuModel.getCurrentPriceForBranch(menuItemId, branchId, restaurantId);

    if (!menuItem) {
      errors.push(`Món #${menuItemId} không tồn tại.`);
      continue;
    }
    if (!menuItem.IsAvailable) {
      errors.push(`Món "${menuItem.Name}" hiện không khả dụng tại chi nhánh này.`);
      continue;
    }

    // Xác định trạng thái và số lượng theo loại món (Món cân = quantity 0)
    const isWeightBased = menuItem.IsWeightBased === 1;
    const finalQuantity = isWeightBased ? 0 : quantity;
    const lineStatus = isWeightBased
      ? ORDER_LINE_STATUS.WAITING_WEIGH   // Món cân — CHỜ CÂN
      : ORDER_LINE_STATUS.WAITING_CONFIRM; // Món thường — CHỜ XÁC NHẬN

    orderLinesData.push({
      menuItemId,
      quantity: finalQuantity,
      unitPrice: parseFloat(menuItem.FinalPrice), // ← SNAPSHOT GIÁ (BR-07)
      note,
      status: lineStatus,
    });
  }

  if (errors.length > 0 && orderLinesData.length === 0) {
    const err = new Error(`Không thể tạo đơn: ${errors.join('; ')}`);
    err.statusCode = 422;
    throw err;
  }

  // ── Tạo hoặc Lấy Order đang mở ────────────────────────────
  let activeOrder = await orderModel.findActiveOrderByParticipantId(
    session.SessionID,
    parseInt(participantId, 10)
  );

  let orderIdToUse;
  if (activeOrder) {
    orderIdToUse = activeOrder.OrderID;
  } else {
    const { orderId } = await orderModel.createOrder({
      sessionId:     session.SessionID,
      participantId: parseInt(participantId, 10),
      status:        ORDER_STATUS.PENDING,
    });
    orderIdToUse = orderId;
  }

  await orderModel.createOrderLines(orderIdToUse, orderLinesData);

  const finalOrder = await orderModel.findOrderWithLines(orderIdToUse);

  return {
    order:    finalOrder,
    warnings: errors.length > 0 ? errors : undefined,
  };
};

/**
 * Phục vụ cân món và cập nhật trọng lượng (FR-SRV-05).
 * - Cập nhật Quantity (DECIMAL 10,3).
 * - Đổi trạng thái từ CHỜ CÂN -> ĐANG CHẾ BIẾN.
 * - Gọi giả lập inPhieuBep().
 *
 * @param {number} orderLineId
 * @param {number} weight - Trọng lượng thập phân (ví dụ: 1.25)
 * @param {object} actorUser - Người đang gọi API (lấy từ JWT)
 */
const updateOrderLineWeight = async (orderLineId, weight, actorUser) => {
  if (weight == null || parseFloat(weight) <= 0) {
    const err = new Error('Khối lượng phải là số lớn hơn 0.');
    err.statusCode = 400;
    throw err;
  }

  // Bảo mật (BR-18): Nhân viên chỉ được cập nhật món ở chi nhánh của mình
  // (Ngoại trừ RestaurantAdmin có thể làm thay)
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    const isBelong = await orderModel.verifyOrderLineBelongsToBranch(orderLineId, actorUser.branchId);
    if (!isBelong) {
      const err = new Error('Bạn không có quyền cập nhật món ăn của chi nhánh khác.');
      err.statusCode = 403;
      throw err;
    }
  }

  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy món ăn trong đơn (OrderLine).');
    err.statusCode = 404;
    throw err;
  }

  // Bắt buộc phải đang ở trạng thái CHỜ CÂN
  if (orderLine.Status !== ORDER_LINE_STATUS.WAITING_WEIGH) {
    const err = new Error('Món ăn không ở trạng thái CHỜ CÂN.');
    err.statusCode = 409;
    throw err;
  }

  // Cập nhật Database
  const newStatus = ORDER_LINE_STATUS.COOKING;
  await orderModel.updateOrderLineQuantityAndStatus(orderLineId, parseFloat(weight), newStatus);

  // [GIẢ LẬP] Gọi hàm in phiếu bếp
  console.log(`[PRINT_KITCHEN_TICKET] In phiếu bếp cho OrderLineID: ${orderLineId}, Khối lượng: ${weight}`);

  return { orderLineId, quantity: parseFloat(weight), status: newStatus };
};

/**
 * Nhân viên bếp/phục vụ cập nhật trạng thái món ăn (ví dụ: Chờ xác nhận -> Đã xác nhận -> Đang chế biến -> ...).
 *
 * @param {number} orderLineId
 * @param {number} status
 * @param {object} actorUser
 */
const updateOrderLineStatus = async (orderLineId, status, actorUser) => {
  const parsedStatus = parseInt(status, 10);
  if (isNaN(parsedStatus) || !Object.values(ORDER_LINE_STATUS).includes(parsedStatus)) {
    const err = new Error('Trạng thái món không hợp lệ.');
    err.statusCode = 400;
    throw err;
  }

  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy dòng món ăn.');
    err.statusCode = 404;
    throw err;
  }

  // Bảo mật (BR-18): Cách ly chi nhánh
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    const isBelong = await orderModel.verifyOrderLineBelongsToBranch(orderLineId, actorUser.branchId);
    if (!isBelong) {
      const err = new Error('Bạn không có quyền cập nhật món ăn của chi nhánh khác.');
      err.statusCode = 403;
      throw err;
    }
  }

  if (orderLine.Status === parsedStatus) {
    return { orderLineId, status: parsedStatus, message: 'Trạng thái món không đổi.' };
  }

  // Tái sử dụng hàm model hiện có
  await orderModel.updateOrderLineQuantityAndStatus(orderLineId, orderLine.Quantity, parsedStatus);
  return { orderLineId, status: parsedStatus, message: 'Cập nhật trạng thái món thành công.' };
};

/**
 * Khách hàng yêu cầu thanh toán.
 * Đổi trạng thái Order sang WAITING_PAYMENT.
 */
const requestPayment = async (orderId, sessionToken) => {
  const order = await orderModel.findOrderWithLines(orderId);
  if (!order) {
    const err = new Error('Không tìm thấy Order.');
    err.statusCode = 404;
    throw err;
  }

  // Khách hàng cần cung cấp sessionToken hợp lệ để gọi API này (tránh người lạ)
  if (order.SessionToken !== sessionToken) {
    const err = new Error('Phiên bàn không hợp lệ.');
    err.statusCode = 403;
    throw err;
  }

  if (order.Status === ORDER_STATUS.WAITING_PAYMENT) {
    return { orderId, message: 'Đã gửi yêu cầu thanh toán trước đó.' };
  }
  
  if (order.Status === ORDER_STATUS.CANCELLED) {
    const err = new Error('Đơn hàng này đã bị hủy.');
    err.statusCode = 409;
    throw err;
  }

  await orderModel.updateAllOrdersStatusInSession(order.SessionID, ORDER_STATUS.WAITING_PAYMENT);

  // [GIẢ LẬP] Bắn socket báo cho thu ngân
  console.log(`[CASHIER_NOTIFY] Bàn có SessionID ${order.SessionID} yêu cầu thanh toán OrderID ${orderId}`);

  return { orderId, status: ORDER_STATUS.WAITING_PAYMENT, message: 'Đã gửi yêu cầu thanh toán tới Thu ngân.' };
};

/**
 * Phục vụ hủy món (FR-SRV-06).
 * - Không được hủy món đang COOKING (4) hoặc đã CANCELLED (3).
 * - Ghi lý do hủy + ID người hủy.
 */
const cancelOrderLine = async (orderLineId, cancelReason, actorUser) => {
  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy dòng món ăn.'); err.statusCode = 404; throw err;
  }

  if (orderLine.Status === ORDER_LINE_STATUS.CANCELLED) {
    const err = new Error('Món này đã bị hủy trước đó.'); err.statusCode = 409; throw err;
  }
  if (orderLine.Status === ORDER_LINE_STATUS.COOKING) {
    const err = new Error('Không thể hủy món đang trong bếp. Hãy liên hệ bếp trưởng.'); err.statusCode = 409; throw err;
  }

  // Bảo mật BR-18
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    const isBelong = await orderModel.verifyOrderLineBelongsToBranch(orderLineId, actorUser.branchId);
    if (!isBelong) {
      const err = new Error('Bạn không có quyền hủy món của chi nhánh khác.'); err.statusCode = 403; throw err;
    }
  }

  await orderModel.cancelOrderLine(orderLineId, {
    cancelledBy: actorUser.staffId,
    cancelReason,
  });

  return { orderLineId, status: ORDER_LINE_STATUS.CANCELLED, message: 'Đã hủy món thành công.' };
};

module.exports = { placeOrder, updateOrderLineWeight, updateOrderLineStatus, requestPayment, cancelOrderLine };
