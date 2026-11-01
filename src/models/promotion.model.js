'use strict';

const { pool } = require('../config/db');

/**
 * Danh sách khuyến mãi của nhà hàng, kèm danh sách món áp dụng (promotion_menuitem)
 * và tên danh mục mục tiêu để hiển thị. Hỗ trợ lọc theo chi nhánh (BranchID).
 */
const findPromotionsByRestaurant = async (restaurantId, branchId = null) => {
  let query = `
    SELECT p.PromotionID, p.RestaurantID, p.BranchID, b.Name AS BranchName,
           p.Name, p.Description, p.ApplyLevel, p.DiscountType, p.DiscountValue,
           p.TargetCategoryID, c.Name AS TargetCategoryName,
           p.MinOrderAmount, p.MinItemCount,
           p.MaxUsage, p.UsedCount, p.Version,
           p.StartDate, p.EndDate, p.IsActive, p.CreatedAt
    FROM promotion p
    LEFT JOIN category c ON c.CategoryID = p.TargetCategoryID
    LEFT JOIN branch b ON b.BranchID = p.BranchID
    WHERE p.RestaurantID = ?
  `;
  const params = [restaurantId];
  if (branchId) {
    query += ` AND (p.BranchID IS NULL OR p.BranchID = ?)`;
    params.push(branchId);
  }
  query += ` ORDER BY p.CreatedAt DESC`;

  const [rows] = await pool.execute(query, params);
  if (rows.length === 0) return rows;

  const [items] = await pool.execute(
    `SELECT pm.PromotionID, mi.MenuItemID, mi.Name
     FROM promotion_menuitem pm
     INNER JOIN menuitem mi ON mi.MenuItemID = pm.MenuItemID
     INNER JOIN promotion p ON p.PromotionID = pm.PromotionID
     WHERE p.RestaurantID = ?
     ORDER BY mi.Name ASC`,
    [restaurantId]
  );
  const byPromo = new Map();
  for (const it of items) {
    if (!byPromo.has(it.PromotionID)) byPromo.set(it.PromotionID, []);
    byPromo.get(it.PromotionID).push({ MenuItemID: it.MenuItemID, Name: it.Name });
  }
  return rows.map((r) => {
    const menuItems = byPromo.get(r.PromotionID) || [];
    return { ...r, MenuItems: menuItems, MenuItemIds: menuItems.map((m) => m.MenuItemID) };
  });
};

const findPromotionById = async (promotionId) => {
  const [rows] = await pool.execute(
    `SELECT * FROM promotion WHERE PromotionID = ?`,
    [promotionId]
  );
  return rows[0] || null;
};

const findPromotionMenuItemIds = async (promotionId) => {
  const [rows] = await pool.execute(
    `SELECT MenuItemID FROM promotion_menuitem WHERE PromotionID = ?`,
    [promotionId]
  );
  return rows.map((r) => Number(r.MenuItemID));
};

/** Trả về các MenuItemID (trong danh sách) thực sự thuộc nhà hàng. */
const findMenuItemIdsOfRestaurant = async (restaurantId, menuItemIds) => {
  if (!menuItemIds || menuItemIds.length === 0) return [];
  const placeholders = menuItemIds.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT MenuItemID FROM menuitem WHERE RestaurantID = ? AND MenuItemID IN (${placeholders})`,
    [restaurantId, ...menuItemIds]
  );
  return rows.map((r) => Number(r.MenuItemID));
};

const categoryBelongsToRestaurant = async (restaurantId, categoryId) => {
  const [rows] = await pool.execute(
    `SELECT CategoryID FROM category WHERE CategoryID = ? AND RestaurantID = ?`,
    [categoryId, restaurantId]
  );
  return rows.length > 0;
};

const replaceMenuItems = async (conn, promotionId, menuItemIds) => {
  await conn.execute(`DELETE FROM promotion_menuitem WHERE PromotionID = ?`, [promotionId]);
  if (menuItemIds && menuItemIds.length > 0) {
    const placeholders = menuItemIds.map(() => '(?, ?)').join(', ');
    await conn.execute(
      `INSERT INTO promotion_menuitem (PromotionID, MenuItemID) VALUES ${placeholders}`,
      menuItemIds.flatMap((id) => [promotionId, id])
    );
  }
};

const createPromotion = async ({
  restaurantId, branchId, name, description, applyLevel, discountType, discountValue,
  targetCategoryId, minOrderAmount, minItemCount, menuItemIds,
  maxUsage, startDate, endDate,
}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO promotion
         (RestaurantID, BranchID, Name, Description, ApplyLevel, DiscountType, DiscountValue,
          TargetCategoryID, MinOrderAmount, MinItemCount, MaxUsage, StartDate, EndDate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        restaurantId, branchId || null, name, description || null, applyLevel || 'INVOICE', discountType, discountValue,
        targetCategoryId || null, minOrderAmount || null, minItemCount || null,
        maxUsage || null, startDate, endDate || null,
      ]
    );
    await replaceMenuItems(conn, result.insertId, menuItemIds);
    await conn.commit();
    return result.insertId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * Cập nhật khuyến mãi. menuItemIds === undefined → giữ nguyên danh sách món áp dụng.
 */
const updatePromotion = async (promotionId, {
  branchId, name, description, applyLevel, discountType, discountValue,
  targetCategoryId, minOrderAmount, minItemCount, menuItemIds,
  maxUsage, startDate, endDate, isActive,
}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let query = `
      UPDATE promotion
      SET Name=?, Description=?, ApplyLevel=?, DiscountType=?, DiscountValue=?,
          TargetCategoryID=?, MinOrderAmount=?, MinItemCount=?, MaxUsage=?,
          StartDate=?, EndDate=?, IsActive=?
    `;
    const params = [
      name, description || null, applyLevel || 'INVOICE', discountType, discountValue,
      targetCategoryId || null, minOrderAmount || null, minItemCount || null, maxUsage || null,
      startDate, endDate || null, isActive,
    ];

    if (branchId !== undefined) {
      query += `, BranchID=?`;
      params.push(branchId || null);
    }
    query += ` WHERE PromotionID=?`;
    params.push(promotionId);

    const [result] = await conn.execute(query, params);
    if (menuItemIds !== undefined) {
      await replaceMenuItems(conn, promotionId, menuItemIds);
    }
    await conn.commit();
    return result.affectedRows;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * Tìm khuyến mãi đang active tại thời điểm hiện tại để áp dụng khi checkout.
 * Hỗ trợ lọc theo chi nhánh (BranchID IS NULL OR BranchID = branchId).
 */
const findActivePromotion = async (promotionId, restaurantId, branchId = null) => {
  let query = `
    SELECT * FROM promotion
    WHERE PromotionID   = ?
      AND RestaurantID  = ?
      AND IsActive      = 1
      AND (MaxUsage IS NULL OR UsedCount < MaxUsage)
      AND StartDate     <= NOW()
      AND (EndDate IS NULL OR EndDate >= NOW())
  `;
  const params = [promotionId, restaurantId];
  if (branchId) {
    query += ` AND (BranchID IS NULL OR BranchID = ?)`;
    params.push(branchId);
  }
  const [rows] = await pool.execute(query, params);
  return rows[0] || null;
};
  
  /**
   * Tăng số lượng UsedCount với cơ chế Optimistic Locking (BR: Chống tranh chấp dữ liệu)
   */
  const incrementPromotionUsage = async (promotionId, currentVersion) => {
    const [result] = await pool.execute(
      `UPDATE promotion 
       SET UsedCount = UsedCount + 1, Version = Version + 1
       WHERE PromotionID = ? AND Version = ? AND (MaxUsage IS NULL OR UsedCount < MaxUsage)`,
      [promotionId, currentVersion]
    );
    return result.affectedRows > 0;
  };

module.exports = {
  findPromotionsByRestaurant,
  findPromotionById,
  findPromotionMenuItemIds,
  findMenuItemIdsOfRestaurant,
  categoryBelongsToRestaurant,
  createPromotion,
  updatePromotion,
  findActivePromotion,
  incrementPromotionUsage,
};
