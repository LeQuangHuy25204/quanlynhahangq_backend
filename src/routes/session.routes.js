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
 * @desc    Nhân viên, Thu ngân, Quản lý xác nhận mở bàn (0 -> 1) hoặc đóng bàn (1 -> 2)
 * @access  Protected (Waiter, Cashier, BranchManager, RestaurantAdmin)
 * @body    { status: number }
 */
router.put(
  '/:sessionId/status',
  authenticate,
  requireRole('Waiter', 'Cashier', 'BranchManager', 'RestaurantAdmin'),
  sessionController.updateSessionStatus
);

/**
 * @route   POST /api/sessions/open
 * @desc    Nhân viên, Thu ngân, Quản lý mở bàn thủ công
 * @access  Protected (Waiter, Cashier, BranchManager, RestaurantAdmin)
 * @body    { tableId: number, guestCount: number, note: string }
 */
router.post(
  '/open',
  authenticate,
  requireRole('Waiter', 'Cashier', 'BranchManager', 'RestaurantAdmin'),
  sessionController.manualOpenSession
);

/**
 * @route   POST /api/sessions/call-staff
 * @desc    Khách hàng gọi nhân viên hỗ trợ tại bàn
 * @access  Public (cần sessionToken)
 * @body    { sessionToken: string, reason?: string }
 */
router.post('/call-staff', sessionController.requestStaffSupport);

/**
 * @route   DELETE /api/sessions/:sessionId/call-staff
 * @desc    Nhân viên xác nhận đã hỗ trợ khách tại bàn
 * @access  Protected (Waiter, Cashier, BranchManager, RestaurantAdmin)
 */
router.delete(
  '/:sessionId/call-staff',
  authenticate,
  requireRole('Waiter', 'Cashier', 'BranchManager', 'RestaurantAdmin'),
  sessionController.resolveStaffSupport
);

/**
 * @route   GET /api/sessions/:sessionId
 * @desc    Lấy thông tin phiên theo ID (khách poll trạng thái)
 * @access  Public (khách chờ mở bàn cần poll)
 */
router.get('/:sessionId', sessionController.getSessionById);

module.exports = router;
