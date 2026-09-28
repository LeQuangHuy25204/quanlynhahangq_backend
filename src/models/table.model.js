'use strict';

const { pool } = require('../config/db');
const crypto = require('crypto');

// ─── AREA ────────────────────────────────────────────────────────────────────

const findAreasByBranch = async (branchId) => {
  const [rows] = await pool.execute(
    `SELECT AreaID, BranchID, Name, IsActive FROM area WHERE BranchID = ? ORDER BY Name`,
    [branchId]
  );
  return rows;
};

const findAreaById = async (areaId) => {
  const [rows] = await pool.execute(
    `SELECT a.AreaID, a.BranchID, a.Name, a.IsActive, b.RestaurantID
     FROM area a INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE a.AreaID = ?`,
    [areaId]
  );
  return rows[0] || null;
};

const createArea = async ({ branchId, name }) => {
  const [result] = await pool.execute(
    `INSERT INTO area (BranchID, Name) VALUES (?, ?)`,
    [branchId, name]
  );
  return result.insertId;
};

const updateArea = async (areaId, { name, isActive }) => {
  const [result] = await pool.execute(
    `UPDATE area SET Name = ?, IsActive = ? WHERE AreaID = ?`,
    [name, isActive, areaId]
  );
  return result.affectedRows;
};

// ─── TABLE ────────────────────────────────────────────────────────────────────

const findTablesByArea = async (areaId) => {
  const [rows] = await pool.execute(
    `SELECT TableID, AreaID, Name, QRCode, IsActive FROM \`table\` WHERE AreaID = ? ORDER BY Name`,
    [areaId]
  );
  return rows;
};

const findTablesByBranch = async (branchId) => {
  const [rows] = await pool.execute(
    `SELECT
       t.TableID, t.Name, t.QRCode, t.IsActive,
       a.AreaID, a.Name AS AreaName,
       -- Active session info (Status 0 = chờ xác nhận, 1 = đang phục vụ)
       s.SessionID,
       s.Status      AS SessionStatus,
       s.GuestCount  AS SessionGuestCount,
       s.StartTime   AS SessionStartTime,
       -- Order total amount
       COALESCE(SUM(ol.LineTotal - ol.DiscountApplied), 0) AS SessionTotalAmount,
       -- Order status
       MAX(o.Status) AS OrderStatus
     FROM \`table\` t
     INNER JOIN area a ON t.AreaID = a.AreaID
     LEFT JOIN session s ON s.TableID = t.TableID AND s.Status IN (0, 1)
     LEFT JOIN \`order\` o ON o.SessionID = s.SessionID
     LEFT JOIN orderline ol ON ol.OrderID = o.OrderID AND ol.Status NOT IN (3)
     WHERE a.BranchID = ?
     GROUP BY t.TableID, t.Name, t.QRCode, t.IsActive, a.AreaID, a.Name,
              s.SessionID, s.Status, s.GuestCount, s.StartTime
     ORDER BY a.Name, t.Name`,
    [branchId]
  );

  // Reshape to { TableID, Name, AreaName, Session: {...} | null }
  return rows.map(r => ({
    TableID:  r.TableID,
    Name:     r.Name,
    QRCode:   r.QRCode,
    IsActive: r.IsActive,
    AreaID:   r.AreaID,
    AreaName: r.AreaName,
    Session:  r.SessionID ? {
      SessionID:   r.SessionID,
      Status:      r.SessionStatus,
      GuestCount:  r.SessionGuestCount,
      StartTime:   r.SessionStartTime,
      TotalAmount: parseFloat(r.SessionTotalAmount) || 0,
      Order:       r.OrderStatus !== null ? { Status: r.OrderStatus } : null,
    } : null,
  }));
};


const findTableById = async (tableId) => {
  const [rows] = await pool.execute(
    `SELECT t.TableID, t.AreaID, t.Name, t.QRCode, t.IsActive,
            a.BranchID, b.RestaurantID
     FROM \`table\` t
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE t.TableID = ?`,
    [tableId]
  );
  return rows[0] || null;
};

const createTable = async ({ areaId, name }) => {
  // Gen QRCode duy nhất: uuid v4 dạng rút gọn
  const qrCode = crypto.randomUUID();
  const [result] = await pool.execute(
    `INSERT INTO \`table\` (AreaID, Name, QRCode) VALUES (?, ?, ?)`,
    [areaId, name, qrCode]
  );
  return { tableId: result.insertId, qrCode };
};

const updateTable = async (tableId, { name, isActive }) => {
  const [result] = await pool.execute(
    `UPDATE \`table\` SET Name = ?, IsActive = ? WHERE TableID = ?`,
    [name, isActive, tableId]
  );
  return result.affectedRows;
};

module.exports = {
  findAreasByBranch,
  findAreaById,
  createArea,
  updateArea,
  findTablesByArea,
  findTablesByBranch,
  findTableById,
  createTable,
  updateTable,
};
