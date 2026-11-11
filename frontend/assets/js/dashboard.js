const dashboardState = {
  data: null,
  selectedCompany: 'Dawlance',
  selectedCategoryId: '',
  manageCategoryId: null,
  manageDetail: null,
  manageLocations: [],
  companyOptions: [],
  managerSearch: '',
  managerStock: 'all',
  activeMasterModel: null,
};

function dashboardQuery() {
  return buildQuery({ company: dashboardState.selectedCompany, category_id: dashboardState.selectedCategoryId || undefined, stock_status: 'all' });
}

function categoryManagerUrl(categoryId) {
  const query = buildQuery({ company: dashboardState.selectedCompany });
  return `/category/${categoryId}${query ? `?${query}` : ''}`;
}

function salesUrl(categoryId, productId = '') {
  return `/sales?${buildQuery({ category_id: categoryId, company: dashboardState.selectedCompany, product_id: productId || undefined })}`;
}

function openCompanyModal(company = null) {
  document.getElementById('company-form')?.reset();
  UI.showMessage(document.getElementById('company-form-message'), '');
  document.getElementById('company-id').value = company?.id || '';
  document.getElementById('company-name').value = company?.name || '';
  document.getElementById('company-image-path').value = company?.image_path || '';
  document.getElementById('company-image-preview').innerHTML = company?.image_path 
    ? `<img src="${company.image_path}" class="category-upload-preview" style="max-height:48px; border-radius:10px;">` 
    : '<span class="muted">No logo uploaded yet.</span>';
  
  const titleElem = document.getElementById('company-modal-title');
  if (titleElem) titleElem.textContent = company ? `Edit Company (${company.name})` : 'Manage Companies';
  
  renderCompanyRegistry();
  UI.openModal('company-modal');
}

function renderCompanyRegistry() {
  const wrap = document.getElementById('dashboard-company-registry');
  if (!wrap) return;
  const companies = dashboardState.data?.companies || [];

  if (!companies.length) {
    wrap.innerHTML = '<div class="empty-state">No companies registered for this branch.</div>';
    return;
  }

  const primaryBrands = ['dawlance', 'haier'];

  wrap.innerHTML = companies.map(c => {
    const isPrimary = primaryBrands.includes(c.name.toLowerCase());
    
    return `
      <div class="company-registry-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface-2); margin-bottom: 10px; box-shadow: 0 4px 12px rgba(15,23,42,0.02);">
        
        <div class="company-registry-info" style="display: flex; align-items: center; gap: 14px; min-width: 0;">
          ${companyLogoHTML(c.name, '', c.image_path)}
          <div style="min-width: 0;">
            <div style="font-size: 1.05rem; font-weight: 800; color: var(--text); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(c.name)}</span>
              ${isPrimary ? `<span style="background: rgba(29,78,216,0.1); color: var(--blue-dark); font-size: 0.7rem; padding: 3px 8px; border-radius: 99px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0;">Primary</span>` : ''}
            </div>
            <div class="muted" style="font-size:0.85rem; margin-top:4px;">${c.category_count} categories · ${c.available_units} units in stock</div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
          <button class="btn-ghost small" type="button" data-registry-edit="${escapeHtml(c.name)}" style="padding: 8px 16px;">Edit</button>
          ${!isPrimary ? `<button class="btn-danger small" type="button" data-registry-delete="${c.id || ''}" data-registry-name="${escapeHtml(c.name)}" style="padding: 8px 16px;">Delete</button>` : ''}
        </div>

      </div>
    `;
  }).join('');

  if (typeof hydrateCompanyLogos === 'function') hydrateCompanyLogos(wrap);
}

function resetCompanyForm() {
  document.getElementById('company-form')?.reset();
  document.getElementById('company-id').value = '';
  document.getElementById('company-image-path').value = '';
  document.getElementById('company-image-preview').innerHTML = '<span class="muted">No logo uploaded yet.</span>';
  document.getElementById('company-modal-title').textContent = 'Manage Companies';
  const saveBtn = document.getElementById('save-company-btn');
  if (saveBtn) saveBtn.textContent = 'Add Company';
  const cancelBtn = document.getElementById('reset-company-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  UI.showMessage(document.getElementById('company-form-message'), '');
}

function renderDashboardStats() {
  const stats = dashboardState.data?.stats || {};
  const companies = dashboardState.data?.companies || [];
  const totalUnits = companies.reduce((acc, c) => acc + Number(c.available_units || 0), 0);
  const totalModels = companies.reduce((acc, c) => acc + Number(c.catalog_models || 0), 0);

  const cards = [
    ['Categories', stats.total_categories || 0, 'Active product category groups'],
    ['Stock Units', totalUnits, 'Physical units available in branch'],
    ['Master Models', totalModels, 'Registered company models'],
    ['Companies', companies.length, 'Active brands in this branch'],
  ];

  document.getElementById('dashboard-stats').innerHTML = cards.map(([label, value, note]) => `
    <article class="card stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value" style="font-size: clamp(2rem, 2.8vw, 3rem); font-weight: 850; color: var(--blue-dark);">${value}</div>
      <div class="stat-note">${note}</div>
    </article>
  `).join('');
}

function renderCompanies() {
  const wrap = document.getElementById('company-grid');
  const companies = dashboardState.data?.companies || [];

  // Clean dashboard cards: no inline edit/delete clutter, dedicated Manage Companies button handles registry
  wrap.innerHTML = companies.map(item => `
    <article class="company-tile ${item.name === dashboardState.selectedCompany ? 'active' : ''}" data-company-pick="${escapeHtml(item.name)}" tabindex="0" role="button">
      <div class="company-tile-head">
        ${companyLogoHTML(item.name, 'large', item.image_path)}
        <div>
          <div class="company-tile-title">${escapeHtml(item.name)}</div>
          <div class="company-tile-meta">${item.category_count} categories · ${item.catalog_models} master models</div>
        </div>
      </div>
      <div class="company-tile-kpis">
        <span class="chip metric-chip"><span class="chip-label">Units</span><strong>${item.available_units}</strong></span>
        <span class="chip metric-chip metric-chip-price price-safe-box"><span class="chip-label">Stock</span>${UI.currencyHTML(item.stock_value)}</span>
      </div>
    </article>
  `).join('');

  hydrateCompanyLogos(wrap);
  repairLegacyAssetImages(wrap);
  UI.applyPricePrivacy();
}

function renderCategoryCards() {
  const cards = dashboardState.data?.category_cards || [];
  const wrap = document.getElementById('company-categories');
  if (!cards.length) {
    wrap.innerHTML = '<div class="empty-state">No category exists for this company yet. Create or manage them from Categories & Location Management.</div>';
    return;
  }
  wrap.innerHTML = cards.map(card => `
    <article class="compact-category-card category-card-button dashboard-category-card ${String(card.id) === String(dashboardState.selectedCategoryId) ? 'active' : ''}" data-dashboard-category="${card.id}" tabindex="0">
      <div class="compact-category-head">
        ${categoryVisualHTML(card)}
        <div>
          <div class="compact-category-title">${escapeHtml(card.title)}</div>
          <div class="record-meta"><span>${card.in_stock_models} in stock</span><span>${card.out_of_stock_models} out of stock</span></div>
        </div>
      </div>
      <div class="compact-category-foot">
        <span class="chip metric-chip"><span class="chip-label">Units</span><strong>${card.available_units}</strong></span>
        <span class="chip metric-chip metric-chip-price price-safe-box"><span class="chip-label">Amount</span>${UI.currencyHTML(card.stock_value)}</span>
      </div>
      <div class="inline-actions">
        <button class="btn small" type="button" data-quick-manage="${card.id}">Manage stock</button>
        <a class="btn-ghost small" href="${salesUrl(card.id)}">Sales</a>
      </div>
    </article>
  `).join('');
  hydrateCategoryVisuals(wrap);
  UI.applyPricePrivacy();
}

async function loadDashboard() {
  const data = await API.get(`/api/dashboard/overview?${dashboardQuery()}`);
  dashboardState.data = data;
  if ((!dashboardState.selectedCategoryId || !data.category_cards?.some(card => String(card.id) === String(dashboardState.selectedCategoryId))) && data.category_cards?.length) {
    dashboardState.selectedCategoryId = String(data.category_cards[0].id);
  }
  renderDashboardStats();
  renderCompanies();
  renderCategoryCards();
}

function managerMasterModels() { return dashboardState.manageDetail?.master_models || []; }

function filteredManagerModels() {
  const query = dashboardState.managerSearch.trim().toLowerCase();
  const stock = dashboardState.managerStock;
  return managerMasterModels().filter(model => {
    if (stock === 'in_stock' && Number(model.total_stock || 0) <= 0) return false;
    if (stock === 'out_of_stock' && Number(model.total_stock || 0) > 0) return false;
    if (!query) return true;
    const hay = [model.display_name, model.series, model.model, model.company, ...(model.colors || []).map(item => item.name), ...(model.locations || []).map(item => item.name)].join(' ').toLowerCase();
    return hay.includes(query);
  });
}

function renderManagerSummary() {
  const detail = dashboardState.manageDetail;
  if (!detail) return;
  const rows = [
    ['Master models', detail.summary.master_models],
    ['In stock', detail.summary.in_stock_models],
    ['Out of stock', detail.summary.out_of_stock_models],
    ['Units', detail.summary.available_units],
    ['Stock value', UI.currencyHTML(detail.summary.stock_value)],
  ];
  document.getElementById('dashboard-manage-title').textContent = `${detail.page_title} · ${dashboardState.selectedCompany}`;
  document.getElementById('dashboard-manage-summary').innerHTML = rows.map(([label, value]) => `<div class="summary-pill price-safe-box"><span>${label}</span><strong>${value}</strong></div>`).join('');
  document.getElementById('dashboard-open-full-page').href = categoryManagerUrl(detail.category.id);
  const masterCompany = document.getElementById('master-company');
  const options = (dashboardState.companyOptions || []).length ? dashboardState.companyOptions : TOP_COMPANIES;
  masterCompany.innerHTML = options.map(name => `<option value="${name}">${name}</option>`).join('');
  masterCompany.value = dashboardState.selectedCompany || options[0] || TOP_COMPANIES[0];
  UI.applyPricePrivacy();
}

function salesButtonForModel(model) {
  if (Number(model.total_stock || 0) <= 0) {
    return `<button class="btn-ghost small disabled-sale-trigger" type="button">No Available Stock</button>`;
  }
  const saleVariant = (model.variants || []).find(variant => Number(variant.remaining_units || 0) > 0) || (model.variants || [])[0];
  return `<a class="btn-ghost small" href="${salesUrl(dashboardState.manageDetail.category.id, saleVariant?.id || '')}">Sales</a>`;
}

function existingVariantList(master) {
  const related = (master.variants || []);
  if (!related.length) return '<div class="empty-state">No stock variant exists yet for this master model.</div>';
  return related.map(variant => `
    <article class="mini-stock-card ${Number(variant.remaining_units || 0) <= 0 ? 'out-stock-card' : ''}">
      <div class="record-top">
        <div>
          <h4 class="record-title">${variant.color || 'Standard'}${variant.size ? ` / ${variant.size}` : ''}</h4>
          <div class="record-meta"><span>${variant.location_name || 'No location'}</span><span>${variant.remaining_units} left</span></div>
        </div>
        <div class="inline-actions">
          <button class="btn-ghost small" type="button" data-edit-variant="${variant.id}">Edit</button>
          <button class="btn-danger small" type="button" data-delete-variant="${variant.id}" data-delete-name="${escapeHtml(variant.color || 'Standard')}">Delete</button>
        </div>
      </div>
    </article>
  `).join('');
}

function openStockModal(master) {
  dashboardState.activeMasterModel = master;
  document.getElementById('stock-form').reset();
  document.getElementById('stock-product-id').value = '';
  document.getElementById('stock-modal-title').textContent = `Manage stock · ${master.display_name}`;
  document.getElementById('stock-modal-summary').innerHTML = `Company: <strong>${master.company}</strong> · Current stock: <strong>${master.total_stock}</strong>`;
  document.getElementById('stock-existing-variants').innerHTML = existingVariantList(master);
  document.getElementById('stock-model-display').value = master.display_name;
  document.getElementById('stock-company').value = master.company;
  document.getElementById('stock-series').value = master.series || '';
  document.getElementById('stock-model-name').value = master.model;
  document.getElementById('stock-size').value = master.size || '';
  document.getElementById('stock-purchase').value = master.default_price || 0;
  document.getElementById('stock-sale').value = master.default_price || 0;
  document.getElementById('stock-opening-quantity').value = 0;
  document.getElementById('stock-min').value = 0;
  document.getElementById('stock-bulk-colors').value = '';
  document.getElementById('stock-notes').value = '';
  document.getElementById('stock-color').value = '';
  document.getElementById('stock-location').value = '';
  UI.populateSelect(document.getElementById('stock-location'), dashboardState.manageLocations, { includeAll: true, allLabel: 'Select location' });
  UI.openModal('stock-modal');
}

function fillVariantForEdit(variant) {
  document.getElementById('stock-product-id').value = variant.id;
  document.getElementById('stock-series').value = variant.series || '';
  document.getElementById('stock-model-name').value = variant.model || '';
  document.getElementById('stock-size').value = variant.size || '';
  document.getElementById('stock-location').value = variant.location_id || '';
  document.getElementById('stock-color').value = variant.color || '';
  document.getElementById('stock-min').value = variant.min_stock || 0;
  document.getElementById('stock-purchase').value = variant.default_purchase_price || 0;
  document.getElementById('stock-sale').value = variant.default_sale_price || 0;
  document.getElementById('stock-opening-quantity').value = 0;
  document.getElementById('stock-notes').value = variant.notes || '';
  document.getElementById('stock-modal-summary').innerHTML = `Editing variant <strong>${variant.color || 'Standard'}</strong>. Use Quantity to add now to increase stock.`;
}

function renderManagerGrid() {
  const wrap = document.getElementById('dashboard-manage-grid');
  const models = filteredManagerModels();
  if (!models.length) {
    wrap.innerHTML = '<div class="empty-state">No model matched the current filter.</div>';
    return;
  }
  wrap.innerHTML = models.map(model => `
    <article class="manager-model-card ${Number(model.total_stock || 0) > 0 ? 'in-stock' : 'out-stock'}">
      <div class="record-top">
        <div class="model-brand-row">
          ${companyLogoHTML(model.company)}
          <div>
            <h3 class="record-title">${escapeHtml(model.display_name)}</h3>
            <div class="record-meta"><span>${escapeHtml(model.company)}</span><span>${escapeHtml(model.series || 'No series')}</span></div>
          </div>
        </div>
        <span class="badge ${Number(model.total_stock || 0) > 0 ? 'success' : 'danger'}">${Number(model.total_stock || 0) > 0 ? `${model.total_stock} in stock` : 'Out of stock'}</span>
      </div>
      <div class="inline-actions" style="margin-top:14px;"><button class="btn small" type="button" data-manage-model="${model.key}">Manage</button>${salesButtonForModel(model)}</div>
    </article>
  `).join('');
  hydrateCompanyLogos(wrap);
  UI.applyPricePrivacy();
}

async function openQuickManager(categoryId) {
  dashboardState.manageCategoryId = Number(categoryId);
  dashboardState.managerSearch = '';
  dashboardState.managerStock = 'all';
  document.getElementById('dashboard-manager-search').value = '';
  document.getElementById('dashboard-manager-stock').value = 'all';
  const [detail, locations, meta] = await Promise.all([
    API.get(`/api/categories/${categoryId}/detail?${buildQuery({ company: dashboardState.selectedCompany, stock_status: 'all' })}`),
    API.get('/api/locations'),
    API.get('/api/meta'),
  ]);
  dashboardState.manageDetail = detail;
  dashboardState.manageLocations = locations;
  dashboardState.companyOptions = meta.company_options || TOP_COMPANIES;
  renderManagerSummary();
  renderManagerGrid();
  UI.openModal('dashboard-manage-modal');
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  document.getElementById('dashboard-new-company')?.addEventListener('click', openCompanyModal);
  document.getElementById('reset-company-btn')?.addEventListener('click', resetCompanyForm);

  document.getElementById('company-image-upload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await API.upload('/api/uploads/company-image', form);
      document.getElementById('company-image-path').value = result.path;
      document.getElementById('company-image-preview').innerHTML = `<img src="${result.path}" class="category-upload-preview" style="max-height:48px; border-radius:10px;">`;
    } catch (error) { alert(error.message); }
  });

  document.getElementById('company-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = document.getElementById('company-id').value;
    const payload = { 
      name: document.getElementById('company-name').value.trim(),
      image_path: document.getElementById('company-image-path').value
    };
    try {
      if (id) {
        await API.put(`/api/companies/${id}`, payload);
        UI.toast('Company updated successfully.', 'success');
      } else {
        await API.post('/api/companies', payload);
        UI.toast('Company added successfully.', 'success');
      }
      resetCompanyForm();
      await loadDashboard();
      renderCompanyRegistry();
    } catch (error) { UI.showMessage(document.getElementById('company-form-message'), error.message); }
  });

  document.getElementById('dashboard-company-registry')?.addEventListener('click', async (event) => {
    const editName = event.target.closest('[data-registry-edit]')?.dataset.registryEdit;
    const deleteId = event.target.closest('[data-registry-delete]')?.dataset.registryDelete;
    const deleteName = event.target.closest('[data-registry-delete]')?.dataset.registryName;

    if (editName) {
      const comp = (dashboardState.data?.companies || []).find(c => c.name === editName);
      if (comp) {
        document.getElementById('company-id').value = comp.id || '';
        document.getElementById('company-name').value = comp.name;
        document.getElementById('company-image-path').value = comp.image_path || '';
        document.getElementById('company-image-preview').innerHTML = comp.image_path
          ? `<img src="${comp.image_path}" class="category-upload-preview" style="max-height:48px; border-radius:10px;">`
          : '<span class="muted">No logo uploaded yet.</span>';
        document.getElementById('company-modal-title').textContent = `Edit ${comp.name}`;
        document.getElementById('save-company-btn').textContent = 'Update Company';
        document.getElementById('reset-company-btn').style.display = 'inline-block';
        document.getElementById('company-name').focus();
      }
      return;
    }

    if (deleteName) {
      if (!confirm(`Are you sure you want to delete ${deleteName} and all its associated catalog models?`)) return;
      try {
        const targetKey = deleteId && deleteId !== "null" && deleteId !== "" ? deleteId : encodeURIComponent(deleteName);
        await API.delete(`/api/companies/${targetKey}`);
        
        UI.toast(`${deleteName} deleted successfully.`, 'success');
        await loadDashboard();
        renderCompanyRegistry();
      } catch (error) {
        alert(error.message);
      }
    }
  });

  document.getElementById('company-grid').addEventListener('click', async (event) => {
    const companyBtn = event.target.closest('[data-company-pick]');
    if (!companyBtn) return;
    dashboardState.selectedCompany = companyBtn.dataset.companyPick;
    dashboardState.selectedCategoryId = '';
    await loadDashboard();
  });

  document.getElementById('company-categories').addEventListener('click', async (event) => {
    const manageId = event.target.closest('[data-quick-manage]')?.dataset.quickManage;
    if (manageId) {
      event.preventDefault();
      await openQuickManager(manageId);
      return;
    }
    if (event.target.closest('a,button')) return;
    const card = event.target.closest('[data-dashboard-category]');
    if (card) location.href = categoryManagerUrl(card.dataset.dashboardCategory);
  });

  document.getElementById('dashboard-manager-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    dashboardState.managerSearch = document.getElementById('dashboard-manager-search').value.trim();
    dashboardState.managerStock = document.getElementById('dashboard-manager-stock').value;
    renderManagerGrid();
  });

  document.getElementById('dashboard-add-master-model').addEventListener('click', () => {
    document.getElementById('master-model-form').reset();
    document.getElementById('master-company').value = dashboardState.selectedCompany || TOP_COMPANIES[0];
    UI.openModal('master-model-modal');
  });

  document.getElementById('master-model-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await API.post('/api/catalog/models', {
      category_name: dashboardState.manageDetail.category.name,
      company: document.getElementById('master-company').value,
      series: document.getElementById('master-series').value.trim(),
      model: document.getElementById('master-model').value.trim(),
      default_price: Number(document.getElementById('master-price').value || 0),
    });
    UI.closeModal('master-model-modal');
    await openQuickManager(dashboardState.manageCategoryId);
    UI.toast('Master model created.', 'success');
  });

  document.getElementById('dashboard-manage-grid').addEventListener('click', (event) => {
    const key = event.target.closest('[data-manage-model]')?.dataset.manageModel;
    if (!key) return;
    const master = managerMasterModels().find(item => String(item.key) === String(key));
    if (master) openStockModal(master);
  });

  document.getElementById('stock-existing-variants').addEventListener('click', async (event) => {
    const variantId = event.target.closest('[data-edit-variant]')?.dataset.editVariant;
    const deleteVariantId = event.target.closest('[data-delete-variant]')?.dataset.deleteVariant;
    if (variantId) {
      const detail = await API.get(`/api/products/${variantId}`);
      fillVariantForEdit(detail.product);
      return;
    }
    if (deleteVariantId) {
      if (!confirm('Delete this variant?')) return;
      await API.delete(`/api/products/${deleteVariantId}`);
      UI.toast('Variant deleted.', 'success');
      UI.closeModal('stock-modal');
      await openQuickManager(dashboardState.manageCategoryId);
    }
  });

  document.getElementById('stock-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const master = dashboardState.activeMasterModel;
    if (!master) return;
    const productId = document.getElementById('stock-product-id').value;
    const bulkColors = document.getElementById('stock-bulk-colors').value.split(',').map(item => item.trim()).filter(Boolean);
    const color = document.getElementById('stock-color').value.trim();
    const openingQuantity = Number(document.getElementById('stock-opening-quantity').value || 0);
    const commonPayload = {
      category_id: dashboardState.manageDetail.category.id,
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
    if (productId) {
      await API.put(`/api/products/${productId}`, { ...commonPayload, color, opening_quantity: 0, added_quantity: openingQuantity, active: 1 });
    } else {
      await API.post('/api/products/bulk', { ...commonPayload, colors: bulkColors.length ? bulkColors : [color], sizes: [commonPayload.size || ''], opening_quantity: openingQuantity });
    }
    UI.closeModal('stock-modal');
    await openQuickManager(dashboardState.manageCategoryId);
    await loadDashboard();
    UI.toast('Stock updated.', 'success');
  });

  await loadDashboard();
});