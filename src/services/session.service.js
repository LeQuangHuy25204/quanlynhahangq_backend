'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');
const sessionModel = require('../models/session.model');
const orderModel = require('../models/order.model');
const { SESSION_STATUS, ORDER_STATUS } = require('../constants/status');

const generateJoinCode = () =>
  crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

/**
 * Xá»­ lÃ½ nghiá»‡p vá»¥ quÃ©t QR má»Ÿ bÃ n.
 *
 * Há»‡ thá»‘ng 1 nhÃ  hÃ ng: chá»‰ cáº§n qrCode + branchId (chi nhÃ¡nh cá»¥ thá»ƒ).
 * restaurantId khÃ´ng cáº§n tá»« client.
 *
 * Quy táº¯c:
 * 1. TÃ¬m bÃ n theo QRCode lá»c theo branchId (cÃ¡ch ly chi nhÃ¡nh).
 * 2. BÃ n khÃ´ng tá»“n táº¡i / khÃ´ng thuá»™c chi nhÃ¡nh â†’ 404.
 * 3. BÃ n INACTIVE â†’ 409.
 * 4. ÄÃ£ cÃ³ session OPEN / WAITING_OPEN â†’ tráº£ vá» session hiá»‡n táº¡i (idempotent).
 * 5. ChÆ°a cÃ³ â†’ táº¡o má»›i vá»›i status = WAITING_OPEN (0).
 *
 * @param {string} qrCode
 * @param {number} branchId
 */
const processQRScan = async (qrCode, branchId) => {
  if (!qrCode || !branchId) {
    const err = new Error('qrCode vÃ  branchId lÃ  báº¯t buá»™c.');
    err.statusCode = 400;
    throw err;
  }

  const parsedBranchId = parseInt(branchId, 10);

  const table = await sessionModel.findTableByQRCode(qrCode, parsedBranchId);
  if (!table) {
    const err = new Error('KhÃ´ng tÃ¬m tháº¥y bÃ n vá»›i mÃ£ QR nÃ y trong chi nhÃ¡nh.');
    err.statusCode = 404;
    throw err;
  }
  if (!table.IsActive) {
    const err = new Error('BÃ n nÃ y hiá»‡n Ä‘ang khÃ´ng hoáº¡t Ä‘á»™ng.');
    err.statusCode = 409;
    throw err;
  }

  const existingSession = await sessionModel.findActiveSessionByTableId(table.TableID);
  if (existingSession) {
    const participants = await sessionModel.getSessionParticipants(existingSession.SessionID);
    const hasHost = participants.length > 0;

    return {
      isNew:            !hasHost,
      requiresJoinCode: hasHost,
      participantCount: participants.length,
      hostName:         hasHost ? participants[0].GuestName : null,
      sessionId:        existingSession.SessionID,
      sessionToken:     hasHost ? null : existingSession.SessionToken,
      joinCode:         hasHost ? null : existingSession.JoinCode,
      status:           existingSession.Status,
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
    isNew:            true,
    requiresJoinCode: false,
    participantCount: 0,
    hostName:         null,
    sessionId:        newSessionId,
    sessionToken,
    joinCode,
    status:           SESSION_STATUS.WAITING_OPEN,
    table: {
      tableId:   table.TableID,
      tableName: table.TableName,
      areaName:  table.AreaName,
    },
  };
};

/**
 * KhÃ¡ch tham gia phiÃªn báº±ng SessionToken (ngÆ°á»i quÃ©t QR) hoáº·c JoinCode (ngÆ°á»i thá»© 2).
 * branchId dÃ¹ng Ä‘á»ƒ xÃ¡c minh session thuá»™c Ä‘Ãºng chi nhÃ¡nh.
 *
 * @param {string} sessionCode - LÃ  SessionToken (36 kÃ½ tá»±) hoáº·c JoinCode (6 kÃ½ tá»±)
 * @param {string} guestName
 * @param {number} branchId
 */
const joinSession = async (sessionCode, guestName, branchId, guestCount, sessionId = null) => {
  if (!sessionCode || !guestName) {
    const err = new Error('Mã tham gia và tên người dùng là bắt buộc.');
    err.statusCode = 400;
    throw err;
  }

  const trimmedCode = String(sessionCode).trim();
  const trimmedName = String(guestName).trim();

  let session;
  if (sessionId) {
    session = await sessionModel.findSessionById(sessionId);
  } else if (trimmedCode.length === 6) {
    session = await sessionModel.findSessionByJoinCode(trimmedCode.toUpperCase());
  } else {
    session = await sessionModel.findSessionByToken(trimmedCode);
  }

  if (!session) {
    const err = new Error('Phiên không tồn tại hoặc mã tham gia không hợp lệ.');
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

  const existingParticipants = await sessionModel.getSessionParticipants(session.SessionID);
  const isFirstGuest = existingParticipants.length === 0;

  if (!isFirstGuest) {
    // Người thứ 2, 3, 4...: Bàn phải được mở (Status = 1) và bắt buộc phải nhập đúng JoinCode
    if (session.Status === SESSION_STATUS.WAITING_OPEN) {
      const err = new Error('Bàn đang chờ nhân viên xác nhận mở bàn. Vui lòng đợi bàn mở rồi nhập mã tham gia.');
      err.statusCode = 409;
      throw err;
    }

    if (trimmedCode.toUpperCase() !== String(session.JoinCode).toUpperCase()) {
      const err = new Error('Mã tham gia không chính xác! Vui lòng kiểm tra mã trên màn hình của người đầu tiên trong bàn.');
      err.statusCode = 400;
      throw err;
    }
  } else {
    // Người đầu tiên: xác thực bằng SessionToken hoặc JoinCode của phiên đó
    const validToken = trimmedCode === session.SessionToken;
    const validJoinCode = trimmedCode.toUpperCase() === String(session.JoinCode).toUpperCase();
    if (!validToken && !validJoinCode) {
      const err = new Error('Mã phiên bàn không hợp lệ.');
      err.statusCode = 400;
      throw err;
    }
  }

  const participantId = await sessionModel.addParticipant({
    sessionId: session.SessionID,
    guestName: trimmedName,
  });

  if (isFirstGuest && guestCount && parseInt(guestCount, 10) > 0) {
    await sessionModel.updateGuestCount(session.SessionID, parseInt(guestCount, 10));
  }

  return {
    participantId,
    sessionId:    session.SessionID,
    sessionToken: session.SessionToken,
    joinCode:     session.JoinCode,
    status:       session.Status,
    guestName:    trimmedName,
    guestCount:   (isFirstGuest && guestCount) ? parseInt(guestCount, 10) : session.GuestCount,
    isHost:       isFirstGuest,
  };
};

/**
 * NhÃ¢n viÃªn cáº­p nháº­t tráº¡ng thÃ¡i bÃ n (Má»Ÿ bÃ n, ÄÃ³ng bÃ n).
 *
 * @param {number} sessionId
 * @param {number} status - Tráº¡ng thÃ¡i má»›i (0, 1, 2)
 * @param {object} actorUser - NgÆ°á»i gá»i API (Waiter, Manager, Admin)
 */
const updateSessionStatus = async (sessionId, status, actorUser) => {
  const parsedStatus = parseInt(status, 10);
  if (isNaN(parsedStatus) || !Object.values(SESSION_STATUS).includes(parsedStatus)) {
    const err = new Error('Tráº¡ng thÃ¡i khÃ´ng há»£p lá»‡.');
    err.statusCode = 400;
    throw err;
  }

  const session = await sessionModel.findSessionById(sessionId);
  if (!session) {
    const err = new Error('KhÃ´ng tÃ¬m tháº¥y phiÃªn bÃ n.');
    err.statusCode = 404;
    throw err;
  }

  // Báº£o máº­t (BR-18): CÃ¡ch ly chi nhÃ¡nh
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    if (session.BranchID !== actorUser.branchId) {
      const err = new Error('Báº¡n khÃ´ng cÃ³ quyá»n cáº­p nháº­t bÃ n cá»§a chi nhÃ¡nh khÃ¡c.');
      err.statusCode = 403;
      throw err;
    }
  }

  if (session.Status === parsedStatus) {
    return { sessionId, status: parsedStatus, message: 'Tráº¡ng thÃ¡i khÃ´ng Ä‘á»•i.' };
  }

  const affected = await sessionModel.updateSessionStatus(sessionId, parsedStatus);
  if (parsedStatus === SESSION_STATUS.CLOSED && affected === 0) {
    const err = new Error('Bàn đã có món gọi, chỉ được đóng bàn sau khi đã thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  // Nếu đóng bàn (hoặc hủy phiên khi chưa có món), dọn dẹp các order chưa thanh toán
  if (parsedStatus === SESSION_STATUS.CLOSED) {
    const [payments] = await pool.execute(
      `SELECT 1 FROM invoice i INNER JOIN payment p ON p.InvoiceID = i.InvoiceID WHERE i.SessionID = ? AND p.Status = 1 LIMIT 1`,
      [sessionId]
    );
    if (!payments || payments.length === 0) {
      await orderModel.updateAllOrdersStatusInSession(sessionId, ORDER_STATUS.CANCELLED);
    }
  }

  return { sessionId, status: parsedStatus, message: 'Cập nhật trạng thái thành công.' };
};

/**
 * NhÃ¢n viÃªn má»Ÿ bÃ n thá»§ cÃ´ng.
 */
const manualOpenSession = async (tableId, guestCount, actorUser) => {
  if (!tableId) {
    const err = new Error('Vui lÃ²ng chá»n bÃ n.');
    err.statusCode = 400;
    throw err;
  }

  const pool = require('../config/db').pool;
  const [rows] = await pool.execute(
    `SELECT t.TableID, t.IsActive, a.BranchID 
     FROM \`table\` t 
     INNER JOIN area a ON t.AreaID = a.AreaID 
     WHERE t.TableID = ?`,
    [tableId]
  );
  
  if (!rows.length) {
    const err = new Error('BÃ n khÃ´ng tá»“n táº¡i.');
    err.statusCode = 404;
    throw err;
  }
  
  const table = rows[0];
  const { ROLE_CODE } = require('../constants/status');
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && table.BranchID !== actorUser.branchId) {
    const err = new Error('Báº¡n khÃ´ng cÃ³ quyá»n má»Ÿ bÃ n cá»§a chi nhÃ¡nh khÃ¡c.');
    err.statusCode = 403;
    throw err;
  }

  if (!table.IsActive) {
    const err = new Error('BÃ n nÃ y hiá»‡n Ä‘ang khÃ´ng hoáº¡t Ä‘á»™ng.');
    err.statusCode = 409;
    throw err;
  }

  const existingSession = await sessionModel.findActiveSessionByTableId(table.TableID);
  if (existingSession) {
    const err = new Error('BÃ n nÃ y Ä‘Ã£ cÃ³ phiÃªn Ä‘ang má»Ÿ.');
    err.statusCode = 409;
    throw err;
  }

  const sessionToken = crypto.randomUUID();
  const joinCode = generateJoinCode();

  const sessionId = await sessionModel.createSession({
    tableId: table.TableID,
    sessionToken,
    joinCode,
    status: SESSION_STATUS.OPEN, // NhÃ¢n viÃªn má»Ÿ thÃ¬ active luÃ´n
    guestCount: guestCount || 2
  });

  return { sessionId, sessionToken, joinCode, status: SESSION_STATUS.OPEN };
};


/**
 * Lấy thông tin phiên theo SessionID (kèm số lượng & danh sách người tham gia).
 */
const getSessionById = async (sessionId) => {
  const session = await sessionModel.findSessionById(sessionId);
  if (!session) return null;

  const participants = await sessionModel.getSessionParticipants(sessionId);
  return {
    ...session,
    participantCount: participants.length,
    hostName: participants.length > 0 ? participants[0].GuestName : null,
    participants,
  };
};

module.exports = { processQRScan, joinSession, updateSessionStatus, manualOpenSession, getSessionById };


