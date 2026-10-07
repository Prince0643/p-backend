/*!
 * Nexistry embeddable checkout (nx-embed.js)
 *
 * Paste into a GoHighLevel "Custom Code" element (any number of embeds per page):
 *
 *   <div data-nx-product="PRODUCT_ID"></div>
 *   <script src="https://api.nexistrydigitalsolutions.com/public/nx-embed.js" async></script>
 *
 * Optional attributes on the div:
 *   data-accent="#2563eb"     hex color (#rgb or #rrggbb) for button / focus ring
 *   data-button-text="Pay now"  button label
 *   data-radius="10"          corner radius in px (clamped 0-32)
 *   data-api-base="https://..."  override API origin (default: origin of this script's src)
 *   data-nx-test="<token>"    ADMIN TEST MODE (set by the admin "Test checkout" preview page only -
 *                             never paste it into a public snippet). The form shows a "TEST MODE -
 *                             no real charge" banner and sends the token as `testToken` so the
 *                             checkout runs in PayMongo test mode (use PayMongo test cards).
 *
 * Admin test mode on a real funnel page: append ?nx_test=<token> to the page URL (the token comes
 * from Admin > Products > Test checkout, is signed, and expires after ~2 hours). It is read from the
 * URL each time and is never stored in a cookie or localStorage.
 *
 * The form renders inside an open Shadow DOM so host-page CSS cannot break it.
 * Affiliate attribution (?ref= / ?campaign=) uses the same cookie + localStorage
 * keys as nx-ref.js ("nx_ref", 30 days, last-click-wins), so both scripts interoperate.
 * Public API: window.NexistryEmbed = { version, mount(el) }.
 */
(function () {
  'use strict';

  // Capture the executing script synchronously (null once async work begins).
  var CURRENT_SCRIPT = document.currentScript;

  // Safe to include the script more than once: just re-scan and stop.
  if (window.NexistryEmbed) {
    try { window.NexistryEmbed.scan(); } catch (e) { /* ignore */ }
    return;
  }

  var VERSION = '1.1.0';
  var DEFAULT_ACCENT = '#2563eb';
  var DEFAULT_BUTTON = 'Pay now';
  var DEFAULT_RADIUS = 10;
  var PROMO_DEBOUNCE_MS = 500;

  // ---- attribution (mirrors nx-ref.js) ------------------------------------
  var COOKIE_NAME = 'nx_ref';
  var STORAGE_KEY = 'nx_ref';
  var MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
  var REF_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
  var CAMPAIGN_PATTERN = /^[a-z0-9-]{2,60}$/;

  function sanitizeRef(v) { v = v == null ? '' : String(v); return REF_PATTERN.test(v) ? v : null; }
  function sanitizeCampaign(v) { v = v == null ? '' : String(v); return CAMPAIGN_PATTERN.test(v) ? v : null; }

  function readQuery(search) {
    try {
      var p = new URLSearchParams(search || '');
      var ref = sanitizeRef(p.get('ref'));
      return ref ? { ref: ref, campaign: sanitizeCampaign(p.get('campaign')) } : null;
    } catch (e) { return null; }
  }

  function readStored(raw) {
    try {
      var parsed = JSON.parse(raw);
      var ref = sanitizeRef(parsed && parsed.ref);
      return ref ? { ref: ref, campaign: sanitizeCampaign(parsed && parsed.campaign) } : null;
    } catch (e) { return null; }
  }

  function readCookie() {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'));
      return m ? readStored(decodeURIComponent(m[1])) : null;
    } catch (e) { return null; }
  }

  function readLocal() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? readStored(raw) : null;
    } catch (e) { return null; }
  }

  function writeAttribution(ref, campaign) {
    var json = JSON.stringify({ ref: ref, campaign: campaign || null, ts: Date.now() });
    try { window.localStorage.setItem(STORAGE_KEY, json); } catch (e) { /* blocked storage */ }
    try {
      var attrs = COOKIE_NAME + '=' + encodeURIComponent(json) + '; Max-Age=' + MAX_AGE_SECONDS + '; Path=/; SameSite=Lax';
      if (window.location.protocol === 'https:') attrs += '; Secure';
      var labels = String(window.location.hostname || '').split('.').filter(Boolean);
      if (labels.length >= 2) {
        document.cookie = attrs + '; Domain=.' + labels.slice(-2).join('.');
        if (document.cookie.indexOf(COOKIE_NAME + '=') === -1) document.cookie = attrs;
      } else {
        document.cookie = attrs;
      }
    } catch (e) { /* never break the page */ }
  }

  // Query string (own window, then top window if same-origin) > cookie > localStorage.
  function resolveAttribution() {
    var fromUrl = readQuery(window.location.search);
    if (!fromUrl) {
      try { if (window.top !== window) fromUrl = readQuery(window.top.location.search); } catch (e) { /* cross-origin */ }
    }
    if (fromUrl) {
      writeAttribution(fromUrl.ref, fromUrl.campaign);
      return fromUrl;
    }
    return readCookie() || readLocal() || { ref: null, campaign: null };
  }

  // ---- admin test mode ------------------------------------------------------
  var TEST_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,2000}$/;

  function sanitizeTestToken(v) { v = v == null ? '' : String(v).trim(); return TEST_TOKEN_PATTERN.test(v) ? v : null; }

  function readTestQuery(search) {
    try { return sanitizeTestToken(new URLSearchParams(search || '').get('nx_test')); } catch (e) { return null; }
  }

  // data-nx-test attribute > ?nx_test= on this window > ?nx_test= on the (same-origin) top window.
  function resolveTestToken(el) {
    var token = sanitizeTestToken(el.getAttribute('data-nx-test'));
    if (!token) token = readTestQuery(window.location.search);
    if (!token) {
      try { if (window.top !== window) token = readTestQuery(window.top.location.search); } catch (e) { /* cross-origin */ }
    }
    return token;
  }

  // ---- API base -------------------------------------------------------------
  function originOf(url) {
    if (typeof url !== 'string' || !url.trim()) return null;
    try {
      var u = new URL(url, window.location.href);
      return /^https?:$/.test(u.protocol) ? u.origin : null;
    } catch (e) { return null; }
  }

  function findScriptOrigin() {
    var src = CURRENT_SCRIPT && CURRENT_SCRIPT.src;
    if (!src) {
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        if (/\/nx-embed\.js(\?|#|$)/.test(scripts[i].src || '')) { src = scripts[i].src; break; }
      }
    }
    return src ? originOf(src) : null;
  }
  var SCRIPT_ORIGIN = findScriptOrigin();

  // ---- helpers ----------------------------------------------------------------
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k) || props[k] == null) continue;
        if (k === 'text') el.textContent = props[k];
        else if (k === 'class') el.className = props[k];
        else el.setAttribute(k, props[k]);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) if (children[i]) el.appendChild(children[i]);
    }
    return el;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function cleanAccent(v) {
    return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : DEFAULT_ACCENT;
  }

  function cleanRadius(v) {
    var n = parseFloat(v);
    return isFinite(n) ? Math.max(0, Math.min(32, Math.round(n))) : DEFAULT_RADIUS;
  }

  function cleanText(v, fallback, max) {
    v = typeof v === 'string' ? v.trim() : '';
    return v ? v.slice(0, max) : fallback;
  }

  // Readable text color (white or near-black) for a hex background.
  function contrastText(hex) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var ch = [0, 2, 4].map(function (i) {
      var s = parseInt(c.substr(i, 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return lum > 0.4 ? '#111827' : '#ffffff';
  }

  function money(amount, currency) {
    var n = Number(amount) || 0;
    try {
      return new Intl.NumberFormat('en-PH', { style: 'currency', currency: currency || 'PHP' }).format(n);
    } catch (e) { return (currency || 'PHP') + ' ' + n.toFixed(2); }
  }

  // discountPercent and taxRate are fractions (0.15 -> "15"); render as whole percents.
  function pctText(fraction) {
    return String(Math.round((Number(fraction) || 0) * 10000) / 100);
  }

  function intervalLabel(interval) {
    var i = String(interval || 'month').toLowerCase();
    return { monthly: 'month', yearly: 'year', annually: 'year', weekly: 'week', daily: 'day' }[i] || i;
  }

  // Only plain http(s) links are ever put in an href (the API already validates, this is defence in depth).
  function safeHref(v) {
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return null;
    try { return /^https?:$/.test(new URL(v.trim()).protocol) ? v.trim() : null; } catch (e) { return null; }
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function validMobile(v) {
    var s = v.replace(/[\s\-().]/g, '');
    return /^(\+?63|0)9\d{9}$/.test(s) || /^\+[1-9]\d{7,14}$/.test(s);
  }

  // Best human message out of an error payload.
  function errorMessage(data, status) {
    var msg = '';
    if (data && typeof data === 'object') {
      msg = data.message || (typeof data.error === 'string' ? data.error : '') || '';
      var list = data.details || data.errors;
      var parts = [];
      if (Array.isArray(list)) {
        list.forEach(function (d) {
          var t = typeof d === 'string' ? d : d && (d.message || d.msg);
          if (t) parts.push(String(t));
        });
      } else if (list && typeof list === 'object') {
        Object.keys(list).forEach(function (k) {
          var t = list[k];
          t = Array.isArray(t) ? t.join(', ') : typeof t === 'string' ? t : t && t.message;
          if (t) parts.push(String(t));
        });
      }
      if (parts.length) msg = (msg ? msg + ' ' : '') + parts.join(' ');
    }
    if (!msg) msg = status >= 500 ? 'Something went wrong on our side. Please try again.' : 'We could not process your request. Please check your details and try again.';
    return msg;
  }

  function request(url, opts, signal) {
    var init = { method: opts.method, credentials: 'omit', mode: 'cors', headers: { 'Accept': 'application/json' }, signal: signal };
    if (opts.body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(errorMessage(data, res.status));
          err.status = res.status;
          throw err;
        }
        return data || {};
      });
    });
  }

  // ---- styles -------------------------------------------------------------------
  function buildCss(accent, radius) {
    var onAccent = contrastText(accent);
    return [
      ':host{display:block;all:initial;display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#111827;line-height:1.45;-webkit-text-size-adjust:100%}',
      '*,*::before,*::after{box-sizing:border-box}',
      '.card{max-width:480px;width:100%;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:' + (radius + 4) + 'px;padding:24px;box-shadow:0 1px 3px rgba(17,24,39,.06)}',
      '@media (max-width:400px){.card{padding:16px}}',
      'h2{margin:0 0 4px;font-size:20px;line-height:1.3;font-weight:650}',
      '.sub{margin:0 0 18px;font-size:14px;color:#4b5563}',
      '.field{margin-bottom:14px}',
      'label{display:block;font-size:14px;font-weight:600;margin-bottom:6px;color:#1f2937}',
      '.opt{font-weight:400;color:#6b7280}',
      'input,textarea{display:block;width:100%;font:inherit;font-size:16px;color:#111827;background:#fff;border:1px solid #9ca3af;border-radius:' + radius + 'px;padding:10px 12px;min-height:44px}',
      'textarea{resize:vertical;min-height:80px}',
      'input::placeholder,textarea::placeholder{color:#6b7280}',
      'input:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid ' + accent + ';outline-offset:2px}',
      'input[aria-invalid="true"],textarea[aria-invalid="true"]{border-color:#b91c1c}',
      '.hint{margin:4px 0 0;font-size:13px;color:#4b5563}',
      '.err{margin:4px 0 0;font-size:13px;color:#b91c1c}',
      '.ok{margin:4px 0 0;font-size:13px;color:#166534;font-weight:600}',
      '.note{margin:4px 0 0;font-size:13px;color:#4b5563}',
      '.summary{margin:18px 0;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:' + radius + 'px}',
      '.row{display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:3px 0}',
      '.row .v{white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.row.disc{color:#166534}',
      '.row.total{font-weight:700;font-size:16px;border-top:1px solid #e5e7eb;margin-top:6px;padding-top:10px}',
      '.renew{margin:6px 0 0;font-size:13px;color:#374151}',
      '.busy{opacity:.55;transition:opacity .15s}',
      'button.pay{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;font:inherit;font-size:16px;font-weight:650;border:0;border-radius:' + radius + 'px;background:' + accent + ';color:' + onAccent + ';cursor:pointer;padding:12px 16px}',
      'button.pay:hover:not([disabled]){filter:brightness(.93)}',
      'button.pay[disabled]{cursor:not-allowed;opacity:.7}',
      '.consent{display:flex;align-items:flex-start;gap:10px;margin:0 0 14px}',
      '.consent input[type="checkbox"]{flex:none;width:22px;height:22px;min-height:0;margin:1px 0 0;padding:0;accent-color:' + accent + ';cursor:pointer}',
      '.consent label{margin:0;font-size:14px;font-weight:400;color:#1f2937;cursor:pointer}',
      '.consent a{color:#1d4ed8;text-decoration:underline}',
      '.consent a:focus-visible{outline:3px solid ' + accent + ';outline-offset:2px;border-radius:2px}',
      '.consent-err{margin:-8px 0 14px 32px}',
      'button.link{font:inherit;font-size:14px;background:none;border:0;padding:4px 0;color:#1d4ed8;text-decoration:underline;cursor:pointer}',
      '.spin{width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s .7s linear infinite}',
      '@keyframes s{to{transform:rotate(360deg)}}',
      '.errbox{margin:0 0 14px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:' + radius + 'px;font-size:14px}',
      '.errbox:empty{display:none}',
      '.testbanner{margin:0 0 16px;padding:12px 14px;background:#fef3c7;border:2px solid #b45309;border-radius:' + radius + 'px;color:#78350f;font-size:13px}',
      '.testbanner strong{display:block;font-size:15px;letter-spacing:.02em;color:#7c2d12}',
      '.inst{margin:10px 0 0;text-align:center;font-size:12px;color:#4b5563}',
      '.foot{margin:14px 0 0;text-align:center;font-size:12px;color:#4b5563}',
      '.sk{border-radius:6px;background:linear-gradient(90deg,#f3f4f6 25%,#e5e7eb 37%,#f3f4f6 63%);background-size:400% 100%;animation:sh 1.4s ease infinite}',
      '@keyframes sh{0%{background-position:100% 50%}100%{background-position:0 50%}}',
      '@media (prefers-reduced-motion:reduce){.spin,.sk{animation:none}.busy{transition:none}}',
      '.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
    ].join('\n');
  }

  // ---- widget --------------------------------------------------------------------
  function mount(el) {
    if (!el || el.__nxMounted || el.nodeType !== 1) return;
    var productId = (el.getAttribute('data-nx-product') || '').trim();
    if (!productId) return;
    el.__nxMounted = true;

    var accent = cleanAccent(el.getAttribute('data-accent'));
    var radius = cleanRadius(el.getAttribute('data-radius'));
    var buttonText = cleanText(el.getAttribute('data-button-text'), DEFAULT_BUTTON, 40);
    var base = originOf(el.getAttribute('data-api-base') || '') || SCRIPT_ORIGIN || 'https://api.nexistrydigitalsolutions.com';

    var attribution = resolveAttribution();
    var testToken = resolveTestToken(el);
    var root = el.attachShadow ? el.attachShadow({ mode: 'open' }) : null;
    if (!root) { console.warn('[nx-embed] Shadow DOM unsupported'); return; }
    root.appendChild(h('style', { text: buildCss(accent, radius) }));
    var card = h('div', { 'class': 'card' });
    root.appendChild(card);

    var uid = 'nx' + Math.random().toString(36).slice(2, 8);
    var state = { product: null, quote: null, seq: 0, ctrl: null, timer: null, submitting: false, promoEdited: false, quoteError: '' };
    var refs = {};

    function skeleton() {
      clear(card);
      card.setAttribute('aria-busy', 'true');
      var bars = [['60%', 24], ['100%', 44], ['100%', 44], ['100%', 44], ['100%', 90], ['100%', 48]];
      bars.forEach(function (b) {
        var d = h('div', { 'class': 'sk', 'aria-hidden': 'true' });
        d.style.cssText = 'width:' + b[0] + ';height:' + b[1] + 'px;margin-bottom:14px';
        card.appendChild(d);
      });
      card.appendChild(h('span', { 'class': 'vh', role: 'status', text: 'Loading checkout' }));
    }

    function fatal(message, retry) {
      clear(card);
      card.removeAttribute('aria-busy');
      var box = h('div', { 'class': 'errbox', role: 'alert', text: message });
      card.appendChild(box);
      if (retry) {
        var b = h('button', { type: 'button', 'class': 'link', text: 'Try again' });
        b.addEventListener('click', load);
        card.appendChild(b);
      }
    }

    function buildQuoteBody() {
      var body = { productId: productId };
      var promo = refs.promo.value.trim();
      var email = refs.email.value.trim();
      if (promo) body.promoCode = promo;
      else if (attribution.ref) body.promoCode = attribution.ref;
      if (EMAIL_RE.test(email)) body.email = email;
      if (attribution.campaign) body.campaign = attribution.campaign;
      return body;
    }

    // Latest-wins quote: earlier in-flight requests are aborted and their results ignored.
    function requote() {
      clearTimeout(state.timer);
      var mySeq = ++state.seq;
      if (state.ctrl) { try { state.ctrl.abort(); } catch (e) { /* ignore */ } }
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      state.ctrl = ctrl;
      if (refs.summary) refs.summary.classList.add('busy');
      return request(base + '/api/embed/quote', { method: 'POST', body: buildQuoteBody() }, ctrl && ctrl.signal)
        .then(function (q) {
          if (mySeq !== state.seq) return;
          state.quote = q;
          state.quoteError = '';
          renderQuote();
        })
        .catch(function (err) {
          if (mySeq !== state.seq || (err && err.name === 'AbortError')) return;
          state.quoteError = 'Could not update the price. Please try again.';
          if (refs.summary) refs.summary.classList.remove('busy');
          if (refs.priceNote) refs.priceNote.textContent = state.quoteError;
          throw err;
        });
    }

    function row(label, value, cls) {
      return h('div', { 'class': 'row' + (cls ? ' ' + cls : '') }, [
        h('span', { text: label }),
        h('span', { 'class': 'v', text: value })
      ]);
    }

    function renderQuote() {
      var q = state.quote;
      if (!q || !refs.summary) return;
      var cur = q.currency || (state.product && state.product.currency) || 'PHP';
      var recurring = q.billing && q.billing.type === 'recurring';
      clear(refs.summary);
      refs.summary.classList.remove('busy');
      var setupFee = Number(q.setupFee) > 0 ? Number(q.setupFee) : 0;
      refs.summary.appendChild(row(setupFee ? 'First month' : 'Subtotal', money(q.subtotal, cur)));
      if (setupFee) refs.summary.appendChild(row('Setup fee', money(setupFee, cur)));
      if (Number(q.discountAmount) > 0) {
        var code = q.promo && q.promo.code ? q.promo.code : '';
        var pct = Number(q.discountPercent) > 0 ? ' ' + pctText(q.discountPercent) + '%' : '';
        var label = 'Discount' + (code || pct ? ' (' + (code ? code : '') + (code && pct ? ', ' : '') + pct.trim() + ')' : '');
        refs.summary.appendChild(row(label, '-' + money(q.discountAmount, cur), 'disc'));
      }
      if (Number(q.taxRate) > 0) {
        refs.summary.appendChild(row('Tax (' + pctText(q.taxRate) + '%)', money(q.taxAmount, cur)));
      }
      refs.summary.appendChild(row('Total due today', money(q.total, cur), 'total'));
      if (recurring && q.renewal) {
        refs.summary.appendChild(h('p', { 'class': 'renew', text: 'Then ' + money(q.renewal.amount, cur) + '/' + intervalLabel(q.renewal.interval || (q.billing && q.billing.interval)) }));
        if (Number(q.discountAmount) > 0) {
          refs.summary.appendChild(h('p', { 'class': 'renew', text: 'Discount applies to the first payment only.' }));
        }
      }
      refs.priceNote.textContent = '';

      // Promo feedback
      clear(refs.promoMsg);
      var p = q.promo;
      var promoVal = refs.promo.value.trim();
      if (p && p.applied) {
        refs.promoMsg.className = 'ok';
        refs.promoMsg.textContent = '✓ Code applied';
      } else if (p && p.applied === false) {
        var fromRef = !state.promoEdited && attribution.ref && promoVal === attribution.ref;
        // A code switched off for this product is a blocking error (checkout rejects it too),
        // even when it came from a referral link.
        var blocked = p.reason === 'product_coupon_disabled';
        refs.promoMsg.className = fromRef && !blocked ? 'note' : 'err';
        refs.promoMsg.textContent = blocked
          ? 'This coupon is not valid for this product. Remove it to continue.'
          : fromRef
            ? 'The referral code ' + attribution.ref + ' could not be applied. You can still continue.'
            : (p.message || 'This code could not be applied.');
      } else {
        refs.promoMsg.className = 'note';
      }
    }

    function field(name, labelText, opts) {
      opts = opts || {};
      var id = uid + '-' + name;
      var input = h(opts.textarea ? 'textarea' : 'input', {
        id: id, name: name, type: opts.textarea ? null : (opts.type || 'text'),
        autocomplete: opts.autocomplete || 'off', placeholder: opts.placeholder,
        required: opts.required ? 'required' : null, 'aria-required': opts.required ? 'true' : null,
        rows: opts.textarea ? '3' : null, maxlength: opts.max || '200',
        inputmode: opts.inputmode, autocapitalize: opts.autocapitalize, spellcheck: opts.spellcheck
      });
      var lab = h('label', { 'for': id }, [document.createTextNode(labelText)]);
      if (!opts.required) lab.appendChild(h('span', { 'class': 'opt', text: ' (optional)' }));
      var describedBy = [];
      var wrap = h('div', { 'class': 'field' }, [lab, input]);
      if (opts.hint) {
        wrap.appendChild(h('p', { 'class': 'hint', id: id + '-hint', text: opts.hint }));
        describedBy.push(id + '-hint');
      }
      var err = h('p', { 'class': 'err', id: id + '-err' });
      wrap.appendChild(err);
      describedBy.push(id + '-err');
      input.setAttribute('aria-describedby', describedBy.join(' '));
      refs[name] = input;
      refs[name + 'Err'] = err;
      return wrap;
    }

    function setFieldError(name, msg) {
      refs[name + 'Err'].textContent = msg || '';
      if (msg) refs[name].setAttribute('aria-invalid', 'true'); else refs[name].removeAttribute('aria-invalid');
    }

    function validate() {
      var first = null;
      function check(name, msg) { setFieldError(name, msg); if (msg && !first) first = refs[name]; }
      var name = refs.fullName.value.trim();
      var email = refs.email.value.trim();
      var mobile = refs.mobile.value.trim();
      check('fullName', name ? '' : 'Please enter your full name.');
      check('email', !email ? 'Please enter your email.' : EMAIL_RE.test(email) ? '' : 'Please enter a valid email address.');
      check('mobile', !mobile ? 'Please enter your mobile number.' : validMobile(mobile) ? '' : 'Enter a valid mobile number, e.g. 09171234567 or +639171234567.');
      if (state.consent) {
        var ticked = refs.consent.checked;
        refs.consentErr.textContent = ticked ? '' : 'Please agree before continuing.';
        if (ticked) refs.consent.removeAttribute('aria-invalid'); else refs.consent.setAttribute('aria-invalid', 'true');
        if (!ticked && !first) first = refs.consent;
      }
      if (first) first.focus();
      return !first;
    }

    // The pay button stays disabled until the (required) consent box is ticked.
    function syncPayDisabled() {
      refs.button.disabled = state.submitting || (!!state.consent && !refs.consent.checked);
    }

    function setSubmitting(on) {
      state.submitting = on;
      syncPayDisabled();
      refs.button.setAttribute('aria-busy', on ? 'true' : 'false');
      clear(refs.button);
      if (on) refs.button.appendChild(h('span', { 'class': 'spin', 'aria-hidden': 'true' }));
      refs.button.appendChild(h('span', { text: on ? 'Processing…' : buttonText }));
    }

    function showFormError(msg) {
      refs.formErr.textContent = msg || '';
    }

    function redirect(url) {
      try { window.top.location.href = url; } catch (e) { window.location.href = url; }
    }

    function submit(ev) {
      ev.preventDefault();
      if (state.submitting) return;
      showFormError('');
      if (!validate()) return;
      var body = {
        productId: productId,
        fullName: refs.fullName.value.trim(),
        email: refs.email.value.trim(),
        mobile: refs.mobile.value.trim()
      };
      var promo = refs.promo.value.trim();
      // Same semantics as nx-ref.js: empty promo falls back to the remembered ref.
      if (promo) body.promoCode = promo; else if (attribution.ref) body.promoCode = attribution.ref;
      var biz = refs.businessName.value.trim();
      var notes = refs.notes.value.trim();
      if (biz) body.businessName = biz;
      if (notes) body.notes = notes;
      if (attribution.campaign) body.campaign = attribution.campaign;
      if (attribution.ref) body.attributionRef = attribution.ref;
      if (testToken) body.testToken = testToken;
      if (state.consent) body.termsAccepted = true;

      clearTimeout(state.timer);
      setSubmitting(true);
      request(base + '/api/embed/checkout', { method: 'POST', body: body })
        .then(function (data) {
          var url = data && data.checkoutUrl;
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            throw new Error('We could not start your payment. Please try again.');
          }
          refs.button.lastChild.textContent = 'Redirecting…';
          redirect(url); // stay disabled while the browser navigates
        })
        .catch(function (err) {
          setSubmitting(false);
          showFormError(err && err.message ? err.message : 'Something went wrong. Please try again.');
          refs.formErr.focus();
        });
    }

    function renderForm() {
      clear(card);
      card.removeAttribute('aria-busy');
      var p = state.product;
      var form = h('form', { novalidate: 'novalidate', 'aria-labelledby': uid + '-title' });
      form.addEventListener('submit', submit);

      if (testToken) {
        card.appendChild(h('div', { 'class': 'testbanner', role: 'status' }, [
          h('strong', { text: 'TEST MODE \u2014 no real charge' }),
          h('span', { text: 'This checkout uses PayMongo test mode. Pay with a PayMongo test card or test e-wallet only.' })
        ]));
      }
      card.appendChild(h('h2', { id: uid + '-title', text: p.name || 'Checkout' }));
      card.appendChild(h('p', { 'class': 'sub', text: 'Enter your details to continue to secure payment.' }));

      refs.formErr = h('div', { 'class': 'errbox', role: 'alert', tabindex: '-1' });
      form.appendChild(refs.formErr);

      form.appendChild(field('fullName', 'Full name', { required: true, autocomplete: 'name' }));
      form.appendChild(field('email', 'Email', { required: true, type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', max: '254' }));
      form.appendChild(field('mobile', 'Mobile number', { required: true, type: 'tel', autocomplete: 'tel', inputmode: 'tel', hint: 'e.g. 09171234567 or +639171234567', max: '20' }));
      form.appendChild(field('businessName', 'Business name'));
      form.appendChild(field('notes', 'Notes', { textarea: true, max: '1000' }));
      var promoWrap = field('promo', 'Promo code', { autocapitalize: 'characters', spellcheck: 'false', max: '60' });
      refs.promoMsg = refs.promoErr; // reuse the described-by message slot for apply feedback
      refs.promoMsg.className = 'note';
      refs.promoMsg.setAttribute('aria-live', 'polite');
      form.appendChild(promoWrap);

      refs.summary = h('div', { 'class': 'summary', 'aria-live': 'polite', 'aria-atomic': 'true', role: 'group', 'aria-label': 'Price summary' });
      refs.priceNote = h('p', { 'class': 'err', role: 'status' });
      form.appendChild(refs.summary);
      form.appendChild(refs.priceNote);

      // Required consent checkbox when the product (or the global setting) has legal links.
      var termsHref = safeHref(p.termsUrl);
      var privacyHref = safeHref(p.privacyUrl);
      state.consent = !!(termsHref || privacyHref);
      if (state.consent) {
        var cid = uid + '-consent';
        var legalLink = function (href, text) {
          return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: text });
        };
        var label = h('label', { 'for': cid }, [document.createTextNode('I have read and agree to the ')]);
        if (termsHref) label.appendChild(legalLink(termsHref, 'Terms and Conditions'));
        if (termsHref && privacyHref) label.appendChild(document.createTextNode(' and '));
        if (privacyHref) label.appendChild(legalLink(privacyHref, 'Privacy Policy'));
        label.appendChild(document.createTextNode('.'));
        refs.consent = h('input', { type: 'checkbox', id: cid, name: 'termsAccepted', required: 'required', 'aria-required': 'true', 'aria-describedby': cid + '-err' });
        refs.consentErr = h('p', { 'class': 'err consent-err', id: cid + '-err' });
        form.appendChild(h('div', { 'class': 'consent' }, [refs.consent, label]));
        form.appendChild(refs.consentErr);
        refs.consent.addEventListener('change', function () {
          refs.consentErr.textContent = '';
          refs.consent.removeAttribute('aria-invalid');
          syncPayDisabled();
        });
      }

      refs.button = h('button', { type: 'submit', 'class': 'pay' }, [h('span', { text: buttonText })]);
      form.appendChild(refs.button);
      // Server-decided (embed API `installmentsAvailable`); static, not tied to promo-adjusted totals.
      if (p.installmentsAvailable === true) {
        form.appendChild(h('p', { 'class': 'inst', text: 'Pay in up to 12 months with an eligible credit card.' }));
      }
      syncPayDisabled();
      card.appendChild(form);
      card.appendChild(h('p', { 'class': 'foot', text: testToken ? 'PayMongo TEST MODE \u2014 no real charge' : 'Secure payment via PayMongo' }));

      // Prefill promo with the affiliate ref, like nx-ref.js does for an empty field.
      if (attribution.ref) refs.promo.value = attribution.ref;

      refs.promo.addEventListener('input', function () {
        state.promoEdited = true;
        refs.promoMsg.textContent = '';
        clearTimeout(state.timer);
        state.timer = setTimeout(function () { requote().catch(function () {}); }, PROMO_DEBOUNCE_MS);
      });
      refs.email.addEventListener('blur', function () {
        if (EMAIL_RE.test(refs.email.value.trim())) requote().catch(function () {});
      });
      ['fullName', 'email', 'mobile'].forEach(function (n) {
        refs[n].addEventListener('input', function () { if (refs[n + 'Err'].textContent) setFieldError(n, ''); });
      });
    }

    function load() {
      skeleton();
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var quoteBody = { productId: productId };
      if (attribution.ref) { quoteBody.promoCode = attribution.ref; quoteBody.attributionRef = attribution.ref; }
      if (attribution.campaign) quoteBody.campaign = attribution.campaign;

      var productReq = request(base + '/api/embed/products/' + encodeURIComponent(productId), { method: 'GET' }, ctrl && ctrl.signal);
      var quoteReq = request(base + '/api/embed/quote', { method: 'POST', body: quoteBody }, ctrl && ctrl.signal);
      quoteReq.catch(function () {}); // handled below; avoid unhandled-rejection noise

      productReq.then(function (data) {
        if (!data || !data.product) throw new Error('Product not found');
        state.product = data.product;
        return quoteReq;
      }).then(function (q) {
        state.quote = q;
        renderForm();
        renderQuote();
      }).catch(function (err) {
        if (err && err.status === 404) {
          console.warn('[nx-embed] Unknown product id:', productId);
          fatal('This checkout is unavailable right now. Please contact the seller.', false);
        } else {
          console.warn('[nx-embed] Failed to load product', productId, err);
          fatal('We could not load this checkout. Please check your connection and try again.', true);
        }
      });
    }

    load();
  }

  function scan() {
    var nodes = document.querySelectorAll('[data-nx-product]');
    for (var i = 0; i < nodes.length; i++) {
      try { mount(nodes[i]); } catch (e) { console.warn('[nx-embed] mount failed', e); }
    }
  }

  window.NexistryEmbed = { version: VERSION, mount: mount, scan: scan };

  // Mount what exists now, and pick up divs GHL adds later.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();

  try {
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () { scheduled = false; scan(); }, 50);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* MutationObserver unavailable; DOMContentLoaded scan still ran */ }
})();
