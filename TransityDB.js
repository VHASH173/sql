const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

function loadLocalEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile();

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Create .env from .env.example or set it before starting the backend.`);
  }
  return value;
}

const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = Number(process.env.PORT || 3000);
const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+63\d{10}$/;
const PROFILE_GENDER_OPTIONS = ['Male', 'Female', 'Others', 'Prefer not say'];
const PROFILE_REGION_OPTIONS = [
  'NCR \u2013 National Capital Region',
  'Region I \u2013 Ilocos Region',
  'Region II \u2013 Cagayan Valley',
  'Region III \u2013 Central Luzon',
  'Region IV-A \u2013 CALABARZON',
  'MIMAROPA Region',
  'Region V \u2013 Bicol Region',
  'Region VI \u2013 Western Visayas',
  'Region VII \u2013 Central Visayas',
  'Region VIII \u2013 Eastern Visayas',
  'Region IX \u2013 Zamboanga Peninsula',
  'Region X \u2013 Northern Mindanao',
  'Region XI \u2013 Davao Region',
  'Region XII \u2013 SOCCSKSARGEN',
  'Region XIII \u2013 Caraga'
];
const ACTIVE_BOOKING_STATUSES = ['Accepted', 'In Progress'];
const FINAL_DISCOUNT_MINIMUM_FARE = 80.0;
const DEFAULT_DRIVER_COMMISSION_RATE = 18.0;
const REDUCED_DRIVER_COMMISSION_RATE = 15.0;
const REDUCED_DRIVER_COMMISSION_THRESHOLD = 8;
const FIRST_DRIVER_TOP_UP_MINIMUM = 300.0;
const LATER_DRIVER_TOP_UP_MINIMUM = 50.0;
const SPECIAL_DISCOUNT_RATE = 20.0;
const MAX_DISCOUNT_PERCENTAGE = 25.0;
const MAX_MINIMUM_FARE_RATIO = 0.25;
const CUSTOMER_REWARD_RULES = [
  {
    completedCount: 5,
    type: 'PERCENTAGE',
    value: 10.0,
    maxDiscount: 60.0,
    label: '5 completed bookings reward'
  }
];
const DISCOUNT_REQUEST_METADATA_DIR = path.join(__dirname, 'discount_request_assets');

app.use(express.json({ limit: '2mb' }));

const db = mysql.createPool({
  host: requireEnv('DB_HOST'),
  port: Number(process.env.DB_PORT || 3306),
  user: requireEnv('DB_USER'),
  password: requireEnv('DB_PASSWORD'),
  database: requireEnv('DB_NAME'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const driverLiveLocations = new Map();

function isValidEmail(email) {
  return EMAIL_REGEX.test(String(email || '').trim());
}

function isProfileComplete(profile) {
  const requiredValues = [
    profile.first_name,
    profile.last_name,
    profile.email_address,
    profile.phone,
    profile.address,
    profile.city,
    profile.region
  ];

  return requiredValues.every((value) => String(value || '').trim().length > 0);
}

function normalizeUserPicture(value) {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    const textValue = value.toString('utf8').trim();
    if (
      textValue.startsWith('content://') ||
      textValue.startsWith('file://') ||
      textValue.startsWith('android.resource://') ||
      textValue.startsWith('data:image/') ||
      /^[A-Za-z0-9+/=\r\n]+$/.test(textValue)
    ) {
      return textValue || null;
    }
    return `data:image/jpeg;base64,${value.toString('base64')}`;
  }
  const textValue = String(value).trim();
  return textValue || null;
}

function normalizeStoredAsset(value) {
  return normalizeUserPicture(value);
}

function parseDiscountRequestPicture(value, mimeType) {
  const normalizedValue = normalizeStoredAsset(value);
  if (!normalizedValue) {
    return { buffer: null, mimeType: null };
  }

  let resolvedMimeType = String(mimeType || '').trim() || 'image/jpeg';
  let base64Payload = normalizedValue.replace(/\s/g, '');
  const dataUriMatch = normalizedValue.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUriMatch) {
    resolvedMimeType = dataUriMatch[1];
    base64Payload = String(dataUriMatch[2] || '').replace(/\s/g, '');
  }

  try {
    const buffer = Buffer.from(base64Payload, 'base64');
    if (!buffer.length) {
      return { buffer: null, mimeType: null };
    }
    return {
      buffer,
      mimeType: resolvedMimeType
    };
  } catch (error) {
    return { buffer: null, mimeType: null };
  }
}

function normalizeDiscountRequestPicture(value, mimeType) {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return `data:${String(mimeType || 'image/jpeg').trim() || 'image/jpeg'};base64,${value.toString('base64')}`;
  }
  return normalizeStoredAsset(value);
}

function generateUserCode() {
  return `TB${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function toMysqlDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toMysqlDateTime(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function getDiscountRequestMetadataPath(requestId) {
  ensureDirectoryExists(DISCOUNT_REQUEST_METADATA_DIR);
  return path.join(DISCOUNT_REQUEST_METADATA_DIR, `discount_request_${requestId}.json`);
}

function loadDiscountRequestMetadata(requestId) {
  try {
    const filePath = getDiscountRequestMetadataPath(requestId);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('Discount request metadata read error:', error);
    return {};
  }
}

function saveDiscountRequestMetadata(requestId, payload) {
  const filePath = getDiscountRequestMetadataPath(requestId);
  fs.writeFileSync(filePath, JSON.stringify(payload || {}, null, 2), 'utf8');
}

function deleteDiscountRequestMetadata(requestId) {
  const filePath = getDiscountRequestMetadataPath(requestId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function normalizeDateOnly(value) {
  return String(value || '').trim().slice(0, 10);
}

function parseId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseMoney(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function roundCurrency(value) {
  const parsed = Number(value || 0);
  return Number(parsed.toFixed(2));
}

function computeCommissionRate(totalCompletedBookings) {
  return totalCompletedBookings >= REDUCED_DRIVER_COMMISSION_THRESHOLD
    ? REDUCED_DRIVER_COMMISSION_RATE
    : DEFAULT_DRIVER_COMMISSION_RATE;
}

function computePercentageDiscount(baseAmount, percentage, maxDiscount = null) {
  const rawDiscount = roundCurrency((baseAmount * percentage) / 100);
  if (maxDiscount == null || maxDiscount <= 0) {
    return rawDiscount;
  }
  return roundCurrency(Math.min(rawDiscount, maxDiscount));
}

function parseCoordinatePair(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return null;
  }

  const [latitudeRaw, longitudeRaw] = raw.split(',').map((value) => String(value || '').trim());
  const latitude = Number.parseFloat(latitudeRaw);
  const longitude = Number.parseFloat(longitudeRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6))
  };
}

function parseBookingTripPayload(rawValue) {
  if (!rawValue) {
    return {};
  }

  try {
    const normalizedRaw = Buffer.isBuffer(rawValue) ? rawValue.toString('utf8') : String(rawValue);
    const trimmed = normalizedRaw.trim();
    return trimmed ? JSON.parse(trimmed) : {};
  } catch (error) {
    return {};
  }
}

function buildBookingTripPayload({
  pickup_coordinates,
  destination_coordinates,
  vehicle_type,
  original_fare,
  discount_amount,
  final_fare,
  voucher_id,
  promo_id,
  promo_code,
  apply_special_discount,
  discount_type,
  discount_value,
  max_discount
}) {
  const pickup = parseCoordinatePair(pickup_coordinates);
  const destination = parseCoordinatePair(destination_coordinates);
  const normalizedVehicleType = String(vehicle_type || '').trim();

  return {
    pickup_latitude: pickup?.latitude ?? null,
    pickup_longitude: pickup?.longitude ?? null,
    destination_latitude: destination?.latitude ?? null,
    destination_longitude: destination?.longitude ?? null,
    vehicle_type: normalizedVehicleType || null,
    original_fare: parseMoney(original_fare),
    discount_amount: parseMoney(discount_amount),
    final_fare: parseMoney(final_fare),
    voucher_id: parseId(voucher_id),
    promo_id: parseId(promo_id),
    promo_code: String(promo_code || '').trim() || null,
    apply_special_discount: Boolean(apply_special_discount),
    discount_type: String(discount_type || '').trim() || null,
    discount_value: parseMoney(discount_value),
    max_discount: parseMoney(max_discount)
  };
}

function isAllowedBookingStatus(status) {
  return ['Pending', 'Accepted', 'In Progress', 'Completed', 'Cancelled', 'Rejected'].includes(status);
}

function normalizeBookingStatus(status) {
  const value = String(status || '').trim().toLowerCase();

  switch (value) {
    case 'pending':
    case 'searching':
    case 'queued':
      return 'Pending';
    case 'accepted':
    case 'assigned':
      return 'Accepted';
    case 'in progress':
    case 'in_progress':
    case 'inprogress':
    case 'arrived':
    case 'in trip':
    case 'in_trip':
      return 'In Progress';
    case 'completed':
    case 'complete':
      return 'Completed';
    case 'cancelled':
    case 'canceled':
    case 'timed_out':
    case 'timeout':
      return 'Cancelled';
    case 'rejected':
    case 'declined':
      return 'Rejected';
    default:
      return String(status || '').trim();
  }
}

function normalizeStatusUpper(value) {
  return String(value || '').trim().toUpperCase();
}

let customerVoucherColumnCache = null;

async function getCustomerVoucherColumns(connection = db) {
  if (customerVoucherColumnCache) {
    return customerVoucherColumnCache;
  }

  const [rows] = await connection.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'customer_vouchers'
    `
  );

  customerVoucherColumnCache = new Set(rows.map((row) => String(row.COLUMN_NAME || '').trim()));
  return customerVoucherColumnCache;
}

function hasCustomerVoucherColumn(columns, columnName) {
  return columns.has(String(columnName || '').trim());
}

function buildCustomerVoucherStatusSelect(columns) {
  if (hasCustomerVoucherColumn(columns, 'status')) {
    return 'status';
  }
  if (hasCustomerVoucherColumn(columns, 'is_used')) {
    return "CASE WHEN COALESCE(is_used, 0) = 1 THEN 'USED' ELSE 'AVAILABLE' END AS status";
  }
  return "'AVAILABLE' AS status";
}

function buildCustomerVoucherAvailableWhere(columns) {
  const clauses = [];
  if (hasCustomerVoucherColumn(columns, 'status')) {
    clauses.push("UPPER(TRIM(status)) = 'AVAILABLE'");
  }
  if (hasCustomerVoucherColumn(columns, 'is_used')) {
    clauses.push('COALESCE(is_used, 0) = 0');
  }
  if (hasCustomerVoucherColumn(columns, 'redeemed_at')) {
    clauses.push('redeemed_at IS NULL');
  }
  return clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
}

function buildCustomerVoucherDateSelect(columns, columnName) {
  if (hasCustomerVoucherColumn(columns, columnName)) {
    return `DATE_FORMAT(${columnName}, '%Y-%m-%d %H:%i:%s') AS ${columnName}`;
  }
  return `NULL AS ${columnName}`;
}

function buildCustomerVoucherMilestoneSelect(columns) {
  return hasCustomerVoucherColumn(columns, 'grant_milestone_completed_bookings')
    ? 'grant_milestone_completed_bookings'
    : 'NULL AS grant_milestone_completed_bookings';
}

function buildVoucherRewardMessage(voucher) {
  const milestone = Number(voucher?.grant_milestone_completed_bookings || voucher?.completedCount || 5);
  return `Congratulations! You received a voucher for completing ${milestone} bookings.`;
}

function validateDiscountDefinition(type, value, maxDiscount = null) {
  const normalizedType = normalizeStatusUpper(type);
  const normalizedValue = parseMoney(value);
  const normalizedMaxDiscount = maxDiscount == null ? null : parseMoney(maxDiscount);

  if (!['FIXED', 'PERCENTAGE'].includes(normalizedType)) {
    return 'Discount type is not supported.';
  }
  if (normalizedValue == null || normalizedValue <= 0) {
    return 'Discount value must be greater than zero.';
  }
  if (normalizedType === 'PERCENTAGE' && normalizedValue > MAX_DISCOUNT_PERCENTAGE) {
    return `Discount percentage cannot exceed ${MAX_DISCOUNT_PERCENTAGE}%.`;
  }
  if (normalizedMaxDiscount != null && normalizedMaxDiscount <= 0) {
    return 'Maximum discount must be greater than zero.';
  }
  return '';
}

function validateMinimumFareForFare(minimumFare, currentFare) {
  const normalizedMinimumFare = parseMoney(minimumFare) || 0;
  const normalizedFare = parseMoney(currentFare) || 0;
  if (normalizedMinimumFare <= 0 || normalizedFare <= 0) {
    return '';
  }

  if (normalizedMinimumFare > roundCurrency(normalizedFare * MAX_MINIMUM_FARE_RATIO)) {
    return 'Minimum fare requirement is too high for this booking.';
  }
  if (normalizedFare < normalizedMinimumFare) {
    return `This promo requires a minimum fare of PHP ${normalizedMinimumFare.toFixed(2)}.`;
  }
  return '';
}

async function ensureDriverWallet(driverId, connection = db) {
  const [existingRows] = await connection.query(
    `
      SELECT wallet_id, driver_id, balance, total_completed_bookings, commission_rate
      FROM driver_wallets
      WHERE driver_id = ?
      LIMIT 1
    `,
    [driverId]
  );

  if (existingRows.length > 0) {
    const wallet = existingRows[0];
    const normalizedCompleted = Number(wallet.total_completed_bookings || 0);
    const expectedRate = computeCommissionRate(normalizedCompleted);
    if (Number(wallet.commission_rate || 0) !== expectedRate) {
      await connection.query(
        `
          UPDATE driver_wallets
          SET commission_rate = ?, updated_at = NOW()
          WHERE wallet_id = ?
        `,
        [expectedRate, wallet.wallet_id]
      );
      wallet.commission_rate = expectedRate;
    }
    return {
      ...wallet,
      balance: parseMoney(wallet.balance) || 0,
      total_completed_bookings: normalizedCompleted
    };
  }

  const [insertResult] = await connection.query(
    `
      INSERT INTO driver_wallets (
        driver_id,
        balance,
        total_completed_bookings,
        commission_rate,
        created_at,
        updated_at
      )
      VALUES (?, 0, 0, ?, NOW(), NOW())
    `,
    [driverId, DEFAULT_DRIVER_COMMISSION_RATE]
  );

  return {
    wallet_id: insertResult.insertId,
    driver_id: driverId,
    balance: 0,
    total_completed_bookings: 0,
    commission_rate: DEFAULT_DRIVER_COMMISSION_RATE
  };
}

async function getDriverWalletSummary(driverId, connection = db) {
  const wallet = await ensureDriverWallet(driverId, connection);
  return {
    wallet_id: wallet.wallet_id,
    driver_id: wallet.driver_id,
    balance: parseMoney(wallet.balance) || 0,
    total_completed_bookings: Number(wallet.total_completed_bookings || 0),
    commission_rate: parseMoney(wallet.commission_rate) || DEFAULT_DRIVER_COMMISSION_RATE
  };
}

function canWalletCoverBooking(wallet, estimatedFare) {
  const balance = parseMoney(wallet?.balance) || 0;
  const fare = parseMoney(estimatedFare) || 0;
  if (fare <= 0) {
    return balance > 0;
  }
  const commissionAmount = roundCurrency((fare * (parseMoney(wallet?.commission_rate) || DEFAULT_DRIVER_COMMISSION_RATE)) / 100);
  return balance >= commissionAmount;
}

async function getAvailableCustomerVoucher(userId, voucherId, connection = db) {
  const columns = await getCustomerVoucherColumns(connection);
  const [rows] = await connection.query(
    `
      SELECT
        voucher_id,
        user_id,
        type,
        value,
        max_discount,
        ${buildCustomerVoucherMilestoneSelect(columns)},
        ${buildCustomerVoucherStatusSelect(columns)},
        ${buildCustomerVoucherDateSelect(columns, 'expiration_date')},
        ${buildCustomerVoucherDateSelect(columns, 'created_at')},
        ${buildCustomerVoucherDateSelect(columns, 'redeemed_at')},
        ${buildCustomerVoucherDateSelect(columns, 'notified_at')}
      FROM customer_vouchers
      WHERE voucher_id = ?
        AND user_id = ?
        ${buildCustomerVoucherAvailableWhere(columns)}
        ${hasCustomerVoucherColumn(columns, 'expiration_date') ? 'AND (expiration_date IS NULL OR expiration_date >= NOW())' : ''}
      LIMIT 1
    `,
    [voucherId, userId]
  );
  return rows[0] || null;
}

async function getActivePromoRecord({ promoId = null, code = null }, connection = db) {
  if (!promoId && !code) {
    return null;
  }

  const whereClause = promoId ? 'promo_id = ?' : 'code = ?';
  const whereValue = promoId || String(code || '').trim();
  const [rows] = await connection.query(
    `
      SELECT
        promo_id,
        code,
        type,
        value,
        max_discount,
        minimum_fare,
        usage_limit,
        used_count,
        DATE_FORMAT(expiration_date, '%Y-%m-%d %H:%i:%s') AS expiration_date,
        is_active
      FROM promo_codes
      WHERE ${whereClause}
      LIMIT 1
    `,
    [whereValue]
  );

  return rows[0] || null;
}

function validatePromoRecord(promo, currentFare = null) {
  if (!promo) {
    return 'Invalid promo code.';
  }
  if (Number(promo.is_active || 0) !== 1) {
    return 'This promo is no longer active.';
  }
  if (promo.expiration_date && new Date(promo.expiration_date).getTime() < Date.now()) {
    return 'This promo has expired.';
  }
  if (promo.usage_limit != null && Number(promo.used_count || 0) >= Number(promo.usage_limit)) {
    return 'This promo has already reached its usage limit.';
  }

  const discountDefinitionError = validateDiscountDefinition(promo.type, promo.value, promo.max_discount);
  if (discountDefinitionError) {
    return discountDefinitionError;
  }

  const minimumFareError = validateMinimumFareForFare(promo.minimum_fare, currentFare);
  if (minimumFareError) {
    return minimumFareError;
  }

  return '';
}

function validateVoucherRecord(voucher, completedBookingCount) {
  if (!voucher) {
    return 'Selected voucher is no longer available.';
  }
  if (normalizeStatusUpper(voucher.status) !== 'AVAILABLE') {
    return 'This voucher has already been used.';
  }
  if (voucher.expiration_date && new Date(voucher.expiration_date).getTime() < Date.now()) {
    return 'This voucher has expired.';
  }

  const discountDefinitionError = validateDiscountDefinition(voucher.type, voucher.value, voucher.max_discount);
  if (discountDefinitionError) {
    return discountDefinitionError;
  }

  const requiredCompletedBookings = Number(voucher.grant_milestone_completed_bookings || CUSTOMER_REWARD_RULES[0]?.completedCount || 5);
  if (Number(completedBookingCount || 0) < requiredCompletedBookings) {
    return `Vouchers unlock after ${requiredCompletedBookings} completed bookings.`;
  }

  return '';
}

async function getApprovedDiscountEligibility(userId, connection = db) {
  const [approvedRows] = await connection.query(
    `
      SELECT request_id, type, status
      FROM discount_requests
      WHERE user_id = ?
        AND status = 'APPROVED'
      ORDER BY reviewed_at DESC, request_id DESC
      LIMIT 1
    `,
    [userId]
  );
  const [activeRows] = await connection.query(
    `
      SELECT request_id, type, status
      FROM discount_requests
      WHERE user_id = ?
      ORDER BY submitted_at DESC, request_id DESC
      LIMIT 1
    `,
    [userId]
  );

  return {
    approved: approvedRows[0] || null,
    latest: activeRows[0] || null
  };
}

function calculateDiscountSnapshot({
  originalFare,
  voucher = null,
  promo = null,
  specialDiscountApproved = null,
  applySpecialDiscount = false
}) {
  const baseFare = parseMoney(originalFare) || 0;
  if (baseFare <= 0) {
    return {
      originalFare: 0,
      discountAmount: 0,
      finalFare: 0,
      discountType: null,
      discountValue: null,
      maxDiscount: null,
      voucherId: null,
      promoId: null,
      promoCode: null,
      applySpecialDiscount: false
    };
  }

  if (voucher) {
    const type = normalizeStatusUpper(voucher.type);
    const discountAmount = type === 'PERCENTAGE'
      ? computePercentageDiscount(baseFare, parseMoney(voucher.value) || 0, parseMoney(voucher.max_discount))
      : roundCurrency(Math.min(baseFare, parseMoney(voucher.value) || 0));
    return {
      originalFare: baseFare,
      discountAmount,
      finalFare: roundCurrency(Math.max(0, baseFare - discountAmount)),
      discountType: type,
      discountValue: parseMoney(voucher.value),
      maxDiscount: parseMoney(voucher.max_discount),
      voucherId: voucher.voucher_id,
      promoId: null,
      promoCode: null,
      applySpecialDiscount: false
    };
  }

  if (promo) {
    const type = normalizeStatusUpper(promo.type);
    const discountAmount = type === 'PERCENTAGE'
      ? computePercentageDiscount(baseFare, parseMoney(promo.value) || 0, parseMoney(promo.max_discount))
      : roundCurrency(Math.min(baseFare, parseMoney(promo.value) || 0));
    return {
      originalFare: baseFare,
      discountAmount,
      finalFare: roundCurrency(Math.max(0, baseFare - discountAmount)),
      discountType: type,
      discountValue: parseMoney(promo.value),
      maxDiscount: parseMoney(promo.max_discount),
      voucherId: null,
      promoId: promo.promo_id,
      promoCode: promo.code,
      applySpecialDiscount: false
    };
  }

  if (applySpecialDiscount && specialDiscountApproved) {
    const discountAmount = computePercentageDiscount(baseFare, SPECIAL_DISCOUNT_RATE, null);
    return {
      originalFare: baseFare,
      discountAmount,
      finalFare: roundCurrency(Math.max(0, baseFare - discountAmount)),
      discountType: specialDiscountApproved.type,
      discountValue: SPECIAL_DISCOUNT_RATE,
      maxDiscount: null,
      voucherId: null,
      promoId: null,
      promoCode: null,
      applySpecialDiscount: true
    };
  }

  return {
    originalFare: baseFare,
    discountAmount: 0,
    finalFare: baseFare,
    discountType: null,
    discountValue: null,
    maxDiscount: null,
    voucherId: null,
    promoId: null,
    promoCode: null,
    applySpecialDiscount: false
  };
}

async function getCompletedCustomerBookingCount(userId, connection = db) {
  const [rows] = await connection.query(
    `
      SELECT COUNT(*) AS completed_count
      FROM booking
      WHERE user_id = ?
        AND status = 'Completed'
    `,
    [userId]
  );
  return Number(rows[0]?.completed_count || 0);
}

async function grantCustomerRewardVoucherIfEligible(userId, completedCount, connection = db) {
  const matchingRule = [...CUSTOMER_REWARD_RULES]
    .sort((left, right) => right.completedCount - left.completedCount)
    .find((rule) => completedCount >= rule.completedCount);
  if (!matchingRule) {
    return null;
  }

  const columns = await getCustomerVoucherColumns(connection);
  const existingQuery = hasCustomerVoucherColumn(columns, 'grant_milestone_completed_bookings')
    ? `
        SELECT voucher_id
        FROM customer_vouchers
        WHERE user_id = ?
          AND grant_milestone_completed_bookings = ?
        LIMIT 1
      `
    : `
        SELECT voucher_id
        FROM customer_vouchers
        WHERE user_id = ?
          AND UPPER(TRIM(type)) = ?
          AND value = ?
          AND (max_discount <=> ?)
        LIMIT 1
      `;
  const existingParams = hasCustomerVoucherColumn(columns, 'grant_milestone_completed_bookings')
    ? [userId, matchingRule.completedCount]
    : [userId, normalizeStatusUpper(matchingRule.type), matchingRule.value, matchingRule.maxDiscount ?? null];

  const [existingRows] = await connection.query(existingQuery, existingParams);
  if (existingRows.length > 0) {
    return null;
  }

  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + 30);

  const insertColumns = ['user_id', 'type', 'value', 'max_discount'];
  const insertValues = [userId, matchingRule.type, matchingRule.value, matchingRule.maxDiscount];
  const insertPlaceholders = ['?', '?', '?', '?'];

  if (hasCustomerVoucherColumn(columns, 'grant_milestone_completed_bookings')) {
    insertColumns.push('grant_milestone_completed_bookings');
    insertPlaceholders.push('?');
    insertValues.push(matchingRule.completedCount);
  }
  if (hasCustomerVoucherColumn(columns, 'status')) {
    insertColumns.push('status');
    insertPlaceholders.push('?');
    insertValues.push('AVAILABLE');
  } else if (hasCustomerVoucherColumn(columns, 'is_used')) {
    insertColumns.push('is_used');
    insertPlaceholders.push('?');
    insertValues.push(0);
  }
  if (hasCustomerVoucherColumn(columns, 'expiration_date')) {
    insertColumns.push('expiration_date');
    insertPlaceholders.push('?');
    insertValues.push(toMysqlDateTime(expirationDate));
  }
  if (hasCustomerVoucherColumn(columns, 'created_at')) {
    insertColumns.push('created_at');
    insertPlaceholders.push('NOW()');
  }
  if (hasCustomerVoucherColumn(columns, 'redeemed_at')) {
    insertColumns.push('redeemed_at');
    insertPlaceholders.push('NULL');
  }
  if (hasCustomerVoucherColumn(columns, 'notified_at')) {
    insertColumns.push('notified_at');
    insertPlaceholders.push('NULL');
  }

  const [result] = await connection.query(
    `
      INSERT INTO customer_vouchers (${insertColumns.join(', ')})
      VALUES (${insertPlaceholders.join(', ')})
    `,
    insertValues
  );

  return {
    voucher_id: result.insertId,
    grant_milestone_completed_bookings: matchingRule.completedCount,
    completedCount: matchingRule.completedCount,
    type: matchingRule.type,
    value: matchingRule.value,
    max_discount: matchingRule.maxDiscount,
    status: 'AVAILABLE',
    notified_at: null
  };
}

function emitBookingUpdate(bookingId, payload) {
  io.emit('booking:updated', { booking_id: bookingId, ...payload });
  io.to(`booking:${bookingId}`).emit('booking:updated', { booking_id: bookingId, ...payload });
}

function emitNotification(userId, payload) {
  io.to(`user:${userId}`).emit('notification:new', payload);
}

function upsertDriverLiveLocation(bookingId, driverId, latitude, longitude) {
  const normalizedLatitude = Number.parseFloat(latitude);
  const normalizedLongitude = Number.parseFloat(longitude);
  if (!Number.isFinite(normalizedLatitude) || !Number.isFinite(normalizedLongitude)) {
    return null;
  }

  const location = {
    driver_id: driverId,
    booking_id: bookingId,
    latitude: Number(normalizedLatitude.toFixed(6)),
    longitude: Number(normalizedLongitude.toFixed(6)),
    updated_at: new Date().toISOString()
  };

  driverLiveLocations.set(bookingId, location);
  io.emit('driver:location', location);
  io.to(`booking:${bookingId}`).emit('driver:location', location);
  return location;
}

function getDriverLiveLocation(bookingId) {
  return driverLiveLocations.get(bookingId) || null;
}

function clearDriverLiveLocation(bookingId) {
  driverLiveLocations.delete(bookingId);
}

async function persistDriverLiveLocation(bookingId, driverId, latitude, longitude, connection = db) {
  const [rows] = await connection.query(
    'SELECT trip_map FROM booking WHERE booking_id = ? LIMIT 1',
    [bookingId]
  );
  if (!rows.length) {
    return null;
  }

  const tripPayload = parseBookingTripPayload(rows[0].trip_map);
  tripPayload.driver_latitude = Number(Number.parseFloat(latitude).toFixed(6));
  tripPayload.driver_longitude = Number(Number.parseFloat(longitude).toFixed(6));
  tripPayload.driver_updated_at = new Date().toISOString();

  await connection.query(
    'UPDATE booking SET trip_map = ? WHERE booking_id = ?',
    [JSON.stringify(tripPayload), bookingId]
  );

  return upsertDriverLiveLocation(bookingId, driverId, latitude, longitude);
}

async function createNotification(userId, message) {
  const [result] = await db.query(
    `INSERT INTO notifications (user_id, message, status, created_at)
     VALUES (?, ?, 'Unread', NOW())`,
    [userId, message]
  );

  emitNotification(userId, {
    notification_id: result.insertId,
    user_id: userId,
    message,
    status: 'Unread'
  });

  return result.insertId;
}

async function getApprovedDriver(driverId, connection = db) {
  const [rows] = await connection.query(
    `
      SELECT d.driver_id, d.user_id, v.vehicle_type
      FROM drivers d
      LEFT JOIN vehicles v ON v.driver_id = d.driver_id
      WHERE d.driver_id = ?
        AND UPPER(TRIM(d.approval_status)) = 'APPROVED'
      LIMIT 1
    `,
    [driverId]
  );

  return rows.length > 0 ? rows[0] : null;
}

async function driverHasActiveBooking(driverId, bookingIdToIgnore = null, connection = db) {
  const params = [driverId, ...ACTIVE_BOOKING_STATUSES];
  let query = `
    SELECT booking_id
    FROM booking
    WHERE driver_id = ?
      AND status IN (?, ?)
  `;

  if (bookingIdToIgnore) {
    query += ' AND booking_id <> ?';
    params.push(bookingIdToIgnore);
  }

  query += ' LIMIT 1';

  const [rows] = await connection.query(query, params);
  return rows.length > 0;
}

io.on('connection', (socket) => {
  socket.on('join:user', (userId) => {
    socket.join(`user:${userId}`);
  });

  socket.on('join:booking', (bookingId) => {
    socket.join(`booking:${bookingId}`);
  });
});

app.get('/test', async (req, res) => {
  try {
    const connection = await db.getConnection();
    connection.release();
    res.json({ message: 'Backend working with all tables!' });
  } catch (error) {
    res.status(500).json({ error: 'Database connection failed' });
  }
});

app.post('/signup', async (req, res) => {
  try {
    const { first_name, last_name, email_address, password } = req.body;
    if (!first_name || !last_name || !email_address || !password) {
      return res.status(400).json({ error: 'Required fields missing' });
    }
    if (!isValidEmail(email_address)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const [existingUsers] = await db.query(
      'SELECT user_id FROM users WHERE email_address = ?',
      [email_address.trim()]
    );
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const userCode = generateUserCode();

    const [result] = await db.query(
      `
        INSERT INTO users (
          user_code,
          first_name,
          last_name,
          email_address,
          password,
          account_type,
          profile_complete
        )
        VALUES (?, ?, ?, ?, ?, 'Customer', FALSE)
      `,
      [userCode, first_name.trim(), last_name.trim(), email_address.trim(), hashedPassword]
    );

    res.status(201).json({
      message: 'Account created successfully!',
      user_id: result.insertId,
      user_code: userCode
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email_address, password } = req.body;
    if (!email_address || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!isValidEmail(email_address)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const [results] = await db.query(
      `
        SELECT user_id, user_code, first_name, last_name, email_address, phone, phone_verified, applied, password, account_type, profile_complete
        FROM users
        WHERE email_address = ?
      `,
      [email_address.trim()]
    );

    if (results.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = results[0];
    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    delete user.password;
    res.json(user);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/profile/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const [results] = await db.query(
      `
        SELECT user_id, user_code, first_name, middle_name, last_name, extension,
               DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth, gender,
               email_address, phone, phone_verified, address, city, region, zip_code, account_type, profile_complete, applied, picture
        FROM users
        WHERE user_id = ?
      `,
      [userId]
    );

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    results[0].picture = normalizeUserPicture(results[0].picture);
    res.json(results[0]);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/profile/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const profile = {
      first_name: String(req.body.first_name || '').trim(),
      middle_name: String(req.body.middle_name || '').trim(),
      last_name: String(req.body.last_name || '').trim(),
      extension: String(req.body.extension || '').trim(),
      date_of_birth: normalizeDateOnly(req.body.date_of_birth),
      gender: String(req.body.gender || '').trim(),
      email_address: String(req.body.email_address || '').trim(),
      phone: String(req.body.phone || '').trim(),
      address: String(req.body.address || '').trim(),
      city: String(req.body.city || '').trim(),
      region: String(req.body.region || '').trim(),
      zip_code: String(req.body.zip_code || '').trim(),
      phone_verified: Number(req.body.phone_verified) === 1 ? 1 : 0,
      picture: String(req.body.picture || '').trim()
    };

    if (!profile.first_name || !profile.last_name || !profile.email_address) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }
    if (!isValidEmail(profile.email_address)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (profile.phone && !PHONE_REGEX.test(profile.phone)) {
      return res.status(400).json({ error: 'Phone must be stored in +63 format' });
    }
    if (profile.gender && !PROFILE_GENDER_OPTIONS.includes(profile.gender)) {
      return res.status(400).json({ error: 'Gender value is not allowed by the database' });
    }
    if (profile.region && !PROFILE_REGION_OPTIONS.includes(profile.region)) {
      return res.status(400).json({ error: 'Region value is not allowed by the database' });
    }

    const [existingUsers] = await db.query(
      'SELECT user_id FROM users WHERE email_address = ? AND user_id <> ?',
      [profile.email_address, userId]
    );
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const profileComplete = isProfileComplete(profile) ? 1 : 0;

    const [updateResult] = await db.query(
      `
        UPDATE users
        SET first_name = ?,
            middle_name = ?,
            last_name = ?,
            extension = ?,
            date_of_birth = ?,
            gender = ?,
            email_address = ?,
            phone = ?,
            address = ?,
            city = ?,
            region = ?,
            zip_code = ?,
            phone_verified = ?,
            picture = ?,
            profile_complete = ?
        WHERE user_id = ?
      `,
      [
        profile.first_name,
        profile.middle_name || null,
        profile.last_name,
        profile.extension || null,
        profile.date_of_birth || null,
        profile.gender || null,
        profile.email_address,
        profile.phone || null,
        profile.address || null,
        profile.city || null,
        profile.region || null,
        profile.zip_code || null,
        profile.phone_verified,
        profile.picture || null,
        profileComplete,
        userId
      ]
    );

    if (!updateResult.affectedRows) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [updatedRows] = await db.query(
      `
        SELECT user_id, user_code, first_name, middle_name, last_name, extension,
               DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth, gender,
               email_address, phone, phone_verified, address, city, region, zip_code, account_type, profile_complete, applied, picture
        FROM users
        WHERE user_id = ?
      `,
      [userId]
    );

    if (!updatedRows.length) {
      return res.status(404).json({ error: 'Updated profile could not be reloaded' });
    }

    updatedRows[0].picture = normalizeUserPicture(updatedRows[0].picture);
    res.json({ message: 'Profile updated successfully', profile: updatedRows[0] });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: error.sqlMessage || error.message || 'Profile update failed' });
  }
});


app.put('/profile/:user_id/phone-verification', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const phone = String(req.body.phone || '').trim();
    const phoneVerified = Number(req.body.phone_verified) === 1 ? 1 : 0;
    if (!phone || !PHONE_REGEX.test(phone)) {
      return res.status(400).json({ error: 'Phone must be stored in +63 format' });
    }

    const [updateResult] = await db.query(
      `
        UPDATE users
        SET phone = ?,
            phone_verified = ?
        WHERE user_id = ?
      `,
      [phone, phoneVerified, userId]
    );

    if (!updateResult.affectedRows) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [updatedRows] = await db.query(
      `
        SELECT user_id, user_code, first_name, middle_name, last_name, extension,
               DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth, gender,
               email_address, phone, phone_verified, address, city, region, zip_code, account_type, profile_complete, applied, picture
        FROM users
        WHERE user_id = ?
      `,
      [userId]
    );

    if (!updatedRows.length) {
      return res.status(404).json({ error: 'Updated profile could not be reloaded' });
    }

    updatedRows[0].picture = normalizeUserPicture(updatedRows[0].picture);
    res.json({ message: 'Phone verification updated successfully', profile: updatedRows[0] });
  } catch (error) {
    console.error('Phone verification update error:', error);
    res.status(500).json({ error: error.sqlMessage || error.message || 'Phone verification update failed' });
  }
});

app.post('/drivers/apply', async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      user_id,
      license_number,
      license_expiry_date,
      license_type,
      restriction_code,
      id_picture_front,
      id_picture_back,
      picture,
      vehicle_type,
      plate_number,
      model,
      color,
      capacity
    } = req.body;

    const application = {
      user_id: parseId(user_id),
      license_number: String(license_number || '').trim().toUpperCase(),
      license_expiry_date: normalizeDateOnly(license_expiry_date),
      license_type: String(license_type || '').trim(),
      restriction_code: String(restriction_code || '').trim(),
      id_picture_front: String(id_picture_front || '').trim(),
      id_picture_back: String(id_picture_back || '').trim(),
      picture: String(picture || '').trim(),
      vehicle_type: String(vehicle_type || '').trim(),
      plate_number: String(plate_number || '').trim(),
      model: String(model || '').trim(),
      color: String(color || '').trim(),
      capacity: capacity == null || capacity === '' ? null : Number(capacity)
    };

    if (
      !application.user_id ||
      !application.license_number ||
      !application.license_expiry_date ||
      !application.license_type ||
      !application.restriction_code ||
      !application.id_picture_front ||
      !application.id_picture_back ||
      !application.picture ||
      !application.vehicle_type ||
      !application.plate_number
    ) {
      connection.release();
      return res.status(400).json({ error: 'Required driver, image, or vehicle fields are missing' });
    }

    const [users] = await connection.query(
      `
        SELECT user_id, profile_complete, applied
        FROM users
        WHERE user_id = ?
      `,
      [application.user_id]
    );
    if (users.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'User not found' });
    }
    if (!users[0].profile_complete) {
      connection.release();
      return res.status(400).json({ error: 'Complete your profile before applying as a driver' });
    }
    if (Number(users[0].applied) === 1) {
      connection.release();
      return res.status(400).json({ error: 'Driver application already exists for this user', approval_status: 'Pending' });
    }

    await connection.beginTransaction();

    const [existingPending] = await connection.query(
      `
        SELECT driver_id, approval_status
        FROM drivers
        WHERE user_id = ?
          AND UPPER(TRIM(approval_status)) = 'PENDING'
        ORDER BY driver_id DESC
        LIMIT 1
      `,
      [application.user_id]
    );
    if (existingPending.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'You already have a pending driver application', approval_status: existingPending[0].approval_status });
    }

    const [existingApproved] = await connection.query(
      `
        SELECT driver_id, approval_status
        FROM drivers
        WHERE user_id = ?
          AND UPPER(TRIM(approval_status)) = 'APPROVED'
        ORDER BY driver_id DESC
        LIMIT 1
      `,
      [application.user_id]
    );
    if (existingApproved.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'This user is already an approved driver', approval_status: existingApproved[0].approval_status });
    }

    const [duplicateLicense] = await connection.query(
      `
        SELECT driver_id, user_id
        FROM drivers
        WHERE UPPER(TRIM(license_number)) = ?
          AND user_id <> ?
        LIMIT 1
      `,
      [application.license_number, application.user_id]
    );
    if (duplicateLicense.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'That license number is already used by another driver application' });
    }

    const [driverResult] = await connection.query(
      `
        INSERT INTO drivers (
          user_id,
          license_number,
          license_expiry_date,
          license_type,
          restriction_code,
          id_picture_front,
          id_picture_back,
          picture,
          approval_status,
          date_applied
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)
      `,
      [
        application.user_id,
        application.license_number,
        application.license_expiry_date,
        application.license_type,
        application.restriction_code,
        application.id_picture_front,
        application.id_picture_back,
        application.picture,
        toMysqlDate()
      ]
    );

    const driverId = driverResult.insertId;
    await connection.query(
      `
        INSERT INTO vehicles (driver_id, vehicle_type, plate_number, model, color, capacity)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [driverId, application.vehicle_type, application.plate_number, application.model || null, application.color || null, application.capacity]
    );
    await connection.query(
      `
        UPDATE users
        SET applied = 1
        WHERE user_id = ?
      `,
      [application.user_id]
    );

    await connection.commit();
    connection.release();

    res.status(201).json({ message: 'Driver application submitted', driver_id: driverId, approval_status: 'Pending' });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
    }
    connection.release();
    console.error('Driver apply error:', error);
    res.status(500).json({ error: error.sqlMessage || error.message || 'Driver application failed' });
  }
});

app.get('/drivers/application/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          d.driver_id,
          d.user_id,
          d.license_number,
          DATE_FORMAT(d.license_expiry_date, '%Y-%m-%d') AS license_expiry_date,
          d.license_type,
          d.restriction_code,
          d.id_picture_front,
          d.id_picture_back,
          d.picture,
          CASE
            WHEN UPPER(TRIM(d.approval_status)) = 'PENDING' THEN 'Pending'
            WHEN UPPER(TRIM(d.approval_status)) = 'APPROVED' THEN 'Approved'
            WHEN UPPER(TRIM(d.approval_status)) = 'REJECTED' THEN 'Rejected'
            ELSE d.approval_status
          END AS approval_status,
          DATE_FORMAT(d.date_applied, '%Y-%m-%d %H:%i:%s') AS date_applied,
          DATE_FORMAT(d.date_approved, '%Y-%m-%d %H:%i:%s') AS date_approved,
          v.vehicle_type,
          v.plate_number,
          v.model,
          v.color,
          v.capacity
        FROM drivers d
        LEFT JOIN vehicles v ON v.driver_id = d.driver_id
        WHERE d.user_id = ?
        ORDER BY d.driver_id DESC
        LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Driver application not found' });
    }

    const application = rows[0];
    res.json({
      ...application,
      id_picture_front: normalizeStoredAsset(application.id_picture_front),
      id_picture_back: normalizeStoredAsset(application.id_picture_back),
      picture: normalizeStoredAsset(application.picture)
    });
  } catch (error) {
    console.error('Driver application status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/booking/create', async (req, res) => {
  try {
    const {
      user_id,
      pick_location,
      destination,
      estimated_distance,
      estimated_fare,
      original_fare,
      discount_amount,
      vehicle_type,
      pickup_coordinates,
      destination_coordinates,
      voucher_id,
      promo_id,
      promo_code,
      apply_special_discount
    } = req.body;
    const normalizedVoucherId = parseId(voucher_id);
    const normalizedPromoId = parseId(promo_id);
    const normalizedPromoCode = String(promo_code || '').trim() || null;
    const wantsSpecialDiscount = apply_special_discount === true || String(apply_special_discount).toLowerCase() === 'true';

    if (!user_id || !pick_location || !destination) {
      return res.status(400).json({ error: 'Required booking fields missing' });
    }

    const userId = parseId(user_id);
    const baseOriginalFare = parseMoney(original_fare) ?? parseMoney(estimated_fare);
    if (!userId || baseOriginalFare == null || baseOriginalFare <= 0) {
      return res.status(400).json({ error: 'Valid booking fare details are required' });
    }

    const selectedVoucher = normalizedVoucherId ? await getAvailableCustomerVoucher(userId, normalizedVoucherId) : null;
    if (normalizedVoucherId && !selectedVoucher) {
      return res.status(400).json({ error: 'Selected voucher is no longer available.' });
    }

    const selectedPromo = normalizedPromoId || normalizedPromoCode
      ? await getActivePromoRecord({ promoId: normalizedPromoId, code: normalizedPromoCode })
      : null;
    if (normalizedPromoId || normalizedPromoCode) {
      const promoValidationError = validatePromoRecord(selectedPromo);
      if (promoValidationError) {
        return res.status(400).json({ error: promoValidationError });
      }

      const [existingRedemptions] = await db.query(
        `
          SELECT redemption_id
          FROM promo_redemptions
          WHERE promo_id = ?
            AND user_id = ?
          LIMIT 1
        `,
        [selectedPromo.promo_id, userId]
      );
      if (existingRedemptions.length > 0) {
        return res.status(400).json({ error: 'Promo code has already been used by this user.' });
      }
    }

    const discountEligibility = wantsSpecialDiscount
      ? await getApprovedDiscountEligibility(userId)
      : { approved: null };
    const discountSnapshot = calculateDiscountSnapshot({
      originalFare: baseOriginalFare,
      voucher: selectedVoucher,
      promo: selectedPromo,
      specialDiscountApproved: discountEligibility.approved,
      applySpecialDiscount: wantsSpecialDiscount
    });

    const tripPayload = buildBookingTripPayload({
      pickup_coordinates,
      destination_coordinates,
      vehicle_type,
      original_fare: discountSnapshot.originalFare,
      discount_amount: discountSnapshot.discountAmount,
      final_fare: discountSnapshot.finalFare,
      voucher_id: discountSnapshot.voucherId,
      promo_id: discountSnapshot.promoId,
      promo_code: discountSnapshot.promoCode,
      apply_special_discount: discountSnapshot.applySpecialDiscount,
      discount_type: discountSnapshot.discountType,
      discount_value: discountSnapshot.discountValue,
      max_discount: discountSnapshot.maxDiscount
    });

    const [result] = await db.query(
      `
        INSERT INTO booking (user_id, pick_location, destination, estimated_distance, estimated_fare, status, trip_map)
        VALUES (?, ?, ?, ?, ?, 'Pending', ?)
      `,
      [
        userId,
        pick_location,
        destination,
        estimated_distance || null,
        discountSnapshot.finalFare,
        JSON.stringify(tripPayload)
      ]
    );

    const bookingId = result.insertId;
    await createNotification(userId, 'Your booking request is now waiting for available drivers.');
    emitBookingUpdate(bookingId, {
      status: 'Pending',
      driver_id: null,
      assignment: 'queued'
    });

    res.status(201).json({
      booking_id: bookingId,
      status: 'Pending',
      driver_id: null,
      queued: true,
      original_fare: discountSnapshot.originalFare,
      discount_amount: discountSnapshot.discountAmount,
      final_fare: discountSnapshot.finalFare
    });
  } catch (error) {
    console.error('Booking create error:', error);
    res.status(500).json({ error: 'Booking failed' });
  }
});

app.get('/booking/user/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          b.booking_id,
          b.user_id,
          b.driver_id,
          b.pick_location,
          b.destination,
          b.estimated_distance,
          b.estimated_fare,
          b.trip_map,
          b.status,
          t.transaction_id,
          t.final_fare,
          DATE_FORMAT(t.payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date,
          t.total_time,
          cu.user_code,
          CONCAT_WS(' ', NULLIF(TRIM(du.first_name), ''), NULLIF(TRIM(du.last_name), '')) AS driver_name,
          du.user_code AS driver_code,
          du.phone AS driver_phone,
          du.picture AS driver_picture,
          v.vehicle_type,
          v.plate_number
        FROM booking b
        LEFT JOIN \`transaction\` t ON t.booking_id = b.booking_id
        LEFT JOIN drivers d ON d.driver_id = b.driver_id
        LEFT JOIN users cu ON cu.user_id = b.user_id
        LEFT JOIN users du ON du.user_id = d.user_id
        LEFT JOIN vehicles v ON v.driver_id = d.driver_id
        WHERE b.user_id = ?
        ORDER BY b.booking_id DESC
      `,
      [userId]
    );

    const mappedRows = rows.map((row) => {
      const tripPayload = parseBookingTripPayload(row.trip_map);
      return {
        ...row,
        driver_picture: normalizeStoredAsset(row.driver_picture),
        vehicle_type: row.vehicle_type || tripPayload.vehicle_type || null,
        plate_number: row.plate_number || null,
        original_fare: parseMoney(tripPayload.original_fare),
        discount_amount: parseMoney(tripPayload.discount_amount),
        pickup_latitude: tripPayload.pickup_latitude ?? null,
        pickup_longitude: tripPayload.pickup_longitude ?? null,
        destination_latitude: tripPayload.destination_latitude ?? null,
        destination_longitude: tripPayload.destination_longitude ?? null
      };
    });

    res.json(mappedRows);
  } catch (error) {
    console.error('User booking history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/booking/driver/:driver_id', async (req, res) => {
  try {
    const driverId = parseId(req.params.driver_id);
    if (!driverId) {
      return res.status(400).json({ error: 'Invalid driver_id' });
    }

    const driver = await getApprovedDriver(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found or not approved' });
    }
    const wallet = await getDriverWalletSummary(driverId);

    const [rows] = await db.query(
      `
        SELECT
          b.booking_id,
          b.user_id,
          b.driver_id,
          b.pick_location,
          b.destination,
          b.estimated_distance,
          b.estimated_fare,
          b.status,
          b.trip_map,
          t.transaction_id,
          t.final_fare,
          DATE_FORMAT(t.payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date,
          t.total_time,
          u.user_code,
          CONCAT_WS(' ', NULLIF(TRIM(u.first_name), ''), NULLIF(TRIM(u.last_name), '')) AS customer_name,
          u.first_name AS customer_first_name,
          u.last_name AS customer_last_name,
          u.email_address AS customer_email,
          u.phone AS customer_phone,
          u.picture AS customer_picture
        FROM booking b
        INNER JOIN users u ON u.user_id = b.user_id
        LEFT JOIN \`transaction\` t ON t.booking_id = b.booking_id
        WHERE b.driver_id = ?
           OR (b.driver_id IS NULL AND UPPER(TRIM(b.status)) = 'PENDING')
        ORDER BY CASE WHEN b.driver_id = ? THEN 0 ELSE 1 END, b.booking_id DESC
      `,
      [driverId, driverId]
    );

    const compatibleVehicleType = String(driver.vehicle_type || '').trim().toLowerCase();
    const mappedRows = rows
      .map((row) => {
        const tripPayload = parseBookingTripPayload(row.trip_map);
        return {
          ...row,
          customer_picture: normalizeStoredAsset(row.customer_picture),
          vehicle_type: tripPayload.vehicle_type || null,
          original_fare: parseMoney(tripPayload.original_fare),
          discount_amount: parseMoney(tripPayload.discount_amount),
          discount_type: tripPayload.discount_type || null,
          discount_value: parseMoney(tripPayload.discount_value),
          max_discount: parseMoney(tripPayload.max_discount),
          pickup_latitude: tripPayload.pickup_latitude ?? null,
          pickup_longitude: tripPayload.pickup_longitude ?? null,
          destination_latitude: tripPayload.destination_latitude ?? null,
          destination_longitude: tripPayload.destination_longitude ?? null
        };
      })
      .filter((row) => {
        if (row.driver_id === driverId) {
          return true;
        }

        if (!compatibleVehicleType) {
          return true;
        }

        const requestedVehicleType = String(row.vehicle_type || '').trim().toLowerCase();
        const vehicleMatches = !requestedVehicleType || requestedVehicleType === compatibleVehicleType;
        if (!vehicleMatches) {
          return false;
        }

        return true;
      });

    res.json(mappedRows);
  } catch (error) {
    console.error('Driver booking history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/booking/:id/status', async (req, res) => {
  try {
    const bookingId = parseId(req.params.id);
    if (!bookingId) {
      return res.status(400).json({ error: 'Invalid booking_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          b.booking_id,
          b.driver_id,
          b.status,
          b.trip_map,
          CONCAT_WS(' ', NULLIF(TRIM(u.first_name), ''), NULLIF(TRIM(u.last_name), '')) AS driver_name,
          u.phone AS driver_phone,
          u.picture AS driver_picture,
          v.vehicle_type,
          v.plate_number,
          tr.final_fare,
          tr.total_time,
          pc.amount AS commission_fee
        FROM booking b
        LEFT JOIN drivers d ON d.driver_id = b.driver_id
        LEFT JOIN users u ON u.user_id = d.user_id
        LEFT JOIN vehicles v ON v.driver_id = d.driver_id
        LEFT JOIN \`transaction\` tr ON tr.booking_id = b.booking_id
        LEFT JOIN platform_commissions pc ON pc.booking_id = b.booking_id
        WHERE b.booking_id = ?
        LIMIT 1
      `,
      [bookingId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = rows[0];
    const tripPayload = parseBookingTripPayload(booking.trip_map);
    const liveLocation = getDriverLiveLocation(booking.booking_id) || (
      Number.isFinite(Number.parseFloat(tripPayload.driver_latitude)) &&
      Number.isFinite(Number.parseFloat(tripPayload.driver_longitude))
        ? {
            latitude: Number(Number.parseFloat(tripPayload.driver_latitude).toFixed(6)),
            longitude: Number(Number.parseFloat(tripPayload.driver_longitude).toFixed(6))
          }
        : null
    );

    const discountAmount = parseMoney(tripPayload.discount_amount) || 0;
    const totalDistanceKm = parseMoney(tripPayload.total_distance_km) || parseMoney(booking.estimated_distance) || 0;
    const commissionFee = parseMoney(booking.commission_fee) || 0;
    const finalFare = parseMoney(booking.final_fare) || parseMoney(tripPayload.final_fare) || 0;

    res.json({
      booking_id: booking.booking_id,
      status: booking.status,
      driver_name: booking.driver_name,
      driver_phone: booking.driver_phone,
      driver_picture: normalizeStoredAsset(booking.driver_picture),
      vehicle_type: booking.vehicle_type,
      plate_number: booking.plate_number,
      original_fare: parseMoney(tripPayload.original_fare) || null,
      discount_amount: discountAmount > 0 ? discountAmount : 0,
      final_fare: finalFare > 0 ? finalFare : null,
      total_time: booking.total_time || tripPayload.total_time || null,
      total_distance_km: totalDistanceKm > 0 ? totalDistanceKm : null,
      commission_fee: commissionFee > 0 ? commissionFee : null,
      driver_profit: finalFare > 0 ? roundCurrency(Math.max(0, finalFare - commissionFee)) : null,
      driver_latitude: liveLocation?.latitude ?? null,
      driver_longitude: liveLocation?.longitude ?? null
    });
  } catch (error) {
    console.error('Booking status fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/booking/:id/status', async (req, res) => {
  try {
    const bookingId = parseId(req.params.id);
    const normalizedStatus = normalizeBookingStatus(req.body?.status);
    const requestedDriverId = parseId(req.body?.driver_id);

    if (!bookingId) {
      return res.status(400).json({ error: 'Invalid booking_id' });
    }
    if (!isAllowedBookingStatus(normalizedStatus)) {
      return res.status(400).json({ error: 'Invalid booking status' });
    }

    const [bookingRows] = await db.query(
      'SELECT booking_id, user_id, driver_id, status FROM booking WHERE booking_id = ?',
      [bookingId]
    );
    if (bookingRows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingRows[0];
    let assignedDriverId = booking.driver_id || null;
    let driverUserId = null;
    let updateQuery = 'UPDATE booking SET status = ? WHERE booking_id = ?';
    let updateParams = [normalizedStatus, bookingId];

    if (normalizedStatus === 'Accepted') {
      if (!requestedDriverId) {
        return res.status(400).json({ error: 'driver_id is required when accepting a booking' });
      }

      const driver = await getApprovedDriver(requestedDriverId);
      if (!driver) {
        return res.status(404).json({ error: 'Approved driver not found' });
      }

      const currentStatus = normalizeBookingStatus(booking.status);
      if (booking.driver_id && booking.driver_id !== driver.driver_id) {
        return res.status(409).json({ error: 'Booking is already assigned to another driver' });
      }
      if (currentStatus !== 'Pending' && !(currentStatus === 'Accepted' && booking.driver_id === driver.driver_id)) {
        return res.status(409).json({ error: 'Only pending bookings can be accepted manually' });
      }
      if (!booking.driver_id && await driverHasActiveBooking(driver.driver_id, bookingId)) {
        return res.status(409).json({ error: 'Driver already has an active booking' });
      }

      const wallet = await getDriverWalletSummary(driver.driver_id);
      if (!canWalletCoverBooking(wallet, booking.estimated_fare)) {
        return res.status(409).json({ error: 'Insufficient wallet balance. Please top up before accepting bookings.' });
      }

      assignedDriverId = driver.driver_id;
      driverUserId = driver.user_id;
      updateQuery = `
        UPDATE booking
        SET status = ?, driver_id = ?
        WHERE booking_id = ?
          AND (driver_id IS NULL OR driver_id = ?)
      `;
      updateParams = [normalizedStatus, assignedDriverId, bookingId, assignedDriverId];
    }

    const [updateResult] = await db.query(updateQuery, updateParams);

    if (!updateResult.affectedRows) {
      return res.status(409).json({ error: 'Booking status update did not change any rows' });
    }

    if (normalizedStatus === 'Completed' || normalizedStatus === 'Cancelled' || normalizedStatus === 'Rejected') {
        clearDriverLiveLocation(bookingId);
      }

    if (normalizedStatus === 'Accepted' && driverUserId) {
      await createNotification(driverUserId, `You accepted booking #${bookingId}.`);
      await createNotification(booking.user_id, 'Your booking has been accepted by a driver.');
    } else {
      await createNotification(
        booking.user_id,
        `Your booking #${bookingId} is now ${normalizedStatus}.`
      );
    }

    emitBookingUpdate(bookingId, {
      status: normalizedStatus,
      driver_id: assignedDriverId
    });

    res.json({
      success: true,
      message: 'Booking status updated',
      booking_id: bookingId,
      driver_id: assignedDriverId,
      status: normalizedStatus
    });
  } catch (error) {
    console.error('Booking status error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.delete('/booking/:id', async (req, res) => {
  try {
    const bookingId = parseId(req.params.id);
    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'Invalid booking_id' });
    }

    const [bookingRows] = await db.query(
      'SELECT booking_id, user_id, driver_id FROM booking WHERE booking_id = ?',
      [bookingId]
    );
    if (bookingRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const [deleteResult] = await db.query(
      'DELETE FROM booking WHERE booking_id = ?',
      [bookingId]
    );

    if (!deleteResult.affectedRows) {
      return res.status(500).json({ success: false, error: 'Booking delete failed' });
    }

    clearDriverLiveLocation(bookingId);
    await createNotification(bookingRows[0].user_id, `Your booking #${bookingId} has been cancelled.`);
    emitBookingUpdate(bookingId, {
      status: 'Cancelled',
      deleted: true,
      driver_id: bookingRows[0].driver_id || null
    });

    res.json({ success: true, message: 'Booking deleted successfully', booking_id: bookingId });
  } catch (error) {
    console.error('Booking delete error:', error);
    res.status(500).json({ success: false, error: 'Booking delete failed' });
  }
});

app.get('/driver/wallet/:driver_id', async (req, res) => {
  try {
    const driverId = parseId(req.params.driver_id);
    if (!driverId) {
      return res.status(400).json({ error: 'Invalid driver_id' });
    }

    const driver = await getApprovedDriver(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found or not approved' });
    }

    const wallet = await getDriverWalletSummary(driverId);
    const [todayRows] = await db.query(
      `
        SELECT
          COALESCE(SUM(t.final_fare), 0) AS today_gross_earnings,
          COALESCE(SUM(pc.amount), 0) AS today_commission_deducted
        FROM \`transaction\` t
        INNER JOIN booking b ON b.booking_id = t.booking_id
        LEFT JOIN platform_commissions pc ON pc.booking_id = b.booking_id
        WHERE b.driver_id = ?
          AND DATE(t.payment_date) = CURDATE()
      `,
      [driverId]
    );
    const [totalRows] = await db.query(
      `
        SELECT
          COALESCE(SUM(t.final_fare), 0) AS total_gross_earnings,
          COALESCE(SUM(pc.amount), 0) AS total_commission_deducted
        FROM \`transaction\` t
        INNER JOIN booking b ON b.booking_id = t.booking_id
        LEFT JOIN platform_commissions pc ON pc.booking_id = b.booking_id
        WHERE b.driver_id = ?
      `,
      [driverId]
    );
    const todayGross = parseMoney(todayRows[0]?.today_gross_earnings) || 0;
    const todayCommission = parseMoney(todayRows[0]?.today_commission_deducted) || 0;
    const totalGross = parseMoney(totalRows[0]?.total_gross_earnings) || 0;
    const totalCommission = parseMoney(totalRows[0]?.total_commission_deducted) || 0;
    const [[topUpHistory]] = await db.query(
      `
        SELECT COUNT(*) AS top_up_count
        FROM driver_wallet_transactions
        WHERE wallet_id = ?
          AND type = 'TOPUP'
      `,
      [wallet.wallet_id]
    );
    const hasPreviousTopUp = Number(topUpHistory?.top_up_count || 0) > 0;
    const minimumTopUpAmount = hasPreviousTopUp ? LATER_DRIVER_TOP_UP_MINIMUM : FIRST_DRIVER_TOP_UP_MINIMUM;
    const isEligible = wallet.balance > 0;
    res.json({
      ...wallet,
      today_gross_earnings: todayGross,
      today_commission_deducted: todayCommission,
      today_net_earnings: roundCurrency(todayGross - todayCommission),
      total_gross_earnings: totalGross,
      total_commission_deducted: totalCommission,
      total_net_earnings: roundCurrency(totalGross - totalCommission),
      has_previous_top_up: hasPreviousTopUp,
      minimum_top_up_amount: minimumTopUpAmount,
      is_eligible: isEligible,
      eligibility_message: isEligible
        ? 'Wallet is ready for bookings.'
        : 'Please top up your wallet to receive bookings.'
    });
  } catch (error) {
    console.error('Driver wallet fetch error:', error);
    res.status(500).json({ error: 'Unable to load wallet details right now' });
  }
});

app.get('/driver/earnings/:driver_id', async (req, res) => {
  try {
    const driverId = parseId(req.params.driver_id);
    if (!driverId) {
      return res.status(400).json({ error: 'Invalid driver_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          b.booking_id,
          t.transaction_id,
          t.final_fare,
          COALESCE(pc.amount, 0) AS commission_amount,
          (t.final_fare - COALESCE(pc.amount, 0)) AS net_earnings,
          DATE_FORMAT(t.payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date,
          CONCAT('Commission deducted from wallet for booking #', b.booking_id) AS wallet_impact
        FROM booking b
        INNER JOIN \`transaction\` t ON t.booking_id = b.booking_id
        LEFT JOIN platform_commissions pc ON pc.booking_id = b.booking_id
        WHERE b.driver_id = ?
        ORDER BY t.payment_date DESC, t.transaction_id DESC
      `,
      [driverId]
    );

    res.json(rows);
  } catch (error) {
    console.error('Driver earnings history error:', error);
    res.status(500).json({ error: 'Unable to load driver earnings history right now' });
  }
});

app.post('/driver/wallet/topup', async (req, res) => {
  const connection = await db.getConnection();
  try {
    const driverId = parseId(req.body?.driver_id);
    const amount = parseMoney(req.body?.amount);
    if (!driverId || amount == null) {
      connection.release();
      return res.status(400).json({ error: 'Valid driver_id and amount are required' });
    }
    const driver = await getApprovedDriver(driverId, connection);
    if (!driver) {
      connection.release();
      return res.status(404).json({ error: 'Driver not found or not approved' });
    }

    await connection.beginTransaction();
    const wallet = await ensureDriverWallet(driverId, connection);
    const [[topUpHistory]] = await connection.query(
      `
        SELECT COUNT(*) AS top_up_count
        FROM driver_wallet_transactions
        WHERE wallet_id = ?
          AND type = 'TOPUP'
      `,
      [wallet.wallet_id]
    );
    const hasPreviousTopUp = Number(topUpHistory?.top_up_count || 0) > 0;
    const minimumTopUpAmount = hasPreviousTopUp ? LATER_DRIVER_TOP_UP_MINIMUM : FIRST_DRIVER_TOP_UP_MINIMUM;
    if (amount < minimumTopUpAmount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        error: `Minimum top-up amount is PHP ${minimumTopUpAmount.toFixed(2)}.`,
        minimum_top_up_amount: minimumTopUpAmount,
        has_previous_top_up: hasPreviousTopUp
      });
    }
    const nextBalance = roundCurrency((parseMoney(wallet.balance) || 0) + amount);
    await connection.query(
      `
        UPDATE driver_wallets
        SET balance = ?, updated_at = NOW()
        WHERE wallet_id = ?
      `,
      [nextBalance, wallet.wallet_id]
    );
    await connection.query(
      `
        INSERT INTO driver_wallet_transactions (
          wallet_id,
          type,
          amount,
          reference_id,
          description,
          created_at
        )
        VALUES (?, 'TOPUP', ?, NULL, ?, NOW())
      `,
      [wallet.wallet_id, amount, `Driver wallet top-up of PHP ${amount.toFixed(2)}`]
    );
    await connection.commit();
    connection.release();

    res.status(201).json({
      success: true,
      message: 'Wallet topped up successfully.',
      balance: nextBalance,
      minimum_top_up_amount: LATER_DRIVER_TOP_UP_MINIMUM
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
    }
    connection.release();
    console.error('Driver wallet top-up error:', error);
    res.status(500).json({ error: error.sqlMessage || error.message || 'Unable to top up wallet right now' });
  }
});

app.get('/driver/wallet/transactions/:driver_id', async (req, res) => {
  try {
    const driverId = parseId(req.params.driver_id);
    if (!driverId) {
      return res.status(400).json({ error: 'Invalid driver_id' });
    }

    const wallet = await getDriverWalletSummary(driverId);
    const [rows] = await db.query(
      `
        SELECT
          transaction_id,
          wallet_id,
          type,
          amount,
          reference_id,
          description,
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
        FROM driver_wallet_transactions
        WHERE wallet_id = ?
        ORDER BY created_at DESC, transaction_id DESC
      `,
      [wallet.wallet_id]
    );

    res.json(rows);
  } catch (error) {
    console.error('Driver wallet transactions error:', error);
    res.status(500).json({ error: 'Unable to load wallet transactions right now' });
  }
});

app.get('/customer/vouchers/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const voucherColumns = await getCustomerVoucherColumns();
    const statusSelect = hasCustomerVoucherColumn(voucherColumns, 'status')
      ? 'status'
      : hasCustomerVoucherColumn(voucherColumns, 'is_used')
        ? "CASE WHEN COALESCE(is_used, 0) = 1 THEN 'USED' ELSE 'AVAILABLE' END AS status"
        : "'AVAILABLE' AS status";
    const expirationSelect = hasCustomerVoucherColumn(voucherColumns, 'expiration_date')
      ? "DATE_FORMAT(expiration_date, '%Y-%m-%d %H:%i:%s') AS expiration_date"
      : 'NULL AS expiration_date';
    const createdAtSelect = hasCustomerVoucherColumn(voucherColumns, 'created_at')
      ? "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at"
      : 'NULL AS created_at';

    const [rows] = await db.query(
      `
        SELECT
          voucher_id,
          user_id,
          type,
          value,
          max_discount,
          ${statusSelect},
          ${expirationSelect},
          ${createdAtSelect}
        FROM customer_vouchers
        WHERE user_id = ?
        ORDER BY
          CASE status
            WHEN 'AVAILABLE' THEN 0
            WHEN 'USED' THEN 1
            ELSE 2
          END,
          ${hasCustomerVoucherColumn(voucherColumns, 'expiration_date') ? 'expiration_date ASC,' : ''}
          voucher_id DESC
      `,
      [userId]
    );

    res.json(rows);
  } catch (error) {
    console.error('Customer vouchers error:', error);
    res.status(500).json({ error: 'Unable to load vouchers right now' });
  }
});

app.post('/promo/validate', async (req, res) => {
  try {
    const userId = parseId(req.body?.user_id);
    const estimatedFare = parseMoney(req.body?.estimated_fare);
    const code = String(req.body?.code || '').trim();
    if (!userId || !code || estimatedFare == null || estimatedFare <= 0) {
      return res.status(400).json({ error: 'Valid user_id, code, and estimated_fare are required' });
    }

    const promo = await getActivePromoRecord({ code });
    const validationError = validatePromoRecord(promo);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const minimumFare = parseMoney(promo.minimum_fare) || 0;
    if (minimumFare > 0 && estimatedFare < minimumFare) {
      return res.status(400).json({ error: `This promo requires a minimum fare of PHP ${minimumFare.toFixed(2)}.` });
    }

    const [existingRedemptions] = await db.query(
      `
        SELECT redemption_id
        FROM promo_redemptions
        WHERE promo_id = ?
          AND user_id = ?
        LIMIT 1
      `,
      [promo.promo_id, userId]
    );
    if (existingRedemptions.length > 0) {
      return res.status(400).json({ error: 'Promo code has already been used by this user.' });
    }

    const discount = calculateDiscountSnapshot({
      originalFare: estimatedFare,
      promo
    });

    res.json({
      success: true,
      message: 'Promo code applied successfully.',
      promo_id: promo.promo_id,
      code: promo.code,
      type: promo.type,
      value: parseMoney(promo.value),
      max_discount: parseMoney(promo.max_discount),
      minimum_fare: minimumFare,
      original_fare: discount.originalFare,
      discount_amount: discount.discountAmount,
      final_fare: discount.finalFare
    });
  } catch (error) {
    console.error('Promo validation error:', error);
    res.status(500).json({ error: 'Unable to validate promo code right now' });
  }
});

app.get('/discount/eligibility/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const eligibility = await getApprovedDiscountEligibility(userId);
    res.json({
      eligible: Boolean(eligibility.approved),
      approved_type: eligibility.approved?.type || null,
      active_request_status: eligibility.latest?.status || null,
      active_request_type: eligibility.latest?.type || null,
      discount_rate: eligibility.approved ? SPECIAL_DISCOUNT_RATE : 0
    });
  } catch (error) {
    console.error('Discount eligibility error:', error);
    res.status(500).json({ error: 'Unable to load discount eligibility right now' });
  }
});

app.get('/discount/request/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          dr.request_id,
          dr.user_id,
          dr.type,
          dr.status,
          DATE_FORMAT(dr.submitted_at, '%Y-%m-%d %H:%i:%s') AS submitted_at,
          DATE_FORMAT(dr.reviewed_at, '%Y-%m-%d %H:%i:%s') AS reviewed_at,
          u.user_code,
          CONCAT_WS(
            ' ',
            NULLIF(TRIM(u.first_name), ''),
            NULLIF(TRIM(u.middle_name), ''),
            NULLIF(TRIM(u.last_name), ''),
            NULLIF(TRIM(u.extension), '')
          ) AS full_name,
          u.phone,
          DATE_FORMAT(u.date_of_birth, '%Y-%m-%d') AS birth_date,
          u.address
        FROM discount_requests dr
        INNER JOIN users u ON u.user_id = dr.user_id
        WHERE dr.user_id = ?
        ORDER BY submitted_at DESC, request_id DESC
      `,
      [userId]
    );

    res.json(
      rows.map((row) => {
        const metadata = loadDiscountRequestMetadata(row.request_id);
        return {
          ...row,
          full_name: metadata.full_name || row.full_name || null,
          birth_date: metadata.birth_date || row.birth_date || null,
          address: metadata.address || row.address || null,
          id_number: metadata.id_number || null,
          id_picture: metadata.id_picture || null
        };
      })
    );
  } catch (error) {
    console.error('Discount request list error:', error);
    res.status(500).json({ error: 'Unable to load discount requests right now' });
  }
});

app.post('/discount/request', async (req, res) => {
  try {
    const userId = parseId(req.body?.user_id);
    const type = normalizeStatusUpper(req.body?.type);
    const idNumber = String(req.body?.id_reference_number || req.body?.id_number || '').trim();
    const idPicturePayload = parseDiscountRequestPicture(req.body?.id_picture, req.body?.id_picture_mime_type);
    const allowedTypes = ['STUDENT', 'SENIOR', 'PWD'];
    if (!userId || !allowedTypes.includes(type) || !idNumber || !idPicturePayload.buffer) {
      return res.status(400).json({ error: 'Select the discount type, enter the ID/reference number, and upload the ID picture.' });
    }

    const [profileRows] = await db.query(
      `
        SELECT
          CONCAT_WS(
            ' ',
            NULLIF(TRIM(first_name), ''),
            NULLIF(TRIM(middle_name), ''),
            NULLIF(TRIM(last_name), ''),
            NULLIF(TRIM(extension), '')
          ) AS full_name,
          DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS birth_date,
          address
        FROM users
        WHERE user_id = ?
        LIMIT 1
      `,
      [userId]
    );
    if (!profileRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [existingRows] = await db.query(
      `
        SELECT request_id, status
        FROM discount_requests
        WHERE user_id = ?
        ORDER BY submitted_at DESC, request_id DESC
        LIMIT 1
      `,
      [userId]
    );
    if (existingRows.length > 0 && normalizeStatusUpper(existingRows[0].status) !== 'REJECTED') {
      return res.status(400).json({
        error: 'A discount request already exists for this account.'
      });
    }

    const [result] = await db.query(
      `
        INSERT INTO discount_requests (
          user_id,
          type,
          id_reference_number,
          id_picture,
          id_picture_mime_type,
          status,
          submitted_at,
          reviewed_at
        )
        VALUES (?, ?, ?, ?, ?, 'PENDING', NOW(), NULL)
      `,
      [userId, type, idNumber, idPicturePayload.buffer, idPicturePayload.mimeType]
    );
    const profile = profileRows[0];
    saveDiscountRequestMetadata(result.insertId, {
      full_name: profile.full_name || '',
      birth_date: profile.birth_date || '',
      address: profile.address || '',
      id_number: idNumber,
      id_picture: normalizeDiscountRequestPicture(idPicturePayload.buffer, idPicturePayload.mimeType)
    });

    res.status(201).json({
      success: true,
      request_id: result.insertId,
      status: 'PENDING',
      message: 'Discount request submitted successfully.'
    });
  } catch (error) {
    console.error('Discount request create error:', error);
    res.status(500).json({ error: 'Unable to submit discount request right now' });
  }
});

app.get('/admin/promos', async (req, res) => {
  try {
    const [rows] = await db.query(
      `
        SELECT
          promo_id,
          code,
          type,
          value,
          max_discount,
          minimum_fare,
          usage_limit,
          used_count,
          DATE_FORMAT(expiration_date, '%Y-%m-%d %H:%i:%s') AS expiration_date,
          is_active,
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
        FROM promo_codes
        ORDER BY created_at DESC, promo_id DESC
      `
    );

    res.json(rows);
  } catch (error) {
    console.error('Admin promos error:', error);
    res.status(500).json({ error: 'Unable to load promo codes right now' });
  }
});

app.get('/admin/promos/active', async (req, res) => {
  try {
    const [rows] = await db.query(
      `
        SELECT
          promo_id,
          code,
          type,
          value,
          max_discount,
          minimum_fare,
          usage_limit,
          used_count,
          DATE_FORMAT(expiration_date, '%Y-%m-%d %H:%i:%s') AS expiration_date,
          is_active,
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
        FROM promo_codes
        WHERE is_active = 1
          AND (expiration_date IS NULL OR expiration_date >= NOW())
        ORDER BY expiration_date ASC, promo_id DESC
      `
    );

    res.json(rows);
  } catch (error) {
    console.error('Admin active promos error:', error);
    res.status(500).json({ error: 'Unable to load active promo codes right now' });
  }
});

app.post('/admin/promos', async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const type = normalizeStatusUpper(req.body?.type);
    const value = parseMoney(req.body?.value);
    const maxDiscount = parseMoney(req.body?.max_discount);
    const minimumFare = parseMoney(req.body?.minimum_fare) ?? 0;
    const usageLimit = parseId(req.body?.usage_limit);
    const expirationDate = String(req.body?.expiration_date || '').trim();
    const isActive = Number(req.body?.is_active) === 1 ? 1 : 0;
    if (!code || !['FIXED', 'PERCENTAGE'].includes(type) || value == null || !expirationDate) {
      return res.status(400).json({ error: 'Promo code, type, value, and expiration date are required' });
    }
    const definitionError = validateDiscountDefinition(type, value, maxDiscount);
    if (definitionError) {
      return res.status(400).json({ error: definitionError });
    }
    if (minimumFare < 0) {
      return res.status(400).json({ error: 'Minimum fare cannot be negative.' });
    }

    const [result] = await db.query(
      `
        INSERT INTO promo_codes (
          code,
          type,
          value,
          max_discount,
          minimum_fare,
          usage_limit,
          used_count,
          expiration_date,
          is_active,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NOW())
      `,
      [code, type, value, maxDiscount, minimumFare, usageLimit, expirationDate, isActive]
    );

    res.status(201).json({
      success: true,
      promo_id: result.insertId,
      message: 'Promo code created successfully.'
    });
  } catch (error) {
    console.error('Admin promo create error:', error);
    res.status(500).json({ error: error.sqlMessage || error.message || 'Unable to create promo code right now' });
  }
});

app.put('/admin/promos/:promo_id/status', async (req, res) => {
  try {
    const promoId = parseId(req.params.promo_id);
    const isActive = Number(req.body?.is_active) === 1 ? 1 : 0;
    if (!promoId) {
      return res.status(400).json({ error: 'Invalid promo_id' });
    }

    const [result] = await db.query(
      `
        UPDATE promo_codes
        SET is_active = ?
        WHERE promo_id = ?
      `,
      [isActive, promoId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    res.json({
      success: true,
      promo_id: promoId,
      status: isActive === 1 ? 'ACTIVE' : 'INACTIVE',
      message: 'Promo status updated successfully.'
    });
  } catch (error) {
    console.error('Admin promo status update error:', error);
    res.status(500).json({ error: 'Unable to update promo status right now' });
  }
});

app.get('/admin/discount-requests', async (req, res) => {
  try {
    const [rows] = await db.query(
      `
        SELECT
          dr.request_id,
          dr.user_id,
          dr.type,
          dr.status,
          DATE_FORMAT(dr.submitted_at, '%Y-%m-%d %H:%i:%s') AS submitted_at,
          DATE_FORMAT(dr.reviewed_at, '%Y-%m-%d %H:%i:%s') AS reviewed_at,
          u.user_code,
          CONCAT_WS(
            ' ',
            NULLIF(TRIM(u.first_name), ''),
            NULLIF(TRIM(u.middle_name), ''),
            NULLIF(TRIM(u.last_name), ''),
            NULLIF(TRIM(u.extension), '')
          ) AS full_name,
          u.phone
        FROM discount_requests dr
        INNER JOIN users u ON u.user_id = dr.user_id
        ORDER BY
          CASE dr.status
            WHEN 'PENDING' THEN 0
            WHEN 'APPROVED' THEN 1
            ELSE 2
          END,
          dr.submitted_at DESC,
          dr.request_id DESC
      `
    );

    res.json(rows);
  } catch (error) {
    console.error('Admin discount request list error:', error);
    res.status(500).json({ error: 'Unable to load discount requests right now' });
  }
});

app.get('/admin/discounts', async (req, res) => {
  try {
    const query = String(req.query?.q || '').trim();
    const likeQuery = `%${query}%`;
    const exactUserId = parseId(query);
    const [rows] = await db.query(
      `
        SELECT
          dr.request_id,
          dr.user_id,
          dr.type,
          dr.status,
          DATE_FORMAT(dr.submitted_at, '%Y-%m-%d %H:%i:%s') AS submitted_at,
          DATE_FORMAT(dr.reviewed_at, '%Y-%m-%d %H:%i:%s') AS reviewed_at,
          u.user_code,
          CONCAT_WS(
            ' ',
            NULLIF(TRIM(u.first_name), ''),
            NULLIF(TRIM(u.middle_name), ''),
            NULLIF(TRIM(u.last_name), ''),
            NULLIF(TRIM(u.extension), '')
          ) AS full_name,
          u.phone
        FROM discount_requests dr
        INNER JOIN users u ON u.user_id = dr.user_id
        WHERE dr.status = 'APPROVED'
          AND (
            ? = ''
            OR dr.user_id = COALESCE(?, -1)
            OR u.user_code LIKE ?
            OR CONCAT_WS(
              ' ',
              NULLIF(TRIM(u.first_name), ''),
              NULLIF(TRIM(u.middle_name), ''),
              NULLIF(TRIM(u.last_name), ''),
              NULLIF(TRIM(u.extension), '')
            ) LIKE ?
            OR dr.type LIKE ?
            OR dr.status LIKE ?
          )
        ORDER BY dr.reviewed_at DESC, dr.request_id DESC
      `,
      [query, exactUserId, likeQuery, likeQuery, likeQuery, likeQuery]
    );

    res.json(rows);
  } catch (error) {
    console.error('Admin approved discount list error:', error);
    res.status(500).json({ error: 'Unable to load approved discounts right now' });
  }
});

app.get('/admin/discount-requests/:request_id', async (req, res) => {
  try {
    const requestId = parseId(req.params.request_id);
    if (!requestId) {
      return res.status(400).json({ error: 'Invalid request_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          dr.request_id,
          dr.user_id,
          dr.type,
          dr.status,
          DATE_FORMAT(dr.submitted_at, '%Y-%m-%d %H:%i:%s') AS submitted_at,
          DATE_FORMAT(dr.reviewed_at, '%Y-%m-%d %H:%i:%s') AS reviewed_at,
          u.user_code,
          CONCAT_WS(
            ' ',
            NULLIF(TRIM(u.first_name), ''),
            NULLIF(TRIM(u.middle_name), ''),
            NULLIF(TRIM(u.last_name), ''),
            NULLIF(TRIM(u.extension), '')
          ) AS full_name,
          u.phone,
          DATE_FORMAT(u.date_of_birth, '%Y-%m-%d') AS birth_date,
          u.address
        FROM discount_requests dr
        INNER JOIN users u ON u.user_id = dr.user_id
        WHERE dr.request_id = ?
        LIMIT 1
      `,
      [requestId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Discount request not found' });
    }

    const metadata = loadDiscountRequestMetadata(requestId);
    res.json({
      ...rows[0],
      full_name: metadata.full_name || rows[0].full_name || null,
      birth_date: metadata.birth_date || rows[0].birth_date || null,
      address: metadata.address || rows[0].address || null,
      id_reference_number: metadata.id_number || null,
      id_number: metadata.id_number || null,
      id_picture: metadata.id_picture || null
    });
  } catch (error) {
    console.error('Admin discount request detail error:', error);
    res.status(500).json({ error: 'Unable to load discount request details right now' });
  }
});

app.put('/admin/discounts/:request_id/revoke', async (req, res) => {
  try {
    const requestId = parseId(req.params.request_id);
    if (!requestId) {
      return res.status(400).json({ error: 'Invalid request_id' });
    }

    const [requestRows] = await db.query(
      `
        SELECT request_id, user_id, type, status
        FROM discount_requests
        WHERE request_id = ?
          AND status = 'APPROVED'
        LIMIT 1
      `,
      [requestId]
    );
    if (!requestRows.length) {
      return res.status(404).json({ error: 'Approved discount not found' });
    }

    await db.query(
      `
        UPDATE discount_requests
        SET status = 'REJECTED', reviewed_at = NOW()
        WHERE request_id = ?
      `,
      [requestId]
    );

    await createNotification(
      requestRows[0].user_id,
      `Your ${requestRows[0].type} discount eligibility has been revoked.`
    );

    res.json({
      success: true,
      request_id: requestId,
      message: 'Discount eligibility revoked successfully.'
    });
  } catch (error) {
    console.error('Admin discount revoke error:', error);
    res.status(500).json({ error: 'Unable to revoke discount eligibility right now' });
  }
});

app.put('/admin/discount-requests/:request_id/status', async (req, res) => {
  try {
    const requestId = parseId(req.params.request_id);
    const status = normalizeStatusUpper(req.body?.status);
    const allowedStatuses = ['APPROVED', 'REJECTED'];
    if (!requestId || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Valid request_id and status are required' });
    }

    const [requestRows] = await db.query(
      `
        SELECT request_id, user_id, type
        FROM discount_requests
        WHERE request_id = ?
        LIMIT 1
      `,
      [requestId]
    );
    if (!requestRows.length) {
      return res.status(404).json({ error: 'Discount request not found' });
    }

    await db.query(
      `
        UPDATE discount_requests
        SET status = ?, reviewed_at = NOW()
        WHERE request_id = ?
      `,
      [status, requestId]
    );
    const requestRow = requestRows[0];
    await createNotification(
      requestRow.user_id,
      status === 'APPROVED'
        ? `Your ${requestRow.type} discount request has been approved.`
        : `Your ${requestRow.type} discount request has been rejected.`
    );

    res.json({
      success: true,
      request_id: requestId,
      status,
      message: 'Discount request updated successfully.'
    });
  } catch (error) {
    console.error('Admin discount request update error:', error);
    res.status(500).json({ error: 'Unable to update discount request right now' });
  }
});

app.post('/transaction/complete', async (req, res) => {
  const connection = await db.getConnection();
  try {
    const bookingId = parseId(req.body?.booking_id);
    const rawFinalFare = parseMoney(req.body?.final_fare);
    const totalTime = String(req.body?.total_time || '').trim() || null;
    const totalDistanceKm = parseMoney(req.body?.total_distance_km);
    const finalDiscountMinimumFare = FINAL_DISCOUNT_MINIMUM_FARE;
    if (!bookingId || rawFinalFare == null) {
      connection.release();
      return res.status(400).json({ error: 'Required transaction fields missing' });
    }

    await connection.beginTransaction();

    const [existingTransactions] = await connection.query(
      'SELECT transaction_id, final_fare FROM `transaction` WHERE booking_id = ? LIMIT 1',
      [bookingId]
    );
    if (existingTransactions.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(409).json({
        error: 'Transaction already completed for this booking.',
        transaction_id: existingTransactions[0].transaction_id
      });
    }

    const [bookingRows] = await connection.query(
      `
        SELECT booking_id, user_id, driver_id, estimated_fare, status, trip_map
        FROM booking
        WHERE booking_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [bookingId]
    );
    if (!bookingRows.length) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingRows[0];
    if (!booking.driver_id) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'Booking has no assigned driver' });
    }

    const tripPayload = parseBookingTripPayload(booking.trip_map);
    if (totalDistanceKm != null && totalDistanceKm > 0) {
      tripPayload.total_distance_km = totalDistanceKm;
    }
    if (totalTime) {
      tripPayload.total_time = totalTime;
    }

    let discountAmount = 0;
    let appliedVoucher = null;
    let appliedPromo = null;
    let resolvedDiscountType = null;
    let resolvedDiscountValue = null;
    let resolvedMaxDiscount = null;
    let discountVoidedReason = null;
    const hadSelectedDiscount = Boolean(
      tripPayload.voucher_id ||
      tripPayload.promo_id ||
      tripPayload.promo_code ||
      tripPayload.apply_special_discount
    );
    const qualifiesForFinalDiscount = rawFinalFare >= finalDiscountMinimumFare;

    if (!qualifiesForFinalDiscount && hadSelectedDiscount) {
      discountVoidedReason = `Discount voided because final fare is below PHP ${finalDiscountMinimumFare.toFixed(2)}.`;
    }

    if (qualifiesForFinalDiscount && tripPayload.voucher_id) {
      const completedBookingCount = await getCompletedCustomerBookingCount(booking.user_id, connection);
      const voucher = await getAvailableCustomerVoucher(booking.user_id, tripPayload.voucher_id, connection);
      const voucherError = validateVoucherRecord(voucher, completedBookingCount);
      if (!voucherError && voucher) {
        appliedVoucher = voucher;
        resolvedDiscountType = normalizeStatusUpper(voucher.type);
        resolvedDiscountValue = parseMoney(voucher.value);
        resolvedMaxDiscount = parseMoney(voucher.max_discount);
      }
    }

    if (qualifiesForFinalDiscount && !appliedVoucher && (tripPayload.promo_id || tripPayload.promo_code)) {
      const promo = await getActivePromoRecord(
        { promoId: tripPayload.promo_id, code: tripPayload.promo_code },
        connection
      );
      const promoError = validatePromoRecord(promo, rawFinalFare);
      if (!promoError && promo) {
        appliedPromo = promo;
        tripPayload.promo_id = parseId(promo.promo_id);
        tripPayload.promo_code = String(promo.code || '').trim() || tripPayload.promo_code || null;
        resolvedDiscountType = normalizeStatusUpper(promo.type);
        resolvedDiscountValue = parseMoney(promo.value);
        resolvedMaxDiscount = parseMoney(promo.max_discount);
      }
    }

    if (qualifiesForFinalDiscount && !resolvedDiscountType && tripPayload.apply_special_discount) {
      resolvedDiscountType = 'PERCENTAGE';
      resolvedDiscountValue = SPECIAL_DISCOUNT_RATE;
      resolvedMaxDiscount = null;
    }

    if (qualifiesForFinalDiscount && hadSelectedDiscount && !resolvedDiscountType && !discountVoidedReason) {
      discountVoidedReason = 'Selected discount no longer qualifies for the final fare.';
    }

    if (resolvedDiscountType === 'PERCENTAGE' && resolvedDiscountValue != null) {
      discountAmount = computePercentageDiscount(rawFinalFare, resolvedDiscountValue, resolvedMaxDiscount);
    } else if (resolvedDiscountType === 'FIXED' && resolvedDiscountValue != null) {
      discountAmount = roundCurrency(Math.min(rawFinalFare, resolvedDiscountValue));
    }

    discountAmount = roundCurrency(Math.max(0, Math.min(rawFinalFare, discountAmount)));
    const finalFare = roundCurrency(Math.max(0, rawFinalFare - discountAmount));
    tripPayload.original_fare = rawFinalFare;
    tripPayload.discount_type = discountAmount > 0 ? resolvedDiscountType : null;
    tripPayload.discount_value = discountAmount > 0 ? resolvedDiscountValue : null;
    tripPayload.max_discount = discountAmount > 0 ? resolvedMaxDiscount : null;
    tripPayload.discount_amount = discountAmount;
    tripPayload.final_fare = finalFare;
    tripPayload.final_amount_paid = finalFare;
    tripPayload.discount_status = discountAmount > 0 ? 'APPLIED' : hadSelectedDiscount ? 'VOIDED' : 'NONE';
    tripPayload.discount_voided_reason = discountVoidedReason;
    const wallet = await ensureDriverWallet(booking.driver_id, connection);
    const currentCompleted = Number(wallet.total_completed_bookings || 0);
    const commissionRate = computeCommissionRate(currentCompleted);
    const commissionAmount = roundCurrency((finalFare * commissionRate) / 100);
    const currentBalance = parseMoney(wallet.balance) || 0;
    if (commissionAmount > currentBalance) {
      await connection.rollback();
      connection.release();
      return res.status(409).json({ error: 'Driver wallet balance is insufficient for this commission deduction.' });
    }

    const [transactionInsert] = await connection.query(
      `
        INSERT INTO \`transaction\` (booking_id, final_fare, payment_date, total_time)
        VALUES (?, ?, NOW(), ?)
      `,
      [bookingId, finalFare, totalTime]
    );

    const updatedCompletedCount = currentCompleted + 1;
    const nextCommissionRate = computeCommissionRate(updatedCompletedCount);
    const nextBalance = roundCurrency(currentBalance - commissionAmount);

    await connection.query(
      `
        UPDATE driver_wallets
        SET balance = ?,
            total_completed_bookings = ?,
            commission_rate = ?,
            updated_at = NOW()
        WHERE wallet_id = ?
      `,
      [nextBalance, updatedCompletedCount, nextCommissionRate, wallet.wallet_id]
    );
    await connection.query(
      `
        INSERT INTO driver_wallet_transactions (
          wallet_id,
          type,
          amount,
          reference_id,
          description,
          created_at
        )
        VALUES (?, 'COMMISSION_DEDUCTION', ?, ?, ?, NOW())
      `,
      [wallet.wallet_id, commissionAmount, bookingId, `Commission deduction for booking #${bookingId}`]
    );
    await connection.query(
      `
        INSERT INTO platform_commissions (booking_id, driver_id, amount, created_at)
        VALUES (?, ?, ?, NOW())
      `,
      [bookingId, booking.driver_id, commissionAmount]
    );

    if (tripPayload.voucher_id && appliedVoucher && discountAmount > 0) {
      const voucherColumns = await getCustomerVoucherColumns(connection);
      const setClauses = [];
      const whereClauses = ['voucher_id = ?', 'user_id = ?'];
      const params = [tripPayload.voucher_id, booking.user_id];

      if (hasCustomerVoucherColumn(voucherColumns, 'status')) {
        setClauses.push("status = 'USED'");
        whereClauses.push("UPPER(TRIM(status)) = 'AVAILABLE'");
      }
      if (hasCustomerVoucherColumn(voucherColumns, 'is_used')) {
        setClauses.push('is_used = 1');
        whereClauses.push('COALESCE(is_used, 0) = 0');
      }
      if (hasCustomerVoucherColumn(voucherColumns, 'redeemed_at')) {
        setClauses.push('redeemed_at = NOW()');
        whereClauses.push('redeemed_at IS NULL');
      }

      if (setClauses.length > 0) {
        await connection.query(
          `
            UPDATE customer_vouchers
            SET ${setClauses.join(', ')}
            WHERE ${whereClauses.join(' AND ')}
          `,
          params
        );
      }
    }
    if (tripPayload.promo_id && appliedPromo && discountAmount > 0) {
      const [existingRedemptions] = await connection.query(
        `
          SELECT redemption_id
          FROM promo_redemptions
          WHERE promo_id = ?
            AND user_id = ?
            AND booking_id = ?
          LIMIT 1
        `,
        [tripPayload.promo_id, booking.user_id, bookingId]
      );
      if (!existingRedemptions.length) {
        await connection.query(
          `
            INSERT INTO promo_redemptions (promo_id, user_id, booking_id, created_at)
            VALUES (?, ?, ?, NOW())
          `,
          [tripPayload.promo_id, booking.user_id, bookingId]
        );
        await connection.query(
          `
            UPDATE promo_codes
            SET used_count = used_count + 1
            WHERE promo_id = ?
          `,
          [tripPayload.promo_id]
        );
      }
    }

    await connection.query(
      `UPDATE booking SET status = 'Completed', trip_map = ? WHERE booking_id = ?`,
      [JSON.stringify(tripPayload), bookingId]
    );

    const completedBookingCount = await getCompletedCustomerBookingCount(booking.user_id, connection);
    let rewardedVoucher = null;
    try {
      rewardedVoucher = await grantCustomerRewardVoucherIfEligible(booking.user_id, completedBookingCount, connection);
    } catch (rewardError) {
      console.error('Reward voucher grant skipped during transaction completion:', rewardError);
      rewardedVoucher = null;
    }

    await connection.commit();
    connection.release();

    clearDriverLiveLocation(bookingId);
    emitBookingUpdate(bookingId, { status: 'Completed' });
    if (rewardedVoucher) {
      await createNotification(booking.user_id, buildVoucherRewardMessage(rewardedVoucher));
    }

    res.status(201).json({
      success: true,
      transaction_id: transactionInsert.insertId,
      final_fare: finalFare,
      original_fare: rawFinalFare,
      discount_amount: discountAmount,
      amount_paid: finalFare,
      discount_voided: Boolean(discountVoidedReason),
      discount_voided_reason: discountVoidedReason,
      commission_amount: commissionAmount,
      driver_profit: roundCurrency(finalFare - commissionAmount),
      wallet_balance: nextBalance,
      message: 'Transaction completed successfully.'
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
    }
    connection.release();
    console.error('Transaction error:', error);
    res.status(500).json({ error: error.sqlMessage || error.message || 'Transaction failed' });
  }
});

app.put('/booking/:id/driver-location', async (req, res) => {
  try {
    const bookingId = parseId(req.params.id);
    const driverId = parseId(req.body?.driver_id);
    const latitude = Number.parseFloat(req.body?.latitude);
    const longitude = Number.parseFloat(req.body?.longitude);

    if (!bookingId || !driverId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'Valid booking_id, driver_id, latitude, and longitude are required' });
    }

    const [bookingRows] = await db.query(
      'SELECT booking_id, driver_id, status FROM booking WHERE booking_id = ?',
      [bookingId]
    );
    if (!bookingRows.length) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingRows[0];
    const normalizedStatus = normalizeBookingStatus(booking.status);
    if (booking.driver_id !== driverId) {
      return res.status(409).json({ error: 'Driver is not assigned to this booking' });
    }
    if (normalizedStatus !== 'Accepted' && normalizedStatus !== 'In Progress') {
      return res.status(409).json({ error: 'Driver location can only be updated for active bookings' });
    }

    const location = await persistDriverLiveLocation(bookingId, driverId, latitude, longitude);
    res.json({ success: true, ...location });
  } catch (error) {
    console.error('Driver location update error:', error);
    res.status(500).json({ error: 'Driver location update failed' });
  }
});

app.post('/tickets/create', async (req, res) => {
  try {
    const { user_id, booking_id, description } = req.body;
    if (!user_id || !description) {
      return res.status(400).json({ error: 'Required ticket fields missing' });
    }

    const [result] = await db.query(
      `
        INSERT INTO tickets (user_id, booking_id, description, status, created_at)
        VALUES (?, ?, ?, 'Open', NOW())
      `,
      [user_id, booking_id || null, description]
    );

    res.status(201).json({ ticket_id: result.insertId });
  } catch (error) {
    console.error('Ticket error:', error);
    res.status(500).json({ error: 'Ticket creation failed' });
  }
});

app.get('/tickets/user/:user_id', async (req, res) => {
  try {
    const userId = parseId(req.params.user_id);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const [rows] = await db.query(
      `
        SELECT
          ticket_id,
          user_id,
          booking_id,
          description,
          status,
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
        FROM tickets
        WHERE user_id = ?
        ORDER BY created_at DESC, ticket_id DESC
      `,
      [userId]
    );

    res.json(rows.map((row) => {
      const tripPayload = parseBookingTripPayload(row.trip_map);
      return {
        ...row,
        original_fare: parseMoney(tripPayload.original_fare),
        discount_amount: parseMoney(tripPayload.discount_amount)
      };
    }));
  } catch (error) {
    console.error('Ticket history error:', error);
    res.status(500).json({ error: 'Ticket history failed' });
  }
});

app.put('/tickets/:ticket_id/status', async (req, res) => {
  try {
    const ticketId = parseId(req.params.ticket_id);
    const status = String(req.body?.status || '').trim();
    if (!ticketId || !status) {
      return res.status(400).json({ error: 'Valid ticket_id and status are required' });
    }

    const [result] = await db.query(
      `
        UPDATE tickets
        SET status = ?
        WHERE ticket_id = ?
      `,
      [status, ticketId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ success: true, ticket_id: ticketId, status });
  } catch (error) {
    console.error('Ticket status update error:', error);
    res.status(500).json({ error: 'Ticket status update failed' });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ADMIN â€” USERS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /admin/users/search?q=   â†’  List<AdminUserSearchItemResponse>
app.get('/admin/users/search', async (req, res) => {
  try {
    console.log('ADMIN_USERS_ROUTE hit');
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const [rows] = await db.query(
      `SELECT
         u.user_id,
         u.user_code,
         TRIM(CONCAT_WS(' ',
           NULLIF(TRIM(u.first_name),''),
           NULLIF(TRIM(u.last_name),'')
         )) AS full_name,
         u.email_address,
         u.phone,
         CASE
           WHEN EXISTS (
             SELECT 1
             FROM drivers d
             WHERE d.user_id = u.user_id
               AND UPPER(TRIM(d.approval_status)) = 'APPROVED'
           ) THEN 'Driver'
           ELSE u.account_type
         END AS account_type
       FROM users u
       WHERE u.first_name   LIKE ?
          OR u.last_name    LIKE ?
          OR u.email_address LIKE ?
          OR u.user_code    LIKE ?
       ORDER BY u.user_id DESC
       LIMIT 100`,
      [like, like, like, like]
    );
    console.log(`ADMIN_USERS_ROUTE rows returned: ${rows.length}`);
    res.json(rows);
  } catch (error) {
    console.error('ADMIN_USERS_ROUTE error:', error);
    res.status(500).json({ error: 'Unable to load users right now.' });
  }
});

// GET /admin/users/:userId   â†’  AdminUserDetailResponse
app.get('/admin/users/:userId', async (req, res) => {
  try {
    const userId = parseId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user_id' });

    const [[userRows], [driverRows]] = await Promise.all([
      db.query(
        `SELECT
           user_id, user_code,
           first_name, middle_name, last_name, extension,
           DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth,
           gender, email_address, phone, address, city, region, zip_code,
           account_type, profile_complete, phone_verified, applied,
           picture
         FROM users
         WHERE user_id = ?
         LIMIT 1`,
        [userId]
      ),
      db.query(
        `SELECT
           d.driver_id, d.user_id,
           d.license_number,
           DATE_FORMAT(d.license_expiry_date, '%Y-%m-%d') AS license_expiry_date,
           d.license_type, d.restriction_code,
           d.approval_status,
           DATE_FORMAT(d.date_applied,   '%Y-%m-%d %H:%i:%s') AS date_applied,
           DATE_FORMAT(d.date_approved,  '%Y-%m-%d %H:%i:%s') AS date_approved,
           d.id_picture_front, d.id_picture_back,
           d.picture AS driver_picture,
           v.vehicle_id, v.vehicle_type, v.plate_number,
           v.model, v.color, v.capacity
         FROM drivers d
         LEFT JOIN vehicles v ON v.driver_id = d.driver_id
         WHERE d.user_id = ?
         ORDER BY d.driver_id DESC
         LIMIT 1`,
        [userId]
      )
    ]);

    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    const userRow = userRows[0];
    if (userRow.picture) userRow.picture = normalizeUserPicture(userRow.picture);

    let driver = null;
    let vehicle = null;
    if (driverRows.length) {
      const dr = driverRows[0];
      driver = {
        driver_id: dr.driver_id,
        user_id: dr.user_id,
        license_number: dr.license_number,
        license_expiry_date: dr.license_expiry_date,
        license_type: dr.license_type,
        restriction_code: dr.restriction_code,
        approval_status: dr.approval_status,
        date_applied: dr.date_applied,
        date_approved: dr.date_approved,
        id_picture_front: normalizeStoredAsset(dr.id_picture_front),
        id_picture_back: normalizeStoredAsset(dr.id_picture_back),
        driver_picture: normalizeStoredAsset(dr.driver_picture)
      };
      if (dr.vehicle_id != null) {
        vehicle = {
          vehicle_id: dr.vehicle_id,
          vehicle_type: dr.vehicle_type,
          plate_number: dr.plate_number,
          model: dr.model,
          color: dr.color,
          capacity: dr.capacity
        };
      }
    }

    res.json({ user: userRow, driver, vehicle });
  } catch (error) {
    console.error('ADMIN_USER_DETAIL error:', error);
    res.status(500).json({ error: 'Unable to load user details right now.' });
  }
});

// DELETE /admin/users/:userId   â†’  AdminActionResponse
app.delete('/admin/users/:userId', async (req, res) => {
  try {
    const userId = parseId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid user_id' });

    const [result] = await db.query('DELETE FROM users WHERE user_id = ?', [userId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, message: 'User deleted successfully.', user_id: userId });
  } catch (error) {
    console.error('ADMIN_USER_DELETE error:', error);
    res.status(500).json({ error: 'Unable to delete this user right now.' });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ADMIN â€” DRIVER APPLICATIONS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /admin/driver-applications/pending   â†’  List<AdminDriverApplicationItemResponse>
app.get('/admin/driver-applications/pending', async (req, res) => {
  try {
    console.log('ADMIN_DRIVER_APPLICATIONS_ROUTE hit');
    const [rows] = await db.query(
      `SELECT
         d.driver_id, d.user_id,
         u.user_code,
         TRIM(CONCAT_WS(' ',
           NULLIF(TRIM(u.first_name),''),
           NULLIF(TRIM(u.last_name),'')
         )) AS full_name,
         u.first_name, u.middle_name, u.last_name, u.extension,
         DATE_FORMAT(u.date_of_birth, '%Y-%m-%d') AS date_of_birth,
         u.gender, u.email_address, u.phone,
         u.address, u.city, u.region, u.zip_code,
         u.picture AS user_picture,
         d.license_number,
         DATE_FORMAT(d.license_expiry_date, '%Y-%m-%d') AS license_expiry_date,
         d.license_type, d.restriction_code,
         d.approval_status,
         DATE_FORMAT(d.date_applied,  '%Y-%m-%d %H:%i:%s') AS date_applied,
         DATE_FORMAT(d.date_approved, '%Y-%m-%d %H:%i:%s') AS date_approved,
         d.id_picture_front, d.id_picture_back,
         d.picture AS driver_picture,
         v.vehicle_id, v.vehicle_type, v.plate_number,
         v.model, v.color, v.capacity
       FROM drivers d
       INNER JOIN users u ON u.user_id = d.user_id
       LEFT JOIN vehicles v ON v.driver_id = d.driver_id
       WHERE UPPER(TRIM(d.approval_status)) = 'PENDING'
       ORDER BY d.date_applied ASC, d.driver_id ASC`
    );
    console.log(`ADMIN_DRIVER_APPLICATIONS_ROUTE rows returned: ${rows.length}`);
    res.json(rows.map((row) => ({
      ...row,
      user_picture: normalizeStoredAsset(row.user_picture),
      id_picture_front: normalizeStoredAsset(row.id_picture_front),
      id_picture_back: normalizeStoredAsset(row.id_picture_back),
      driver_picture: normalizeStoredAsset(row.driver_picture)
    })));
  } catch (error) {
    console.error('ADMIN_DRIVER_APPLICATIONS_ROUTE error:', error);
    res.status(500).json({ error: 'Unable to load driver applications right now.' });
  }
});

async function syncApprovedDriverUserAccounts(connection = db) {
  const [result] = await connection.query(
    `UPDATE users u
     INNER JOIN drivers d ON d.user_id = u.user_id
     SET u.account_type = 'Driver',
         u.applied = 1
     WHERE UPPER(TRIM(d.approval_status)) = 'APPROVED'
       AND (u.account_type <> 'Driver' OR COALESCE(u.applied, 0) <> 1)`
  );
  return result.affectedRows || 0;
}

// PUT /admin/driver-applications/:driverId/approve   ->  AdminActionResponse
app.put('/admin/driver-applications/:driverId/approve', async (req, res) => {
  let connection;
  try {
    const driverId = parseId(req.params.driverId);
    if (!driverId) return res.status(400).json({ error: 'Invalid driver_id' });

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [driverRows] = await connection.query(
      `SELECT driver_id, user_id, approval_status
       FROM drivers
       WHERE driver_id = ?
       FOR UPDATE`,
      [driverId]
    );

    if (!driverRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Driver application not found.' });
    }

    const driver = driverRows[0];
    const status = String(driver.approval_status || '').trim().toUpperCase();
    if (status !== 'PENDING' && status !== 'APPROVED') {
      await connection.rollback();
      return res.status(404).json({ error: 'Driver application already processed.' });
    }

    if (status === 'PENDING') {
      await connection.query(
        `UPDATE drivers
           SET approval_status = 'Approved',
               date_approved = NOW()
         WHERE driver_id = ?`,
        [driverId]
      );
    }

    await connection.query(
      `UPDATE users
       SET account_type = 'Driver',
           applied = 1
       WHERE user_id = ?`,
      [driver.user_id]
    );

    await connection.commit();
    res.json({ success: true, message: 'Driver application approved.', driver_id: driverId, approval_status: 'Approved' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('ADMIN_DRIVER_APPROVE error:', error);
    res.status(500).json({ error: 'Unable to approve this driver application right now.' });
  } finally {
    if (connection) connection.release();
  }
});
// PUT /admin/driver-applications/:driverId/reject   â†’  AdminActionResponse
app.put('/admin/driver-applications/:driverId/reject', async (req, res) => {
  try {
    const driverId = parseId(req.params.driverId);
    if (!driverId) return res.status(400).json({ error: 'Invalid driver_id' });

    const [result] = await db.query(
      `UPDATE drivers
         SET approval_status = 'Rejected'
       WHERE driver_id = ? AND UPPER(TRIM(approval_status)) = 'PENDING'`,
      [driverId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Driver application not found or already processed.' });
    }
    res.json({ success: true, message: 'Driver application rejected.', driver_id: driverId, approval_status: 'Rejected' });
  } catch (error) {
    console.error('ADMIN_DRIVER_REJECT error:', error);
    res.status(500).json({ error: 'Unable to reject this driver application right now.' });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ADMIN â€” TICKETS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /admin/tickets/open   â†’  List<AdminTicketItemResponse>
// GET /admin/commissions   ->  AdminCommissionsResponse
app.get('/admin/commissions', async (req, res) => {
  try {
    const [[summary]] = await db.query(
      `
        SELECT
          COALESCE(SUM(amount), 0) AS total_commission_earned,
          COUNT(*) AS total_transactions
        FROM platform_commissions
      `
    );
    const [records] = await db.query(
      `
        SELECT
          pc.commission_id,
          pc.booking_id,
          t.transaction_id,
          pc.driver_id,
          TRIM(CONCAT_WS(' ',
            NULLIF(TRIM(u.first_name),''),
            NULLIF(TRIM(u.last_name),'')
          )) AS driver_name,
          COALESCE(t.final_fare, b.estimated_fare, 0) AS fare_amount,
          CASE
            WHEN COALESCE(t.final_fare, b.estimated_fare, 0) > 0
              THEN ROUND((pc.amount / COALESCE(t.final_fare, b.estimated_fare)) * 100, 2)
            ELSE NULL
          END AS commission_rate,
          pc.amount AS commission_amount,
          DATE_FORMAT(pc.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
        FROM platform_commissions pc
        LEFT JOIN booking b ON b.booking_id = pc.booking_id
        LEFT JOIN (
          SELECT
            booking_id,
            MAX(transaction_id) AS transaction_id,
            MAX(final_fare) AS final_fare,
            MAX(payment_date) AS payment_date
          FROM \`transaction\`
          GROUP BY booking_id
        ) t ON t.booking_id = pc.booking_id
        LEFT JOIN drivers d ON d.driver_id = pc.driver_id
        LEFT JOIN users u ON u.user_id = d.user_id
        ORDER BY pc.created_at DESC, pc.commission_id DESC
        LIMIT 100
      `
    );

    res.json({
      summary: {
        total_commission_earned: parseMoney(summary?.total_commission_earned) || 0,
        total_transactions: Number(summary?.total_transactions || 0)
      },
      records
    });
  } catch (error) {
    console.error('ADMIN_COMMISSIONS_ROUTE error:', error);
    res.status(500).json({ error: 'Unable to load commission earnings right now.' });
  }
});

app.get('/admin/tickets/open', async (req, res) => {
  try {
    console.log('ADMIN_TICKETS_ROUTE hit');
    const [rows] = await db.query(
      `SELECT
         tk.ticket_id, tk.user_id, tk.booking_id,
         tk.description, tk.status,
         DATE_FORMAT(tk.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
         u.user_code,
         TRIM(CONCAT_WS(' ',
           NULLIF(TRIM(u.first_name),''),
           NULLIF(TRIM(u.last_name),'')
         )) AS user_full_name,
         u.phone AS user_phone,
         b.driver_id,
         TRIM(CONCAT_WS(' ',
           NULLIF(TRIM(du.first_name),''),
           NULLIF(TRIM(du.last_name),'')
         )) AS driver_full_name,
         b.pick_location, b.destination,
         b.estimated_distance, b.estimated_fare,
         t.final_fare,
         t.total_time,
         DATE_FORMAT(t.payment_date, '%Y-%m-%d %H:%i:%s') AS payment_date
       FROM tickets tk
       INNER JOIN users u ON u.user_id = tk.user_id
       LEFT JOIN booking b ON b.booking_id = tk.booking_id
       LEFT JOIN \`transaction\` t ON t.booking_id = b.booking_id
       LEFT JOIN drivers d ON d.driver_id = b.driver_id
       LEFT JOIN users du ON du.user_id = d.user_id
       WHERE UPPER(TRIM(tk.status)) != 'CLOSED'
       ORDER BY tk.created_at DESC, tk.ticket_id DESC`
    );
    console.log(`ADMIN_TICKETS_ROUTE rows returned: ${rows.length}`);
    res.json(rows);
  } catch (error) {
    console.error('ADMIN_TICKETS_ROUTE error:', error);
    res.status(500).json({ error: 'Unable to load tickets right now.' });
  }
});

// PUT /admin/tickets/:ticketId/status   â†’  AdminActionResponse
app.put('/admin/tickets/:ticketId/status', async (req, res) => {
  try {
    const ticketId = parseId(req.params.ticketId);
    const status = String(req.body?.status || '').trim();
    if (!ticketId || !status) {
      return res.status(400).json({ error: 'Valid ticket_id and status are required' });
    }

    const [result] = await db.query(
      'UPDATE tickets SET status = ? WHERE ticket_id = ?',
      [status, ticketId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Ticket not found' });

    res.json({ success: true, ticket_id: ticketId, status });
  } catch (error) {
    console.error('ADMIN_TICKET_STATUS error:', error);
    res.status(500).json({ error: 'Unable to update this ticket right now.' });
  }
});

app.post('/notifications/send', async (req, res) => {
  try {
    const { user_id, message } = req.body;
    if (!user_id || !message) {
      return res.status(400).json({ error: 'Required notification fields missing' });
    }

    const notificationId = await createNotification(user_id, message);
    res.status(201).json({ notification_id: notificationId });
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ error: 'Notification failed' });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  try {
    const connection = await db.getConnection();
    connection.release();
    console.log('Connected to MySQL successfully.');

    const syncedRows = await syncApprovedDriverUserAccounts();
    if (syncedRows > 0) {
      console.log(`Synced ${syncedRows} approved driver user account(s).`);
    }
  } catch (error) {
    console.error('Error connecting to MySQL:', error);
  }

  console.log(`API running on http://localhost:${PORT}`);
});
