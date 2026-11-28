'use strict';

const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const authModel = require('../models/auth.model');
const activityLogService = require('./activityLog.service');
const { STAFF_STATUS, LOG_SEVERITY } = require('../constants/status');

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

  if (!staff) {
    await activityLogService.logSystemAction({
      entityType: 'Auth',
      action: 'LOGIN_FAILED',
      severity: LOG_SEVERITY.WARNING,
      actorName: `Tài khoản: ${username}`,
      description: `Đăng nhập thất bại: không tìm thấy tài khoản "${username}".`,
      newValue: { username, reason: 'USER_NOT_FOUND' },
    });
    throw invalidErr;
  }

  if (staff.Status !== STAFF_STATUS.ACTIVE) {
    await activityLogService.logActivity({
      restaurantId: staff.RestaurantID,
      branchId: staff.BranchID,
      staffId: staff.StaffID,
      actorType: staff.RoleCode,
      actorName: `${staff.FullName} (${staff.Username})`,
      entityType: 'Auth',
      entityId: staff.StaffID,
      action: 'LOGIN_FAILED',
      severity: LOG_SEVERITY.CRITICAL,
      description: `Tài khoản bị khóa "${staff.Username}" cố gắng đăng nhập.`,
      newValue: { username: staff.Username, reason: 'ACCOUNT_DISABLED' },
    });
    const err = new Error('Tài khoản đã bị vô hiệu hoá. Liên hệ quản trị viên.');
    err.statusCode = 403;
    throw err;
  }

  const isPasswordValid = await bcrypt.compare(password, staff.PasswordHash);
  if (!isPasswordValid) {
    await activityLogService.logActivity({
      restaurantId: staff.RestaurantID,
      branchId: staff.BranchID,
      staffId: staff.StaffID,
      actorType: staff.RoleCode,
      actorName: `${staff.FullName} (${staff.Username})`,
      entityType: 'Auth',
      entityId: staff.StaffID,
      action: 'LOGIN_FAILED',
      severity: LOG_SEVERITY.WARNING,
      description: `Đăng nhập thất bại (sai mật khẩu) cho tài khoản "${staff.Username}".`,
      newValue: { username: staff.Username, reason: 'INVALID_PASSWORD' },
    });
    throw invalidErr;
  }

  // Ký JWT với payload chuẩn
  const payload = {
    staffId:      staff.StaffID,
    restaurantId: staff.RestaurantID, // từ DB, không từ client
    branchId:     staff.BranchID || null,
    roleCode:     staff.RoleCode,
    fullName:     staff.FullName,
    username:     staff.Username,
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });

  await activityLogService.logActivity({
    restaurantId: staff.RestaurantID,
    branchId: staff.BranchID,
    staffId: staff.StaffID,
    actorType: staff.RoleCode,
    actorName: `${staff.FullName} (${staff.Username})`,
    entityType: 'Auth',
    entityId: staff.StaffID,
    action: 'LOGIN_SUCCESS',
    severity: LOG_SEVERITY.INFO,
    description: `${staff.FullName} (${staff.Username} - ${staff.RoleCode}) đăng nhập hệ thống.`,
    newValue: { staffId: staff.StaffID, username: staff.Username, roleCode: staff.RoleCode, branchId: staff.BranchID },
  });

  return {
    token,
    staff: {
      staffId:  staff.StaffID,
      fullName: staff.FullName,
      username: staff.Username,
      roleCode: staff.RoleCode,
      branchId: staff.BranchID || null,
    },
  };
};

module.exports = { login };
