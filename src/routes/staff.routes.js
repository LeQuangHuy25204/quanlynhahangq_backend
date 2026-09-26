'use strict';

const express = require('express');
const router  = express.Router();
const staffController = require('../controllers/staff.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   POST /api/staff
 * @desc    Tạo tài khoản nhân viên mới
 * @access  RestaurantAdmin
 * @body    { fullName, phone, email?, username, password, roleCode, branchId }
 */
router.post(
  '/',
  authenticate,
  requireRole('RestaurantAdmin'),
  staffController.createStaff
);

/**
 * @route   GET /api/staff?branchId=X
 * @desc    Lấy danh sách nhân viên (lọc theo chi nhánh)
 * @access  BranchManager (chi nhánh mình), RestaurantAdmin (tất cả chi nhánh)
 */
router.get(
  '/',
  authenticate,
  requireRole('BranchManager', 'RestaurantAdmin'),
  staffController.getStaffByBranch
);

/**
 * @route   PATCH /api/staff/:staffId/status
 * @desc    Khóa hoặc mở khóa tài khoản nhân viên
 * @access  BranchManager (chi nhánh mình), RestaurantAdmin (tất cả)
 * @body    { status: 0 | 1 }
 */
router.patch(
  '/:staffId/status',
  authenticate,
  requireRole('BranchManager', 'RestaurantAdmin'),
  staffController.toggleStaffStatus
);

module.exports = router;
