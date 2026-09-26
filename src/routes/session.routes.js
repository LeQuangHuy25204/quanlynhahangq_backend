'use strict';

const express = require('express');
const router  = express.Router();
const sessionController = require('../controllers/session.controller');

const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   POST /api/sessions/qr-scan
 * @desc    Quét mã QR để mở bàn hoặc lấy lại phiên hiện tại
 * @access  Public
 * @body    { qrCode: string, branchId: number }
 */
router.post('/qr-scan', sessionController.qrScan);

/**
 * @route   POST /api/sessions/join
 * @desc    Khách nhập tên tham gia vào bàn
 * @access  Public
 * @body    { sessionCode: string, guestName: string, branchId: number }
 */
router.post('/join', sessionController.joinSession);

/**
 * @route   PUT /api/sessions/:sessionId/status
 * @desc    Nhân viên xác nhận mở bàn (từ 0 -> 1) hoặc đóng bàn (từ 1 -> 2)
 * @access  Protected (Waiter, BranchManager, RestaurantAdmin)
 * @body    { status: number }
 */
router.put(
  '/:sessionId/status',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  sessionController.updateSessionStatus
);

module.exports = router;
