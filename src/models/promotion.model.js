'use strict';

const { pool } = require('../config/db');

const findPromotionsByRestaurant = async (restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT PromotionID, Name, Description, ApplyLevel, DiscountType, DiscountValue, MaxUsage, UsedCount, Version,
            StartDate, EndDate, IsActive, CreatedAt
     FROM promotion
     WHERE RestaurantID = ?
     ORDER BY CreatedAt DESC`,
    [restaurantId]
  );
  return rows;
};

const findPromotionById = async (promotionId) => {
  const [rows] = await pool.execute(
    `SELECT * FROM promotion WHERE PromotionID = ?`,
    [promotionId]
  );
  return rows[0] || null;
};

const createPromotion = async ({ restaurantId, name, description, applyLevel, discountType, discountValue, maxUsage, startDate, endDate }) => {
  const [result] = await pool.execute(
    `INSERT INTO promotion (RestaurantID, Name, Description, ApplyLevel, DiscountType, DiscountValue, MaxUsage, StartDate, EndDate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [restaurantId, name, description || null, applyLevel || 'INVOICE', discountType, discountValue, maxUsage || null, startDate, endDate || null]
  );
  return result.insertId;
};

const updatePromotion = async (promotionId, { name, description, applyLevel, discountType, discountValue, maxUsage, startDate, endDate, isActive }) => {
  const [result] = await pool.execute(
    `UPDATE promotion SET Name=?, Description=?, ApplyLevel=?, DiscountType=?, DiscountValue=?, MaxUsage=?, StartDate=?, EndDate=?, IsActive=?
     WHERE PromotionID=?`,
    [name, description || null, applyLevel || 'INVOICE', discountType, discountValue, maxUsage || null, startDate, endDate || null, isActive, promotionId]
  );
  return result.affectedRows;
};

/**
 * Tìm khuyến mãi đang active tại thời điểm hiện tại để áp dụng khi checkout.
 */
const findActivePromotion = async (promotionId, restaurantId) => {
  const [rows] = await pool.execute(
      `SELECT * FROM promotion
       WHERE PromotionID   = ?
         AND RestaurantID  = ?
         AND IsActive      = 1
         AND (MaxUsage IS NULL OR UsedCount < MaxUsage)
         AND StartDate     <= NOW()
         AND (EndDate IS NULL OR EndDate >= NOW())`,
      [promotionId, restaurantId]
    );
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
  createPromotion,
  updatePromotion,
  findActivePromotion,
  incrementPromotionUsage,
};
