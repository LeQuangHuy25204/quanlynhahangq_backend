'use strict';

const menuModel = require('../models/menu.model');

/**
 * Lấy danh sách menu, nhóm theo Category.
 *
 * Hệ thống 1 nhà hàng: restaurantId lấy từ process.env.RESTAURANT_ID,
 * không cần client truyền lên.
 * branchId (tuỳ chọn): nếu có thì ưu tiên giá chi nhánh (BranchMenuOverride).
 *
 * @param {string|undefined} branchId - Query param từ client
 */
const getMenu = async (branchId) => {
  const restaurantId = parseInt(process.env.RESTAURANT_ID, 10);
  if (!restaurantId) {
    const err = new Error('RESTAURANT_ID chưa được cấu hình trong biến môi trường.');
    err.statusCode = 500;
    throw err;
  }

  const parsedBranchId = branchId ? parseInt(branchId, 10) : null;
  if (branchId && isNaN(parsedBranchId)) {
    const err = new Error('branchId không hợp lệ.');
    err.statusCode = 400;
    throw err;
  }

  const items = await menuModel.findAllMenuItems(restaurantId, parsedBranchId);

  // Nhóm theo danh mục để Frontend dễ render
  const grouped = items.reduce((acc, item) => {
    if (!acc[item.CategoryID]) {
      acc[item.CategoryID] = {
        categoryId:   item.CategoryID,
        categoryName: item.CategoryName,
        items:        [],
      };
    }
    acc[item.CategoryID].items.push({
      menuItemId:        item.MenuItemID,
      name:              item.Name,
      description:       item.Description,
      imageUrl:          item.url_Image,
      isWeightBased:     item.IsWeightBased === 1,
      finalPrice:        parseFloat(item.FinalPrice),
      hasBranchOverride: item.HasBranchOverride === 1,
    });
    return acc;
  }, {});

  return { totalItems: items.length, categories: Object.values(grouped) };
};

/**
 * Thêm món ăn mới ở cấp nhà hàng (RestaurantAdmin only).
 * restaurantId lấy từ req.user (JWT) — không từ body client.
 */
const addMenuItem = async (data, actorUser) => {
  const { categoryId, name, description, basePrice, urlImage, isWeightBased } = data;

  if (!categoryId || !name || basePrice == null) {
    const err = new Error('categoryId, name và basePrice là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }
  if (parseFloat(basePrice) < 0) {
    const err = new Error('BasePrice không được âm.');
    err.statusCode = 400;
    throw err;
  }

  const insertId = await menuModel.createMenuItem({
    restaurantId: actorUser.restaurantId, // từ JWT, không từ body
    categoryId,
    name,
    description,
    basePrice:    parseFloat(basePrice),
    urlImage,
    isWeightBased: !!isWeightBased,
  });

  return { menuItemId: insertId };
};

/**
 * Cập nhật bản đè giá chi nhánh.
 * branchId: BranchManager dùng branchId của mình (từ JWT).
 *           RestaurantAdmin có thể chỉ định branchId cụ thể qua body.
 */
const setBranchOverride = async (menuItemId, data, actorUser) => {
  const { overridePrice, isAvailable } = data;

  if (overridePrice != null && parseFloat(overridePrice) < 0) {
    const err = new Error('overridePrice không được âm.');
    err.statusCode = 400;
    throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  let targetBranchId = actorUser.branchId;

  // RestaurantAdmin có thể override cho bất kỳ chi nhánh nào
  if (actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN && data.branchId) {
    targetBranchId = parseInt(data.branchId, 10);
  }

  if (!targetBranchId) {
    const err = new Error('Không xác định được branchId để tạo override.');
    err.statusCode = 400;
    throw err;
  }

  await menuModel.upsertBranchOverride({
    branchId:      targetBranchId,
    menuItemId:    parseInt(menuItemId, 10),
    overridePrice: overridePrice != null ? parseFloat(overridePrice) : null,
    isAvailable:   isAvailable !== undefined ? !!isAvailable : true,
  });

  return { menuItemId: parseInt(menuItemId, 10), branchId: targetBranchId };
};

module.exports = { getMenu, addMenuItem, setBranchOverride };
