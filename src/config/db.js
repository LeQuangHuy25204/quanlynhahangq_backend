'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/**
 * Connection pool kết nối MySQL (hỗ trợ cả biến DB_* local và MYSQL* trên Railway Cloud).
 */
const dbConfig = {
  host:               process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || process.env.MYSQLPORT || '3306', 10),
  user:               process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
  password:           process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database:           process.env.DB_NAME     || process.env.MYSQLDATABASE || 'quanlynhahang',
  waitForConnections: true,
  connectionLimit:    parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  queueLimit:         0,
  charset:            'utf8mb4',
  timezone:           '+07:00',
};

const pool = mysql.createPool(dbConfig);

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+07:00'");
  conn.query("SET SESSION sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))");
});

/**
 * Kiểm tra kết nối khi khởi động và tự động khởi tạo schema + seed data nếu DB Cloud mới tạo còn trống.
 */
const testConnection = async () => {
  try {
    const conn = await pool.getConnection();
    console.log('[DB] ✅ Kết nối MySQL thành công!');
    const [tables] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND LOWER(table_name) = 'branch'`
    );
    conn.release();

    const tableCount = Number(tables[0]?.cnt ?? tables[0]?.CNT ?? 0);
    if (tableCount === 0) {
      const seedPath = path.join(__dirname, '../../sql/cloud_seed.sql');
      if (fs.existsSync(seedPath)) {
        console.log('[DB] 🌱 Phát hiện Database trống trên Cloud, đang nạp dữ liệu từ sql/cloud_seed.sql...');
        const sqlContent = fs.readFileSync(seedPath, 'utf8');
        const seedConn = await mysql.createConnection({
          ...dbConfig,
          multipleStatements: true,
        });
        await seedConn.query(sqlContent);
        await seedConn.end();
        console.log('[DB] 🎉 Đã khởi tạo toàn bộ bảng và dữ liệu mẫu lên Cloud MySQL thành công!');
      }
    }
  } catch (err) {
    console.error('[DB] ❌ Không thể kết nối MySQL:', err.message);
    throw err;
  }
};

module.exports = { pool, dbConfig, testConnection };
