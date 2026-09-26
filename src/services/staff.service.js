'use strict';

const bcrypt     = require('bcryptjs');
const staffModel = require('../models/staff.model');
const { ROLE_CODE } = require('../constants/status');

/**
 * Tạo tài khoản nhân viên mới.
 *
 * Luật nghiệp vụ (1 nhà hàng):
 * - restaurantId cố định từ env (hoặc từ req.user nếu là staff đã login)
 * - RestaurantAdmin tạo được: Waiter, Cashier, BranchManager, RestaurantAdmin
 * - Username phải duy nhất trong nhà hàng (FR-ADM-01)
 * - branchId của nhân viên mới phải hợp lệ trong nhà hàng
 *
 * @param {object} data       - Thông tin nhân viên
 * @param {object} actorUser  - req.user (người đang thực hiện hành động)
 */
const createStaff = async (data, actorUser) => {
  const { fullName, phone, email, username, password, roleCode, branchId } = data;

  if (!fullName || !phone || !username || !password || !roleCode || !branchId) {
    const err = new Error('fullName, phone, username, password, roleCode và branchId là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  // Xóa kiểm tra PlatformAdmin vì Use Case đã loại bỏ role này

  const restaurantId = actorUser.restaurantId;

  // Kiểm tra branchId hợp lệ và thuộc nhà hàng
  const branch = await staffModel.verifyBranchBelongsToRestaurant(
    parseInt(branchId, 10),
    restaurantId
  );
  if (!branch) {
    const err = new Error('Chi nhánh không tồn tại hoặc không thuộc nhà hàng.');
    err.statusCode = 400;
    throw err;
  }

  // Tìm RoleID
  const role = await staffModel.findRoleByCode(roleCode);
  if (!role) {
    const err = new Error(`Role "${roleCode}" không tồn tại hoặc đã bị vô hiệu hoá.`);
    err.statusCode = 400;
    throw err;
  }

  // FR-ADM-01: Username duy nhất trong nhà hàng
  const existing = await staffModel.findByUsernameInRestaurant(username, restaurantId);
  if (existing) {
    const err = new Error(`Tên đăng nhập "${username}" đã tồn tại.`);
    err.statusCode = 409;
    throw err;
  }

  // Hash mật khẩu
  const saltRounds  = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10);
  const passwordHash = await bcrypt.hash(password, saltRounds);

  const staffId = await staffModel.createStaff({
    branchId:     parseInt(branchId, 10),
    roleId:       role.RoleID,
    fullName,
    phone,
    email,
    username,
    passwordHash,
  });

  return { staffId, username, fullName, roleCode, branchId: parseInt(branchId, 10) };
};

/**
 * Lấy danh sách nhân viên theo chi nhánh.
 * BranchManager: chỉ xem chi nhánh của mình (từ JWT).
 * RestaurantAdmin: có thể xem bất kỳ chi nhánh nào.
 */
const getStaffByBranch = async (branchId, actorUser) => {
  // BR-18: BranchManager chỉ xem chi nhánh của mình
  const bypass = [ROLE_CODE.RESTAURANT_ADMIN];
  const targetBranchId = bypass.includes(actorUser.roleCode)
    ? parseInt(branchId, 10)
    : actorUser.branchId;

  if (!targetBranchId || isNaN(targetBranchId)) {
    const err = new Error('branchId là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  // Kiểm tra chi nhánh thuộc nhà hàng
  const branch = await staffModel.verifyBranchBelongsToRestaurant(
    targetBranchId,
    actorUser.restaurantId
  );
  if (!branch) {
    const err = new Error('Chi nhánh không thuộc nhà hàng.');
    err.statusCode = 403;
    throw err;
  }

  return staffModel.findStaffByBranch(targetBranchId, actorUser.restaurantId);
};

/**
 * Khóa hoặc Mở khóa tài khoản nhân viên.
 * - BranchManager: chỉ được thao tác với nhân viên thuộc chi nhánh mình.
 * - RestaurantAdmin: được thao tác tất cả chi nhánh.
 */
const toggleStaffStatus = async (staffId, status, actorUser) => {
  const parsedStatus = parseInt(status, 10);
  if (![0, 1].includes(parsedStatus)) {
    const err = new Error('Trạng thái không hợp lệ. Dùng 1 (mở) hoặc 0 (khóa).');
    err.statusCode = 400;
    throw err;
  }

  const staff = await staffModel.findStaffById(staffId);
  if (!staff) {
    const err = new Error('Không tìm thấy nhân viên.');
    err.statusCode = 404;
    throw err;
  }

  // Cách ly nhà hàng
  if (staff.RestaurantID !== actorUser.restaurantId) {
    const err = new Error('Không có quyền thao tác nhân viên ngoài nhà hàng.');
    err.statusCode = 403;
    throw err;
  }

  // BR-18: BranchManager chỉ quản lý nhân viên chi nhánh mình
  if (actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER && staff.BranchID !== actorUser.branchId) {
    const err = new Error('Bạn chỉ có thể quản lý nhân viên của chi nhánh mình.');
    err.statusCode = 403;
    throw err;
  }

  if (staff.Status === parsedStatus) {
    return { staffId: staff.StaffID, status: parsedStatus, message: 'Trạng thái không thay đổi.' };
  }

  await staffModel.updateStaffStatus(staffId, parsedStatus);
  return {
    staffId: staff.StaffID,
    status:  parsedStatus,
    message: parsedStatus === 1 ? 'Đã mở khóa tài khoản.' : 'Đã khóa tài khoản.',
  };
};

module.exports = { createStaff, getStaffByBranch, toggleStaffStatus };
