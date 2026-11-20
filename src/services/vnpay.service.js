'use strict';

const crypto = require('crypto');

const VNP_VERSION = '2.1.0';
const VNP_COMMAND_PAY = 'pay';
const VNP_COMMAND_QUERY = 'querydr';

/**
 * Lấy cấu hình VNPay từ biến môi trường (không hardcode secret).
 */
const getVnpConfig = () => {
  const tmnCode = (process.env.VNP_TMN_CODE || '').trim();
  const hashSecret = (process.env.VNP_HASH_SECRET || '').trim();
  const vnpUrl = (process.env.VNP_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html').trim();
  const vnpApiUrl = (process.env.VNP_API_URL || 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction').trim();
  const returnUrl = (process.env.VNP_RETURN_URL || 'http://localhost:3000/api/payments/vnpay/return').trim();
  const frontendReturnUrl = (process.env.VNP_FRONTEND_RETURN_URL || 'http://localhost:5173/customer/payment-result').trim();
  const pendingTimeoutMinutes = parseInt(process.env.VNP_PENDING_TIMEOUT_MINUTES || '15', 10);

  return {
    tmnCode,
    hashSecret,
    vnpUrl,
    vnpApiUrl,
    returnUrl,
    frontendReturnUrl,
    pendingTimeoutMinutes: Number.isNaN(pendingTimeoutMinutes) ? 15 : pendingTimeoutMinutes,
  };
};

/**
 * Định dạng thời gian theo chuẩn VNPay yyyyMMddHHmmss (múi giờ GMT+7 Asia/Ho_Chi_Minh).
 */
const formatVnpDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}${map.month}${map.day}${hour}${map.minute}${map.second}`;
};

/**
 * Chuẩn hóa IP client gửi sang VNPay (VNPay ưu tiên IPv4).
 */
const normalizeIp = (ip) => {
  if (!ip) return '127.0.0.1';
  const cleaned = String(ip).split(',')[0].trim();
  if (cleaned === '::1' || cleaned === '::ffff:127.0.0.1') return '127.0.0.1';
  if (cleaned.startsWith('::ffff:')) return cleaned.slice(7);
  return cleaned;
};

/**
 * Chuyển số tiền VNĐ (decimal string hoặc integer) sang số nguyên đơn vị (VNĐ * 100) dùng BigInt.
 * Tuyệt đối không dùng phép tính floating point để đối chiếu tiền.
 */
const parseAmountToVnpInt = (amount) => {
  const str = typeof amount === 'number'
    ? Math.round(amount * 100).toString().padStart(3, '0')
    : null;

  if (str !== null) {
    return BigInt(str);
  }

  const raw = String(amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Giá trị tiền tệ không hợp lệ: ${raw}`);
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const paddedFrac = (fracPart + '00').slice(0, 2);
  return BigInt(intPart) * 100n + BigInt(paddedFrac);
};

/**
 * Parse chuỗi số nguyên vnp_Amount từ VNPay callback. Trả về null nếu không phải số nguyên hợp lệ.
 */
const parseVnpInteger = (raw) => {
  const str = String(raw ?? '').trim();
  if (!/^\d+$/.test(str)) return null;
  return BigInt(str);
};

/**
 * Sắp xếp tham số theo bảng chữ cái và encode theo chuẩn VNPay NodeJS 2.1.0.
 */
const sortObject = (obj) => {
  const sorted = {};
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .sort();

  for (const key of keys) {
    const encodedKey = encodeURIComponent(key);
    sorted[encodedKey] = encodeURIComponent(String(obj[key])).replace(/%20/g, '+');
  }
  return sorted;
};

/**
 * Tạo chữ ký HMAC-SHA512 cho chuỗi dữ liệu.
 */
const signHmacSha512 = (data, secret) => {
  return crypto
    .createHmac('sha512', secret)
    .update(Buffer.from(data, 'utf-8'))
    .digest('hex');
};

/**
 * So sánh chữ ký an toàn theo thời gian hằng (chống timing attack).
 */
const timingSafeHexEqual = (hexA, hexB) => {
  if (!hexA || !hexB) return false;
  const a = String(hexA).trim().toLowerCase();
  const b = String(hexB).trim().toLowerCase();
  if (a.length !== b.length || a.length === 0) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Kiểm tra chữ ký vnp_SecureHash trên query callback (Return URL hoặc IPN).
 */
const verifySignature = (queryParams, overrideSecret = null) => {
  const { hashSecret } = getVnpConfig();
  const secret = overrideSecret || hashSecret;
  if (!secret) return false;

  const secureHash = queryParams?.vnp_SecureHash;
  if (!secureHash || typeof secureHash !== 'string') return false;

  const cloned = { ...queryParams };
  delete cloned.vnp_SecureHash;
  delete cloned.vnp_SecureHashType;

  const sorted = sortObject(cloned);
  const signData = Object.keys(sorted)
    .map((k) => `${k}=${sorted[k]}`)
    .join('&');

  const expectedHash = signHmacSha512(signData, secret);
  return timingSafeHexEqual(expectedHash, secureHash);
};

/**
 * Tạo URL thanh toán VNPay Sandbox (API v2.1.0 - HMACSHA512).
 */
const buildPaymentUrl = ({
  txnRef,
  amountVnp,
  orderInfo,
  ipAddr,
  locale = 'vn',
  createDate = new Date(),
  expireMinutes = 15,
}) => {
  const { tmnCode, hashSecret, vnpUrl, returnUrl } = getVnpConfig();
  if (!tmnCode || !hashSecret) {
    const err = new Error('VNPay Sandbox chưa được cấu hình (thiếu VNP_TMN_CODE hoặc VNP_HASH_SECRET).');
    err.statusCode = 500;
    throw err;
  }

  const expireDate = new Date(createDate.getTime() + expireMinutes * 60 * 1000);

  const vnpParams = {
    vnp_Version: VNP_VERSION,
    vnp_Command: VNP_COMMAND_PAY,
    vnp_TmnCode: tmnCode,
    vnp_Locale: locale,
    vnp_CurrCode: 'VND',
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: 'other',
    vnp_Amount: BigInt(amountVnp).toString(),
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: normalizeIp(ipAddr),
    vnp_CreateDate: formatVnpDate(createDate),
    vnp_ExpireDate: formatVnpDate(expireDate),
  };

  const sorted = sortObject(vnpParams);
  const signData = Object.keys(sorted)
    .map((k) => `${k}=${sorted[k]}`)
    .join('&');

  const secureHash = signHmacSha512(signData, hashSecret);
  return `${vnpUrl}?${signData}&vnp_SecureHash=${secureHash}`;
};

/**
 * Gọi API querydr của VNPay để tra cứu kết quả thực tế khi IPN chậm hoặc cần đối soát.
 */
const queryTransaction = async ({ txnRef, transactionDate, orderInfo, ipAddr }) => {
  const { tmnCode, hashSecret, vnpApiUrl } = getVnpConfig();
  if (!tmnCode || !hashSecret) {
    const err = new Error('VNPay Sandbox chưa được cấu hình (thiếu VNP_TMN_CODE hoặc VNP_HASH_SECRET).');
    err.statusCode = 500;
    throw err;
  }

  const requestId = `${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
  const createDate = formatVnpDate(new Date());
  const normalizedIp = normalizeIp(ipAddr);
  const info = orderInfo || `Kiem tra giao dich ${txnRef}`;

  const dataStr = [
    requestId,
    VNP_VERSION,
    VNP_COMMAND_QUERY,
    tmnCode,
    txnRef,
    transactionDate,
    createDate,
    normalizedIp,
    info,
  ].join('|');

  const secureHash = signHmacSha512(dataStr, hashSecret);

  const body = {
    vnp_RequestId: requestId,
    vnp_Version: VNP_VERSION,
    vnp_Command: VNP_COMMAND_QUERY,
    vnp_TmnCode: tmnCode,
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: info,
    vnp_TransactionDate: transactionDate,
    vnp_CreateDate: createDate,
    vnp_IpAddr: normalizedIp,
    vnp_SecureHash: secureHash,
  };

  const response = await fetch(vnpApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const err = new Error(`VNPay querydr trả về HTTP ${response.status}`);
    err.statusCode = 502;
    throw err;
  }

  return await response.json();
};

/**
 * Loại bỏ các trường nhạy cảm trước khi ghi log hoặc lưu payload đối soát.
 */
const sanitizeLogPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  const blockedKeys = new Set([
    'vnp_SecureHash',
    'vnp_SecureHashType',
    'vnp_HashSecret',
    'hashSecret',
    'secret',
    'sessionToken',
    'cardNumber',
    'cvv',
    'otp',
  ]);
  const sanitized = {};
  for (const [k, v] of Object.entries(payload)) {
    if (blockedKeys.has(k)) {
      sanitized[k] = '[REDACTED]';
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
};

module.exports = {
  getVnpConfig,
  formatVnpDate,
  normalizeIp,
  parseAmountToVnpInt,
  parseVnpInteger,
  sortObject,
  signHmacSha512,
  timingSafeHexEqual,
  verifySignature,
  buildPaymentUrl,
  queryTransaction,
  sanitizeLogPayload,
};
