'use strict';

const promotionModel = require('../models/promotion.model');

const APPLY_LEVELS = ['INVOICE', 'MENU_ITEM', 'CATEGORY'];

const httpError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const fmtMoney = (n) => new Intl.NumberFormat('vi-VN').format(Math.round(n)) + 'đ';
const round2 = (n) => Math.round(n * 100) / 100;

const toPositiveOrNull = (value, label, { integer = false } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw httpError(`${label} không hợp lệ.`);
  }
  return n === 0 ? null : n;
};

/**
 * Chuẩn hóa + kiểm tra dữ liệu phạm vi / điều kiện của khuyến mãi.
 * Các trường mục tiêu không liên quan tới ApplyLevel sẽ bị dọn về rỗng.
 */
const normalizeScope = async (data, restaurantId) => {
  const applyLevel = data.applyLevel || 'INVOICE';
  if (!APPLY_LEVELS.includes(applyLevel)) {
    throw httpError('applyLevel phải là INVOICE, MENU_ITEM hoặc CATEGORY.');
  }

  let menuItemIds = data.menuItemIds;
  let targetCategoryId = null;

  if (applyLevel === 'MENU_ITEM') {
    const ids = [...new Set((menuItemIds || []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) throw httpError('Vui lòng chọn ít nhất một món áp dụng khuyến mãi.');
    const valid = await promotionModel.findMenuItemIdsOfRestaurant(restaurantId, ids);
    if (valid.length !== ids.length) throw httpError('Có món không thuộc nhà hàng của bạn.');
    menuItemIds = ids;
  } else {
    menuItemIds = [];
  }

  if (applyLevel === 'CATEGORY') {
    targetCategoryId = Number(data.targetCategoryId);
    if (!Number.isInteger(targetCategoryId) || targetCategoryId <= 0) {
      throw httpError('Vui lòng chọn danh mục áp dụng khuyến mãi.');
    }
    if (!(await promotionModel.categoryBelongsToRestaurant(restaurantId, targetCategoryId))) {
      throw httpError('Danh mục không thuộc nhà hàng của bạn.');
    }
  }

  return {
    applyLevel,
    menuItemIds,
    targetCategoryId,
    minOrderAmount: toPositiveOrNull(data.minOrderAmount, 'Giá trị hóa đơn tối thiểu'),
    minItemCount: toPositiveOrNull(data.minItemCount, 'Số món tối thiểu', { integer: true }),
  };
};

const validateDiscount = (discountType, discountValue) => {
  if (!['PERCENT', 'FIXED'].includes(discountType)) {
    throw httpError('discountType phải là PERCENT hoặc FIXED.');
  }
  const v = Number(discountValue);
  if (!Number.isFinite(v) || v <= 0) throw httpError('Giá trị giảm phải lớn hơn 0.');
  if (discountType === 'PERCENT' && v > 100) throw httpError('Giảm phần trăm không được vượt quá 100%.');
};

const getPromotions = async (actorUser, queryBranchId = null) => {
  const { ROLE_CODE } = require('../constants/status');
  let targetBranchId = null;

  if (actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER || actorUser.roleCode === ROLE_CODE.CASHIER) {
    targetBranchId = actorUser.branchId;
  } else if (actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN && queryBranchId) {
    targetBranchId = parseInt(queryBranchId, 10);
  }

  return promotionModel.findPromotionsByRestaurant(actorUser.restaurantId, targetBranchId);
};

const createPromotion = async (data, actorUser) => {
  const { name, discountType, discountValue, startDate } = data;
  if (!name || !discountType || !discountValue || !startDate) {
    throw httpError('name, discountType, discountValue, startDate là bắt buộc.');
  }
  validateDiscount(discountType, discountValue);
  const scope = await normalizeScope(data, actorUser.restaurantId);

  const { ROLE_CODE } = require('../constants/status');
  let branchId = null;
  if (actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER) {
    if (!actorUser.branchId) throw httpError('Không xác định được chi nhánh của quản lý.', 400);
    branchId = actorUser.branchId;
  } else if (actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN) {
    branchId = data.branchId ? parseInt(data.branchId, 10) : null;
  }

  const promotionId = await promotionModel.createPromotion({
    ...data, ...scope, branchId, restaurantId: actorUser.restaurantId,
  });
  return { promotionId, ...data, ...scope, branchId };
};

const updatePromotion = async (promotionId, data, actorUser) => {
  const promotion = await promotionModel.findPromotionById(promotionId);
  if (!promotion) throw httpError('Không tìm thấy khuyến mãi.', 404);
  if (promotion.RestaurantID !== actorUser.restaurantId) {
    throw httpError('Không có quyền chỉnh sửa khuyến mãi này.', 403);
  }

  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER) {
    if (promotion.BranchID !== actorUser.branchId) {
      throw httpError('Quản lý chi nhánh chỉ được chỉnh sửa khuyến mãi của chi nhánh mình.', 403);
    }
  }

  let branchId = promotion.BranchID;
  if (actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN && data.branchId !== undefined) {
    branchId = data.branchId ? parseInt(data.branchId, 10) : null;
  }

  const scopeTouched = ['applyLevel', 'menuItemIds', 'targetCategoryId', 'minOrderAmount', 'minItemCount']
    .some((k) => data[k] !== undefined);

  const discountType  = data.discountType  ?? promotion.DiscountType;
  const discountValue = data.discountValue ?? promotion.DiscountValue;
  validateDiscount(discountType, discountValue);

  let scope;
  if (scopeTouched) {
    scope = await normalizeScope({
      applyLevel:       data.applyLevel       ?? promotion.ApplyLevel,
      targetCategoryId: data.targetCategoryId !== undefined ? data.targetCategoryId : promotion.TargetCategoryID,
      menuItemIds:      data.menuItemIds      !== undefined ? data.menuItemIds : await promotionModel.findPromotionMenuItemIds(promotionId),
      minOrderAmount:   data.minOrderAmount   !== undefined ? data.minOrderAmount : promotion.MinOrderAmount,
      minItemCount:     data.minItemCount     !== undefined ? data.minItemCount : promotion.MinItemCount,
    }, actorUser.restaurantId);
  } else {
    // Chỉ đổi trường khác (vd. bật/tắt) → giữ nguyên phạm vi & điều kiện hiện có.
    scope = {
      applyLevel: promotion.ApplyLevel,
      targetCategoryId: promotion.TargetCategoryID,
      minOrderAmount: promotion.MinOrderAmount,
      minItemCount: promotion.MinItemCount,
      menuItemIds: undefined,
    };
  }

  const merged = {
    name:          data.name          ?? promotion.Name,
    description:   data.description   ?? promotion.Description,
    branchId,
    discountType,
    discountValue,
    maxUsage:      data.maxUsage      !== undefined ? data.maxUsage : promotion.MaxUsage,
    startDate:     data.startDate     ?? promotion.StartDate,
    endDate:       data.endDate       !== undefined ? data.endDate : promotion.EndDate,
    isActive:      data.isActive      !== undefined ? data.isActive : promotion.IsActive,
    ...scope,
  };
  await promotionModel.updatePromotion(promotionId, merged);
  return { promotionId: parseInt(promotionId, 10), ...merged };
};

/**
 * Kiểm tra điều kiện & tính số tiền giảm của một khuyến mãi trên các dòng hóa đơn.
 *
 * - INVOICE   : giảm trên toàn bộ tạm tính.
 * - MENU_ITEM : chỉ giảm trên các dòng thuộc danh sách món của khuyến mãi.
 * - CATEGORY  : chỉ giảm trên các dòng thuộc danh mục của khuyến mãi.
 * - FIXED với MENU_ITEM/CATEGORY: giảm "giá trị × số lượng" cho từng dòng (tối đa bằng thành tiền dòng đó).
 *
 * Điều kiện:
 * - MinOrderAmount: so với tạm tính của CẢ hóa đơn.
 * - MinItemCount  : tổng số lượng của các món thuộc phạm vi khuyến mãi
 *                   (INVOICE → toàn bộ món, MENU_ITEM/CATEGORY → chỉ món áp dụng).
 *
 * @param {object} promotion      Row bảng promotion
 * @param {Array}  lines          [{ MenuItemID, CategoryID, Quantity, Amount }]
 * @param {number} subTotal       Tạm tính toàn hóa đơn
 * @param {number[]} menuItemIds  Món áp dụng (khi ApplyLevel = MENU_ITEM)
 * @returns {{ ok: boolean, discountAmount: number, reason: string|null }}
 */
const evaluatePromotion = (promotion, lines, subTotal, menuItemIds = []) => {
  const level = promotion.ApplyLevel || 'INVOICE';
  const value = parseFloat(promotion.DiscountValue);
  const idSet = new Set(menuItemIds.map(Number));

  let eligible = lines;
  if (level === 'MENU_ITEM') {
    eligible = lines.filter((l) => idSet.has(Number(l.MenuItemID)));
  } else if (level === 'CATEGORY') {
    eligible = lines.filter((l) => Number(l.CategoryID) === Number(promotion.TargetCategoryID));
  }

  if (level !== 'INVOICE' && eligible.length === 0) {
    return {
      ok: false, discountAmount: 0,
      reason: level === 'MENU_ITEM'
        ? 'Hóa đơn không có món nào thuộc chương trình khuyến mãi này.'
        : 'Hóa đơn không có món nào thuộc danh mục của chương trình khuyến mãi này.',
    };
  }

  const minAmount = promotion.MinOrderAmount != null ? parseFloat(promotion.MinOrderAmount) : 0;
  if (minAmount > 0 && subTotal < minAmount) {
    return {
      ok: false, discountAmount: 0,
      reason: `Khuyến mãi chỉ áp dụng cho hóa đơn từ ${fmtMoney(minAmount)} (hiện tại ${fmtMoney(subTotal)}).`,
    };
  }

  const itemCount = eligible.reduce((s, l) => s + parseFloat(l.Quantity), 0);
  const minCount = promotion.MinItemCount != null ? Number(promotion.MinItemCount) : 0;
  if (minCount > 0 && itemCount < minCount) {
    return {
      ok: false, discountAmount: 0,
      reason: `Khuyến mãi yêu cầu tối thiểu ${minCount} món áp dụng (hiện có ${itemCount}).`,
    };
  }

  let discount;
  if (level === 'INVOICE') {
    discount = promotion.DiscountType === 'PERCENT'
      ? subTotal * (value / 100)
      : Math.min(value, subTotal);
  } else if (promotion.DiscountType === 'PERCENT') {
    discount = eligible.reduce((s, l) => s + l.Amount * (value / 100), 0);
  } else {
    discount = eligible.reduce((s, l) => s + Math.min(value * parseFloat(l.Quantity), l.Amount), 0);
  }

  return { ok: true, discountAmount: round2(discount), reason: null };
};

module.exports = { getPromotions, createPromotion, updatePromotion, evaluatePromotion };
