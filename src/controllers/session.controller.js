'use strict';

const sessionService = require('../services/session.service');

/**
 * POST /api/sessions/qr-scan
 * Body: { qrCode, branchId }
 */
const qrScan = async (req, res, next) => {
  try {
    const { qrCode, branchId } = req.body;
    const data = await sessionService.processQRScan(qrCode, branchId);
    const statusCode = data.isNew ? 201 : 200;
    const message    = data.isNew
      ? 'Tạo phiên bàn mới thành công. Đang chờ nhân viên mở bàn.'
      : 'Bàn đã có phiên đang mở.';
    res.status(statusCode).json({ success: true, message, data });
  } catch (err) { next(err); }
};

/**
 * POST /api/sessions/join
 * Body: { sessionCode, guestName, branchId }
 */
const joinSession = async (req, res, next) => {
  try {
    const { sessionCode, guestName, branchId } = req.body;
    const data = await sessionService.joinSession(sessionCode, guestName, branchId);
    res.status(200).json({ success: true, message: 'Tham gia phiên thành công.', data });
  } catch (err) { next(err); }
};

/**
 * PUT /api/sessions/:sessionId/status
 * Body: { status: number }
 */
const updateSessionStatus = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { status } = req.body;
    const data = await sessionService.updateSessionStatus(sessionId, status, req.user);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

/**
 * POST /api/sessions/open
 * Body: { tableId, guestCount, note }
 */
const manualOpenSession = async (req, res, next) => {
  try {
    const { tableId, guestCount } = req.body;
    const data = await sessionService.manualOpenSession(tableId, guestCount, req.user);
    res.status(201).json({ success: true, message: 'Mở bàn thành công.', data });
  } catch (err) { next(err); }
};

/**
 * GET /api/sessions/:sessionId
 */
const getSessionById = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const session = await sessionService.getSessionById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Phiên không tồn tại.' });
    }
    res.status(200).json({ success: true, data: session });
  } catch (err) { next(err); }
};

module.exports = { qrScan, joinSession, updateSessionStatus, manualOpenSession, getSessionById };
