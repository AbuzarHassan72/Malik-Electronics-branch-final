const stocksState = {
  company: getQueryParam('company') || '',
  categoryId: getQueryParam('category_id') || '',
  stockStatus: getQueryParam('stock_status') || 'in_stock',
  search: getQueryParam('search') || '',
  data: null,
};

function stocksQuery() {
  return buildQuery({
    company: stocksState.company || undefined,
    category_id: stocksState.categoryId || undefined,
    stock_status: stocksState.stockStatus || 'all',
    search: stocksState.search || undefined,
  });
}

function inventoryManageUrl(row) {
  return `/category/${row.category_id}?${buildQuery({ company: row.company, search: row.model, stock_status: 'all', manage_key: row.key })}`;
}

function renderStocksCompanies() {
  const wrap = document.getElementById('stocks-company-grid');
  const allBtn = document.getElementById('stocks-all-companies-btn');
  const companies = stocksState.data?.company_list || [];

  if (allBtn) {
    allBtn.classList.toggle('active', !stocksState.company);
  }

  if (!wrap) return;
  wrap.innerHTML = companies.map(c => `
    <button class="company-tile ${c.name === stocksState.company ? 'active' : ''}" type="button" data-stocks-company="${escapeHtml(c.name)}">
      <div class="company-tile-head">
        ${companyLogoHTML(c.name, 'large', c.image_path)}
        <div>
          <div class="company-tile-title">${escapeHtml(c.name)}</div>
          <div class="company-tile-meta">Show all categories and model rows.</div>
        </div>
      </div>
    </button>
  `).join('');
  hydrateCompanyLogos(wrap);
}

function populateStocksFilters() {
  UI.populateSelect(
    document.getElementById('stocks-category-filter'),
    stocksState.data?.categories || [],
    { includeAll: true, allLabel: 'All categories' },
  );

  const companies = stocksState.data?.company_list || [];
  UI.populateSelect(
    document.getElementById('stocks-company-filter'),
    companies,
    { includeAll: true, allLabel: 'All companies', valueKey: 'name', labelKey: 'name' }
  );

  document.getElementById('stocks-company-filter').value = stocksState.company || '';
  document.getElementById('stocks-category-filter').value = stocksState.categoryId || '';
  document.getElementById('stocks-status-filter').value = stocksState.stockStatus;

  const searchInput = document.getElementById('stocks-search-input');
  if (document.activeElement !== searchInput) {
    searchInput.value = stocksState.search;
  }
}

function renderStocksSummary() {
  const wrap = document.getElementById('stocks-summary');
  const sections = stocksState.data?.company_sections || [];
  const allCategories = stocksState.data?.categories || [];
  const allCompanies = stocksState.data?.company_list || [];

  const hasCompanyFilter = Boolean(stocksState.company);
  const hasCategoryFilter = Boolean(stocksState.categoryId);
  const hasStatusFilter = stocksState.stockStatus && stocksState.stockStatus !== 'all';
  const hasSearchFilter = Boolean(stocksState.search && stocksState.search.trim());
  const isFiltered = hasCompanyFilter || hasCategoryFilter || hasStatusFilter || hasSearchFilter;

  const matchingCategoryIds = new Set();
  const matchingCompanyNames = new Set();
  let rowCount = 0;
  let unitCount = 0;

  sections.forEach(section => {
    let companyHasRows = false;
    (section.category_sections || []).forEach(cat => {
      if (cat.rows && cat.rows.length > 0) {
        matchingCategoryIds.add(String(cat.category_id));
        companyHasRows = true;
        rowCount += cat.rows.length;
        unitCount += cat.rows.reduce((sum, r) => sum + Number(r.total_stock || 0), 0);
      }
    });
    if (companyHasRows) {
      matchingCompanyNames.add(section.company);
    }
  });

  const companyCount = !isFiltered ? allCompanies.length : (hasCompanyFilter ? 1 : matchingCompanyNames.size);
  const categoryCount = !isFiltered ? allCategories.length : (hasCategoryFilter ? 1 : matchingCategoryIds.size);

  if (!wrap) return;
  wrap.innerHTML = `
    <div class="summary-pill">Companies: <strong>${companyCount}</strong></div>
    <div class="summary-pill">Categories: <strong>${categoryCount}</strong></div>
    <div class="summary-pill">Models: <strong>${rowCount}</strong></div>
    <div class="summary-pill">Total Items: <strong>${unitCount}</strong></div>
  `;
}

function renderColorLocationStockHTML(row) {
  const colorList = row.color_locations || [];
  if (!colorList.length) {
    return '<span class="muted" style="font-size:0.84rem;">No physical stock registered</span>';
  }

  return `
    <div class="stock-matrix-wrap">
      ${colorList.map(item => {
        const locationPills = (item.locations || []).map(loc => `
          <span class="stock-loc-chip">
            <span>${escapeHtml(loc.location_name)}:</span>
            <strong>${loc.units}</strong>
          </span>
        `).join('');

        return `
          <div class="stock-matrix-card">
            <div class="stock-color-head">
              <span class="stock-color-title">${escapeHtml(item.color)}</span>
              <span class="stock-color-badge">${item.total} Units Total</span>
            </div>
            <div class="stock-loc-chips">
              ${locationPills || '<span class="muted" style="font-size:0.75rem;">Unassigned</span>'}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderStocksResults() {
  const wrap = document.getElementById('stocks-results');
  if (!wrap) return;
  const sections = stocksState.data?.company_sections || [];
  if (!sections.length) {
    wrap.innerHTML = '<section class="card"><div class="empty-state">No stock records found matching current filters.</div></section>';
    return;
  }

  wrap.innerHTML = sections.map(section => `
    <section class="card stock-company-block" style="margin-bottom: 22px;">
      <div class="section-banner">
        <div class="model-brand-row">
          ${companyLogoHTML(section.company, 'medium', section.image_path)}
          <div>
            <h2 class="section-title">${section.company}</h2>
            <div class="record-meta"><span>${section.summary.categories} categories</span><span>${section.summary.master_models} master models</span><span>${section.summary.available_units} units available</span></div>
          </div>
        </div>
      </div>
      ${section.category_sections.map(category => {
        const seriesMap = new Map();
        (category.rows || []).forEach(row => {
          const sName = (row.series || '').trim() || 'General Models';
          if (!seriesMap.has(sName)) {
            seriesMap.set(sName, []);
          }
          seriesMap.get(sName).push(row);
        });

        const seriesBlocksHTML = Array.from(seriesMap.entries()).map(([seriesName, seriesRows]) => {
          const seriesUnits = seriesRows.reduce((sum, r) => sum + Number(r.total_stock || 0), 0);
          return `
            <div class="stock-series-group" style="margin-top: 14px;">
              <div class="stock-series-header">
                <div class="stock-series-title">
                  <span class="series-badge">Series</span>
                  <h4>${escapeHtml(seriesName)}</h4>
                </div>
                <div class="stock-series-meta">
                  <span class="chip">${seriesRows.length} model${seriesRows.length === 1 ? '' : 's'}</span>
                  <span class="chip">${seriesUnits} units total</span>
                </div>
              </div>
              <div class="stock-table-wrap">
                <table class="stock-table">
                  <thead>
                    <tr>
                      <th style="width: 28%; text-align: left;">Model</th>
                      <th style="width: 44%; text-align: left;">Stock by Color &amp; Place</th>
                      <th style="width: 12%; text-align: center;">Total Stock</th>
                      <th style="width: 16%; text-align: right;">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${seriesRows.map(row => `
                      <tr>
                        <td style="text-align: left;">
                          <div style="font-weight: 800; color: #0f172a; font-size: 0.96rem; line-height: 1.35;">
                            ${escapeHtml(row.model || row.display_name)}
                          </div>
                          <div class="muted" style="font-size: 0.78rem; margin-top: 3px;">
                            ${escapeHtml(row.company)} &bull; ${escapeHtml(category.category_name)}
                          </div>
                        </td>
                        <td style="text-align: left;">
                          ${renderColorLocationStockHTML(row)}
                        </td>
                        <td style="text-align: center;">
                          <div class="total-stock-box">
                            <span class="total-stock-num">${row.total_stock}</span>
                            <span class="total-stock-sub">Units</span>
                          </div>
                        </td>
                        <td style="text-align: right;">
                          <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
                            <a class="btn-stock-manage" href="${inventoryManageUrl(row)}">Manage</a>
                            ${(() => {
                              if (Number(row.total_stock || 0) <= 0) return '';
                              const inStockVar = (row.variants || []).find(v => Number(v.remaining_units || 0) > 0) || (row.variants || [])[0];
                              const pId = inStockVar ? inStockVar.id : '';
                              return `<a class="btn-stock-sale" href="/sales?${buildQuery({ category_id: row.category_id, company: row.company, product_id: pId, search: row.model })}">Sales</a>`;
                            })()}
                          </div>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        }).join('');

        return `
          <section class="stock-category-block" style="margin-top: 16px;">
            <div class="stock-category-head" style="margin-bottom: 12px;">
              <div class="stock-category-title-row">
                ${categoryVisualHTML({ name: category.category_name, icon: category.category_icon, image_path: category.category_image_path })}
                <div>
                  <h3 class="section-title">${category.page_title}</h3>
                  <div class="stock-meta-line">
                    <span class="chip">Models: ${category.summary.master_models}</span>
                    <span class="chip">Units: ${category.summary.available_units}</span>
                  </div>
                </div>
              </div>
            </div>
            ${seriesBlocksHTML}
          </section>
        `;
      }).join('')}
    </section>
  `).join('');
  hydrateCompanyLogos(wrap);
  hydrateCategoryVisuals(wrap);
}

async function loadStocks() {
  stocksState.data = await API.get(`/api/stocks/overview?${stocksQuery()}`);
  renderStocksCompanies();
  populateStocksFilters();
  renderStocksSummary();
  renderStocksResults();
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  const triggerFilterUpdate = async () => {
    history.replaceState({}, '', `/stocks?${stocksQuery()}`);
    await loadStocks();
  };

  document.getElementById('stocks-all-companies-btn')?.addEventListener('click', async () => {
    stocksState.company = '';
    document.getElementById('stocks-company-filter').value = '';
    await triggerFilterUpdate();
  });

  document.getElementById('stocks-company-grid')?.addEventListener('click', async (event) => {
    const company = event.target.closest('[data-stocks-company]')?.dataset.stocksCompany;
    if (company === undefined) return;
    stocksState.company = company;
    document.getElementById('stocks-company-filter').value = company;
    await triggerFilterUpdate();
  });

  document.getElementById('stocks-company-filter')?.addEventListener('change', async (event) => {
    stocksState.company = event.target.value;
    await triggerFilterUpdate();
  });

  document.getElementById('stocks-category-filter')?.addEventListener('change', async (event) => {
    stocksState.categoryId = event.target.value;
    await triggerFilterUpdate();
  });

  document.getElementById('stocks-status-filter')?.addEventListener('change', async (event) => {
    stocksState.stockStatus = event.target.value;
    await triggerFilterUpdate();
  });

  let searchDebounceTimer = null;
  document.getElementById('stocks-search-input')?.addEventListener('input', (event) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(async () => {
      stocksState.search = event.target.value.trim();
      await triggerFilterUpdate();
    }, 250);
  });

  document.getElementById('stocks-filter-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearTimeout(searchDebounceTimer);
    stocksState.search = document.getElementById('stocks-search-input').value.trim();
    stocksState.company = document.getElementById('stocks-company-filter').value;
    stocksState.categoryId = document.getElementById('stocks-category-filter').value;
    stocksState.stockStatus = document.getElementById('stocks-status-filter').value;
    await triggerFilterUpdate();
  });

  // Inter-Branch Transfers Tab Controller
  const tabInventory = document.getElementById('tab-btn-stock-inventory');
  const tabTransfers = document.getElementById('tab-btn-branch-transfers');
  const compSection = document.getElementById('stocks-companies-section');
  const filterSection = document.getElementById('stocks-filter-card');
  const resultsSection = document.getElementById('stocks-results');
  const transfersSection = document.getElementById('branch-transfers-section');

  async function loadBranchTransfers() {
    try {
      const rows = await API.get('/api/branch-transfers');
      const tbody = document.getElementById('branch-transfers-table-body');
      const emptyState = document.getElementById('branch-transfers-empty');
      if (!tbody) return;

      if (!rows.length) {
        tbody.innerHTML = '';
        emptyState?.classList.remove('hidden');
        return;
      }
      emptyState?.classList.add('hidden');

      tbody.innerHTML = rows.map(r => {
        const isOutward = r.transfer_type === 'outward';
        const flowBadge = isOutward
          ? `<span class="badge warning" style="font-weight:700;">Sent to ${escapeHtml(r.to_branch_name)}</span>`
          : `<span class="badge success" style="font-weight:700;">Received from ${escapeHtml(r.from_branch_name)}</span>`;
        return `
          <tr>
            <td>${UI.formatDateTime(r.transfer_at || r.created_at)}</td>
            <td><strong style="color:var(--blue-dark);">${escapeHtml(r.reference_no || '')}</strong></td>
            <td>${flowBadge}</td>
            <td><strong>${escapeHtml(r.company)} ${escapeHtml(r.model)}</strong><div class="muted" style="font-size:0.78rem;">${escapeHtml(r.category_name)}</div></td>
            <td>${escapeHtml(r.color || 'Standard')}</td>
            <td><strong style="font-size:1.05rem; color:${isOutward ? 'var(--red)' : 'var(--green)'};">${isOutward ? '-' : '+'}${r.quantity}</strong></td>
            <td><div style="font-size:0.85rem;">${escapeHtml(r.notes || '-')}</div><div class="muted" style="font-size:0.75rem;">By: ${escapeHtml(r.username || 'System')}</div></td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn("Failed to load transfers:", err);
    }
  }

  tabInventory?.addEventListener('click', () => {
    tabInventory.classList.add('active');
    tabInventory.style.borderColor = 'var(--blue-dark)';
    tabInventory.style.fontWeight = '800';
    tabTransfers.classList.remove('active');
    tabTransfers.style.borderColor = '';
    tabTransfers.style.fontWeight = 'normal';

    compSection?.classList.remove('hidden');
    filterSection?.classList.remove('hidden');
    resultsSection?.classList.remove('hidden');
    transfersSection?.classList.add('hidden');
  });

  tabTransfers?.addEventListener('click', async () => {
    tabTransfers.classList.add('active');
    tabTransfers.style.borderColor = 'var(--blue-dark)';
    tabTransfers.style.fontWeight = '800';
    tabInventory.classList.remove('active');
    tabInventory.style.borderColor = '';
    tabInventory.style.fontWeight = 'normal';

    compSection?.classList.add('hidden');
    filterSection?.classList.add('hidden');
    resultsSection?.classList.add('hidden');
    transfersSection?.classList.remove('hidden');
    await loadBranchTransfers();
  });

  document.getElementById('btn-refresh-transfers')?.addEventListener('click', loadBranchTransfers);

  // Wire up the "Transfer Stock Between Branches" button
  document.getElementById('btn-open-branch-transfer')?.addEventListener('click', async () => {
    try {
      const [appState, products] = await Promise.all([
        API.get('/api/app-state'),
        API.get('/api/products')
      ]);

      const currentBranchId = appState.current_branch?.id;
      const targetSelect = document.getElementById('transfer-target-branch');
      const otherBranches = (appState.branches || []).filter(b => b.id !== currentBranchId);

      if (!otherBranches.length) {
        alert('No secondary branch exists to transfer to.');
        return;
      }

      targetSelect.innerHTML = otherBranches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');

      const productSelect = document.getElementById('transfer-product-select');
      const inStockProds = (products || []).filter(p => Number(p.current_stock || 0) > 0);

      if (!inStockProds.length) {
        alert('No in-stock products available in this branch to transfer.');
        return;
      }

      productSelect.innerHTML = inStockProds.map(p => `
        <option value="${p.id}" data-max="${p.current_stock}">${escapeHtml(p.company)} ${escapeHtml(p.model)} — Color: ${escapeHtml(p.color || 'Standard')} (${p.current_stock} available at ${escapeHtml(p.location_name || 'Warehouse')})</option>
      `).join('');

      const qtyInput = document.getElementById('transfer-quantity');
      qtyInput.max = inStockProds[0]?.current_stock || 1;
      qtyInput.value = 1;

      productSelect.onchange = () => {
        const selectedOpt = productSelect.options[productSelect.selectedIndex];
        qtyInput.max = selectedOpt.dataset.max || 1;
      };

      document.getElementById('branch-transfer-error').textContent = '';
      UI.openModal('branch-transfer-modal');
    } catch (err) {
      alert("Failed to prepare branch transfer: " + err.message);
    }
  });

  // Submit Inter-Branch Transfer
  document.getElementById('branch-transfer-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetBranchId = Number(document.getElementById('transfer-target-branch').value);
    const productId = Number(document.getElementById('transfer-product-select').value);
    const qty = Number(document.getElementById('transfer-quantity').value);
    const notes = document.getElementById('transfer-notes').value.trim();
    const errorEl = document.getElementById('branch-transfer-error');
    const submitBtn = document.getElementById('btn-submit-branch-transfer');

    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Transferring...';

    try {
      const res = await API.post('/api/branch-transfers', {
        to_branch_id: targetBranchId,
        product_id: productId,
        quantity: qty,
        notes: notes
      });
      UI.closeModal('branch-transfer-modal');
      UI.toast(res.message || 'Stock transferred successfully.', 'success');
      await loadStocks();
      if (!transfersSection.classList.contains('hidden')) {
        await loadBranchTransfers();
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Transfer failed.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm Transfer';
    }
  });

  await loadStocks();
});