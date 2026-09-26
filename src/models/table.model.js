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
    `SELECT t.TableID, t.Name, t.QRCode, t.IsActive,
            a.AreaID, a.Name AS AreaName
     FROM \`table\` t
     INNER JOIN area a ON t.AreaID = a.AreaID
     WHERE a.BranchID = ?
     ORDER BY a.Name, t.Name`,
    [branchId]
  );
  return rows;
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
