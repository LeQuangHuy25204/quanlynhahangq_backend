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
 * @param {object} data - { tableId, sessionToken, joinCode, status }
 */
const createSession = async ({ tableId, sessionToken, joinCode, status }) => {
  const [result] = await pool.execute(
    `INSERT INTO session (TableID, SessionToken, JoinCode, Status)
     VALUES (?, ?, ?, ?)`,
    [tableId, sessionToken, joinCode, status]
  );
  return result.insertId;
};

/**
 * Tìm session bằng SessionToken (dùng cho các API cần xác thực phiên khách).
 */
const findSessionByToken = async (sessionToken) => {
  const [rows] = await pool.execute(
    `SELECT s.SessionID, s.TableID, s.Status, s.JoinCode,
            t.Name AS TableName, a.BranchID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
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
 * Tìm session bằng JoinCode (khi người thứ 2 tham gia).
 */
const findSessionByJoinCode = async (joinCode) => {
  const [rows] = await pool.execute(
    `SELECT s.SessionID, s.SessionToken, s.TableID, s.Status, s.JoinCode,
            t.Name AS TableName, a.BranchID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     WHERE s.JoinCode = ?`,
    [joinCode]
  );
  return rows[0] || null;
};

/**
 * Tìm session bằng ID.
 */
const findSessionById = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT s.SessionID, s.SessionToken, s.TableID, s.Status, s.JoinCode,
            t.Name AS TableName, a.BranchID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     WHERE s.SessionID = ?`,
    [sessionId]
  );
  return rows[0] || null;
};

/**
 * Cập nhật trạng thái Session.
 */
const updateSessionStatus = async (sessionId, status) => {
  const [result] = await pool.execute(
    `UPDATE session SET Status = ? WHERE SessionID = ?`,
    [status, sessionId]
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
  findSessionById,
  updateSessionStatus
};
