const categoryState = {
  categoryId: Number(location.pathname.split('/').pop()),
  detail: null,
  locations: [],
  company: getQueryParam('company') || '',
  series: '',
  stockStatus: 'all',
  search: '',
  listHidden: false,
  activeMasterModel: null,
  editingVariant: null,
  manageKey: getQueryParam('manage_key') || '',
  companyOptions: [],
};

function categoryQuery() {
  return buildQuery({
    company: categoryState.company || undefined,
    series: categoryState.series || undefined,
    stock_status: categoryState.stockStatus,
    search: categoryState.search || undefined,
  });
}

function salesLink(categoryId, company, productId = '') {
  return `/sales?${buildQuery({ category_id: categoryId, company: company || undefined, product_id: productId || undefined })}`;
}

function currentMasterModels() {
  return categoryState.detail?.master_models || [];
}

function findMasterModelByKey(key) {
  return currentMasterModels().find(item => String(item.key) === String(key));
}

function updateCategoryUrl() {
  history.replaceState({}, '', `/category/${categoryState.categoryId}?${buildQuery({
    company: categoryState.company || undefined,
    series: categoryState.series || undefined,
    stock_status: categoryState.stockStatus || undefined,
    search: categoryState.search || undefined,
    manage_key: categoryState.manageKey || undefined,
  })}`);
}

function renderSummary() {
  const detail = categoryState.detail;
  if (!detail) return;
  
  const pageTitleElem = document.getElementById('category-page-title');
  const heroTitleElem = document.getElementById('category-hero-title');
  const pageSubElem = document.getElementById('category-page-subtitle');
  const salesLinkElem = document.getElementById('category-sales-link');

  if (pageTitleElem) pageTitleElem.textContent = detail.page_title || 'Category';
  if (heroTitleElem) heroTitleElem.textContent = detail.page_title || 'Category';
  if (pageSubElem) pageSubElem.textContent = `Professional stock control for ${detail.page_title || 'Category'}. Available units stay updated across locations and branches.`;
  if (salesLinkElem) salesLinkElem.href = salesLink(detail.category.id, categoryState.company);

  const heroMedia = document.getElementById('category-hero-media');
  if (heroMedia && detail.category) {
    heroMedia.innerHTML = categoryVisualHTML(detail.category);
    if (typeof hydrateCategoryVisuals === 'function') hydrateCategoryVisuals(heroMedia);
  }

  const summaryWrap = document.getElementById('category-summary');
  if (summaryWrap) {
    const cards = [
      ['Total Models', detail.summary?.master_models || 0, false],
      ['In Stock', detail.summary?.in_stock_models || 0, false],
      ['Out of Stock', detail.summary?.out_of_stock_models || 0, false],
      ['Total Items', detail.summary?.available_units || 0, false],
      ['Purchase Total', detail.summary?.purchase_value || 0, true],
      ['Sales Total', detail.summary?.sales_value || 0, true],
      ['Stock Value', detail.summary?.stock_value || 0, true],
    ];

    summaryWrap.innerHTML = cards.map(([label, value, money]) => `
      <div class="kpi-box price-safe-box">
        <div class="label">${label}</div>
        <div class="value ${money ? 'currency' : ''}">${money ? UI.currencyHTML(value) : value}</div>
      </div>
    `).join('');
  }

  const breakdownWrap = document.getElementById('category-breakdown');
  if (breakdownWrap) {
    breakdownWrap.innerHTML = `
      <div class="summary-pill">Companies: <strong>${(detail.company_sections || []).length}</strong></div>
      <div class="summary-pill">Colors tracked: <strong>${(detail.colors || []).length}</strong></div>
      <div class="summary-pill">Locations tracked: <strong>${(detail.locations || []).length}</strong></div>
      <div class="summary-pill price-safe-box">Amount: <strong>${UI.currencyHTML(detail.summary?.stock_value || 0)}</strong></div>
    `;
  }
  if (typeof UI !== 'undefined' && typeof UI.applyPricePrivacy === 'function') {
    UI.applyPricePrivacy();
  }
}

function populateFilters() {
  const detail = categoryState.detail;
  const companySelect = document.getElementById('category-company-filter');
  const seriesSelect = document.getElementById('category-series-filter');
  const availableCompanies = (detail?.company_options && detail.company_options.length ? detail.company_options : (categoryState.companyOptions || [])).slice();

  if (companySelect) {
    UI.populateSelect(companySelect, availableCompanies.map(name => ({ id: name, name })), { includeAll: true, allLabel: 'All companies', valueKey: 'id' });
    companySelect.value = categoryState.company || '';
  }
  if (seriesSelect) {
    UI.populateSelect(seriesSelect, (detail?.series_options || []).map(name => ({ id: name, name })), { includeAll: true, allLabel: 'All series', valueKey: 'id' });
    seriesSelect.value = categoryState.series || '';
  }

  const stockFilter = document.getElementById('category-stock-filter');
  if (stockFilter) stockFilter.value = categoryState.stockStatus;

  const searchInput = document.getElementById('category-search-input');
  if (searchInput) searchInput.value = categoryState.search;
}

function renderColorLocationHierarchy(model) {
  const colorList = model.color_locations || [];
  if (!colorList.length) {
    if (model.colors && model.colors.length) {
      return model.colors.map(c => '<span class="feature-pill"><strong>' + escapeHtml(c.name || 'Standard') + ':</strong> <em>' + (c.units ?? 0) + ' units</em></span>').join('');
    }
    return '<span class="muted" style="font-size:0.84rem;">No physical stock entered yet</span>';
  }

  return colorList.map(c => {
    const locBadges = (c.locations || []).map(loc => `
      <span class="exec-loc-badge">
        <span>${escapeHtml(loc.location_name)}:</span>
        <strong>${loc.units} units</strong>
      </span>
    `).join('');

    return `
      <div class="exec-color-row">
        <div class="exec-color-left">
          <span class="exec-color-title">Color: ${escapeHtml(c.color)}</span>
          <span class="exec-color-subtotal">${c.total_units} Units Total</span>
        </div>
        <div class="exec-loc-badges">
          ${locBadges}
        </div>
      </div>
    `;
  }).join('');
}
function existingVariantList(master) {
  const related = (master.variants || []);
  if (!related.length) return '<div class="empty-state">No stock variant exists yet for this master model. Use the form below to create your first stock entry.</div>';

  const colorGroups = new Map();
  related.forEach(v => {
    const col = v.color || 'Standard';
    if (!colorGroups.has(col)) colorGroups.set(col, []);
    colorGroups.get(col).push(v);
  });

  return Array.from(colorGroups.entries()).map(([colorName, variants]) => {
    const totalColorUnits = variants.reduce((sum, v) => sum + Number(v.remaining_units || 0), 0);
    const variantCards = variants.map(variant => {
      const isOut = Number(variant.remaining_units || 0) <= 0;
      const moveBtn = Number(variant.remaining_units || 0) > 0 
        ? '<button class="btn small" type="button" data-transfer-variant="' + variant.id + '">Move Location</button>' 
        : '';
      const branchBtn = Number(variant.remaining_units || 0) > 0 
        ? '<button class="btn-dark small" type="button" data-branch-transfer-variant="' + variant.id + '">Transfer to Branch</button>' 
        : '';
      const sizeTag = variant.size ? ' (' + escapeHtml(variant.size) + ')' : '';
      return `
        <article class="mini-stock-card ${isOut ? 'out-stock-card' : ''}" style="margin:0; background:#fff; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px;">
          <div class="record-top">
            <div>
              <h4 class="record-title" style="font-size:0.88rem; font-weight:700;">Location: <strong>${escapeHtml(variant.location_name || 'Unassigned')}</strong>${sizeTag}</h4>
              <div class="record-meta"><span style="font-weight:750; color:var(--blue-dark);">${variant.remaining_units} in this location</span><span>${variant.sold_units || 0} sold</span></div>
            </div>
            <div class="inline-actions" style="display:flex; gap:6px; flex-wrap:wrap;">
              ${moveBtn}
              ${branchBtn}
              <button class="btn-ghost small" type="button" data-edit-variant="${variant.id}">Edit / Add Stock</button>
              <button class="btn-danger small" type="button" data-delete-variant="${variant.id}" data-delete-name="${escapeHtml(variant.color || 'Standard')} (${escapeHtml(variant.location_name || '')})">Delete</button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    return `
      <div class="color-stock-group" style="margin-bottom: 14px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
          <strong style="font-size:0.95rem; color:var(--text);">Color: <span style="color:var(--blue-dark);">${escapeHtml(colorName)}</span></strong>
          <span class="badge ${totalColorUnits > 0 ? 'success' : 'danger'}">Total ${escapeHtml(colorName)}: ${totalColorUnits} units</span>
        </div>
        <div style="display:grid; gap:8px;">
          ${variantCards}
        </div>
      </div>
    `;
  }).join('');
}

function salesButtonForModel(detail, section, model) {
  if (Number(model?.total_stock || 0) <= 0) {
    return '<button class="btn-ghost small disabled-sale-trigger" type="button" data-no-stock="' + escapeHtml(model?.display_name || model?.model || 'Model') + '">No Available Stock</button>';
  }
  const saleVariant = (model?.variants || []).find(variant => Number(variant.remaining_units || 0) > 0) || (model?.variants || [])[0];
  return '<a class="btn-ghost small" href="' + salesLink(detail.category.id, section.company, saleVariant?.id || '') + '">Sales</a>';
}

function renderCompanySections() {
  const wrap = document.getElementById('category-company-sections');
  if (!wrap) return;

  const toggleListBtn = document.getElementById('toggle-category-list');

  if (categoryState.listHidden) {
    wrap.innerHTML = '<div class="empty-state">Model list is hidden. Press Show list to display it again.</div>';
    if (toggleListBtn) toggleListBtn.textContent = 'Show list';
    return;
  }
  if (toggleListBtn) toggleListBtn.textContent = 'Hide list';

  const detail = categoryState.detail;
  if (!detail?.company_sections?.length) {
    wrap.innerHTML = '<div class="empty-state">No model matched the current filter. Click "Create master model" to add one.</div>';
    return;
  }

  wrap.innerHTML = detail.company_sections.map(section => {
    const seriesBlocks = (section.series_sections || []).map(seriesSection => {
      const modelCards = seriesSection.models.map(model => {
        const sizeTag = model.size ? '<span>' + escapeHtml(model.size) + '</span>' : '';
        const deleteMasterBtn = Number(model.total_stock || 0) <= 0 
          ? '<button class="btn-danger small" type="button" data-delete-master="' + model.key + '" style="margin-top: 10px; width: 100%;">Delete Master Model</button>' 
          : '';
        const visualData = model.image_path ? { image_path: model.image_path, name: detail.category?.name, icon: detail.category?.icon } : detail.category;
        const colorCount = (model.colors || []).length;
        const locationCount = (model.locations || []).length;

        return `
          <article class="model-browser-card ${model.stock_status}">
            <div class="model-browser-head">
              <div class="model-brand-row">
                ${categoryVisualHTML(visualData)}
                <div>
                  <h3 class="record-title" style="font-size: 1.08rem; font-weight: 900; color: #0f172a;">${escapeHtml(model.model || model.display_name)}</h3>
                  <div class="record-meta"><span>${escapeHtml(model.company)}</span><span>${escapeHtml(model.series || 'Standard')}</span>${sizeTag}</div>
                </div>
              </div>
              <span class="badge ${model.total_stock > 0 ? 'success' : 'danger'}" style="font-size: 0.82rem; padding: 5px 12px;">
                ${model.total_stock > 0 ? `${model.total_stock} in stock` : 'Out of stock'}
              </span>
            </div>

            <!-- EXECUTIVE METRIC ROW (Crystal Clear Labels) -->
            <div class="executive-metric-grid">
              <div class="exec-metric-card">
                <span class="exec-metric-label">Colors</span>
                <span class="exec-metric-val">${colorCount} Color${colorCount === 1 ? '' : 's'}</span>
              </div>
              <div class="exec-metric-card">
                <span class="exec-metric-label">Places</span>
                <span class="exec-metric-val">${locationCount} Place${locationCount === 1 ? '' : 's'}</span>
              </div>
              <div class="exec-metric-card price-safe-box">
                <span class="exec-metric-label">Stock Value</span>
                <span class="exec-metric-val currency-inline" style="color: #1d4ed8;">${UI.currencyHTML(model.stock_value)}</span>
              </div>
            </div>

            <!-- STRUCTURED COLOR & LOCATION BREAKDOWN -->
            <div class="exec-breakdown-box">
              <div class="exec-breakdown-heading">Stock by Color &amp; Place</div>
              ${renderColorLocationHierarchy(model)}
            </div>

            <!-- ENERGETIC ACTION BUTTONS -->
            <div class="category-card-actions">
              <button class="btn-cat-manage" type="button" data-manage-model="${model.key}">Manage Stock</button>
              ${Number(model.total_stock || 0) > 0 ? `<a class="btn-cat-sales" href="${salesLink(detail.category.id, section.company, (model.variants?.[0]?.id || ''))}">Sales &amp; Invoice</a>` : '<button class="btn-ghost small disabled-sale-trigger" type="button" style="flex:1;">No Stock</button>'}
            </div>
            ${deleteMasterBtn}
          </article>
        `;
      }).join('');

      return `
        <div class="series-group-block">
          <div class="series-group-head">
            <div>
              <h4 class="series-group-title">${escapeHtml(seriesSection.series || 'Unspecified Series')}</h4>
              <div class="record-meta"><span>${seriesSection.model_count} models</span><span>${seriesSection.in_stock_count} in stock</span><span>${seriesSection.out_of_stock_count} out of stock</span><span>${seriesSection.available_units} units</span></div>
            </div>
            <div class="price-safe-box section-banner-amount">${UI.currencyHTML(seriesSection.stock_value)}</div>
          </div>
          <div class="model-grid wide-grid">
            ${modelCards}
          </div>
        </div>
      `;
    }).join('');

    return `
      <section class="company-model-section">
        <div class="section-banner">
          <div class="model-brand-row">
            ${companyLogoHTML(section.company, 'medium', section.image_path)}
            <div>
              <h3 class="section-title">${section.title}</h3>
              <div class="record-meta"><span>${section.in_stock_count} in stock</span><span>${section.out_of_stock_count} out of stock</span><span>${section.available_units} units</span></div>
            </div>
          </div>
          <div class="price-safe-box section-banner-amount">${UI.currencyHTML(section.stock_value)}</div>
        </div>
        ${seriesBlocks}
      </section>
    `;
  }).join('');

  if (typeof hydrateCompanyLogos === 'function') hydrateCompanyLogos(wrap);
  if (typeof hydrateCategoryVisuals === 'function') hydrateCategoryVisuals(wrap);
  if (typeof UI !== 'undefined' && typeof UI.applyPricePrivacy === 'function') UI.applyPricePrivacy();
}

async function refreshCategoryPage() {
  try {
    const [detail, locations, meta] = await Promise.all([
      API.get(`/api/categories/${categoryState.categoryId}/detail?${categoryQuery()}`),
      API.get('/api/locations'),
      API.get('/api/meta'),
    ]);
    categoryState.detail = detail;
    categoryState.locations = locations;
    categoryState.companyOptions = meta.company_options || [];

    renderSummary();
    populateFilters();
    renderCompanySections();
    
    const locSelect = document.getElementById('stock-location');
    if (locSelect) {
      UI.populateSelect(locSelect, locations, { includeAll: true, allLabel: 'Select location' });
    }

    if (categoryState.manageKey) {
      const targetMaster = findMasterModelByKey(categoryState.manageKey);
      if (targetMaster) {
        openStockModal(targetMaster);
        categoryState.manageKey = '';
        updateCategoryUrl();
      }
    }
  } catch (err) {
    console.error("Error refreshing category page:", err);
  }
}

function openMasterModelModal() {
  document.getElementById('master-model-form')?.reset();
  const masterCompany = document.getElementById('master-company');
  if (masterCompany) {
    let options = categoryState.companyOptions || [];
    if (!options.length) options = ['Dawlance', 'Haier'];
    masterCompany.innerHTML = options.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    masterCompany.value = categoryState.company || options[0];
  }
  UI.openModal('master-model-modal');
}

function openStockModal(master) {
  categoryState.activeMasterModel = master;
  categoryState.editingVariant = null;
  document.getElementById('stock-form')?.reset();
  document.getElementById('stock-product-id').value = '';
  
  const titleElem = document.getElementById('stock-modal-title');
  if (titleElem) titleElem.textContent = `Manage stock: ${master.display_name}`;
  
  const summaryElem = document.getElementById('stock-modal-summary');
  if (summaryElem) {
    summaryElem.innerHTML = `Company: <strong>${master.company}</strong> | Current stock: <strong>${master.total_stock}</strong> | Colors: <strong>${(master.colors || []).length}</strong> | Locations: <strong>${(master.locations || []).length}</strong>`;
  }
  
  const variantsElem = document.getElementById('stock-existing-variants');
  if (variantsElem) variantsElem.innerHTML = existingVariantList(master);
  
  const modelDisplay = document.getElementById('stock-model-display');
  if (modelDisplay) modelDisplay.value = master.display_name;
  
  const stockComp = document.getElementById('stock-company');
  if (stockComp) stockComp.value = master.company;
  
  const stockSeries = document.getElementById('stock-series');
  if (stockSeries) stockSeries.value = master.series || '';
  
  const stockModelName = document.getElementById('stock-model-name');
  if (stockModelName) stockModelName.value = master.model;
  
  const stockSize = document.getElementById('stock-size');
  if (stockSize) stockSize.value = master.size || '';
  
  const stockPurchase = document.getElementById('stock-purchase');
  if (stockPurchase) stockPurchase.value = master.default_price || 0;
  
  const stockSale = document.getElementById('stock-sale');
  if (stockSale) stockSale.value = master.default_price || 0;
  
  const stockQty = document.getElementById('stock-opening-quantity');
  if (stockQty) stockQty.value = 0;
  
  const stockMin = document.getElementById('stock-min');
  if (stockMin) stockMin.value = 0;

  UI.openModal('stock-modal');
}

function fillVariantForEdit(variant) {
  categoryState.editingVariant = variant;
  document.getElementById('stock-product-id').value = variant.id;
  document.getElementById('stock-series').value = variant.series || '';
  document.getElementById('stock-model-name').value = variant.model || '';
  document.getElementById('stock-size').value = variant.size || '';
  document.getElementById('stock-location').value = variant.location_id || '';
  document.getElementById('stock-color').value = variant.color || '';
  document.getElementById('stock-min').value = variant.min_stock || 0;
  document.getElementById('stock-purchase').value = variant.default_purchase_price || variant.last_purchase_price || 0;
  document.getElementById('stock-sale').value = variant.default_sale_price || 0;
  document.getElementById('stock-opening-quantity').value = 0;
  document.getElementById('stock-notes').value = variant.notes || '';
  
  const summaryElem = document.getElementById('stock-modal-summary');
  if (summaryElem) {
    summaryElem.innerHTML = `
      Editing: <strong>${escapeHtml(variant.color || 'Standard')}</strong> at <strong>${escapeHtml(variant.location_name || 'Warehouse')}</strong>.<br>
      Current in stock: <strong>${variant.remaining_units || 0} units</strong>. You can update purchase price, change location/color, or enter quantity in <em>Add New Purchased Quantity</em> below to add new machines to this stock.
    `;
  }
  document.getElementById('stock-opening-quantity')?.focus();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  await refreshCategoryPage();

  const allButtons = Array.from(document.querySelectorAll('button, .btn, .btn-accent, .btn-dark'));

  const createMasterBtn = document.getElementById('add-master-model-btn') || 
                          allButtons.find(b => b.textContent.trim().toLowerCase().includes('create master model'));
  if (createMasterBtn) {
    createMasterBtn.addEventListener('click', openMasterModelModal);
  }

  const manageStockBtn = document.getElementById('manage-stock-btn') || 
                         allButtons.find(b => b.textContent.trim().toLowerCase() === 'manage stock' && !b.closest('.inline-actions'));
  if (manageStockBtn) {
    manageStockBtn.addEventListener('click', () => {
      const first = currentMasterModels()[0];
      if (!first) {
        alert('No models exist in this category yet. Click "Create Master Model" to add one first.');
        return;
      }
      openStockModal(first);
    });
  }

  document.getElementById('btn-add-variant-toggle')?.addEventListener('click', () => {
    document.getElementById('stock-form')?.reset();
    document.getElementById('stock-product-id').value = '';
    const master = categoryState.activeMasterModel;
    if (master) {
      document.getElementById('stock-model-display').value = master.display_name;
      document.getElementById('stock-company').value = master.company;
      document.getElementById('stock-series').value = master.series || '';
      document.getElementById('stock-model-name').value = master.model;
      document.getElementById('stock-purchase').value = master.default_price || 0;
      document.getElementById('stock-sale').value = master.default_price || 0;
      document.getElementById('stock-modal-summary').innerHTML = `Creating a new color or location variant for <strong>${master.display_name}</strong>.`;
    }
  });

  document.getElementById('toggle-category-list')?.addEventListener('click', () => {
    categoryState.listHidden = !categoryState.listHidden;
    renderCompanySections();
  });

  document.getElementById('category-filter-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    categoryState.company = document.getElementById('category-company-filter').value;
    categoryState.series = document.getElementById('category-series-filter').value;
    categoryState.stockStatus = document.getElementById('category-stock-filter').value;
    categoryState.search = document.getElementById('category-search-input').value.trim();
    categoryState.manageKey = '';
    updateCategoryUrl();
    await refreshCategoryPage();
  });

  document.getElementById('master-model-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await API.post('/api/catalog/models', {
        category_name: categoryState.detail.category.name,
        company: document.getElementById('master-company').value,
        series: document.getElementById('master-series').value.trim(),
        model: document.getElementById('master-model').value.trim(),
        default_price: Number(document.getElementById('master-price').value || 0),
      });
      UI.closeModal('master-model-modal');
      categoryState.company = document.getElementById('master-company').value;
      updateCategoryUrl();
      await refreshCategoryPage();
      UI.toast('Master model created successfully.', 'success');
    } catch (e) {
      alert(e.message);
    }
  });

  document.getElementById('category-company-sections')?.addEventListener('click', async (event) => {
    const key = event.target.closest('[data-manage-model]')?.dataset.manageModel;
    const deleteKey = event.target.closest('[data-delete-master]')?.dataset.deleteMaster;
    const noStockName = event.target.closest('[data-no-stock]')?.dataset.noStock;

    if (noStockName) {
      UI.toast(`${noStockName} has no stock available for sale.`);
      return;
    }

    if (deleteKey) {
      if (!confirm('Permanently delete this master model? This action cannot be undone.')) return;
      const master = currentMasterModels().find(item => item.key === deleteKey);
      if (master) {
        try {
          await API.post('/api/catalog/models/delete-by-key', {
            company: master.company,
            category_name: master.category_name,
            series: master.series,
            model: master.model,
          });
          UI.toast('Master model deleted.', 'success');
          await refreshCategoryPage();
        } catch (error) {
          alert(error.message);
        }
      }
      return;
    }

    if (!key) return;
    const master = currentMasterModels().find(item => item.key === key);
    if (master) openStockModal(master);
  });

  // Variant actions: Edit, Move Location, Transfer to Branch, Delete
  document.getElementById('stock-existing-variants')?.addEventListener('click', async (event) => {
    const transferVariantId = event.target.closest('[data-transfer-variant]')?.dataset.transferVariant;
    const branchTransferId = event.target.closest('[data-branch-transfer-variant]')?.dataset.branchTransferVariant;
    const variantId = event.target.closest('[data-edit-variant]')?.dataset.editVariant;
    const deleteVariantId = event.target.closest('[data-delete-variant]')?.dataset.deleteVariant;
    const deleteName = event.target.closest('[data-delete-variant]')?.dataset.deleteName;
    
    // 1. Move Location within shop
    if (transferVariantId) {
      const detail = await API.get(`/api/products/${transferVariantId}`);
      const p = detail.product;
      document.getElementById('move-source-product-id').value = p.id;
      document.getElementById('move-stock-info').innerHTML = `
        Model: <strong>${escapeHtml(p.model)}</strong><br>
        Color: <strong>${escapeHtml(p.color || 'Standard')}</strong><br>
        Source Location: <strong>${escapeHtml(p.location_name || 'Warehouse')}</strong><br>
        Available Units at Source: <strong>${p.current_stock || 0}</strong>
      `;
      const locSelect = document.getElementById('move-target-location');
      const otherLocations = (categoryState.locations || []).filter(l => Number(l.id) !== Number(p.location_id));
      UI.populateSelect(locSelect, otherLocations, { includeAll: false });
      const qtyInput = document.getElementById('move-transfer-qty');
      qtyInput.max = p.current_stock || 1;
      qtyInput.value = 1;
      document.getElementById('move-stock-error').textContent = '';
      UI.openModal('move-stock-modal');
      return;
    }

    // 2. Transfer directly to other Branch
    if (branchTransferId) {
      const detail = await API.get(`/api/products/${branchTransferId}`);
      const p = detail.product;
      const appState = await API.get('/api/app-state');
      const currentBranchId = appState.current_branch?.id;
      const otherBranches = (appState.branches || []).filter(b => b.id !== currentBranchId);
      
      document.getElementById('cat-transfer-product-id').value = p.id;
      document.getElementById('cat-transfer-info').innerHTML = `
        Transferring: <strong>${escapeHtml(p.company)} ${escapeHtml(p.model)}</strong><br>
        Color: <strong>${escapeHtml(p.color || 'Standard')}</strong> | From: <strong>${escapeHtml(appState.current_branch?.name || 'Current Branch')}</strong><br>
        Available Stock: <strong>${p.current_stock || 0} units</strong>
      `;
      const branchSelect = document.getElementById('cat-transfer-target-branch');
      branchSelect.innerHTML = otherBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
      const qtyInput = document.getElementById('cat-transfer-qty');
      qtyInput.max = p.current_stock || 1;
      qtyInput.value = 1;
      document.getElementById('cat-transfer-error').textContent = '';
      UI.openModal('category-branch-transfer-modal');
      return;
    }

    // 3. Edit variant & add stock
    if (variantId) {
      const detail = await API.get(`/api/products/${variantId}`);
      fillVariantForEdit(detail.product);
      return;
    }

    // 4. Delete variant
    if (deleteVariantId) {
      if (!confirm(`Delete ${deleteName || 'this variant'} and all linked history?`)) return;
      await API.delete(`/api/products/${deleteVariantId}`);
      UI.toast('Variant deleted successfully.', 'success');
      UI.closeModal('stock-modal');
      await refreshCategoryPage();
    }
  });

  // Submit Move Location
  document.getElementById('move-stock-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pid = Number(document.getElementById('move-source-product-id').value);
    const targetLocId = Number(document.getElementById('move-target-location').value);
    const qty = Number(document.getElementById('move-transfer-qty').value);
    const errorEl = document.getElementById('move-stock-error');
    const submitBtn = document.getElementById('btn-submit-move');
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      await API.post('/api/products/transfer', {
        from_product_id: pid,
        to_location_id: targetLocId,
        quantity: qty
      });
      UI.closeModal('move-stock-modal');
      UI.closeModal('stock-modal');
      await refreshCategoryPage();
      UI.toast('Stock moved successfully.', 'success');
    } catch (err) {
      errorEl.textContent = err.message || 'Transfer failed.';
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Submit Branch Transfer from Category Manage Stock
  document.getElementById('category-branch-transfer-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pid = Number(document.getElementById('cat-transfer-product-id').value);
    const targetBranchId = Number(document.getElementById('cat-transfer-target-branch').value);
    const qty = Number(document.getElementById('cat-transfer-qty').value);
    const notes = document.getElementById('cat-transfer-notes').value.trim();
    const errorEl = document.getElementById('cat-transfer-error');
    const submitBtn = document.getElementById('btn-submit-cat-transfer');
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      const res = await API.post('/api/branch-transfers', {
        to_branch_id: targetBranchId,
        product_id: pid,
        quantity: qty,
        notes: notes
      });
      UI.closeModal('category-branch-transfer-modal');
      UI.closeModal('stock-modal');
      await refreshCategoryPage();
      UI.toast(res.message || 'Stock transferred to branch successfully.', 'success');
    } catch (err) {
      errorEl.textContent = err.message || 'Branch transfer failed.';
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Submit Variant Update / Creation Form (Add new machines to existing variant)
  document.getElementById('stock-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const master = categoryState.activeMasterModel;
    if (!master) return;
    const productId = document.getElementById('stock-product-id').value;
    const bulkColors = document.getElementById('stock-bulk-colors').value.split(',').map(item => item.trim()).filter(Boolean);
    const color = document.getElementById('stock-color').value.trim();
    const openingQuantity = Number(document.getElementById('stock-opening-quantity').value || 0);
    const commonPayload = {
      category_id: categoryState.detail.category.id,
      location_id: document.getElementById('stock-location').value ? Number(document.getElementById('stock-location').value) : null,
      company: master.company,
      series: document.getElementById('stock-series').value.trim(),
      model: document.getElementById('stock-model-name').value.trim(),
      size: document.getElementById('stock-size').value.trim(),
      image_path: master.image_path || '',
      min_stock: Number(document.getElementById('stock-min').value || 0),
      default_purchase_price: Number(document.getElementById('stock-purchase').value || 0),
      default_sale_price: Number(document.getElementById('stock-sale').value || 0),
      notes: document.getElementById('stock-notes').value.trim(),
    };
    try {
      if (productId) {
        await API.put(`/api/products/${productId}`, {
          ...commonPayload,
          color,
          opening_quantity: 0,
          added_quantity: openingQuantity,
          active: 1,
        });
      } else {
        await API.post('/api/products/bulk', {
          ...commonPayload,
          colors: bulkColors.length ? bulkColors : [color],
          sizes: [commonPayload.size || ''],
          opening_quantity: openingQuantity,
        });
      }
      UI.closeModal('stock-modal');
      await refreshCategoryPage();
      UI.toast('Stock updated successfully.', 'success');
    } catch (e) {
      alert(e.message);
    }
  });

});