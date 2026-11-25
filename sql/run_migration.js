'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const { dbConfig } = require('../src/config/db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const ENSURE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
    \`MigrationName\` varchar(255) NOT NULL,
    \`AppliedAt\` datetime NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (\`MigrationName\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
`;

/**
 * Chạy các file SQL chưa được áp dụng trong thư mục migrations theo thứ tự tên file.
 * Lưu lịch sử vào bảng schema_migrations để tránh chạy lặp seed sau khi admin đã sửa/xóa dữ liệu.
 */
const runMigrations = async ({ force = false, createConnection = mysql.createConnection } = {}) => {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Không tìm thấy thư mục migrations: ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[MIGRATION] ℹ️ Không có file SQL nào trong thư mục migrations.');
    return { applied: [], skipped: [] };
  }

  const conn = await createConnection({
    ...dbConfig,
    multipleStatements: true,
  });

  const applied = [];
  const skipped = [];

  try {
    await conn.query(ENSURE_MIGRATIONS_TABLE_SQL);
    const [rows] = await conn.query('SELECT `MigrationName` FROM `schema_migrations`');
    const alreadyApplied = new Set(rows.map((r) => r.MigrationName));

    for (const file of files) {
      if (!force && alreadyApplied.has(file)) {
        skipped.push(file);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[MIGRATION] Đang kiểm tra & chạy ${file}...`);
      await conn.query(sql);
      await conn.query(
        'INSERT INTO `schema_migrations` (`MigrationName`) VALUES (?) ON DUPLICATE KEY UPDATE `AppliedAt` = CURRENT_TIMESTAMP()',
        [file]
      );
      applied.push(file);
      console.log(`[MIGRATION] ✅ Hoàn tất ${file}!`);
    }

    if (applied.length === 0) {
      console.log(`[MIGRATION] ✅ Dữ liệu migration đã cập nhật (${skipped.length} file đã áp dụng trước đó).`);
    }

    return { applied, skipped };
  } finally {
    await conn.end();
  }
};

if (require.main === module) {
  const force = process.argv.includes('--force');
  runMigrations({ force })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[MIGRATION] ❌ Lỗi migration:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
