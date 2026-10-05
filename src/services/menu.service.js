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

/**
 * Danh sách món cho màn quản trị (gồm món ngừng bán / bị chi nhánh ẩn).
 * BranchManager luôn xem chi nhánh của mình; RestaurantAdmin chỉ định qua query branchId.
 */
const getAdminMenu = async (branchId, actorUser) => {
  const { ROLE_CODE } = require('../constants/status');
  const target = actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN
    ? parseInt(branchId, 10) || actorUser.branchId
    : actorUser.branchId;
  if (!target) {
    const err = new Error('Không xác định được chi nhánh.'); err.statusCode = 400; throw err;
  }
  const rows = await menuModel.findAllMenuItemsForAdmin(actorUser.restaurantId, target);
  return {
    branchId: target,
    items: rows.map((r) => ({
      menuItemId:      r.MenuItemID,
      categoryId:      r.CategoryID,
      categoryName:    r.CategoryName,
      name:            r.Name,
      description:     r.Description,
      imageUrl:        r.url_Image,
      unit:            r.Unit,
      basePrice:       parseFloat(r.BasePrice),
      overridePrice:   r.OverridePrice != null ? parseFloat(r.OverridePrice) : null,
      isWeightBased:   r.IsWeightBased === 1,
      isActive:        r.IsActive === 1,
      branchAvailable: r.BranchAvailable === 1,
    })),
  };
};

const getCategories = async (actorUser) => {
  const rows = await menuModel.findCategories(actorUser.restaurantId);
  return rows.map((r) => ({
    categoryId:  r.CategoryID,
    name:        r.Name,
    description: r.Description,
    itemCount:   Number(r.ItemCount),
  }));
};

const createCategory = async ({ name, description }, actorUser) => {
  if (!name || !String(name).trim()) {
    const err = new Error('Tên danh mục là bắt buộc.'); err.statusCode = 400; throw err;
  }
  const categoryId = await menuModel.createCategory({
    restaurantId: actorUser.restaurantId,
    name: String(name).trim(),
    description,
  });
  return { categoryId, name: String(name).trim() };
};

const updateMenuItem = async (menuItemId, data, actorUser) => {
  const item = await menuModel.findMenuItemById(menuItemId);
  if (!item || item.RestaurantID !== actorUser.restaurantId) {
    const err = new Error('Không tìm thấy món ăn.'); err.statusCode = 404; throw err;
  }
  const basePrice = data.basePrice != null ? parseFloat(data.basePrice) : parseFloat(item.BasePrice);
  if (isNaN(basePrice) || basePrice < 0) {
    const err = new Error('BasePrice không hợp lệ.'); err.statusCode = 400; throw err;
  }
  let categoryId = item.CategoryID;
  if (data.categoryId != null && Number(data.categoryId) !== item.CategoryID) {
    const cat = await menuModel.findCategoryById(data.categoryId);
    if (!cat || cat.RestaurantID !== actorUser.restaurantId) {
      const err = new Error('Danh mục không hợp lệ.'); err.statusCode = 400; throw err;
    }
    categoryId = cat.CategoryID;
  }
  const name = data.name != null ? String(data.name).trim() : item.Name;
  if (!name) {
    const err = new Error('Tên món không được trống.'); err.statusCode = 400; throw err;
  }
  await menuModel.updateMenuItem(menuItemId, {
    categoryId,
    name,
    description:   data.description !== undefined ? data.description : item.Description,
    basePrice,
    urlImage:      data.urlImage !== undefined ? data.urlImage : item.url_Image,
    isWeightBased: data.isWeightBased !== undefined ? !!data.isWeightBased : item.IsWeightBased === 1,
    isActive:      data.isActive !== undefined ? !!data.isActive : item.IsActive === 1,
  });
  return { menuItemId: parseInt(menuItemId, 10) };
};

module.exports = { getMenu, addMenuItem, setBranchOverride, getAdminMenu, getCategories, createCategory, updateMenuItem };
