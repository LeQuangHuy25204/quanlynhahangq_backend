'use strict';

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/db');
const { authenticate } = require('../middlewares/authMiddleware');
const { requireRole }  = require('../middlewares/roleMiddleware');

/**
 * @route   GET /api/branches
 * @desc    Danh sách chi nhánh của nhà hàng (RestaurantAdmin xem tất cả,
 *          các role khác chỉ thấy chi nhánh của mình).
 * @access  Protected (mọi role nhân viên)
 */
router.get(
  '/',
  authenticate,
  requireRole('Waiter', 'Cashier', 'BranchManager', 'RestaurantAdmin'),
  async (req, res, next) => {
    try {
      const { restaurantId, roleCode, branchId } = req.user;
      const params = [restaurantId];
      let sql = `SELECT BranchID, Name, Address, Phone, VATRate, ServiceFeeRate, IsActive
                 FROM branch WHERE RestaurantID = ? AND IsActive = 1`;
      if (roleCode !== 'RestaurantAdmin') {
        sql += ' AND BranchID = ?';
        params.push(branchId);
      }
      sql += ' ORDER BY Name ASC';
      const [rows] = await pool.execute(sql, params);
      res.status(200).json({ success: true, data: rows });
    } catch (err) { next(err); }
  }
);

module.exports = router;
