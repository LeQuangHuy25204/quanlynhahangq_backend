'use strict';

const express = require('express');
const router = express.Router();
const activityLogController = require('../controllers/activityLog.controller');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole } = require('../middlewares/roleMiddleware');

/**
 * @route   GET /api/activity-logs
 * @desc    Xem nhật ký hoạt động toàn hệ thống, lọc theo actor / chi nhánh / đối tượng / mức độ / thời gian
 * @access  Protected (RestaurantAdmin)
 */
router.get(
  '/',
  authenticate,
  requireRole('RestaurantAdmin'),
  activityLogController.getLogs
);

/**
 * @route   GET /api/activity-logs/:logId
 * @desc    Chi tiết 1 dòng ActivityLog và chuỗi lịch sử của cùng đối tượng
 * @access  Protected (RestaurantAdmin)
 */
router.get(
  '/:logId',
  authenticate,
  requireRole('RestaurantAdmin'),
  activityLogController.getLogDetail
);

module.exports = router;
