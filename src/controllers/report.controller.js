'use strict';

const reportService = require('../services/report.service');

/**
 * GET /api/reports/branch-revenue?branchId=X&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
const getBranchRevenue = async (req, res, next) => {
  try {
    const { branchId, startDate, endDate } = req.query;
    const data = await reportService.getBranchRevenue({ branchId, startDate, endDate }, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

/**
 * GET /api/reports/restaurant-revenue?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
const getRestaurantRevenue = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await reportService.getRestaurantRevenue({ startDate, endDate }, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

const getDashboardSummary = async (req, res, next) => {
  try {
    const { branchId, startDate, endDate } = req.query;
    const data = await reportService.getDashboardSummary({ branchId, startDate, endDate }, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) { next(err); }
};

module.exports = { getBranchRevenue, getRestaurantRevenue, getDashboardSummary };

