// tests/setupEnv.js
// Required as the FIRST line of every test file, before any app module is required -
// db/pool.js reads process.env.DATABASE_URL once at module load time, so the override
// below must land before anything requires it (directly or transitively).
require('dotenv').config();

process.env.NODE_ENV = 'test';

// Never run tests against the real dev/production database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    || 'postgres://pbackend:pbackend_dev_local@localhost:5432/pbackend_test';

// Fixed, known values so tests don't depend on whatever's in the real .env.
process.env.PAYMONGO_WEBHOOK_SECRET = 'test_webhook_secret_for_automated_tests';
process.env.ADMIN_API_KEY = 'test_admin_key_for_automated_tests';
process.env.AUTH_TOKEN_SECRET = 'test_auth_token_secret_for_automated_tests';

module.exports = {
    hasPaymongoKey: Boolean(process.env.PAYMONGO_SECRET_KEY)
};
