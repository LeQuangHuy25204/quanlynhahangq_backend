'use strict';

const express = require('express');
const router  = express.Router();
const orderController = require('../controllers/order.controller');

const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   POST /api/orders
 * @desc    Gửi đơn đặt món — áp dụng snapshot giá BR-07
 * @access  Public (khách có sessionToken, chưa cần đăng nhập)
 * @body    {
 *            sessionToken: string,
 *            participantId: number,
 *            branchId: number,
 *            items: [{ menuItemId: number, quantity: number, note?: string }]
 *          }
 */
router.post('/', orderController.placeOrder);

/**
 * @route   GET /api/orders
 * @desc    Lấy tất cả các order và món ăn theo chi nhánh cho Waiter/Staff
 * @access  Protected
 */
router.get(
  '/',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  orderController.getOrdersByBranch
);

/**
 * @route   GET /api/orders/tracking/:sessionToken
 * @desc    Khách hàng theo dõi đơn hàng của phiên
 * @access  Public
 */
router.get('/tracking/:sessionToken', orderController.trackOrderByToken);

/**
 * @route   PUT /api/orders/lines/:orderLineId/weight
 * @desc    Phục vụ cân món và chuyển sang bếp (FR-SRV-05)
 * @access  Protected (Waiter, BranchManager, RestaurantAdmin)
 * @body    { quantity: number }
 */
router.put(
  '/lines/:orderLineId/weight',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  orderController.updateOrderLineWeight
);

/**
 * @route   PUT /api/orders/lines/:orderLineId/status
 * @desc    Cập nhật trạng thái món ăn (Chờ xác nhận -> Đã xác nhận -> Đang chế biến -> Đã phục vụ...)
 * @access  Protected (Waiter, BranchManager, RestaurantAdmin)
 * @body    { status: number }
 */
router.put(
  '/lines/:orderLineId/status',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  orderController.updateOrderLineStatus
);

/**
 * @route   POST /api/orders/:orderId/request-payment
 * @desc    Khách hàng (App) yêu cầu thanh toán
 * @access  Public (cần sessionToken)
 * @body    { sessionToken: string }
 */
router.post('/:orderId/request-payment', orderController.requestPayment);

/**
 * @route   PATCH /api/orders/lines/:orderLineId/cancel
 * @desc    Phục vụ hủy món ăn
 * @access  Protected (Waiter, BranchManager, RestaurantAdmin)
 * @body    { cancelReason?: string }
 */
router.patch(
  '/lines/:orderLineId/cancel',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  orderController.cancelOrderLine
);

/**
 * @route   GET /api/orders/session/:sessionId
 * @desc    Lấy danh sách món ăn đã gọi của một phiên
 * @access  Protected (Waiter, BranchManager, RestaurantAdmin)
 */
router.get(
  '/session/:sessionId',
  authenticate,
  requireRole('Waiter', 'BranchManager', 'RestaurantAdmin'),
  orderController.getOrderLinesBySession
);

module.exports = router;
