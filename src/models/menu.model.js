'use strict';

const { pool } = require('../config/db');

/**
 * Lấy toàn bộ menu — áp dụng chiến lược giá linh hoạt (BR-21).
 *
 * Nếu có branchId: COALESCE(OverridePrice, BasePrice)
 * Nếu không:       chỉ lấy BasePrice
 *
 * Lọc theo restaurantId để cách ly multi-tenant (BR-21).
 * Lọc thêm IsAvailable từ BranchMenuOverride.
 */
const findAllMenuItems = async (restaurantId, branchId = null) => {
  if (branchId) {
    const [rows] = await pool.execute(
      `SELECT
         mi.MenuItemID,
         mi.Name,
         mi.Description,
         mi.url_Image,
         mi.IsWeightBased,
         mi.CategoryID,
         c.Name                                   AS CategoryName,
         COALESCE(bmo.OverridePrice, mi.BasePrice) AS FinalPrice,
         CASE WHEN bmo.BranchMenuOverrideID IS NOT NULL THEN 1 ELSE 0 END AS HasBranchOverride
       FROM menuitem mi
       INNER JOIN category c ON mi.CategoryID = c.CategoryID
       LEFT JOIN branchmenuoverride bmo
              ON bmo.MenuItemID = mi.MenuItemID
             AND bmo.BranchID   = ?
             AND (bmo.StartDate IS NULL OR bmo.StartDate <= NOW())
             AND (bmo.EndDate   IS NULL OR bmo.EndDate   >= NOW())
       WHERE mi.IsActive      = 1
         AND mi.RestaurantID  = ?
         AND (bmo.IsAvailable IS NULL OR bmo.IsAvailable = 1)
       ORDER BY c.Name ASC, mi.Name ASC`,
      [branchId, restaurantId]
    );
    return rows;
  }

  const [rows] = await pool.execute(
    `SELECT
       mi.MenuItemID,
       mi.Name,
       mi.Description,
       mi.url_Image,
       mi.IsWeightBased,
       mi.CategoryID,
       c.Name       AS CategoryName,
       mi.BasePrice AS FinalPrice,
       0            AS HasBranchOverride
     FROM menuitem mi
     INNER JOIN category c ON mi.CategoryID = c.CategoryID
     WHERE mi.IsActive     = 1
       AND mi.RestaurantID = ?
     ORDER BY c.Name ASC, mi.Name ASC`,
    [restaurantId]
  );
  return rows;
};

/**
 * Thêm món ăn mới ở cấp nhà hàng (RestaurantAdmin only).
 * BR-21: restaurantId lấy từ req.user, không từ client.
 */
const createMenuItem = async ({ restaurantId, categoryId, name, description, basePrice, urlImage, isWeightBased }) => {
  const [result] = await pool.execute(
    `INSERT INTO menuitem
       (RestaurantID, CategoryID, Name, Description, BasePrice, url_Image, IsWeightBased, IsActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [restaurantId, categoryId, name, description || null, basePrice, urlImage || null, isWeightBased ? 1 : 0]
  );
  return result.insertId;
};

/**
 * Upsert BranchMenuOverride — chi nhánh đặt giá riêng hoặc ẩn món.
 * Dùng INSERT ... ON DUPLICATE KEY UPDATE để idempotent.
 * BR-21: branchId lấy từ req.user.
 */
const upsertBranchOverride = async ({ branchId, menuItemId, overridePrice, isAvailable }) => {
  const [result] = await pool.execute(
    `INSERT INTO branchmenuoverride (BranchID, MenuItemID, OverridePrice, IsAvailable)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       OverridePrice = VALUES(OverridePrice),
       IsAvailable   = VALUES(IsAvailable)`,
    [branchId, menuItemId, overridePrice ?? null, isAvailable ? 1 : 0]
  );
  return result;
};

/**
 * Lấy giá hiện tại của một món cho một chi nhánh.
 * Dùng trong order service để snapshot giá (BR-07).
 */
const getCurrentPriceForBranch = async (menuItemId, branchId, restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT
       mi.MenuItemID,
       mi.Name,
       mi.IsWeightBased,
       mi.RestaurantID,
       COALESCE(bmo.OverridePrice, mi.BasePrice) AS FinalPrice,
       CASE WHEN bmo.IsAvailable = 0 THEN 0 ELSE 1 END AS IsAvailable
     FROM menuitem mi
     LEFT JOIN branchmenuoverride bmo
            ON bmo.MenuItemID = mi.MenuItemID
           AND bmo.BranchID   = ?
           AND (bmo.StartDate IS NULL OR bmo.StartDate <= NOW())
           AND (bmo.EndDate   IS NULL OR bmo.EndDate   >= NOW())
     WHERE mi.MenuItemID    = ?
       AND mi.RestaurantID  = ?
       AND mi.IsActive      = 1`,
    [branchId, menuItemId, restaurantId]
  );
  return rows[0] || null;
};

module.exports = { findAllMenuItems, createMenuItem, upsertBranchOverride, getCurrentPriceForBranch };
