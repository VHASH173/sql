'use strict';

/**
 * fix_missing_tables.js
 * ---------------------
 * Crea todas las tablas necesarias en la BD de producción (Aiven) si no
 * existen todavía. Se ejecuta ANTES de TransityDB.js en el script "start"
 * para que Render (plan gratuito, sin shell) pueda auto-repararse.
 *
 * Al terminar exitosamente hace process.exit(0) para que el shell &&
 * continúe con "node TransityDB.js". Si falla, process.exit(1) aborta
 * el arranque y Render muestra el error en los logs.
 */

const mysql = require('mysql2/promise');
const path  = require('path');
const fs    = require('fs');

// ── Carga manual del .env (por si dotenv no está disponible aún) ─────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sep = trimmed.indexOf('=');
    if (sep === -1) continue;

    const key = trimmed.slice(0, sep).trim();
    let value  = trimmed.slice(sep + 1).trim();

    // Quitar comillas opcionales
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// ── Configuración de conexión (igual que TransityDB.js) ──────────────────────
function buildConfig() {
  const rawHost = (process.env.DB_HOST || process.env.DATABASE_URL || '').trim();

  // Soporte para DATABASE_URL de Aiven: mysql://user:pass@host:port/db?...
  if (rawHost.startsWith('mysql://')) {
    try {
      const url   = new URL(rawHost);
      return {
        host     : url.hostname,
        port     : Number(url.port) || 3306,
        user     : decodeURIComponent(url.username),
        password : decodeURIComponent(url.password),
        database : url.pathname.replace(/^\//, '') || 'defaultdb',
        ssl      : { rejectUnauthorized: false },
        multipleStatements: false,
      };
    } catch (_) { /* fallthrough a variables individuales */ }
  }

  return {
    host     : rawHost.replace(/^mysql:\/\//, '').split(':')[0],
    port     : Number(process.env.DB_PORT || 3306),
    user     : (process.env.DB_USER     || '').trim(),
    password : (process.env.DB_PASSWORD || '').trim(),
    database : (process.env.DB_NAME     || 'defaultdb').trim(),
    ssl      : { rejectUnauthorized: false },
    multipleStatements: false,
  };
}

// ── Definición de tablas ─────────────────────────────────────────────────────
const TABLES = [
  // ── Tablas base (sin dependencias) ─────────────────────────────────────────
  {
    name: 'users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        user_id          INT            NOT NULL AUTO_INCREMENT,
        user_code        VARCHAR(20)    DEFAULT NULL,
        first_name       VARCHAR(45)    NOT NULL,
        middle_name      VARCHAR(45)    DEFAULT NULL,
        last_name        VARCHAR(45)    NOT NULL,
        extension        VARCHAR(16)    DEFAULT NULL,
        date_of_birth    DATE           DEFAULT NULL,
        gender           ENUM('Male','Female','Others','Prefer not say') DEFAULT NULL,
        email_address    VARCHAR(128)   NOT NULL,
        password         VARCHAR(64)    NOT NULL,
        phone            VARCHAR(45)    DEFAULT NULL,
        address          VARCHAR(254)   DEFAULT NULL,
        city             VARCHAR(45)    DEFAULT NULL,
        region           VARCHAR(100)   DEFAULT NULL,
        zip_code         VARCHAR(45)    DEFAULT NULL,
        account_type     ENUM('Customer','Driver','Admin') DEFAULT 'Customer',
        profile_complete TINYINT(1)     DEFAULT 0,
        picture          LONGBLOB       DEFAULT NULL,
        phone_verified   TINYINT(1)     DEFAULT 0,
        applied          TINYINT(1)     DEFAULT 0,
        PRIMARY KEY (user_id),
        UNIQUE KEY user_code      (user_code),
        UNIQUE KEY email_address  (email_address)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },

  // ── discount_requests ───────────────────────────────────────────────────────
  {
    name: 'discount_requests',
    sql: `
      CREATE TABLE IF NOT EXISTS discount_requests (
        request_id           INT          NOT NULL AUTO_INCREMENT,
        user_id              INT          NOT NULL,
        type                 ENUM('STUDENT','SENIOR','PWD') NOT NULL,
        id_reference_number  VARCHAR(100) DEFAULT NULL,
        id_picture           LONGBLOB     DEFAULT NULL,
        id_picture_mime_type VARCHAR(100) DEFAULT NULL,
        status               ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
        submitted_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_at          TIMESTAMP    NULL DEFAULT NULL,
        PRIMARY KEY (request_id),
        KEY user_id (user_id),
        CONSTRAINT discount_requests_ibfk_1
          FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },

  // ── drivers ─────────────────────────────────────────────────────────────────
  {
    name: 'drivers',
    sql: `
      CREATE TABLE IF NOT EXISTS drivers (
        driver_id           INT         NOT NULL AUTO_INCREMENT,
        user_id             INT         NOT NULL,
        license_number      VARCHAR(64) NOT NULL,
        license_expiry_date DATE        NOT NULL,
        license_type        VARCHAR(32) DEFAULT NULL,
        restriction_code    VARCHAR(32) DEFAULT NULL,
        approval_status     ENUM('Pending','Approved','Rejected') DEFAULT 'Pending',
        date_applied        DATE        DEFAULT NULL,
        date_approved       DATE        DEFAULT NULL,
        id_picture_front    LONGBLOB    DEFAULT NULL,
        id_picture_back     LONGBLOB    DEFAULT NULL,
        picture             LONGBLOB    DEFAULT NULL,
        PRIMARY KEY (driver_id),
        KEY user_id (user_id),
        CONSTRAINT drivers_ibfk_1
          FOREIGN KEY (user_id) REFERENCES users (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },

  // ── vehicles ─────────────────────────────────────────────────────────────────
  {
    name: 'vehicles',
    sql: `
      CREATE TABLE IF NOT EXISTS vehicles (
        vehicle_id   INT         NOT NULL AUTO_INCREMENT,
        driver_id    INT         NOT NULL,
        vehicle_type ENUM('Car','Motorcycle','Van') NOT NULL,
        plate_number VARCHAR(32) NOT NULL,
        model        VARCHAR(64) DEFAULT NULL,
        color        VARCHAR(32) DEFAULT NULL,
        capacity     INT         DEFAULT NULL,
        PRIMARY KEY (vehicle_id),
        KEY driver_id (driver_id),
        CONSTRAINT vehicles_ibfk_1
          FOREIGN KEY (driver_id) REFERENCES drivers (driver_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },

  // ── driver_wallets ───────────────────────────────────────────────────────────
  {
    name: 'driver_wallets',
    sql: `
      CREATE TABLE IF NOT EXISTS driver_wallets (
        wallet_id                INT            NOT NULL AUTO_INCREMENT,
        driver_id                INT            NOT NULL,
        balance                  DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
        total_completed_bookings INT            NOT NULL DEFAULT 0,
        commission_rate          DECIMAL(5,2)   NOT NULL DEFAULT 10.00,
        created_at               DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at               DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (wallet_id),
        UNIQUE KEY uq_driver_wallets_driver_id (driver_id),
        KEY idx_driver_wallets_driver_id (driver_id),
        CONSTRAINT driver_wallets_ibfk_1
          FOREIGN KEY (driver_id) REFERENCES drivers (driver_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },

  // ── booking ──────────────────────────────────────────────────────────────────
  {
    name: 'booking',
    sql: `
      CREATE TABLE IF NOT EXISTS booking (
        booking_id         INT            NOT NULL AUTO_INCREMENT,
        user_id            INT            NOT NULL,
        driver_id          INT            DEFAULT NULL,
        pick_location      VARCHAR(255)   NOT NULL,
        destination        VARCHAR(255)   NOT NULL,
        estimated_distance DECIMAL(10,2)  DEFAULT NULL,
        estimated_fare     DECIMAL(10,2)  DEFAULT NULL,
        trip_map           LONGBLOB       DEFAULT NULL,
        status             ENUM('Pending','Accepted','In Progress','Completed','Cancelled','Rejected')
                           NOT NULL DEFAULT 'Pending',
        created_at         DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (booking_id),
        KEY idx_booking_user_id   (user_id),
        KEY idx_booking_driver_id (driver_id),
        CONSTRAINT booking_ibfk_1
          FOREIGN KEY (user_id)   REFERENCES users   (user_id)   ON DELETE CASCADE,
        CONSTRAINT booking_ibfk_2
          FOREIGN KEY (driver_id) REFERENCES drivers (driver_id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },

  // ── tickets ──────────────────────────────────────────────────────────────────
  {
    name: 'tickets',
    sql: `
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id   INT          NOT NULL AUTO_INCREMENT,
        user_id     INT          NOT NULL,
        booking_id  INT          DEFAULT NULL,
        description TEXT         NOT NULL,
        status      ENUM('Open','In Review','Resolved','Closed') NOT NULL DEFAULT 'Open',
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (ticket_id),
        KEY idx_tickets_user_id    (user_id),
        KEY idx_tickets_booking_id (booking_id),
        CONSTRAINT tickets_ibfk_1
          FOREIGN KEY (user_id)    REFERENCES users    (user_id)    ON DELETE CASCADE,
        CONSTRAINT tickets_ibfk_2
          FOREIGN KEY (booking_id) REFERENCES booking  (booking_id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
  },
];

// ── Ejecución principal ──────────────────────────────────────────────────────
async function run() {
  const config = buildConfig();
  console.log(`[fix_missing_tables] Conectando a ${config.database} en ${config.host}:${config.port} …`);

  const connection = await mysql.createConnection(config);

  for (const table of TABLES) {
    try {
      await connection.query(table.sql);
      console.log(`[fix_missing_tables] ✔  ${table.name}`);
    } catch (err) {
      // Los errores de FK duplicada o constraint ya existente no son fatales
      if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_FK_DUP_NAME') {
        console.warn(`[fix_missing_tables] ⚠  ${table.name}: ${err.code} (se ignora)`);
      } else {
        console.error(`[fix_missing_tables] ✖  ${table.name}:`, err.message);
        await connection.end();
        process.exit(1);
      }
    }
  }

  console.log('[fix_missing_tables] ✅ Todas las tablas verificadas/creadas. Cerrando conexión …');
  await connection.end();
  process.exit(0); // ← OBLIGATORIO: permite que "&&" continúe con TransityDB.js
}

run().catch(async (err) => {
  console.error('[fix_missing_tables] ERROR FATAL:', err.message || err);
  process.exit(1);
});
