'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const runMigration = async () => {
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Không tìm thấy thư mục migrations: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.MYSQLPORT || '3306', 10),
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'quanlynhahang',
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`[MIGRATION] Đang kiểm tra & chạy ${file}...`);
      await conn.query(sql);
      console.log(`[MIGRATION] ✅ Hoàn tất ${file}!`);
    }
  } finally {
    await conn.end();
  }
};

runMigration()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[MIGRATION] ❌ Lỗi migration:', err.message);
    process.exit(1);
  });
