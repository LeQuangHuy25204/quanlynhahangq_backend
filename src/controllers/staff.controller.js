'use strict';

const staffService = require('../services/staff.service');

/**
 * POST /api/staff
 * Body: { fullName, phone, email?, username, password, roleCode, branchId }
 * Protected: RestaurantAdmin
 */
const createStaff = async (req, res, next) => {
  try {
    const data = await staffService.createStaff(req.body, req.user);
    res.status(201).json({ success: true, message: 'Tạo tài khoản nhân viên thành công.', data });
  } catch (err) { next(err); }
};

/**
 * GET /api/staff?branchId=X
 * Protected: BranchManager (chỉ chi nhánh mình), RestaurantAdmin (toàn nhà hàng)
 */
const getStaffByBranch = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const data = await staffService.getStaffByBranch(branchId, req.user);
    res.status(200).json({ success: true, message: 'Lấy danh sách nhân viên thành công.', data });
  } catch (err) { next(err); }
};

/**
 * PATCH /api/staff/:staffId/status
 * Body: { status: 0 | 1 }
 * Protected: BranchManager, RestaurantAdmin
 */
const toggleStaffStatus = async (req, res, next) => {
  try {
    const { staffId } = req.params;
    const { status } = req.body;
    const data = await staffService.toggleStaffStatus(staffId, status, req.user);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

module.exports = { createStaff, getStaffByBranch, toggleStaffStatus };
