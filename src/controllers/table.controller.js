'use strict';

const tableService = require('../services/table.service');

// ─── AREA ────────────────────────────────────────────────────────────────────

const getAreasByBranch = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    if (!branchId) return res.status(400).json({ success: false, message: 'branchId là bắt buộc.' });
    const data = await tableService.getAreasByBranch(branchId, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

const createArea = async (req, res, next) => {
  try {
    const data = await tableService.createArea(req.body, req.user);
    res.status(201).json({ success: true, message: 'Tạo khu vực thành công.', data });
  } catch (err) { next(err); }
};

const updateArea = async (req, res, next) => {
  try {
    const data = await tableService.updateArea(req.params.areaId, req.body, req.user);
    res.status(200).json({ success: true, message: 'Cập nhật khu vực thành công.', data });
  } catch (err) { next(err); }
};

// ─── TABLE ────────────────────────────────────────────────────────────────────

const getTablesByBranch = async (req, res, next) => {
  try {
    const { branchId } = req.query;
    if (!branchId) return res.status(400).json({ success: false, message: 'branchId là bắt buộc.' });
    const data = await tableService.getTablesByBranch(branchId, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

const createTable = async (req, res, next) => {
  try {
    const data = await tableService.createTable(req.body, req.user);
    res.status(201).json({ success: true, message: 'Tạo bàn thành công.', data });
  } catch (err) { next(err); }
};

const updateTable = async (req, res, next) => {
  try {
    const data = await tableService.updateTable(req.params.tableId, req.body, req.user);
    res.status(200).json({ success: true, message: 'Cập nhật bàn thành công.', data });
  } catch (err) { next(err); }
};

module.exports = { getAreasByBranch, createArea, updateArea, getTablesByBranch, createTable, updateTable };
