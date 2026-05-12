const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'ghl_invoice_schedules.json');

function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) return { version: 1, schedules: {} };
    const schedules = parsed.value && typeof parsed.value === 'object' ? (parsed.value.schedules || parsed.value) : {};
    return { version: Number(parsed.value?.version || 1), schedules: schedules && typeof schedules === 'object' ? schedules : {} };
  } catch {
    return { version: 1, schedules: {} };
  }
}

function writeStore(store) {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
}

function makeKey({ locationId, contactId, productId }) {
  return `${String(locationId || '').trim()}:${String(contactId || '').trim()}:${String(productId || '').trim()}`;
}

function getScheduleId({ locationId, contactId, productId }) {
  const { schedules } = readStore();
  const key = makeKey({ locationId, contactId, productId });
  return schedules[key] || null;
}

function setScheduleId({ locationId, contactId, productId, scheduleId }) {
  const store = readStore();
  const key = makeKey({ locationId, contactId, productId });
  store.schedules[key] = String(scheduleId);
  writeStore(store);
  return store.schedules[key];
}

module.exports = {
  STORE_PATH,
  getScheduleId,
  setScheduleId
};

