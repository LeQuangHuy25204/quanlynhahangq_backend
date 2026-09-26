'use strict';

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

// ── Routes ────────────────────────────────────────────────────
const authRoutes    = require('./routes/auth.routes');
const menuRoutes    = require('./routes/menu.routes');
const sessionRoutes = require('./routes/session.routes');
const orderRoutes   = require('./routes/order.routes');
const staffRoutes    = require('./routes/staff.routes');
const paymentRoutes  = require('./routes/payment.routes');
const tableRoutes    = require('./routes/table.routes');
const promotionRoutes = require('./routes/promotion.routes');
const reportRoutes   = require('./routes/report.routes');
const app = express();

// ── Global Middlewares ────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/menu',     menuRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/orders',   orderRoutes);
app.use('/api/staff',    staffRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/tables',   tableRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/reports',  reportRoutes);

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route không tồn tại: [${req.method}] ${req.originalUrl}`,
  });
});

// ── Centralized Error Handler ─────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  console.error('[ERROR]', err.stack || err.message);
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Lỗi server nội bộ.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;
