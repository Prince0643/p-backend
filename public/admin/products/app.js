const els = {
  setKeyBtn: document.getElementById('setKeyBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  searchInput: document.getElementById('searchInput'),
  newBtn: document.getElementById('newBtn'),
  productsList: document.getElementById('productsList'),
  formTitle: document.getElementById('formTitle'),
  deleteBtn: document.getElementById('deleteBtn'),
  resetBtn: document.getElementById('resetBtn'),
  productForm: document.getElementById('productForm'),
  idInput: document.getElementById('idInput'),
  nameInput: document.getElementById('nameInput'),
  amountInput: document.getElementById('amountInput'),
  taxRateInput: document.getElementById('taxRateInput'),
  paymentMethodInput: document.getElementById('paymentMethodInput'),
  sourceInput: document.getElementById('sourceInput'),
  suffixInput: document.getElementById('suffixInput'),
  billingTypeInput: document.getElementById('billingTypeInput'),
  successUrlInput: document.getElementById('successUrlInput'),
  cancelUrlInput: document.getElementById('cancelUrlInput'),
  backendUrlInput: document.getElementById('backendUrlInput'),
  snippetBox: document.getElementById('snippetBox'),
  copySnippetBtn: document.getElementById('copySnippetBtn'),
  toast: document.getElementById('toast')
};

const state = {
  apiKey: localStorage.getItem('nx_admin_api_key') || '',
  products: [],
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

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function getFormPayload() {
  const id = els.idInput.value.trim();
  const name = els.nameInput.value.trim();
  const amountPhp = Number(els.amountInput.value);
  const taxRateRaw = els.taxRateInput.value.trim();
  const taxRate = taxRateRaw ? Number(taxRateRaw) : undefined;
  const paymentMethod = els.paymentMethodInput.value.trim();
  const source = els.sourceInput.value.trim();
  const displaySuffix = els.suffixInput.value.trim();
  const billingType = String(els.billingTypeInput?.value || 'one_time').trim();
  const successUrl = els.successUrlInput.value.trim();
  const cancelUrl = els.cancelUrlInput.value.trim();

  return {
    id: id || slugify(name),
    name,
    amountPhp,
    currency: 'PHP',
    billing: {
      type: billingType
    },
    defaults: {
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(source ? { source } : {}),
      ...(taxRateRaw ? { taxRate } : {}),
      ...(displaySuffix ? { displaySuffix } : {}),
      ...(successUrl ? { successUrl } : {}),
      ...(cancelUrl ? { cancelUrl } : {})
    }
  };
}

function fillForm(product) {
  els.formTitle.textContent = product ? `Edit Product: ${product.name}` : 'New Product';
  els.deleteBtn.classList.toggle('hidden', !product);
  els.idInput.value = product?.id || '';
  els.nameInput.value = product?.name || '';
  els.amountInput.value = product?.amountPhp ?? '';
  els.taxRateInput.value = product?.defaults?.taxRate ?? '';
  els.paymentMethodInput.value = product?.defaults?.paymentMethod ?? '';
  els.sourceInput.value = product?.defaults?.source ?? '';
  els.suffixInput.value = product?.defaults?.displaySuffix ?? '';
  if (els.billingTypeInput) {
    els.billingTypeInput.value = product?.billing?.type || 'one_time';
  }
  els.successUrlInput.value = product?.defaults?.successUrl ?? '';
  els.cancelUrlInput.value = product?.defaults?.cancelUrl ?? '';
  state.selectedId = product?.id || null;
}

function renderList() {
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = state.products.filter(p => {
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
  });

  els.productsList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = `<div><div class="card__title">No products</div><div class="card__meta">Create one to generate an HTML snippet.</div></div>`;
    els.productsList.appendChild(empty);
    return;
  }

  for (const p of filtered) {
    const card = document.createElement('div');
    card.className = 'card';
    const label = p.defaults?.displaySuffix ? ` ${p.defaults.displaySuffix}` : '';
    card.innerHTML = `
      <div>
        <div class="card__title">${escapeHtml(p.name)}</div>
        <div class="card__meta">${escapeHtml(p.id)} · ₱${Number(p.amountPhp).toLocaleString()}${escapeHtml(label)}</div>
      </div>
      <div class="pill">Snippet</div>
    `;
    card.addEventListener('click', () => selectProduct(p.id));
    els.productsList.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadProducts() {
  const data = await api('/api/admin/products');
  state.products = data.products || [];
  renderList();
}

async function selectProduct(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  fillForm(p);
  await refreshSnippet(p.id);
}

async function refreshSnippet(id) {
  if (!id) {
    els.snippetBox.value = '';
    return;
  }

  const backendUrl = els.backendUrlInput.value.trim() || 'https://api.nexistrydigitalsolutions.com';
  const data = await api(`/api/admin/products/${encodeURIComponent(id)}/snippet?backendUrl=${encodeURIComponent(backendUrl)}`);
  els.snippetBox.value = data.snippet || '';
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
    await loadProducts();
    if (state.selectedId) await refreshSnippet(state.selectedId);
    toast('Refreshed.');
  } catch (e) {
    toast(e.message);
  }
});

els.searchInput.addEventListener('input', renderList);

els.newBtn.addEventListener('click', () => {
  fillForm(null);
  els.snippetBox.value = '';
});

els.resetBtn.addEventListener('click', () => {
  const p = state.selectedId ? state.products.find(x => x.id === state.selectedId) : null;
  fillForm(p);
});

els.backendUrlInput.addEventListener('change', async () => {
  try {
    if (state.selectedId) await refreshSnippet(state.selectedId);
  } catch (e) {
    toast(e.message);
  }
});

els.copySnippetBtn.addEventListener('click', async () => {
  try {
    const text = els.snippetBox.value;
    if (!text) return toast('No snippet to copy.');
    await navigator.clipboard.writeText(text);
    toast('Copied snippet.');
  } catch {
    els.snippetBox.select();
    document.execCommand('copy');
    toast('Copied snippet.');
  }
});

els.deleteBtn.addEventListener('click', async () => {
  try {
    if (!state.selectedId) return;
    if (!confirm(`Delete product "${state.selectedId}"?`)) return;
    if (!ensureApiKey()) return;
    await api(`/api/admin/products/${encodeURIComponent(state.selectedId)}`, { method: 'DELETE' });
    toast('Deleted.');
    state.selectedId = null;
    fillForm(null);
    els.snippetBox.value = '';
    await loadProducts();
  } catch (e) {
    toast(e.message);
  }
});

els.productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!ensureApiKey()) return;
    const payload = getFormPayload();
    const method = state.selectedId ? 'PUT' : 'POST';
    const path = state.selectedId ? `/api/admin/products/${encodeURIComponent(payload.id)}` : '/api/admin/products';
    const data = await api(path, { method, body: payload });
    toast('Saved.');
    await loadProducts();
    await selectProduct(data.product.id);
  } catch (err) {
    toast(err.message);
  }
});

(async function init() {
  try {
    if (!ensureApiKey()) return;
    await loadProducts();
  } catch (e) {
    toast(e.message);
  }
})();
