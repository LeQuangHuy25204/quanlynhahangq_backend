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

router.post(
  '/',
  authenticate,
  requireRole('RestaurantAdmin'),
  async (req, res, next) => {
    try {
      const { restaurantId } = req.user;
      const { name, address, phone, bussinessStartHour, vatRate, serviceFeeRate, taxCode } = req.body;
      if (!name || !address || !phone) {
        return res.status(400).json({ success: false, message: 'Tên, địa chỉ và số điện thoại là bắt buộc.' });
      }
      const [result] = await pool.execute(
        `INSERT INTO branch (RestaurantID, Name, Address, Phone, BussinessStartHour, VATRate, ServiceFeeRate, TaxCode, IsActive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          restaurantId,
          String(name).trim(),
          String(address).trim(),
          String(phone).trim(),
          bussinessStartHour || '10:00:00',
          vatRate != null ? parseFloat(vatRate) : 8.00,
          serviceFeeRate != null ? parseFloat(serviceFeeRate) : 5.00,
          taxCode ? String(taxCode).trim() : null
        ]
      );
      res.status(201).json({ success: true, message: 'Tạo chi nhánh thành công.', data: { branchId: result.insertId } });
    } catch (err) { next(err); }
  }
);

router.put(
  '/:branchId',
  authenticate,
  requireRole('BranchManager', 'RestaurantAdmin'),
  async (req, res, next) => {
    try {
      const { restaurantId, roleCode, branchId: userBranchId } = req.user;
      const branchId = parseInt(req.params.branchId, 10);
      if (roleCode === 'BranchManager' && branchId !== userBranchId) {
        return res.status(403).json({ success: false, message: 'Bạn chỉ có quyền cấu hình chi nhánh của mình.' });
      }

      const [existing] = await pool.execute(`SELECT * FROM branch WHERE BranchID = ? AND RestaurantID = ?`, [branchId, restaurantId]);
      if (!existing || existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh.' });
      }

      const b = existing[0];
      const { name, address, phone, bussinessStartHour, vatRate, serviceFeeRate, taxCode, isActive } = req.body;

      let newName = b.Name;
      let newVat = b.VATRate;
      let newServiceFee = b.ServiceFeeRate;
      let newTaxCode = b.TaxCode;
      let newIsActive = b.IsActive;

      // Chỉ RestaurantAdmin được sửa các trường hệ thống
      if (roleCode === 'RestaurantAdmin') {
        if (name) newName = String(name).trim();
        if (vatRate != null) newVat = parseFloat(vatRate);
        if (serviceFeeRate != null) newServiceFee = parseFloat(serviceFeeRate);
        if (taxCode !== undefined) newTaxCode = taxCode ? String(taxCode).trim() : null;
        if (isActive !== undefined) newIsActive = isActive ? 1 : 0;
      }

      const newAddress = address ? String(address).trim() : b.Address;
      const newPhone = phone ? String(phone).trim() : b.Phone;
      const newStartHour = bussinessStartHour || b.BussinessStartHour;

      await pool.execute(
        `UPDATE branch 
         SET Name = ?, Address = ?, Phone = ?, BussinessStartHour = ?, VATRate = ?, ServiceFeeRate = ?, TaxCode = ?, IsActive = ?
         WHERE BranchID = ?`,
        [newName, newAddress, newPhone, newStartHour, newVat, newServiceFee, newTaxCode, newIsActive, branchId]
      );

      res.status(200).json({ success: true, message: 'Cập nhật thông tin chi nhánh thành công.' });
    } catch (err) { next(err); }
  }
);

module.exports = router;
