'use strict';

const express = require('express');
const router  = express.Router();
const menuController = require('../controllers/menu.controller');
const { authenticate }   = require('../middlewares/authMiddleware');
const { requireRole }    = require('../middlewares/roleMiddleware');

/**
 * @route   GET /api/menu
 * @desc    Lấy menu với chiến lược giá linh hoạt
 * @access  Public (khách quét QR)
 * @query   restaurantId (bắt buộc), branchId (tuỳ chọn)
 */
router.get('/', menuController.getMenu);

/**
 * @route   POST /api/menu/items
 * @desc    Thêm món ăn gốc ở cấp nhà hàng
 * @access  RestaurantAdmin
 */
router.post(
  '/items',
  authenticate,
  requireRole('RestaurantAdmin'),
  menuController.addMenuItem
);

/**
 * @route   PUT /api/menu/items/:menuItemId/override
 * @desc    Đặt giá chi nhánh hoặc ẩn/hiện món tại chi nhánh
 * @access  BranchManager, RestaurantAdmin
 */
router.put(
  '/items/:menuItemId/override',
  authenticate,
  requireRole('BranchManager', 'RestaurantAdmin'),
  menuController.setBranchOverride
);

module.exports = router;
