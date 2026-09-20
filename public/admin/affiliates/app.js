const els = {
  setKeyBtn: document.getElementById('setKeyBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  searchInput: document.getElementById('searchInput'),
  affiliatesList: document.getElementById('affiliatesList'),
  detailTitle: document.getElementById('detailTitle'),
  statusSelect: document.getElementById('statusSelect'),
  updateStatusBtn: document.getElementById('updateStatusBtn'),
  detailEmpty: document.getElementById('detailEmpty'),
  detailBody: document.getElementById('detailBody'),
  detailContact: document.getElementById('detailContact'),
  detailSocials: document.getElementById('detailSocials'),
  detailRegion: document.getElementById('detailRegion'),
  detailPayout: document.getElementById('detailPayout'),
  detailCoupon: document.getElementById('detailCoupon'),
  detailRegistered: document.getElementById('detailRegistered'),
  detailTerms: document.getElementById('detailTerms'),
  toast: document.getElementById('toast')
};

const STATUSES = ['active', 'suspended', 'terminated'];

const state = {
  apiKey: localStorage.getItem('nx_admin_api_key') || '',
  affiliates: [],
  selectedId: null
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

function pillClass(status) {
  if (status === 'active') return 'pill pill--active';
  if (status === 'suspended') return 'pill pill--suspended';
  return 'pill pill--terminated';
}

function renderList() {
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = state.affiliates.filter((a) => {
    if (!q) return true;
    const hay = `${a.firstName} ${a.lastName} ${a.email} ${a.couponCode}`.toLowerCase();
    return hay.includes(q);
  });

  els.affiliatesList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = `<div><div class="card__title">No affiliates</div><div class="card__meta">Registrations will appear here.</div></div>`;
    els.affiliatesList.appendChild(empty);
    return;
  }

  for (const a of filtered) {
    const card = document.createElement('div');
    card.className = `card${a.id === state.selectedId ? ' is-selected' : ''}`;
    card.innerHTML = `
      <div>
        <div class="card__title">${escapeHtml(a.firstName)} ${escapeHtml(a.lastName)}</div>
        <div class="card__meta">${escapeHtml(a.email)} · ${escapeHtml(a.paymentRegion)} · <span class="code">${escapeHtml(a.couponCode)}</span></div>
      </div>
      <div class="${pillClass(a.status)}">${escapeHtml(a.status)}</div>
    `;
    card.addEventListener('click', () => selectAffiliate(a.id));
    els.affiliatesList.appendChild(card);
  }
}

async function loadAffiliates() {
  const data = await api('/api/admin/affiliates');
  state.affiliates = data.affiliates || [];
  renderList();
}

function renderPayout(affiliate) {
  const d = affiliate.payoutDetails || {};
  if (affiliate.paymentRegion === 'PH') {
    if (affiliate.preferredBank === 'GCASH' || affiliate.preferredBank === 'MAYA') {
      return `${escapeHtml(affiliate.preferredBank)}<br/>${escapeHtml(d.accountHolderName)}<br/>${escapeHtml(d.mobileNumber)}`;
    }
    return `${escapeHtml(d.bankName || affiliate.preferredBank)}<br/>${escapeHtml(d.accountName)}<br/>Acct: ${escapeHtml(d.accountNumber)}<br/>Branch: ${escapeHtml(d.bankBranch)}`;
  }
  return `${escapeHtml(affiliate.preferredBank)}<br/>${escapeHtml(d.accountName)}<br/>${escapeHtml(d.accountEmail)}`;
}

function renderSocials(affiliate) {
  const s = affiliate.socials || {};
  const entries = Object.entries(s).filter(([, v]) => v);
  if (entries.length === 0) return '<span style="color:var(--muted)">None provided</span>';
  return entries.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join('<br/>');
}

async function selectAffiliate(id) {
  try {
    state.selectedId = id;
    renderList();

    const data = await api(`/api/admin/affiliates/${encodeURIComponent(id)}`);
    const a = data.affiliate;
    const coupon = data.coupon;

    els.detailTitle.textContent = `${a.firstName} ${a.lastName}`;
    els.detailEmpty.classList.add('hidden');
    els.detailBody.classList.remove('hidden');
    els.statusSelect.classList.remove('hidden');
    els.updateStatusBtn.classList.remove('hidden');

    els.statusSelect.innerHTML = STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('');

    els.detailContact.innerHTML = `${escapeHtml(a.email)}<br/>${escapeHtml(a.contactNumber)}`;
    els.detailSocials.innerHTML = renderSocials(a);
    els.detailRegion.textContent = a.paymentRegion;
    els.detailPayout.innerHTML = renderPayout(a);

    const couponStatus = coupon
      ? `${coupon.active ? 'Active' : 'Inactive'} · ${coupon.discountPercent * 100}% off / ${coupon.affiliateFeePercent * 100}% fee${coupon.maxRedemptions ? ` · limit ${coupon.maxRedemptions}` : ''}`
      : 'Coupon record not found';
    els.detailCoupon.innerHTML = `<span class="code">${escapeHtml(a.couponCode)}</span><br/>${escapeHtml(couponStatus)}<br/><a href="/admin/coupons" target="_blank">Manage in Coupons →</a>`;

    els.detailRegistered.textContent = new Date(a.createdAt).toLocaleString();
    els.detailTerms.textContent = a.termsAccepted ? `Yes${a.termsVersion ? ` (v${a.termsVersion})` : ''}` : 'No';
  } catch (e) {
    toast(e.message);
  }
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
    await loadAffiliates();
    if (state.selectedId) await selectAffiliate(state.selectedId);
    toast('Refreshed.');
  } catch (e) {
    toast(e.message);
  }
});

els.searchInput.addEventListener('input', renderList);

els.updateStatusBtn.addEventListener('click', async () => {
  try {
    if (!state.selectedId) return;
    const status = els.statusSelect.value;
    if (!confirm(`Set this affiliate's status to "${status}"? ${status !== 'active' ? 'Their coupon will be deactivated.' : 'Their coupon will be reactivated (if not already used up).'}`)) return;
    if (!ensureApiKey()) return;
    await api(`/api/admin/affiliates/${encodeURIComponent(state.selectedId)}/status`, { method: 'PATCH', body: { status } });
    toast('Status updated.');
    await loadAffiliates();
    await selectAffiliate(state.selectedId);
  } catch (e) {
    toast(e.message);
  }
});

(async function init() {
  try {
    if (!ensureApiKey()) return;
    await loadAffiliates();
  } catch (e) {
    toast(e.message);
  }
})();
