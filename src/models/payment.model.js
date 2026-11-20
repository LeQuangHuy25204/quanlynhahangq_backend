'use strict';

const { pool } = require('../config/db');

/**
 * Lấy cấu hình thuế và phí phục vụ của chi nhánh dựa trên SessionID.
 */
const getBranchConfigBySessionId = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT b.VATRate, b.ServiceFeeRate, b.BranchID
     FROM session s
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE s.SessionID = ?`,
    [sessionId]
  );
  return rows[0] || null;
};

/**
 * Tạo bản ghi Payment mới (thường là PENDING).
 */
const createPayment = async ({ invoiceId, amount, paymentMethod, status, note }, conn = pool) => {
  const [result] = await conn.execute(
    `INSERT INTO payment (InvoiceID, Amount, PaymentMethod, Status, Note)
     VALUES (?, ?, ?, ?, ?)`,
    [invoiceId, amount, paymentMethod || 'CASH', status, note || null]
  );
  return result.insertId;
};

/**
 * Tạo Invoice.
 * InvoiceNumber tự sinh pattern: INV-{YYYYMMDD}-{random 6 hex}
 */
const createInvoice = async ({ sessionId, branchId, promotionId, subTotal, vatAmount, serviceFeeAmount, discountAmount, totalAmount }, conn = pool) => {
  const vnDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const dateStr = vnDate.replace(/-/g, '');
  const random = Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
  const invoiceNumber = `INV-${dateStr}-${random}`;

  const [result] = await conn.execute(
    `INSERT INTO invoice (SessionID, BranchID, PromotionID, InvoiceNumber, SubTotal, VATAmount, ServiceFeeAmount, DiscountAmount, TotalAmount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, branchId, promotionId || null, invoiceNumber, subTotal, vatAmount, serviceFeeAmount, discountAmount, totalAmount]
  );
  return { invoiceId: result.insertId, invoiceNumber };
};

/**
 * Tạo InvoiceLines (Snapshot)
 */
const createInvoiceLines = async (invoiceId, lines, conn = pool) => {
  if (!lines || lines.length === 0) return;
  const placeholders = lines.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const values = lines.flatMap(line => [
    invoiceId, line.OrderLineID, line.MenuItemName, line.Quantity, line.UnitPrice, line.Quantity * line.UnitPrice
  ]);
  await conn.execute(
    `INSERT INTO invoiceline (InvoiceID, OrderLineID, ItemNameSnapshot, Quantity, UnitPrice, Amount)
     VALUES ${placeholders}`,
    values
  );
};

/**
 * Cập nhật trạng thái Payment khi đã thu tiền thành công.
 */
const completePayment = async (paymentId, status, transactionNo = null, paymentMethod = 'CASH', conn = pool) => {
  const [result] = await conn.execute(
    `UPDATE payment SET Status = ?, PaidAt = NOW(), TransactionNo = ?, PaymentMethod = ? WHERE PaymentID = ?`,
    [status, transactionNo, paymentMethod, paymentId]
  );
  return result.affectedRows;
};

/**
 * Cập nhật trạng thái Payment khi giao dịch VNPay thất bại (chỉ khi hiện đang PENDING).
 */
const markPaymentFailedIfPending = async (paymentId, conn = pool) => {
  const [result] = await conn.execute(
    `UPDATE payment SET Status = 2 WHERE PaymentID = ? AND Status = 0`,
    [paymentId]
  );
  return result.affectedRows;
};

/**
 * Tìm tất cả OrderLine hợp lệ (chưa hủy) của một Session.
 */
const findValidOrderLinesBySessionId = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT ol.OrderLineID, ol.MenuItemID, mi.CategoryID, mi.Name AS MenuItemName, ol.PromotionID,
            ol.Quantity, ol.UnitPrice, ol.LineTotal, ol.Note, ol.Status, ol.DiscountApplied
     FROM orderline ol
     INNER JOIN \`order\` o ON ol.OrderID = o.OrderID
     INNER JOIN menuitem mi ON ol.MenuItemID = mi.MenuItemID
     WHERE o.SessionID = ? AND ol.Status != 3 AND o.Status != 2`,
    [sessionId]
  );
  return rows;
};

/**
 * Tìm hóa đơn đã tạo cho một Session (mỗi Session chỉ có 1 hóa đơn — UQ_Invoice_SessionID).
 */
const findInvoiceBySessionId = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT i.InvoiceID, i.InvoiceNumber, p.PaymentID, p.Status AS PaymentStatus
     FROM invoice i
     LEFT JOIN payment p ON p.InvoiceID = i.InvoiceID
     WHERE i.SessionID = ?
     LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
};

/**
 * Chi tiết hóa đơn theo PaymentID (kèm chi nhánh, bàn, khu vực) — dùng để in hóa đơn.
 */
const findInvoiceDetailByPaymentId = async (paymentId) => {
  const [rows] = await pool.execute(
    `SELECT p.PaymentID, p.PaymentMethod, p.Status AS PaymentStatus, p.PaidAt, p.TransactionNo,
            i.InvoiceID, i.InvoiceNumber, i.InvoiceDate, i.SessionID, i.BranchID,
            i.SubTotal, i.VATAmount, i.ServiceFeeAmount, i.DiscountAmount, i.TotalAmount,
            b.Name AS BranchName, b.Address AS BranchAddress, b.Phone AS BranchPhone,
            b.VATRate, b.ServiceFeeRate,
            t.Name AS TableName, a.Name AS AreaName,
            s.GuestCount, s.StartTime AS SessionStartTime, s.EndTime AS SessionEndTime,
            pr.Name AS PromotionName
     FROM payment p
     INNER JOIN invoice i ON p.InvoiceID = i.InvoiceID
     INNER JOIN branch b  ON i.BranchID  = b.BranchID
     LEFT JOIN session s ON i.SessionID = s.SessionID
     LEFT JOIN \`table\` t ON s.TableID = t.TableID
     LEFT JOIN area a    ON t.AreaID    = a.AreaID
     LEFT JOIN promotion pr ON i.PromotionID = pr.PromotionID
     WHERE p.PaymentID = ?`,
    [paymentId]
  );
  return rows[0] || null;
};

const findInvoiceLines = async (invoiceId) => {
  const [rows] = await pool.execute(
    `SELECT il.InvoiceLineID, il.OrderLineID, il.ItemNameSnapshot AS MenuItemName,
            il.Quantity, il.UnitPrice, il.Amount,
            COALESCE(mi.Unit, 'Phần') AS Unit,
            ol.Note,
            COALESCE(ol.DiscountApplied, 0) AS DiscountApplied
     FROM invoiceline il
     LEFT JOIN orderline ol ON il.OrderLineID = ol.OrderLineID
     LEFT JOIN menuitem mi  ON ol.MenuItemID  = mi.MenuItemID
     WHERE il.InvoiceID = ?
     ORDER BY il.InvoiceLineID ASC`,
    [invoiceId]
  );
  return rows;
};

/**
 * Tìm Payment kèm Invoice.
 */
const findPaymentWithInvoice = async (paymentId, conn = pool) => {
  const [rows] = await conn.execute(
    `SELECT p.*, i.InvoiceNumber, i.SubTotal, i.VATAmount, i.ServiceFeeAmount, i.DiscountAmount, i.TotalAmount, i.SessionID, i.BranchID
     FROM payment p
     INNER JOIN invoice i ON p.InvoiceID = i.InvoiceID
     WHERE p.PaymentID = ?`,
    [paymentId]
  );
  return rows[0] || null;
};

/**
 * Tạo bản ghi PaymentTransaction mới (không bao giờ ghi đè lịch sử giao dịch cũ).
 */
const createPaymentTransaction = async ({
  paymentId,
  invoiceId,
  provider = 'VNPAY',
  vnpTxnRef,
  amount,
  amountVnp,
  status = 'PENDING',
  vnpOrderInfo = null,
  ipAddress = null,
}, conn = pool) => {
  const [result] = await conn.execute(
    `INSERT INTO paymenttransaction
       (PaymentID, InvoiceID, Provider, VnpTxnRef, Amount, AmountVnp, Status, VnpOrderInfo, IpAddress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [paymentId, invoiceId, provider, vnpTxnRef, amount, String(amountVnp), status, vnpOrderInfo, ipAddress]
  );
  return result.insertId;
};

/**
 * Tìm PaymentTransaction theo VnpTxnRef kèm Payment, Invoice, Session (hỗ trợ FOR UPDATE trong Transaction).
 */
const findTransactionWithLockByTxnRef = async (vnpTxnRef, { forUpdate = false } = {}, conn = pool) => {
  const lockClause = forUpdate ? 'FOR UPDATE' : '';
  const [rows] = await conn.execute(
    `SELECT pt.*,
            p.Status AS PaymentStatus, p.PaymentMethod, p.Amount AS PaymentAmount, p.TransactionNo AS PaymentTransactionNo, p.PaidAt AS PaymentPaidAt,
            i.InvoiceNumber, i.SessionID, i.BranchID, i.TotalAmount AS InvoiceTotalAmount,
            s.SessionToken, s.Status AS SessionStatus,
            t.Name AS TableName, a.Name AS AreaName
     FROM paymenttransaction pt
     INNER JOIN payment p ON pt.PaymentID = p.PaymentID
     INNER JOIN invoice i ON pt.InvoiceID = i.InvoiceID
     INNER JOIN session s ON i.SessionID = s.SessionID
     LEFT JOIN \`table\` t ON s.TableID = t.TableID
     LEFT JOIN area a ON t.AreaID = a.AreaID
     WHERE pt.VnpTxnRef = ?
     ${lockClause}`,
    [vnpTxnRef]
  );
  return rows[0] || null;
};

/**
 * Cập nhật kết quả xử lý PaymentTransaction (IPN hoặc QueryDR).
 */
const updatePaymentTransactionResult = async (paymentTransactionId, {
  status,
  vnpTransactionNo = null,
  vnpBankCode = null,
  vnpBankTranNo = null,
  vnpCardType = null,
  vnpResponseCode = null,
  vnpTransactionStatus = null,
  vnpPayDate = null,
  needReconcile = 0,
  reconcileNote = null,
  rawIpnPayload = null,
  setIpnReceivedAt = true,
}, conn = pool) => {
  const ipnTimeExpr = setIpnReceivedAt ? 'COALESCE(IpnReceivedAt, NOW())' : 'IpnReceivedAt';
  const [result] = await conn.execute(
    `UPDATE paymenttransaction
     SET Status = ?,
         VnpTransactionNo = COALESCE(?, VnpTransactionNo),
         VnpBankCode = COALESCE(?, VnpBankCode),
         VnpBankTranNo = COALESCE(?, VnpBankTranNo),
         VnpCardType = COALESCE(?, VnpCardType),
         VnpResponseCode = COALESCE(?, VnpResponseCode),
         VnpTransactionStatus = COALESCE(?, VnpTransactionStatus),
         VnpPayDate = COALESCE(?, VnpPayDate),
         NeedReconcile = ?,
         ReconcileNote = COALESCE(?, ReconcileNote),
         RawIpnPayload = COALESCE(?, RawIpnPayload),
         IpnReceivedAt = ${ipnTimeExpr},
         ProcessedAt = NOW()
     WHERE PaymentTransactionID = ?`,
    [
      status,
      vnpTransactionNo,
      vnpBankCode,
      vnpBankTranNo,
      vnpCardType,
      vnpResponseCode,
      vnpTransactionStatus,
      vnpPayDate,
      needReconcile ? 1 : 0,
      reconcileNote,
      rawIpnPayload,
      paymentTransactionId,
    ]
  );
  return result.affectedRows;
};

/**
 * Cập nhật thời điểm gọi querydr gần nhất.
 */
const updateTransactionLastQueryAt = async (paymentTransactionId, conn = pool) => {
  await conn.execute(
    `UPDATE paymenttransaction SET LastQueryAt = NOW() WHERE PaymentTransactionID = ?`,
    [paymentTransactionId]
  );
};

/**
 * Lấy danh sách PaymentTransaction (lịch sử giao dịch VNPay) theo InvoiceID hoặc bộ lọc chi nhánh/trạng thái.
 */
const findVnpayTransactions = async ({ invoiceId = null, branchId = null, status = null, needReconcile = null } = {}) => {
  let sql = `
    SELECT pt.PaymentTransactionID, pt.PaymentID, pt.InvoiceID, pt.Provider, pt.VnpTxnRef,
           pt.Amount, pt.AmountVnp, pt.Status, pt.VnpTransactionNo, pt.VnpBankCode,
           pt.VnpCardType, pt.VnpResponseCode, pt.VnpTransactionStatus, pt.VnpPayDate,
           pt.NeedReconcile, pt.ReconcileNote, pt.IpnReceivedAt, pt.ProcessedAt, pt.LastQueryAt, pt.CreatedAt,
           p.Status AS PaymentStatus, p.PaymentMethod,
           i.InvoiceNumber, i.SessionID, i.BranchID,
           t.Name AS TableName, a.Name AS AreaName
    FROM paymenttransaction pt
    INNER JOIN payment p ON pt.PaymentID = p.PaymentID
    INNER JOIN invoice i ON pt.InvoiceID = i.InvoiceID
    LEFT JOIN session s ON i.SessionID = s.SessionID
    LEFT JOIN \`table\` t ON s.TableID = t.TableID
    LEFT JOIN area a ON t.AreaID = a.AreaID
    WHERE 1 = 1
  `;
  const params = [];

  if (invoiceId) {
    sql += ' AND pt.InvoiceID = ?';
    params.push(invoiceId);
  }
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  if (status) {
    sql += ' AND pt.Status = ?';
    params.push(status);
  }
  if (needReconcile !== null && needReconcile !== undefined && needReconcile !== '') {
    sql += ' AND pt.NeedReconcile = ?';
    params.push(Number(needReconcile) ? 1 : 0);
  }

  sql += ' ORDER BY pt.PaymentTransactionID DESC LIMIT 100';
  const [rows] = await pool.execute(sql, params);
  return rows;
};

module.exports = {
  getBranchConfigBySessionId,
  createPayment,
  createInvoice,
  createInvoiceLines,
  findValidOrderLinesBySessionId,
  findInvoiceBySessionId,
  findInvoiceDetailByPaymentId,
  findInvoiceLines,
  completePayment,
  markPaymentFailedIfPending,
  findPaymentWithInvoice,
  createPaymentTransaction,
  findTransactionWithLockByTxnRef,
  updatePaymentTransactionResult,
  updateTransactionLastQueryAt,
  findVnpayTransactions,
};
