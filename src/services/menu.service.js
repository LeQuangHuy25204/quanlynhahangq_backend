'use strict';

const menuModel = require('../models/menu.model');
const activityLogService = require('./activityLog.service');
const { LOG_SEVERITY } = require('../constants/status');

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
  const restaurantId = parseInt(process.env.RESTAURANT_ID || '1', 10);
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
    const stockQty = item.StockQuantity !== null && item.StockQuantity !== undefined ? parseFloat(item.StockQuantity) : null;
    const lowThresh = item.LowStockThreshold !== null && item.LowStockThreshold !== undefined ? parseFloat(item.LowStockThreshold) : 5;
    const isOutOfStock = item.IsAvailable === 0 || (stockQty !== null && stockQty <= 0);
    const isLowStock = !isOutOfStock && stockQty !== null && stockQty > 0 && stockQty <= lowThresh;

    acc[item.CategoryID].items.push({
      menuItemId:        item.MenuItemID,
      name:              item.Name,
      description:       item.Description,
      imageUrl:          item.url_Image,
      unit:              item.Unit || 'Phần',
      isWeightBased:     item.IsWeightBased === 1,
      finalPrice:        parseFloat(item.FinalPrice),
      hasBranchOverride: item.HasBranchOverride === 1,
      stockQuantity:     stockQty,
      lowStockThreshold: lowThresh,
      isAvailable:       !isOutOfStock,
      isOutOfStock,
      isLowStock,
    });
    return acc;
  }, {});

  return { totalItems: items.length, categories: Object.values(grouped) };
};

/**
 * Thêm món ăn mới:
 * - RestaurantAdmin: tạo món toàn chuỗi (branchId=null) hoặc món riêng cho chi nhánh (branchId chỉ định).
 * - BranchManager: tạo món ăn riêng cho chi nhánh của mình (branchId = actorUser.branchId).
 */
const addMenuItem = async (data, actorUser) => {
  const { categoryId, name, description, basePrice, urlImage, isWeightBased } = data;
  const { ROLE_CODE } = require('../constants/status');

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

  let branchId = null;
  if (actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER) {
    if (!actorUser.branchId) {
      const err = new Error('Không xác định được chi nhánh của quản lý.');
      err.statusCode = 400;
      throw err;
    }
    branchId = actorUser.branchId;
  } else if (actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN) {
    branchId = data.branchId ? parseInt(data.branchId, 10) : null;
  }

  const insertId = await menuModel.createMenuItem({
    restaurantId: actorUser.restaurantId,
    branchId,
    categoryId,
    name,
    description,
    basePrice:    parseFloat(basePrice),
    urlImage,
    isWeightBased: !!isWeightBased,
  });

  await activityLogService.logStaffAction(actorUser, {
    branchId,
    entityType: 'MenuItem',
    entityId: insertId,
    action: 'MENU_ITEM_CREATE',
    severity: LOG_SEVERITY.WARNING,
    description: `Thêm món mới "${name}" (giá gốc ${parseFloat(basePrice).toLocaleString('vi-VN')}đ)${branchId ? ` cho chi nhánh #${branchId}` : ' (toàn chuỗi)'}.`,
    newValue: {
      menuItemId: insertId,
      branchId,
      categoryId,
      name,
      basePrice: parseFloat(basePrice),
      isWeightBased: !!isWeightBased,
    },
  });

  return { menuItemId: insertId, branchId };
};

/**
 * Cập nhật bản đè giá chi nhánh.
 * branchId: BranchManager dùng branchId của mình (từ JWT).
 *           RestaurantAdmin có thể chỉ định branchId cụ thể qua body.
 */
const setBranchOverride = async (menuItemId, data, actorUser) => {
  const { overridePrice, isAvailable, stockQuantity, lowStockThreshold } = data;

  if (overridePrice != null && parseFloat(overridePrice) < 0) {
    const err = new Error('overridePrice không được âm.');
    err.statusCode = 400;
    throw err;
  }

  let parsedStock = null;
  if (stockQuantity !== undefined && stockQuantity !== null && stockQuantity !== '') {
    parsedStock = parseFloat(stockQuantity);
    if (isNaN(parsedStock) || parsedStock < 0) {
      const err = new Error('Số lượng tồn kho không được âm.');
      err.statusCode = 400;
      throw err;
    }
  }

  let parsedThreshold = 5;
  if (lowStockThreshold !== undefined && lowStockThreshold !== null && lowStockThreshold !== '') {
    parsedThreshold = parseFloat(lowStockThreshold);
    if (isNaN(parsedThreshold) || parsedThreshold < 0) {
      const err = new Error('Mốc cảnh báo sắp hết hàng không được âm.');
      err.statusCode = 400;
      throw err;
    }
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

  const parsedMenuItemId = parseInt(menuItemId, 10);
  const [prevOverride, menuItemRow] = await Promise.all([
    menuModel.findBranchOverride(targetBranchId, parsedMenuItemId),
    menuModel.findMenuItemById(parsedMenuItemId),
  ]);

  const nextAvailable = isAvailable !== undefined ? !!isAvailable : true;
  const nextOverridePrice = overridePrice != null ? parseFloat(overridePrice) : null;

  await menuModel.upsertBranchOverride({
    branchId:          targetBranchId,
    menuItemId:        parsedMenuItemId,
    overridePrice:     nextOverridePrice,
    isAvailable:       nextAvailable,
    stockQuantity:     parsedStock,
    lowStockThreshold: parsedThreshold,
  });

  await activityLogService.logStaffAction(actorUser, {
    branchId: targetBranchId,
    entityType: 'BranchMenuOverride',
    entityId: parsedMenuItemId,
    action: 'MENU_OVERRIDE_UPDATE',
    severity: LOG_SEVERITY.WARNING,
    description: `Cập nhật cấu hình/tồn kho món "${menuItemRow?.Name || `#${parsedMenuItemId}`}" tại chi nhánh #${targetBranchId}.`,
    oldValue: prevOverride ? {
      overridePrice: prevOverride.OverridePrice != null ? parseFloat(prevOverride.OverridePrice) : null,
      isAvailable: prevOverride.IsAvailable === 1,
      stockQuantity: prevOverride.StockQuantity != null ? parseFloat(prevOverride.StockQuantity) : null,
      lowStockThreshold: prevOverride.LowStockThreshold != null ? parseFloat(prevOverride.LowStockThreshold) : 5,
    } : null,
    newValue: {
      overridePrice: nextOverridePrice,
      isAvailable: (parsedStock !== null && parsedStock <= 0) ? false : nextAvailable,
      stockQuantity: parsedStock,
      lowStockThreshold: parsedThreshold,
    },
  });

  return { menuItemId: parsedMenuItemId, branchId: targetBranchId };
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
      menuItemId:          r.MenuItemID,
      branchId:            r.BranchID,
      branchExclusiveName: r.BranchExclusiveName,
      categoryId:          r.CategoryID,
      categoryName:        r.CategoryName,
      name:                r.Name,
      description:         r.Description,
      imageUrl:            r.url_Image,
      unit:                r.Unit,
      basePrice:           parseFloat(r.BasePrice),
      overridePrice:       r.OverridePrice != null ? parseFloat(r.OverridePrice) : null,
      isWeightBased:       r.IsWeightBased === 1,
      isActive:            r.IsActive === 1,
      branchAvailable:     r.BranchAvailable === 1,
      stockQuantity:       r.StockQuantity !== null && r.StockQuantity !== undefined ? parseFloat(r.StockQuantity) : null,
      lowStockThreshold:   r.LowStockThreshold !== null && r.LowStockThreshold !== undefined ? parseFloat(r.LowStockThreshold) : 5,
      isOutOfStock:        r.StockQuantity !== null && parseFloat(r.StockQuantity) <= 0,
      isLowStock:          r.StockQuantity !== null && parseFloat(r.StockQuantity) > 0 && parseFloat(r.StockQuantity) <= parseFloat(r.LowStockThreshold ?? 5),
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
  await activityLogService.logStaffAction(actorUser, {
    branchId: null,
    entityType: 'Category',
    entityId: categoryId,
    action: 'CATEGORY_CREATE',
    severity: LOG_SEVERITY.INFO,
    description: `Tạo danh mục món ăn mới "${String(name).trim()}".`,
    newValue: { categoryId, name: String(name).trim(), description: description || null },
  });
  return { categoryId, name: String(name).trim() };
};

const updateMenuItem = async (menuItemId, data, actorUser) => {
  const item = await menuModel.findMenuItemById(menuItemId);
  if (!item || item.RestaurantID !== actorUser.restaurantId) {
    const err = new Error('Không tìm thấy món ăn.'); err.statusCode = 404; throw err;
  }

  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode === ROLE_CODE.BRANCH_MANAGER) {
    if (item.BranchID !== actorUser.branchId) {
      const err = new Error('Quản lý chi nhánh chỉ được chỉnh sửa thông tin món riêng của chi nhánh mình. Với món toàn chuỗi, vui lòng dùng tính năng điều chỉnh chi nhánh.');
      err.statusCode = 403;
      throw err;
    }
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

  let branchId = item.BranchID;
  if (actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN && data.branchId !== undefined) {
    branchId = data.branchId ? parseInt(data.branchId, 10) : null;
  }

  const nextDesc = data.description !== undefined ? data.description : item.Description;
  const nextUrl = data.urlImage !== undefined ? data.urlImage : item.url_Image;
  const nextWeightBased = data.isWeightBased !== undefined ? !!data.isWeightBased : item.IsWeightBased === 1;
  const nextActive = data.isActive !== undefined ? !!data.isActive : item.IsActive === 1;

  await menuModel.updateMenuItem(menuItemId, {
    categoryId,
    name,
    description:   nextDesc,
    basePrice,
    urlImage:      nextUrl,
    isWeightBased: nextWeightBased,
    isActive:      nextActive,
    branchId,
  });

  const criticalChanged = basePrice !== parseFloat(item.BasePrice) || nextActive !== (item.IsActive === 1);
  await activityLogService.logStaffAction(actorUser, {
    branchId,
    entityType: 'MenuItem',
    entityId: parseInt(menuItemId, 10),
    action: 'MENU_ITEM_UPDATE',
    severity: criticalChanged ? LOG_SEVERITY.CRITICAL : LOG_SEVERITY.WARNING,
    description: `Cập nhật món "${name}" (#${menuItemId}).`,
    oldValue: {
      name: item.Name,
      categoryId: item.CategoryID,
      basePrice: parseFloat(item.BasePrice),
      isWeightBased: item.IsWeightBased === 1,
      isActive: item.IsActive === 1,
      branchId: item.BranchID,
    },
    newValue: {
      name,
      categoryId,
      basePrice,
      isWeightBased: nextWeightBased,
      isActive: nextActive,
      branchId,
    },
  });

  return { menuItemId: parseInt(menuItemId, 10), branchId };
};

module.exports = { getMenu, addMenuItem, setBranchOverride, getAdminMenu, getCategories, createCategory, updateMenuItem };
