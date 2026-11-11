let appMeta = null;
let allCategories = [];
let allCompanies = [];
let allCatalogModels = [];
let allProducts = [];
let filterDebounceTimer = null;
let itemRowCounter = 0;

// Format Date utilities
function getTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getLastWeekISO() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonthStartISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function loadPurchasesPage() {
  const [meta, companies, categories, catalog, products] = await Promise.all([
    API.get('/api/meta'),
    API.get('/api/companies'),
    API.get('/api/categories'),
    API.get('/api/catalog/models'),
    API.get('/api/products'),
  ]);

  appMeta = meta;
  allCompanies = companies;
  allCategories = categories;
  allCatalogModels = catalog;
  allProducts = products;

  // Filter dropdowns
  const companyOptions = companies.map(c => ({ id: c.name, name: c.name }));
  UI.populateSelect(document.getElementById('purchase-company-filter'), companyOptions, { includeAll: true, allLabel: 'All companies' });
  UI.populateSelect(document.getElementById('purchase-category-filter'), categories, { includeAll: true, allLabel: 'All categories' });

  // Default date filter = TODAY
  applyDatePreset('today');

  // Clear and add first item row
  document.getElementById('purchase-items-container').innerHTML = '';
  itemRowCounter = 0;
  addPurchaseItemRow();

  await fetchAndRenderPurchases();
}

function applyDatePreset(preset) {
  document.querySelectorAll('.date-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dateRange === preset);
  });

  const startInput = document.getElementById('purchase-start-date');
  const endInput = document.getElementById('purchase-end-date');
  const today = getTodayISO();

  if (preset === 'today') {
    startInput.value = today;
    endInput.value = today;
  } else if (preset === 'last_week') {
    startInput.value = getLastWeekISO();
    endInput.value = today;
  } else if (preset === 'current_month') {
    startInput.value = getMonthStartISO();
    endInput.value = today;
  } else if (preset === 'all') {
    startInput.value = '';
    endInput.value = '';
  }
}

function addPurchaseItemRow(defaultData = {}) {
  itemRowCounter++;
  const rowIndex = itemRowCounter;
  const container = document.getElementById('purchase-items-container');

  const card = document.createElement('div');
  card.className = 'purchase-item-card';
  card.id = `item-card-${rowIndex}`;
  card.dataset.rowIndex = rowIndex;

  const companyOpts = '<option value="all">All Companies</option>' + allCompanies.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  const catOpts = '<option value="all">All Categories</option>' + allCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const colors = (appMeta?.colors || ['White', 'Black', 'Silver', 'Golden', 'Grey', 'Red']);
  const colorOpts = colors.map(col => `<option value="${escapeHtml(col)}">${escapeHtml(col)}</option>`).join('');

  card.innerHTML = `
    <div class="purchase-item-card-header">
      <span class="item-index-badge">Item #${rowIndex}</span>
      <button class="btn-remove-item" type="button" data-remove-row="${rowIndex}">Remove</button>
    </div>
    <div class="purchase-item-grid">
      <div class="field">
        <label>Company</label>
        <select class="item-company-select" required>${companyOpts}</select>
      </div>
      <div class="field">
        <label>Category</label>
        <select class="item-category-select" required>${catOpts}</select>
      </div>
      <div class="field">
        <label>Series</label>
        <select class="item-series-select"><option value="all">All Series</option></select>
      </div>
      <div class="field item-model-field">
        <label>Model</label>
        <div class="autocomplete-wrap">
          <input class="item-model-input" type="text" placeholder="Search model (e.g. A, 15, Aura)..." autocomplete="off" required>
          <div class="search-suggestions item-suggestions-box"></div>
        </div>
        <input type="hidden" class="item-product-id">
      </div>
      <div class="field">
        <label>Color</label>
        <select class="item-color-select">${colorOpts}</select>
      </div>
      <div class="field">
        <label>Quantity</label>
        <input class="item-qty-input" type="number" min="1" value="${defaultData.quantity || 1}" required>
      </div>
      <div class="field">
        <label>Purchase Price</label>
        <input class="item-cost-input" type="number" min="0" step="0.01" value="${defaultData.unit_cost || ''}" placeholder="Rs" required>
      </div>
      <div class="field">
        <label>Line Total</label>
        <input class="item-total-input" type="text" value="Rs 0.00" disabled>
      </div>
    </div>
  `;

  container.appendChild(card);

  const compSelect = card.querySelector('.item-company-select');
  const catSelect = card.querySelector('.item-category-select');
  const seriesSelect = card.querySelector('.item-series-select');
  const modelInput = card.querySelector('.item-model-input');
  const prodIdInput = card.querySelector('.item-product-id');
  const costInput = card.querySelector('.item-cost-input');
  const qtyInput = card.querySelector('.item-qty-input');
  const suggestionsBox = card.querySelector('.item-suggestions-box');

  let currentMatches = [];
  let activeIndex = -1;

  if (defaultData.company) compSelect.value = defaultData.company;
  if (defaultData.category_id) catSelect.value = defaultData.category_id;
  if (defaultData.model) modelInput.value = defaultData.model;
  if (defaultData.product_id) prodIdInput.value = defaultData.product_id;

  // Normalization helpers
  const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const normCat = (s) => norm(s).replace(/s$/, ''); // Reconciles singular and plural forms (e.g. "washing machines" vs "washing machine")

  const updateSeries = () => {
    const selectedComp = compSelect.value;
    const isCompAll = !selectedComp || selectedComp === 'all';
    const compNorm = norm(selectedComp);

    const selectedCat = catSelect.value;
    const isCatAll = !selectedCat || selectedCat === 'all';
    const selectedCatId = Number(selectedCat);
    const catObj = allCategories.find(c => Number(c.id) === selectedCatId);
    const catNorm = normCat(catObj?.name);

    const set = new Set();
    allCatalogModels.forEach(m => {
      const compMatch = isCompAll || norm(m.company) === compNorm;
      const catMatch = isCatAll || normCat(m.category_name) === catNorm;
      if (compMatch && catMatch && (m.series || '').trim()) {
        set.add(m.series.trim());
      }
    });
    allProducts.forEach(p => {
      const compMatch = isCompAll || norm(p.company) === compNorm;
      const catMatch = isCatAll || Number(p.category_id) === selectedCatId || normCat(p.category_name) === catNorm;
      if (compMatch && catMatch && (p.series || '').trim()) {
        set.add(p.series.trim());
      }
    });

    const seriesList = Array.from(set).sort();
    const prevVal = seriesSelect.value || 'all';
    seriesSelect.innerHTML = `
      <option value="all">All Series</option>
      <option value="__no_series__">General / No Series</option>
      ${seriesList.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
    `;

    if (defaultData.series && (seriesList.includes(defaultData.series) || defaultData.series === '__no_series__')) {
      seriesSelect.value = defaultData.series;
    } else if (seriesList.includes(prevVal) || prevVal === '__no_series__') {
      seriesSelect.value = prevVal;
    } else {
      seriesSelect.value = 'all';
    }
  };

  updateSeries();

  const calculateLineTotal = () => {
    const q = Number(qtyInput.value || 0);
    const c = Number(costInput.value || 0);
    card.querySelector('.item-total-input').value = UI.currencyText(q * c);
    calculateInvoiceTotals();
  };

  qtyInput.addEventListener('input', calculateLineTotal);
  costInput.addEventListener('input', calculateLineTotal);

  const runAutocomplete = () => {
    prodIdInput.value = '';
    activeIndex = -1;
    const rawQuery = modelInput.value.trim().toLowerCase();
    const qTokens = rawQuery.split(/\s+/).filter(Boolean);

    if (!rawQuery) {
      currentMatches = [];
      suggestionsBox.classList.remove('open');
      suggestionsBox.innerHTML = '';
      return;
    }

    const selectedComp = compSelect.value;
    const isCompAll = !selectedComp || selectedComp === 'all';
    const compNorm = norm(selectedComp);

    const selectedCat = catSelect.value;
    const isCatAll = !selectedCat || selectedCat === 'all';
    const selectedCatId = Number(selectedCat);
    const catObj = allCategories.find(c => Number(c.id) === selectedCatId);
    const catNorm = normCat(catObj?.name);

    const selectedSeries = seriesSelect.value;
    const isSeriesAll = !selectedSeries || selectedSeries === 'all';
    const isSeriesNone = selectedSeries === '__no_series__';
    const seriesNorm = norm(selectedSeries);

    const matches = [];
    const seenModels = new Set();

    const matchesQuery = (haystack) => {
      const h = (haystack || '').toLowerCase();
      return qTokens.every(token => h.includes(token));
    };

    const matchesSeries = (s) => {
      if (isSeriesAll) return true;
      const sn = norm(s);
      if (isSeriesNone) {
        return !s || sn === '' || sn === 'general' || sn === 'noseries' || sn === 'unspecifiedseries';
      }
      return sn === seriesNorm;
    };

    const matchesCompany = (c) => {
      if (isCompAll) return true;
      return norm(c) === compNorm;
    };

    const matchesCategory = (catId, catName) => {
      if (isCatAll) return true;
      if (catId && selectedCatId && Number(catId) === selectedCatId) return true;
      if (catName && catNorm && normCat(catName) === catNorm) return true;
      return false;
    };

    // 1. Search existing branch variants
    allProducts.forEach(p => {
      if (!matchesCompany(p.company)) return;
      if (!matchesCategory(p.category_id, p.category_name)) return;
      if (!matchesSeries(p.series)) return;

      const pModel = (p.model || '').trim();
      const pSeries = (p.series || '').trim();
      const combo = `${pSeries} ${pModel}`;

      if (matchesQuery(pModel) || (pSeries && matchesQuery(pSeries)) || matchesQuery(combo)) {
        const key = `${norm(p.company)}|${normCat(p.category_name)}|${norm(pSeries)}|${norm(pModel)}`;
        if (!seenModels.has(key)) {
          seenModels.add(key);
          matches.push({
            productId: p.id,
            company: p.company,
            category_id: p.category_id,
            category_name: p.category_name,
            series: pSeries,
            model: pModel,
            color: p.color || 'Standard',
            cost: p.default_purchase_price || p.last_purchase_price || 0,
            stock: p.current_stock || 0,
          });
        }
      }
    });

    // 2. Search master catalog models
    allCatalogModels.forEach(cm => {
      const cat = allCategories.find(c => normCat(c.name) === normCat(cm.category_name));
      const cmCatId = cat ? cat.id : null;

      if (!matchesCompany(cm.company)) return;
      if (!matchesCategory(cmCatId, cm.category_name)) return;
      if (!matchesSeries(cm.series)) return;

      const cmModel = (cm.model || '').trim();
      const cmSeries = (cm.series || '').trim();
      const combo = `${cmSeries} ${cmModel}`;

      if (matchesQuery(cmModel) || (cmSeries && matchesQuery(cmSeries)) || matchesQuery(combo)) {
        const key = `${norm(cm.company)}|${normCat(cm.category_name)}|${norm(cmSeries)}|${norm(cmModel)}`;
        if (!seenModels.has(key)) {
          seenModels.add(key);
          matches.push({
            productId: null,
            company: cm.company,
            category_id: cmCatId,
            category_name: cm.category_name,
            series: cmSeries,
            model: cmModel,
            color: 'Standard',
            cost: cm.default_price || 0,
            stock: 0,
          });
        }
      }
    });

    currentMatches = matches;

    // 3. Strict "Not found" when no matching models exist under active filters
    if (matches.length === 0) {
      suggestionsBox.innerHTML = `
        <div class="suggestion-item not-found">
          <strong>Not found</strong>
          <span class="suggestion-meta">No matching model under selected filters</span>
        </div>
      `;
      suggestionsBox.classList.add('open');
      return;
    }

    // Render all matching models
    suggestionsBox.innerHTML = matches.map((m, idx) => `
      <div class="suggestion-item" data-idx="${idx}">
        <div>
          <strong>${escapeHtml(m.model)}</strong>
          <div class="suggestion-meta">${escapeHtml(m.company)} • ${escapeHtml(m.series || 'General')} • ${escapeHtml(m.color)}</div>
        </div>
        <span class="suggestion-meta">Stock: ${m.stock}</span>
      </div>
    `).join('');
    suggestionsBox.classList.add('open');
  };

  const selectMatch = (m) => {
    if (!m) return;
    modelInput.value = m.model;
    prodIdInput.value = m.productId || '';
    if (m.company) compSelect.value = m.company;
    if (m.category_id) {
      catSelect.value = m.category_id;
    } else if (m.category_name) {
      const foundCat = allCategories.find(c => normCat(c.name) === normCat(m.category_name));
      if (foundCat) catSelect.value = foundCat.id;
    }
    updateSeries();
    if (m.series) {
      seriesSelect.value = m.series;
    } else {
      seriesSelect.value = '__no_series__';
    }
    if (m.color) card.querySelector('.item-color-select').value = m.color;
    if (Number(m.cost) > 0 && !Number(costInput.value)) {
      costInput.value = m.cost;
    }
    suggestionsBox.classList.remove('open');
    calculateLineTotal();
  };

  const highlightItem = (items) => {
    items.forEach((item, i) => {
      item.classList.toggle('active', i === activeIndex);
      if (i === activeIndex) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  modelInput.addEventListener('input', runAutocomplete);

  // Keyboard navigation
  modelInput.addEventListener('keydown', (e) => {
    if (!suggestionsBox.classList.contains('open')) return;
    const items = suggestionsBox.querySelectorAll('.suggestion-item:not(.not-found)');
    if (!items.length) {
      if (e.key === 'Escape') {
        suggestionsBox.classList.remove('open');
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      highlightItem(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      highlightItem(items);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // Prevents premature form submission
      if (activeIndex >= 0 && currentMatches[activeIndex]) {
        selectMatch(currentMatches[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      suggestionsBox.classList.remove('open');
    }
  });

  // Mouse click selection
  suggestionsBox.addEventListener('click', (e) => {
    const itemEl = e.target.closest('.suggestion-item:not(.not-found)');
    if (!itemEl) return;
    const idx = Number(itemEl.dataset.idx);
    if (currentMatches[idx]) {
      selectMatch(currentMatches[idx]);
    }
  });

  // Filter dropdown changes immediately re-evaluate autocomplete
  compSelect.addEventListener('change', () => {
    updateSeries();
    if (modelInput.value.trim()) runAutocomplete();
  });
  catSelect.addEventListener('change', () => {
    updateSeries();
    if (modelInput.value.trim()) runAutocomplete();
  });
  seriesSelect.addEventListener('change', () => {
    if (modelInput.value.trim()) runAutocomplete();
  });

  calculateLineTotal();
};

function calculateInvoiceTotals() {
  const cards = document.querySelectorAll('.purchase-item-card');
  let totalQty = 0;
  let totalAmount = 0;

  cards.forEach(card => {
    const q = Number(card.querySelector('.item-qty-input')?.value || 0);
    const c = Number(card.querySelector('.item-cost-input')?.value || 0);
    totalQty += q;
    totalAmount += (q * c);
  });

  document.getElementById('purchase-summary-items-count').textContent = cards.length;
  document.getElementById('purchase-summary-units-count').textContent = totalQty;
  document.getElementById('purchase-summary-total-amount').textContent = UI.currencyText(totalAmount);
}

async function fetchAndRenderPurchases() {
  const params = buildQuery({
    search: document.getElementById('purchase-search-input').value.trim() || undefined,
    company: document.getElementById('purchase-company-filter').value || undefined,
    category_id: document.getElementById('purchase-category-filter').value || undefined,
    stock_status: document.getElementById('purchase-status-filter').value || undefined,
    start_date: document.getElementById('purchase-start-date').value || undefined,
    end_date: document.getElementById('purchase-end-date').value || undefined,
  });

  const rows = await API.get(`/api/purchases?${params}`);
  const tbody = document.getElementById('purchase-history-rows');
  const emptyState = document.getElementById('purchase-empty-state');
  const summaryStrip = document.getElementById('purchase-summary-strip');

  // Group purchase items by invoice (reference_no)
  const invoiceMap = new Map();
  rows.forEach(r => {
    const invKey = r.reference_no || `PUR-#${r.id}`;
    if (!invoiceMap.has(invKey)) {
      invoiceMap.set(invKey, {
        id: r.id,
        reference_no: invKey,
        purchase_date: r.purchase_date,
        supplier_name: r.supplier_name,
        supplier_phone: r.supplier_phone,
        notes: r.notes,
        items: [],
        total_amount: 0,
        total_quantity: 0,
        stock_status: 'in_stock',
      });
    }
    const inv = invoiceMap.get(invKey);
    inv.items.push(r);
    inv.total_amount += Number(r.total_amount || 0);
    inv.total_quantity += Number(r.quantity || 0);
    if (r.stock_status === 'out_of_stock' && inv.stock_status === 'in_stock') {
      inv.stock_status = 'out_of_stock';
    }
  });

  const invoices = Array.from(invoiceMap.values());
  const grandUnits = invoices.reduce((sum, inv) => sum + inv.total_quantity, 0);
  const grandSpend = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);

  summaryStrip.innerHTML = `
    <div class="summary-pill">Invoices: <strong>${invoices.length}</strong></div>
    <div class="summary-pill">Total Units: <strong>${grandUnits}</strong></div>
    <div class="summary-pill">Total Spend: <strong>${UI.currencyText(grandSpend)}</strong></div>
  `;

  if (!invoices.length) {
    tbody.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  tbody.innerHTML = invoices.map(inv => {
    const itemDesc = inv.items.length === 1
      ? `<strong>${escapeHtml(inv.items[0].model || inv.items[0].product_label)}</strong><div class="muted" style="font-size:0.8rem;">${escapeHtml(inv.items[0].company)} • ${escapeHtml(inv.items[0].color || 'Standard')}</div>`
      : `<strong>${inv.items.length} Products</strong><div class="muted" style="font-size:0.8rem;">${inv.items.slice(0, 2).map(i => escapeHtml(i.model)).join(', ')}${inv.items.length > 2 ? '...' : ''}</div>`;

    const unitCostDisplay = inv.items.length === 1
      ? UI.currencyHTML(inv.items[0].unit_cost)
      : `<span class="muted" style="font-size:0.8rem;">(Multiple)</span>`;

    return `
      <tr>
        <td><strong>${escapeHtml(inv.reference_no)}</strong></td>
        <td>${UI.formatDate(inv.purchase_date)}</td>
        <td>
          <div><strong>${escapeHtml(inv.supplier_name || 'Direct Supplier')}</strong></div>
          <div class="muted" style="font-size:0.78rem;">${escapeHtml(inv.supplier_phone || '')}</div>
        </td>
        <td>${itemDesc}</td>
        <td><strong>${inv.total_quantity}</strong></td>
        <td class="price-safe-box">${unitCostDisplay}</td>
        <td class="price-safe-box"><strong>${UI.currencyHTML(inv.total_amount)}</strong></td>
        <td>
          <span class="stock-status-pill ${inv.stock_status}">
            ${inv.stock_status === 'in_stock' ? 'In Stock' : 'Out of Stock'}
          </span>
        </td>
        <td>
          <div class="purchase-actions-col">
            <button class="btn-action-view" type="button" data-view-id="${inv.id}">View</button>
            <button class="btn-action-edit" type="button" data-edit-id="${inv.id}">Edit</button>
            <button class="btn-action-delete" type="button" data-delete-id="${inv.id}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  UI.applyPricePrivacy();
}

async function openViewInvoiceModal(purchaseId) {
  const inv = await API.get(`/api/purchases/${purchaseId}`);
  const paper = document.getElementById('purchase-invoice-paper');
  const items = inv.items || [inv];

  paper.innerHTML = `
    <div class="invoice-header-block">
      <div>
        <h3 class="invoice-shop-title">Malik Electronic</h3>
        <div class="muted">${escapeHtml(inv.branch_name || 'Active Branch')} • ${escapeHtml(inv.branch_address || '')}</div>
        <div class="muted">Official Supplier Purchase Invoice</div>
      </div>
      <div style="text-align: right;">
        <h4 style="margin: 0; font-size: 1.25rem;">${escapeHtml(inv.reference_no || `PUR-#${inv.id}`)}</h4>
        <div class="muted">Date: ${UI.formatDate(inv.purchase_date)}</div>
      </div>
    </div>

    <div class="invoice-meta-grid">
      <div class="invoice-box">
        <h5>Supplier / Vendor Information</h5>
        <div><strong>${escapeHtml(inv.supplier_name || 'Standard Vendor')}</strong></div>
        <div>Contact: ${escapeHtml(inv.supplier_phone || 'N/A')}</div>
      </div>
      <div class="invoice-box">
        <h5>Delivery &amp; Destination</h5>
        <div>Branch: <strong>${escapeHtml(inv.branch_name || 'Main Branch')}</strong></div>
        <div>Notes: ${escapeHtml(inv.notes || 'None recorded.')}</div>
      </div>
    </div>

    <table class="invoice-items-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Company</th>
          <th>Category</th>
          <th>Series</th>
          <th>Model Description</th>
          <th>Color</th>
          <th>Qty</th>
          <th>Unit Cost</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((it, idx) => `
          <tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(it.company)}</td>
            <td>${escapeHtml(it.category_name)}</td>
            <td>${escapeHtml(it.series || '-')}</td>
            <td><strong>${escapeHtml(it.model)}</strong></td>
            <td>${escapeHtml(it.color || 'Standard')}</td>
            <td><strong>${it.quantity}</strong></td>
            <td>${UI.currencyText(it.unit_cost)}</td>
            <td><strong>${UI.currencyText(it.total_amount)}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="invoice-total-row">
      <span>Grand Total:</span>
      <strong>${UI.currencyText(inv.total_amount)}</strong>
    </div>
  `;

  document.getElementById('purchase-view-modal').classList.add('open');
}

let currentEditingInvoice = null;

async function openEditPurchaseModal(purchaseId) {
  const inv = await API.get(`/api/purchases/${purchaseId}`);
  currentEditingInvoice = inv;

  document.getElementById('edit-purchase-id').value = inv.id;
  document.getElementById('edit-purchase-date').value = inv.purchase_date;
  document.getElementById('edit-purchase-supplier').value = inv.supplier_name || '';
  document.getElementById('edit-purchase-phone').value = inv.supplier_phone || '';
  document.getElementById('edit-purchase-reference').value = inv.reference_no || '';
  document.getElementById('edit-purchase-notes').value = inv.notes || '';

  const items = inv.items || [inv];
  const infoBox = document.getElementById('edit-purchase-product-info');

  infoBox.innerHTML = `
    <strong>Invoice:</strong> ${escapeHtml(inv.reference_no)} • ${items.length} line item(s).
    <div style="margin-top: 10px;">
      <table class="stock-table" style="min-width: 100%;">
        <thead>
          <tr>
            <th>Product Description</th>
            <th style="width: 100px;">Color</th>
            <th style="width: 110px;">Quantity</th>
            <th style="width: 140px;">Unit Cost</th>
            <th style="width: 60px;">Action</th>
          </tr>
        </thead>
        <tbody id="edit-modal-items-body">
          ${items.map((it, idx) => `
            <tr data-edit-item-row data-item-id="${it.id}">
              <td>
                <strong>${escapeHtml(it.model)}</strong>
                <div class="muted" style="font-size:0.78rem;">${escapeHtml(it.company)} •${escapeHtml(it.series || '')}</div>
              </td>
              <td><input class="edit-item-color" type="text" value="${escapeHtml(it.color || 'Standard')}" style="min-height: 40px; padding: 6px 10px;"></td>
              <td><input class="edit-item-qty" type="number" min="1" value="${it.quantity}" style="min-height: 40px; padding: 6px 10px;" required></td>
              <td><input class="edit-item-cost" type="number" min="0" step="0.01" value="${it.unit_cost}" style="min-height: 40px; padding: 6px 10px;" required></td>
              <td>
                <button class="btn-remove-item" type="button" data-remove-edit-item="${it.id}">✕</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('purchase-edit-modal').classList.add('open');
}

function openDeleteModal(purchaseId) {
  document.getElementById('delete-purchase-id').value = purchaseId;
  document.getElementById('purchase-delete-security-key').value = '';
  document.getElementById('purchase-delete-modal').classList.add('open');
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  UI.setToday('purchase-entry-date');
  await loadPurchasesPage();

  // Add Item button in Add Purchase
  document.getElementById('btn-add-purchase-item').addEventListener('click', () => {
    addPurchaseItemRow();
  });

  // Remove Item delegation in Add Purchase
  document.getElementById('purchase-items-container').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-row]');
    if (!btn) return;
    const cards = document.querySelectorAll('.purchase-item-card');
    if (cards.length <= 1) {
      alert('An invoice must contain at least one item.');
      return;
    }
    const card = document.getElementById(`item-card-${btn.dataset.removeRow}`);
    if (card) {
      card.remove();
      calculateInvoiceTotals();
    }
  });

  // Date Presets click listeners
  document.querySelectorAll('.date-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyDatePreset(btn.dataset.dateRange);
      fetchAndRenderPurchases();
    });
  });

  // Date input changes deselect presets and filter live
  const onCustomDateChange = () => {
    document.querySelectorAll('.date-preset-btn').forEach(b => b.classList.remove('active'));
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(fetchAndRenderPurchases, 250);
  };
  document.getElementById('purchase-start-date').addEventListener('change', onCustomDateChange);
  document.getElementById('purchase-end-date').addEventListener('change', onCustomDateChange);

  // Live filter listener with debounce
  const triggerAutoFilter = () => {
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(fetchAndRenderPurchases, 250);
  };
  document.getElementById('purchase-search-input').addEventListener('input', triggerAutoFilter);
  document.getElementById('purchase-company-filter').addEventListener('change', fetchAndRenderPurchases);
  document.getElementById('purchase-category-filter').addEventListener('change', fetchAndRenderPurchases);
  document.getElementById('purchase-status-filter').addEventListener('change', fetchAndRenderPurchases);
  document.getElementById('purchase-filter-form').addEventListener('submit', (e) => {
    e.preventDefault();
    fetchAndRenderPurchases();
  });

  // History table delegation (View, Edit, Delete)
  document.getElementById('purchase-history-rows').addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-view-id]');
    if (viewBtn) openViewInvoiceModal(viewBtn.dataset.viewId);

    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) openEditPurchaseModal(editBtn.dataset.editId);

    const deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) openDeleteModal(deleteBtn.dataset.deleteId);
  });

  // Remove Item delegation in Edit Modal
  document.getElementById('edit-purchase-product-info').addEventListener('click', (e) => {
    const rmBtn = e.target.closest('[data-remove-edit-item]');
    if (!rmBtn) return;
    const rows = document.querySelectorAll('#edit-modal-items-body tr');
    if (rows.length <= 1) {
      alert('An invoice must contain at least one product.');
      return;
    }
    rmBtn.closest('tr').remove();
  });

  // Close modals and autocomplete dropdowns delegation
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) {
      document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('open'));
    }
    if (!e.target.closest('.autocomplete-wrap')) {
      document.querySelectorAll('.item-suggestions-box').forEach(b => b.classList.remove('open'));
    }
  });

  // Print button
  document.getElementById('btn-print-purchase-invoice').addEventListener('click', () => {
    window.print();
  });

  // Create Multi-Item Purchase submission
  document.getElementById('purchase-entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const itemCards = document.querySelectorAll('.purchase-item-card');
    if (!itemCards.length) {
      alert('Please add at least one item.');
      return;
    }

    const items = [];
    for (const card of itemCards) {
      const compVal = card.querySelector('.item-company-select').value;
      const catVal = card.querySelector('.item-category-select').value;
      const sVal = card.querySelector('.item-series-select').value;

      if (!compVal || compVal === 'all') {
        alert('Please select a specific Company for all items.');
        return;
      }
      if (!catVal || catVal === 'all' || isNaN(Number(catVal))) {
        alert('Please select a specific Category for all items.');
        return;
      }

      items.push({
        product_id: card.querySelector('.item-product-id').value ? Number(card.querySelector('.item-product-id').value) : null,
        company: compVal,
        category_id: Number(catVal),
        series: (sVal === 'all' || sVal === '__no_series__') ? '' : sVal,
        model: card.querySelector('.item-model-input').value.trim(),
        color: card.querySelector('.item-color-select').value,
        quantity: Number(card.querySelector('.item-qty-input').value),
        unit_cost: Number(card.querySelector('.item-cost-input').value),
      });
    }

    const payload = {
      purchase_date: document.getElementById('purchase-entry-date').value,
      supplier_name: document.getElementById('purchase-entry-supplier').value.trim(),
      supplier_phone: document.getElementById('purchase-entry-phone').value.trim(),
      reference_no: document.getElementById('purchase-entry-reference').value.trim(),
      notes: document.getElementById('purchase-entry-notes').value.trim(),
      items: items,
    };

    try {
      const res = await API.post('/api/purchases', payload);
      alert(res.message || 'Purchase invoice recorded successfully.');
      e.target.reset();
      UI.setToday('purchase-entry-date');
      document.getElementById('purchase-items-container').innerHTML = '';
      itemRowCounter = 0;
      addPurchaseItemRow();
      await fetchAndRenderPurchases();
    } catch (err) {
      alert(err.message || 'Failed to record purchase.');
    }
  });

  // Edit Purchase submission
  document.getElementById('purchase-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const purchaseId = document.getElementById('edit-purchase-id').value;
    const itemRows = document.querySelectorAll('#edit-modal-items-body tr');

    const items = [];
    itemRows.forEach(row => {
      items.push({
        id: row.dataset.itemId ? Number(row.dataset.itemId) : null,
        color: row.querySelector('.edit-item-color').value.trim(),
        quantity: Number(row.querySelector('.edit-item-qty').value),
        unit_cost: Number(row.querySelector('.edit-item-cost').value),
      });
    });

    const payload = {
      purchase_date: document.getElementById('edit-purchase-date').value,
      supplier_name: document.getElementById('edit-purchase-supplier').value.trim(),
      supplier_phone: document.getElementById('edit-purchase-phone').value.trim(),
      reference_no: document.getElementById('edit-purchase-reference').value.trim(),
      notes: document.getElementById('edit-purchase-notes').value.trim(),
      items: items,
    };

    try {
      await API.put(`/api/purchases/${purchaseId}`, payload);
      alert('Purchase invoice updated successfully.');
      document.getElementById('purchase-edit-modal').classList.remove('open');
      await fetchAndRenderPurchases();
    } catch (err) {
      alert(err.message || 'Failed to update purchase.');
    }
  });

  // Biometric Purchase Reversal Handler
  document.getElementById('btn-biometric-reverse-purchase')?.addEventListener('click', async () => {
    const purchaseId = document.getElementById('delete-purchase-id').value;
    const errEl = document.getElementById('purchase-delete-error');
    if (!purchaseId) return;
    if (errEl) errEl.textContent = '';

    try {
      const bio = await UI.authenticateBiometric('reverse_purchase');
      if (bio?.verified) {
        await API.post(`/api/purchases/${purchaseId}/reverse`, {
          security_code: bio.verification_token || bio.security_code,
          biometric_token: bio.verification_token
        });
        document.getElementById('purchase-delete-modal').classList.remove('open');
        UI.toast('Purchase invoice reversed via Biometrics.', 'success');
        await fetchAndRenderPurchases();
      }
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Biometric verification failed. Please use the verification password below.';
    }
  });

  // Delete Purchase reversal submission (Password fallback)
  document.getElementById('purchase-delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const purchaseId = document.getElementById('delete-purchase-id').value;
    const secKey = document.getElementById('purchase-delete-security-key').value.trim();
    const errEl = document.getElementById('purchase-delete-error');
    if (!secKey) {
      if (errEl) errEl.textContent = 'Please enter the verification password.';
      return;
    }
    if (errEl) errEl.textContent = '';

    try {
      await API.post(`/api/purchases/${purchaseId}/reverse`, { security_code: secKey });
      document.getElementById('purchase-delete-modal').classList.remove('open');
      UI.toast('Purchase invoice reversed and deleted successfully.', 'success');
      await fetchAndRenderPurchases();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Invalid verification password.';
    }
  });
});
