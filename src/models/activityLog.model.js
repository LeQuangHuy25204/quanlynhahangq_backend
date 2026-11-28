'use strict';

const { pool } = require('../config/db');

const parseJsonColumn = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
};

const formatLogRow = (row) => {
  if (!row) return null;
  return {
    ...row,
    OldValue: parseJsonColumn(row.OldValue),
    NewValue: parseJsonColumn(row.NewValue),
  };
};

/**
 * Ghi một bản ghi vào bảng activitylog.
 */
const createLog = async ({
  restaurantId = 1,
  branchId = null,
  staffId = null,
  actorType,
  actorName,
  entityType,
  entityId = null,
  action,
  severity = 'INFO',
  description,
  oldValue = null,
  newValue = null,
  ipAddress = null,
}, conn = pool) => {
  const [result] = await conn.execute(
    `INSERT INTO activitylog
       (RestaurantID, BranchID, StaffID, ActorType, ActorName, EntityType, EntityID, Action, Severity, Description, OldValue, NewValue, IPAddress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      restaurantId || 1,
      branchId ?? null,
      staffId ?? null,
      String(actorType || 'System').slice(0, 30),
      String(actorName || 'Hệ thống').slice(0, 255),
      String(entityType || 'System').slice(0, 50),
      entityId !== undefined && entityId !== null && !Number.isNaN(Number(entityId))
        ? Number(entityId)
        : null,
      String(action || 'UNKNOWN').slice(0, 100),
      String(severity || 'INFO').slice(0, 20),
      String(description || action || '').slice(0, 500),
      oldValue !== null && oldValue !== undefined ? JSON.stringify(oldValue) : null,
      newValue !== null && newValue !== undefined ? JSON.stringify(newValue) : null,
      ipAddress ? String(ipAddress).slice(0, 45) : null,
    ]
  );
  return result.insertId;
};

/**
 * Tra cứu tên & username nhân viên theo StaffID (dùng fallback nếu JWT cũ không có fullName).
 */
const findStaffActorById = async (staffId) => {
  if (!staffId) return null;
  const [rows] = await pool.execute(
    `SELECT s.StaffID, s.FullName, s.Username, s.BranchID, r.RoleCode, b.RestaurantID
     FROM staff s
     INNER JOIN role r ON s.RoleID = r.RoleID
     INNER JOIN branch b ON s.BranchID = b.BranchID
     WHERE s.StaffID = ?
     LIMIT 1`,
    [staffId]
  );
  return rows[0] || null;
};

const buildWhereClause = ({
  restaurantId,
  branchId,
  actorType,
  entityType,
  entityId,
  staffId,
  action,
  severity,
  startDate,
  endDate,
  search,
}) => {
  const conditions = ['al.RestaurantID = ?'];
  const params = [restaurantId];

  if (branchId === 'null' || branchId === 'SYSTEM') {
    conditions.push('al.BranchID IS NULL');
  } else if (branchId && branchId !== 'all' && branchId !== 'ALL') {
    const parsed = parseInt(branchId, 10);
    if (!Number.isNaN(parsed)) {
      conditions.push('al.BranchID = ?');
      params.push(parsed);
    }
  }

  if (actorType && actorType !== 'ALL') {
    conditions.push('al.ActorType = ?');
    params.push(actorType);
  }

  if (entityType && entityType !== 'ALL') {
    conditions.push('al.EntityType = ?');
    params.push(entityType);
  }

  if (entityId !== undefined && entityId !== null && entityId !== '') {
    const parsedEntityId = parseInt(entityId, 10);
    if (!Number.isNaN(parsedEntityId)) {
      conditions.push('al.EntityID = ?');
      params.push(parsedEntityId);
    }
  }

  if (staffId !== undefined && staffId !== null && staffId !== '') {
    const parsedStaffId = parseInt(staffId, 10);
    if (!Number.isNaN(parsedStaffId)) {
      conditions.push('al.StaffID = ?');
      params.push(parsedStaffId);
    }
  }

  if (action && action !== 'ALL') {
    conditions.push('al.Action = ?');
    params.push(action);
  }

  if (severity && severity !== 'ALL') {
    conditions.push('al.Severity = ?');
    params.push(severity);
  }

  if (startDate) {
    conditions.push('al.Timestamp >= ?');
    params.push(`${startDate} 00:00:00`);
  }

  if (endDate) {
    conditions.push('al.Timestamp <= ?');
    params.push(`${endDate} 23:59:59`);
  }

  if (search && String(search).trim()) {
    const kw = `%${String(search).trim()}%`;
    conditions.push(
      `(al.ActorName LIKE ? OR al.Description LIKE ? OR al.Action LIKE ? OR al.EntityType LIKE ? OR COALESCE(al.IPAddress, '') LIKE ? OR CAST(COALESCE(al.EntityID, '') AS CHAR) LIKE ? OR CAST(COALESCE(al.OldValue, '') AS CHAR) LIKE ? OR CAST(COALESCE(al.NewValue, '') AS CHAR) LIKE ?)`
    );
    params.push(kw, kw, kw, kw, kw, kw, kw, kw);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
};

/**
 * Truy vấn danh sách ActivityLog có lọc đa chiều & phân trang cho RestaurantAdmin.
 */
const findLogs = async (filters) => {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(filters.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  const { whereSql, params } = buildWhereClause(filters);

  const [[countRow], [summaryRow], [rows]] = await Promise.all([
    pool.execute(
      `SELECT COUNT(*) AS total FROM activitylog al ${whereSql}`,
      params
    ),
    pool.execute(
      `SELECT
         COUNT(*) AS totalLogs,
         COALESCE(SUM(CASE WHEN al.Severity = 'CRITICAL' THEN 1 ELSE 0 END), 0) AS criticalCount,
         COALESCE(SUM(CASE WHEN al.Severity = 'WARNING' THEN 1 ELSE 0 END), 0) AS warningCount,
         COALESCE(SUM(CASE WHEN al.ActorType = 'Guest' THEN 1 ELSE 0 END), 0) AS guestCount,
         COALESCE(SUM(CASE WHEN al.Action = 'SESSION_AUTO_CLOSE_TIMEOUT' THEN 1 ELSE 0 END), 0) AS autoCloseCount
       FROM activitylog al
       ${whereSql}`,
      params
    ),
    pool.execute(
      `SELECT
         al.LogID, al.RestaurantID, al.BranchID, b.Name AS BranchName,
         al.StaffID, s.Username AS StaffUsername, s.FullName AS StaffFullName,
         al.ActorType, al.ActorName, al.EntityType, al.EntityID,
         al.Action, al.Severity, al.Description, al.OldValue, al.NewValue,
         al.IPAddress, al.Timestamp
       FROM activitylog al
       LEFT JOIN branch b ON al.BranchID = b.BranchID
       LEFT JOIN staff s ON al.StaffID = s.StaffID
       ${whereSql}
       ORDER BY al.Timestamp DESC, al.LogID DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    ),
  ]);

  const total = Number(countRow[0]?.total || 0);
  const sRow = summaryRow[0] || {};

  return {
    logs: rows.map(formatLogRow),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    summary: {
      totalLogs: Number(sRow.totalLogs || 0),
      criticalCount: Number(sRow.criticalCount || 0),
      warningCount: Number(sRow.warningCount || 0),
      guestCount: Number(sRow.guestCount || 0),
      autoCloseCount: Number(sRow.autoCloseCount || 0),
    },
  };
};

/**
 * Chi tiết một bản ghi log (cách ly theo RestaurantID).
 */
const findLogById = async (logId, restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT
       al.LogID, al.RestaurantID, al.BranchID, b.Name AS BranchName,
       al.StaffID, s.Username AS StaffUsername, s.FullName AS StaffFullName,
       al.ActorType, al.ActorName, al.EntityType, al.EntityID,
       al.Action, al.Severity, al.Description, al.OldValue, al.NewValue,
       al.IPAddress, al.Timestamp
     FROM activitylog al
     LEFT JOIN branch b ON al.BranchID = b.BranchID
     LEFT JOIN staff s ON al.StaffID = s.StaffID
     WHERE al.LogID = ? AND al.RestaurantID = ?
     LIMIT 1`,
    [logId, restaurantId]
  );
  return formatLogRow(rows[0] || null);
};

/**
 * Lấy chuỗi thao tác liên quan cùng một thực thể (EntityType + EntityID) để Admin truy vết dòng thời gian.
 */
const findRelatedLogs = async (restaurantId, entityType, entityId, limit = 20) => {
  if (!entityType || entityId === null || entityId === undefined) return [];
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const [rows] = await pool.execute(
    `SELECT
       al.LogID, al.BranchID, b.Name AS BranchName,
       al.StaffID, al.ActorType, al.ActorName,
       al.EntityType, al.EntityID, al.Action, al.Severity,
       al.Description, al.OldValue, al.NewValue, al.IPAddress, al.Timestamp
     FROM activitylog al
     LEFT JOIN branch b ON al.BranchID = b.BranchID
     WHERE al.RestaurantID = ?
       AND al.EntityType = ?
       AND al.EntityID = ?
     ORDER BY al.Timestamp DESC, al.LogID DESC
     LIMIT ${safeLimit}`,
    [restaurantId, entityType, entityId]
  );
  return rows.map(formatLogRow);
};

module.exports = {
  createLog,
  findStaffActorById,
  findLogs,
  findLogById,
  findRelatedLogs,
};
