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
const createPayment = async ({ invoiceId, amount, paymentMethod, status, note }) => {
  const [result] = await pool.execute(
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
const createInvoice = async ({ sessionId, branchId, promotionId, subTotal, vatAmount, serviceFeeAmount, discountAmount, totalAmount }) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
  const invoiceNumber = `INV-${dateStr}-${random}`;

  const [result] = await pool.execute(
    `INSERT INTO invoice (SessionID, BranchID, PromotionID, InvoiceNumber, SubTotal, VATAmount, ServiceFeeAmount, DiscountAmount, TotalAmount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, branchId, promotionId || null, invoiceNumber, subTotal, vatAmount, serviceFeeAmount, discountAmount, totalAmount]
  );
  return { invoiceId: result.insertId, invoiceNumber };
};

/**
 * Tạo InvoiceLines (Snapshot)
 */
const createInvoiceLines = async (invoiceId, lines) => {
  if (!lines || lines.length === 0) return;
  const placeholders = lines.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const values = lines.flatMap(line => [
    invoiceId, line.OrderLineID, line.MenuItemName, line.Quantity, line.UnitPrice, line.Quantity * line.UnitPrice
  ]);
  await pool.execute(
    `INSERT INTO invoiceline (InvoiceID, OrderLineID, ItemNameSnapshot, Quantity, UnitPrice, Amount)
     VALUES ${placeholders}`,
    values
  );
};

/**
 * Cập nhật trạng thái Payment khi đã thu tiền thành công.
 */
const completePayment = async (paymentId, status, transactionNo = null, paymentMethod = 'CASH') => {
  const [result] = await pool.execute(
    `UPDATE payment SET Status = ?, PaidAt = NOW(), TransactionNo = ?, PaymentMethod = ? WHERE PaymentID = ?`,
    [status, transactionNo, paymentMethod, paymentId]
  );
  return result.affectedRows;
};

/**
 * Tìm tất cả OrderLine hợp lệ (chưa hủy) của một Session.
 */
const findValidOrderLinesBySessionId = async (sessionId) => {
  const [rows] = await pool.execute(
    `SELECT ol.OrderLineID, ol.MenuItemID, mi.Name AS MenuItemName, ol.PromotionID,
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
            pr.Name AS PromotionName
     FROM payment p
     INNER JOIN invoice i ON p.InvoiceID = i.InvoiceID
     INNER JOIN branch b  ON i.BranchID  = b.BranchID
     INNER JOIN session s ON i.SessionID = s.SessionID
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a    ON t.AreaID    = a.AreaID
     LEFT JOIN promotion pr ON i.PromotionID = pr.PromotionID
     WHERE p.PaymentID = ?`,
    [paymentId]
  );
  return rows[0] || null;
};

const findInvoiceLines = async (invoiceId) => {
  const [rows] = await pool.execute(
    `SELECT InvoiceLineID, OrderLineID, ItemNameSnapshot AS MenuItemName, Quantity, UnitPrice, Amount
     FROM invoiceline
     WHERE InvoiceID = ?
     ORDER BY InvoiceLineID ASC`,
    [invoiceId]
  );
  return rows;
};

/**
 * Tìm Payment kèm Invoice.
 */
const findPaymentWithInvoice = async (paymentId) => {
  const [rows] = await pool.execute(
    `SELECT p.*, i.InvoiceNumber, i.SubTotal, i.VATAmount, i.ServiceFeeAmount, i.DiscountAmount, i.TotalAmount, i.SessionID, i.BranchID
     FROM payment p
     INNER JOIN invoice i ON p.InvoiceID = i.InvoiceID
     WHERE p.PaymentID = ?`,
    [paymentId]
  );
  return rows[0] || null;
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
  findPaymentWithInvoice
};
