'use strict';

const { pool } = require('../config/db');

/**
 * Kiểm tra username đã tồn tại trong phạm vi nhà hàng (FR-ADM-01).
 * Username phải duy nhất per-restaurant (không phải toàn hệ thống).
 *
 * Note: DB schema hiện có UNIQUE KEY toàn cục trên Username.
 * Service layer sẽ check thủ công theo restaurantId trước khi insert.
 */
const findByUsernameInRestaurant = async (username, restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT s.StaffID
     FROM staff s
     INNER JOIN branch b ON s.BranchID = b.BranchID
     WHERE s.Username      = ?
       AND b.RestaurantID  = ?
     LIMIT 1`,
    [username, restaurantId]
  );
  return rows[0] || null;
};

/**
 * Tìm RoleID theo RoleCode.
 */
const findRoleByCode = async (roleCode) => {
  const [rows] = await pool.execute(
    `SELECT RoleID FROM role WHERE RoleCode = ? AND IsActive = 1 LIMIT 1`,
    [roleCode]
  );
  return rows[0] || null;
};

/**
 * Kiểm tra branchId có thuộc restaurantId không (BR-21).
 */
const verifyBranchBelongsToRestaurant = async (branchId, restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT BranchID FROM branch WHERE BranchID = ? AND RestaurantID = ? AND IsActive = 1 LIMIT 1`,
    [branchId, restaurantId]
  );
  return rows[0] || null;
};

/**
 * Insert nhân viên mới.
 */
const createStaff = async ({ branchId, roleId, fullName, phone, email, username, passwordHash }) => {
  const [result] = await pool.execute(
    `INSERT INTO staff (BranchID, RoleID, FullName, Phone, Email, Username, PasswordHash, Status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [branchId, roleId, fullName, phone, email || null, username, passwordHash]
  );
  return result.insertId;
};

/**
 * Lấy danh sách nhân viên theo chi nhánh (BR-21).
 */
const findStaffByBranch = async (branchId, restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT
       s.StaffID, s.FullName, s.Phone, s.Email, s.Username,
       s.Status, s.CreatedAt,
       r.RoleCode, r.RoleName,
       b.Name AS BranchName
     FROM staff s
     INNER JOIN role   r ON s.RoleID   = r.RoleID
     INNER JOIN branch b ON s.BranchID = b.BranchID
     WHERE s.BranchID     = ?
       AND b.RestaurantID = ?
     ORDER BY s.CreatedAt DESC`,
    [branchId, restaurantId]
  );
  return rows;
};

/**
 * Tìm một nhân viên theo ID (kèm thông tin role và branch).
 */
const findStaffById = async (staffId) => {
  const [rows] = await pool.execute(
    `SELECT
       s.StaffID, s.FullName, s.Phone, s.Email, s.Username,
       s.Status, s.CreatedAt, s.BranchID,
       r.RoleCode, r.RoleName,
       b.Name AS BranchName, b.RestaurantID
     FROM staff s
     INNER JOIN role   r ON s.RoleID   = r.RoleID
     INNER JOIN branch b ON s.BranchID = b.BranchID
     WHERE s.StaffID = ?`,
    [staffId]
  );
  return rows[0] || null;
};

/**
 * Cập nhật trạng thái tài khoản nhân viên (1 = active, 0 = inactive).
 */
const updateStaffStatus = async (staffId, status) => {
  const [result] = await pool.execute(
    `UPDATE staff SET Status = ? WHERE StaffID = ?`,
    [status, staffId]
  );
  return result.affectedRows;
};

module.exports = {
  findByUsernameInRestaurant,
  findRoleByCode,
  verifyBranchBelongsToRestaurant,
  createStaff,
  findStaffByBranch,
  findStaffById,
  updateStaffStatus,
};
