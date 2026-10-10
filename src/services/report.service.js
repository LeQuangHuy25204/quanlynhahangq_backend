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
 * Báo cáo doanh thu theo ngày của một chi nhánh.
 */
const getBranchRevenue = async ({ branchId, startDate, endDate }, actorUser) => {
  validateDateRange(startDate, endDate);

  let targetBranch = parseInt(branchId, 10);

  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    // BranchManager / Cashier chỉ xem chi nhánh mình
    targetBranch = actorUser.branchId;
  } else {
    // RestaurantAdmin: nếu không truyền branchId thì mặc định chi nhánh 1
    if (!targetBranch || isNaN(targetBranch)) {
      targetBranch = actorUser.branchId || 1;
    }
  }

  const daily  = await reportModel.getRevenueByBranch(targetBranch, startDate, endDate);
  const topItems = await reportModel.getTopSellingItems(targetBranch, startDate, endDate, 10);

  const totalRevenue = daily.reduce((sum, d) => sum + parseFloat(d.TotalRevenue || 0), 0);

  return { branchId: targetBranch, startDate, endDate, totalRevenue, daily, topItems };
};

/**
 * Báo cáo tổng hợp doanh thu toàn nhà hàng — chỉ RestaurantAdmin.
 */
const getRestaurantRevenue = async ({ startDate, endDate }, actorUser) => {
  validateDateRange(startDate, endDate);
  const branches = await reportModel.getRevenueByRestaurant(actorUser.restaurantId, startDate, endDate);
  const totalRevenue = branches.reduce((sum, b) => sum + parseFloat(b.TotalRevenue || 0), 0);
  return { restaurantId: actorUser.restaurantId, startDate, endDate, totalRevenue, branches };
};

const getDashboardSummary = async ({ branchId, startDate, endDate }, actorUser) => {
  const targetBranch = actorUser.roleCode === ROLE_CODE.RESTAURANT_ADMIN
    ? (branchId ? parseInt(branchId, 10) : null)
    : actorUser.branchId;

  return await reportModel.getDashboardSummary(actorUser.restaurantId, targetBranch, startDate, endDate);
};

module.exports = { getBranchRevenue, getRestaurantRevenue, getDashboardSummary };

