'use strict';

const express = require('express');
const router  = express.Router();
const authController = require('../controllers/auth.controller');

// Bảo mật chống dò mật khẩu (Brute-force protection: tối đa 15 lần thử / 5 phút mỗi IP)
const loginAttempts = new Map();
const loginRateLimiter = (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const record = loginAttempts.get(ip);

  if (!record || now - record.start > windowMs) {
    loginAttempts.set(ip, { count: 1, start: now });
    return next();
  }
  if (record.count >= 15) {
    return res.status(429).json({
      success: false,
      message: 'Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau 5 phút.',
    });
  }
  record.count += 1;
  return next();
};

/**
 * @route   POST /api/auth/login
 * @desc    Đăng nhập nhân viên, trả về JWT token
 * @access  Public
 * @body    { username: string, password: string }
 */
router.post('/login', loginRateLimiter, authController.login);

module.exports = router;
