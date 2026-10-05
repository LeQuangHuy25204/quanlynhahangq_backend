'use strict';

const { pool } = require('../config/db');

/**
 * Tạo Order record.
 * OrderNumber tự sinh theo pattern: ORD-{YYYYMMDD}-{random 6 hex}
 */
const createOrder = async ({ sessionId, participantId, status, createdByStaffId = null }) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
  const orderNumber = `ORD-${dateStr}-${random}`;

  const [result] = await pool.execute(
    `INSERT INTO \`order\` (SessionID, ParticipantID, OrderNumber, Status, CreatedByStaffID)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, participantId, orderNumber, status, createdByStaffId]
  );
  return { orderId: result.insertId, orderNumber };
};

/**
 * Batch insert OrderLines với UnitPrice đã được snapshot (BR-07).
 *
 * QUAN TRỌNG: UnitPrice được truyền vào từ service layer (đã lấy giá hiện tại)
 * và lưu trực tiếp. Model KHÔNG query ngược lại bảng menu để tính giá.
 *
 * @param {number}   orderId
 * @param {Array}    lines - [{ menuItemId, quantity, unitPrice, note, status }]
 */
const createOrderLines = async (orderId, lines) => {
  if (!lines || lines.length === 0) return [];

  const placeholders = lines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, 0.00)').join(', ');
  const values = lines.flatMap(({ menuItemId, promotionId, quantity, unitPrice, note, status }) => [
    orderId, menuItemId, promotionId || null, quantity, unitPrice, quantity * unitPrice, note || null, status,
  ]);

  await pool.execute(
    `INSERT INTO orderline (OrderID, MenuItemID, PromotionID, Quantity, UnitPrice, LineTotal, Note, Status, DiscountApplied)
     VALUES ${placeholders}`,
    values
  );
};

/**
 * Lấy Order kèm OrderLines để trả về response.
 */
const findOrderWithLines = async (orderId) => {
  const [[orderRows], [lineRows]] = await Promise.all([
    pool.execute(
      `SELECT o.OrderID, o.OrderNumber, o.Status, o.CreatedAt,
              o.SessionID, o.ParticipantID, s.SessionToken
       FROM \`order\` o
       INNER JOIN session s ON o.SessionID = s.SessionID
       WHERE o.OrderID = ?`,
      [orderId]
    ),
    pool.execute(
      `SELECT ol.OrderLineID, ol.MenuItemID, mi.Name AS MenuItemName, ol.PromotionID,
              ol.Quantity, ol.UnitPrice, ol.LineTotal, ol.Note, ol.Status, ol.DiscountApplied
       FROM orderline ol
       INNER JOIN menuitem mi ON ol.MenuItemID = mi.MenuItemID
       WHERE ol.OrderID = ?`,
      [orderId]
    ),
  ]);

  if (!orderRows[0]) return null;
  return { ...orderRows[0], lines: lineRows };
};

/**
 * Tìm 1 OrderLine bằng ID.
 */
const findOrderLineById = async (orderLineId) => {
  const [rows] = await pool.execute(
    `SELECT OrderLineID, OrderID, MenuItemID, PromotionID, Quantity, UnitPrice, LineTotal, Note, Status, DiscountApplied
     FROM orderline
     WHERE OrderLineID = ?`,
    [orderLineId]
  );
  return rows[0] || null;
};

/**
 * Kiểm tra OrderLine có thuộc về một chi nhánh cụ thể không (Bảo mật BR-18).
 */
const verifyOrderLineBelongsToBranch = async (orderLineId, branchId) => {
  const [rows] = await pool.execute(
    `SELECT ol.OrderLineID
     FROM orderline ol
     INNER JOIN \`order\` o ON ol.OrderID = o.OrderID
     INNER JOIN session s ON o.SessionID = s.SessionID
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     WHERE ol.OrderLineID = ? AND a.BranchID = ?`,
    [orderLineId, branchId]
  );
  return rows[0] || null;
};

/**
 * Cập nhật số lượng và trạng thái cho 1 OrderLine.
 */
const updateOrderLineQuantityAndStatus = async (orderLineId, quantity, status) => {
  const [result] = await pool.execute(
    `UPDATE orderline
     SET Quantity = ?, LineTotal = ROUND(? * UnitPrice, 2), Status = ?
     WHERE OrderLineID = ?`,
    [quantity, quantity, status, orderLineId]
  );
  return result.affectedRows;
};

/**
 * Tìm Order đang mở (PENDING = 0 hoặc CONFIRMED = 1) của một Participant trong Session.
 */
const findActiveOrderByParticipantId = async (sessionId, participantId) => {
  const [rows] = await pool.execute(
    `SELECT OrderID, OrderNumber, Status
     FROM \`order\`
     WHERE SessionID = ? AND ParticipantID = ? AND Status IN (0, 1)
     LIMIT 1`,
    [sessionId, participantId]
  );
  return rows[0] || null;
};

/**
 * Cập nhật trạng thái của Order.
 */
const updateOrderStatus = async (orderId, status) => {
  const [result] = await pool.execute(
    `UPDATE \`order\` SET Status = ? WHERE OrderID = ?`,
    [status, orderId]
  );
  return result.affectedRows;
};

/**
 * Cập nhật trạng thái của tất cả Order trong 1 Session.
 */
const updateAllOrdersStatusInSession = async (sessionId, status) => {
  const [result] = await pool.execute(
    `UPDATE \`order\` SET Status = ? WHERE SessionID = ?`,
    [status, sessionId]
  );
  return result.affectedRows;
};

/**
 * Hủy một dòng món (ghi lý do và người hủy).
 */
const cancelOrderLine = async (orderLineId, { cancelledBy, cancelReason }) => {
  const [result] = await pool.execute(
    `UPDATE orderline
     SET Status = 3, CancelledAt = NOW(), CancelledBy = ?, CancelReason = ?
     WHERE OrderLineID = ?`,
    [cancelledBy, cancelReason || null, orderLineId]
  );
  return result.affectedRows;
};

/**
 * Tìm tất cả các order lines thuộc về 1 session (gộp tất cả orders của bàn)
 */
const findOrderLinesBySessionId = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT ol.OrderLineID, ol.MenuItemID, mi.Name AS MenuItemName, ol.Quantity, ol.UnitPrice, ol.LineTotal, ol.Note, ol.Status,
            o.OrderID, o.Status AS OrderStatus, mi.IsWeightBased
     FROM orderline ol
     INNER JOIN menuitem mi ON ol.MenuItemID = mi.MenuItemID
     INNER JOIN \`order\` o ON ol.OrderID = o.OrderID
     WHERE o.SessionID = ?
     ORDER BY o.CreatedAt DESC, ol.OrderLineID ASC`,
    [sessionId]
  );
  return rows;
};

/**
 * Lấy danh sách tất cả các order và order lines theo branchId cho OrderBoard của Waiter và CashierBoard
 */
const findOrdersByBranch = async (branchId, status = null) => {
  let query = `SELECT 
       o.OrderID, o.OrderNumber, o.Status AS OrderStatus, o.SessionID, o.CreatedAt AS OrderCreatedAt,
       t.Name AS TableName, a.Name AS AreaName,
       ol.OrderLineID, ol.MenuItemID, mi.Name AS MenuItemName, 
       ol.Quantity, ol.UnitPrice, ol.Status, ol.Note, ol.CreatedAt AS LineCreatedAt
     FROM \`order\` o
     INNER JOIN session s ON o.SessionID = s.SessionID
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN orderline ol ON o.OrderID = ol.OrderID
     INNER JOIN menuitem mi ON ol.MenuItemID = mi.MenuItemID
     WHERE a.BranchID = ? AND ol.Status != 3 AND s.Status != 2`; // Avoid closed sessions

  const params = [branchId];
  if (status !== null && status !== undefined) {
    query += ` AND o.Status = ?`;
    params.push(parseInt(status, 10));
  }
  query += ` ORDER BY ol.CreatedAt ASC`;

  const [rows] = await pool.execute(query, params);

  // Group by OrderID
  const ordersMap = {};
  rows.forEach(row => {
    if (!ordersMap[row.OrderID]) {
      ordersMap[row.OrderID] = {
        OrderID: row.OrderID,
        SessionID: row.SessionID,
        OrderNumber: row.OrderNumber,
        OrderStatus: row.OrderStatus,
        TableName: row.TableName,
        AreaName: row.AreaName,
        CreatedAt: row.OrderCreatedAt,
        lines: []
      };
    }
    ordersMap[row.OrderID].lines.push({
      OrderLineID: row.OrderLineID,
      MenuItemID: row.MenuItemID,
      MenuItemName: row.MenuItemName,
      Quantity: row.Quantity,
      UnitPrice: row.UnitPrice,
      Status: row.Status,
      Note: row.Note,
      CreatedAt: row.LineCreatedAt
    });
  });

  return Object.values(ordersMap);
};

module.exports = {
  createOrder,
  createOrderLines,
  findOrderWithLines,
  findOrderLineById,
  verifyOrderLineBelongsToBranch,
  updateOrderLineQuantityAndStatus,
  findActiveOrderByParticipantId,
  updateOrderStatus,
  updateAllOrdersStatusInSession,
  cancelOrderLine,
  findOrderLinesBySessionId,
  findOrdersByBranch,
};
