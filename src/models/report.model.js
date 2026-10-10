'use strict';

const { pool } = require('../config/db');

/**
 * Doanh thu theo ngày trong khoảng thời gian (theo chi nhánh).
 * @param {number} branchId
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 */
const getRevenueByBranch = async (branchId, startDate, endDate) => {
  const [rows] = await pool.execute(
    `SELECT
       DATE(i.InvoiceDate) AS Date,
       COUNT(DISTINCT i.InvoiceID)  AS TotalInvoices,
       SUM(i.SubTotal)              AS SubTotal,
       SUM(i.VATAmount)             AS VATAmount,
       SUM(i.ServiceFeeAmount)      AS ServiceFeeAmount,
       SUM(i.DiscountAmount)        AS DiscountAmount,
       SUM(i.TotalAmount)           AS TotalRevenue
     FROM invoice i
     INNER JOIN payment p  ON i.InvoiceID  = p.InvoiceID
     WHERE i.BranchID  = ?
       AND p.Status    = 1
       AND DATE(i.InvoiceDate) BETWEEN ? AND ?
     GROUP BY DATE(i.InvoiceDate)
     ORDER BY DATE(i.InvoiceDate) DESC`,
    [branchId, startDate, endDate]
  );
  return rows;
};

/**
 * Top 10 món bán chạy nhất theo chi nhánh trong khoảng thời gian.
 */
const getTopSellingItems = async (branchId, startDate, endDate, limit = 10) => {
  const [rows] = await pool.execute(
    `SELECT
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
     WHERE a.BranchID  = ?
       AND ol.Status  != 3
       AND DATE(ol.CreatedAt) BETWEEN ? AND ?
     GROUP BY mi.MenuItemID, mi.Name, mi.Unit
     ORDER BY TotalQuantity DESC
     LIMIT ?`,
    [branchId, startDate, endDate, limit]
  );
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

module.exports = { getRevenueByBranch, getTopSellingItems, getRevenueByRestaurant, getDashboardSummary };
