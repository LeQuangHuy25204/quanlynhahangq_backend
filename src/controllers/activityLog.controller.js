'use strict';

const activityLogService = require('../services/activityLog.service');

/**
 * GET /api/activity-logs
 * Protected: RestaurantAdmin
 */
const getLogs = async (req, res, next) => {
  try {
    const data = await activityLogService.getActivityLogs(req.query, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/activity-logs/:logId
 * Protected: RestaurantAdmin
 */
const getLogDetail = async (req, res, next) => {
  try {
    const data = await activityLogService.getActivityLogDetail(req.params.logId, req.user);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

module.exports = { getLogs, getLogDetail };
