'use strict';

const tableModel = require('../models/table.model');
const staffModel = require('../models/staff.model'); // dùng verifyBranchBelongsToRestaurant
const { ROLE_CODE } = require('../constants/status');

// ─── Helper: kiểm tra chi nhánh thuộc nhà hàng và actorUser có quyền ────────
const assertBranchAccess = async (branchId, actorUser) => {
  const branch = await staffModel.verifyBranchBelongsToRestaurant(
    parseInt(branchId, 10),
    actorUser.restaurantId
  );
  if (!branch) {
    const err = new Error('Chi nhánh không tồn tại hoặc không thuộc nhà hàng.');
    err.statusCode = 403;
    throw err;
  }
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    if (parseInt(branchId, 10) !== actorUser.branchId) {
      const err = new Error('Bạn chỉ có thể quản lý bàn của chi nhánh mình.');
      err.statusCode = 403;
      throw err;
    }
  }
};

// ─── AREA ────────────────────────────────────────────────────────────────────

const getAreasByBranch = async (branchId, actorUser) => {
  await assertBranchAccess(branchId, actorUser);
  return tableModel.findAreasByBranch(branchId);
};

const createArea = async ({ branchId, name }, actorUser) => {
  if (!branchId || !name) {
    const err = new Error('branchId và name là bắt buộc.'); err.statusCode = 400; throw err;
  }
  await assertBranchAccess(branchId, actorUser);
  const areaId = await tableModel.createArea({ branchId: parseInt(branchId, 10), name });
  return { areaId, branchId: parseInt(branchId, 10), name };
};

const updateArea = async (areaId, body, actorUser) => {
  const area = await tableModel.findAreaById(areaId);
  if (!area) {
    const err = new Error('Không tìm thấy khu vực.'); err.statusCode = 404; throw err;
  }
  await assertBranchAccess(area.BranchID, actorUser);
  const name     = body.name     ?? area.Name;
  const isActive = body.isActive !== undefined ? body.isActive : area.IsActive;
  await tableModel.updateArea(areaId, { name, isActive });
  return { areaId: parseInt(areaId, 10), name, isActive };
};

// ─── TABLE ────────────────────────────────────────────────────────────────────

const getTablesByBranch = async (branchId, actorUser) => {
  await assertBranchAccess(branchId, actorUser);
  return tableModel.findTablesByBranch(branchId);
};

const createTable = async ({ areaId, name }, actorUser) => {
  if (!areaId || !name) {
    const err = new Error('areaId và name là bắt buộc.'); err.statusCode = 400; throw err;
  }
  const area = await tableModel.findAreaById(areaId);
  if (!area) {
    const err = new Error('Không tìm thấy khu vực.'); err.statusCode = 404; throw err;
  }
  await assertBranchAccess(area.BranchID, actorUser);
  const { tableId, qrCode } = await tableModel.createTable({ areaId: parseInt(areaId, 10), name });
  return { tableId, areaId: parseInt(areaId, 10), name, qrCode };
};

const updateTable = async (tableId, body, actorUser) => {
  const table = await tableModel.findTableById(tableId);
  if (!table) {
    const err = new Error('Không tìm thấy bàn.'); err.statusCode = 404; throw err;
  }
  await assertBranchAccess(table.BranchID, actorUser);
  const name     = body.name     ?? table.Name;
  const isActive = body.isActive !== undefined ? body.isActive : table.IsActive;
  await tableModel.updateTable(tableId, { name, isActive });
  return { tableId: parseInt(tableId, 10), name, isActive };
};

module.exports = { getAreasByBranch, createArea, updateArea, getTablesByBranch, createTable, updateTable };
