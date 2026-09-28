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

/**
 * @route   POST /api/sessions/open
 * @desc    Nhân viên mở bàn thủ công
 * @access  Protected (Waiter, BranchManager, RestaurantAdmin)
 * @body    { tableId: number, guestCount: number, note: string }
 */
router.post(
  '/open',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  sessionController.manualOpenSession
);

/**
 * @route   GET /api/sessions/:sessionId
 * @desc    Lấy thông tin phiên theo ID (khách poll trạng thái)
 * @access  Public (khách chờ mở bàn cần poll)
 */
router.get('/:sessionId', sessionController.getSessionById);

module.exports = router;
