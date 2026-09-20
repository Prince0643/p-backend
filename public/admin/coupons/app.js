const els = {
  setKeyBtn: document.getElementById('setKeyBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  searchInput: document.getElementById('searchInput'),
  newBtn: document.getElementById('newBtn'),
  couponsList: document.getElementById('couponsList'),
  formTitle: document.getElementById('formTitle'),
  deleteBtn: document.getElementById('deleteBtn'),
  resetBtn: document.getElementById('resetBtn'),
  couponForm: document.getElementById('couponForm'),
  codeInput: document.getElementById('codeInput'),
  discountPercentInput: document.getElementById('discountPercentInput'),
  affiliateFeePercentInput: document.getElementById('affiliateFeePercentInput'),
  affiliateEmailInput: document.getElementById('affiliateEmailInput'),
  expiresAtInput: document.getElementById('expiresAtInput'),
  maxRedemptionsInput: document.getElementById('maxRedemptionsInput'),
  productIdsInput: document.getElementById('productIdsInput'),
  activeInput: document.getElementById('activeInput'),
  notesInput: document.getElementById('notesInput'),
  statusFilter: document.getElementById('statusFilter'),
  loadRedemptionsBtn: document.getElementById('loadRedemptionsBtn'),
  markPaidBtn: document.getElementById('markPaidBtn'),
  redemptionsBody: document.getElementById('redemptionsBody'),
  toast: document.getElementById('toast')
};

const state = {
  apiKey: localStorage.getItem('nx_admin_api_key') || '',
  coupons: [],
  redemptions: [],
  selectedCode: null
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.apiKey
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toLocalDatetimeInputValue(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getFormPayload() {
  const code = els.codeInput.value.trim().toUpperCase();
  const discountPercent = Number(els.discountPercentInput.value) / 100;
  const affiliateFeePercentRaw = els.affiliateFeePercentInput.value.trim();
  const affiliateFeePercent = affiliateFeePercentRaw ? Number(affiliateFeePercentRaw) / 100 : 0;
  const affiliateEmail = els.affiliateEmailInput.value.trim();
  const expiresAtLocal = els.expiresAtInput.value;
  const expiresAt = expiresAtLocal ? new Date(expiresAtLocal).toISOString() : null;
  const maxRedemptionsRaw = els.maxRedemptionsInput.value.trim();
  const maxRedemptions = maxRedemptionsRaw ? Number(maxRedemptionsRaw) : null;
  const productIds = els.productIdsInput.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const active = els.activeInput.value === 'true';
  const notes = els.notesInput.value.trim();

  return {
    code,
    discountPercent,
    affiliateFeePercent,
    affiliateEmail,
    expiresAt,
    maxRedemptions,
    productIds,
    active,
    notes
  };
}

function fillForm(coupon) {
  els.formTitle.textContent = coupon ? `Edit Coupon: ${coupon.code}` : 'New Coupon';
  els.deleteBtn.classList.toggle('hidden', !coupon);
  els.codeInput.value = coupon?.code || '';
  els.discountPercentInput.value = coupon ? Number((coupon.discountPercent * 100).toFixed(4)) : '';
  els.affiliateFeePercentInput.value = coupon ? Number((coupon.affiliateFeePercent * 100).toFixed(4)) : '';
  els.affiliateEmailInput.value = coupon?.affiliateEmail || '';
  els.expiresAtInput.value = toLocalDatetimeInputValue(coupon?.expiresAt);
  els.maxRedemptionsInput.value = coupon?.maxRedemptions ?? '';
  els.productIdsInput.value = (coupon?.productIds || []).join(', ');
  els.activeInput.value = coupon ? String(!!coupon.active) : 'true';
  els.notesInput.value = coupon?.notes || '';
  state.selectedCode = coupon?.code || null;
}

function renderList() {
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = state.coupons.filter((c) => {
    if (!q) return true;
    return c.code.toLowerCase().includes(q) || (c.affiliateEmail || '').toLowerCase().includes(q);
  });

  els.couponsList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = `<div><div class="card__title">No coupons</div><div class="card__meta">Create one to enable a promo code at checkout.</div></div>`;
    els.couponsList.appendChild(empty);
    return;
  }

  for (const c of filtered) {
    const card = document.createElement('div');
    card.className = 'card';
    const expiryLabel = c.expiresAt ? `expires ${new Date(c.expiresAt).toLocaleString()}` : 'no expiry';
    card.innerHTML = `
      <div>
        <div class="card__title">${escapeHtml(c.code)}</div>
        <div class="card__meta">${(c.discountPercent * 100).toFixed(0)}% off${c.affiliateFeePercent ? ` · ${(c.affiliateFeePercent * 100).toFixed(0)}% affiliate fee` : ''} · ${escapeHtml(expiryLabel)}</div>
      </div>
      <div class="pill ${c.active ? 'pill--active' : 'pill--inactive'}">${c.active ? 'Active' : 'Inactive'}</div>
    `;
    card.addEventListener('click', () => selectCoupon(c.code));
    els.couponsList.appendChild(card);
  }
}

async function loadCoupons() {
  const data = await api('/api/admin/coupons');
  state.coupons = data.coupons || [];
  renderList();
}

function selectCoupon(code) {
  const c = state.coupons.find((x) => x.code === code);
  if (!c) return;
  fillForm(c);
}

function renderRedemptions() {
  els.redemptionsBody.innerHTML = '';
  if (state.redemptions.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="10" style="color:var(--muted)">No redemptions loaded.</td>`;
    els.redemptionsBody.appendChild(tr);
    return;
  }

  for (const r of state.redemptions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="redemptionCheckbox" data-id="${escapeHtml(r.id)}" ${r.status === 'paid' ? 'disabled' : ''}/></td>
      <td>${escapeHtml(r.code)}</td>
      <td>${escapeHtml(r.paymentReference)}</td>
      <td>${escapeHtml(r.fullName)}<br/><span style="color:var(--muted)">${escapeHtml(r.email)}</span></td>
      <td>₱${Number(r.baseAmount).toLocaleString()}</td>
      <td>₱${Number(r.discountAmount).toLocaleString()}</td>
      <td>₱${Number(r.affiliateFeeAmount).toLocaleString()}</td>
      <td>${escapeHtml(r.affiliateEmail)}</td>
      <td class="status--${r.status}">${escapeHtml(r.status)}</td>
      <td>${new Date(r.createdAt).toLocaleString()}</td>
    `;
    els.redemptionsBody.appendChild(tr);
  }
}

async function loadRedemptions() {
  const status = els.statusFilter.value;
  const code = state.selectedCode || '';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (code) params.set('code', code);
  const data = await api(`/api/admin/coupons/redemptions${params.toString() ? `?${params}` : ''}`);
  state.redemptions = data.redemptions || [];
  renderRedemptions();
}

function ensureApiKey() {
  if (state.apiKey) return true;
  const val = prompt('Enter ADMIN API Key (x-api-key):');
  if (!val) return false;
  state.apiKey = val.trim();
  localStorage.setItem('nx_admin_api_key', state.apiKey);
  return true;
}

els.setKeyBtn.addEventListener('click', () => {
  const val = prompt('Enter ADMIN API Key (x-api-key):', state.apiKey || '');
  if (val == null) return;
  state.apiKey = String(val).trim();
  localStorage.setItem('nx_admin_api_key', state.apiKey);
  toast('Saved API key.');
});

els.refreshBtn.addEventListener('click', async () => {
  try {
    if (!ensureApiKey()) return;
    await loadCoupons();
    toast('Refreshed.');
  } catch (e) {
    toast(e.message);
  }
});

els.searchInput.addEventListener('input', renderList);

els.newBtn.addEventListener('click', () => {
  fillForm(null);
});

els.resetBtn.addEventListener('click', () => {
  const c = state.selectedCode ? state.coupons.find((x) => x.code === state.selectedCode) : null;
  fillForm(c);
});

els.deleteBtn.addEventListener('click', async () => {
  try {
    if (!state.selectedCode) return;
    if (!confirm(`Delete coupon "${state.selectedCode}"?`)) return;
    if (!ensureApiKey()) return;
    await api(`/api/admin/coupons/${encodeURIComponent(state.selectedCode)}`, { method: 'DELETE' });
    toast('Deleted.');
    state.selectedCode = null;
    fillForm(null);
    await loadCoupons();
  } catch (e) {
    toast(e.message);
  }
});

els.couponForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!ensureApiKey()) return;
    const payload = getFormPayload();
    const method = state.selectedCode ? 'PUT' : 'POST';
    const path = state.selectedCode
      ? `/api/admin/coupons/${encodeURIComponent(payload.code)}`
      : '/api/admin/coupons';
    const data = await api(path, { method, body: payload });
    toast('Saved.');
    await loadCoupons();
    selectCoupon(data.coupon.code);
  } catch (err) {
    toast(err.message);
  }
});

els.loadRedemptionsBtn.addEventListener('click', async () => {
  try {
    if (!ensureApiKey()) return;
    await loadRedemptions();
    toast('Loaded redemptions.');
  } catch (e) {
    toast(e.message);
  }
});

els.markPaidBtn.addEventListener('click', async () => {
  try {
    if (!ensureApiKey()) return;
    const ids = Array.from(document.querySelectorAll('.redemptionCheckbox:checked')).map((el) => el.dataset.id);
    if (ids.length === 0) return toast('Select at least one redemption.');
    if (!confirm(`Mark ${ids.length} redemption(s) as paid?`)) return;
    await api('/api/admin/coupons/redemptions/mark-paid', { method: 'POST', body: { ids } });
    toast('Marked as paid.');
    await loadRedemptions();
  } catch (e) {
    toast(e.message);
  }
});

(async function init() {
  try {
    if (!ensureApiKey()) return;
    await loadCoupons();
    await loadRedemptions();
  } catch (e) {
    toast(e.message);
  }
})();
