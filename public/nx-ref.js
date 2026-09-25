/*!
 * Nexistry checkout attribution script (nx-ref.js)
 *
 * Drop this on any GHL funnel checkout page (Settings -> Head tracking code):
 *   <script src="https://api.nexistrydigitalsolutions.com/public/nx-ref.js" async></script>
 *
 * What it does:
 *  - Reads ?ref=<COUPON_CODE>&campaign=<slug> from the landing URL.
 *  - Remembers it (cookie + localStorage) for 30 days, last-click-wins.
 *  - Prefills an empty promo-code field on the page, if one exists.
 *  - Wraps window.fetch so a POST to our create-payment-intent/validate endpoints
 *    automatically carries the remembered ref/campaign, without overwriting a
 *    promo code the customer actually typed.
 *
 * Defensive by design: this file must NEVER throw an uncaught error, and must
 * NEVER block or corrupt a request it doesn't understand. Every block below is
 * wrapped in try/catch for that reason.
 */
(function () {
    'use strict';

    var COOKIE_NAME = 'nx_ref';
    var STORAGE_KEY = 'nx_ref';
    var MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
    var REF_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
    var CAMPAIGN_PATTERN = /^[a-z0-9-]{2,60}$/;
    var TRACKED_PATH_SUFFIXES = [
        '/api/payments/create-payment-intent',
        '/api/clockistry/create-payment-intent',
        '/api/payments/validate'
    ];
    var PREFILL_SELECTOR = '#promoCode, input[name="promoCode"], input[name="promo_code"], input[name="coupon_code"]';
    var PREFILL_TIMEOUT_MS = 15000;

    // ---- registrable-domain helper -----------------------------------------

    function getCookieDomain() {
        try {
            var host = String(window.location.hostname || '');
            var labels = host.split('.').filter(Boolean);
            if (labels.length < 2) return null; // e.g. "localhost" -> host-only cookie
            return '.' + labels.slice(-2).join('.');
        } catch (e) {
            return null;
        }
    }

    // ---- validation ----------------------------------------------------------

    function sanitizeRef(value) {
        var v = value == null ? '' : String(value);
        return REF_PATTERN.test(v) ? v : null;
    }

    function sanitizeCampaign(value) {
        var v = value == null ? '' : String(value);
        return CAMPAIGN_PATTERN.test(v) ? v : null;
    }

    // ---- storage ---------------------------------------------------------

    function readQueryParams() {
        try {
            var params = new URLSearchParams(window.location.search || '');
            var ref = sanitizeRef(params.get('ref'));
            var campaign = sanitizeCampaign(params.get('campaign'));
            return ref ? { ref: ref, campaign: campaign } : null;
        } catch (e) {
            return null;
        }
    }

    function readCookie() {
        try {
            var match = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'));
            if (!match) return null;
            var parsed = JSON.parse(decodeURIComponent(match[1]));
            var ref = sanitizeRef(parsed && parsed.ref);
            if (!ref) return null;
            return { ref: ref, campaign: sanitizeCampaign(parsed && parsed.campaign) };
        } catch (e) {
            return null;
        }
    }

    function readLocalStorage() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            var ref = sanitizeRef(parsed && parsed.ref);
            if (!ref) return null;
            return { ref: ref, campaign: sanitizeCampaign(parsed && parsed.campaign) };
        } catch (e) {
            return null;
        }
    }

    function writeCookie(ref, campaign) {
        try {
            var payload = encodeURIComponent(JSON.stringify({ ref: ref, campaign: campaign || null, ts: Date.now() }));
            var attrs = COOKIE_NAME + '=' + payload + '; Max-Age=' + MAX_AGE_SECONDS + '; Path=/; SameSite=Lax';
            if (window.location.protocol === 'https:') attrs += '; Secure';

            var domain = getCookieDomain();
            if (domain) {
                try {
                    document.cookie = attrs + '; Domain=' + domain;
                    // Verify the cookie actually got set with that Domain attribute (some
                    // browsers/contexts silently reject it) - fall back to host-only if not.
                    if (document.cookie.indexOf(COOKIE_NAME + '=') === -1) {
                        document.cookie = attrs;
                    }
                } catch (e) {
                    document.cookie = attrs;
                }
            } else {
                document.cookie = attrs;
            }
        } catch (e) {
            // Never let a cookie-write failure break the page.
        }
    }

    function writeLocalStorage(ref, campaign) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ref: ref, campaign: campaign || null, ts: Date.now() }));
        } catch (e) {
            // Some browsers/contexts (private mode, blocked storage) throw here - ignore.
        }
    }

    // ---- resolution --------------------------------------------------------

    function resolveRef() {
        try {
            var fromQuery = readQueryParams();
            if (fromQuery) return fromQuery;
            var fromCookie = readCookie();
            if (fromCookie) return fromCookie;
            var fromStorage = readLocalStorage();
            if (fromStorage) return fromStorage;
        } catch (e) {
            // fall through to default below
        }
        return { ref: null, campaign: null };
    }

    // Last-click-wins: a new valid ref in the URL overwrites any stored value.
    try {
        var fromUrl = readQueryParams();
        if (fromUrl) {
            writeCookie(fromUrl.ref, fromUrl.campaign);
            writeLocalStorage(fromUrl.ref, fromUrl.campaign);
        }
    } catch (e) {
        // ignore
    }

    try {
        var resolved = resolveRef();
        window.NexistryRef = { ref: resolved.ref, campaign: resolved.campaign };
    } catch (e) {
        window.NexistryRef = { ref: null, campaign: null };
    }

    // ---- prefill ------------------------------------------------------------

    var prefillDone = false;

    function tryPrefill() {
        if (prefillDone) return true;
        try {
            var current = window.NexistryRef || {};
            if (!current.ref) return false;

            var field = document.querySelector(PREFILL_SELECTOR);
            if (!field) return false;

            var existingValue = field.value == null ? '' : String(field.value).trim();
            if (existingValue) {
                // A value is already present (user-typed, or otherwise) - never overwrite it.
                prefillDone = true;
                return true;
            }

            field.value = current.ref;
            try { field.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
            try { field.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
            prefillDone = true;
            return true;
        } catch (e) {
            return false;
        }
    }

    function startPrefillWatcher() {
        try {
            if (tryPrefill()) return;

            var observer = new MutationObserver(function () {
                try {
                    if (tryPrefill() && observer) {
                        observer.disconnect();
                    }
                } catch (e) {
                    // ignore mutation-handling errors
                }
            });

            if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true });
            }

            setTimeout(function () {
                try { observer.disconnect(); } catch (e) {}
            }, PREFILL_TIMEOUT_MS);
        } catch (e) {
            // ignore - prefill is best-effort
        }
    }

    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startPrefillWatcher);
        } else {
            startPrefillWatcher();
        }
    } catch (e) {
        // ignore
    }

    // ---- fetch wrapper --------------------------------------------------------

    function pathnameEndsWithTrackedRoute(pathname) {
        for (var i = 0; i < TRACKED_PATH_SUFFIXES.length; i++) {
            if (pathname.indexOf(TRACKED_PATH_SUFFIXES[i]) === pathname.length - TRACKED_PATH_SUFFIXES[i].length) {
                return true;
            }
        }
        return false;
    }

    function getRequestMethod(input, init) {
        if (init && init.method) return String(init.method).toUpperCase();
        if (typeof Request !== 'undefined' && input instanceof Request && input.method) {
            return String(input.method).toUpperCase();
        }
        return 'GET';
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input === 'object') {
            if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
            if (typeof Request !== 'undefined' && input instanceof Request && input.url) return input.url;
        }
        return String(input);
    }

    try {
        if (window.fetch && !window.fetch.__nxRefWrapped) {
            var originalFetch = window.fetch.bind(window);

            var wrappedFetch = function (input, init) {
                try {
                    var method = getRequestMethod(input, init);
                    if (method !== 'POST') return originalFetch(input, init);

                    var rawUrl = getRequestUrl(input);
                    var pathname;
                    try {
                        pathname = new URL(rawUrl, window.location.href).pathname;
                    } catch (e) {
                        return originalFetch(input, init);
                    }
                    if (!pathnameEndsWithTrackedRoute(pathname)) return originalFetch(input, init);

                    // Only a plain string JSON body is handled - anything else (FormData,
                    // Blob, a Request object carrying its own body, etc.) passes through
                    // untouched rather than risk mangling it.
                    var bodyStr = init && typeof init.body === 'string' ? init.body : null;
                    if (bodyStr == null) return originalFetch(input, init);

                    var parsedBody;
                    try {
                        parsedBody = JSON.parse(bodyStr);
                    } catch (e) {
                        return originalFetch(input, init);
                    }
                    if (!parsedBody || typeof parsedBody !== 'object') return originalFetch(input, init);

                    var current = window.NexistryRef || resolveRef();

                    if (!parsedBody.promoCode && current.ref) {
                        parsedBody.promoCode = current.ref;
                    }
                    if (current.campaign) parsedBody.campaign = current.campaign;
                    if (current.ref) parsedBody.attributionRef = current.ref;

                    var newInit = {};
                    for (var key in init) {
                        if (Object.prototype.hasOwnProperty.call(init, key)) newInit[key] = init[key];
                    }
                    newInit.body = JSON.stringify(parsedBody);

                    return originalFetch(input, newInit);
                } catch (e) {
                    // Any failure in the wrapper logic must never block the real request.
                    try {
                        return originalFetch(input, init);
                    } catch (e2) {
                        return Promise.reject(e2);
                    }
                }
            };

            wrappedFetch.__nxRefWrapped = true;
            window.fetch = wrappedFetch;
        }
    } catch (e) {
        // If wrapping fetch fails entirely, leave window.fetch untouched.
    }
})();
