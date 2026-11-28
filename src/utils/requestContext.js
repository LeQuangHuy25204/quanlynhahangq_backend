'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Chuẩn hóa địa chỉ IP client (hỗ trợ proxy Railway qua x-forwarded-for).
 */
const extractClientIp = (req) => {
  if (!req) return null;
  const forwarded = req.headers?.['x-forwarded-for'];
  let ip = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === 'string'
    ? forwarded.split(',')[0]
    : req.socket?.remoteAddress || req.ip || null;

  if (!ip) return null;
  ip = String(ip).trim();
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip.slice(0, 45);
};

/**
 * Middleware khởi tạo AsyncLocalStorage context cho mỗi HTTP request.
 */
const requestContextMiddleware = (req, _res, next) => {
  const ctx = {
    ipAddress: extractClientIp(req),
    method: req.method,
    requestPath: req.originalUrl || req.url,
    user: null,
  };
  storage.run(ctx, () => next());
};

const getContext = () => storage.getStore() || null;

const setContextUser = (user) => {
  const store = storage.getStore();
  if (store) {
    store.user = user;
  }
};

module.exports = {
  extractClientIp,
  requestContextMiddleware,
  getContext,
  setContextUser,
};
