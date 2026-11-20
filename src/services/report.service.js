'use strict';

const reportModel = require('../models/report.model');
const staffModel  = require('../models/staff.model');
const { ROLE_CODE } = require('../constants/status');

const validateDateRange = (startDate, endDate) => {
  if (!startDate && !endDate) return;
  if ((startDate && !endDate) || (!startDate && endDate)) {
    const err = new Error('Vui lòng truyền cả startDate và endDate (định dạng YYYY-MM-DD).');
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
  const isSingleDay = Boolean(startDate && endDate && startDate === endDate);

  const [daily, topItems, summary, hourly, invoices] = await Promise.all([
    reportModel.getRevenueByBranch(restaurantId, targetBranch, startDate, endDate),
    reportModel.getTopSellingItems(restaurantId, targetBranch, startDate, endDate, 50),
    reportModel.getDashboardSummary(restaurantId, targetBranch, startDate, endDate),
    isSingleDay ? reportModel.getRevenueByHourly(restaurantId, targetBranch, startDate) : Promise.resolve([]),
    reportModel.getInvoicesByPeriod(restaurantId, targetBranch, startDate, endDate)
  ]);

  return {
    branchId: targetBranch,
    startDate,
    endDate,
    totalRevenue: summary.totalRevenue,
    subTotal: summary.subTotal,
    vatAmount: summary.vatAmount,
    serviceFeeAmount: summary.serviceFeeAmount,
    discountAmount: summary.discountAmount,
    totalInvoices: summary.totalInvoices,
    totalGuests: summary.totalGuests,
    avgOrderValue: summary.avgOrderValue,
    paymentBreakdown: summary.paymentBreakdown,
    daily,
    hourly,
    topItems,
    invoices
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

