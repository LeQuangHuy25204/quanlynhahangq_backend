'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');
const sessionModel = require('../models/session.model');
const orderModel = require('../models/order.model');
const activityLogService = require('./activityLog.service');
const { SESSION_STATUS, ORDER_STATUS, ROLE_CODE, LOG_SEVERITY } = require('../constants/status');

const WAIT_OPEN_TIMEOUT_MINUTES = Math.max(
  1,
  parseInt(process.env.SESSION_WAIT_TIMEOUT_MINUTES || '5', 10) || 5
);
const WAIT_OPEN_TIMEOUT_SECONDS = WAIT_OPEN_TIMEOUT_MINUTES * 60;

const generateJoinCode = () =>
  crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

// Khóa đồng bộ theo từng bàn để chống race-condition khi 2 request quét QR đến cùng 1 mili-giây
const tableScanLocks = new Map();
const withTableLock = async (lockKey, fn) => {
  const prev = tableScanLocks.get(lockKey) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  tableScanLocks.set(lockKey, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tableScanLocks.get(lockKey) === next) {
      tableScanLocks.delete(lockKey);
    }
  }
};

/**
 * Tính thời điểm hết hạn chờ mở bàn (mặc định 5 phút kể từ lúc quét QR).
 */
const buildWaitTiming = (session) => {
  const nowMs = Date.now();
  if (!session || session.Status !== SESSION_STATUS.WAITING_OPEN) {
    return {
      waitTimeoutMinutes: WAIT_OPEN_TIMEOUT_MINUTES,
      waitTimeoutSeconds: WAIT_OPEN_TIMEOUT_SECONDS,
      expiresAt: null,
      remainingSeconds: null,
      serverNow: new Date(nowMs).toISOString(),
    };
  }
  const origin = session.CreatedAt || session.StartTime;
  const originMs = origin ? new Date(origin).getTime() : nowMs;
  const expiresAtMs = originMs + WAIT_OPEN_TIMEOUT_SECONDS * 1000;
  return {
    waitTimeoutMinutes: WAIT_OPEN_TIMEOUT_MINUTES,
    waitTimeoutSeconds: WAIT_OPEN_TIMEOUT_SECONDS,
    expiresAt: new Date(expiresAtMs).toISOString(),
    remainingSeconds: Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)),
    serverNow: new Date(nowMs).toISOString(),
  };
};

/**
 * Tự động đóng các phiên bàn đang ở trạng thái CHỜ MỞ BÀN (Status = 0)
 * nếu đã quá 5 phút (hoặc SESSION_WAIT_TIMEOUT_MINUTES) kể từ khi khách quét QR mà nhân viên chưa xác nhận mở bàn.
 */
const closeExpiredWaitingSessions = async ({ tableId = null, sessionId = null, deps = {} } = {}) => {
  const sModel = deps.sessionModel || sessionModel;
  const oModel = deps.orderModel || orderModel;
  const logger = deps.activityLog || activityLogService;
  const timeoutSeconds = deps.timeoutSeconds ?? WAIT_OPEN_TIMEOUT_SECONDS;
  const timeoutMinutes = Math.max(1, Math.round(timeoutSeconds / 60));

  const expiredList = await sModel.findExpiredWaitingSessions(timeoutSeconds, { tableId, sessionId });
  if (!expiredList || expiredList.length === 0) {
    return [];
  }

  const closedSessions = [];
  for (const s of expiredList) {
    const affected = await sModel.autoCloseWaitingSessionById(s.SessionID, timeoutSeconds);
    if (affected !== 1) continue;

    await oModel.updateAllOrdersStatusInSession(s.SessionID, ORDER_STATUS.CANCELLED);
    if (typeof sModel.clearSupportRequest === 'function') {
      await sModel.clearSupportRequest(s.SessionID);
    }

    const elapsedSec = Number(s.ElapsedSeconds || timeoutSeconds);
    await logger.logSystemAction({
      restaurantId: s.RestaurantID || 1,
      branchId: s.BranchID,
      actorName: 'Hệ thống tự động',
      entityType: 'Session',
      entityId: s.SessionID,
      action: 'SESSION_AUTO_CLOSE_TIMEOUT',
      severity: LOG_SEVERITY.WARNING,
      description: `Tự động đóng ${s.TableName || `Bàn #${s.TableID}`} (Phiên #${s.SessionID}) do quá ${timeoutMinutes} phút chưa được nhân viên mở bàn.`,
      oldValue: {
        sessionId: s.SessionID,
        tableId: s.TableID,
        tableName: s.TableName,
        status: SESSION_STATUS.WAITING_OPEN,
        createdAt: s.CreatedAt || s.StartTime,
      },
      newValue: {
        sessionId: s.SessionID,
        status: SESSION_STATUS.CLOSED,
        closeReason: 'AUTO_CLOSE_TIMEOUT',
        timeoutMinutes,
        elapsedSeconds: elapsedSec,
      },
    });

    console.log(`[SESSION_AUTO_CLOSE] ⏱️ Tự động đóng ${s.TableName || `Table#${s.TableID}`} (Session #${s.SessionID}) sau ${elapsedSec}s chờ mở bàn.`);
    closedSessions.push(s);
  }

  return closedSessions;
};

let autoCloseTimer = null;
let isAutoCloseRunning = false;

/**
 * Khởi chạy bộ quét định kỳ mỗi 15 giây để tự động đóng bàn chờ quá 5 phút.
 */
const startAutoCloseWaitingSessionsJob = (intervalMs = 15000) => {
  if (autoCloseTimer) return autoCloseTimer;
  autoCloseTimer = setInterval(async () => {
    if (isAutoCloseRunning) return;
    isAutoCloseRunning = true;
    try {
      await closeExpiredWaitingSessions();
    } catch (err) {
      console.error('[SESSION_AUTO_CLOSE] Lỗi quét đóng bàn tự động:', err.message);
    } finally {
      isAutoCloseRunning = false;
    }
  }, intervalMs);

  if (typeof autoCloseTimer.unref === 'function') {
    autoCloseTimer.unref();
  }
  return autoCloseTimer;
};

const stopAutoCloseWaitingSessionsJob = () => {
  if (autoCloseTimer) {
    clearInterval(autoCloseTimer);
    autoCloseTimer = null;
  }
};

/**
 * Xử lý nghiệp vụ quét QR mở bàn.
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

  return withTableLock(`table_${table.TableID}`, async () => {
    // Dọn trước phiên chờ cũ nếu đã quá 5 phút chưa được mở bàn
    await closeExpiredWaitingSessions({ tableId: table.TableID });

    const existingSession = await sessionModel.findActiveSessionByTableId(table.TableID);
    if (existingSession) {
      const participants = await sessionModel.getSessionParticipants(existingSession.SessionID);
      const hasHost = participants.length > 0;
      const timing = buildWaitTiming(existingSession);

      return {
        isNew:            !hasHost,
        requiresJoinCode: hasHost,
        participantCount: participants.length,
        hostName:         hasHost ? participants[0].GuestName : null,
        sessionId:        existingSession.SessionID,
        sessionToken:     hasHost ? null : existingSession.SessionToken,
        joinCode:         hasHost ? null : existingSession.JoinCode,
        status:           existingSession.Status,
        ...timing,
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

    const timing = buildWaitTiming({
      Status: SESSION_STATUS.WAITING_OPEN,
      CreatedAt: new Date(),
    });

    await activityLogService.logGuestAction({
      branchId: parsedBranchId,
      actorName: `Khách quét QR (${table.TableName})`,
      entityType: 'Session',
      entityId: newSessionId,
      action: 'SESSION_QR_SCAN',
      severity: LOG_SEVERITY.INFO,
      description: `Khách quét mã QR tạo phiên #${newSessionId} tại ${table.TableName} (chờ nhân viên mở bàn trong ${WAIT_OPEN_TIMEOUT_MINUTES} phút).`,
      newValue: {
        sessionId: newSessionId,
        tableId: table.TableID,
        tableName: table.TableName,
        status: SESSION_STATUS.WAITING_OPEN,
        timeoutMinutes: WAIT_OPEN_TIMEOUT_MINUTES,
      },
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
      ...timing,
      table: {
        tableId:   table.TableID,
        tableName: table.TableName,
        areaName:  table.AreaName,
      },
    };
  });
};

/**
 * Khách tham gia phiên bằng SessionToken (người quét QR) hoặc JoinCode (người thứ 2).
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

  if (session.Status === SESSION_STATUS.WAITING_OPEN) {
    const closed = await closeExpiredWaitingSessions({ sessionId: session.SessionID });
    if (closed.length > 0) {
      const err = new Error(
        `Phiên chờ mở bàn đã tự động đóng sau ${WAIT_OPEN_TIMEOUT_MINUTES} phút do chưa được nhân viên xác nhận. Vui lòng quét lại mã QR tại bàn.`
      );
      err.statusCode = 409;
      throw err;
    }
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

  const finalGuestCount = (isFirstGuest && guestCount && parseInt(guestCount, 10) > 0)
    ? parseInt(guestCount, 10)
    : session.GuestCount;

  if (isFirstGuest && guestCount && parseInt(guestCount, 10) > 0) {
    await sessionModel.updateGuestCount(session.SessionID, finalGuestCount);
  }

  await activityLogService.logGuestAction({
    restaurantId: session.RestaurantID,
    branchId: session.BranchID,
    actorName: `Khách: ${trimmedName}`,
    entityType: 'Session',
    entityId: session.SessionID,
    action: 'SESSION_GUEST_JOIN',
    severity: LOG_SEVERITY.INFO,
    description: `Khách "${trimmedName}" tham gia ${session.TableName || `bàn #${session.TableID}`} (Phiên #${session.SessionID})${isFirstGuest ? ` — ${finalGuestCount} khách` : ''}.`,
    newValue: {
      participantId,
      guestName: trimmedName,
      isHost: isFirstGuest,
      guestCount: finalGuestCount,
      tableName: session.TableName,
    },
  });

  return {
    participantId,
    sessionId:    session.SessionID,
    sessionToken: session.SessionToken,
    joinCode:     session.JoinCode,
    status:       session.Status,
    guestName:    trimmedName,
    guestCount:   finalGuestCount,
    isHost:       isFirstGuest,
    ...buildWaitTiming(session),
  };
};

/**
 * Nhân viên cập nhật trạng thái bàn (Mở bàn 0 -> 1, Đóng bàn * -> 2).
 */
const updateSessionStatus = async (sessionId, status, actorUser) => {
  const parsedStatus = parseInt(status, 10);
  if (isNaN(parsedStatus) || !Object.values(SESSION_STATUS).includes(parsedStatus)) {
    const err = new Error('Trạng thái không hợp lệ.');
    err.statusCode = 400;
    throw err;
  }

  let session = await sessionModel.findSessionById(sessionId);
  if (!session) {
    const err = new Error('Không tìm thấy phiên bàn.');
    err.statusCode = 404;
    throw err;
  }

  // Bảo mật (BR-18): Cách ly chi nhánh
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN) {
    if (session.BranchID !== actorUser.branchId) {
      const err = new Error('Bạn không có quyền cập nhật bàn của chi nhánh khác.');
      err.statusCode = 403;
      throw err;
    }
  }

  // Nếu nhân viên đang xác nhận mở bàn nhưng phiên đã quá 5 phút chờ -> tự động đóng luôn
  if (session.Status === SESSION_STATUS.WAITING_OPEN && parsedStatus === SESSION_STATUS.OPEN) {
    const closed = await closeExpiredWaitingSessions({ sessionId: session.SessionID });
    if (closed.length > 0) {
      const err = new Error(
        `Phiên chờ mở bàn đã quá ${WAIT_OPEN_TIMEOUT_MINUTES} phút và được hệ thống tự động đóng. Vui lòng hướng dẫn khách quét lại mã QR.`
      );
      err.statusCode = 409;
      throw err;
    }
    session = await sessionModel.findSessionById(sessionId);
  }

  if (session.Status === parsedStatus) {
    return { sessionId, status: parsedStatus, message: 'Trạng thái không đổi.' };
  }

  const affected = await sessionModel.updateSessionStatus(sessionId, parsedStatus);
  if (parsedStatus === SESSION_STATUS.CLOSED && affected === 0) {
    const err = new Error('Bàn đã có món gọi, chỉ được đóng bàn sau khi đã thanh toán.');
    err.statusCode = 409;
    throw err;
  }

  // Nếu đóng bàn (hoặc hủy phiên khi chưa có món), dọn dẹp các order chưa thanh toán & chuông hỗ trợ
  if (parsedStatus === SESSION_STATUS.CLOSED) {
    const [payments] = await pool.execute(
      `SELECT 1 FROM invoice i INNER JOIN payment p ON p.InvoiceID = i.InvoiceID WHERE i.SessionID = ? AND p.Status = 1 LIMIT 1`,
      [sessionId]
    );
    if (!payments || payments.length === 0) {
      await orderModel.updateAllOrdersStatusInSession(sessionId, ORDER_STATUS.CANCELLED);
    }
    await sessionModel.clearSupportRequest(sessionId);
  }

  const isOpenConfirm = session.Status === SESSION_STATUS.WAITING_OPEN && parsedStatus === SESSION_STATUS.OPEN;
  await activityLogService.logStaffAction(actorUser, {
    branchId: session.BranchID,
    entityType: 'Session',
    entityId: Number(sessionId),
    action: isOpenConfirm ? 'SESSION_OPEN_CONFIRM' : (parsedStatus === SESSION_STATUS.CLOSED ? 'SESSION_CLOSE' : 'SESSION_STATUS_UPDATE'),
    severity: parsedStatus === SESSION_STATUS.CLOSED && session.Status === SESSION_STATUS.WAITING_OPEN
      ? LOG_SEVERITY.WARNING
      : LOG_SEVERITY.INFO,
    description: isOpenConfirm
      ? `Xác nhận mở ${session.TableName || `bàn #${session.TableID}`} (Phiên #${sessionId}).`
      : `Đóng ${session.TableName || `bàn #${session.TableID}`} (Phiên #${sessionId}).`,
    oldValue: { status: session.Status, tableName: session.TableName },
    newValue: { status: parsedStatus, tableName: session.TableName },
  });

  return { sessionId, status: parsedStatus, message: 'Cập nhật trạng thái thành công.' };
};

/**
 * Nhân viên mở bàn thủ công.
 */
const manualOpenSession = async (tableId, guestCount, actorUser) => {
  if (!tableId) {
    const err = new Error('Vui lòng chọn bàn.');
    err.statusCode = 400;
    throw err;
  }

  const [rows] = await pool.execute(
    `SELECT t.TableID, t.Name AS TableName, t.IsActive, a.BranchID, b.RestaurantID
     FROM \`table\` t
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE t.TableID = ?`,
    [tableId]
  );

  if (!rows.length) {
    const err = new Error('Bàn không tồn tại.');
    err.statusCode = 404;
    throw err;
  }

  const table = rows[0];
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && table.BranchID !== actorUser.branchId) {
    const err = new Error('Bạn không có quyền mở bàn của chi nhánh khác.');
    err.statusCode = 403;
    throw err;
  }

  if (!table.IsActive) {
    const err = new Error('Bàn này hiện đang không hoạt động.');
    err.statusCode = 409;
    throw err;
  }

  await closeExpiredWaitingSessions({ tableId: table.TableID });

  const existingSession = await sessionModel.findActiveSessionByTableId(table.TableID);
  if (existingSession) {
    const err = new Error('Bàn này đã có phiên đang mở.');
    err.statusCode = 409;
    throw err;
  }

  const sessionToken = crypto.randomUUID();
  const joinCode = generateJoinCode();

  const sessionId = await sessionModel.createSession({
    tableId: table.TableID,
    sessionToken,
    joinCode,
    status: SESSION_STATUS.OPEN, // Nhân viên mở thì active luôn
    guestCount: guestCount || 2,
  });

  await activityLogService.logStaffAction(actorUser, {
    branchId: table.BranchID,
    entityType: 'Session',
    entityId: sessionId,
    action: 'SESSION_MANUAL_OPEN',
    severity: LOG_SEVERITY.INFO,
    description: `Mở bàn thủ công ${table.TableName} (Phiên #${sessionId}, ${guestCount || 2} khách).`,
    newValue: {
      sessionId,
      tableId: table.TableID,
      tableName: table.TableName,
      status: SESSION_STATUS.OPEN,
      guestCount: guestCount || 2,
    },
  });

  return { sessionId, sessionToken, joinCode, status: SESSION_STATUS.OPEN };
};

/**
 * Lấy thông tin phiên theo SessionID (kèm đếm ngược 5 phút & tự đóng nếu quá hạn).
 * Bảo mật: Không bao giờ lộ SessionToken; chỉ trả JoinCode nếu participantId hợp lệ thuộc phiên này.
 */
const getSessionById = async (sessionId, participantId = null) => {
  let session = await sessionModel.findSessionById(sessionId);
  if (!session) return null;

  let autoClosedTimeout = false;
  if (session.Status === SESSION_STATUS.WAITING_OPEN) {
    const closed = await closeExpiredWaitingSessions({ sessionId: session.SessionID });
    if (closed.length > 0) {
      autoClosedTimeout = true;
      session = await sessionModel.findSessionById(sessionId);
    }
  }

  const participants = await sessionModel.getSessionParticipants(sessionId);
  const parsedParticipantId = participantId ? parseInt(participantId, 10) : null;
  const isVerifiedParticipant = parsedParticipantId
    ? participants.some((p) => Number(p.ParticipantID) === parsedParticipantId)
    : false;

  const timing = buildWaitTiming(session);

  return {
    SessionID:        session.SessionID,
    TableID:          session.TableID,
    TableName:        session.TableName,
    BranchID:         session.BranchID,
    Status:           session.Status,
    GuestCount:       session.GuestCount,
    JoinCode:         isVerifiedParticipant ? session.JoinCode : null,
    CreatedAt:        session.CreatedAt,
    StartTime:        session.StartTime,
    EndTime:          session.EndTime,
    ExpiresAt:        timing.expiresAt,
    RemainingSeconds: timing.remainingSeconds,
    WaitTimeoutMinutes: timing.waitTimeoutMinutes,
    WaitTimeoutSeconds: timing.waitTimeoutSeconds,
    ServerNow:        timing.serverNow,
    AutoClosedTimeout: autoClosedTimeout,
    participantCount: participants.length,
    hostName:         participants.length > 0 ? participants[0].GuestName : null,
    participants,
  };
};

/**
 * Khách hàng bấm nút "Gọi nhân viên" từ điện thoại để yêu cầu nhân viên tới bàn hỗ trợ.
 */
const requestStaffSupport = async ({ sessionToken, reason }) => {
  if (!sessionToken) {
    const err = new Error('Thiếu sessionToken xác thực phiên bàn.');
    err.statusCode = 401;
    throw err;
  }
  const session = await sessionModel.findSessionByToken(sessionToken);
  if (!session) {
    const err = new Error('Phiên bàn không tồn tại.');
    err.statusCode = 404;
    throw err;
  }
  if (session.Status !== SESSION_STATUS.OPEN) {
    const err = new Error('Chỉ có thể gọi nhân viên khi bàn đang phục vụ.');
    err.statusCode = 409;
    throw err;
  }

  const res = await sessionModel.createSupportRequest(
    session.SessionID,
    reason || 'Khách cần nhân viên hỗ trợ tại bàn'
  );

  await activityLogService.logGuestAction({
    restaurantId: session.RestaurantID,
    branchId: session.BranchID,
    actorName: `Khách tại ${session.TableName || `bàn #${session.TableID}`}`,
    entityType: 'Session',
    entityId: session.SessionID,
    action: 'SESSION_CALL_STAFF',
    severity: LOG_SEVERITY.INFO,
    description: `Khách tại ${session.TableName || `Phiên #${session.SessionID}`} gọi nhân viên hỗ trợ: "${res.note}".`,
    newValue: { sessionId: session.SessionID, reason: res.note },
  });

  return {
    sessionId: session.SessionID,
    tableName: session.TableName,
    needSupport: true,
    supportNote: res.note,
    message: 'Đã gửi thông báo gọi nhân viên! Nhân viên sẽ đến bàn hỗ trợ bạn ngay.',
  };
};

/**
 * Nhân viên xác nhận đã hỗ trợ khách tại bàn (tắt chuông báo hỗ trợ trên sơ đồ bàn).
 */
const resolveStaffSupport = async (sessionId, actorUser) => {
  const session = await sessionModel.findSessionById(sessionId);
  if (!session) {
    const err = new Error('Không tìm thấy phiên bàn.');
    err.statusCode = 404;
    throw err;
  }
  if (actorUser.roleCode !== ROLE_CODE.RESTAURANT_ADMIN && session.BranchID !== actorUser.branchId) {
    const err = new Error('Bạn không có quyền thao tác trên bàn của chi nhánh khác.');
    err.statusCode = 403;
    throw err;
  }
  await sessionModel.clearSupportRequest(sessionId);

  await activityLogService.logStaffAction(actorUser, {
    branchId: session.BranchID,
    entityType: 'Session',
    entityId: Number(sessionId),
    action: 'SESSION_RESOLVE_SUPPORT',
    severity: LOG_SEVERITY.INFO,
    description: `Xác nhận đã hỗ trợ khách tại ${session.TableName} (Phiên #${sessionId}).`,
    newValue: { sessionId: Number(sessionId), needSupport: false },
  });

  return {
    sessionId: Number(sessionId),
    needSupport: false,
    message: `Đã xác nhận hỗ trợ xong cho ${session.TableName}.`,
  };
};

module.exports = {
  WAIT_OPEN_TIMEOUT_MINUTES,
  WAIT_OPEN_TIMEOUT_SECONDS,
  buildWaitTiming,
  closeExpiredWaitingSessions,
  startAutoCloseWaitingSessionsJob,
  stopAutoCloseWaitingSessionsJob,
  processQRScan,
  joinSession,
  updateSessionStatus,
  manualOpenSession,
  getSessionById,
  requestStaffSupport,
  resolveStaffSupport,
};
