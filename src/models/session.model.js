'use strict';

const { pool } = require('../config/db');

/**
 * Tìm bàn bằng QRCode, lọc theo branchId (BR-21).
 * Đi qua table → area → branch để đảm bảo bàn thuộc chi nhánh đúng.
 */
const findTableByQRCode = async (qrCode, branchId) => {
  const [rows] = await pool.execute(
    `SELECT
       t.TableID,
       t.Name  AS TableName,
       t.IsActive,
       a.AreaID,
       a.Name  AS AreaName,
       a.BranchID
     FROM \`table\` t
     INNER JOIN area a ON t.AreaID = a.AreaID
     WHERE t.QRCode   = ?
       AND a.BranchID = ?`,
    [qrCode, branchId]
  );
  return rows[0] || null;
};

/**
 * Tìm session đang mở (WAITING_OPEN hoặc OPEN) của một bàn.
 */
const findActiveSessionByTableId = async (tableId) => {
  const [rows] = await pool.execute(
    `SELECT
       SessionID,
       SessionToken,
       JoinCode,
       Status,
       GuestCount,
       StartTime
     FROM session
     WHERE TableID = ?
       AND Status  IN (0, 1)
     ORDER BY StartTime DESC
     LIMIT 1`,
    [tableId]
  );
  return rows[0] || null;
};

/**
 * Tạo session mới.
 * @param {object} data - { tableId, sessionToken, joinCode, status, guestCount }
 */
const createSession = async ({ tableId, sessionToken, joinCode, status, guestCount = 2 }) => {
  const [result] = await pool.execute(
    `INSERT INTO session (TableID, SessionToken, JoinCode, Status, GuestCount)
     VALUES (?, ?, ?, ?, ?)`,
    [tableId, sessionToken, joinCode, status, guestCount]
  );
  return result.insertId;
};

/**
 * Tìm session bằng SessionToken (dùng cho các API cần xác thực phiên khách).
 */
const findSessionByToken = async (sessionToken) => {
  const [rows] = await pool.execute(
    `SELECT s.SessionID, s.SessionToken, s.TableID, s.Status, s.JoinCode,
            t.Name AS TableName, a.BranchID, b.RestaurantID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE s.SessionToken = ?`,
    [sessionToken]
  );
  return rows[0] || null;
};

/**
 * Thêm người tham gia vào phiên (SessionParticipant).
 */
const addParticipant = async ({ sessionId, guestName }) => {
  const [result] = await pool.execute(
    `INSERT INTO sessionparticipant (SessionID, GuestName, Status)
     VALUES (?, ?, 1)`,
    [sessionId, guestName]
  );
  return result.insertId;
};

/**
 * Tìm participant theo tên trong một phiên (dùng cho order do nhân viên thêm).
 */
const findParticipantByName = async (sessionId, guestName) => {
  const [rows] = await pool.execute(
    `SELECT * FROM sessionparticipant WHERE SessionID = ? AND GuestName = ? LIMIT 1`,
    [sessionId, guestName]
  );
  return rows[0] || null;
};

// Lưu tín hiệu "Gọi nhân viên hỗ trợ" trên bộ nhớ RAM của Server (In-Memory Map theo SessionID)
// Không ghi vào bảng sessionparticipant trong Database
const supportRequestsMemory = new Map();

/**
 * Lấy danh sách khách hàng đã tham gia phiên (không tính nhân viên order hộ 'NV: %').
 */
const getSessionParticipants = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT ParticipantID, GuestName, JoinedAt
     FROM sessionparticipant
     WHERE SessionID = ?
       AND Status = 1
       AND GuestName NOT LIKE 'NV: %'
     ORDER BY ParticipantID ASC`,
    [sessionId]
  );
  return rows;
};

/**
 * Khách hàng gửi yêu cầu gọi nhân viên hỗ trợ tại bàn (lưu trên bộ nhớ RAM theo SessionID).
 */
const createSupportRequest = async (sessionId, reasonText = 'Khách gọi nhân viên hỗ trợ tại bàn') => {
  const note = String(reasonText || 'Cần nhân viên hỗ trợ').replace(/^\[HO_TRO\]\s*/i, '').trim().slice(0, 100);
  const key = Number(sessionId);
  supportRequestsMemory.set(key, {
    sessionId: key,
    note,
    requestedAt: new Date().toISOString(),
  });
  return { requestId: key, note };
};

/**
 * Nhân viên xác nhận đã hỗ trợ bàn (xóa yêu cầu hỗ trợ khỏi bộ nhớ RAM).
 */
const clearSupportRequest = async (sessionId) => {
  const key = Number(sessionId);
  const existed = supportRequestsMemory.delete(key);
  return existed ? 1 : 0;
};

/**
 * Đọc yêu cầu hỗ trợ đang chờ của phiên bàn từ bộ nhớ RAM.
 */
const getSupportRequest = (sessionId) => {
  return supportRequestsMemory.get(Number(sessionId)) || null;
};

/**
 * Tìm session bằng JoinCode (khi người thứ 2 tham gia).
 */
const findSessionByJoinCode = async (joinCode) => {
  const [rows] = await pool.execute(
    `SELECT s.SessionID, s.SessionToken, s.TableID, s.Status, s.JoinCode, s.GuestCount,
            t.Name AS TableName, a.BranchID, b.RestaurantID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE s.JoinCode = ?
     ORDER BY s.SessionID DESC
     LIMIT 1`,
    [joinCode]
  );
  return rows[0] || null;
};

/**
 * Tìm session bằng ID.
 */
const findSessionById = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT s.SessionID, s.SessionToken, s.TableID, s.Status, s.JoinCode, s.GuestCount,
            t.Name AS TableName, a.BranchID, b.RestaurantID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE s.SessionID = ?`,
    [sessionId]
  );
  return rows[0] || null;
};

/**
 * Cập nhật trạng thái Session.
 * Quy tắc đóng bàn (Status = 2):
 *  1. Đã thanh toán thành công (Payment.Status = 1)
 *  HOẶC
 *  2. Bàn chưa có order hay món nào (hoặc tất cả món đã bị hủy) -> được phép đóng ngay.
 */
const updateSessionStatus = async (sessionId, status, conn = pool) => {
  const [result] = await conn.execute(
    `UPDATE session SET Status = ?
     WHERE SessionID = ?
       AND (
         ? <> 2
         OR EXISTS (
           SELECT 1 FROM invoice i
           INNER JOIN payment p ON p.InvoiceID = i.InvoiceID
           WHERE i.SessionID = session.SessionID AND p.Status = 1
         )
         OR NOT EXISTS (
           SELECT 1 FROM \`order\` o
           INNER JOIN orderline ol ON ol.OrderID = o.OrderID
           WHERE o.SessionID = session.SessionID AND ol.Status <> 3
         )
       )`,
    [status, sessionId, status]
  );
  return result.affectedRows;
};

/**
 * Cập nhật số lượng khách của Session.
 */
const updateGuestCount = async (sessionId, guestCount) => {
  const [result] = await pool.execute(
    `UPDATE session SET GuestCount = ? WHERE SessionID = ?`,
    [guestCount, sessionId]
  );
  return result.affectedRows;
};

module.exports = {
  findTableByQRCode,
  findActiveSessionByTableId,
  createSession,
  findSessionByToken,
  findSessionByJoinCode,
  addParticipant,
  findParticipantByName,
  getSessionParticipants,
  createSupportRequest,
  clearSupportRequest,
  getSupportRequest,
  findSessionById,
  updateSessionStatus,
  updateGuestCount
};
