'use strict';

const crypto = require('crypto');
const sessionModel = require('../models/session.model');
const { SESSION_STATUS } = require('../constants/status');

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

  // Táº¡o session má»›i â€” CHá»œ Má»ž BÃ€N
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
 * KhÃ¡ch tham gia phiÃªn báº±ng SessionToken (ngÆ°á»i quÃ©t QR) hoáº·c JoinCode (ngÆ°á»i thá»© 2).
 * branchId dÃ¹ng Ä‘á»ƒ xÃ¡c minh session thuá»™c Ä‘Ãºng chi nhÃ¡nh.
 *
 * @param {string} sessionCode - LÃ  SessionToken (36 kÃ½ tá»±) hoáº·c JoinCode (6 kÃ½ tá»±)
 * @param {string} guestName
 * @param {number} branchId
 */
const joinSession = async (sessionCode, guestName, branchId) => {
  if (!sessionCode || !guestName) {
    const err = new Error('sessionCode (Token/JoinCode) vÃ  guestName lÃ  báº¯t buá»™c.');
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
    const err = new Error('PhiÃªn khÃ´ng tá»“n táº¡i hoáº·c Ä‘Ã£ Ä‘Ã³ng.');
    err.statusCode = 404;
    throw err;
  }

  if (session.BranchID !== parseInt(branchId, 10)) {
    const err = new Error('PhiÃªn khÃ´ng thuá»™c chi nhÃ¡nh nÃ y.');
    err.statusCode = 403;
    throw err;
  }

  if (session.Status === SESSION_STATUS.CLOSED) {
    const err = new Error('PhiÃªn bÃ n nÃ y Ä‘Ã£ Ä‘Ã³ng.');
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

  await sessionModel.updateSessionStatus(sessionId, parsedStatus);
  return { sessionId, status: parsedStatus, message: 'Cáº­p nháº­t tráº¡ng thÃ¡i thÃ nh cÃ´ng.' };
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
 * Lay thong tin phien theo SessionID.
 */
const getSessionById = async (sessionId) => {
  const session = await sessionModel.findSessionById(sessionId);
  return session || null;
};

module.exports = { processQRScan, joinSession, updateSessionStatus, manualOpenSession, getSessionById };


