'use strict';

const promotionModel = require('../models/promotion.model');

const getPromotions = async (actorUser) => {
  return promotionModel.findPromotionsByRestaurant(actorUser.restaurantId);
};

const createPromotion = async (data, actorUser) => {
  const { name, discountType, discountValue, startDate } = data;
  if (!name || !discountType || !discountValue || !startDate) {
    const err = new Error('name, discountType, discountValue, startDate là bắt buộc.');
    err.statusCode = 400; throw err;
  }
  if (!['PERCENT', 'FIXED'].includes(discountType)) {
    const err = new Error('discountType phải là PERCENT hoặc FIXED.');
    err.statusCode = 400; throw err;
  }
  const promotionId = await promotionModel.createPromotion({ ...data, restaurantId: actorUser.restaurantId });
  return { promotionId, ...data };
};

const updatePromotion = async (promotionId, data, actorUser) => {
  const promotion = await promotionModel.findPromotionById(promotionId);
  if (!promotion) {
    const err = new Error('Không tìm thấy khuyến mãi.'); err.statusCode = 404; throw err;
  }
  if (promotion.RestaurantID !== actorUser.restaurantId) {
    const err = new Error('Không có quyền chỉnh sửa khuyến mãi này.'); err.statusCode = 403; throw err;
  }
  const merged = {
    name:          data.name          ?? promotion.Name,
    description:   data.description   ?? promotion.Description,
    discountType:  data.discountType  ?? promotion.DiscountType,
    discountValue: data.discountValue ?? promotion.DiscountValue,
    startDate:     data.startDate     ?? promotion.StartDate,
    endDate:       data.endDate       ?? promotion.EndDate,
    isActive:      data.isActive      !== undefined ? data.isActive : promotion.IsActive,
  };
  await promotionModel.updatePromotion(promotionId, merged);
  return { promotionId: parseInt(promotionId, 10), ...merged };
};

module.exports = { getPromotions, createPromotion, updatePromotion };
