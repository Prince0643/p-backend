const els = {
  setKeyBtn: document.getElementById('setKeyBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  typeFilter: document.getElementById('typeFilter'),
  statusFilter: document.getElementById('statusFilter'),
  searchInput: document.getElementById('searchInput'),
  txBody: document.getElementById('txBody'),
  toast: document.getElementById('toast')
};

const state = {
  apiKey: localStorage.getItem('nx_admin_api_key') || '',
  transactions: []
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

async function api(path) {
  const res = await fetch(path, {
    headers: { 'x-api-key': state.apiKey }
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
  return `pill pill--${status || 'initiated'}`;
}

function typeLabel(type) {
  return type === 'clockistry_subscription' ? 'Clockistry' : 'Academy';
}

function renderTable() {
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = state.transactions.filter((t) => {
    if (!q) return true;
    const hay = `${t.customerName} ${t.customerEmail} ${t.companyId || ''} ${t.productName || ''} ${t.transactionId}`.toLowerCase();
    return hay.includes(q);
  });

  els.txBody.innerHTML = '';
  if (filtered.length === 0) {
    els.txBody.innerHTML = `<tr><td colspan="8" style="color:var(--muted)">No transactions.</td></tr>`;
    return;
  }

  for (const t of filtered) {
    const tr = document.createElement('tr');
    const companyOrProduct = t.type === 'clockistry_subscription'
      ? `${escapeHtml(t.companyId)}<br/><span style="color:var(--muted)">${escapeHtml(t.plan)} × ${escapeHtml(t.userCount)}</span>`
      : `${escapeHtml(t.productName)}<br/><span style="color:var(--muted)">${escapeHtml(t.productId)}</span>`;

    tr.innerHTML = `
      <td><span class="${pillClass(t.status)}">${escapeHtml(t.status)}</span></td>
      <td>${escapeHtml(typeLabel(t.type))}</td>
      <td>${escapeHtml(t.transactionId)}</td>
      <td>${escapeHtml(t.customerName)}<br/><span style="color:var(--muted)">${escapeHtml(t.customerEmail)}</span></td>
      <td>${companyOrProduct}</td>
      <td>${t.amount != null ? `₱${Number(t.amount).toLocaleString()}` : '-'}</td>
      <td>${new Date(t.createdAt).toLocaleString()}</td>
      <td>${new Date(t.updatedAt).toLocaleString()}</td>
    `;
    els.txBody.appendChild(tr);
  }
}

async function loadTransactions() {
  const params = new URLSearchParams();
  if (els.typeFilter.value) params.set('type', els.typeFilter.value);
  if (els.statusFilter.value) params.set('status', els.statusFilter.value);
  const data = await api(`/api/admin/solutions${params.toString() ? `?${params}` : ''}`);
  state.transactions = data.transactions || [];
  renderTable();
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
    await loadTransactions();
    toast('Refreshed.');
  } catch (e) {
    toast(e.message);
  }
});

els.typeFilter.addEventListener('change', () => loadTransactions().catch((e) => toast(e.message)));
els.statusFilter.addEventListener('change', () => loadTransactions().catch((e) => toast(e.message)));
els.searchInput.addEventListener('input', renderTable);

(async function init() {
  try {
    if (!ensureApiKey()) return;
    await loadTransactions();
  } catch (e) {
    toast(e.message);
  }
})();
