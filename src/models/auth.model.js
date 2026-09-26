'use strict';

const { pool } = require('../config/db');

/**
 * Tìm nhân viên bằng username.
 * Hệ thống chỉ có 1 nhà hàng nên không cần lọc theo restaurantId từ client.
 * RestaurantID được lấy từ DB thông qua branch.
 */
const findStaffByUsername = async (username) => {
  const [rows] = await pool.execute(
    `SELECT
       s.StaffID,
       s.BranchID,
       s.FullName,
       s.Username,
       s.PasswordHash,
       s.Status,
       r.RoleCode,
       b.RestaurantID
     FROM staff s
     INNER JOIN role   r ON s.RoleID   = r.RoleID
     INNER JOIN branch b ON s.BranchID = b.BranchID
     WHERE s.Username = ?
     LIMIT 1`,
    [username]
  );
  return rows[0] || null;
};

module.exports = { findStaffByUsername };
