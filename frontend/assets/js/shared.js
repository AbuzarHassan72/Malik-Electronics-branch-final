/* ==========================================================================
   MALIK ELECTRONIC ERP — SHARED CORE, SESSION MANAGER, BIOMETRICS & UI/UX
   ========================================================================== */

const OWNER_NAME = 'Malik Alyas';
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minutes Inactivity Auto-Logout
const TOP_COMPANIES = [
  'Dawlance', 'Haier', 'Anex', 'Asia', 'Bonus', 'Eco Plus Led',
  'GAS Stove', 'Kenwood', 'National', 'Nexen', 'Royal', 'Samford',
  'Super Flame', 'United', 'Westpoint'
];



// Client-provided company logo mapping (checks API resolver + static folders)
const CLIENT_COMPANY_LOGOS = {
  'anex': '/static/MAlik%20Images/an.jpeg',
  'asia': '/static/MAlik%20Images/asia.jpeg',
  'bonus': '/static/MAlik%20Images/bo.jpeg',
  'bouns': '/static/MAlik%20Images/bo.jpeg',
  'dawlance': '/api/assets/company-logo/dawlance',
  'haier': '/api/assets/company-logo/haier',
  'ecoplus': '/static/MAlik%20Images/eco.png',
  'ecoplusled': '/static/MAlik%20Images/eco.png',
  'gasstove': '/static/MAlik%20Images/stove.jfif',
  'kenwood': '/static/MAlik%20Images/kenwood.jfif',
  'national': '/static/MAlik%20Images/na.jpeg',
  'nasgas': '/static/MAlik%20Images/nas.png',
  'nexen': '/static/MAlik%20Images/nex.jpeg',
  'royal': '/static/MAlik%20Images/roy.jfif',
  'samford': '/static/MAlik%20Images/sam.jpeg',
  'superflame': '/static/MAlik%20Images/super%20flame.jfif',
  'united': '/static/MAlik%20Images/united.jfif',
  'westpoint': '/static/MAlik%20Images/westpoint.png'
};

// Client-provided category image mapping
const CLIENT_CATEGORY_IMAGES = {
  'airconditioner': '/static/MAlik%20Images/fac.jfif',
  'ac': '/static/MAlik%20Images/fac.jfif',
  'fan': '/static/MAlik%20Images/fan.jfif',
  'fans': '/static/MAlik%20Images/fan.jfif',
  'ceilingfan': '/static/MAlik%20Images/fac.jfif',
  'pedestalfan': '/static/MAlik%20Images/stf.jfif',
  'bracketfan': '/static/MAlik%20Images/fan.jfif',
  'exhaustfan': '/static/MAlik%20Images/fac.jfif',
  'geyser': '/static/MAlik%20Images/gez.webp',
  'geysers': '/static/MAlik%20Images/gez.webp',
  'waterheater': '/static/MAlik%20Images/gez.webp',
  'iron': '/static/MAlik%20Images/iron.jfif',
  'irons': '/static/MAlik%20Images/iron.jfif',
  'dryiron': '/static/MAlik%20Images/iron.jfif',
  'steamiron': '/static/MAlik%20Images/iron.jfif',
  'stabilizer': '/static/MAlik%20Images/st.jpg',
  'stabilizers': '/static/MAlik%20Images/st.jpg',
  'stove': '/static/MAlik%20Images/stove.jfif',
  'gasstove': '/static/MAlik%20Images/stove.jfif',
  'cookingrange': '/static/MAlik%20Images/stp.jfif',
  'microwave': '/static/MAlik%20Images/stp.jfif',
  'oven': '/static/MAlik%20Images/stp.jfif',
  'hotplate': '/static/MAlik%20Images/sp.jfif',
  'singleburner': '/static/MAlik%20Images/sp.jfif',
  'spinner': '/static/MAlik%20Images/sp.jfif',
  'dryer': '/static/MAlik%20Images/sp.jfif',
  'toaster': '/static/MAlik%20Images/tost.jfif',
  'sandwichmaker': '/static/MAlik%20Images/tost.jfif',
  'vacuumcleaner': '/static/MAlik%20Images/vac.jfif',
  'vacuum': '/static/MAlik%20Images/vac.jfif',
  'washingmachine': '/static/MAlik%20Images/vac.jfif'
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function buildQuery(params = {}) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      sp.set(k, String(v).trim());
    }
  });
  return sp.toString();
}

function togglePasswordVisibility(button, inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  if (button) button.textContent = isPass ? 'Hide' : 'Show';
}

function getActiveBranchCookie() {
  const match = document.cookie.match(/(?:^|;\s*)malik_branch_id=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

// ==========================================================================
// 1. 15-MINUTE INACTIVITY SESSION MANAGER
// ==========================================================================
const SessionManager = {
  timerId: null,
  storageKey: 'malik_last_activity_ts',
  sessionMarkerKey: 'malik_active_tab_session',

  init() {
    if (window.location.pathname.startsWith('/login')) return;

    const token = localStorage.getItem('malik_token');
    if (!token) {
      this.forceLogout('unauthenticated');
      return;
    }

    const now = Date.now();
    const lastActive = Number(localStorage.getItem(this.storageKey) || 0);

    if (lastActive > 0 && (now - lastActive) > SESSION_TIMEOUT_MS) {
      this.forceLogout('timeout');
      return;
    }

    this.recordActivity();
    this.bindActivityListeners();
    this.startWatcher();
  },

  recordActivity() {
    const now = Date.now();
    localStorage.setItem(this.storageKey, String(now));
    sessionStorage.setItem(this.sessionMarkerKey, '1');
    this.resetTimer();
  },

  resetTimer() {
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = setTimeout(() => {
      this.forceLogout('timeout');
    }, SESSION_TIMEOUT_MS);
  },

  bindActivityListeners() {
    let throttleTimer = null;
    const onUserActivity = () => {
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        this.recordActivity();
        throttleTimer = null;
      }, 2000);
    };

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
      window.addEventListener(evt, onUserActivity, { passive: true });
    });

    window.addEventListener('storage', (e) => {
      if (e.key === 'malik_token' && !e.newValue) {
        window.location.href = '/login?expired=1';
      }
      if (e.key === this.storageKey && e.newValue) {
        this.resetTimer();
      }
    });
  },

  startWatcher() {
    setInterval(() => {
      const last = Number(localStorage.getItem(this.storageKey) || 0);
      if (last > 0 && (Date.now() - last) > SESSION_TIMEOUT_MS) {
        this.forceLogout('timeout');
      }
    }, 15000);
  },

  async forceLogout(reason = 'manual') {
    if (this.timerId) clearTimeout(this.timerId);
    const token = localStorage.getItem('malik_token');
    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (_) {}
    }
    localStorage.removeItem('malik_token');
    localStorage.removeItem('malik_user');
    localStorage.removeItem(this.storageKey);
    localStorage.removeItem('malik_price_unlocked');
    sessionStorage.clear();
    document.cookie = 'malik_branch_id=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';

    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = reason === 'timeout' ? '/login?expired=1' : '/login';
    }
  }
};

// ==========================================================================
// 2. API CLIENT WITH AUTH & SESSION EXPIRY INTERCEPTOR
// ==========================================================================
const API = {
  async request(url, options = {}) {
    const token = localStorage.getItem('malik_token');
    const branchId = getActiveBranchCookie();

    const headers = {
      ...(options.headers || {})
    };
    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (branchId) {
      headers['X-Branch-Id'] = branchId;
    }

    if (!window.location.pathname.startsWith('/login')) {
      SessionManager.recordActivity();
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (response.status === 401 && !url.includes('/api/auth/login')) {
      await SessionManager.forceLogout('timeout');
      throw new Error('Your session has expired. Redirecting to login...');
    }

    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => '');

    if (!response.ok) {
      const msg = (data && (data.detail || data.message || data.error)) || `Request failed (${response.status})`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    return data;
  },

  get(url) {
    return this.request(url, { method: 'GET' });
  },

  post(url, body = {}) {
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  put(url, body = {}) {
    return this.request(url, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  },

  delete(url) {
    return this.request(url, { method: 'DELETE' });
  },

  upload(url, formData) {
    return this.request(url, {
      method: 'POST',
      body: formData
    });
  }
};

// ==========================================================================
// 3. WEBAUTHN BIOMETRIC ENGINE & UI CONTROLLER
// ==========================================================================
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

const UI = {
  priceUnlocked: false,

  formatCurrency(value) {
    const num = Number(value || 0);
    if (Number.isNaN(num)) return '0';
    return num.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  },

  currencyText(value) {
    if (value === null || value === undefined) return 'Rs ****';
    return `Rs ${this.formatCurrency(value)}`;
  },

  currencyHTML(value) {
    const isLocked = !this.priceUnlocked || value === null || value === undefined;
    const formatted = this.formatCurrency(value);
    const digits = formatted.replace(/\D/g, '').length;
    const sizeClass = digits >= 13 ? 'tiny' : digits >= 10 ? 'compact' : 'normal';
    return `<span class="currency-inline ${sizeClass} ${isLocked ? 'locked' : ''}" data-sensitive="price" data-raw-price="${escapeHtml(formatted)}"><span class="currency-prefix">Rs</span> <span class="currency-amount ${sizeClass} ${isLocked ? 'masked' : ''}">${isLocked ? '****' : formatted}</span></span>`;
  },

  applyPricePrivacy() {
    const unlocked = this.priceUnlocked;
    document.querySelectorAll('[data-sensitive="price"]').forEach(el => {
      const raw = el.getAttribute('data-raw-price') || '0';
      const amountEl = el.querySelector('.currency-amount');
      if (unlocked) {
        el.classList.remove('locked');
        if (amountEl) {
          amountEl.classList.remove('masked');
          amountEl.textContent = raw;
        }
      } else {
        el.classList.add('locked');
        if (amountEl) {
          amountEl.classList.add('masked');
          amountEl.textContent = '****';
        }
      }
    });

    const toggleBtn = document.getElementById('global-price-lock-btn');
    if (toggleBtn) {
      toggleBtn.innerHTML = unlocked ? '&#128274; Lock prices' : '&#128275; Unlock prices';
      toggleBtn.classList.toggle('btn-accent', !unlocked);
      toggleBtn.classList.toggle('btn-ghost', unlocked);
    }
  },

  formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return String(dateStr);
      return d.toLocaleDateString('en-PK', { year: 'numeric', month: 'short', day: '2-digit' });
    } catch (_) {
      return String(dateStr);
    }
  },

  formatDateTime(dateStr) {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return String(dateStr);
      return d.toLocaleString('en-PK', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    } catch (_) {
      return String(dateStr);
    }
  },

  setToday(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    el.value = iso;
  },

  populateSelect(selectEl, items = [], options = {}) {
    if (!selectEl) return;
    const { includeAll = false, allLabel = 'All', valueKey = 'id', labelKey = 'name' } = options;
    let html = '';
    if (includeAll) {
      html += `<option value="">${escapeHtml(allLabel)}</option>`;
    }
    html += items.map(item => {
      const val = typeof item === 'object' ? item[valueKey] : item;
      const label = typeof item === 'object' ? item[labelKey] : item;
      return `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
    }).join('');
    selectEl.innerHTML = html;
  },

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('open');
  },

  closeModal(modalId) {
    if (!modalId) {
      document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
      return;
    }
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('open');
  },

  showMessage(el, message, isError = true) {
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--red, #dc2626)' : 'var(--green, #16a34a)';
    el.style.display = message ? 'block' : 'none';
  },

  toast(message, type = 'info') {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack no-print';
      stack.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; display:flex; flex-direction:column; gap:10px; max-width:360px;';
      document.body.appendChild(stack);
    }
    const item = document.createElement('div');
    const bg = type === 'success' ? '#0f172a' : type === 'error' ? '#dc2626' : type === 'warning' ? '#b45309' : '#1e3a8a';
    item.style.cssText = `background:${bg}; color:#fff; padding:12px 16px; border-radius:12px; font-weight:700; font-size:0.88rem; box-shadow:0 10px 25px rgba(0,0,0,0.2); animation:fadeIn 0.2s ease;`;
    item.textContent = message;
    stack.appendChild(item);
    setTimeout(() => {
      item.style.opacity = '0';
      item.style.transition = 'opacity 0.25s ease';
      setTimeout(() => item.remove(), 260);
    }, 3200);
  },

  async isBiometricAvailable() {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (_) {
      return false;
    }
  },

  async authenticateBiometric(action = 'sensitive_action') {
    const supported = await this.isBiometricAvailable();
    if (!supported) {
      throw new Error('Biometric authentication (Fingerprint / Face ID) is not available on this device. Please use the verification password.');
    }

    const challengeResp = await API.post('/api/auth/biometric/challenge', { action });
    const challengeBytes = base64UrlToUint8Array(challengeResp.challenge);

    const savedCredId = localStorage.getItem('malik_biometric_cred_id');
    let credential = null;

    if (savedCredId) {
      try {
        credential = await navigator.credentials.get({
          publicKey: {
            challenge: challengeBytes,
            allowCredentials: [{
              id: base64UrlToUint8Array(savedCredId),
              type: 'public-key',
              transports: ['internal']
            }],
            userVerification: 'required',
            timeout: 60000
          }
        });
      } catch (_) {
        localStorage.removeItem('malik_biometric_cred_id');
      }
    }

    if (!credential) {
      const userIdBytes = new TextEncoder().encode('malik-alyas-owner');
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: challengeBytes,
          rp: { name: challengeResp.rp_name || 'Malik Electronic ERP' },
          user: {
            id: userIdBytes,
            name: 'malik.alyas@malikelectronic.local',
            displayName: OWNER_NAME
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred'
          },
          timeout: 60000,
          attestation: 'none'
        }
      });

      if (credential && credential.rawId) {
        localStorage.setItem('malik_biometric_cred_id', bufferToBase64Url(credential.rawId));
      }
    }

    if (!credential || !credential.rawId) {
      throw new Error('Biometric verification was cancelled.');
    }

    const credIdStr = bufferToBase64Url(credential.rawId);
    return await API.post('/api/auth/biometric/verify', {
      action,
      challenge: challengeResp.challenge,
      credential_id: credIdStr
    });
  }
};

// ==========================================================================
// 4. CLIENT IMAGE & LOGO RESOLUTION (MULTI-PATH FALLBACK)
// ==========================================================================
function resolveCompanyLogoPath(companyName, explicitPath = '') {
  if (explicitPath && !explicitPath.includes('undefined') && !explicitPath.includes('placeholder')) {
    return explicitPath;
  }
  const norm = String(companyName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (CLIENT_COMPANY_LOGOS[norm]) return CLIENT_COMPANY_LOGOS[norm];
  for (const [key, path] of Object.entries(CLIENT_COMPANY_LOGOS)) {
    if (norm && (norm.includes(key) || key.includes(norm))) return path;
  }
  if (companyName) {
    return `/api/assets/company-logo/${encodeURIComponent(String(companyName).trim().toLowerCase())}`;
  }
  return '';
}

function resolveCategoryImagePath(categoryObj) {
  const explicit = categoryObj?.image_path || categoryObj?.category_image_path || '';
  if (explicit && !explicit.includes('undefined')) return explicit;
  const rawName = String(categoryObj?.name || categoryObj?.category_name || categoryObj?.title || '').trim();
  const norm = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const singular = norm.replace(/s$/, '');
  if (CLIENT_CATEGORY_IMAGES[norm]) return CLIENT_CATEGORY_IMAGES[norm];
  if (CLIENT_CATEGORY_IMAGES[singular]) return CLIENT_CATEGORY_IMAGES[singular];
  for (const [key, path] of Object.entries(CLIENT_CATEGORY_IMAGES)) {
    if (norm && (norm.includes(key) || key.includes(norm))) return path;
  }
  if (rawName) {
    return `/api/assets/category-image/${encodeURIComponent(rawName.toLowerCase())}`;
  }
  return '';
}

function companyLogoHTML(companyName, sizeClass = '', imagePath = '') {
  const primarySrc = resolveCompanyLogoPath(companyName, imagePath);
  const apiFallback = `/api/assets/company-logo/${encodeURIComponent(String(companyName || '').trim().toLowerCase())}`;
  const initials = String(companyName || 'ME').trim().slice(0, 2).toUpperCase();

  if (primarySrc) {
    return `
      <div class="company-logo ${escapeHtml(sizeClass)}" data-company-logo="${escapeHtml(companyName)}">
        <img class="company-logo-image" src="${escapeHtml(primarySrc)}" alt="${escapeHtml(companyName)}"
             onerror="if(this.src && !this.dataset.triedApi){this.dataset.triedApi='1';this.src='${escapeHtml(apiFallback)}';}else{this.outerHTML='<span class=\\'company-logo-fallback\\'>${escapeHtml(initials)}</span>';}">
      </div>
    `;
  }
  return `<div class="company-logo ${escapeHtml(sizeClass)}" data-company-logo="${escapeHtml(companyName)}"><span class="company-logo-fallback">${escapeHtml(initials)}</span></div>`;
}

function hydrateCompanyLogos(root = document) {
  if (!root) return;
  root.querySelectorAll('[data-company-logo]').forEach(box => {
    const existingImg = box.querySelector('img');
    if (existingImg && existingImg.getAttribute('src')) return;
    const name = box.getAttribute('data-company-logo') || '';
    const resolved = resolveCompanyLogoPath(name);
    const apiFallback = `/api/assets/company-logo/${encodeURIComponent(name.trim().toLowerCase())}`;
    if (resolved) {
      const initials = name.trim().slice(0, 2).toUpperCase();
      box.innerHTML = `<img class="company-logo-image" src="${escapeHtml(resolved)}" alt="${escapeHtml(name)}" onerror="if(!this.dataset.triedApi){this.dataset.triedApi='1';this.src='${escapeHtml(apiFallback)}';}else{this.outerHTML='<span class=\\'company-logo-fallback\\'>${escapeHtml(initials)}</span>';}">`;
    }
  });
}

function categoryVisualHTML(category) {
  const resolved = resolveCategoryImagePath(category);
  const title = category?.name || category?.category_name || category?.title || 'Category';
  const apiFallback = `/api/assets/category-image/${encodeURIComponent(String(title).trim().toLowerCase())}`;
  const fallbackIcon = category?.icon || category?.category_icon || '📦';

  if (resolved) {
    return `
      <div class="category-media" data-category-visual="${escapeHtml(title)}">
        <img class="category-media-image" src="${escapeHtml(resolved)}" alt="${escapeHtml(title)}"
             onerror="if(!this.dataset.triedApi){this.dataset.triedApi='1';this.src='${escapeHtml(apiFallback)}';}else{this.outerHTML='<span class=\\'category-icon\\'>${escapeHtml(fallbackIcon)}</span>';}">
      </div>
    `;
  }
  return `<div class="category-media" data-category-visual="${escapeHtml(title)}"><span class="category-icon">${escapeHtml(fallbackIcon)}</span></div>`;
}

function hydrateCategoryVisuals(root = document) {
  if (!root) return;
  root.querySelectorAll('[data-category-visual]').forEach(box => {
    const existingImg = box.querySelector('img');
    if (existingImg && existingImg.getAttribute('src')) return;
    const name = box.getAttribute('data-category-visual') || '';
    const resolved = resolveCategoryImagePath({ name });
    const apiFallback = `/api/assets/category-image/${encodeURIComponent(name.trim().toLowerCase())}`;
    if (resolved) {
      box.innerHTML = `<img class="category-media-image" src="${escapeHtml(resolved)}" alt="${escapeHtml(name)}" onerror="if(!this.dataset.triedApi){this.dataset.triedApi='1';this.src='${escapeHtml(apiFallback)}';}else{this.outerHTML='<span class=\\'category-icon\\'>📦</span>';}">`;
    }
  });
}

function repairLegacyAssetImages(root = document) {
  hydrateCompanyLogos(root);
  hydrateCategoryVisuals(root);
}

// ==========================================================================
// 5. NAVIGATION ICONS, MOBILE DRAWER & PRICE BIOMETRIC MODAL
// ==========================================================================
const NAV_SVG_ICONS = {
  '/dashboard': '<svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  '/inventory': '<svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  '/stocks': '<svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  '/sales': '<svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  '/purchases': '<svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  '/accounts': '<svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>'
};

function injectPriceSecurityModal() {
  if (document.getElementById('price-unlock-modal')) return;
  const modalWrap = document.createElement('div');
  modalWrap.className = 'modal-backdrop no-print';
  modalWrap.id = 'price-unlock-modal';
  modalWrap.innerHTML = `
    <div class="modal small" style="max-width: 440px;">
      <div class="modal-header">
        <h2 id="price-security-modal-title" style="font-size: 1.2rem; color: var(--blue-dark);">Price Visibility Security</h2>
        <button class="btn-ghost small" type="button" data-close-modal="price-unlock-modal">Close</button>
      </div>
      <form id="price-unlock-form" class="form-stack">
        <input type="hidden" id="price-security-target-mode" value="unlock">
        <div class="notice-card" id="price-security-modal-note" style="font-size: 0.88rem; line-height: 1.45;">
          Authenticate as <strong>${OWNER_NAME}</strong> using Mobile Fingerprint / Face ID or enter the verification password to unlock purchase and stock prices.
        </div>

        <button type="button" id="btn-biometric-price-toggle" class="btn" style="width: 100%; background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); color: #fff; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 13px; border-radius: 12px; font-weight: 800; cursor: pointer;">
          <span>&#128274;</span> <span id="txt-biometric-price-btn">Authenticate with Fingerprint / Face ID</span>
        </button>

        <div style="text-align: center; font-size: 0.75rem; color: var(--muted); text-transform: uppercase; font-weight: 800;">Or enter verification password</div>

        <div class="field">
          <label for="price-security-password-input" style="font-weight: 700;">Verification Password</label>
          <div class="password-wrap">
            <input id="price-security-password-input" type="password" placeholder="Enter verification password" autocomplete="off">
            <button class="toggle-password" type="button" data-toggle-password="price-security-password-input">Show</button>
          </div>
        </div>
        <div id="price-security-error" class="form-message" style="color: var(--red); font-weight: 700; font-size: 0.85rem;"></div>
        <div class="action-bar" style="justify-content: flex-end; gap: 8px; margin-top: 8px;">
          <button class="btn-ghost small" type="button" data-close-modal="price-unlock-modal">Cancel</button>
          <button class="btn-accent" type="submit" id="btn-submit-price-security">Verify &amp; Apply</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modalWrap);

  modalWrap.querySelector('[data-toggle-password]')?.addEventListener('click', (e) => {
    togglePasswordVisibility(e.currentTarget, 'price-security-password-input');
  });

  const applyPriceState = async (mode, verificationSecret) => {
    if (mode === 'unlock') {
      await API.post('/api/auth/price-visibility/unlock', {
        password: verificationSecret
      });
      UI.priceUnlocked = true;
      localStorage.setItem('malik_price_unlocked', '1');
      UI.closeModal('price-unlock-modal');
      UI.toast('Prices unlocked successfully.', 'success');
      setTimeout(() => window.location.reload(), 200);
    } else {
      await API.post('/api/auth/verify-action', {
        security_code: verificationSecret
      });
      await API.post('/api/auth/price-visibility/lock', {});
      UI.priceUnlocked = false;
      localStorage.setItem('malik_price_unlocked', '0');
      UI.closeModal('price-unlock-modal');
      UI.toast('Prices locked and masked.', 'info');
      setTimeout(() => window.location.reload(), 200);
    }
  };

  document.getElementById('btn-biometric-price-toggle')?.addEventListener('click', async () => {
    const mode = document.getElementById('price-security-target-mode')?.value || 'unlock';
    const errEl = document.getElementById('price-security-error');
    if (errEl) errEl.textContent = '';
    try {
      const bio = await UI.authenticateBiometric(mode === 'unlock' ? 'unlock_prices' : 'lock_prices');
      if (bio?.verified) {
        await applyPriceState(mode, bio.verification_token || bio.security_code);
      }
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Biometric verification failed. Please enter the verification password below.';
    }
  });

  document.getElementById('price-unlock-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = document.getElementById('price-security-target-mode')?.value || 'unlock';
    const pass = document.getElementById('price-security-password-input')?.value.trim();
    const errEl = document.getElementById('price-security-error');
    if (!pass) {
      if (errEl) errEl.textContent = 'Please enter the verification password.';
      return;
    }
    if (errEl) errEl.textContent = '';
    try {
      await applyPriceState(mode, pass);
    } catch (err) {
      if (errEl) errEl.textContent = 'Invalid verification password.';
    }
  });
}

function openPriceSecurityModal(targetMode = 'unlock') {
  injectPriceSecurityModal();
  document.getElementById('price-security-target-mode').value = targetMode;
  document.getElementById('price-security-password-input').value = '';
  document.getElementById('price-security-error').textContent = '';

  const titleEl = document.getElementById('price-security-modal-title');
  const noteEl = document.getElementById('price-security-modal-note');
  const bioTxt = document.getElementById('txt-biometric-price-btn');

  if (targetMode === 'lock') {
    if (titleEl) titleEl.textContent = 'Lock & Mask Prices';
    if (noteEl) noteEl.innerHTML = `Authenticate with Fingerprint / Face ID or enter the verification password to lock and mask sensitive prices across the application.`;
    if (bioTxt) bioTxt.textContent = 'Lock Prices with Fingerprint / Face ID';
  } else {
    if (titleEl) titleEl.textContent = 'Unlock Protected Prices';
    if (noteEl) noteEl.innerHTML = `Authenticate as <strong>${OWNER_NAME}</strong> using Mobile Fingerprint / Face ID or enter the verification password to reveal purchase and stock prices.`;
    if (bioTxt) bioTxt.textContent = 'Unlock Prices with Fingerprint / Face ID';
  }
  UI.openModal('price-unlock-modal');
}

function setupSidebarAndHeader(appState) {
  const path = window.location.pathname;
  const navLinks = [
    ['/dashboard', 'Dashboard'],
    ['/inventory', 'Categories'],
    ['/stocks', 'Stocks'],
    ['/sales', 'Sales'],
    ['/purchases', 'Purchases'],
    ['/accounts', 'Accounts']
  ];

  const simpleHeadings = {
    '/dashboard': ['Dashboard', 'Click any company or category to check stock and prices.'],
    '/inventory': ['Categories & Places', 'Add or edit product categories and shop/godam places.'],
    '/stocks': ['Stocks', 'Check available items by company, color, and place.'],
    '/sales': ['Sales', 'Create customer bill, print on 1 page, or share on WhatsApp.'],
    '/purchases': ['Purchases', 'Add new stock received from company or supplier.'],
    '/accounts': ['Accounts', 'Check daily sales, purchases, profit, and bills.']
  };
  if (simpleHeadings[path]) {
    const titleEl = document.querySelector('.page-title');
    const subEl = document.querySelector('.page-subtitle');
    if (titleEl) titleEl.textContent = simpleHeadings[path][0];
    if (subEl) subEl.textContent = simpleHeadings[path][1];
  }

  const navList = document.querySelector('.sidebar .nav-list');
  if (navList) {
    navList.innerHTML = navLinks.map(([href, label]) => {
      const isActive = path.startsWith(href) || (href === '/inventory' && path.startsWith('/category/'));
      const svg = NAV_SVG_ICONS[href] || '<span class="nav-dot"></span>';
      return `
        <a class="nav-link ${isActive ? 'active' : ''}" href="${href}">
          ${svg}
          <span>${escapeHtml(label)}</span>
        </a>
      `;
    }).join('');
  }

  // Add compact owner card in sidebar footer instead of center of dashboard
  const sidebarFooter = document.querySelector('.sidebar .sidebar-footer');
  if (sidebarFooter && !sidebarFooter.querySelector('.sidebar-owner-card')) {
    const branchName = appState?.current_branch?.name || 'Active Branch';
    const ownerCard = document.createElement('div');
    ownerCard.className = 'sidebar-owner-card';
    ownerCard.innerHTML = `
      <div class="sidebar-owner-avatar">MA</div>
      <div class="sidebar-owner-info">
        <div class="sidebar-owner-name">${escapeHtml(OWNER_NAME)}</div>
        <div class="sidebar-owner-role">${escapeHtml(branchName)}</div>
      </div>
    `;
    sidebarFooter.insertBefore(ownerCard, sidebarFooter.firstChild);
  }

  // Inject Mobile Responsive Top Bar & Drawer Backdrop
  if (!document.getElementById('malik-mobile-topbar') && document.querySelector('.app-shell')) {
    const mobileBar = document.createElement('div');
    mobileBar.id = 'malik-mobile-topbar';
    mobileBar.className = 'mobile-topbar no-print';
    const branchName = appState?.current_branch?.name || 'Main Branch';
    mobileBar.innerHTML = `
      <button type="button" class="mobile-menu-btn" id="btn-open-mobile-drawer">
        <span>&#9776;</span> <span>Menu</span>
      </button>
      <div style="font-weight: 900; font-size: 1rem; letter-spacing: -0.01em;">Malik Electronic</div>
      <div style="font-size: 0.75rem; background: rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 99px; font-weight: 700;">
        ${escapeHtml(branchName)}
      </div>
    `;
    document.body.insertBefore(mobileBar, document.body.firstChild);

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop no-print';
    backdrop.id = 'malik-sidebar-backdrop';
    document.body.appendChild(backdrop);

    document.getElementById('btn-open-mobile-drawer')?.addEventListener('click', () => {
      document.body.classList.toggle('mobile-nav-open');
    });
    backdrop.addEventListener('click', () => {
      document.body.classList.remove('mobile-nav-open');
    });
  }

  // Setup header tools (Branch switcher + Unlock/Lock prices button)
  const header = document.querySelector('.page-header');
  if (header && !document.getElementById('global-header-controls')) {
    const controls = document.createElement('div');
    controls.id = 'global-header-controls';
    controls.className = 'no-print';
    controls.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;';

    const branches = appState?.branches || [];
    const currentBranchId = appState?.current_branch?.id || getActiveBranchCookie();

    if (branches.length > 0) {
      const select = document.createElement('select');
      select.id = 'global-branch-switcher';
      select.style.cssText = 'min-height:40px; padding:6px 14px; border-radius:10px; border:1px solid var(--erp-border, #e2e8f0); font-weight:800; background:#f8fafc; color:#0f172a; cursor:pointer;';
      select.innerHTML = branches.map(b => `<option value="${b.id}" ${String(b.id) === String(currentBranchId) ? 'selected' : ''}>Branch: ${escapeHtml(b.name)}</option>`).join('');
      select.addEventListener('change', (e) => {
        document.cookie = `malik_branch_id=${e.target.value}; path=/; max-age=31536000`;
        window.location.reload();
      });
      controls.appendChild(select);
    }

    const priceBtn = document.createElement('button');
    priceBtn.type = 'button';
    priceBtn.id = 'global-price-lock-btn';
    priceBtn.className = `small ${UI.priceUnlocked ? 'btn-ghost' : 'btn-accent'}`;
    priceBtn.style.cssText = 'min-height:40px; padding:8px 16px; border-radius:10px; font-weight:800; cursor:pointer;';
    priceBtn.innerHTML = UI.priceUnlocked ? '&#128274; Lock prices' : '&#128275; Unlock prices';
    priceBtn.addEventListener('click', () => {
      openPriceSecurityModal(UI.priceUnlocked ? 'lock' : 'unlock');
    });
    controls.appendChild(priceBtn);

    header.appendChild(controls);
  }

  // Hide the redundant center badge
  document.querySelectorAll('[data-user-name]').forEach(badge => {
    badge.style.display = 'none';
  });

  // Bind logout buttons
  document.querySelectorAll('[data-logout]').forEach(btn => {
    if (!btn.dataset.boundLogout) {
      btn.dataset.boundLogout = '1';
      btn.addEventListener('click', () => SessionManager.forceLogout('manual'));
    }
  });

  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      const target = closeBtn.getAttribute('data-close-modal');
      UI.closeModal(target);
    }
  });
}

async function requireAuth() {
  SessionManager.init();
  const token = localStorage.getItem('malik_token');
  if (!token) {
    window.location.href = '/login';
    return null;
  }

  try {
    const appState = await API.get('/api/app-state');
    UI.priceUnlocked = Boolean(appState.can_view_prices);
    localStorage.setItem('malik_price_unlocked', UI.priceUnlocked ? '1' : '0');
    setupSidebarAndHeader(appState);
    UI.applyPricePrivacy();
    return appState.user || { username: OWNER_NAME, full_name: OWNER_NAME };
  } catch (err) {
    await SessionManager.forceLogout('timeout');
    return null;
  }
}