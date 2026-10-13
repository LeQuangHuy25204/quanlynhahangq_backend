'use strict';

const reportModel = require('../models/report.model');
const staffModel  = require('../models/staff.model');
const { ROLE_CODE } = require('../constants/status');

const validateDateRange = (startDate, endDate) => {
  if (!startDate || !endDate) {
    const err = new Error('startDate và endDate là bắt buộc (định dạng YYYY-MM-DD).');
    err.statusCode = 400; throw err;
  }
  if (new Date(startDate) > new Date(endDate)) {
    const err = new Error('startDate không được lớn hơn endDate.');
    err.statusCode = 400; throw err;
  }
};

/**
 * Báo cáo doanh thu của một chi nhánh hoặc toàn hệ thống.
 */
const getBranchRevenue = async ({ branchId, startDate, endDate }, actorUser) => {
  validateDateRange(startDate, endDate);

  let targetBranch = null;

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    // BranchManager / Cashier chỉ xem chi nhánh mình
    targetBranch = actorUser.branchId;
  } else {
    // RestaurantAdmin: nếu có truyền branchId hợp lệ và khác 'all' thì lọc theo branchId
    if (branchId && branchId !== 'all' && branchId !== 'null' && branchId !== 'undefined' && !isNaN(parseInt(branchId, 10))) {
      targetBranch = parseInt(branchId, 10);
    }
  }

  const restaurantId = actorUser.restaurantId || 1;
  const isSingleDay = startDate === endDate;

  const [daily, topItems, summary, hourly] = await Promise.all([
    reportModel.getRevenueByBranch(restaurantId, targetBranch, startDate, endDate),
    reportModel.getTopSellingItems(restaurantId, targetBranch, startDate, endDate, 10),
    reportModel.getDashboardSummary(restaurantId, targetBranch, startDate, endDate),
    isSingleDay ? reportModel.getRevenueByHourly(restaurantId, targetBranch, startDate) : Promise.resolve([])
  ]);

  return {
    branchId: targetBranch,
    startDate,
    endDate,
    totalRevenue: summary.totalRevenue,
    totalInvoices: summary.totalInvoices,
    avgOrderValue: summary.avgOrderValue,
    daily,
    hourly,
    topItems
  };
};

/**
 * Báo cáo tổng hợp doanh thu toàn nhà hàng — chỉ RestaurantAdmin.
 */
const getRestaurantRevenue = async ({ startDate, endDate }, actorUser) => {
  validateDateRange(startDate, endDate);
  const branches = await reportModel.getRevenueByRestaurant(actorUser.restaurantId || 1, startDate, endDate);
  const totalRevenue = branches.reduce((sum, b) => sum + parseFloat(b.TotalRevenue || 0), 0);
  return { restaurantId: actorUser.restaurantId || 1, startDate, endDate, totalRevenue, branches };
};

const getDashboardSummary = async ({ branchId, startDate, endDate }, actorUser) => {
  let targetBranch = null;
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    targetBranch = actorUser.branchId;
  } else {
    if (branchId && branchId !== 'all' && branchId !== 'null' && branchId !== 'undefined' && !isNaN(parseInt(branchId, 10))) {
      targetBranch = parseInt(branchId, 10);
    }
  }

  return await reportModel.getDashboardSummary(actorUser.restaurantId || 1, targetBranch, startDate, endDate);
};

module.exports = { getBranchRevenue, getRestaurantRevenue, getDashboardSummary };

