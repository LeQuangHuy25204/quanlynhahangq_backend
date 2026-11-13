'use strict';

const { pool } = require('../config/db');

/**
 * Doanh thu theo ngày trong khoảng thời gian.
 * @param {number} restaurantId
 * @param {number|null} branchId
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 */
const getRevenueByBranch = async (restaurantId, branchId, startDate, endDate) => {
  let sql = `SELECT
       DATE_FORMAT(i.InvoiceDate, '%Y-%m-%d') AS Date,
       COUNT(DISTINCT i.InvoiceID)  AS TotalInvoices,
       SUM(i.SubTotal)              AS SubTotal,
       SUM(i.VATAmount)             AS VATAmount,
       SUM(i.ServiceFeeAmount)      AS ServiceFeeAmount,
       SUM(i.DiscountAmount)        AS DiscountAmount,
       SUM(i.TotalAmount)           AS TotalRevenue
     FROM invoice i
     INNER JOIN payment p  ON i.InvoiceID  = p.InvoiceID
     INNER JOIN branch b   ON i.BranchID   = b.BranchID
     WHERE b.RestaurantID = ?
       AND p.Status    = 1`;
  const params = [restaurantId];
  if (startDate && endDate) {
    sql += ' AND DATE(i.InvoiceDate) BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  sql += " GROUP BY DATE_FORMAT(i.InvoiceDate, '%Y-%m-%d') ORDER BY Date ASC";
  const [rows] = await pool.execute(sql, params);
  return rows;
};

/**
 * Doanh thu theo từng khung giờ trong ngày (khi xem báo cáo theo ngày đơn lẻ hoặc hôm nay).
 */
const getRevenueByHourly = async (restaurantId, branchId, date) => {
  let sql = `SELECT
       HOUR(i.InvoiceDate) AS Hour,
       COUNT(DISTINCT i.InvoiceID) AS TotalInvoices,
       SUM(i.TotalAmount)          AS TotalRevenue
     FROM invoice i
     INNER JOIN payment p ON i.InvoiceID = p.InvoiceID
     INNER JOIN branch b  ON i.BranchID  = b.BranchID
     WHERE b.RestaurantID = ?
       AND p.Status = 1
       AND DATE(i.InvoiceDate) = ?`;
  const params = [restaurantId, date];
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  sql += ' GROUP BY HOUR(i.InvoiceDate) ORDER BY Hour ASC';
  const [rows] = await pool.execute(sql, params);
  return rows;
};

/**
 * Top món bán chạy nhất theo chi nhánh / toàn chuỗi trong khoảng thời gian.
 */
const getTopSellingItems = async (restaurantId, branchId, startDate, endDate, limit = 10) => {
  let sql = `SELECT
       mi.MenuItemID,
       mi.Name        AS MenuItemName,
       mi.Unit,
       SUM(ol.Quantity) AS TotalQuantity,
       SUM(ol.LineTotal) AS TotalRevenue
     FROM orderline ol
     INNER JOIN menuitem mi ON ol.MenuItemID = mi.MenuItemID
     INNER JOIN \`order\` o  ON ol.OrderID   = o.OrderID
     INNER JOIN session s   ON o.SessionID  = s.SessionID
     INNER JOIN \`table\` t  ON s.TableID    = t.TableID
     INNER JOIN area a      ON t.AreaID     = a.AreaID
     INNER JOIN branch b    ON a.BranchID   = b.BranchID
     WHERE b.RestaurantID = ?
       AND ol.Status  != 3`;
  const params = [restaurantId];
  if (startDate && endDate) {
    sql += ' AND DATE(ol.CreatedAt) BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }
  if (branchId) {
    sql += ' AND a.BranchID = ?';
    params.push(branchId);
  }
  const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
  sql += ` GROUP BY mi.MenuItemID, mi.Name, mi.Unit
     ORDER BY TotalQuantity DESC
     LIMIT ${safeLimit}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
};

/**
 * Tổng hợp doanh thu toàn nhà hàng (tất cả chi nhánh) — dành cho RestaurantAdmin.
 */
const getRevenueByRestaurant = async (restaurantId, startDate, endDate) => {
  const [rows] = await pool.execute(
    `SELECT
       b.BranchID,
       b.Name AS BranchName,
       COUNT(DISTINCT i.InvoiceID)  AS TotalInvoices,
       SUM(i.TotalAmount)           AS TotalRevenue
     FROM invoice i
     INNER JOIN payment p  ON i.InvoiceID  = p.InvoiceID
     INNER JOIN branch b   ON i.BranchID   = b.BranchID
     WHERE b.RestaurantID = ?
       AND p.Status       = 1
       AND DATE(i.InvoiceDate) BETWEEN ? AND ?
     GROUP BY b.BranchID, b.Name
     ORDER BY TotalRevenue DESC`,
    [restaurantId, startDate, endDate]
  );
  return rows;
};

const getDashboardSummary = async (restaurantId, branchId, startDate, endDate) => {
  let sql = `SELECT
       COALESCE(COUNT(DISTINCT i.InvoiceID), 0) AS totalInvoices,
       COALESCE(SUM(i.SubTotal), 0)             AS subTotal,
       COALESCE(SUM(i.VATAmount), 0)            AS vatAmount,
       COALESCE(SUM(i.ServiceFeeAmount), 0)     AS serviceFeeAmount,
       COALESCE(SUM(i.DiscountAmount), 0)       AS discountAmount,
       COALESCE(SUM(i.TotalAmount), 0)          AS totalRevenue,
       COALESCE(SUM(s.GuestCount), 0)           AS totalGuests
     FROM invoice i
     INNER JOIN payment p ON i.InvoiceID = p.InvoiceID
     INNER JOIN branch b  ON i.BranchID  = b.BranchID
     LEFT JOIN session s  ON i.SessionID = s.SessionID
     WHERE b.RestaurantID = ? AND p.Status = 1`;
  const params = [restaurantId];
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  if (startDate && endDate) {
    sql += ' AND DATE(i.InvoiceDate) BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }
  const [rows] = await pool.execute(sql, params);
  const totalInvoices = Number(rows[0]?.totalInvoices || 0);
  const subTotal = parseFloat(rows[0]?.subTotal || 0);
  const vatAmount = parseFloat(rows[0]?.vatAmount || 0);
  const serviceFeeAmount = parseFloat(rows[0]?.serviceFeeAmount || 0);
  const discountAmount = parseFloat(rows[0]?.discountAmount || 0);
  const totalRevenue = parseFloat(rows[0]?.totalRevenue || 0);
  const totalGuests = Number(rows[0]?.totalGuests || 0);
  const avgOrderValue = totalInvoices > 0 ? Math.round(totalRevenue / totalInvoices) : 0;

  // Thống kê theo phương thức thanh toán
  let pmSql = `SELECT
       p.PaymentMethod,
       COUNT(DISTINCT i.InvoiceID) AS count,
       COALESCE(SUM(i.TotalAmount), 0) AS revenue
     FROM invoice i
     INNER JOIN payment p ON i.InvoiceID = p.InvoiceID
     INNER JOIN branch b  ON i.BranchID  = b.BranchID
     WHERE b.RestaurantID = ? AND p.Status = 1`;
  const pmParams = [restaurantId];
  if (branchId) {
    pmSql += ' AND i.BranchID = ?';
    pmParams.push(branchId);
  }
  if (startDate && endDate) {
    pmSql += ' AND DATE(i.InvoiceDate) BETWEEN ? AND ?';
    pmParams.push(startDate, endDate);
  }
  pmSql += ' GROUP BY p.PaymentMethod';
  const [pmRows] = await pool.execute(pmSql, pmParams);

  return {
    totalInvoices,
    subTotal,
    vatAmount,
    serviceFeeAmount,
    discountAmount,
    totalRevenue,
    totalGuests,
    avgOrderValue,
    paymentBreakdown: pmRows.map(r => ({
      method: r.PaymentMethod,
      count: Number(r.count || 0),
      revenue: parseFloat(r.revenue || 0)
    }))
  };
};

/**
 * Danh sách hóa đơn đã thanh toán trong khoảng thời gian.
 */
const getInvoicesByPeriod = async (restaurantId, branchId, startDate, endDate) => {
  let sql = `SELECT
       i.InvoiceID,
       i.InvoiceNumber,
       i.InvoiceDate,
       DATE_FORMAT(i.InvoiceDate, '%Y-%m-%d') AS InvoiceDateStr,
       i.SessionID,
       i.BranchID,
       b.Name AS BranchName,
       i.SubTotal,
       i.VATAmount,
       i.ServiceFeeAmount,
       i.DiscountAmount,
       i.TotalAmount,
       p.PaymentID,
       p.PaymentMethod,
       p.Status AS PaymentStatus,
       p.PaidAt,
       p.TransactionNo,
       t.TableID,
       t.Name AS TableName,
       a.Name AS AreaName,
       COALESCE(s.GuestCount, 0) AS GuestCount,
       s.StartTime AS SessionStartTime,
       s.EndTime AS SessionEndTime,
       pr.Name AS PromotionName,
       (SELECT COUNT(*) FROM invoiceline il WHERE il.InvoiceID = i.InvoiceID) AS ItemCount
     FROM invoice i
     INNER JOIN payment p   ON i.InvoiceID   = p.InvoiceID
     INNER JOIN branch b    ON i.BranchID    = b.BranchID
     LEFT JOIN session s    ON i.SessionID   = s.SessionID
     LEFT JOIN \`table\` t  ON s.TableID     = t.TableID
     LEFT JOIN area a       ON t.AreaID      = a.AreaID
     LEFT JOIN promotion pr ON i.PromotionID = pr.PromotionID
     WHERE b.RestaurantID = ?
       AND p.Status = 1`;
  const params = [restaurantId];
  if (startDate && endDate) {
    sql += ' AND DATE(i.InvoiceDate) BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  sql += ' ORDER BY i.InvoiceDate DESC, i.InvoiceID DESC';
  const [rows] = await pool.execute(sql, params);
  return rows;
};

module.exports = {
  getRevenueByBranch,
  getRevenueByHourly,
  getTopSellingItems,
  getRevenueByRestaurant,
  getDashboardSummary,
  getInvoicesByPeriod
};
