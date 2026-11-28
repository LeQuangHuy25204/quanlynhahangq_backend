'use strict';

const activityLogModel = require('../models/activityLog.model');
const { ACTOR_TYPE, LOG_SEVERITY } = require('../constants/status');
const { getContext } = require('../utils/requestContext');

const SENSITIVE_KEY_PATTERN = /password|secret|token|apikey|securehash|hashsecret|otp|cvv/i;

/**
 * Loại bỏ các trường nhạy cảm (mật khẩu, token, hash secret, OTP, CVV) khỏi payload audit.
 */
const sanitizeAuditPayload = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditPayload(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const clean = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      if (val === undefined) continue;
      clean[key] = sanitizeAuditPayload(val);
    }
    return clean;
  }
  return value;
};

/**
 * Danh sách mã hành động & nhãn tiếng Việt chuẩn hóa để filter & hiển thị.
 */
const KNOWN_ACTIONS = [
  { code: 'LOGIN_SUCCESS', label: 'Đăng nhập thành công' },
  { code: 'LOGIN_FAILED', label: 'Đăng nhập thất bại' },
  { code: 'STAFF_CREATE', label: 'Tạo tài khoản nhân viên' },
  { code: 'STAFF_STATUS_CHANGE', label: 'Khóa / Mở khóa nhân viên' },
  { code: 'BRANCH_CREATE', label: 'Tạo chi nhánh mới' },
  { code: 'BRANCH_UPDATE', label: 'Cập nhật cấu hình chi nhánh' },
  { code: 'AREA_CREATE', label: 'Tạo khu vực bàn' },
  { code: 'AREA_UPDATE', label: 'Cập nhật khu vực bàn' },
  { code: 'TABLE_CREATE', label: 'Tạo bàn & mã QR' },
  { code: 'TABLE_UPDATE', label: 'Cập nhật thông tin bàn' },
  { code: 'CATEGORY_CREATE', label: 'Tạo danh mục món' },
  { code: 'MENU_ITEM_CREATE', label: 'Thêm món ăn mới' },
  { code: 'MENU_ITEM_UPDATE', label: 'Cập nhật món ăn / giá gốc' },
  { code: 'MENU_OVERRIDE_UPDATE', label: 'Cập nhật giá riêng / tồn kho chi nhánh' },
  { code: 'PROMOTION_CREATE', label: 'Tạo khuyến mãi' },
  { code: 'PROMOTION_UPDATE', label: 'Cập nhật / Bật-tắt khuyến mãi' },
  { code: 'SESSION_QR_SCAN', label: 'Khách quét QR mở phiên chờ' },
  { code: 'SESSION_GUEST_JOIN', label: 'Khách tham gia phiên bàn' },
  { code: 'SESSION_OPEN_CONFIRM', label: 'Xác nhận mở bàn cho khách' },
  { code: 'SESSION_MANUAL_OPEN', label: 'Nhân viên mở bàn thủ công' },
  { code: 'SESSION_CLOSE', label: 'Đóng bàn / Hủy phiên bàn' },
  { code: 'SESSION_AUTO_CLOSE_TIMEOUT', label: 'Hệ thống tự đóng bàn quá 5 phút' },
  { code: 'SESSION_CALL_STAFF', label: 'Khách gọi nhân viên hỗ trợ' },
  { code: 'SESSION_RESOLVE_SUPPORT', label: 'Xác nhận đã hỗ trợ tại bàn' },
  { code: 'ORDER_CREATE', label: 'Khách gửi đơn gọi món' },
  { code: 'ORDER_STAFF_ADD', label: 'Nhân viên thêm món vào bàn' },
  { code: 'ORDER_LINE_WEIGH', label: 'Cân trọng lượng món' },
  { code: 'ORDER_LINE_STATUS_UPDATE', label: 'Cập nhật trạng thái chế biến / phục vụ' },
  { code: 'ORDER_LINE_CANCEL_REQUEST', label: 'Gửi yêu cầu hủy món' },
  { code: 'ORDER_LINE_CANCEL_REJECT', label: 'Từ chối yêu cầu hủy món' },
  { code: 'ORDER_LINE_CANCEL', label: 'Hủy món ăn' },
  { code: 'PAYMENT_REQUEST', label: 'Yêu cầu thanh toán' },
  { code: 'INVOICE_CHECKOUT', label: 'Tạo hóa đơn tạm tính' },
  { code: 'PAYMENT_COMPLETE', label: 'Xác nhận thu tiền hoàn tất' },
  { code: 'VNPAY_CREATE', label: 'Khởi tạo thanh toán VNPay' },
  { code: 'VNPAY_IPN_PAID', label: 'Xác nhận VNPay thành công' },
  { code: 'VNPAY_IPN_FAILED', label: 'Giao dịch VNPay thất bại / hủy' },
  { code: 'SEPAY_CREATE', label: 'Khởi tạo VietQR SePay' },
  { code: 'SEPAY_WEBHOOK_PAID', label: 'SePay Webhook xác nhận chuyển khoản' },
];

const KNOWN_ENTITY_TYPES = [
  'Auth',
  'Staff',
  'Branch',
  'Area',
  'Table',
  'Category',
  'MenuItem',
  'BranchMenuOverride',
  'Promotion',
  'Session',
  'Order',
  'OrderLine',
  'Invoice',
  'Payment',
];

let testWriterOverride = null;
const setTestWriter = (writer) => {
  testWriterOverride = writer;
};

/**
 * Ghi log thao tác tổng quát — không làm gián đoạn nghiệp vụ chính nếu DB log gặp sự cố ngoài ý muốn.
 */
const logActivity = async (payload, deps = {}) => {
  try {
    const model = deps.activityLogModel || activityLogModel;
    const ctx = getContext();

    const sanitizedOld = sanitizeAuditPayload(payload.oldValue);
    const sanitizedNew = sanitizeAuditPayload(payload.newValue);

    let resolvedActorName = payload.actorName;
    if (!resolvedActorName && payload.staffId) {
      if (typeof model.findStaffActorById === 'function' && !testWriterOverride) {
        try {
          const staffRow = await model.findStaffActorById(payload.staffId);
          if (staffRow) {
            resolvedActorName = `${staffRow.FullName} (${staffRow.Username})`;
          }
        } catch {
          // Fallback bên dưới nếu DB tạm thời chưa sẵn sàng
        }
      }
      if (!resolvedActorName) {
        resolvedActorName = `Nhân viên #${payload.staffId}`;
      }
    }

    const entry = {
      restaurantId: payload.restaurantId || Number(process.env.RESTAURANT_ID || 1),
      branchId: payload.branchId ?? null,
      staffId: payload.staffId ?? null,
      actorType: payload.actorType || ACTOR_TYPE.SYSTEM,
      actorName: resolvedActorName || 'Hệ thống tự động',
      entityType: payload.entityType || 'System',
      entityId: payload.entityId ?? null,
      action: payload.action || 'UNKNOWN',
      severity: payload.severity || LOG_SEVERITY.INFO,
      description: payload.description || payload.action || '',
      oldValue: sanitizedOld,
      newValue: sanitizedNew,
      ipAddress: payload.ipAddress ?? ctx?.ipAddress ?? null,
    };

    if (testWriterOverride && !deps.activityLogModel) {
      return await testWriterOverride(entry);
    }

    return await model.createLog(entry, deps.conn);
  } catch (err) {
    if (payload?.strict) throw err;
    console.error('[ACTIVITY_LOG] Không thể ghi log thao tác:', err.message);
    return null;
  }
};

/**
 * Helper ghi log nhanh cho nhân viên / quản lý có req.user.
 */
const logStaffAction = async (actorUser, payload, deps = {}) => {
  if (!actorUser) {
    return logActivity(payload, deps);
  }
  const actorName = actorUser.fullName && actorUser.username
    ? `${actorUser.fullName} (${actorUser.username})`
    : actorUser.fullName || actorUser.username || null;

  return logActivity({
    restaurantId: actorUser.restaurantId,
    branchId: payload.branchId !== undefined ? payload.branchId : actorUser.branchId,
    staffId: actorUser.staffId ?? null,
    actorType: actorUser.roleCode || ACTOR_TYPE.WAITER,
    actorName,
    ...payload,
  }, deps);
};

/**
 * Helper ghi log cho khách hàng tại bàn (không có StaffID).
 */
const logGuestAction = async (payload, deps = {}) => logActivity({
  staffId: null,
  actorType: ACTOR_TYPE.GUEST,
  actorName: payload.actorName || 'Khách tại bàn',
  ...payload,
}, deps);

/**
 * Helper ghi log cho tác vụ tự động / Webhook / IPN của hệ thống.
 */
const logSystemAction = async (payload, deps = {}) => logActivity({
  staffId: null,
  actorType: ACTOR_TYPE.SYSTEM,
  actorName: payload.actorName || 'Hệ thống tự động',
  ...payload,
}, deps);

/**
 * Truy vấn danh sách ActivityLog dành riêng cho RestaurantAdmin.
 */
const getActivityLogs = async (query, actorUser) => {
  const restaurantId = actorUser?.restaurantId || Number(process.env.RESTAURANT_ID || 1);
  const result = await activityLogModel.findLogs({
    restaurantId,
    branchId: query.branchId,
    actorType: query.actorType,
    entityType: query.entityType,
    entityId: query.entityId,
    staffId: query.staffId,
    action: query.action,
    severity: query.severity,
    startDate: query.startDate,
    endDate: query.endDate,
    search: query.search,
    page: query.page,
    pageSize: query.pageSize,
  });

  return {
    ...result,
    meta: {
      actorTypes: Object.values(ACTOR_TYPE),
      severities: Object.values(LOG_SEVERITY),
      entityTypes: KNOWN_ENTITY_TYPES,
      actions: KNOWN_ACTIONS,
    },
  };
};

/**
 * Chi tiết log + dòng thời gian liên quan cùng thực thể.
 */
const getActivityLogDetail = async (logId, actorUser) => {
  const parsedId = parseInt(logId, 10);
  if (Number.isNaN(parsedId) || parsedId <= 0) {
    const err = new Error('Mã log không hợp lệ.');
    err.statusCode = 400;
    throw err;
  }

  const restaurantId = actorUser?.restaurantId || Number(process.env.RESTAURANT_ID || 1);
  const log = await activityLogModel.findLogById(parsedId, restaurantId);
  if (!log) {
    const err = new Error('Không tìm thấy bản ghi nhật ký hoạt động.');
    err.statusCode = 404;
    throw err;
  }

  const relatedLogs = log.EntityID !== null && log.EntityID !== undefined
    ? await activityLogModel.findRelatedLogs(restaurantId, log.EntityType, log.EntityID, 20)
    : [];

  return { log, relatedLogs };
};

module.exports = {
  KNOWN_ACTIONS,
  KNOWN_ENTITY_TYPES,
  sanitizeAuditPayload,
  setTestWriter,
  logActivity,
  logStaffAction,
  logGuestAction,
  logSystemAction,
  getActivityLogs,
  getActivityLogDetail,
};
