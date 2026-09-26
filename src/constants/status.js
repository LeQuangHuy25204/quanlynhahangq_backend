'use strict';

/**
 * Enum trạng thái toàn hệ thống — ánh xạ cột tinyint trong DB.
 * Dùng Object.freeze() để đảm bảo immutable (không ai sửa được runtime).
 */

// Session.Status
const SESSION_STATUS = Object.freeze({
  WAITING_OPEN: 0, // CHỜ MỞ BÀN — vừa quét QR
  OPEN:         1, // ĐANG PHỤC VỤ
  CLOSED:       2, // ĐÃ ĐÓNG / ĐÃ THANH TOÁN
});

// Order.Status
const ORDER_STATUS = Object.freeze({
  PENDING:   0, // CHỜ XÁC NHẬN
  CONFIRMED: 1, // ĐÃ XÁC NHẬN
  CANCELLED: 2, // ĐÃ HỦY
  WAITING_PAYMENT: 3, // CHỜ THANH TOÁN
});

// OrderLine.Status
const ORDER_LINE_STATUS = Object.freeze({
  WAITING_CONFIRM: 0, // Món thường — CHỜ XÁC NHẬN (BR-07: snapshot giá tại đây)
  WAITING_WEIGH:   1, // Món cân — CHỜ CÂN (IsWeightBased = 1)
  CONFIRMED:       2, // ĐÃ XÁC NHẬN
  CANCELLED:       3, // ĐÃ HỦY
  COOKING:         4, // ĐANG CHẾ BIẾN (Chuyển bếp sau khi cân)
});

// Payment.Status
const PAYMENT_STATUS = Object.freeze({
  PENDING:  0,
  PAID:     1,
  FAILED:   2,
  REFUNDED: 3,
});

// Staff.Status
const STAFF_STATUS = Object.freeze({
  INACTIVE: 0,
  ACTIVE:   1,
});

// RoleCode — khớp chính xác với cột RoleCode trong bảng role
const ROLE_CODE = Object.freeze({
  WAITER:           'Waiter',
  CASHIER:          'Cashier',
  BRANCH_MANAGER:   'BranchManager',
  RESTAURANT_ADMIN: 'RestaurantAdmin',
});

module.exports = {
  SESSION_STATUS,
  ORDER_STATUS,
  ORDER_LINE_STATUS,
  PAYMENT_STATUS,
  STAFF_STATUS,
  ROLE_CODE,
};
