'use strict';

const { pool } = require('../config/db');

const findPromotionsByRestaurant = async (restaurantId) => {
  const [rows] = await pool.execute(
    `SELECT PromotionID, Name, Description, DiscountType, DiscountValue,
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

const createPromotion = async ({ restaurantId, name, description, discountType, discountValue, startDate, endDate }) => {
  const [result] = await pool.execute(
    `INSERT INTO promotion (RestaurantID, Name, Description, DiscountType, DiscountValue, StartDate, EndDate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [restaurantId, name, description || null, discountType, discountValue, startDate, endDate || null]
  );
  return result.insertId;
};

const updatePromotion = async (promotionId, { name, description, discountType, discountValue, startDate, endDate, isActive }) => {
  const [result] = await pool.execute(
    `UPDATE promotion SET Name=?, Description=?, DiscountType=?, DiscountValue=?, StartDate=?, EndDate=?, IsActive=?
     WHERE PromotionID=?`,
    [name, description || null, discountType, discountValue, startDate, endDate || null, isActive, promotionId]
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
       AND StartDate     <= NOW()
       AND (EndDate IS NULL OR EndDate >= NOW())`,
    [promotionId, restaurantId]
  );
  return rows[0] || null;
};

module.exports = {
  findPromotionsByRestaurant,
  findPromotionById,
  createPromotion,
  updatePromotion,
  findActivePromotion,
};
