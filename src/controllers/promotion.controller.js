'use strict';

const promotionService = require('../services/promotion.service');

const getPromotions = async (req, res, next) => {
  try {
    const data = await promotionService.getPromotions(req.user);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

const createPromotion = async (req, res, next) => {
  try {
    const data = await promotionService.createPromotion(req.body, req.user);
    res.status(201).json({ success: true, message: 'Tạo khuyến mãi thành công.', data });
  } catch (err) { next(err); }
};

const updatePromotion = async (req, res, next) => {
  try {
    const data = await promotionService.updatePromotion(req.params.promotionId, req.body, req.user);
    res.status(200).json({ success: true, message: 'Cập nhật khuyến mãi thành công.', data });
  } catch (err) { next(err); }
};

module.exports = { getPromotions, createPromotion, updatePromotion };
