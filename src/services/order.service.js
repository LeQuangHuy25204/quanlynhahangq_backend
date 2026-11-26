'use strict';

const { pool }   = require('../config/db');
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

  // ── Kiểm tra Session ─────────────────────────────────────
  const session = await sessionModel.findSessionByToken(sessionToken);
  if (!session) {
    const err = new Error('Phiên không tồn tại.');
    err.statusCode = 404;
    throw err;
  }

  // restaurantId từ phiên bàn hoặc env (fallback 1)
  const restaurantId = session.RestaurantID || parseInt(process.env.RESTAURANT_ID, 10) || 1;
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

    if (!menuItemId || quantity === undefined || quantity <= 0) {
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
      errors.push(`Món "${menuItem.Name}" hiện đã hết hàng hoặc tạm ngưng phục vụ tại chi nhánh này.`);
      continue;
    }
    if (menuItem.StockQuantity !== null && menuItem.StockQuantity !== undefined) {
      const availQty = parseFloat(menuItem.StockQuantity);
      if (parseFloat(quantity) > availQty) {
        errors.push(`Món "${menuItem.Name}" chỉ còn ${availQty} ${menuItem.Unit || 'phần'}, không đủ số lượng bạn đặt.`);
        continue;
      }
    }

    // Xác định trạng thái theo loại món (Món cân = CHỜ CÂN)
    const isWeightBased = menuItem.IsWeightBased === 1;
    const finalQuantity = quantity; // Use customer's requested quantity
    const lineStatus = isWeightBased
      ? ORDER_LINE_STATUS.WAITING_WEIGH   // Món cân — CHỜ CÂN (Bếp sẽ cân lại và chốt số)
      : ORDER_LINE_STATUS.WAITING_CONFIRM; // Món thường — CHỜ XÁC NHẬN

    orderLinesData.push({
      menuItemId,
      menuItemName: menuItem.Name,
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

  // ── Kiểm tra Order đang chờ thanh toán ──────────────────
  const existingLines = await orderModel.findOrderLinesBySessionId(session.SessionID);
  if (existingLines.some(line => line.OrderStatus === ORDER_STATUS.WAITING_PAYMENT)) {
    const err = new Error('Bàn đã yêu cầu thanh toán, không thể gọi thêm món.');
    err.statusCode = 409;
    throw err;
  }

  // ── Trừ tồn kho nguyên tử + Tạo OrderLines trong DB Transaction ──
  const conn = await pool.getConnection();
  let orderIdToUse;
  try {
    await conn.beginTransaction();

    for (const line of orderLinesData) {
      const stockRes = await menuModel.deductBranchStock(branchId, line.menuItemId, line.quantity, conn);
      if (!stockRes.ok) {
        const err = new Error(`Món "${line.menuItemName}" vừa hết hàng hoặc không đủ số lượng còn lại.`);
        err.statusCode = 409;
        throw err;
      }
    }

    const activeOrder = await orderModel.findActiveOrderByParticipantId(
      session.SessionID,
      parseInt(participantId, 10)
    );

    if (activeOrder) {
      orderIdToUse = activeOrder.OrderID;
    } else {
      const { orderId } = await orderModel.createOrder({
        sessionId:     session.SessionID,
        participantId: parseInt(participantId, 10),
        status:        ORDER_STATUS.PENDING,
      }, conn);
      orderIdToUse = orderId;
    }

    await orderModel.createOrderLines(orderIdToUse, orderLinesData, conn);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const finalOrder = await orderModel.findOrderWithLines(orderIdToUse);

  return {
    order:    finalOrder,
    warnings: errors.length > 0 ? errors : undefined,
  };
};

/**
 * Phục vụ cân món và cập nhật trọng lượng (FR-SRV-05).
 * - Cập nhật Quantity (DECIMAL 10,3).
 * - Đổi trạng thái từ CHỜ CÂN -> ĐÃ XÁC NHẬN (để chuyển sang cột Đã xác nhận chờ In phiếu bếp và chế biến).
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

  // Cập nhật Database + điều chỉnh chênh lệch tồn kho (nếu món cân có quản lý tồn kho)
  const newStatus = ORDER_LINE_STATUS.CONFIRMED;
  const newWeight = parseFloat(weight);
  const oldQty = parseFloat(orderLine.Quantity || 0);
  const delta = oldQty - newWeight; // > 0: cân nhẹ hơn -> hoàn lại; < 0: cân nặng hơn -> trừ thêm

  await orderModel.updateOrderLineQuantityAndStatus(orderLineId, newWeight, newStatus);
  if (delta !== 0 && orderLine.BranchID) {
    await menuModel.adjustBranchStock(orderLine.BranchID, orderLine.MenuItemID, delta);
  }

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
 * Quy tắc trước khi chuyển bàn sang CHỜ THANH TOÁN:
 *  - Phiên phải đang phục vụ (OPEN).
 *  - Phải có món được gọi (không được yêu cầu thanh toán khi chưa có món nào).
 *  - Không được còn món đang chế biến (COOKING - 4).
 *  - Không được còn món đang chờ phục vụ (READY - 5).
 *  - Món đã order nhưng chưa xác nhận (CHỜ XÁC NHẬN / CHỜ CÂN) sẽ bị hủy;
 *    tạm tính tự tính lại vì chỉ tính các món không bị hủy.
 *  - Sau khi hủy món chưa xác nhận, bàn phải còn ít nhất 1 món để thanh toán.
 */
const prepareSessionForPayment = async (sessionId, actorUser = null) => {
  const session = await sessionModel.findSessionById(sessionId);
  if (!session || session.Status !== SESSION_STATUS.OPEN) {
    const err = new Error('Chỉ được yêu cầu thanh toán khi bàn đang phục vụ.');
    err.statusCode = 409;
    throw err;
  }

  const lines = await orderModel.findOrderLinesBySessionId(sessionId);
  const activeLines = lines.filter(l => l.Status !== ORDER_LINE_STATUS.CANCELLED);
  if (activeLines.length === 0) {
    const err = new Error('Bàn chưa có món nào được gọi, không thể yêu cầu thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  if (lines.some(l => l.Status === ORDER_LINE_STATUS.COOKING)) {
    const err = new Error('Còn món đang chế biến, chưa thể yêu cầu thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  if (lines.some(l => l.Status === ORDER_LINE_STATUS.READY)) {
    const err = new Error('Còn món đang chờ phục vụ (bếp đã nấu xong, chưa mang ra bàn), vui lòng phục vụ món trước khi yêu cầu thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  const billableLines = lines.filter(l =>
    l.Status !== ORDER_LINE_STATUS.CANCELLED &&
    l.Status !== ORDER_LINE_STATUS.WAITING_CONFIRM &&
    l.Status !== ORDER_LINE_STATUS.WAITING_WEIGH
  );
  if (billableLines.length === 0) {
    const err = new Error('Bàn chưa có món nào được xác nhận hoặc phục vụ để thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  const unconfirmed = lines.filter(l =>
    l.Status === ORDER_LINE_STATUS.WAITING_CONFIRM || l.Status === ORDER_LINE_STATUS.WAITING_WEIGH
  );
  for (const line of unconfirmed) {
    await orderModel.cancelOrderLine(line.OrderLineID, {
      cancelledBy: actorUser?.staffId ?? null,
      cancelReason: 'Món chưa xác nhận khi yêu cầu thanh toán',
    });
    await menuModel.adjustBranchStock(session.BranchID, line.MenuItemID, parseFloat(line.Quantity || 0));
  }
  return { cancelledCount: unconfirmed.length };
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

  await prepareSessionForPayment(order.SessionID);
  await orderModel.updateAllOrdersStatusInSession(order.SessionID, ORDER_STATUS.WAITING_PAYMENT);

  // [GIẢ LẬP] Bắn socket báo cho thu ngân
  console.log(`[CASHIER_NOTIFY] Bàn có SessionID ${order.SessionID} yêu cầu thanh toán OrderID ${orderId}`);

  return { orderId, status: ORDER_STATUS.WAITING_PAYMENT, message: 'Đã gửi yêu cầu thanh toán tới Thu ngân.' };
};

const staffRequestPayment = async (orderId, actorUser) => {
  const order = await orderModel.findOrderWithLines(orderId);
  if (!order) {
    const err = new Error('Không tìm thấy Order.'); err.statusCode = 404; throw err;
  }
  if (order.Status === ORDER_STATUS.WAITING_PAYMENT) {
    return { orderId, message: 'Đã gửi yêu cầu thanh toán trước đó.' };
  }
  if (order.Status === ORDER_STATUS.CANCELLED) {
    const err = new Error('Đơn hàng này đã bị hủy.'); err.statusCode = 409; throw err;
  }
  const { cancelledCount } = await prepareSessionForPayment(order.SessionID, actorUser);
  await orderModel.updateAllOrdersStatusInSession(order.SessionID, ORDER_STATUS.WAITING_PAYMENT);
  const suffix = cancelledCount ? ` (đã hủy ${cancelledCount} món chưa xác nhận)` : '';
  return { orderId, status: ORDER_STATUS.WAITING_PAYMENT, cancelledCount, message: `Đã báo thu ngân bàn cần thanh toán${suffix}.` };
};

/**
 * Hủy món ăn (FR-SRV-06):
 * - Nhân viên phục vụ (Waiter) & Thu ngân (Cashier):
 *     + Chỉ được trực tiếp hủy các món ở trạng thái TRƯỚC Đang chế biến (0: Chờ xác nhận, 1: Chờ cân, 2: Đã xác nhận).
 *     + Nếu món đã ở trạng thái Đang chế biến trở về sau (4: COOKING, 5: READY, 6: SERVED), Phục vụ / Thu ngân KHÔNG được tự ý hủy mà phải gửi yêu cầu cho Quản lý chi nhánh / Quản trị nhà hàng duyệt.
 * - Quản lý chi nhánh (BranchManager) & Quản trị nhà hàng (RestaurantAdmin):
 *     + Có quyền hủy món ở cả trạng thái Đang chế biến trở về sau (bắt buộc phải điền lý do hủy).
 */
const cancelOrderLine = async (orderLineId, cancelReason, actorUser) => {
  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy dòng món ăn.'); err.statusCode = 404; throw err;
  }

  if (orderLine.Status === ORDER_LINE_STATUS.CANCELLED) {
    const err = new Error('Món này đã bị hủy trước đó.'); err.statusCode = 409; throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  const isManager =
    actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER ||
    actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN;

  // Kiểm tra chi nhánh (BR-18)
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    const isBelong = await orderModel.verifyOrderLineBelongsToBranch(orderLineId, actorUser.branchId);
    if (!isBelong) {
      const err = new Error('Bạn không có quyền hủy món của chi nhánh khác.'); err.statusCode = 403; throw err;
    }
  }

  const isCookingOrLater = [
    ORDER_LINE_STATUS.COOKING,
    ORDER_LINE_STATUS.READY,
    ORDER_LINE_STATUS.SERVED,
  ].includes(orderLine.Status);

  // Nhân viên & Thu ngân chỉ được trực tiếp hủy món TRƯỚC trạng thái Đang chế biến
  if (isCookingOrLater && !isManager) {
    const err = new Error(
      'Nhân viên và Thu ngân chỉ được hủy các món ở trạng thái trước Đang chế biến. Với món đang chế biến trở về sau, cần sự chấp nhận của Quản lý chi nhánh hoặc Quản lý nhà hàng.'
    );
    err.statusCode = 403;
    throw err;
  }

  const cleanReason = cancelReason
    ? String(cancelReason).replace(/^\[YC_HUY\]\s*/i, '').trim()
    : (orderLine.CancelReason ? String(orderLine.CancelReason).replace(/^\[YC_HUY\]\s*/i, '').trim() : '');

  if (!cleanReason) {
    const err = new Error('Vui lòng nhập lý do hủy món.');
    err.statusCode = 400;
    throw err;
  }

  await orderModel.cancelOrderLine(orderLineId, {
    cancelledBy: actorUser.staffId,
    cancelReason: cleanReason,
  });
  if (orderLine.BranchID) {
    await menuModel.adjustBranchStock(orderLine.BranchID, orderLine.MenuItemID, parseFloat(orderLine.Quantity || 0));
  }

  return { orderLineId, status: ORDER_LINE_STATUS.CANCELLED, message: 'Đã hủy món thành công.' };
};

/**
 * Khách hàng bấm hủy món từ màn hình "Món đã gọi":
 * - Nếu món đang ở trạng thái Chờ xác nhận (0) hoặc Chờ cân (1): HỦY TRỰC TIẾP luôn (Status = 3) và hoàn trả tồn kho ngay lập tức.
 * - Nếu món đang ở trạng thái Đã xác nhận (2): Gửi yêu cầu hủy món ([YC_HUY]) xuống bàn để nhân viên phục vụ xác nhận.
 * - Nếu món đang ở trạng thái Đang chế biến (4), Chờ phục vụ (5) hoặc Đã phục vụ (6): Trả về thông báo tùy theo trạng thái và không thể hủy.
 */
const customerRequestCancelLine = async (orderLineId, { sessionToken, cancelReason }) => {
  if (!sessionToken) {
    const err = new Error('Thiếu sessionToken xác thực phiên bàn.'); err.statusCode = 401; throw err;
  }

  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy món ăn.'); err.statusCode = 404; throw err;
  }

  if (orderLine.SessionToken !== sessionToken) {
    const err = new Error('Bạn không có quyền thao tác trên phiên bàn này.'); err.statusCode = 403; throw err;
  }

  if (orderLine.SessionStatus !== SESSION_STATUS.OPEN) {
    const err = new Error('Phiên bàn đã đóng, không thể hủy món.'); err.statusCode = 409; throw err;
  }

  if (orderLine.Status === ORDER_LINE_STATUS.CANCELLED) {
    const err = new Error('Món này đã được hủy.'); err.statusCode = 409; throw err;
  }

  if (orderLine.Status === ORDER_LINE_STATUS.COOKING) {
    const err = new Error(`Món "${orderLine.MenuItemName}" hiện đang được bếp chế biến nên không thể hủy!`);
    err.statusCode = 409;
    throw err;
  }
  if (orderLine.Status === ORDER_LINE_STATUS.READY) {
    const err = new Error(`Món "${orderLine.MenuItemName}" đã chế biến xong và đang chờ mang ra bàn nên không thể hủy!`);
    err.statusCode = 409;
    throw err;
  }
  if (orderLine.Status === ORDER_LINE_STATUS.SERVED) {
    const err = new Error(`Món "${orderLine.MenuItemName}" đã được phục vụ ra bàn nên không thể hủy!`);
    err.statusCode = 409;
    throw err;
  }

  const reasonText = String(cancelReason || 'Khách tự hủy món').replace(/^\[YC_HUY\]\s*/i, '').trim();

  // Trạng thái Chờ xác nhận (0) hoặc Chờ cân (1) -> Khách hàng được HỦY TRỰC TIẾP luôn
  if (
    orderLine.Status === ORDER_LINE_STATUS.WAITING_CONFIRM ||
    orderLine.Status === ORDER_LINE_STATUS.WAITING_WEIGH
  ) {
    await orderModel.cancelOrderLine(orderLineId, {
      cancelledBy: null,
      cancelReason: reasonText || 'Khách tự hủy món khi chờ xác nhận',
    });
    if (orderLine.BranchID) {
      await menuModel.adjustBranchStock(orderLine.BranchID, orderLine.MenuItemID, parseFloat(orderLine.Quantity || 0));
    }

    return {
      orderLineId: Number(orderLineId),
      cancelledDirectly: true,
      status: ORDER_LINE_STATUS.CANCELLED,
      message: `Đã hủy món "${orderLine.MenuItemName}" thành công!`,
    };
  }

  // Trạng thái Đã xác nhận (2) -> Gửi yêu cầu hủy để nhân viên tại bàn kiểm tra và duyệt
  const taggedReason = `[YC_HUY] ${reasonText}`.slice(0, 500);
  await orderModel.setOrderLineCancelRequest(orderLineId, taggedReason);

  return {
    orderLineId: Number(orderLineId),
    cancelRequested: true,
    cancelReason: taggedReason,
    message: `Đã gửi yêu cầu hủy món "${orderLine.MenuItemName}" tới nhân viên phục vụ.`,
  };
};

/**
 * Nhân viên / Thu ngân gửi yêu cầu lên Quản lý chi nhánh / Quản lý nhà hàng để xin duyệt hủy món
 * đang ở trạng thái Đang chế biến trở về sau (kèm lý do bắt buộc).
 */
const staffRequestManagerCancelLine = async (orderLineId, cancelReason, actorUser) => {
  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy dòng món ăn.'); err.statusCode = 404; throw err;
  }

  if (orderLine.Status === ORDER_LINE_STATUS.CANCELLED) {
    const err = new Error('Món này đã được hủy.'); err.statusCode = 409; throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    const isBelong = await orderModel.verifyOrderLineBelongsToBranch(orderLineId, actorUser.branchId);
    if (!isBelong) {
      const err = new Error('Bạn không có quyền thao tác trên món của chi nhánh khác.'); err.statusCode = 403; throw err;
    }
  }

  const reasonText = String(cancelReason || '').replace(/^\[YC_HUY\]\s*/i, '').trim();
  if (!reasonText) {
    const err = new Error('Vui lòng điền lý do xin hủy món để trình Quản lý duyệt.'); err.statusCode = 400; throw err;
  }

  const staffLabel = actorUser.fullName || actorUser.username || 'NV';
  const taggedReason = `[YC_HUY] (${staffLabel} xin Quản lý duyệt hủy) ${reasonText}`.slice(0, 500);
  await orderModel.setOrderLineCancelRequest(orderLineId, taggedReason);

  return {
    orderLineId: Number(orderLineId),
    cancelRequested: true,
    cancelReason: taggedReason,
    message: 'Đã gửi yêu cầu hủy món kèm lý do lên Quản lý chi nhánh / Quản lý nhà hàng duyệt.',
  };
};

/**
 * Nhân viên hoặc Quản lý từ chối yêu cầu hủy món (giữ nguyên món).
 * Nếu món đang ở trạng thái Đang chế biến trở về sau, chỉ Quản lý mới được duyệt/từ chối yêu cầu hủy.
 */
const rejectCancelRequestLine = async (orderLineId, actorUser) => {
  const orderLine = await orderModel.findOrderLineById(orderLineId);
  if (!orderLine) {
    const err = new Error('Không tìm thấy dòng món ăn.'); err.statusCode = 404; throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    const isBelong = await orderModel.verifyOrderLineBelongsToBranch(orderLineId, actorUser.branchId);
    if (!isBelong) {
      const err = new Error('Bạn không có quyền thao tác trên món của chi nhánh khác.'); err.statusCode = 403; throw err;
    }
  }

  await orderModel.setOrderLineCancelRequest(orderLineId, null);

  return {
    orderLineId: Number(orderLineId),
    cancelRequested: false,
    message: 'Đã từ chối yêu cầu hủy món và giữ nguyên món.',
  };
};

const getOrderLinesBySession = async (sessionId) => {
  return await orderModel.findOrderLinesBySessionId(sessionId);
};

/**
 * Nhân viên thêm món mới vào bàn đang phục vụ.
 * Tái sử dụng placeOrder (snapshot giá BR-07) với participant riêng của nhân viên.
 */
const staffAddItems = async (sessionId, items, actorUser) => {
  const session = await sessionModel.findSessionById(sessionId);
  if (!session) {
    const err = new Error('Không tìm thấy phiên bàn.'); err.statusCode = 404; throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && session.BranchID !== actorUser.branchId) {
    const err = new Error('Bạn không có quyền thêm món cho bàn của chi nhánh khác.'); err.statusCode = 403; throw err;
  }

  const staffName = `NV: ${actorUser.fullName || actorUser.username || actorUser.staffId}`;
  let participant = await sessionModel.findParticipantByName(session.SessionID, staffName);
  const participantId = participant
    ? Object.values(participant)[0]
    : await sessionModel.addParticipant({ sessionId: session.SessionID, guestName: staffName });

  return await placeOrder({
    sessionToken: session.SessionToken,
    participantId,
    branchId: session.BranchID,
    items,
  });
};

const getOrdersByBranch = async (branchId, status = null) => {
  return await orderModel.findOrdersByBranch(branchId, status);
};

const trackOrderByToken = async (sessionToken) => {
  const session = await sessionModel.findSessionByToken(sessionToken);
  if (!session) {
    const err = new Error('Phiên không hợp lệ'); err.statusCode = 404; throw err;
  }
  const lines = await orderModel.findOrderLinesBySessionId(session.SessionID);
  
  // Extract the OrderID and Status from the first line
  const orderId = lines.length > 0 ? lines[0].OrderID : null;
  const status = lines.length > 0 ? lines[0].OrderStatus : 0;
  
  return {
    OrderID: orderId, 
    OrderNumber: sessionToken.slice(0, 8).toUpperCase(),
    Status: status,
    SessionStatus: session.Status,
    lines
  };
};

module.exports = { placeOrder, staffAddItems, updateOrderLineWeight, updateOrderLineStatus, prepareSessionForPayment, requestPayment, staffRequestPayment, cancelOrderLine, customerRequestCancelLine, staffRequestManagerCancelLine, rejectCancelRequestLine, getOrderLinesBySession, getOrdersByBranch, trackOrderByToken };
