'use strict';

const express = require('express');
const router  = express.Router();
const promotionController = require('../controllers/promotion.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   GET /api/promotions
 * @desc    Lấy danh sách khuyến mãi của nhà hàng
 * @access  Cashier, BranchManager, RestaurantAdmin
 */
router.get('/', authenticate, requireRole('Cashier', 'BranchManager', 'RestaurantAdmin'), promotionController.getPromotions);

/**
 * @route   POST /api/promotions
 * @desc    Tạo mới khuyến mãi (Admin tạo toàn chuỗi/chi nhánh; BranchManager tạo cho chi nhánh mình)
 * @access  BranchManager, RestaurantAdmin
 */
router.post('/', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), promotionController.createPromotion);

/**
 * @route   PUT /api/promotions/:promotionId
 * @desc    Cập nhật / kích hoạt / tắt khuyến mãi
 * @access  BranchManager, RestaurantAdmin
 */
router.put('/:promotionId', authenticate, requireRole('BranchManager', 'RestaurantAdmin'), promotionController.updatePromotion);

module.exports = router;
