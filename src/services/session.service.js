'use strict';

const crypto = require('crypto');
const sessionModel = require('../models/session.model');
const { SESSION_STATUS } = require('../constants/status');

const generateJoinCode = () =>
  crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

/**
 * Xử lý nghiệp vụ quét QR mở bàn.
 *
 * Hệ thống 1 nhà hàng: chỉ cần qrCode + branchId (chi nhánh cụ thể).
 * restaurantId không cần từ client.
 *
 * Quy tắc:
 * 1. Tìm bàn theo QRCode lọc theo branchId (cách ly chi nhánh).
 * 2. Bàn không tồn tại / không thuộc chi nhánh → 404.
 * 3. Bàn INACTIVE → 409.
 * 4. Đã có session OPEN / WAITING_OPEN → trả về session hiện tại (idempotent).
 * 5. Chưa có → tạo mới với status = WAITING_OPEN (0).
 *
 * @param {string} qrCode
 * @param {number} branchId
 */
const processQRScan = async (qrCode, branchId) => {
  if (!qrCode || !branchId) {
    const err = new Error('qrCode và branchId là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  const parsedBranchId = parseInt(branchId, 10);

  const table = await sessionModel.findTableByQRCode(qrCode, parsedBranchId);
  if (!table) {
    const err = new Error('Không tìm thấy bàn với mã QR này trong chi nhánh.');
    err.statusCode = 404;
    throw err;
  }
  if (!table.IsActive) {
    const err = new Error('Bàn này hiện đang không hoạt động.');
    err.statusCode = 409;
    throw err;
  }

  const existingSession = await sessionModel.findActiveSessionByTableId(table.TableID);
  if (existingSession) {
    return {
      isNew:        false,
      sessionId:    existingSession.SessionID,
      sessionToken: existingSession.SessionToken,
      joinCode:     existingSession.JoinCode,
      status:       existingSession.Status,
      table: {
        tableId:   table.TableID,
        tableName: table.TableName,
        areaName:  table.AreaName,
      },
    };
  }

  // Tạo session mới — CHỜ MỞ BÀN
  const sessionToken = crypto.randomUUID();
  const joinCode     = generateJoinCode();

  const newSessionId = await sessionModel.createSession({
    tableId: table.TableID,
    sessionToken,
    joinCode,
    status: SESSION_STATUS.WAITING_OPEN,
  });

  return {
    isNew:        true,
    sessionId:    newSessionId,
    sessionToken,
    joinCode,
    status:       SESSION_STATUS.WAITING_OPEN,
    table: {
      tableId:   table.TableID,
      tableName: table.TableName,
      areaName:  table.AreaName,
    },
  };
};

/**
 * Khách tham gia phiên bằng SessionToken (người quét QR) hoặc JoinCode (người thứ 2).
 * branchId dùng để xác minh session thuộc đúng chi nhánh.
 *
 * @param {string} sessionCode - Là SessionToken (36 ký tự) hoặc JoinCode (6 ký tự)
 * @param {string} guestName
 * @param {number} branchId
 */
const joinSession = async (sessionCode, guestName, branchId) => {
  if (!sessionCode || !guestName) {
    const err = new Error('sessionCode (Token/JoinCode) và guestName là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  let session;
  if (sessionCode.length === 6) {
    session = await sessionModel.findSessionByJoinCode(sessionCode);
  } else {
    session = await sessionModel.findSessionByToken(sessionCode);
  }
  if (!session) {
    const err = new Error('Phiên không tồn tại hoặc đã đóng.');
    err.statusCode = 404;
    throw err;
  }

  if (session.BranchID !== parseInt(branchId, 10)) {
    const err = new Error('Phiên không thuộc chi nhánh này.');
    err.statusCode = 403;
    throw err;
  }

  if (session.Status === SESSION_STATUS.CLOSED) {
    const err = new Error('Phiên bàn này đã đóng.');
    err.statusCode = 409;
    throw err;
  }

  const participantId = await sessionModel.addParticipant({
    sessionId: session.SessionID,
    guestName,
  });

  return { participantId, sessionId: session.SessionID, guestName };
};

/**
 * Nhân viên cập nhật trạng thái bàn (Mở bàn, Đóng bàn).
 *
 * @param {number} sessionId
 * @param {number} status - Trạng thái mới (0, 1, 2)
 * @param {object} actorUser - Người gọi API (Waiter, Manager, Admin)
 */
const updateSessionStatus = async (sessionId, status, actorUser) => {
  const parsedStatus = parseInt(status, 10);
  if (isNaN(parsedStatus) || !Object.values(SESSION_STATUS).includes(parsedStatus)) {
    const err = new Error('Trạng thái không hợp lệ.');
    err.statusCode = 400;
    throw err;
  }

  const session = await sessionModel.findSessionById(sessionId);
  if (!session) {
    const err = new Error('Không tìm thấy phiên bàn.');
    err.statusCode = 404;
    throw err;
  }

  // Bảo mật (BR-18): Cách ly chi nhánh
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    if (session.BranchID !== actorUser.branchId) {
      const err = new Error('Bạn không có quyền cập nhật bàn của chi nhánh khác.');
      err.statusCode = 403;
      throw err;
    }
  }

  if (session.Status === parsedStatus) {
    return { sessionId, status: parsedStatus, message: 'Trạng thái không đổi.' };
  }

  await sessionModel.updateSessionStatus(sessionId, parsedStatus);
  return { sessionId, status: parsedStatus, message: 'Cập nhật trạng thái thành công.' };
};

module.exports = { processQRScan, joinSession, updateSessionStatus };
