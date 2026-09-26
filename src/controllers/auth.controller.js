'use strict';

const authService = require('../services/auth.service');

/**
 * POST /api/auth/login
 * Body: { username, password, restaurantId }
 */
const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await authService.login(username, password);
    res.status(200).json({ success: true, message: 'Đăng nhập thành công.', data: result });
  } catch (err) {
    next(err);
  }
};

module.exports = { login };
