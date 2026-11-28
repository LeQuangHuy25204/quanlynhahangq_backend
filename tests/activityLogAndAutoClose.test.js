'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_for_activity_log_suite';

const app = require('../src/app');
const activityLogService = require('../src/services/activityLog.service');
const sessionService = require('../src/services/session.service');
const paymentService = require('../src/services/payment.service');
const { requestContextMiddleware } = require('../src/utils/requestContext');
const { SESSION_STATUS, PAYMENT_STATUS, ORDER_STATUS, ACTOR_TYPE, LOG_SEVERITY } = require('../src/constants/status');

describe('ActivityLog Audit & 5-Minute Un-opened Table Auto-Close Tests', () => {
  beforeEach(() => {
    activityLogService.setTestWriter(null);
  });

  afterEach(() => {
    activityLogService.setTestWriter(null);
  });

  it('1. sanitizeAuditPayload loại bỏ đệ quy mọi thông tin nhạy cảm (password, token, secret, OTP, CVV)', () => {
    const cleaned = activityLogService.sanitizeAuditPayload({
      username: 'admin1',
      password: 'PlainPassword123',
      passwordHash: '$2a$12$abc',
      sessionToken: 'secret-session-uuid',
      vnp_SecureHash: 'hmac-512',
      nested: {
        otp: '123456',
        cvv: '999',
        apiKey: 'secret-key',
        tableName: 'Bàn T1-01',
      },
      items: [
        { menuItemId: 1, token: 'leak', amount: 250000 },
      ],
    });

    assert.equal(cleaned.username, 'admin1');
    assert.equal('password' in cleaned, false);
    assert.equal('passwordHash' in cleaned, false);
    assert.equal('sessionToken' in cleaned, false);
    assert.equal('vnp_SecureHash' in cleaned, false);
    assert.equal(cleaned.nested.tableName, 'Bàn T1-01');
    assert.equal('otp' in cleaned.nested, false);
    assert.equal('cvv' in cleaned.nested, false);
    assert.equal('apiKey' in cleaned.nested, false);
    assert.equal('token' in cleaned.items[0], false);
    assert.equal(cleaned.items[0].amount, 250000);
  });

  it('2. Ghi nhận đầy đủ các actor (Staff, Guest, System) kèm IP từ request context', async () => {
    const captured = [];
    activityLogService.setTestWriter(async (entry) => {
      captured.push(entry);
      return captured.length;
    });

    await new Promise((resolve, reject) => {
      const fakeReq = {
        method: 'POST',
        originalUrl: '/api/orders',
        headers: { 'x-forwarded-for': '203.113.10.5, 10.0.0.1' },
      };
      requestContextMiddleware(fakeReq, {}, async () => {
        try {
          await activityLogService.logStaffAction(
            { staffId: 1, restaurantId: 1, branchId: 1, roleCode: 'BranchManager', fullName: 'Trần QL', username: 'manager1' },
            {
              entityType: 'Promotion',
              entityId: 9,
              action: 'PROMOTION_UPDATE',
              severity: LOG_SEVERITY.CRITICAL,
              description: 'Sửa khuyến mãi',
              oldValue: { discountValue: 10 },
              newValue: { discountValue: 20, sessionToken: 'must-strip' },
            }
          );

          await activityLogService.logGuestAction({
            branchId: 1,
            actorName: 'Khách: Anh Minh',
            entityType: 'Order',
            entityId: 55,
            action: 'ORDER_CREATE',
            description: 'Khách gọi 3 món',
          });

          await activityLogService.logSystemAction({
            branchId: 2,
            entityType: 'Session',
            entityId: 88,
            action: 'SESSION_AUTO_CLOSE_TIMEOUT',
            severity: LOG_SEVERITY.WARNING,
            description: 'Tự động đóng bàn sau 5 phút',
          });

          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    assert.equal(captured.length, 3);
    assert.equal(captured[0].actorType, ACTOR_TYPE.BRANCH_MANAGER);
    assert.equal(captured[0].actorName, 'Trần QL (manager1)');
    assert.equal(captured[0].ipAddress, '203.113.10.5');
    assert.equal(captured[0].severity, LOG_SEVERITY.CRITICAL);
    assert.equal('sessionToken' in captured[0].newValue, false);

    assert.equal(captured[1].actorType, ACTOR_TYPE.GUEST);
    assert.equal(captured[1].staffId, null);
    assert.equal(captured[1].ipAddress, '203.113.10.5');

    assert.equal(captured[2].actorType, ACTOR_TYPE.SYSTEM);
    assert.equal(captured[2].severity, LOG_SEVERITY.WARNING);
  });

  it('3. RBAC API /api/activity-logs chặn người chưa đăng nhập (401) và role không phải RestaurantAdmin (403)', async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const unauthRes = await fetch(`${baseUrl}/api/activity-logs`);
      assert.equal(unauthRes.status, 401);

      const managerToken = jwt.sign(
        { staffId: 2, restaurantId: 1, branchId: 1, roleCode: 'BranchManager', fullName: 'Manager', username: 'manager1' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      const managerRes = await fetch(`${baseUrl}/api/activity-logs`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(managerRes.status, 403);

      const waiterToken = jwt.sign(
        { staffId: 5, restaurantId: 1, branchId: 1, roleCode: 'Waiter', fullName: 'Waiter', username: 'waiter1' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      const waiterRes = await fetch(`${baseUrl}/api/activity-logs/1`, {
        headers: { Authorization: `Bearer ${waiterToken}` },
      });
      assert.equal(waiterRes.status, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('4. Tự động đóng bàn khi khách quét QR quá 5 phút chưa được mở bàn & ghi ActivityLog SYSTEM (idempotent)', async () => {
    const now = Date.now();
    const sessions = new Map([
      [101, {
        SessionID: 101,
        TableID: 1,
        TableName: 'Bàn T1-01',
        BranchID: 1,
        RestaurantID: 1,
        Status: SESSION_STATUS.WAITING_OPEN,
        GuestCount: 2,
        CreatedAt: new Date(now - 299 * 1000), // 4 phút 59 giây -> chưa đóng
        StartTime: new Date(now - 299 * 1000),
        EndTime: null,
      }],
      [102, {
        SessionID: 102,
        TableID: 2,
        TableName: 'Bàn T1-02',
        BranchID: 1,
        RestaurantID: 1,
        Status: SESSION_STATUS.WAITING_OPEN,
        GuestCount: 4,
        CreatedAt: new Date(now - 305 * 1000), // 5 phút 5 giây -> tự động đóng
        StartTime: new Date(now - 305 * 1000),
        EndTime: null,
      }],
    ]);
    const cancelledOrders = [];
    const clearedSupport = [];
    const recordedLogs = [];

    const mockSessionModel = {
      async findExpiredWaitingSessions(timeoutSec) {
        const current = Date.now();
        return [...sessions.values()]
          .filter((s) => s.Status === SESSION_STATUS.WAITING_OPEN && ((current - s.CreatedAt.getTime()) / 1000) >= timeoutSec)
          .map((s) => ({
            ...s,
            ElapsedSeconds: Math.floor((current - s.CreatedAt.getTime()) / 1000),
          }));
      },
      async autoCloseWaitingSessionById(sessionId) {
        const s = sessions.get(sessionId);
        if (!s || s.Status !== SESSION_STATUS.WAITING_OPEN) return 0;
        s.Status = SESSION_STATUS.CLOSED;
        s.EndTime = new Date();
        return 1;
      },
      async clearSupportRequest(sessionId) {
        clearedSupport.push(sessionId);
        return 0;
      },
    };

    const mockOrderModel = {
      async updateAllOrdersStatusInSession(sessionId, status) {
        cancelledOrders.push({ sessionId, status });
        return 1;
      },
    };

    const mockActivityLog = {
      async logSystemAction(payload) {
        recordedLogs.push(payload);
        return recordedLogs.length;
      },
    };

    const deps = {
      sessionModel: mockSessionModel,
      orderModel: mockOrderModel,
      activityLog: mockActivityLog,
      timeoutSeconds: 300,
    };

    const closedFirst = await sessionService.closeExpiredWaitingSessions({ deps });
    const closedSecond = await sessionService.closeExpiredWaitingSessions({ deps });

    assert.equal(closedFirst.length, 1);
    assert.equal(closedFirst[0].SessionID, 102);
    assert.equal(closedSecond.length, 0);

    // Bàn 101 (< 5 phút) vẫn WAITING_OPEN, bàn 102 (>= 5 phút) đã CLOSED
    assert.equal(sessions.get(101).Status, SESSION_STATUS.WAITING_OPEN);
    assert.equal(sessions.get(102).Status, SESSION_STATUS.CLOSED);
    assert.ok(sessions.get(102).EndTime instanceof Date);

    assert.deepEqual(cancelledOrders, [{ sessionId: 102, status: ORDER_STATUS.CANCELLED }]);
    assert.deepEqual(clearedSupport, [102]);

    assert.equal(recordedLogs.length, 1);
    assert.equal(recordedLogs[0].action, 'SESSION_AUTO_CLOSE_TIMEOUT');
    assert.equal(recordedLogs[0].entityType, 'Session');
    assert.equal(recordedLogs[0].entityId, 102);
    assert.equal(recordedLogs[0].severity, LOG_SEVERITY.WARNING);
    assert.equal(recordedLogs[0].oldValue.status, SESSION_STATUS.WAITING_OPEN);
    assert.equal(recordedLogs[0].newValue.status, SESSION_STATUS.CLOSED);
    assert.equal(recordedLogs[0].newValue.closeReason, 'AUTO_CLOSE_TIMEOUT');
    assert.equal(recordedLogs[0].newValue.timeoutMinutes, 5);
  });

  it('5. Thanh toán VNPay / SePay thành công ghi nhận Audit Log và không ghi log nếu DB rollback', async () => {
    const recorded = [];
    const logger = {
      async logSystemAction(payload) {
        recorded.push({ kind: 'System', ...payload });
      },
      async logStaffAction(user, payload) {
        recorded.push({ kind: user.roleCode, ...payload });
      },
    };

    const makeMockDeps = (failComplete) => {
      const state = {
        paymentStatus: PAYMENT_STATUS.PENDING,
        sessionStatus: SESSION_STATUS.OPEN,
      };
      return {
        pool: {
          async getConnection() {
            return {
              async beginTransaction() {},
              async commit() {},
              async rollback() {},
              release() {},
            };
          },
        },
        paymentModel: {
          async findPaymentByTxnRef() {
            return {
              PaymentID: 200,
              InvoiceID: 100,
              BranchID: 1,
              Amount: '250000.00',
              AmountVnp: '25000000',
              VnpTxnRef: 'BBQ200',
              PaymentStatus: state.paymentStatus,
              InvoiceNumber: 'INV-20261128-000200',
              SessionID: 10,
            };
          },
          async completePayment(_id, status) {
            if (failComplete) throw new Error('DB failure');
            state.paymentStatus = status;
            return 1;
          },
        },
        sessionModel: {
          async updateSessionStatus(_sid, status) {
            state.sessionStatus = status;
            return 1;
          },
        },
        activityLog: logger,
      };
    };

    await assert.rejects(
      () => paymentService.handleSepayWebhook('', { transferType: 'in', content: 'BBQ200', transferAmount: 250000 }, makeMockDeps(true)),
      /DB failure/
    );
    assert.equal(recorded.length, 0);

    const okRes = await paymentService.handleSepayWebhook('', { transferType: 'in', content: 'BBQ200', transferAmount: 250000 }, makeMockDeps(false));
    assert.equal(okRes.success, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].action, 'SEPAY_WEBHOOK_PAID');
    assert.equal(recorded[0].severity, LOG_SEVERITY.CRITICAL);
  });
});
