'use strict';

const mysql = require('mysql2/promise');

/**
 * Connection pool kết nối MySQL.
 * Toàn bộ cấu hình đọc từ process.env — không hard-code giá trị nhạy cảm.
 */
const pool = mysql.createPool({
  host:            process.env.DB_HOST     || 'localhost',
  port:            parseInt(process.env.DB_PORT || '3306', 10),
  user:            process.env.DB_USER     || 'root',
  password:        process.env.DB_PASSWORD || '',
  database:        process.env.DB_NAME     || 'quanlynhahang',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  queueLimit:      0,
  charset:         'utf8mb4',
  timezone:        '+07:00',
});

/**
 * Kiểm tra kết nối khi khởi động — fail-fast nếu DB chưa sẵn sàng.
 */
const testConnection = async () => {
  try {
    const conn = await pool.getConnection();
    console.log('[DB] ✅ Kết nối MySQL thành công!');
    conn.release();
  } catch (err) {
    console.error('[DB] ❌ Không thể kết nối MySQL:', err.message);
    throw err;
  }
};

module.exports = { pool, testConnection };
