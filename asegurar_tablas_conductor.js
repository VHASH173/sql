const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

function loadLocalEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnvFile();

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false
    }
  });

  console.log('Verificando tablas para solicitudes de conductor...');

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
      KEY user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

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
      KEY driver_id (driver_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `);

  console.log('Tablas drivers y vehicles aseguradas.');
  await connection.end();
}

run().catch(err => {
  console.error('Error al asegurar tablas:', err);
  process.exit(1);
});
