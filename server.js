'use strict';

require('dotenv').config();

const app = require('./src/app');
const { testConnection } = require('./src/config/db');

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Kiểm tra DB trước — fail-fast nếu không kết nối được
    await testConnection();

    app.listen(PORT, () => {
      console.log(`[SERVER] ✅ Server đang chạy tại http://localhost:${PORT}`);
      console.log(`[SERVER] 📦 Môi trường: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('[SERVER] ❌ Khởi động thất bại:', err.message);
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled Rejection:', reason);
  process.exit(1);
});

startServer();
