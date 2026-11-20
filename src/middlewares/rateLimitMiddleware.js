'use strict';

/**
 * Middleware giới hạn tần suất (Sliding Window Rate Limiter) trong bộ nhớ.
 * Dùng để bảo vệ endpoint tạo giao dịch VNPay, chống spam / double-submit.
 *
 * @param {object} options
 * @param {number} options.windowMs - Khung thời gian (ms)
 * @param {number} options.maxRequests - Số request tối đa trong khung thời gian
 * @param {function} [options.keyGenerator] - Hàm tạo khóa định danh (mặc định theo IP + session/staff)
 */
const createRateLimiter = ({
  windowMs = 60 * 1000,
  maxRequests = 10,
  keyGenerator = null,
  message = 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít giây.',
} = {}) => {
  const hits = new Map();

  // Dọn dẹp định kỳ các key đã hết hạn để tránh rò rỉ bộ nhớ
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, Math.max(windowMs, 30 * 1000));

  if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test' && req.headers['x-bypass-ratelimit'] === '1') {
      return next();
    }

    const now = Date.now();
    const rawKey = keyGenerator
      ? keyGenerator(req)
      : `${req.ip || 'unknown'}:${req.body?.sessionToken || req.user?.staffId || req.body?.sessionId || 'anon'}`;
    const key = String(rawKey);

    const existing = hits.get(key) || [];
    const recent = existing.filter((t) => now - t < windowMs);

    if (recent.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        message,
      });
    }

    recent.push(now);
    hits.set(key, recent);
    return next();
  };
};

module.exports = { createRateLimiter };
