// utils/adminStore.js
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { validateEmail } = require('./helpers');

const BCRYPT_ROUNDS = 10;

function rowToAdmin(row) {
    return {
        id: row.id,
        email: row.email,
        createdAt: new Date(row.created_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        active: !row.revoked_at
    };
}

async function listAdmins() {
    const { rows } = await pool.query('SELECT * FROM admins ORDER BY created_at DESC');
    return rows.map(rowToAdmin);
}

async function findAdminById(id) {
    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [String(id)]);
    return rows[0] || null;
}

async function findAdminByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const { rows } = await pool.query('SELECT * FROM admins WHERE email = $1', [normalized]);
    return rows[0] || null;
}

async function createAdmin({ email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!validateEmail(normalizedEmail)) throw new Error('A valid email is required');
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');

    if (await findAdminByEmail(normalizedEmail)) {
        throw new Error('An admin with this email already exists');
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const id = `ADM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const { rows } = await pool.query(
        `INSERT INTO admins (id, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
        [id, normalizedEmail, passwordHash]
    );
    return rowToAdmin(rows[0]);
}

/** Verifies email+password. Returns the admin record (safe shape) on success, or null. */
async function verifyAdminCredentials({ email, password }) {
    const row = await findAdminByEmail(email);
    if (!row || row.revoked_at) return null;
    const matches = await bcrypt.compare(String(password || ''), row.password_hash);
    if (!matches) return null;
    return rowToAdmin(row);
}

async function revokeAdmin(id) {
    const { rows } = await pool.query(
        `UPDATE admins SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
        [String(id)]
    );
    return rows[0] ? rowToAdmin(rows[0]) : null;
}

/** True if the admin id still exists and hasn't been revoked - used on every authenticated request. */
async function isAdminActive(id) {
    const row = await findAdminById(id);
    return Boolean(row && !row.revoked_at);
}

module.exports = {
    listAdmins,
    findAdminById,
    findAdminByEmail,
    createAdmin,
    verifyAdminCredentials,
    revokeAdmin,
    isAdminActive
};
