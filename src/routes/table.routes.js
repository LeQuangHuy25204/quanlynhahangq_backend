'use strict';

const express = require('express');
const router  = express.Router();
const tableController = require('../controllers/table.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

// ─── AREA ────────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/tables/areas?branchId=X
 * @desc    Lấy danh sách khu vực của một chi nhánh
 * @access  BranchManager, RestaurantAdmin
 */
router.get('/areas', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), tableController.getAreasByBranch);

/**
 * @route   POST /api/tables/areas
 * @desc    Tạo khu vực mới
 * @access  BranchManager, RestaurantAdmin
 * @body    { branchId, name }
 */
router.post('/areas', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), tableController.createArea);

/**
 * @route   PUT /api/tables/areas/:areaId
 * @desc    Cập nhật khu vực (đổi tên, kích hoạt/ẩn)
 * @access  BranchManager, RestaurantAdmin
 * @body    { name?, isActive? }
 */
router.put('/areas/:areaId', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), tableController.updateArea);

// ─── TABLE ────────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/tables?branchId=X
 * @desc    Lấy danh sách bàn (kèm khu vực và mã QR) của một chi nhánh
 * @access  BranchManager, RestaurantAdmin, Waiter, Cashier
 */
router.get('/', authenticate, requireRole('Waiter', 'Cashier', 'BranchManager', 'RestaurantAdmin'), tableController.getTablesByBranch);

/**
 * @route   POST /api/tables
 * @desc    Tạo bàn mới (mã QR được gen tự động)
 * @access  BranchManager, RestaurantAdmin
 * @body    { areaId, name }
 */
router.post('/', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), tableController.createTable);

/**
 * @route   PUT /api/tables/:tableId
 * @desc    Cập nhật bàn (đổi tên, kích hoạt/ẩn)
 * @access  BranchManager, RestaurantAdmin
 * @body    { name?, isActive? }
 */
router.put('/:tableId', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), tableController.updateTable);

module.exports = router;
