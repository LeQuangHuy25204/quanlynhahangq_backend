'use strict';

const express = require('express');
const router  = express.Router();
const reportController = require('../controllers/report.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   GET /api/reports/branch-revenue
 * @desc    Doanh thu theo ngày của một chi nhánh (kèm top 10 món bán chạy)
 * @access  Cashier, BranchManager, RestaurantAdmin
 * @query   branchId (bắt buộc với Admin, tự động với Manager), startDate, endDate
 */
router.get(
  '/branch-revenue',
  authenticate,
  requireRole('Cashier', 'BranchManager', 'RestaurantAdmin'),
  reportController.getBranchRevenue
);

/**
 * @route   GET /api/reports/restaurant-revenue
 * @desc    Tổng hợp doanh thu tất cả chi nhánh trong khoảng thời gian
 * @access  RestaurantAdmin
 * @query   startDate, endDate
 */
router.get(
  '/restaurant-revenue',
  authenticate,
  requireRole('RestaurantAdmin'),
  reportController.getRestaurantRevenue
);

router.get(
  '/dashboard-summary',
  authenticate,
  requireRole('BranchManager', 'RestaurantAdmin'),
  reportController.getDashboardSummary
);

module.exports = router;

