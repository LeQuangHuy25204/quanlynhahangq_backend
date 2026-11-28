'use strict';

require('dotenv').config();

const app = require('./src/app');
const { testConnection } = require('./src/config/db');
const { runMigrations } = require('./sql/run_migration');
const { startAutoCloseWaitingSessionsJob } = require('./src/services/session.service');

const PORT = process.env.PORT || 3000;

const startServer = async ({
  checkDb = testConnection,
  migrate = runMigrations,
  listenApp = app,
  port = PORT,
  enableBackgroundJobs = process.env.NODE_ENV !== 'test',
} = {}) => {
  try {
    // Kiểm tra DB trước — fail-fast nếu không kết nối được (và tự seed nếu DB mới tạo còn trống)
    await checkDb();
    // Chạy các SQL migration chưa áp dụng (bổ sung bảng/cột/khuyến mãi idempotent)
    await migrate();

    return await new Promise((resolve) => {
      const server = listenApp.listen(port, () => {
        console.log(`[SERVER] ✅ Server đang chạy tại http://localhost:${port}`);
        console.log(`[SERVER] 📦 Môi trường: ${process.env.NODE_ENV || 'development'}`);
        if (enableBackgroundJobs) {
          startAutoCloseWaitingSessionsJob();
        }
        queueMicrotask(() => resolve(server));
      });
    });
  } catch (err) {
    console.error('[SERVER] ❌ Khởi động thất bại:', err.message);
    process.exit(1);
  }
};

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    console.error('[PROCESS] Unhandled Rejection:', reason);
    process.exit(1);
  });

  startServer();
}

module.exports = { startServer };
