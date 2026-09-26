'use strict';

const { ROLE_CODE } = require('../constants/status');

/**
 * Factory function tạo middleware kiểm tra quyền RBAC.
 *
 * Cách dùng trong route:
 *   router.post('/items', authenticate, requireRole('RestaurantAdmin'), controller.addItem);
 *   router.put('/vat',    authenticate, requireRole('RestaurantAdmin', 'PlatformAdmin'), controller.updateVAT);
 *
 * Luôn dùng SAU middleware `authenticate` vì cần req.user.
 *
 * BR-18: Nhân viên chỉ thao tác trong phạm vi chi nhánh.
 * Middleware này kiểm tra role; việc kiểm tra branchId cụ thể
 * được thực hiện trong service layer (để giữ middleware gọn).
 *
 * @param {...string} allowedRoles - Danh sách roleCode được phép
 */
const requireRole = (...allowedRoles) => {
  // Validate để tránh lỗi typo khi khai báo route
  allowedRoles.forEach((role) => {
    if (!Object.values(ROLE_CODE).includes(role)) {
      throw new Error(`[RBAC] Role không hợp lệ: "${role}". Kiểm tra lại ROLE_CODE constants.`);
    }
  });

  return (req, res, next) => {
    if (!req.user) {
      // authenticate chưa chạy — lỗi cấu hình route
      return res.status(401).json({ success: false, message: 'Chưa xác thực.' });
    }

    if (!allowedRoles.includes(req.user.roleCode)) {
      return res.status(403).json({
        success: false,
        message: `Bạn không có quyền thực hiện hành động này. Yêu cầu quyền: [${allowedRoles.join(', ')}].`,
      });
    }

    next();
  };
};

/**
 * Middleware kiểm tra nhân viên thuộc đúng chi nhánh (BR-18).
 *
 * Dùng khi action bị giới hạn trong một chi nhánh cụ thể.
 * Bỏ qua kiểm tra nếu là RestaurantAdmin hoặc PlatformAdmin
 * (họ không bị gắn chết vào một chi nhánh).
 *
 * Tham số branchId lấy từ: req.params.branchId, req.body.branchId,
 * hoặc req.query.branchId (theo thứ tự ưu tiên).
 */
const requireSameBranch = (req, res, next) => {
  const { roleCode, branchId: userBranchId } = req.user;

  // Các role cấp nhà hàng/nền tảng không bị giới hạn chi nhánh
  const bypassRoles = [ROLE_CODE.RESTAURANT_ADMIN, ROLE_CODE.PLATFORM_ADMIN];
  if (bypassRoles.includes(roleCode)) return next();

  // Lấy branchId từ request (params → body → query)
  const targetBranchId = parseInt(
    req.params.branchId || req.body.branchId || req.query.branchId,
    10
  );

  if (!targetBranchId || targetBranchId !== userBranchId) {
    return res.status(403).json({
      success: false,
      message: 'Bạn không có quyền thao tác dữ liệu của chi nhánh khác.',
    });
  }

  next();
};

module.exports = { requireRole, requireSameBranch };
