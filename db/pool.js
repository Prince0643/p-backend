// db/pool.js
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not configured - database-backed stores will fail to connect.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
    console.error('Unexpected Postgres pool error:', err.message);
});

module.exports = pool;
