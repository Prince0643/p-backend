const pool = require('../db/pool');

function normalize(value) {
    return String(value || '').trim();
}

async function getScheduleId({ locationId, contactId, productId }) {
    const { rows } = await pool.query(
        `SELECT schedule_id FROM ghl_invoice_schedules WHERE location_id = $1 AND contact_id = $2 AND product_id = $3`,
        [normalize(locationId), normalize(contactId), normalize(productId)]
    );
    return rows[0]?.schedule_id || null;
}

async function setScheduleId({ locationId, contactId, productId, scheduleId }) {
    const { rows } = await pool.query(
        `INSERT INTO ghl_invoice_schedules (location_id, contact_id, product_id, schedule_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (location_id, contact_id, product_id) DO UPDATE SET schedule_id = EXCLUDED.schedule_id
         RETURNING schedule_id`,
        [normalize(locationId), normalize(contactId), normalize(productId), String(scheduleId)]
    );
    return rows[0].schedule_id;
}

module.exports = {
    getScheduleId,
    setScheduleId
};
