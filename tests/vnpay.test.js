'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Thiết lập biến môi trường test Sandbox mẫu (không phải secret thật)
process.env.NODE_ENV = 'test';
process.env.VNP_TMN_CODE = 'TESTTMN01';
process.env.VNP_HASH_SECRET = 'TEST_SANDBOX_SECRET_KEY_32_CHARS_MINIMUM';
process.env.VNP_URL = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
process.env.VNP_API_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';
process.env.VNP_RETURN_URL = 'http://localhost:3000/api/payments/vnpay/return';
process.env.VNP_FRONTEND_RETURN_URL = 'http://localhost:5173/customer/payment-result';
process.env.VNP_PENDING_TIMEOUT_MINUTES = '15';

const vnpayService = require('../src/services/vnpay.service');
const paymentService = require('../src/services/payment.service');
const { createRateLimiter } = require('../src/middlewares/rateLimitMiddleware');
const {
  PAYMENT_STATUS,
  PAYMENT_METHOD,
  VNPAY_TX_STATUS,
  SESSION_STATUS,
} = require('../src/constants/status');

const signParams = (params, secret = process.env.VNP_HASH_SECRET) => {
  const sorted = vnpayService.sortObject(params);
  const signData = Object.keys(sorted)
    .map((k) => `${k}=${sorted[k]}`)
    .join('&');
  return vnpayService.signHmacSha512(signData, secret);
};

// In-memory transactional store mô phỏng MySQL InnoDB + Row Lock (FOR UPDATE)
const createMockDb = ({ failOnCompletePayment = false } = {}) => {
  const state = {
    sessions: new Map([[10, { SessionID: 10, Status: SESSION_STATUS.OPEN, SessionToken: 'tok-valid-10' }]]),
    invoices: new Map([[100, { InvoiceID: 100, SessionID: 10, InvoiceNumber: 'INV-20261121-000100', TotalAmount: '350000.00' }]]),
    payments: new Map([[200, { PaymentID: 200, InvoiceID: 100, Amount: '350000.00', PaymentMethod: 'VNPAY', Status: PAYMENT_STATUS.PENDING, TransactionNo: null, PaidAt: null }]]),
    transactions: new Map([
      ['VNP200_TX1', {
        PaymentTransactionID: 1,
        PaymentID: 200,
        InvoiceID: 100,
        VnpTxnRef: 'VNP200_TX1',
        Amount: '350000.00',
        AmountVnp: '35000000',
        Status: VNPAY_TX_STATUS.PENDING,
        VnpTransactionNo: null,
        NeedReconcile: 0,
        ReconcileNote: null,
        CreatedAt: new Date(),
      }],
      ['VNP200_TX2', {
        PaymentTransactionID: 2,
        PaymentID: 200,
        InvoiceID: 100,
        VnpTxnRef: 'VNP200_TX2',
        Amount: '350000.00',
        AmountVnp: '35000000',
        Status: VNPAY_TX_STATUS.PENDING,
        VnpTransactionNo: null,
        NeedReconcile: 0,
        ReconcileNote: null,
        CreatedAt: new Date(),
      }],
    ]),
    paidCount: 0,
  };

  let lockPromise = Promise.resolve();

  const mockPool = {
    async getConnection() {
      let releaseLock = null;
      let workingSnapshot = null;

      return {
        async beginTransaction() {
          const prev = lockPromise;
          let nextResolve;
          lockPromise = new Promise((r) => { nextResolve = r; });
          await prev;
          releaseLock = nextResolve;

          // Snapshot để rollback chính xác nếu có lỗi DB
          workingSnapshot = {
            sessions: new Map([...state.sessions].map(([k, v]) => [k, { ...v }])),
            payments: new Map([...state.payments].map(([k, v]) => [k, { ...v }])),
            transactions: new Map([...state.transactions].map(([k, v]) => [k, { ...v }])),
            paidCount: state.paidCount,
          };
        },
        async commit() {
          workingSnapshot = null;
        },
        async rollback() {
          if (workingSnapshot) {
            state.sessions = workingSnapshot.sessions;
            state.payments = workingSnapshot.payments;
            state.transactions = workingSnapshot.transactions;
            state.paidCount = workingSnapshot.paidCount;
            workingSnapshot = null;
          }
        },
        release() {
          if (releaseLock) {
            releaseLock();
            releaseLock = null;
          }
        },
      };
    },
  };

  const mockPaymentModel = {
    async findTransactionWithLockByTxnRef(txnRef) {
      const tx = state.transactions.get(txnRef);
      if (!tx) return null;
      const payment = state.payments.get(tx.PaymentID);
      const invoice = state.invoices.get(tx.InvoiceID);
      const session = state.sessions.get(invoice.SessionID);
      return {
        ...tx,
        PaymentStatus: payment.Status,
        PaymentMethod: payment.PaymentMethod,
        InvoiceNumber: invoice.InvoiceNumber,
        SessionID: invoice.SessionID,
        SessionStatus: session.Status,
      };
    },
    async updatePaymentTransactionResult(txId, data) {
      for (const tx of state.transactions.values()) {
        if (tx.PaymentTransactionID === txId) {
          tx.Status = data.status;
          tx.VnpTransactionNo = data.vnpTransactionNo || tx.VnpTransactionNo;
          tx.VnpBankCode = data.vnpBankCode || null;
          tx.VnpResponseCode = data.vnpResponseCode || null;
          tx.NeedReconcile = data.needReconcile ? 1 : 0;
          tx.ReconcileNote = data.reconcileNote || null;
          tx.ProcessedAt = new Date();
          return 1;
        }
      }
      return 0;
    },
    async markPaymentFailedIfPending(paymentId) {
      const p = state.payments.get(paymentId);
      if (p && p.Status === PAYMENT_STATUS.PENDING) {
        p.Status = PAYMENT_STATUS.FAILED;
        return 1;
      }
      return 0;
    },
    async completePayment(paymentId, status, transactionNo, paymentMethod) {
      if (failOnCompletePayment) {
        throw new Error('Simulated DB write failure during completePayment');
      }
      const p = state.payments.get(paymentId);
      p.Status = status;
      p.TransactionNo = transactionNo;
      p.PaymentMethod = paymentMethod;
      p.PaidAt = new Date();
      state.paidCount += 1;
      return 1;
    },
  };

  const mockSessionModel = {
    async updateSessionStatus(sessionId, status) {
      const s = state.sessions.get(sessionId);
      s.Status = status;
      return 1;
    },
  };

  return { state, mockPool, mockPaymentModel, mockSessionModel };
};

describe('VNPay Sandbox Integration & Security Tests (20 Scenarios)', () => {
  it('1. Tính toán và đối chiếu số tiền bằng số nguyên BigInt (không dùng float) & ký HMAC-SHA512 chuẩn 2.1.0', () => {
    const amountVnp = vnpayService.parseAmountToVnpInt('350000.00');
    assert.equal(amountVnp, 35000000n);
    assert.equal(vnpayService.parseVnpInteger('35000000'), 35000000n);
    assert.equal(vnpayService.parseVnpInteger('350000.50'), null);

    const url = vnpayService.buildPaymentUrl({
      txnRef: 'VNP200_TX1',
      amountVnp,
      orderInfo: 'Thanh toan hoa don INV-001',
      ipAddr: '::1',
    });
    assert.ok(url.startsWith('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?'));
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('vnp_Amount'), '35000000');
    assert.equal(parsed.searchParams.get('vnp_IpAddr'), '127.0.0.1');
    assert.ok(parsed.searchParams.get('vnp_SecureHash'));

    // Kiểm tra verifySignature thành công và phát hiện bị sửa tham số
    const paramsObj = Object.fromEntries(parsed.searchParams.entries());
    assert.equal(vnpayService.verifySignature(paramsObj), true);
    assert.equal(vnpayService.verifySignature({ ...paramsObj, vnp_Amount: '100' }), false);
  });

  it('2. Không ghi thông tin bí mật / OTP / CVV / sessionToken vào log', () => {
    const sanitized = vnpayService.sanitizeLogPayload({
      vnp_TxnRef: 'VNP200_TX1',
      vnp_SecureHash: 'abc123secret',
      vnp_HashSecret: 'my_secret',
      sessionToken: 'uuid-token',
      cvv: '123',
      otp: '999999',
    });
    assert.equal(sanitized.vnp_TxnRef, 'VNP200_TX1');
    assert.equal(sanitized.vnp_SecureHash, '[REDACTED]');
    assert.equal(sanitized.vnp_HashSecret, '[REDACTED]');
    assert.equal(sanitized.sessionToken, '[REDACTED]');
    assert.equal(sanitized.cvv, '[REDACTED]');
    assert.equal(sanitized.otp, '[REDACTED]');
  });

  it('3. Thanh toán VNPay thành công (IPN hợp lệ -> Payment PAID, Session CLOSED)', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const res = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '14567890',
      vnp_BankCode: 'NCB',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });

    assert.equal(res.RspCode, '00');
    assert.equal(state.transactions.get('VNP200_TX1').Status, VNPAY_TX_STATUS.SUCCESS);
    assert.equal(state.payments.get(200).Status, PAYMENT_STATUS.PAID);
    assert.equal(state.sessions.get(10).Status, SESSION_STATUS.CLOSED);
    assert.equal(state.paidCount, 1);
  });

  it('4. Khách hàng hủy thanh toán (vnp_ResponseCode=24 -> CANCELLED, không đóng Session)', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const res = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '24',
      vnp_TransactionStatus: '02',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });

    assert.equal(res.RspCode, '00');
    assert.equal(state.transactions.get('VNP200_TX1').Status, VNPAY_TX_STATUS.CANCELLED);
    assert.equal(state.payments.get(200).Status, PAYMENT_STATUS.FAILED);
    assert.equal(state.sessions.get(10).Status, SESSION_STATUS.OPEN);
  });

  it('5. Thanh toán thất bại (mã lỗi 51 -> FAILED, không đóng Session)', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const res = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '51',
      vnp_TransactionStatus: '02',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });

    assert.equal(res.RspCode, '00');
    assert.equal(state.transactions.get('VNP200_TX1').Status, VNPAY_TX_STATUS.FAILED);
    assert.equal(state.sessions.get(10).Status, SESSION_STATUS.OPEN);
  });

  it('6. Chữ ký IPN không hợp lệ -> trả RspCode 97', async () => {
    const params = {
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_SecureHash: 'invalid_hash_value',
    };
    const res = await paymentService.handleVnpayIpn(params);
    assert.equal(res.RspCode, '97');
  });

  it('7. Mã giao dịch không tồn tại -> trả RspCode 01', async () => {
    const { mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const res = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'NON_EXISTENT_REF',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });
    assert.equal(res.RspCode, '01');
  });

  it('8. Số tiền không khớp -> trả RspCode 04', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const res = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '10000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });
    assert.equal(res.RspCode, '04');
    assert.equal(state.payments.get(200).Status, PAYMENT_STATUS.PENDING);
  });

  it('9. IPN gửi lặp lại nhiều lần -> Idempotent (RspCode 02), không ghi trùng doanh thu', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const payload = {
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '14567890',
    };
    const first = await paymentService.processVnpayResultInTransaction(payload, 'IPN', {
      pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel,
    });
    const second = await paymentService.processVnpayResultInTransaction(payload, 'IPN', {
      pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel,
    });
    assert.equal(first.RspCode, '00');
    assert.equal(second.RspCode, '02');
    assert.equal(state.paidCount, 1);
  });

  it('10. IPN giao dịch cũ đến sau khi giao dịch mới được tạo & hai giao dịch cùng báo thành công cho 1 Invoice', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    // Giao dịch mới TX2 thành công trước
    const resTx2 = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX2',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: 'VNP_NEW_2',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });
    assert.equal(resTx2.RspCode, '00');
    assert.equal(state.transactions.get('VNP200_TX2').Status, VNPAY_TX_STATUS.SUCCESS);

    // IPN của giao dịch cũ TX1 đến trễ và cũng báo thành công (00/00)
    const resTx1 = await paymentService.processVnpayResultInTransaction({
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: 'VNP_OLD_1',
    }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel });

    assert.equal(resTx1.RspCode, '00');
    assert.equal(state.transactions.get('VNP200_TX1').Status, VNPAY_TX_STATUS.DUPLICATE_CONFLICT);
    assert.equal(state.transactions.get('VNP200_TX1').NeedReconcile, 1);
    assert.equal(state.paidCount, 1); // Chỉ ghi nhận doanh thu đúng 1 lần!
  });

  it('11. IPN gửi đồng thời nhiều request -> chỉ 1 request chốt thành công, request còn lại trả 02', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb();
    const payload = {
      vnp_TmnCode: 'TESTTMN01',
      vnp_TxnRef: 'VNP200_TX1',
      vnp_Amount: '35000000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: 'CONCURRENT_1',
    };

    const results = await Promise.all([
      paymentService.processVnpayResultInTransaction(payload, 'IPN', {
        pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel,
      }),
      paymentService.processVnpayResultInTransaction(payload, 'IPN', {
        pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel,
      }),
      paymentService.processVnpayResultInTransaction(payload, 'IPN', {
        pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel,
      }),
    ]);

    const codes = results.map((r) => r.RspCode).sort();
    assert.deepEqual(codes, ['00', '02', '02']);
    assert.equal(state.paidCount, 1);
  });

  it('12. Thanh toán thành công nhưng cập nhật DB gặp lỗi -> Rollback toàn bộ Transaction', async () => {
    const { state, mockPool, mockPaymentModel, mockSessionModel } = createMockDb({ failOnCompletePayment: true });
    await assert.rejects(
      () => paymentService.processVnpayResultInTransaction({
        vnp_TmnCode: 'TESTTMN01',
        vnp_TxnRef: 'VNP200_TX1',
        vnp_Amount: '35000000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      }, 'IPN', { pool: mockPool, paymentModel: mockPaymentModel, sessionModel: mockSessionModel }),
      /Simulated DB write failure/
    );

    // Đảm bảo rollback hoàn toàn về trạng thái PENDING ban đầu
    assert.equal(state.transactions.get('VNP200_TX1').Status, VNPAY_TX_STATUS.PENDING);
    assert.equal(state.payments.get(200).Status, PAYMENT_STATUS.PENDING);
    assert.equal(state.sessions.get(10).Status, SESSION_STATUS.OPEN);
  });

  it('13. Rate limiter chặn khách hàng bấm tạo thanh toán liên tục', () => {
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 2 });
    const req = { ip: '1.2.3.4', body: { sessionToken: 'tok-1' }, headers: {} };
    let statusCalled = null;
    const res = {
      status(code) { statusCalled = code; return this; },
      json() { return this; },
    };

    let nextCount = 0;
    limiter(req, res, () => { nextCount += 1; });
    limiter(req, res, () => { nextCount += 1; });
    limiter(req, res, () => { nextCount += 1; });

    assert.equal(nextCount, 2);
    assert.equal(statusCalled, 429);
  });

  it('14. Chặn thu ngân tự ý đánh dấu VNPAY thành PAID thủ công', async () => {
    const paymentModel = require('../src/models/payment.model');
    const originalFind = paymentModel.findPaymentWithInvoice;
    paymentModel.findPaymentWithInvoice = async () => ({
      PaymentID: 200,
      BranchID: 1,
      Status: PAYMENT_STATUS.PENDING,
      SessionID: 10,
    });
    try {
      await assert.rejects(
        () => paymentService.completePayment(200, { roleCode: 'Cashier', branchId: 1 }, PAYMENT_METHOD.VNPAY),
        (err) => err.statusCode === 400
      );
    } finally {
      paymentModel.findPaymentWithInvoice = originalFind;
    }
  });

  it('15. Return URL chỉ đọc trạng thái để hiển thị, không tự chốt PAID khi IPN chưa đến', async () => {
    const paymentModel = require('../src/models/payment.model');
    const originalFind = paymentModel.findTransactionWithLockByTxnRef;
    paymentModel.findTransactionWithLockByTxnRef = async () => ({
      VnpTxnRef: 'VNP200_TX1',
      Status: VNPAY_TX_STATUS.PENDING,
      PaymentStatus: PAYMENT_STATUS.PENDING,
      PaymentID: 200,
      InvoiceNumber: 'INV-20261121-000100',
      TableName: 'Bàn VIP-01',
      Amount: '350000.00',
    });

    try {
      const baseParams = {
        vnp_TmnCode: 'TESTTMN01',
        vnp_TxnRef: 'VNP200_TX1',
        vnp_Amount: '35000000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      };
      const secureHash = signParams(baseParams);
      const res = await paymentService.handleVnpayReturn({ ...baseParams, vnp_SecureHash: secureHash });
      assert.equal(res.signatureValid, true);
      assert.equal(res.status, VNPAY_TX_STATUS.PENDING);
      assert.equal(res.paymentStatus, PAYMENT_STATUS.PENDING);
    } finally {
      paymentModel.findTransactionWithLockByTxnRef = originalFind;
    }
  });
});
