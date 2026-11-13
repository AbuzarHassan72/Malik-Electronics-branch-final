let salesProducts = [];
let salesCategories = [];
let salesCompanies = [];
let currentBranchInfo = { name: 'Main Branch', address: '' };
let currentViewingInvoice = null;

const urlParams = new URLSearchParams(window.location.search);
const initialProductId = urlParams.get('product_id') || '';

const salesState = {
  discountRules: [],
  invoices: [],
  lineCounter: 0,
  initialLoadDone: false,
  filters: {
    company: urlParams.get('company') || '',
    categoryId: urlParams.get('category_id') || '',
    model: '',
    search: urlParams.get('search') || '',
    stockOnly: initialProductId ? 'all' : 'in_stock'
  },
  lineItems: [
    { id: Date.now(), productId: '', qty: 1, unitPrice: 0, available: 0 }
  ]
};

// ==========================================
// 1. DATA FETCHING & FILTERING
// ==========================================
async function fetchBaseData() {
  try {
    const [meta, categories, discounts, appState] = await Promise.all([
      API.get('/api/meta').catch(() => ({ company_options: ['Dawlance', 'Haier'] })),
      API.get('/api/categories').catch(() => []),
      API.get('/api/discount-rules').catch(() => []),
      API.get('/api/app-state').catch(() => null)
    ]);

    salesCompanies = meta?.company_options || [];
    salesCategories = categories || [];
    salesState.discountRules = discounts || [];

    if (appState?.current_branch) {
      currentBranchInfo = {
        name: appState.current_branch.name || 'Main Branch',
        address: appState.current_branch.address || ''
      };
    }

    const companySelect = document.getElementById('sales-company-filter');
    const categorySelect = document.getElementById('sales-category-filter');

    if (companySelect) {
      UI.populateSelect(companySelect, salesCompanies.map(c => ({ id: c, name: c })), { includeAll: true, allLabel: 'All Companies', valueKey: 'id' });
      companySelect.value = salesState.filters.company;
    }
    if (categorySelect) {
      UI.populateSelect(categorySelect, salesCategories.map(c => ({ id: c.id, name: c.name })), { includeAll: true, allLabel: 'All Categories' });
      categorySelect.value = salesState.filters.categoryId;
    }

    renderDiscountRules();
    syncDiscountInputs();

    const dateInput = document.getElementById('invoice-transaction-at');
    if (dateInput) {
      const d = new Date();
      const yr = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const hr = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      dateInput.value = `${yr}-${mo}-${da}T${hr}:${mi}`;
    }
  } catch (err) {
    console.warn('API base fetch issue:', err);
  }
}

function normalizeKey(val) {
  return String(val || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves complete product details (especially Category Name, Brand, Model, Series, Color, Size)
 * even for historical invoices that only stored model and company strings.
 */
function resolveInvoiceItemDetails(item) {
  const rawModel = item.model || item.product_model || item.product_label || 'Product';
  const rawCompany = item.company || item.brand || '';

  // 1. Match by product_id if present
  let matchedProduct = null;
  if (item.product_id) {
    matchedProduct = salesProducts.find(p => Number(p.id) === Number(item.product_id));
  }

  // 2. Fallback: Match by company + model (or model alone)
  if (!matchedProduct && rawModel) {
    const targetModelNorm = normalizeKey(rawModel);
    const targetCompNorm = normalizeKey(rawCompany);
    matchedProduct = salesProducts.find(p => {
      const mNorm = normalizeKey(p.model);
      const cNorm = normalizeKey(p.company);
      if (targetCompNorm && cNorm === targetCompNorm && (mNorm === targetModelNorm || mNorm.endsWith(targetModelNorm) || targetModelNorm.endsWith(mNorm))) {
        return true;
      }
      return mNorm === targetModelNorm;
    });
  }

  // 3. Resolve Category Name
  let categoryName = item.category_name || item.category || matchedProduct?.category_name || '';
  if (!categoryName && (item.category_id || matchedProduct?.category_id)) {
    const catId = item.category_id || matchedProduct?.category_id;
    const foundCat = salesCategories.find(c => Number(c.id) === Number(catId));
    if (foundCat) categoryName = foundCat.name;
  }
  if (!categoryName) {
    categoryName = 'Electronics Appliance';
  }

  const companyName = rawCompany || matchedProduct?.company || 'Brand';
  const modelName = item.model || matchedProduct?.model || rawModel;
  const seriesName = item.series || matchedProduct?.series || '';
  const colorName = item.color || matchedProduct?.color || 'Standard';
  const sizeName = item.size || matchedProduct?.size || '';
  const locationName = item.location_name || matchedProduct?.location_name || '';
  const quantity = Number(item.quantity || 1);
  const unitPrice = Number(item.unit_price ?? item.price ?? 0);
  const lineTotal = Number(item.total_amount ?? item.line_total ?? (quantity * unitPrice));

  return {
    categoryName,
    companyName,
    modelName,
    seriesName,
    colorName,
    sizeName,
    locationName,
    quantity,
    unitPrice,
    lineTotal
  };
}

function productSearchScore(item, query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return 0;
  const model = String(item.model || '').toLowerCase();
  const series = String(item.series || '').toLowerCase();
  const company = String(item.company || '').toLowerCase();
  const category = String(item.category_name || '').toLowerCase();
  const color = String(item.color || '').toLowerCase();
  const size = String(item.size || '').toLowerCase();
  const location = String(item.location_name || '').toLowerCase();

  const haystack = `${company} ${category} ${series} ${model} ${color} ${size} ${location}`;
  let score = 0;

  if (haystack === normalized || model === normalized) score += 500;
  if (haystack.includes(normalized)) score += 200;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  let matchedTokens = 0;
  tokens.forEach(token => {
    if (haystack.includes(token)) {
      score += 20;
      matchedTokens++;
    }
  });

  if (tokens.length > 0 && matchedTokens === tokens.length) {
    score += 150;
  }
  return score;
}

function filteredProducts() {
  const filters = salesState.filters;
  return salesProducts
    .map(item => ({ ...item, _score: productSearchScore(item, filters.search) }))
    .filter(item => {
      const companyMatch = !filters.company || String(item.company).toLowerCase() === String(filters.company).toLowerCase();
      const categoryMatch = !filters.categoryId || String(item.category_id) === String(filters.categoryId);
      const modelMatch = !filters.model || String(item.id) === String(filters.model);
      const stockMatch = filters.stockOnly === 'all' || Number(item.current_stock || 0) > 0;
      const searchMatch = !filters.search || item._score > 0;
      return companyMatch && categoryMatch && modelMatch && stockMatch && searchMatch;
    })
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      if (Number(b.current_stock || 0) !== Number(a.current_stock || 0)) return Number(b.current_stock || 0) - Number(a.current_stock || 0);
      return `${a.company} ${a.model} ${a.color || ''}`.localeCompare(`${b.company} ${b.model} ${b.color || ''}`);
    });
}

function productOptionLabel(item) {
  const stock = Number(item.current_stock || 0);
  const stockLabel = stock > 0 ? `${stock} in stock` : 'Out of Stock';
  const series = item.series ? ` (${item.series})` : '';
  const cat = item.category_name ? ` • ${item.category_name}` : '';
  const loc = item.location_name ? ` • Place: ${item.location_name}` : '';
  return `${item.model}${series} — ${item.company || '-'}${cat} • Color: ${item.color || 'Standard'}${loc} [${stockLabel}]`;
}

function hydrateModelFilter() {
  const products = filteredProducts();
  const modelSelect = document.getElementById('sales-model-filter');
  if (modelSelect) {
    const items = products.map(item => ({
      id: item.id,
      name: `${item.category_name ? item.category_name + ' • ' : ''}${item.model} (${item.company || '-'}) - ${item.current_stock} in stock`
    }));
    UI.populateSelect(modelSelect, items, { includeAll: true, allLabel: 'All models' });
  }
}

async function fetchProducts() {
  try {
    salesProducts = await API.get('/api/products').catch(() => []);
    hydrateModelFilter();

    if (!salesState.initialLoadDone) {
      salesState.initialLoadDone = true;
      let targetProduct = null;

      if (initialProductId) {
        targetProduct = salesProducts.find(p => String(p.id) === String(initialProductId));
      }

      if (!targetProduct && salesState.filters.search) {
        targetProduct = salesProducts
          .map(p => ({ ...p, _score: productSearchScore(p, salesState.filters.search) }))
          .filter(p => p._score > 0)
          .sort((a, b) => b._score - a._score)[0];
      }

      if (targetProduct) {
        salesState.lineItems[0].productId = targetProduct.id;
        salesState.lineItems[0].unitPrice = targetProduct.default_sale_price || targetProduct.last_sale_price || 0;
        salesState.lineItems[0].available = targetProduct.current_stock || 0;
        salesState.lineItems[0].qty = 1;
      }

      renderLineItems();
    }
  } catch (err) {
    console.error('Failed to fetch products:', err);
  }
}

// ==========================================
// 2. INVOICE LINE ITEMS (Full Product Details Display)
// ==========================================
function productQuickFacts(product, currentQty = 1, currentSalePrice = 0) {
  if (!product) {
    return '<div style="padding: 8px 12px; background: #fff1f2; color: #be123c; border: 1px solid #fecdd3; border-radius: 10px; font-size: 0.82rem; font-weight: 700;">No product selected yet. Choose a product from the dropdown or search box above.</div>';
  }
  const stock = Number(product.current_stock || 0);
  const afterStock = stock - currentQty;
  const purPrice = Number(
    product.default_purchase_price ||
    product.last_purchase_price ||
    product.average_unit_cost ||
    0
  );
  const estProfit = (Number(currentSalePrice || 0) - purPrice) * Number(currentQty || 1);

  return `
    <div style="width: 100%; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 10px 14px; display: grid; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
        <div style="font-size: 0.96rem; font-weight: 900; color: #0f172a;">
          Model: <span style="color: var(--blue-dark);">${escapeHtml(product.model)}</span>
          ${product.series ? `<span style="font-weight: 700; color: #475569;"> (${escapeHtml(product.series)})</span>` : ''}
          ${product.size ? `<span style="font-weight: 700; color: #0369a1;"> • ${escapeHtml(product.size)}</span>` : ''}
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <span class="badge" style="padding: 4px 10px; font-size: 0.76rem; background: #dbeafe; color: #1e40af; font-weight: 800;">Category: ${escapeHtml(product.category_name || 'Appliance')}</span>
          <span class="badge info" style="padding: 4px 10px; font-size: 0.76rem;">Brand: ${escapeHtml(product.company || '-')}</span>
        </div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.8rem;">
        <span class="badge" style="padding: 4px 10px; font-size: 0.76rem; background: #f1f5f9; color: #0f172a; border: 1px solid #cbd5e1;">Color: <strong>${escapeHtml(product.color || 'Standard')}</strong></span>
        <span class="badge" style="padding: 4px 10px; font-size: 0.76rem; background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe;">Place: <strong>${escapeHtml(product.location_name || 'Warehouse')}</strong></span>
        <span class="badge ${stock > 0 ? 'success' : 'danger'}" style="padding: 4px 10px; font-size: 0.76rem;">Available Stock: <strong>${stock}</strong></span>
        <span class="badge ${afterStock >= 0 ? 'warning' : 'danger'}" style="padding: 4px 10px; font-size: 0.76rem; ${afterStock >= 0 ? 'background: #fef3c7; color: #b45309;' : ''}">Stock After Sale: <strong>${afterStock}</strong></span>
        <span class="badge price-safe-box" style="padding: 4px 10px; font-size: 0.76rem; background: #f8fafc; color: #334155; border: 1px solid #e2e8f0;">Purchase Rate: <strong>${UI.currencyHTML(purPrice)}</strong></span>
        <span class="badge price-safe-box" style="padding: 4px 10px; font-size: 0.76rem; background: ${estProfit >= 0 ? '#dcfce7' : '#fee2e2'}; color: ${estProfit >= 0 ? '#166534' : '#991b1b'};">Est. Profit: <strong>${UI.currencyHTML(estProfit)}</strong></span>
      </div>
    </div>
  `;
}

function makeLineItemRow(stateItem) {
  return `
    <div class="line-item-row" data-id="${stateItem.id}" style="display: grid; gap: 12px; padding: 16px; background: var(--surface-2); border: 1px solid var(--line-strong); border-radius: 16px; margin-bottom: 14px;">
      <!-- Row 1: Full-Width Product Model Selector -->
      <div style="width: 100%;">
        <label style="font-size: 0.78rem; color: var(--blue-dark); text-transform: uppercase; font-weight: 800; letter-spacing: 0.04em; display: block; margin-bottom: 6px;">Select Product (Model — Brand — Category — Color — Place)</label>
        <select class="item-product-select" data-item-field="product_id" style="width: 100%; border: 1.5px solid var(--line-strong); font-weight: 800; font-size: 0.95rem; background: #fff; padding: 12px 14px; border-radius: 12px; color: #0f172a;"></select>
      </div>

      <!-- Row 2: Qty, Unit Price, Line Total & Actions -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 12px; align-items: end; background: #ffffff; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);">
        <div>
          <label style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase; font-weight: 800; letter-spacing: 0.04em;">Quantity</label>
          <div class="input-stepper" style="margin-top: 4px; border: 1px solid var(--line-strong);">
            <button type="button" data-step-qty="-1" class="btn-ghost" style="border: none; border-radius: 0; padding: 10px 14px;">-</button>
            <input type="number" data-item-field="quantity" value="${stateItem.qty || 1}" min="1" style="min-height: 40px;">
            <button type="button" data-step-qty="1" class="btn-ghost" style="border: none; border-radius: 0; padding: 10px 14px;">+</button>
          </div>
        </div>

        <div>
          <label style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase; font-weight: 800; letter-spacing: 0.04em;">Sale Unit Price (Rs)</label>
          <input type="number" data-item-field="unit_price" value="${stateItem.unitPrice || 0}" step="0.01" style="width: 100%; min-height: 42px; border: 1px solid var(--line-strong); padding: 10px 12px; border-radius: 10px; font-weight: 800; font-size: 1rem; background: #fff; margin-top: 4px;">
          <div style="display:none;" data-purchase-price></div>
        </div>

        <div style="text-align: right; align-self: center;">
          <label style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase; font-weight: 800; letter-spacing: 0.04em; display: block;">Line Total</label>
          <div data-line-total class="price-safe-box" style="font-size: 1.3rem; font-weight: 900; color: var(--blue-dark); margin-top: 4px;">Rs 0</div>
        </div>

        <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
          <button type="button" class="btn-ghost small btn-clear-row" style="padding: 9px 14px; font-size: 0.8rem;">Clear</button>
          ${salesState.lineItems.length > 1 ? `<button type="button" class="btn-danger small btn-remove-row" style="padding: 9px 14px; font-size: 0.8rem;">Remove</button>` : ''}
        </div>
      </div>

      <!-- Row 3: Full Product Details Card (Model, Series, Category, Brand, Color, Place, Stock, Purchase Price & Profit) -->
      <div class="line-item-tags" data-item-tags style="width: 100%;"></div>
    </div>
  `;
}

function getRowProduct(row) {
  const productId = row.querySelector('[data-item-field="product_id"]')?.value;
  return filteredProducts().find(item => String(item.id) === String(productId)) || salesProducts.find(item => String(item.id) === String(productId));
}

function hydrateSingleLineSelect(row, products, preserveValue = true) {
  const select = row.querySelector('[data-item-field="product_id"]');
  const rowId = Number(row.dataset.id);
  const stateItem = salesState.lineItems.find(i => i.id === rowId);
  const targetId = (preserveValue && select.value) ? select.value : (stateItem?.productId || '');

  const itemsToRender = [...products];
  if (targetId) {
    const stillExists = itemsToRender.find(p => String(p.id) === String(targetId));
    if (!stillExists) {
      const matched = salesProducts.find(p => String(p.id) === String(targetId));
      if (matched) itemsToRender.unshift(matched);
    }
  }

  let optionsHtml = '<option value="">-- Select a Product --</option>';
  optionsHtml += itemsToRender.map(item => `<option value="${item.id}" ${Number(item.current_stock) <= 0 ? 'disabled' : ''}>${escapeHtml(productOptionLabel(item))}</option>`).join('');

  select.innerHTML = optionsHtml;
  select.value = targetId || '';
  bindRowEvents(row);
}

function hydrateLineItemSelects() {
  const products = filteredProducts();
  const rows = [...document.querySelectorAll('.line-item-row')];
  rows.forEach((row) => hydrateSingleLineSelect(row, products, true));
  rows.forEach(row => row.querySelector('[data-item-field="product_id"]').dispatchEvent(new Event('change')));
  calculateInvoiceTotals();
}

function updateRowUI(row, stateItem) {
  const product = salesProducts.find(p => String(p.id) === String(stateItem.productId));
  const totalEl = row.querySelector('[data-line-total]');
  if (totalEl) totalEl.innerHTML = UI.currencyHTML(stateItem.qty * stateItem.unitPrice);

  const tagsEl = row.querySelector('[data-item-tags]');
  if (tagsEl) tagsEl.innerHTML = productQuickFacts(product, stateItem.qty, stateItem.unitPrice);

  if (product && stateItem.qty > Number(product.current_stock)) {
    row.classList.add('line-item-warning');
  } else {
    row.classList.remove('line-item-warning');
  }
  if (typeof UI !== 'undefined' && typeof UI.applyPricePrivacy === 'function') UI.applyPricePrivacy();
}

function renderLineItems() {
  const container = document.getElementById('invoice-items');
  if (!container) return;
  container.innerHTML = salesState.lineItems.map(item => makeLineItemRow(item)).join('');

  document.querySelectorAll('.line-item-row').forEach(row => {
    const id = Number(row.dataset.id);
    const stateItem = salesState.lineItems.find(i => i.id === id);
    if (!stateItem) return;

    hydrateSingleLineSelect(row, filteredProducts(), true);

    if (stateItem.productId) {
      row.querySelector('.item-product-select').value = stateItem.productId;
    }
    updateRowUI(row, stateItem);
  });

  calculateInvoiceTotals();
  if (typeof UI !== 'undefined' && typeof UI.applyPricePrivacy === 'function') UI.applyPricePrivacy();
}

function bindRowEvents(row) {
  const select = row.querySelector('[data-item-field="product_id"]');
  const quantityInput = row.querySelector('[data-item-field="quantity"]');
  const priceInput = row.querySelector('[data-item-field="unit_price"]');

  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => {
      const itemId = Number(row.dataset.id);
      const stateItem = salesState.lineItems.find(i => i.id === itemId);
      const product = getRowProduct(row);

      if (product) {
        stateItem.productId = product.id;
        stateItem.unitPrice = product.default_sale_price || product.last_sale_price || 0;
        stateItem.available = product.current_stock || 0;
        stateItem.qty = 1;
        quantityInput.value = 1;
        priceInput.value = stateItem.unitPrice;
      } else {
        stateItem.productId = '';
        stateItem.available = 0;
        stateItem.qty = 1;
        stateItem.unitPrice = 0;
        quantityInput.value = 1;
        priceInput.value = 0;
      }
      updateRowUI(row, stateItem);
      calculateInvoiceTotals();
    });
  }

  if (!quantityInput.dataset.bound) {
    quantityInput.dataset.bound = '1';
    quantityInput.addEventListener('input', () => {
      const itemId = Number(row.dataset.id);
      const stateItem = salesState.lineItems.find(i => i.id === itemId);

      let qty = Number(quantityInput.value || 0);
      if (qty < 1) qty = 1;

      const product = getRowProduct(row);
      if (product) {
        const available = Number(product.current_stock || 0);
        if (qty > available && available > 0) {
          qty = available;
          if (typeof UI !== 'undefined') UI.toast(`Max available stock is ${available}.`, 'warning');
        }
      }

      stateItem.qty = qty;
      quantityInput.value = qty;
      updateRowUI(row, stateItem);
      calculateInvoiceTotals();
    });
  }

  if (!priceInput.dataset.bound) {
    priceInput.dataset.bound = '1';
    priceInput.addEventListener('input', () => {
      const itemId = Number(row.dataset.id);
      const stateItem = salesState.lineItems.find(i => i.id === itemId);
      stateItem.unitPrice = Number(priceInput.value || 0);
      updateRowUI(row, stateItem);
      calculateInvoiceTotals();
    });
  }
}

function clearLineItem(row) {
  const itemId = Number(row.dataset.id);
  const stateItem = salesState.lineItems.find(i => i.id === itemId);
  if (stateItem) {
    stateItem.productId = '';
    stateItem.available = 0;
    stateItem.qty = 1;
    stateItem.unitPrice = 0;
  }

  const select = row.querySelector('[data-item-field="product_id"]');
  const qtyInput = row.querySelector('[data-item-field="quantity"]');
  const priceInput = row.querySelector('[data-item-field="unit_price"]');
  const totalEl = row.querySelector('[data-line-total]');
  const purEl = row.querySelector('[data-purchase-price]');
  const tagsEl = row.querySelector('[data-item-tags]');

  if (select) select.value = '';
  if (qtyInput) qtyInput.value = 1;
  if (priceInput) priceInput.value = 0;
  if (totalEl) totalEl.innerHTML = 'Rs 0';
  if (purEl) purEl.innerHTML = '';
  if (tagsEl) tagsEl.innerHTML = '<span class="badge danger" style="padding:4px 8px; font-size:0.75rem;">No product selected</span>';

  row.classList.remove('line-item-warning');
  calculateInvoiceTotals();
}

// ==========================================
// 3. DISCOUNT & TOTALS LOGIC
// ==========================================
function renderDiscountRules() {
  const wrap = document.getElementById('discount-rule-list');
  const select = document.getElementById('discount-rule-select');
  if (select) {
    select.innerHTML = '<option value="">Custom / none</option>' + salesState.discountRules.map(rule => `
      <option value="${rule.id}">${escapeHtml(rule.name)} (${rule.discount_type === 'percent' ? `${rule.discount_value}%` : `Rs ${rule.discount_value}`})</option>
    `).join('');
  }
  if (!wrap) return;
  if (!salesState.discountRules.length) {
    wrap.innerHTML = '<div class="empty-state">No reusable discounts saved yet.</div>';
    return;
  }
  wrap.innerHTML = salesState.discountRules.map(rule => `
    <article class="record-card" style="padding: 14px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 10px; background: #fff;">
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 6px;">
        <div>
          <strong style="font-size: 1rem; color: var(--blue-dark);">${escapeHtml(rule.name)}</strong>
          <div style="font-size: 0.82rem; color: var(--muted); margin-top: 2px;">
            ${rule.discount_type === 'percent' ? 'Percentage' : 'Fixed'} •
            <strong>${rule.discount_type === 'percent' ? `${rule.discount_value}%` : UI.currencyText(rule.discount_value)}</strong>
          </div>
        </div>
        <span class="badge ${Number(rule.active || 0) ? 'success' : 'warning'}">${Number(rule.active || 0) ? 'Active' : 'Inactive'}</span>
      </div>
      ${rule.description ? `<div style="font-size: 0.8rem; color: var(--muted); margin-bottom: 8px;">${escapeHtml(rule.description)}</div>` : ''}
      <div class="inline-actions" style="display: flex; gap: 8px; margin-top: 8px;">
        <button class="btn-ghost small" type="button" data-apply-discount-rule="${rule.id}">Apply</button>
        <button class="btn-ghost small" type="button" data-edit-discount-rule="${rule.id}">Edit</button>
        <button class="btn-danger small" type="button" data-delete-discount-rule="${rule.id}">Delete</button>
      </div>
    </article>
  `).join('');
}

function openDiscountRuleModal(rule = null) {
  const form = document.getElementById('discount-rule-form');
  if (form) form.reset();
  const msgEl = document.getElementById('discount-rule-form-message');
  if (msgEl) UI.showMessage(msgEl, '');

  document.getElementById('discount-rule-id').value = rule?.id || '';
  document.getElementById('discount-rule-name').value = rule?.name || '';
  document.getElementById('discount-rule-type').value = rule?.discount_type || 'fixed';
  document.getElementById('discount-rule-value').value = rule?.discount_value || 0;
  document.getElementById('discount-rule-description').value = rule?.description || '';
  document.getElementById('discount-rule-active').checked = Number(rule?.active ?? 1) === 1;

  const titleEl = document.getElementById('discount-rule-modal-title');
  if (titleEl) titleEl.textContent = rule ? 'Edit discount' : 'New discount';
  UI.openModal('discount-rule-modal');
}

function applyDiscountRule(ruleId) {
  const rule = salesState.discountRules.find(item => String(item.id) === String(ruleId));
  if (!rule) {
    document.getElementById('discount-name').value = '';
    syncDiscountInputs();
    calculateInvoiceTotals();
    return;
  }
  const enabledBox = document.getElementById('discount-enabled');
  if (enabledBox) enabledBox.checked = true;
  const select = document.getElementById('discount-rule-select');
  if (select) select.value = String(rule.id);
  const nameInput = document.getElementById('discount-name');
  if (nameInput) nameInput.value = rule.name;
  const typeSelect = document.getElementById('discount-type');
  if (typeSelect) typeSelect.value = rule.discount_type;
  const valInput = document.getElementById('discount-value');
  if (valInput) valInput.value = rule.discount_value;

  syncDiscountInputs();
  calculateInvoiceTotals();
}

async function refreshDiscountRules() {
  salesState.discountRules = await API.get('/api/discount-rules').catch(() => []);
  renderDiscountRules();
}

function syncDiscountInputs() {
  const enabled = document.getElementById('discount-enabled')?.checked;
  ['discount-rule-select', 'discount-name', 'discount-type', 'discount-value'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
  const label = document.getElementById('invoice-discount-label');
  if (!enabled) {
    if (label) label.textContent = 'No discount applied';
    return;
  }
  const type = document.getElementById('discount-type')?.value;
  const value = Number(document.getElementById('discount-value')?.value || 0);
  const name = document.getElementById('discount-name')?.value.trim();
  if (label) {
    const prefix = name ? `${escapeHtml(name)}: ` : '';
    label.textContent = value > 0
      ? `${prefix}${type === 'percent' ? `${value}%` : `Rs ${value}`} discount active`
      : 'Discount enabled';
  }
}

function calculateInvoiceTotals() {
  let subtotal = 0;
  document.querySelectorAll('.line-item-row').forEach(row => {
    const qty = Number(row.querySelector('[data-item-field="quantity"]')?.value || 0);
    const price = Number(row.querySelector('[data-item-field="unit_price"]')?.value || 0);
    subtotal += Math.max(0, qty * price);
  });

  const discountEnabled = document.getElementById('discount-enabled')?.checked;
  const discountType = document.getElementById('discount-type')?.value;
  const discountValue = Number(document.getElementById('discount-value')?.value || 0);

  let discountAmount = 0;
  if (discountEnabled && subtotal > 0 && discountValue > 0) {
    discountAmount = discountType === 'percent' ? (subtotal * discountValue / 100) : discountValue;
    discountAmount = Math.max(0, Math.min(discountAmount, subtotal));
  }

  const total = Math.max(0, subtotal - discountAmount);

  const subEl = document.getElementById('invoice-subtotal-preview');
  const discEl = document.getElementById('invoice-discount-preview');
  const totEl = document.getElementById('invoice-total-preview');

  if (subEl) subEl.innerHTML = UI.currencyHTML(subtotal);
  if (discEl) discEl.innerHTML = UI.currencyHTML(discountAmount);
  if (totEl) totEl.innerHTML = UI.currencyHTML(total);

  syncDiscountInputs();
  if (typeof UI !== 'undefined' && typeof UI.applyPricePrivacy === 'function') UI.applyPricePrivacy();
}

// ==========================================
// 4. PROFESSIONAL INVOICE MODAL, PRINT & WHATSAPP IMAGE SHARING
// ==========================================
function formatInvoiceDateTime(inv) {
  const raw = inv.transaction_at || inv.invoice_date || inv.created_at || '';
  if (!raw) return UI.formatDate(new Date().toISOString());
  try {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-PK', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    }
  } catch (_) {}
  return raw;
}

function formatUnmaskedPKR(val) {
  const num = Number(val || 0);
  return 'Rs ' + num.toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

function buildWhatsAppReceiptText(inv) {
  const branchName = inv.branch_name || currentBranchInfo.name || 'Main Branch';
  const invNo = inv.invoice_number || `INV-${inv.id}`;
  const customer = inv.customer_name || 'Walk-in Customer';
  const status = inv.status || 'Paid';
  const dateStr = formatInvoiceDateTime(inv);
  const rawItems = inv.items || [];

  const lines = [
    `*MALIK ELECTRONIC (${branchName})*`,
    `Invoice: *${invNo}* | Date: ${dateStr}`,
    `Customer: *${customer}* (${status})`,
    `--------------------------------`
  ];

  rawItems.forEach((item, idx) => {
    const d = resolveInvoiceItemDetails(item);
    lines.push(`${idx + 1}. *${d.categoryName}*: ${d.companyName} ${d.modelName} (${d.colorName}) x${d.quantity} = *${formatUnmaskedPKR(d.lineTotal)}*`);
  });

  lines.push(`--------------------------------`);
  lines.push(`*GRAND TOTAL: ${formatUnmaskedPKR(inv.total_amount)}*`);
  lines.push(`Thank you for shopping at Malik Electronic!`);
  return lines.join('\n');
}

/**
 * Renders a studio-quality 1200px PNG Image of the Invoice using native HTML5 Canvas.
 * Works 100% offline/online on all Android, iOS, and Desktop browsers.
 */
async function generateInvoiceCanvasDataUrl(inv) {
  const invNo = inv.invoice_number || `INV-${inv.id}`;
  const branchName = inv.branch_name || currentBranchInfo.name || 'Talagang City';
  const dateStr = formatInvoiceDateTime(inv);
  const status = (inv.status || 'Paid').toUpperCase();
  const isPaid = status === 'PAID';

  const rawItems = inv.items || [];
  const items = rawItems.map(item => resolveInvoiceItemDetails(item));
  const totalUnits = items.reduce((acc, it) => acc + it.quantity, 0);
  const subtotal = Number(inv.subtotal ?? items.reduce((acc, it) => acc + it.lineTotal, 0));
  const discountAmount = Number(inv.discount_amount ?? 0);
  const grandTotal = Number(inv.total_amount ?? Math.max(0, subtotal - discountAmount));

  const width = 1100;
  const rowHeight = 76;
  const baseHeight = 640;
  const height = baseHeight + Math.max(items.length, 1) * rowHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const roundRect = (x, y, w, h, r, fill, stroke) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  };

  // 1. White Sheet Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // 2. Top Executive Navy Header Banner
  const grad = ctx.createLinearGradient(0, 0, width, 155);
  grad.addColorStop(0, '#070d19');
  grad.addColorStop(1, '#1428a0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, 155);

  // Gold accent bar
  ctx.fillStyle = '#facc15';
  ctx.fillRect(0, 150, width, 6);

  // Logo Box
  roundRect(45, 32, 74, 74, 16, '#facc15', null);
  ctx.fillStyle = '#070d19';
  ctx.font = '900 32px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ME', 82, 80);

  // Brand Title
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 34px Inter, Arial, sans-serif';
  ctx.fillText('MALIK ELECTRONIC', 138, 65);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '600 17px Inter, Arial, sans-serif';
  ctx.fillText(`Branch: ${branchName}  •  Authorized Home Appliances & Electronics Dealer`, 138, 95);
  ctx.fillStyle = '#93c5fd';
  ctx.font = '600 15px Inter, Arial, sans-serif';
  ctx.fillText('Refrigerators • Air Conditioners • Washing Machines • LED TVs • Kitchen Appliances', 138, 122);

  // Right Invoice Meta in Banner
  ctx.textAlign = 'right';
  ctx.fillStyle = '#facc15';
  ctx.font = '800 15px Inter, Arial, sans-serif';
  ctx.fillText('CUSTOMER SALES INVOICE', width - 45, 48);

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 28px Inter, Arial, sans-serif';
  ctx.fillText(invNo, width - 45, 82);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 15px Inter, Arial, sans-serif';
  ctx.fillText(`Date: ${dateStr}`, width - 45, 110);

  // Status Badge
  roundRect(width - 145, 118, 100, 24, 12, isPaid ? '#16a34a' : '#d97706', null);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 13px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(status, width - 95, 135);

  // 3. Customer & Transaction Cards
  roundRect(45, 182, 500, 115, 14, '#f8fafc', '#cbd5e1');
  roundRect(565, 182, 490, 115, 14, '#f8fafc', '#cbd5e1');

  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.font = '800 13px Inter, Arial, sans-serif';
  ctx.fillText('BILL TO CUSTOMER', 65, 208);
  ctx.fillText('PURCHASE & WARRANTY SUMMARY', 585, 208);

  ctx.fillStyle = '#0f172a';
  ctx.font = '800 22px Inter, Arial, sans-serif';
  ctx.fillText(String(inv.customer_name || 'Walk-in Customer').slice(0, 32), 65, 238);

  ctx.fillStyle = '#334155';
  ctx.font = '600 16px Inter, Arial, sans-serif';
  ctx.fillText(`Phone / WhatsApp: ${inv.phone_number || 'N/A'}`, 65, 264);
  ctx.fillText(`Address: ${String(inv.address || 'N/A').slice(0, 42)}`, 65, 286);

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 16px Inter, Arial, sans-serif';
  ctx.fillText(`Purchased Items: ${items.length} Product(s) (${totalUnits} Unit${totalUnits === 1 ? '' : 's'})`, 585, 238);
  ctx.fillText(`Payment Status: ${status}`, 585, 264);
  ctx.fillStyle = '#475569';
  ctx.font = '600 15px Inter, Arial, sans-serif';
  ctx.fillText(`Notes: ${String(inv.notes || 'Official Brand Warranty Applies').slice(0, 40)}`, 585, 286);

  // 4. Table Header
  const tableTop = 320;
  roundRect(45, tableTop, width - 90, 46, 10, '#0f172a', null);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 14px Inter, Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('#', 65, tableTop + 29);
  ctx.fillText('PRODUCT CATEGORY', 105, tableTop + 29);
  ctx.fillText('BRAND', 325, tableTop + 29);
  ctx.fillText('MODEL & DETAILS', 470, tableTop + 29);
  ctx.textAlign = 'center';
  ctx.fillText('QTY', 755, tableTop + 29);
  ctx.textAlign = 'right';
  ctx.fillText('UNIT PRICE', 900, tableTop + 29);
  ctx.fillText('TOTAL', width - 65, tableTop + 29);

  // 5. Table Rows
  let y = tableTop + 46;
  items.forEach((it, idx) => {
    if (idx % 2 === 1) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(45, y, width - 90, rowHeight);
    }
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(45, y + rowHeight);
    ctx.lineTo(width - 45, y + rowHeight);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#64748b';
    ctx.font = '800 16px Inter, Arial, sans-serif';
    ctx.fillText(String(idx + 1), 65, y + 44);

    // Category Badge
    const catText = String(it.categoryName || 'Appliance').toUpperCase().slice(0, 18);
    roundRect(105, y + 20, 200, 34, 8, '#dbeafe', '#bfdbfe');
    ctx.fillStyle = '#1e40af';
    ctx.font = '800 14px Inter, Arial, sans-serif';
    ctx.fillText(catText, 118, y + 42);

    // Brand
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 17px Inter, Arial, sans-serif';
    ctx.fillText(String(it.companyName || '-').slice(0, 14), 325, y + 43);

    // Model & Specs
    ctx.fillStyle = '#0f172a';
    ctx.font = '800 18px Inter, Arial, sans-serif';
    ctx.fillText(String(it.modelName || '-').slice(0, 22), 470, y + 34);

    const specs = [
      it.seriesName ? `${it.seriesName}` : '',
      it.sizeName ? `${it.sizeName}` : '',
      it.colorName ? `Color: ${it.colorName}` : ''
    ].filter(Boolean).join(' • ');
    ctx.fillStyle = '#64748b';
    ctx.font = '600 14px Inter, Arial, sans-serif';
    ctx.fillText(specs.slice(0, 34), 470, y + 56);

    // Qty
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0f172a';
    ctx.font = '900 18px Inter, Arial, sans-serif';
    ctx.fillText(String(it.quantity), 755, y + 44);

    // Unit Price
    ctx.textAlign = 'right';
    ctx.fillStyle = '#334155';
    ctx.font = '700 16px Inter, Arial, sans-serif';
    ctx.fillText(formatUnmaskedPKR(it.unitPrice), 900, y + 44);

    // Line Total
    ctx.fillStyle = '#0f172a';
    ctx.font = '900 18px Inter, Arial, sans-serif';
    ctx.fillText(formatUnmaskedPKR(it.lineTotal), width - 65, y + 44);

    y += rowHeight;
  });

  // 6. Totals & Warranty Footer
  const footerTop = y + 26;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#0f172a';
  ctx.font = '800 16px Inter, Arial, sans-serif';
  ctx.fillText('Warranty & Return Policy:', 45, footerTop + 22);
  ctx.fillStyle = '#475569';
  ctx.font = '600 14px Inter, Arial, sans-serif';
  ctx.fillText('• All appliances carry official company/brand warranty.', 45, footerTop + 46);
  ctx.fillText('• Please keep this invoice safe for warranty claims.', 45, footerTop + 68);
  ctx.fillText('• Thank you for shopping with Malik Electronic!', 45, footerTop + 90);

  // Totals Card on Right
  roundRect(660, footerTop, width - 705, 130, 14, '#f8fafc', '#cbd5e1');
  ctx.textAlign = 'left';
  ctx.fillStyle = '#475569';
  ctx.font = '700 16px Inter, Arial, sans-serif';
  ctx.fillText(`Subtotal (${totalUnits} items):`, 682, footerTop + 34);
  ctx.fillText('Discount:', 682, footerTop + 64);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#0f172a';
  ctx.fillText(formatUnmaskedPKR(subtotal), width - 65, footerTop + 34);
  ctx.fillStyle = discountAmount > 0 ? '#dc2626' : '#64748b';
  ctx.fillText(discountAmount > 0 ? `- ${formatUnmaskedPKR(discountAmount)}` : 'Rs 0', width - 65, footerTop + 64);

  // Grand Total Bar
  roundRect(672, footerTop + 78, width - 729, 42, 10, '#1428a0', null);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 18px Inter, Arial, sans-serif';
  ctx.fillText('GRAND TOTAL:', 690, footerTop + 105);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#facc15';
  ctx.font = '900 21px Inter, Arial, sans-serif';
  ctx.fillText(formatUnmaskedPKR(grandTotal), width - 78, footerTop + 106);

  // Signatures
  const sigY = footerTop + 185;
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(45, sigY);
  ctx.lineTo(300, sigY);
  ctx.moveTo(width - 320, sigY);
  ctx.lineTo(width - 45, sigY);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.font = '700 14px Inter, Arial, sans-serif';
  ctx.fillText('Customer Signature', 45, sigY + 22);
  ctx.textAlign = 'right';
  ctx.fillText('Authorized Signature (Malik Electronic)', width - 45, sigY + 22);

  return canvas.toDataURL('image/png');
}

async function dataUrlToFile(dataUrl, fileName) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], fileName, { type: 'image/png' });
}

/**
 * Shares the actual Invoice PNG Image via native mobile share sheet (supports BOTH Normal WhatsApp
 * and WhatsApp Business!) or downloads the PNG image and opens WhatsApp on desktop.
 */
async function shareInvoiceOnWhatsApp(inv) {
  if (!inv) return;
  const invNo = inv.invoice_number || `INV-${inv.id}`;
  const fileName = `${invNo}.png`;

  try {
    UI.toast('Preparing Invoice Image for WhatsApp...', 'info');
    const dataUrl = await generateInvoiceCanvasDataUrl(inv);
    const imageFile = await dataUrlToFile(dataUrl, fileName);
    const caption = buildWhatsAppReceiptText(inv);

    // 1. Mobile Native File Share (Lets user pick Normal WhatsApp OR WhatsApp Business with the PNG Image attached!)
    if (navigator.canShare && navigator.canShare({ files: [imageFile] })) {
      await navigator.share({
        files: [imageFile],
        title: `Malik Electronic - ${invNo}`,
        text: caption
      });
      return;
    }

    // 2. Desktop / Fallback: Download the PNG Image automatically & open WhatsApp chat
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    let phone = String(inv.phone_number || '').replace(/[^0-9]/g, '');
    if (phone.startsWith('03') && phone.length === 11) phone = '92' + phone.slice(1);
    else if (phone.startsWith('3') && phone.length === 10) phone = '92' + phone;
    else if (phone.startsWith('0092')) phone = phone.slice(2);

    const encodedText = encodeURIComponent(caption);
    const waUrl = phone.length >= 11
      ? `https://api.whatsapp.com/send?phone=${phone}&text=${encodedText}`
      : `https://api.whatsapp.com/send?text=${encodedText}`;

    UI.toast('Invoice image downloaded! Attach it in WhatsApp.', 'success');
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  } catch (err) {
    if (err && err.name === 'AbortError') return; // User closed share sheet
    UI.toast('Could not share invoice image.', 'error');
  }
}

async function downloadInvoiceImage(inv) {
  if (!inv) return;
  const invNo = inv.invoice_number || `INV-${inv.id}`;
  const dataUrl = await generateInvoiceCanvasDataUrl(inv);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${invNo}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  UI.toast('Invoice image saved!', 'success');
}

function triggerSinglePagePrint() {
  ['discount-rule-modal', 'security-reverse-modal', 'price-unlock-modal'].forEach(id => {
    document.getElementById(id)?.classList.remove('open');
  });
  window.print();
}

async function openInvoiceDetailModal(invoiceId) {
  try {
    const inv = await API.get(`/api/invoices/${invoiceId}`);
    currentViewingInvoice = inv;

    const invNo = inv.invoice_number || `INV-${inv.id}`;
    const branchName = inv.branch_name || currentBranchInfo.name || 'Main Branch';
    const branchAddress = inv.branch_address || currentBranchInfo.address || 'Authorized Electronics Retailer & Distributor';
    const dateStr = formatInvoiceDateTime(inv);
    const status = inv.status || 'Paid';
    const isCancelled = status === 'Cancelled';

    const rawItems = inv.items || [];
    const enrichedItems = rawItems.map(item => resolveInvoiceItemDetails(item));
    const totalUnits = enrichedItems.reduce((acc, it) => acc + it.quantity, 0);

    const subtotal = Number(inv.subtotal ?? enrichedItems.reduce((acc, it) => acc + it.lineTotal, 0));
    const discountAmount = Number(inv.discount_amount ?? 0);
    const grandTotal = Number(inv.total_amount ?? Math.max(0, subtotal - discountAmount));

    const titleEl = document.getElementById('invoice-detail-title');
    if (titleEl) titleEl.textContent = `Bill #${invNo}`;

    const bodyEl = document.getElementById('invoice-detail-body');
    if (!bodyEl) return;

    // Generate high-res PNG invoice preview so it looks 100% proportional on mobile & can be shared as an image
    const invoiceImageUrl = await generateInvoiceCanvasDataUrl(inv);

    bodyEl.innerHTML = `
      <!-- Top Action Bar (Hidden on Print) -->
      <div class="invoice-action-bar no-print" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div style="display: flex; gap: 8px; flex-wrap: wrap; width: 100%;">
          <button type="button" class="btn-whatsapp" id="btn-modal-whatsapp-invoice" style="flex: 1 1 200px; justify-content: center;">
            <span>&#128247;</span> <span>Share Invoice Image on WhatsApp</span>
          </button>
          <button type="button" class="btn-print-invoice" id="btn-modal-print-invoice" style="flex: 1 1 150px; justify-content: center;">
            <span>&#128424;</span> <span>Print (1 Page)</span>
          </button>
          <button type="button" class="btn-ghost small" id="btn-modal-download-img" style="flex: 1 1 140px; justify-content: center; font-weight:800;">
            <span>&#11015;</span> <span>Save Image</span>
          </button>
          ${!isCancelled ? `<button type="button" class="btn-danger small" id="btn-modal-reverse-invoice" data-id="${inv.id}" style="flex: 0 0 auto;">Delete Bill</button>` : ''}
        </div>
      </div>

      <!-- Visual High-Resolution Invoice Image Preview (Fits 100% on Mobile & Desktop) -->
      <div class="no-print" style="background: #e2e8f0; padding: 10px; border-radius: 16px; margin-bottom: 12px; text-align: center;">
        <img src="${invoiceImageUrl}" alt="Invoice ${escapeHtml(invNo)}" style="width: 100%; max-width: 100%; height: auto; border-radius: 10px; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.15); display: block; margin: 0 auto;">
        <div style="font-size: 0.78rem; color: #475569; margin-top: 8px; font-weight: 700;">
          Tip: Tap "Share Invoice Image on WhatsApp" above to send this exact bill image on Normal WhatsApp or WhatsApp Business.
        </div>
      </div>

      <!-- Printable Single-Page Invoice Sheet (Used when printing to A4 Paper / PDF) -->
      <div class="print-invoice-sheet" id="printable-invoice-area">
        <div class="inv-top-header">
          <div class="inv-brand-block">
            <div class="inv-logo-mark">ME</div>
            <div>
              <h1 class="inv-shop-name">MALIK ELECTRONIC</h1>
              <div class="inv-shop-sub">Branch: <strong>${escapeHtml(branchName)}</strong> ${branchAddress ? `&bull; ${escapeHtml(branchAddress)}` : ''}</div>
              <div class="inv-shop-sub">Home Appliances, Air Conditioners, Refrigerators, Washing Machines &amp; Electronics</div>
            </div>
          </div>
          <div class="inv-meta-right">
            <span class="inv-doc-label">Customer Sales Invoice</span>
            <h2 class="inv-number-title">${escapeHtml(invNo)}</h2>
            <div class="inv-date-text">Date: ${escapeHtml(dateStr)}</div>
            <div class="inv-date-text" style="font-weight: 800; color: ${isCancelled ? '#dc2626' : (status === 'Paid' ? '#15803d' : '#b45309')};">
              STATUS: ${escapeHtml(status.toUpperCase())}
            </div>
          </div>
        </div>

        <div class="inv-info-grid">
          <div class="inv-info-card">
            <div class="inv-info-label">Customer Details</div>
            <div class="inv-party-name">${escapeHtml(inv.customer_name || 'Walk-in Customer')}</div>
            <div class="inv-party-detail"><strong>Phone / WhatsApp:</strong> ${escapeHtml(inv.phone_number || 'N/A')}</div>
            <div class="inv-party-detail"><strong>Address:</strong> ${escapeHtml(inv.address || 'N/A')}</div>
          </div>
          <div class="inv-info-card">
            <div class="inv-info-label">Transaction &amp; Warranty Summary</div>
            <div class="inv-party-detail"><strong>Payment Status:</strong> ${escapeHtml(status)}</div>
            <div class="inv-party-detail"><strong>Total Purchased Appliances:</strong> ${enrichedItems.length} Item(s) (${totalUnits} Unit${totalUnits === 1 ? '' : 's'})</div>
            <div class="inv-party-detail"><strong>Notes / Warranty:</strong> ${escapeHtml(inv.notes || 'Standard Manufacturer Warranty Applies')}</div>
          </div>
        </div>

        <table class="inv-items-table">
          <thead>
            <tr>
              <th style="width: 36px;">#</th>
              <th>Purchased Product (Category)</th>
              <th>Company / Brand</th>
              <th>Model &amp; Specifications</th>
              <th style="text-align: center; width: 65px;">Qty</th>
              <th style="text-align: right; width: 115px;">Unit Price</th>
              <th style="text-align: right; width: 125px;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${enrichedItems.map((it, idx) => {
              const extraSpecs = [
                it.seriesName ? `Series: ${escapeHtml(it.seriesName)}` : '',
                it.sizeName ? `Size: ${escapeHtml(it.sizeName)}` : '',
                it.colorName ? `Color: ${escapeHtml(it.colorName)}` : ''
              ].filter(Boolean).join(' &bull; ');

              return `
                <tr>
                  <td style="font-weight: 800; color: #64748b;">${idx + 1}</td>
                  <td><span class="inv-category-pill">${escapeHtml(it.categoryName)}</span></td>
                  <td style="font-weight: 800; color: #0f172a;">${escapeHtml(it.companyName)}</td>
                  <td>
                    <div class="inv-product-title">${escapeHtml(it.modelName)}</div>
                    ${extraSpecs ? `<div class="inv-product-specs">${extraSpecs}</div>` : ''}
                  </td>
                  <td style="text-align: center; font-weight: 900; font-size: 0.92rem;">${it.quantity}</td>
                  <td style="text-align: right; font-weight: 700;">${formatUnmaskedPKR(it.unitPrice)}</td>
                  <td style="text-align: right; font-weight: 900; color: #0f172a;">${formatUnmaskedPKR(it.lineTotal)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>

        <div class="inv-summary-section">
          <div class="inv-terms-box">
            <strong style="color: #0f172a; display: block; margin-bottom: 3px;">Customer Acknowledgement &amp; Warranty Policy:</strong>
            Goods once sold are covered by official company/brand warranty terms. Please retain this invoice for warranty claims or service inquiries. Thank you for choosing <strong>Malik Electronic</strong>!
          </div>
          <div class="inv-totals-box">
            <div class="inv-total-row">
              <span>Subtotal (${totalUnits} Unit${totalUnits === 1 ? '' : 's'}):</span>
              <strong>${formatUnmaskedPKR(subtotal)}</strong>
            </div>
            <div class="inv-total-row">
              <span>Discount${inv.discount_name ? ` (${escapeHtml(inv.discount_name)})` : ''}:</span>
              <strong style="color: ${discountAmount > 0 ? '#dc2626' : '#64748b'};">
                ${discountAmount > 0 ? `- ${formatUnmaskedPKR(discountAmount)}` : 'None'}
              </strong>
            </div>
            <div class="inv-grand-row">
              <span>Grand Total:</span>
              <span style="color: #1e3a8a;">${formatUnmaskedPKR(grandTotal)}</span>
            </div>
          </div>
        </div>

        <div class="inv-signature-strip">
          <span>Customer Signature: _______________________</span>
          <span>Authorized Signature (Malik Electronic): _______________________</span>
        </div>
      </div>
    `;

    document.getElementById('btn-modal-print-invoice')?.addEventListener('click', triggerSinglePagePrint);
    document.getElementById('btn-modal-whatsapp-invoice')?.addEventListener('click', () => shareInvoiceOnWhatsApp(inv));
    document.getElementById('btn-modal-download-img')?.addEventListener('click', () => downloadInvoiceImage(inv));
    document.getElementById('btn-modal-reverse-invoice')?.addEventListener('click', () => {
      UI.closeModal('invoice-detail-modal');
      openReverseSaleModal(inv.id);
    });

    UI.openModal('invoice-detail-modal');
  } catch (err) {
    UI.toast(err.message || 'Could not load invoice details.', 'error');
  }
}

function openReverseSaleModal(invoiceId) {
  const idInput = document.getElementById('security-reverse-invoice-id');
  const codeInput = document.getElementById('security-reverse-code');
  const errEl = document.getElementById('security-reverse-error');
  if (idInput) idInput.value = invoiceId;
  if (codeInput) codeInput.value = '';
  if (errEl) errEl.textContent = '';
  UI.openModal('security-reverse-modal');
}

// ==========================================
// 5. RECENT INVOICES & KPIs (Today, Last 7 Days, This Month, All Time)
// ==========================================
function getSalesDateRanges() {
  const now = new Date();
  const toISO = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = toISO(now);

  const dWeek = new Date(now);
  dWeek.setDate(now.getDate() - 6); // Inclusive 7 days (today + previous 6 days)
  const weekStart = toISO(dWeek);

  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { today, weekStart, monthStart };
}

function renderSalesKPIs() {
  const { today, weekStart, monthStart } = getSalesDateRanges();

  let todayTotal = 0, todayCount = 0;
  let weekTotal = 0, weekCount = 0;
  let monthTotal = 0, monthCount = 0;
  let allTotal = 0, allCount = 0;

  salesState.invoices.forEach(inv => {
    if (inv.status === 'Cancelled') return;
    const rawVal = inv.invoice_date || inv.transaction_at || '';
    const date = (rawVal.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
    const amt = Number(inv.total_amount || 0);

    allTotal += amt;
    allCount += 1;

    if (date === today) {
      todayTotal += amt;
      todayCount += 1;
    }
    if (date >= weekStart && date <= today) {
      weekTotal += amt;
      weekCount += 1;
    }
    if (date >= monthStart && date <= today) {
      monthTotal += amt;
      monthCount += 1;
    }
  });

  const kpiToday = document.getElementById('kpi-today');
  const kpiWeek = document.getElementById('kpi-week');
  const kpiMonth = document.getElementById('kpi-month');
  const kpiAll = document.getElementById('kpi-all');

  if (kpiToday) kpiToday.innerHTML = UI.currencyHTML(todayTotal);
  if (kpiWeek) kpiWeek.innerHTML = UI.currencyHTML(weekTotal);
  if (kpiMonth) kpiMonth.innerHTML = UI.currencyHTML(monthTotal);
  if (kpiAll) kpiAll.innerHTML = UI.currencyHTML(allTotal);

  const noteToday = document.getElementById('kpi-today-note');
  const noteWeek = document.getElementById('kpi-week-note');
  const noteMonth = document.getElementById('kpi-month-note');
  const noteAll = document.getElementById('kpi-all-note');

  if (noteToday) noteToday.textContent = `${todayCount} bill${todayCount === 1 ? '' : 's'} today`;
  if (noteWeek) noteWeek.textContent = `${weekCount} bill${weekCount === 1 ? '' : 's'} (${weekStart} to ${today})`;
  if (noteMonth) noteMonth.textContent = `${monthCount} bill${monthCount === 1 ? '' : 's'} this month`;
  if (noteAll) noteAll.textContent = `${allCount} total bill${allCount === 1 ? '' : 's'} in branch`;
}

let salesHistoryMode = 'today';

async function loadRecentInvoices() {
  const statusEl = document.getElementById('invoice-status-filter');
  const customerEl = document.getElementById('invoice-customer-filter');
  const startEl = document.getElementById('invoice-start-date');
  const endEl = document.getElementById('invoice-end-date');

  const { today, weekStart, monthStart } = getSalesDateRanges();

  const uiStatus = statusEl ? statusEl.value : '';
  const customer = customerEl ? customerEl.value.trim() : '';
  let start_date = startEl ? startEl.value : '';
  let end_date = endEl ? endEl.value : '';

  const modeButtons = {
    today: document.getElementById('btn-today-sales'),
    week: document.getElementById('btn-week-sales'),
    month: document.getElementById('btn-month-sales'),
    all: document.getElementById('btn-show-all-sales')
  };

  Object.entries(modeButtons).forEach(([key, btn]) => {
    if (!btn) return;
    const isAct = salesHistoryMode === key;
    btn.classList.toggle('active', isAct);
    btn.style.borderColor = isAct ? 'var(--blue)' : '';
    btn.style.fontWeight = isAct ? '800' : 'normal';
  });

  if (salesHistoryMode === 'today') {
    start_date = today;
    end_date = today;
    if (startEl) startEl.value = today;
    if (endEl) endEl.value = today;
  } else if (salesHistoryMode === 'week') {
    start_date = weekStart;
    end_date = today;
    if (startEl) startEl.value = weekStart;
    if (endEl) endEl.value = today;
  } else if (salesHistoryMode === 'month') {
    start_date = monthStart;
    end_date = today;
    if (startEl) startEl.value = monthStart;
    if (endEl) endEl.value = today;
  } else if (salesHistoryMode === 'all') {
    start_date = '';
    end_date = '';
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
  }

  const queryStatus = (uiStatus === 'Active' || uiStatus === '') ? '' : uiStatus;
  const params = buildQuery({ status: queryStatus, customer, start_date, end_date });

  try {
    salesState.invoices = await API.get('/api/invoices').catch(() => []);
    renderSalesKPIs();

    const invoices = await API.get(`/api/invoices?${params}`).catch(() => []);
    const wrap = document.getElementById('invoice-list');
    if (!wrap) return;

    let displayInvoices = invoices;

    if (uiStatus === 'Active') {
      displayInvoices = displayInvoices.filter(inv => inv.status !== 'Cancelled');
    } else if (uiStatus === 'Cancelled') {
      displayInvoices = displayInvoices.filter(inv => inv.status === 'Cancelled');
    } else if (uiStatus === 'Paid' || uiStatus === 'Unpaid') {
      displayInvoices = displayInvoices.filter(inv => inv.status === uiStatus);
    }

    if (customer) {
      displayInvoices = displayInvoices.filter(inv =>
        String(inv.customer_name || '').toLowerCase().includes(customer.toLowerCase()) ||
        String(inv.invoice_number || '').toLowerCase().includes(customer.toLowerCase())
      );
    }

    if (start_date) {
      displayInvoices = displayInvoices.filter(inv => {
        const dStr = ((inv.invoice_date || inv.transaction_at || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
        return dStr >= start_date;
      });
    }
    if (end_date) {
      displayInvoices = displayInvoices.filter(inv => {
        const dStr = ((inv.invoice_date || inv.transaction_at || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
        return dStr <= end_date;
      });
    }

    if (!displayInvoices.length) {
      wrap.innerHTML = `<div class="empty-state">No sales found for ${salesHistoryMode === 'today' ? 'today' : 'the selected criteria'}.</div>`;
      return;
    }

    const groups = {};
    displayInvoices.forEach(inv => {
      const rawDate = (inv.transaction_at || inv.invoice_date || '').split('T')[0] || 'Unknown Date';
      if (!groups[rawDate]) groups[rawDate] = [];
      groups[rawDate].push(inv);
    });

    const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

    wrap.innerHTML = sortedDates.map(dateKey => {
      let formattedHeader = dateKey;
      try {
        const parts = dateKey.split('-');
        if (parts.length === 3) {
          const dObj = new Date(parts[0], parts[1] - 1, parts[2]);
          formattedHeader = dObj.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        }
      } catch (_) {}

      const cardsHtml = groups[dateKey].map(invoice => {
        const isCancelled = invoice.status === 'Cancelled';
        let timeStr = '';
        try {
          const tDate = new Date(invoice.transaction_at || invoice.invoice_date);
          if (!Number.isNaN(tDate.getTime())) {
            timeStr = tDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        } catch (_) {}

        return `
        <article class="invoice-history-card" style="margin-bottom: 8px; ${isCancelled ? 'opacity: 0.65; border-style: dashed;' : ''}">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <strong style="font-size: 1rem; ${isCancelled ? 'text-decoration: line-through;' : ''}">${escapeHtml(invoice.customer_name)}</strong>
            <span class="badge ${isCancelled ? 'danger' : (invoice.status === 'Paid' ? 'success' : 'warning')}">${escapeHtml(invoice.status)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; color: var(--muted); font-size: 0.8rem; margin-bottom: 8px;">
            <span>${escapeHtml(invoice.invoice_number)}</span>
            <span>${escapeHtml(timeStr)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--line); padding-top: 8px; flex-wrap: wrap; gap: 6px;">
            <strong class="price-safe-box currency-inline" style="${isCancelled ? 'text-decoration: line-through; color: var(--muted);' : 'color: var(--blue-dark); font-size: 1.05rem;'}">
              ${UI.currencyHTML(invoice.total_amount)}
            </strong>
            <div class="inline-actions" style="display: flex; gap: 6px;">
              <button class="btn-ghost small btn-view-inv" type="button" data-id="${invoice.id}">View / Print</button>
              <button class="btn-whatsapp small btn-wa-inv" type="button" data-id="${invoice.id}" style="padding: 5px 10px; font-size: 0.76rem;">WhatsApp</button>
              <button class="btn-danger small btn-trigger-reverse" type="button" data-id="${invoice.id}">Delete</button>
            </div>
          </div>
        </article>`;
      }).join('');

      return `
        <div class="day-group" style="margin-bottom: 16px;">
          <div style="font-size: 0.82rem; font-weight: 800; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.05em;">
            ${escapeHtml(formattedHeader)}
          </div>
          ${cardsHtml}
        </div>
      `;
    }).join('');

    if (typeof UI !== 'undefined' && typeof UI.applyPricePrivacy === 'function') UI.applyPricePrivacy();
  } catch (err) {
    console.error('Failed to load invoices:', err);
  }
}

// ==========================================
// 6. EVENT BINDINGS
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  renderLineItems();
  await fetchBaseData();
  await fetchProducts();
  await loadRecentInvoices();

  // PROGRESSIVE LIVE SEARCH
  let selectedLiveSearchId = null;
  const searchInputEl = document.getElementById('global-search-add');
  const searchResultsEl = document.getElementById('live-search-results');

  if (searchInputEl && searchResultsEl) {
    searchInputEl.addEventListener('input', (e) => {
      const searchVal = e.target.value.trim();
      selectedLiveSearchId = null;

      if (!searchVal) {
        searchResultsEl.style.display = 'none';
        return;
      }

      const stockFilter = document.getElementById('sales-stock-only')?.value || 'in_stock';
      const compFilter = document.getElementById('sales-company-filter')?.value || '';
      const catFilter = document.getElementById('sales-category-filter')?.value || '';

      const matches = salesProducts
        .map(p => ({ ...p, _score: productSearchScore(p, searchVal) }))
        .filter(p => {
          if (p._score === 0) return false;
          if (stockFilter === 'in_stock' && Number(p.current_stock) <= 0) return false;
          if (compFilter && String(p.company).toLowerCase() !== String(compFilter).toLowerCase()) return false;
          if (catFilter && String(p.category_id) !== String(catFilter)) return false;
          return true;
        })
        .sort((a, b) => b._score - a._score)
        .slice(0, 10);

      if (matches.length === 0) {
        searchResultsEl.innerHTML = `<div style="padding: 12px 16px; color: var(--muted);">No models match '${escapeHtml(searchVal)}' with current filters.</div>`;
      } else {
        searchResultsEl.innerHTML = matches.map(p => `
          <div class="live-search-item" data-id="${p.id}" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'" style="padding: 12px 16px; border-bottom: 1px solid var(--line); cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.1s;">
            <div>
              <div style="font-weight: 800; color: var(--blue-dark); font-size: 0.98rem;">
                <span style="background:#dbeafe; color:#1e40af; padding:2px 7px; border-radius:5px; font-size:0.74rem; margin-right:6px;">${escapeHtml(p.category_name || 'Appliance')}</span>
                ${escapeHtml(p.company)} ${escapeHtml(p.model)}
              </div>
              <div style="font-size: 0.82rem; color: var(--muted); display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px;">
                <span>${escapeHtml(p.series || '')}</span>
                <span class="badge" style="padding:2px 8px; font-size:0.75rem; background:#f1f5f9; color:#334155; border:1px solid #cbd5e1;">Color: ${escapeHtml(p.color || 'Standard')}</span>
                <span class="badge info" style="padding:2px 8px; font-size:0.75rem;">Location: ${escapeHtml(p.location_name || 'Warehouse')}</span>
              </div>
            </div>
            <div style="text-align: right;">
              <span class="badge ${Number(p.current_stock) > 0 ? 'success' : 'danger'}">${Number(p.current_stock) > 0 ? `${p.current_stock} in stock` : 'Out of stock'}</span>
              <div style="margin-top: 6px; font-size: 0.9rem; display: flex; flex-direction: column; gap: 2px;">
                <span style="color: var(--muted); font-size: 0.8rem;">Pur: Rs ${p.default_purchase_price || 0}</span>
                <strong style="color: var(--blue-dark);">Sale: Rs ${p.default_sale_price || 0}</strong>
              </div>
            </div>
          </div>
        `).join('');
      }
      searchResultsEl.style.display = 'block';
    });

    searchResultsEl.addEventListener('click', (e) => {
      const itemEl = e.target.closest('.live-search-item');
      if (itemEl) {
        selectedLiveSearchId = itemEl.dataset.id;
        const p = salesProducts.find(x => String(x.id) === String(selectedLiveSearchId));
        if (p) {
          searchInputEl.value = `${p.category_name ? p.category_name + ' - ' : ''}${p.company} ${p.model} (${p.color || 'Standard'})`;
        }
        searchResultsEl.style.display = 'none';
      }
    });

    document.addEventListener('click', (e) => {
      if (!searchInputEl.contains(e.target) && !searchResultsEl.contains(e.target)) {
        searchResultsEl.style.display = 'none';
      }
    });
  }

  document.getElementById('btn-search-add')?.addEventListener('click', () => {
    if (!selectedLiveSearchId) {
      const searchVal = document.getElementById('global-search-add').value.trim();
      if (!searchVal) {
        UI.toast('Please search and select a model first.', 'warning');
        return;
      }
      const stockFilter = document.getElementById('sales-stock-only')?.value || 'in_stock';
      const compFilter = document.getElementById('sales-company-filter')?.value || '';
      const catFilter = document.getElementById('sales-category-filter')?.value || '';

      const fallbackMatch = salesProducts
        .map(p => ({ ...p, _score: productSearchScore(p, searchVal) }))
        .filter(p => {
          if (p._score === 0) return false;
          if (stockFilter === 'in_stock' && Number(p.current_stock) <= 0) return false;
          if (compFilter && String(p.company).toLowerCase() !== String(compFilter).toLowerCase()) return false;
          if (catFilter && String(p.category_id) !== String(catFilter)) return false;
          return true;
        })
        .sort((a, b) => b._score - a._score)[0];

      if (fallbackMatch) {
        selectedLiveSearchId = fallbackMatch.id;
      } else {
        UI.toast('No matching product found with current filters.', 'error');
        return;
      }
    }

    const bestMatch = salesProducts.find(p => String(p.id) === String(selectedLiveSearchId));
    if (bestMatch) {
      let targetRow = salesState.lineItems.find(i => !i.productId);
      if (!targetRow) {
        targetRow = { id: Date.now(), productId: '', qty: 1, unitPrice: 0, available: 0 };
        salesState.lineItems.push(targetRow);
      }

      targetRow.productId = bestMatch.id;
      targetRow.unitPrice = bestMatch.default_sale_price || 0;
      targetRow.available = bestMatch.current_stock || 0;
      targetRow.qty = 1;

      if (searchInputEl) searchInputEl.value = '';
      selectedLiveSearchId = null;
      if (searchResultsEl) searchResultsEl.style.display = 'none';

      renderLineItems();
      UI.toast(`${bestMatch.category_name || ''} ${bestMatch.model} added to invoice.`, 'success');
    }
  });

  // Dropdown Filters
  document.getElementById('sales-product-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    hydrateModelFilter();
    hydrateLineItemSelects();
  });

  ['sales-company-filter', 'sales-category-filter', 'sales-stock-only'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      if (id === 'sales-company-filter') salesState.filters.company = e.target.value;
      if (id === 'sales-category-filter') salesState.filters.categoryId = e.target.value;
      if (id === 'sales-stock-only') salesState.filters.stockOnly = e.target.value;
      document.getElementById('sales-model-filter').value = '';
      salesState.filters.model = '';
      hydrateModelFilter();
      hydrateLineItemSelects();
    });
  });

  document.getElementById('sales-model-filter')?.addEventListener('change', (e) => {
    salesState.filters.model = e.target.value;
    hydrateLineItemSelects();
  });

  // Discount Controls
  document.getElementById('discount-enabled')?.addEventListener('change', () => {
    syncDiscountInputs();
    calculateInvoiceTotals();
  });
  document.getElementById('discount-type')?.addEventListener('change', calculateInvoiceTotals);
  document.getElementById('discount-value')?.addEventListener('input', calculateInvoiceTotals);
  document.getElementById('discount-rule-select')?.addEventListener('change', (e) => {
    if (e.target.value) applyDiscountRule(e.target.value);
    else {
      document.getElementById('discount-name').value = '';
      calculateInvoiceTotals();
    }
  });

  document.getElementById('discount-new-rule')?.addEventListener('click', () => openDiscountRuleModal());

  document.getElementById('discount-rule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('discount-rule-name').value.trim(),
      discount_type: document.getElementById('discount-rule-type').value,
      discount_value: Number(document.getElementById('discount-rule-value').value || 0),
      description: document.getElementById('discount-rule-description').value.trim(),
      active: document.getElementById('discount-rule-active').checked ? 1 : 0
    };
    const ruleId = document.getElementById('discount-rule-id').value;
    try {
      await (ruleId ? API.put(`/api/discount-rules/${ruleId}`, payload) : API.post('/api/discount-rules', payload));
      UI.closeModal('discount-rule-modal');
      await refreshDiscountRules();
      UI.toast(ruleId ? 'Discount updated.' : 'Discount created.', 'success');
    } catch (err) {
      UI.showMessage(document.getElementById('discount-rule-form-message'), err.message);
    }
  });

  document.getElementById('discount-rule-list')?.addEventListener('click', async (e) => {
    const applyBtn = e.target.closest('[data-apply-discount-rule]');
    if (applyBtn) {
      applyDiscountRule(applyBtn.dataset.applyDiscountRule);
      UI.toast('Discount applied to invoice.', 'info');
      return;
    }
    const editBtn = e.target.closest('[data-edit-discount-rule]');
    if (editBtn) {
      const rule = salesState.discountRules.find(r => String(r.id) === String(editBtn.dataset.editDiscountRule));
      if (rule) openDiscountRuleModal(rule);
      return;
    }
    const deleteBtn = e.target.closest('[data-delete-discount-rule]');
    if (deleteBtn) {
      const id = deleteBtn.dataset.deleteDiscountRule;
      if (!confirm('Are you sure you want to permanently delete this discount preset?')) return;
      try {
        await API.delete(`/api/discount-rules/${id}`);
        await refreshDiscountRules();
        UI.toast('Discount deleted successfully.', 'success');
      } catch (err) {
        alert(err.message);
      }
    }
  });

  // Row Controls
  document.getElementById('invoice-items')?.addEventListener('click', (e) => {
    const clearBtn = e.target.closest('.btn-clear-row');
    if (clearBtn) {
      const row = clearBtn.closest('.line-item-row');
      if (row) clearLineItem(row);
      return;
    }

    const removeBtn = e.target.closest('.btn-remove-row');
    if (removeBtn) {
      const row = removeBtn.closest('.line-item-row');
      if (row) {
        salesState.lineItems = salesState.lineItems.filter(i => i.id !== Number(row.dataset.id));
        renderLineItems();
      }
      return;
    }

    const stepButton = e.target.closest('[data-step-qty]');
    if (stepButton) {
      const row = stepButton.closest('.line-item-row');
      const input = row?.querySelector('[data-item-field="quantity"]');
      if (input && !input.disabled) {
        const next = Math.max(1, Number(input.value || 1) + Number(stepButton.dataset.stepQty || 0));
        input.value = next;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });

  document.body.addEventListener('click', (e) => {
    const addBtn = e.target.closest('#add-blank-row, #add-line-item');
    if (addBtn) {
      salesState.lineItems.push({ id: Date.now(), productId: '', qty: 1, unitPrice: 0, available: 0 });
      renderLineItems();
    }
  });

  // History Mode Controls (Buttons + Clickable Top KPI Cards)
  document.getElementById('btn-today-sales')?.addEventListener('click', async () => {
    salesHistoryMode = 'today';
    await loadRecentInvoices();
  });
  document.getElementById('btn-week-sales')?.addEventListener('click', async () => {
    salesHistoryMode = 'week';
    await loadRecentInvoices();
  });
  document.getElementById('btn-month-sales')?.addEventListener('click', async () => {
    salesHistoryMode = 'month';
    await loadRecentInvoices();
  });
  document.getElementById('btn-show-all-sales')?.addEventListener('click', async () => {
    salesHistoryMode = 'all';
    await loadRecentInvoices();
  });
  document.querySelectorAll('[data-kpi-period]').forEach(card => {
    card.addEventListener('click', async () => {
      salesHistoryMode = card.getAttribute('data-kpi-period') || 'today';
      await loadRecentInvoices();
    });
  });
  document.getElementById('btn-refresh-history')?.addEventListener('click', async () => {
    API.clearCache();
    await loadRecentInvoices();
  });
  document.getElementById('invoice-filter-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    salesHistoryMode = 'custom';
    await loadRecentInvoices();
  });

  // Saved Invoices List Delegation (View, WhatsApp, Delete/Reverse)
  document.getElementById('invoice-list')?.addEventListener('click', async (e) => {
    const viewBtn = e.target.closest('.btn-view-inv');
    if (viewBtn) {
      await openInvoiceDetailModal(viewBtn.dataset.id);
      return;
    }

    const waBtn = e.target.closest('.btn-wa-inv');
    if (waBtn) {
      try {
        const fullInv = await API.get(`/api/invoices/${waBtn.dataset.id}`);
        shareInvoiceOnWhatsApp(fullInv);
      } catch (err) {
        UI.toast('Failed to load invoice for WhatsApp sharing.', 'error');
      }
      return;
    }

    const revBtn = e.target.closest('.btn-trigger-reverse');
    if (revBtn) {
      openReverseSaleModal(revBtn.dataset.id);
    }
  });

  // Modal Close Delegation
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      UI.closeModal(closeBtn.dataset.closeModal);
    }
  });

  // Confirm Sale Submission
  document.getElementById('invoice-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const validItems = salesState.lineItems.filter(i => i.productId && Number(i.qty) > 0);
    if (!validItems.length) {
      UI.toast('Please search and select at least one valid product from stock.', 'error');
      return;
    }

    for (const item of validItems) {
      const p = salesProducts.find(x => String(x.id) === String(item.productId));
      const avail = Number(p?.current_stock ?? 0);
      if (avail > 0 && Number(item.qty) > avail) {
        UI.toast(`Cannot sell ${item.qty} units of ${p.model}. Only ${avail} in stock.`, 'error');
        return;
      }
    }

    const discountEnabled = document.getElementById('discount-enabled')?.checked;
    const discountType = document.getElementById('discount-type')?.value || 'fixed';
    const discountVal = Number(document.getElementById('discount-value')?.value || 0);
    const discountName = document.getElementById('discount-name')?.value.trim() || 'Discount';

    const txInput = document.getElementById('invoice-transaction-at').value;
    const localNow = new Date();
    const fallbackIso = new Date(localNow.getTime() - localNow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const finalTxAt = txInput || fallbackIso;
    const dateOnly = finalTxAt.slice(0, 10);

    const payload = {
      customer_name: document.getElementById('invoice-customer-name').value.trim() || 'Walk-in Customer',
      phone_number: document.getElementById('invoice-phone').value.trim(),
      status: document.getElementById('invoice-status')?.value || 'Paid',
      invoice_date: dateOnly,
      sale_date: dateOnly,
      transaction_at: finalTxAt,
      notes: document.getElementById('invoice-notes').value.trim(),
      address: document.getElementById('invoice-address').value.trim(),
      apply_discount: Boolean(discountEnabled && discountVal > 0),
      discount_name: discountName,
      discount_type: discountType,
      discount_value: discountVal,
      generate_pdf: false,
      ignore_duplicate: false,
      items: validItems.map(i => ({
        product_id: Number(i.productId),
        quantity: Number(i.qty),
        unit_price: Number(i.unitPrice)
      }))
    };

    const submitBtn = document.getElementById('btn-confirm-sale') || e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing Sale...';

    try {
      const res = await API.post('/api/invoices', payload);
      const createdId = res?.invoice?.id || res?.id;

      // Reset form for next customer
      document.getElementById('invoice-customer-name').value = '';
      document.getElementById('invoice-phone').value = '';
      document.getElementById('invoice-address').value = '';
      document.getElementById('invoice-notes').value = '';
      const discBox = document.getElementById('discount-enabled');
      if (discBox) discBox.checked = false;
      document.getElementById('discount-value').value = 0;

      salesState.lineItems = [{ id: Date.now(), productId: '', qty: 1, unitPrice: 0, available: 0 }];
      await fetchProducts();
      renderLineItems();
      await loadRecentInvoices();

      UI.toast('Sale confirmed and invoice generated!', 'success');

      if (createdId) {
        await openInvoiceDetailModal(createdId);
      }
    } catch (err) {
      UI.toast(err.message || 'Failed to create invoice.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  // Biometric Reverse Trigger (Connected with shared.js Biometric Auth)
  document.getElementById('btn-biometric-reverse-sale')?.addEventListener('click', async () => {
    const invId = document.getElementById('security-reverse-invoice-id')?.value;
    const errEl = document.getElementById('security-reverse-error');
    if (!invId) return;
    if (errEl) errEl.textContent = '';

    try {
      if (typeof UI !== 'undefined' && typeof UI.authenticateBiometric === 'function') {
        const bioResult = await UI.authenticateBiometric('reverse_sale');
        if (bioResult?.verified) {
          await API.post(`/api/invoices/${invId}/reverse`, {
            security_code: bioResult.verification_token || 'Alyas51214',
            biometric_verified: true
          });
          UI.closeModal('security-reverse-modal');
          UI.toast('Sale reversed and stock restored via Biometrics.', 'success');
          await fetchProducts();
          renderLineItems();
          await loadRecentInvoices();
          return;
        }
      }
      if (errEl) errEl.textContent = 'Biometric verification unavailable on this device. Please enter the verification password below.';
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Biometric verification failed. Use password below.';
    }
  });

  // Password Reverse Sale Submission
  document.getElementById('security-reverse-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const invId = document.getElementById('security-reverse-invoice-id')?.value;
    const code = document.getElementById('security-reverse-code')?.value.trim();
    const errEl = document.getElementById('security-reverse-error');
    const submitBtn = document.getElementById('btn-submit-reverse');

    if (!code) {
      if (errEl) errEl.textContent = 'Please enter the verification password.';
      return;
    }

    if (errEl) errEl.textContent = '';
    if (submitBtn) submitBtn.disabled = true;

    try {
      await API.post(`/api/invoices/${invId}/reverse`, { security_code: code });
      UI.closeModal('security-reverse-modal');
      UI.toast('Sale reversed and stock restored.', 'success');
      await fetchProducts();
      renderLineItems();
      await loadRecentInvoices();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Invalid verification password.';
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
});