'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const runMigration = async () => {
  const migrationFile = path.join(__dirname, 'migrations', '001_vnpay_payment_transaction.sql');
  if (!fs.existsSync(migrationFile)) {
    throw new Error(`Không tìm thấy file migration: ${migrationFile}`);
  }

  const sql = fs.readFileSync(migrationFile, 'utf8');
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
    console.log('[MIGRATION] Đang kiểm tra & chạy 001_vnpay_payment_transaction.sql...');
    await conn.query(sql);
    console.log('[MIGRATION] ✅ Hoàn tất migration 001_vnpay_payment_transaction.sql!');
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
