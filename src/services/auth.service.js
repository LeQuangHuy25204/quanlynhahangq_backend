'use strict';

const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const authModel = require('../models/auth.model');
const { STAFF_STATUS } = require('../constants/status');

/**
 * Đăng nhập nhân viên.
 * Hệ thống 1 nhà hàng: không cần client truyền restaurantId.
 * RestaurantID được lấy từ DB (thông qua staff → branch → restaurant).
 *
 * @param {string} username
 * @param {string} password
 */
const login = async (username, password) => {
  if (!username || !password) {
    const err = new Error('Username và password là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  const staff = await authModel.findStaffByUsername(username);

  // Luôn trả cùng 1 message để tránh user enumeration attack
  const invalidErr = new Error('Tên đăng nhập hoặc mật khẩu không đúng.');
  invalidErr.statusCode = 401;

  if (!staff) throw invalidErr;

  if (staff.Status !== STAFF_STATUS.ACTIVE) {
    const err = new Error('Tài khoản đã bị vô hiệu hoá. Liên hệ quản trị viên.');
    err.statusCode = 403;
    throw err;
  }

  const isPasswordValid = await bcrypt.compare(password, staff.PasswordHash);
  if (!isPasswordValid) throw invalidErr;

  // Ký JWT với payload chuẩn
  const payload = {
    staffId:      staff.StaffID,
    restaurantId: staff.RestaurantID, // từ DB, không từ client
    branchId:     staff.BranchID || null,
    roleCode:     staff.RoleCode,
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });

  return {
    token,
    staff: {
      staffId:  staff.StaffID,
      fullName: staff.FullName,
      roleCode: staff.RoleCode,
      branchId: staff.BranchID || null,
    },
  };
};

module.exports = { login };
