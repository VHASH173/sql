const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// Manual env loading if dotenv is not immediately available or to be safe
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length === 2) {
      process.env[parts[0].trim()] = parts[1].trim();
    }
  });
}

loadEnv();

async function run() {
  const config = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false
    }
  };

  console.log('Connecting to database:', config.database, 'at', config.host);

  const connection = await mysql.createConnection(config);

  console.log('Creating table: discount_requests');
  await connection.query(`
    CREATE TABLE IF NOT EXISTS discount_requests (
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
  `);

  console.log('Creating table: drivers');
  await connection.query(`
    CREATE TABLE IF NOT EXISTS drivers (
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
      CONSTRAINT drivers_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

  console.log('Creating table: vehicles');
  await connection.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      vehicle_id int NOT NULL AUTO_INCREMENT,
      driver_id int NOT NULL,
      vehicle_type enum('Car','Motorcycle','Van') NOT NULL,
      plate_number varchar(32) NOT NULL,
      model varchar(64) DEFAULT NULL,
      color varchar(32) DEFAULT NULL,
      capacity int DEFAULT NULL,
      PRIMARY KEY (vehicle_id),
      KEY driver_id (driver_id),
      CONSTRAINT vehicles_ibfk_1 FOREIGN KEY (driver_id) REFERENCES drivers (driver_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

  console.log('All tables verified/created successfully.');
  await connection.end();
}

run().catch(err => {
  console.error('FAILED to create tables:', err);
  process.exit(1);
});
