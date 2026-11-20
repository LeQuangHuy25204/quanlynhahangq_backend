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
         mi.BranchID,
         mi.Name,
         mi.Description,
         mi.url_Image,
         mi.Unit,
         mi.IsWeightBased,
         mi.CategoryID,
         c.Name                                   AS CategoryName,
         COALESCE(bmo.OverridePrice, mi.BasePrice) AS FinalPrice,
         CASE WHEN bmo.BranchMenuOverrideID IS NOT NULL THEN 1 ELSE 0 END AS HasBranchOverride,
         bmo.StockQuantity,
         COALESCE(bmo.LowStockThreshold, 5) AS LowStockThreshold,
         CASE
           WHEN bmo.IsAvailable = 0 THEN 0
           WHEN bmo.StockQuantity IS NOT NULL AND bmo.StockQuantity <= 0 THEN 0
           ELSE 1
         END AS IsAvailable
       FROM menuitem mi
       INNER JOIN category c ON mi.CategoryID = c.CategoryID
       LEFT JOIN branchmenuoverride bmo
              ON bmo.MenuItemID = mi.MenuItemID
             AND bmo.BranchID   = ?
             AND (bmo.StartDate IS NULL OR bmo.StartDate <= NOW())
             AND (bmo.EndDate   IS NULL OR bmo.EndDate   >= NOW())
       WHERE mi.IsActive      = 1
         AND mi.RestaurantID  = ?
         AND (mi.BranchID IS NULL OR mi.BranchID = ?)
       ORDER BY c.Name ASC, mi.Name ASC`,
      [branchId, restaurantId, branchId]
    );
    return rows;
  }

  const [rows] = await pool.execute(
    `SELECT
       mi.MenuItemID,
       mi.BranchID,
       mi.Name,
       mi.Description,
       mi.url_Image,
       mi.Unit,
       mi.IsWeightBased,
       mi.CategoryID,
       c.Name       AS CategoryName,
       mi.BasePrice AS FinalPrice,
       0            AS HasBranchOverride,
       NULL         AS StockQuantity,
       5            AS LowStockThreshold,
       1            AS IsAvailable
     FROM menuitem mi
     INNER JOIN category c ON mi.CategoryID = c.CategoryID
     WHERE mi.IsActive     = 1
       AND mi.RestaurantID = ?
       AND mi.BranchID IS NULL
     ORDER BY c.Name ASC, mi.Name ASC`,
    [restaurantId]
  );
  return rows;
};

/**
 * Thêm món ăn mới (ở cấp toàn chuỗi nếu branchId=null, hoặc riêng chi nhánh nếu branchId có giá trị).
 */
const createMenuItem = async ({ restaurantId, branchId, categoryId, name, description, basePrice, urlImage, isWeightBased }) => {
  const [result] = await pool.execute(
    `INSERT INTO menuitem
       (RestaurantID, BranchID, CategoryID, Name, Description, BasePrice, url_Image, IsWeightBased, IsActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [restaurantId, branchId || null, categoryId, name, description || null, basePrice, urlImage || null, isWeightBased ? 1 : 0]
  );
  return result.insertId;
};

/**
 * Upsert BranchMenuOverride — chi nhánh đặt giá riêng hoặc ẩn món.
 * Dùng INSERT ... ON DUPLICATE KEY UPDATE để idempotent.
 * BR-21: branchId lấy từ req.user.
 */
const upsertBranchOverride = async ({ branchId, menuItemId, overridePrice, isAvailable, stockQuantity = null, lowStockThreshold = 5 }) => {
  const effectiveAvailable = (stockQuantity !== null && Number(stockQuantity) <= 0)
    ? 0
    : (isAvailable ? 1 : 0);

  const [result] = await pool.execute(
    `INSERT INTO branchmenuoverride (BranchID, MenuItemID, OverridePrice, IsAvailable, StockQuantity, LowStockThreshold)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       OverridePrice     = VALUES(OverridePrice),
       IsAvailable       = VALUES(IsAvailable),
       StockQuantity     = VALUES(StockQuantity),
       LowStockThreshold = VALUES(LowStockThreshold)`,
    [
      branchId,
      menuItemId,
      overridePrice ?? null,
      effectiveAvailable,
      stockQuantity !== null && stockQuantity !== undefined ? Number(stockQuantity) : null,
      lowStockThreshold !== null && lowStockThreshold !== undefined ? Number(lowStockThreshold) : 5,
    ]
  );
  return result;
};

/**
 * Trừ tồn kho nguyên tử khi khách đặt món (chỉ trừ nếu StockQuantity IS NOT NULL).
 * Tự động khóa món (IsAvailable = 0) nếu tồn kho chạm 0.
 */
const deductBranchStock = async (branchId, menuItemId, quantity, conn = pool) => {
  const [rows] = await conn.execute(
    `SELECT StockQuantity FROM branchmenuoverride WHERE BranchID = ? AND MenuItemID = ? FOR UPDATE`,
    [branchId, menuItemId]
  );
  if (!rows.length || rows[0].StockQuantity === null) {
    return { tracked: false, ok: true };
  }

  const [result] = await conn.execute(
    `UPDATE branchmenuoverride
     SET StockQuantity = StockQuantity - ?,
         IsAvailable   = CASE WHEN StockQuantity - ? <= 0 THEN 0 ELSE IsAvailable END
     WHERE BranchID = ?
       AND MenuItemID = ?
       AND StockQuantity IS NOT NULL
       AND StockQuantity >= ?`,
    [quantity, quantity, branchId, menuItemId, quantity]
  );
  return { tracked: true, ok: result.affectedRows > 0 };
};

/**
 * Điều chỉnh / hoàn trả tồn kho (khi hủy món hoặc cân lại trọng lượng món).
 * Nếu tồn kho tăng từ <= 0 lên > 0 thì tự động mở lại món (IsAvailable = 1).
 */
const adjustBranchStock = async (branchId, menuItemId, delta, conn = pool) => {
  const [rows] = await conn.execute(
    `SELECT StockQuantity FROM branchmenuoverride WHERE BranchID = ? AND MenuItemID = ? FOR UPDATE`,
    [branchId, menuItemId]
  );
  if (!rows.length || rows[0].StockQuantity === null) {
    return { tracked: false, ok: true };
  }

  if (delta < 0) {
    const need = Math.abs(delta);
    const [result] = await conn.execute(
      `UPDATE branchmenuoverride
       SET StockQuantity = GREATEST(0, StockQuantity - ?),
           IsAvailable   = CASE WHEN StockQuantity - ? <= 0 THEN 0 ELSE IsAvailable END
       WHERE BranchID = ? AND MenuItemID = ? AND StockQuantity IS NOT NULL`,
      [need, need, branchId, menuItemId]
    );
    return { tracked: true, ok: result.affectedRows > 0 };
  }

  const [result] = await conn.execute(
    `UPDATE branchmenuoverride
     SET StockQuantity = StockQuantity + ?,
         IsAvailable   = CASE WHEN StockQuantity + ? > 0 THEN 1 ELSE 0 END
     WHERE BranchID = ? AND MenuItemID = ? AND StockQuantity IS NOT NULL`,
    [delta, delta, branchId, menuItemId]
  );
  return { tracked: true, ok: result.affectedRows > 0 };
};

/**
 * Lấy giá hiện tại của một món cho một chi nhánh.
 * Dùng trong order service để snapshot giá (BR-07).
 */
const getCurrentPriceForBranch = async (menuItemId, branchId, restaurantId, conn = pool) => {
  const [rows] = await conn.execute(
    `SELECT
       mi.MenuItemID,
       mi.Name,
       mi.Unit,
       mi.IsWeightBased,
       mi.RestaurantID,
       COALESCE(bmo.OverridePrice, mi.BasePrice) AS FinalPrice,
       bmo.StockQuantity,
       COALESCE(bmo.LowStockThreshold, 5) AS LowStockThreshold,
       CASE
         WHEN bmo.IsAvailable = 0 THEN 0
         WHEN bmo.StockQuantity IS NOT NULL AND bmo.StockQuantity <= 0 THEN 0
         ELSE 1
       END AS IsAvailable
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

/**
 * Danh sách món cho màn quản trị: gồm cả món ngừng bán (IsActive = 0) và món bị
 * chi nhánh ẩn, kèm giá gốc / giá đè / tồn kho của chi nhánh đang chọn.
 */
const findAllMenuItemsForAdmin = async (restaurantId, branchId) => {
  const [rows] = await pool.execute(
    `SELECT
       mi.MenuItemID, mi.RestaurantID, mi.BranchID, b.Name AS BranchExclusiveName,
       mi.CategoryID, c.Name AS CategoryName,
       mi.Name, mi.Description, mi.url_Image, mi.Unit,
       mi.BasePrice, mi.IsWeightBased, mi.IsActive,
       bmo.OverridePrice,
       bmo.StockQuantity,
       COALESCE(bmo.LowStockThreshold, 5) AS LowStockThreshold,
       CASE
         WHEN bmo.StockQuantity IS NOT NULL AND bmo.StockQuantity <= 0 THEN 0
         WHEN bmo.BranchMenuOverrideID IS NULL THEN 1
         ELSE bmo.IsAvailable
       END AS BranchAvailable
     FROM menuitem mi
     INNER JOIN category c ON mi.CategoryID = c.CategoryID
     LEFT JOIN branch b ON b.BranchID = mi.BranchID
     LEFT JOIN branchmenuoverride bmo
            ON bmo.MenuItemID = mi.MenuItemID AND bmo.BranchID = ?
     WHERE mi.RestaurantID = ?
       AND (mi.BranchID IS NULL OR mi.BranchID = ?)
     ORDER BY c.Name ASC, mi.Name ASC`,
    [branchId, restaurantId, branchId]
  );
  return rows;
};

const findCategories = async (restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT c.CategoryID, c.Name, c.Description,
            (SELECT COUNT(*) FROM menuitem mi WHERE mi.CategoryID = c.CategoryID) AS ItemCount
     FROM category c
     WHERE c.RestaurantID = ?
     ORDER BY c.Name ASC`,
    [restaurantId]
  );
  return rows;
};

const findCategoryById = async (categoryId) => {
  const [rows] = await pool.execute(
    `SELECT CategoryID, RestaurantID, Name FROM category WHERE CategoryID = ?`,
    [categoryId]
  );
  return rows[0] || null;
};

const createCategory = async ({ restaurantId, name, description }) => {
  const [result] = await pool.execute(
    `INSERT INTO category (RestaurantID, Name, Description) VALUES (?, ?, ?)`,
    [restaurantId, name, description || null]
  );
  return result.insertId;
};

const findMenuItemById = async (menuItemId) => {
  const [rows] = await pool.execute(
    `SELECT MenuItemID, RestaurantID, BranchID, CategoryID, Name, Description, BasePrice, url_Image, IsWeightBased, IsActive
     FROM menuitem WHERE MenuItemID = ?`,
    [menuItemId]
  );
  return rows[0] || null;
};

const updateMenuItem = async (menuItemId, { categoryId, name, description, basePrice, urlImage, isWeightBased, isActive, branchId }) => {
  let query = `UPDATE menuitem SET CategoryID = ?, Name = ?, Description = ?, BasePrice = ?, url_Image = ?, IsWeightBased = ?, IsActive = ?`;
  const params = [categoryId, name, description || null, basePrice, urlImage || null, isWeightBased ? 1 : 0, isActive ? 1 : 0];
  if (branchId !== undefined) {
    query += `, BranchID = ?`;
    params.push(branchId || null);
  }
  query += ` WHERE MenuItemID = ?`;
  params.push(menuItemId);
  const [result] = await pool.execute(query, params);
  return result.affectedRows;
};

module.exports = {
  findAllMenuItems,
  createMenuItem,
  upsertBranchOverride,
  deductBranchStock,
  adjustBranchStock,
  getCurrentPriceForBranch,
  findAllMenuItemsForAdmin,
  findCategories,
  findCategoryById,
  createCategory,
  findMenuItemById,
  updateMenuItem,
};
