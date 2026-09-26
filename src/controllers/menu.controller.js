'use strict';

const menuService = require('../services/menu.service');

/**
 * GET /api/menu?branchId=2
 * Public — khách quét QR không cần token.
 * restaurantId lấy từ process.env.RESTAURANT_ID, không từ client.
 */
const getMenu = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const data = await menuService.getMenu(branchId);
    res.status(200).json({ success: true, message: 'Lấy menu thành công.', data });
  } catch (err) { next(err); }
};

/**
 * POST /api/menu/items
 * Body: { categoryId, name, description?, basePrice, urlImage?, isWeightBased? }
 * Protected: RestaurantAdmin
 */
const addMenuItem = async (req, res, next) => {
  try {
    const data = await menuService.addMenuItem(req.body, req.user);
    res.status(201).json({ success: true, message: 'Thêm món ăn thành công.', data });
  } catch (err) { next(err); }
};

/**
 * PUT /api/menu/items/:menuItemId/override
 * Body: { overridePrice?, isAvailable?, branchId? (RestaurantAdmin only) }
 * Protected: BranchManager, RestaurantAdmin
 */
const setBranchOverride = async (req, res, next) => {
  try {
    const { menuItemId } = req.params;
    const data = await menuService.setBranchOverride(menuItemId, req.body, req.user);
    res.status(200).json({ success: true, message: 'Cập nhật giá chi nhánh thành công.', data });
  } catch (err) { next(err); }
};

module.exports = { getMenu, addMenuItem, setBranchOverride };
