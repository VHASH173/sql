const mysql = require('mysql2/promise');
require('dotenv').config();

async function makeMeAdmin() {
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

    const updateQuery = "UPDATE users SET account_type = 'Admin' WHERE email_address = 'mvegxs@gmail.com'";

    try {
        console.log("Intentando actualizar el rango a 'Admin' para: mvegxs@gmail.com...");
        const [result] = await connection.query(updateQuery);

        if (result.affectedRows > 0) {
            console.log("¡Éxito! Tu cuenta ahora tiene permisos de Administrador.");
        } else {
            console.warn("No se encontró ningún usuario con el correo 'mvegxs@gmail.com'. ¿Ya te registraste en la app?");
        }
    } catch (error) {
        console.error("Error al ejecutar la consulta SQL:", error);
    } finally {
        await connection.end();
    }
}

makeMeAdmin();
