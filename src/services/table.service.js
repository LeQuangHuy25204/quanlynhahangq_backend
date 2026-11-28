'use strict';

const tableModel = require('../models/table.model');
const staffModel = require('../models/staff.model'); // dùng verifyBranchBelongsToRestaurant
const sessionService = require('./session.service');
const activityLogService = require('./activityLog.service');
const { ROLE_CODE, LOG_SEVERITY } = require('../constants/status');

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
  const parsedBranchId = parseInt(branchId, 10);
  const areaId = await tableModel.createArea({ branchId: parsedBranchId, name });
  await activityLogService.logStaffAction(actorUser, {
    branchId: parsedBranchId,
    entityType: 'Area',
    entityId: areaId,
    action: 'AREA_CREATE',
    severity: LOG_SEVERITY.INFO,
    description: `Tạo khu vực mới "${name}" tại chi nhánh #${parsedBranchId}.`,
    newValue: { areaId, branchId: parsedBranchId, name },
  });
  return { areaId, branchId: parsedBranchId, name };
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
  await activityLogService.logStaffAction(actorUser, {
    branchId: area.BranchID,
    entityType: 'Area',
    entityId: parseInt(areaId, 10),
    action: 'AREA_UPDATE',
    severity: Number(isActive) === 0 ? LOG_SEVERITY.WARNING : LOG_SEVERITY.INFO,
    description: `Cập nhật khu vực "${name}" (#${areaId}).`,
    oldValue: { name: area.Name, isActive: area.IsActive },
    newValue: { name, isActive },
  });
  return { areaId: parseInt(areaId, 10), name, isActive };
};

// ─── TABLE ────────────────────────────────────────────────────────────────────

const getTablesByBranch = async (branchId, actorUser) => {
  await assertBranchAccess(branchId, actorUser);
  await sessionService.closeExpiredWaitingSessions();
  return tableModel.findTablesByBranch(branchId, {
    waitTimeoutSeconds: sessionService.WAIT_OPEN_TIMEOUT_SECONDS,
  });
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
  await activityLogService.logStaffAction(actorUser, {
    branchId: area.BranchID,
    entityType: 'Table',
    entityId: tableId,
    action: 'TABLE_CREATE',
    severity: LOG_SEVERITY.INFO,
    description: `Tạo bàn mới "${name}" thuộc khu vực "${area.Name}" (#${area.AreaID}).`,
    newValue: { tableId, areaId: parseInt(areaId, 10), name, qrCode },
  });
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
  await activityLogService.logStaffAction(actorUser, {
    branchId: table.BranchID,
    entityType: 'Table',
    entityId: parseInt(tableId, 10),
    action: 'TABLE_UPDATE',
    severity: Number(isActive) !== Number(table.IsActive) ? LOG_SEVERITY.WARNING : LOG_SEVERITY.INFO,
    description: `Cập nhật bàn "${name}" (#${tableId}).`,
    oldValue: { name: table.Name, isActive: table.IsActive },
    newValue: { name, isActive },
  });
  return { tableId: parseInt(tableId, 10), name, isActive };
};

module.exports = { getAreasByBranch, createArea, updateArea, getTablesByBranch, createTable, updateTable };
