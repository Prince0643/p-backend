// tests/migrate-test-db.js
// Applies db/schema.sql to the test database and seeds one deterministic test product.
// Run automatically via the "pretest" npm script before the suite.
require('./setupEnv');
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

async function main() {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const client = await pool.connect();
    try {
        await client.query(schema);
        await client.query(
            `INSERT INTO products (id, name, amount_php, currency, billing_type)
             VALUES
                ('test_product', 'Test Product', 500, 'PHP', 'one_time'),
                ('test_product_2', 'Test Product 2', 750, 'PHP', 'one_time')
             ON CONFLICT (id) DO UPDATE SET amount_php = EXCLUDED.amount_php`
        );
        console.log('Test database ready.');
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Failed to prepare test database:', err.message);
    console.error('Is the local Postgres container running, and does the "pbackend_test" database exist?');
    process.exit(1);
});
