const mysql = require('mysql2/promise');
require('dotenv').config();

async function forceCreateUsersTable() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        ssl: {
            rejectUnauthorized: false
        }
    });

    console.log(`Conectado a la base de datos: ${process.env.DB_NAME}`);

    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
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
    `;

    try {
        console.log('Creando tabla "users" en la base de datos actual...');
        await connection.query(createTableQuery);
        console.log('Tabla "users" verificada/creada con éxito.');
    } catch (error) {
        console.error('Error al crear la tabla users:', error);
    } finally {
        await connection.end();
    }
}

forceCreateUsersTable();
