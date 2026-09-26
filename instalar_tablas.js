const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function instalar() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
        multipleStatements: true,
        ssl: {
            rejectUnauthorized: false
        }
    });

    console.log('Conectado a la base de datos MySQL...');

    try {
        const sqlPath = path.join(__dirname, 'schema.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('Ejecutando schema.sql...');
        await connection.query(sql);
        console.log('Tablas creadas exitosamente.');
    } catch (error) {
        console.error('Error al instalar las tablas:', error);
    } finally {
        await connection.end();
    }
}

instalar();
