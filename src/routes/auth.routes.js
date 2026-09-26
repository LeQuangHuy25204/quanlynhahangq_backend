'use strict';

const express = require('express');
const router  = express.Router();
const authController = require('../controllers/auth.controller');

/**
 * @route   POST /api/auth/login
 * @desc    Đăng nhập nhân viên, trả về JWT token
 * @access  Public
 * @body    { username: string, password: string, restaurantId: number }
 */
router.post('/login', authController.login);

module.exports = router;
