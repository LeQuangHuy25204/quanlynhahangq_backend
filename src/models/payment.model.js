'use strict';

const { pool } = require('../config/db');

/**
 * Lấy cấu hình thuế và phí phục vụ của chi nhánh dựa trên OrderID.
 */
const getBranchConfigByOrderId = async (orderId) => {
  const [rows] = await pool.execute(
    `SELECT b.VATRate, b.ServiceFeeRate, b.BranchID
     FROM \`order\` o
     INNER JOIN session s ON o.SessionID = s.SessionID
     INNER JOIN \`table\` t ON s.TableID = t.TableID
     INNER JOIN area a ON t.AreaID = a.AreaID
     INNER JOIN branch b ON a.BranchID = b.BranchID
     WHERE o.OrderID = ?`,
    [orderId]
  );
  return rows[0] || null;
};

/**
 * Tạo bản ghi Payment mới (thường là PENDING).
 */
const createPayment = async ({ orderId, amount, paymentMethod, status, note }) => {
  const [result] = await pool.execute(
    `INSERT INTO payment (OrderID, Amount, PaymentMethod, Status, Note)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, amount, paymentMethod || 'CASH', status, note || null]
  );
  return result.insertId;
};

/**
 * Tạo Invoice.
 * InvoiceNumber tự sinh pattern: INV-{YYYYMMDD}-{random 6 hex}
 */
const createInvoice = async ({ paymentId, subTotal, vatAmount, serviceFeeAmount, discountAmount, totalAmount }) => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
  const invoiceNumber = `INV-${dateStr}-${random}`;

  const [result] = await pool.execute(
    `INSERT INTO invoice (PaymentID, InvoiceNumber, SubTotal, VATAmount, ServiceFeeAmount, DiscountAmount, TotalAmount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [paymentId, invoiceNumber, subTotal, vatAmount, serviceFeeAmount, discountAmount, totalAmount]
  );
  return { invoiceId: result.insertId, invoiceNumber };
};

/**
 * Cập nhật trạng thái Payment khi đã thu tiền thành công.
 */
const completePayment = async (paymentId, status, transactionNo = null) => {
  const [result] = await pool.execute(
    `UPDATE payment SET Status = ?, PaidAt = NOW(), TransactionNo = ? WHERE PaymentID = ?`,
    [status, transactionNo, paymentId]
  );
  return result.affectedRows;
};

/**
 * Tìm Payment kèm Invoice.
 */
const findPaymentWithInvoice = async (paymentId) => {
  const [rows] = await pool.execute(
    `SELECT p.*, i.InvoiceID, i.InvoiceNumber, i.SubTotal, i.VATAmount, i.ServiceFeeAmount, i.DiscountAmount, i.TotalAmount
     FROM payment p
     LEFT JOIN invoice i ON p.PaymentID = i.PaymentID
     WHERE p.PaymentID = ?`,
    [paymentId]
  );
  return rows[0] || null;
};

module.exports = {
  getBranchConfigByOrderId,
  createPayment,
  createInvoice,
  completePayment,
  findPaymentWithInvoice
};
