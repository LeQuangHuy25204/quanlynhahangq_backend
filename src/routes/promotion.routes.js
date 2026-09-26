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
 * @desc    Tạo mới khuyến mãi
 * @access  RestaurantAdmin
 * @body    { name, description?, discountType: 'PERCENT'|'FIXED', discountValue, startDate, endDate? }
 */
router.post('/', authenticate, requireRole('RestaurantAdmin'), promotionController.createPromotion);

/**
 * @route   PUT /api/promotions/:promotionId
 * @desc    Cập nhật / kích hoạt / tắt khuyến mãi
 * @access  RestaurantAdmin
 * @body    { name?, description?, discountType?, discountValue?, startDate?, endDate?, isActive? }
 */
router.put('/:promotionId', authenticate, requireRole('RestaurantAdmin'), promotionController.updatePromotion);

module.exports = router;
