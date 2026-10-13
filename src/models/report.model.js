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
       AND p.Status    = 1
       AND DATE(i.InvoiceDate) BETWEEN ? AND ?`;
  const params = [restaurantId, startDate, endDate];
  if (branchId) {
    sql += ' AND i.BranchID = ?';
    params.push(branchId);
  }
  sql += ' GROUP BY DATE(i.InvoiceDate) ORDER BY DATE(i.InvoiceDate) ASC';
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
       AND ol.Status  != 3
       AND DATE(ol.CreatedAt) BETWEEN ? AND ?`;
  const params = [restaurantId, startDate, endDate];
  if (branchId) {
    sql += ' AND a.BranchID = ?';
    params.push(branchId);
  }
  sql += ` GROUP BY mi.MenuItemID, mi.Name, mi.Unit
     ORDER BY TotalQuantity DESC
     LIMIT ?`;
  params.push(limit);
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
       COALESCE(SUM(i.TotalAmount), 0)          AS totalRevenue
     FROM invoice i
     INNER JOIN payment p ON i.InvoiceID = p.InvoiceID
     INNER JOIN branch b  ON i.BranchID  = b.BranchID
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
  const totalRevenue = parseFloat(rows[0]?.totalRevenue || 0);
  const avgOrderValue = totalInvoices > 0 ? Math.round(totalRevenue / totalInvoices) : 0;
  return { totalInvoices, totalRevenue, avgOrderValue };
};

module.exports = { getRevenueByBranch, getRevenueByHourly, getTopSellingItems, getRevenueByRestaurant, getDashboardSummary };
