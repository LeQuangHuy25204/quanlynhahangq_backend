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
const createPayment = async ({ invoiceId, amount, paymentMethod, status, transactionNo = null, note = null }, conn = pool) => {
  const [result] = await conn.execute(
    `INSERT INTO payment (InvoiceID, Amount, PaymentMethod, Status, TransactionNo, Note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [invoiceId, amount, paymentMethod || 'CASH', status, transactionNo, note]
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
 * Lưu mã giao dịch cổng thanh toán (MoMo / VNPay) trực tiếp vào bảng payment gốc (cột TransactionNo, Note).
 */
const saveGatewayTransactionToPayment = async ({
  paymentId,
  provider = 'MOMO',
  txnRef,
  orderInfo = null,
}, conn = pool) => {
  const noteText = orderInfo
    ? `[REF:${txnRef}] ${orderInfo}`.slice(0, 500)
    : `[REF:${txnRef}]`;
  const [result] = await conn.execute(
    `UPDATE payment
     SET PaymentMethod = ?,
         Status = 0,
         TransactionNo = ?,
         Note = ?
     WHERE PaymentID = ?`,
    [provider, txnRef, noteText, paymentId]
  );
  return result.affectedRows;
};

/**
 * Cập nhật trạng thái Payment khi đã thu tiền thành công (lưu trực tiếp TransactionNo và Note vào bảng payment).
 */
const completePayment = async (paymentId, status, transactionNo = null, paymentMethod = 'CASH', note = null, conn = pool) => {
  if (note && typeof note === 'object' && typeof note.execute === 'function') {
    conn = note;
    note = null;
  }
  const safeNote = note ? String(note).slice(0, 500) : null;
  const [result] = await conn.execute(
    `UPDATE payment
     SET Status = ?,
         PaidAt = NOW(),
         TransactionNo = COALESCE(?, TransactionNo),
         PaymentMethod = ?,
         Note = COALESCE(?, Note)
     WHERE PaymentID = ?`,
    [status, transactionNo, paymentMethod, safeNote, paymentId]
  );
  return result.affectedRows;
};

/**
 * Cập nhật trạng thái Payment khi giao dịch cổng thanh toán thất bại (chỉ khi hiện đang PENDING).
 */
const markPaymentFailedIfPending = async (paymentId, note = null, conn = pool) => {
  const safeNote = note ? String(note).slice(0, 500) : null;
  const [result] = await conn.execute(
    `UPDATE payment
     SET Status = 2,
         Note = COALESCE(?, Note)
     WHERE PaymentID = ? AND Status = 0`,
    [safeNote, paymentId]
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
    `SELECT p.PaymentID, p.PaymentMethod, p.Status AS PaymentStatus, p.PaidAt, p.TransactionNo, p.Note,
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
 * Tìm bản ghi Payment theo mã tham chiếu giao dịch (TransactionNo hoặc [REF:...] trong Note).
 * Không cần bảng paymenttransaction — truy vấn trực tiếp trên bảng payment gốc.
 */
const findPaymentByTxnRef = async (txnRef, { forUpdate = false } = {}, conn = pool) => {
  const lockClause = forUpdate ? 'FOR UPDATE' : '';
  const refTagPattern = `%[REF:${txnRef}]%`;
  const idMatch = String(txnRef || '').match(/^(?:BBQ|MOMO|VNP)(\d+)/i);
  const parsedPaymentId = idMatch ? parseInt(idMatch[1], 10) : -1;

  const [rows] = await conn.execute(
    `SELECT p.PaymentID, p.InvoiceID, p.Amount, p.PaymentMethod,
            p.Status AS PaymentStatus, p.PaidAt, p.TransactionNo, p.Note, p.CreatedAt,
            i.InvoiceNumber, i.SessionID, i.BranchID, i.TotalAmount AS InvoiceTotalAmount,
            s.SessionToken, s.Status AS SessionStatus,
            t.Name AS TableName, a.Name AS AreaName
     FROM payment p
     INNER JOIN invoice i ON p.InvoiceID = i.InvoiceID
     INNER JOIN session s ON i.SessionID = s.SessionID
     LEFT JOIN \`table\` t ON s.TableID = t.TableID
     LEFT JOIN area a ON t.AreaID = a.AreaID
     WHERE p.TransactionNo = ? OR p.Note LIKE ? OR p.PaymentID = ?
     ORDER BY p.PaymentID DESC
     LIMIT 1
     ${lockClause}`,
    [txnRef, refTagPattern, parsedPaymentId]
  );

  const row = rows[0];
  if (!row) return null;

  const refMatch = row.Note ? row.Note.match(/\[REF:([^\]]+)\]/) : null;
  const resolvedTxnRef = refMatch ? refMatch[1] : (row.TransactionNo || txnRef);
  const txStatus =
    row.PaymentStatus === 1
      ? 'SUCCESS'
      : row.PaymentStatus === 2
      ? 'FAILED'
      : 'PENDING';

  return {
    ...row,
    PaymentTransactionID: row.PaymentID,
    Provider: row.PaymentMethod,
    VnpTxnRef: resolvedTxnRef,
    AmountVnp: String(Math.round(Number(row.Amount) * 100)),
    Status: txStatus,
    VnpTransactionNo: row.TransactionNo,
    VnpBankCode: row.PaymentMethod === 'MOMO' ? 'MOMO' : row.PaymentMethod,
    VnpOrderInfo: row.Note,
    ProcessedAt: row.PaidAt,
  };
};

/**
 * Lấy danh sách giao dịch trực tuyến trực tiếp từ bảng payment.
 */
const findVnpayTransactions = async ({ invoiceId = null, branchId = null, status = null } = {}) => {
  let sql = `
    SELECT p.PaymentID AS PaymentTransactionID, p.PaymentID, p.InvoiceID,
           p.PaymentMethod AS Provider, p.TransactionNo AS VnpTxnRef,
           p.Amount, p.TransactionNo AS VnpTransactionNo, p.Note AS ReconcileNote,
           p.PaidAt AS ProcessedAt, p.CreatedAt,
           p.Status AS PaymentStatus, p.PaymentMethod,
           CASE
             WHEN p.Status = 1 THEN 'SUCCESS'
             WHEN p.Status = 2 THEN 'FAILED'
             ELSE 'PENDING'
           END AS Status,
           i.InvoiceNumber, i.SessionID, i.BranchID,
           t.Name AS TableName, a.Name AS AreaName
    FROM payment p
    INNER JOIN invoice i ON p.InvoiceID = i.InvoiceID
    LEFT JOIN session s ON i.SessionID = s.SessionID
    LEFT JOIN \`table\` t ON s.TableID = t.TableID
    LEFT JOIN area a ON t.AreaID = a.AreaID
    WHERE p.PaymentMethod IN ('MOMO', 'VNPAY', 'BANK_TRANSFER')
  `;
  const params = [];

  if (invoiceId) {
    sql += ' AND p.InvoiceID = ?';
    params.push(invoiceId);
  }
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  if (status) {
    if (status === 'SUCCESS') sql += ' AND p.Status = 1';
    else if (status === 'FAILED') sql += ' AND p.Status = 2';
    else if (status === 'PENDING') sql += ' AND p.Status = 0';
  }

  sql += ' ORDER BY p.PaymentID DESC LIMIT 100';
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
  saveGatewayTransactionToPayment,
  completePayment,
  markPaymentFailedIfPending,
  findPaymentWithInvoice,
  findPaymentByTxnRef,
  findVnpayTransactions,
};
