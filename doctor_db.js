const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 1. Configuración y Carga de Variables de Entorno
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        console.error('ERROR: No se encontró el archivo .env en la carpeta backend.');
        return false;
    }
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            let value = parts.slice(1).join('=').trim();
            // Limpiar comillas si existen
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            process.env[key] = value;
        }
    });
    return true;
}

const tables = {
    users: `
        CREATE TABLE users (
          user_id int NOT NULL AUTO_INCREMENT,
          user_code varchar(20) DEFAULT NULL,
          first_name varchar(45) NOT NULL,
          middle_name varchar(45) DEFAULT NULL,
          last_name varchar(45) NOT NULL,
          extension varchar(16) DEFAULT NULL,
          date_of_birth date DEFAULT NULL,
          gender enum('Male','Female','Others','Prefer not say') DEFAULT NULL,
          email_address varchar(128) NOT NULL,
          password varchar(64) NOT NULL,
          phone varchar(45) DEFAULT NULL,
          address varchar(254) DEFAULT NULL,
          city varchar(45) DEFAULT NULL,
          region varchar(100) DEFAULT NULL,
          zip_code varchar(45) DEFAULT NULL,
          account_type enum('Customer','Driver','Admin') DEFAULT 'Customer',
          profile_complete tinyint(1) DEFAULT '0',
          picture longblob,
          phone_verified tinyint(1) DEFAULT '0',
          applied tinyint(1) DEFAULT '0',
          PRIMARY KEY (user_id),
          UNIQUE KEY email_address (email_address),
          UNIQUE KEY user_code (user_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    drivers: `
        CREATE TABLE drivers (
          driver_id int NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          license_number varchar(64) NOT NULL,
          license_expiry_date date NOT NULL,
          license_type varchar(32) DEFAULT NULL,
          restriction_code varchar(32) DEFAULT NULL,
          approval_status enum('Pending','Approved','Rejected') DEFAULT 'Pending',
          date_applied date DEFAULT NULL,
          date_approved date DEFAULT NULL,
          id_picture_front longblob,
          id_picture_back longblob,
          picture longblob,
          PRIMARY KEY (driver_id),
          KEY user_id (user_id),
          CONSTRAINT drivers_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    vehicles: `
        CREATE TABLE vehicles (
          vehicle_id int NOT NULL AUTO_INCREMENT,
          driver_id int NOT NULL,
          vehicle_type enum('Car','Motorcycle','Van') NOT NULL,
          plate_number varchar(32) NOT NULL,
          model varchar(64) DEFAULT NULL,
          color varchar(32) DEFAULT NULL,
          capacity int DEFAULT NULL,
          PRIMARY KEY (vehicle_id),
          KEY driver_id (driver_id),
          CONSTRAINT vehicles_ibfk_1 FOREIGN KEY (driver_id) REFERENCES drivers (driver_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    booking: `
        CREATE TABLE booking (
          booking_id int NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          driver_id int DEFAULT NULL,
          pick_location varchar(254) NOT NULL,
          destination varchar(254) NOT NULL,
          estimated_distance decimal(10,2) DEFAULT NULL,
          estimated_fare decimal(10,2) DEFAULT NULL,
          status enum('Pending','Accepted','In Progress','Completed','Cancelled','Rejected') DEFAULT 'Pending',
          trip_map longblob,
          PRIMARY KEY (booking_id),
          KEY user_id (user_id),
          KEY driver_id (driver_id),
          CONSTRAINT booking_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id),
          CONSTRAINT booking_ibfk_2 FOREIGN KEY (driver_id) REFERENCES drivers (driver_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    transaction: `
        CREATE TABLE \`transaction\` (
          transaction_id int NOT NULL AUTO_INCREMENT,
          booking_id int NOT NULL,
          final_fare decimal(10,2) NOT NULL,
          payment_date datetime NOT NULL,
          trip_map longblob,
          total_time time DEFAULT '00:00:00',
          PRIMARY KEY (transaction_id),
          KEY booking_id (booking_id),
          CONSTRAINT transaction_ibfk_1 FOREIGN KEY (booking_id) REFERENCES booking (booking_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    discount_requests: `
        CREATE TABLE discount_requests (
          request_id int NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          type enum('STUDENT','SENIOR','PWD') NOT NULL,
          id_reference_number varchar(100) DEFAULT NULL,
          id_picture longblob,
          id_picture_mime_type varchar(100) DEFAULT NULL,
          status enum('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
          submitted_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          reviewed_at timestamp NULL DEFAULT NULL,
          PRIMARY KEY (request_id),
          KEY user_id (user_id),
          CONSTRAINT discount_requests_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    driver_wallets: `
        CREATE TABLE driver_wallets (
          wallet_id int NOT NULL AUTO_INCREMENT,
          driver_id int NOT NULL,
          balance decimal(10,2) DEFAULT '0.00',
          total_completed_bookings int DEFAULT '0',
          commission_rate decimal(5,2) DEFAULT '18.00',
          created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (wallet_id),
          UNIQUE KEY driver_id (driver_id),
          CONSTRAINT driver_wallets_ibfk_1 FOREIGN KEY (driver_id) REFERENCES drivers (driver_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    driver_wallet_transactions: `
        CREATE TABLE driver_wallet_transactions (
          transaction_id int NOT NULL AUTO_INCREMENT,
          wallet_id int NOT NULL,
          type enum('TOPUP','COMMISSION_DEDUCTION') NOT NULL,
          amount decimal(10,2) NOT NULL,
          reference_id int DEFAULT NULL,
          description varchar(255) DEFAULT NULL,
          created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (transaction_id),
          KEY wallet_id (wallet_id),
          CONSTRAINT driver_wallet_transactions_ibfk_1 FOREIGN KEY (wallet_id) REFERENCES driver_wallets (wallet_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    promo_codes: `
        CREATE TABLE promo_codes (
          promo_id int NOT NULL AUTO_INCREMENT,
          code varchar(50) NOT NULL,
          type enum('FIXED','PERCENTAGE') NOT NULL,
          value decimal(10,2) NOT NULL,
          minimum_fare decimal(10,2) DEFAULT '0.00',
          max_discount decimal(10,2) DEFAULT NULL,
          usage_limit int DEFAULT NULL,
          used_count int DEFAULT '0',
          expiration_date datetime DEFAULT NULL,
          is_active tinyint(1) DEFAULT '1',
          created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (promo_id),
          UNIQUE KEY code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    promo_redemptions: `
        CREATE TABLE promo_redemptions (
          redemption_id int NOT NULL AUTO_INCREMENT,
          promo_id int NOT NULL,
          user_id int NOT NULL,
          booking_id int NOT NULL,
          created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (redemption_id),
          KEY promo_id (promo_id),
          KEY user_id (user_id),
          CONSTRAINT promo_redemptions_ibfk_1 FOREIGN KEY (promo_id) REFERENCES promo_codes (promo_id) ON DELETE CASCADE,
          CONSTRAINT promo_redemptions_ibfk_2 FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    customer_vouchers: `
        CREATE TABLE customer_vouchers (
          voucher_id int NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          type enum('FIXED','PERCENTAGE') NOT NULL,
          value decimal(10,2) NOT NULL,
          max_discount decimal(10,2) DEFAULT NULL,
          grant_milestone_completed_bookings int DEFAULT NULL,
          status enum('AVAILABLE','USED','EXPIRED') DEFAULT 'AVAILABLE',
          is_used tinyint(1) NOT NULL DEFAULT '0',
          expiration_date datetime DEFAULT NULL,
          created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
          redeemed_at datetime DEFAULT NULL,
          notified_at datetime DEFAULT NULL,
          PRIMARY KEY (voucher_id),
          KEY user_id (user_id),
          CONSTRAINT customer_vouchers_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    platform_commissions: `
        CREATE TABLE platform_commissions (
          commission_id int NOT NULL AUTO_INCREMENT,
          booking_id int NOT NULL,
          driver_id int NOT NULL,
          amount decimal(10,2) NOT NULL,
          created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (commission_id),
          KEY driver_id (driver_id),
          CONSTRAINT platform_commissions_ibfk_1 FOREIGN KEY (driver_id) REFERENCES drivers (driver_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    notifications: `
        CREATE TABLE notifications (
          notification_id int NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          message text NOT NULL,
          status enum('Unread','Read') DEFAULT 'Unread',
          created_at datetime DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (notification_id),
          KEY user_id (user_id),
          CONSTRAINT notifications_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `,
    tickets: `
        CREATE TABLE tickets (
          ticket_id int NOT NULL AUTO_INCREMENT,
          user_id int NOT NULL,
          booking_id int DEFAULT NULL,
          description text NOT NULL,
          status enum('Open','In Review','Resolved','Closed') DEFAULT 'Open',
          created_at datetime DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (ticket_id),
          KEY user_id (user_id),
          KEY booking_id (booking_id),
          CONSTRAINT tickets_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id),
          CONSTRAINT tickets_ibfk_2 FOREIGN KEY (booking_id) REFERENCES booking (booking_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `
};

async function diagnose() {
    console.log('--- DIAGNÓSTICO DE BASE DE DATOS TRANSITY ---');

    if (!loadEnv()) return;

    const config = {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: { rejectUnauthorized: false },
        connectTimeout: 10000
    };

    console.log(`Intentando conectar a: ${config.host}:${config.port}...`);

    let connection;
    try {
        connection = await mysql.createConnection(config);
        console.log('âœ… CONEXIÓN EXITOSA (SSL Activado)');
    } catch (error) {
        console.error('âŒ FALLO DE CONEXIÓN:');
        if (error.code === 'ENOTFOUND') {
            console.error(`  - El host "${config.host}" no es accesible. Verifique que no haya espacios en blanco en el .env o que la URL de Aiven sea correcta.`);
        } else if (error.code === 'ETIMEDOUT') {
            console.error('  - Tiempo de espera agotado. Verifique si su IP tiene acceso permitido en el panel de Aiven.');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('  - Usuario o contraseña incorrectos.');
        } else {
            console.error(`  - Error: ${error.message}`);
        }
        return;
    }

    try {
        console.log('\nAuditando tablas necesarias...');
        const [existingTablesRaw] = await connection.query('SHOW TABLES');
        const existingTables = existingTablesRaw.map(row => Object.values(row)[0]);

        for (const tableName in tables) {
            if (existingTables.includes(tableName)) {
                console.log(`  [âœ…] Tabla "${tableName}" existe.`);
            } else {
                console.warn(`  [âš…] Tabla "${tableName}" NO encontrada. Reparando...`);
                try {
                    await connection.query(tables[tableName]);
                    console.log(`      -> Tabla "${tableName}" creada con éxito.`);
                } catch (createError) {
                    console.error(`      -> Error al crear "${tableName}": ${createError.message}`);
                }
            }
        }

        console.log('\n--- DIAGNÓSTICO FINALIZADO ---');
        console.log('El sistema está listo para operar.');

    } catch (err) {
        console.error('Error durante la auditoría:', err.message);
    } finally {
        await connection.end();
    }
}

diagnose();
