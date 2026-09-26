'use strict';

const jwt = require('jsonwebtoken');

/**
 * Middleware xác thực JWT.
 *
 * Quy trình:
 * 1. Đọc header "Authorization: Bearer <token>"
 * 2. Verify token bằng JWT_SECRET
 * 3. Gắn payload đã giải mã vào req.user để các tầng sau sử dụng
 *
 * JWT Payload chuẩn:
 * {
 *   staffId:      number,
 *   restaurantId: number,  ← dùng cho BR-21 (cách ly dữ liệu)
 *   branchId:     number | null,  ← null nếu RestaurantAdmin
 *   roleCode:     string   ← 'Waiter' | 'Cashier' | 'BranchManager' | 'RestaurantAdmin'
 * }
 *
 * Sau khi middleware này chạy, mọi controller/service đều có thể dùng:
 *   req.user.restaurantId  → BR-21: cách ly multi-tenant
 *   req.user.branchId      → BR-18: giới hạn phạm vi chi nhánh
 *   req.user.roleCode      → RBAC: kiểm tra quyền
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Không tìm thấy token xác thực. Vui lòng đăng nhập.',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token không hợp lệ.',
      });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('[AUTH] JWT_SECRET chưa được cấu hình!');
      return res.status(500).json({ success: false, message: 'Lỗi cấu hình server.' });
    }

    const decoded = jwt.verify(token, secret);

    // Gắn payload vào request để các middleware/handler sau dùng
    req.user = {
      staffId:      decoded.staffId,
      restaurantId: decoded.restaurantId,
      branchId:     decoded.branchId ?? null,
      roleCode:     decoded.roleCode,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token đã hết hạn. Vui lòng đăng nhập lại.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Token không hợp lệ.' });
    }
    next(err);
  }
};

module.exports = { authenticate };
