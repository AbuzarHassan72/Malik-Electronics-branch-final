const inventoryState = {
  categories: [],
  locations: [],
  meta: null,
  selectedCategoryId: getQueryParam('category_id') || '',
  selectedCardId: getQueryParam('category_id') || '',
};

function searchScore(query, category) {
  const value = `${category.name} ${category.description || ''} ${category.icon || ''}`.toLowerCase();
  const clean = query.trim().toLowerCase();
  if (!clean) return 0;
  let score = 0;
  clean.split(/\s+/).filter(Boolean).forEach(token => {
    if (category.name.toLowerCase() === token) score += 140;
    if (category.name.toLowerCase().startsWith(token)) score += 90;
    if (category.name.toLowerCase().includes(token)) score += 55;
    if (value.includes(token)) score += 25;
    if ((category.description || '').toLowerCase().includes(token)) score += 15;
  });
  return score;
}

function selectedCategory() {
  return inventoryState.categories.find(item => String(item.id) === String(inventoryState.selectedCardId || inventoryState.selectedCategoryId));
}

function matchingCategories() {
  const query = document.getElementById('inventory-search').value.trim().toLowerCase();
  return [...inventoryState.categories]
    .map(item => ({ ...item, _score: searchScore(query, item) }))
    .filter(item => !query || item._score > 0)
    .sort((a, b) => {
      if (!!query && b._score !== a._score) return b._score - a._score;
      if ((b.current_units || 0) !== (a.current_units || 0)) return (b.current_units || 0) - (a.current_units || 0);
      return a.name.localeCompare(b.name);
    });
}

function renderSearchSuggestions() {
  const wrap = document.getElementById('inventory-search-suggestions');
  if (!wrap) return;
  const query = document.getElementById('inventory-search').value.trim();
  if (!query) { wrap.innerHTML = ''; wrap.classList.remove('open'); return; }
  const rows = matchingCategories().slice(0, 6);
  if (!rows.length) { wrap.innerHTML = ''; wrap.classList.remove('open'); return; }
  wrap.innerHTML = rows.map(item => `<button type="button" class="suggestion-item" data-suggest-category="${item.id}"><span>${escapeHtml(item.name)}</span><small>${item.variant_count} variants · ${item.current_units} units</small></button>`).join('');
  wrap.classList.add('open');
}

function renderIconPicker() {
  const wrap = document.getElementById('category-icon-picker');
  const icons = inventoryState.meta?.category_icons || ['📦'];
  const current = document.getElementById('category-icon').value || '📦';
  wrap.innerHTML = icons.map(icon => `<button type="button" class="icon-pill ${icon === current ? 'active' : ''}" data-icon-choice="${icon}">${icon}</button>`).join('');
}

function renderCategories() {
  const wrap = document.getElementById('inventory-categories');
  const query = document.getElementById('inventory-search').value.trim().toLowerCase();
  const rows = matchingCategories();

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state">No category matched this search.</div>';
    return;
  }

  wrap.innerHTML = rows.map(item => `
    <article class="compact-category-card category-card-button ${String(item.id) === String(inventoryState.selectedCardId) ? 'active' : ''}" data-category-card="${item.id}" tabindex="0">
      <div class="compact-category-head">
        ${categoryVisualHTML(item)}
        <div>
          <div class="compact-category-title">${escapeHtml(item.name)}</div>
          <div class="record-meta"><span>${item.product_count} models</span><span>${item.series_count || 0} series</span><span>${item.variant_count} variants</span></div>
        </div>
      </div>
      <div class="compact-category-foot">
        <span class="chip">Units: ${item.current_units}</span>
        <span class="chip price-safe-box">Value: ${UI.currencyHTML(item.current_value)}</span>
      </div>
      <div class="inline-actions">
        <button class="btn small" type="button" data-open-models="${item.id}">Open models</button>
      </div>
    </article>
  `).join('');
  hydrateCategoryVisuals(wrap);
  UI.applyPricePrivacy();
}

function renderLocations() {
  const target = document.getElementById('location-list');
  if (!inventoryState.locations.length) {
    target.innerHTML = '<div class="empty-state">No location created yet.</div>';
    return;
  }
  target.innerHTML = inventoryState.locations.map(location => `
    <article class="management-row">
      <div>
        <div class="management-row-title">${escapeHtml(location.name)}</div>
        <div class="management-row-meta">${escapeHtml(location.description || 'No description')} · ${Number(location.linked_variants || 0)} linked variants · ${Number(location.current_units || 0)} units</div>
      </div>
      <div class="inline-actions">
        <button class="btn-ghost small" type="button" data-edit-location="${location.id}">Edit</button>
        <button class="btn-danger small" type="button" data-delete-location="${location.id}" data-location-name="${escapeHtml(location.name)}">Delete</button>
      </div>
    </article>
  `).join('');
}

async function refreshData() {
  const [categories, meta, locations] = await Promise.all([API.get('/api/categories'), API.get('/api/meta'), API.get('/api/locations')]);
  inventoryState.categories = categories;
  inventoryState.meta = meta;
  inventoryState.locations = locations;
  if (!inventoryState.selectedCategoryId && categories.length) inventoryState.selectedCategoryId = String(categories[0].id);
  if (!inventoryState.selectedCardId && categories.length) inventoryState.selectedCardId = String(categories[0].id);
  renderIconPicker();
  renderCategories();
  renderLocations();
  renderSearchSuggestions();
}

function openCategoryModal(category = null) {
  document.getElementById('category-form').reset();
  UI.showMessage(document.getElementById('category-form-message'), '');
  document.getElementById('category-id').value = category?.id || '';
  document.getElementById('category-name').value = category?.name || '';
  document.getElementById('category-icon').value = category?.icon || '📦';
  document.getElementById('category-description').value = category?.description || '';
  
  // Handle existing category image
  document.getElementById('category-image-path').value = category?.image_path || '';
  document.getElementById('category-image-preview').innerHTML = category?.image_path 
    ? `<img src="${category.image_path}" alt="${escapeHtml(category.name)}" class="category-upload-preview">` 
    : '<span class="muted">No uploaded image yet.</span>';
  
  document.getElementById('category-modal-title').textContent = category ? 'Edit category' : 'New category';
  
  // Setup the Company Selection dropdown
  const companyOptions = inventoryState.meta?.company_options || (typeof TOP_COMPANIES !== 'undefined' ? TOP_COMPANIES : []);
  const selectElement = document.getElementById('category-company-select');
  if (selectElement) {
    UI.populateSelect(selectElement, companyOptions.map(c => ({ id: c, name: c })), { includeAll: true, allLabel: 'Do not link a company yet' });
  }

  // Reset the inline company creation preview
  const newCompanyPreview = document.getElementById('new-company-image-preview');
  if (newCompanyPreview) newCompanyPreview.innerHTML = '<span class="muted">No logo uploaded yet.</span>';

  renderIconPicker();
  UI.openModal('category-modal');
}

function openLocationModal(location = null) {
  document.getElementById('location-form').reset();
  UI.showMessage(document.getElementById('location-form-message'), '');
  document.getElementById('location-id').value = location?.id || '';
  document.getElementById('location-name').value = location?.name || '';
  document.getElementById('location-description').value = location?.description || '';
  document.getElementById('location-modal-title').textContent = location ? 'Edit location' : 'New location';
  UI.openModal('location-modal');
}

async function uploadCategoryImage(file) {
  const form = new FormData();
  form.append('file', file);
  const result = await API.upload('/api/uploads/category-image', form);
  return result.path;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  await refreshData();

  // Handle Company Association Tab Switching
  const tabSelect = document.getElementById('tab-select-company');
  const tabCreate = document.getElementById('tab-create-company');
  const viewSelect = document.getElementById('view-select-company');
  const viewCreate = document.getElementById('view-create-company');

  if (tabSelect && tabCreate && viewSelect && viewCreate) {
    tabSelect.addEventListener('click', () => {
      tabSelect.classList.add('active');
      tabCreate.classList.remove('active');
      viewSelect.classList.remove('hidden');
      viewCreate.classList.add('hidden');
    });

    tabCreate.addEventListener('click', () => {
      tabCreate.classList.add('active');
      tabSelect.classList.remove('active');
      viewCreate.classList.remove('hidden');
      viewSelect.classList.add('hidden');
    });
  }

  // Handle Inline New Company Image Upload
  document.getElementById('new-company-image-upload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      // NOTE: Make sure your backend exposes this endpoint /api/uploads/company-image 
      const result = await API.upload('/api/uploads/company-image', form); 
      document.getElementById('new-company-image-path').value = result.path;
      document.getElementById('new-company-image-preview').innerHTML = `<img src="${result.path}" alt="Company logo" class="category-upload-preview">`;
    } catch (error) {
      alert(error.message);
    }
  });

  document.getElementById('inventory-search').addEventListener('input', () => { renderCategories(); renderSearchSuggestions(); });

  document.getElementById('inventory-categories').addEventListener('click', (event) => {
    const cardId = event.target.closest('[data-category-card]')?.dataset.categoryCard;
    const openId = event.target.closest('[data-open-models]')?.dataset.openModels;
    if (cardId) {
      inventoryState.selectedCardId = cardId;
      inventoryState.selectedCategoryId = cardId;
      renderCategories();
    }
    if (openId) location.href = `/category/${openId}`;
  });

  document.getElementById('inventory-categories').addEventListener('keydown', (event) => {
    const cardId = event.target.closest('[data-category-card]')?.dataset.categoryCard;
    if (!cardId) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      inventoryState.selectedCardId = cardId;
      inventoryState.selectedCategoryId = cardId;
      renderCategories();
    }
  });

  document.getElementById('inventory-search-suggestions')?.addEventListener('click', (event) => {
    const picked = event.target.closest('[data-suggest-category]')?.dataset.suggestCategory;
    if (!picked) return;
    inventoryState.selectedCardId = picked;
    inventoryState.selectedCategoryId = picked;
    const category = inventoryState.categories.find(item => String(item.id) === String(picked));
    if (category) document.getElementById('inventory-search').value = category.name;
    renderCategories();
    renderSearchSuggestions();
  });
  document.getElementById('inventory-search')?.addEventListener('blur', () => setTimeout(renderSearchSuggestions, 120));

  document.getElementById('inventory-new-category').addEventListener('click', () => openCategoryModal());
  document.getElementById('inventory-edit-category').addEventListener('click', () => {
    const category = selectedCategory();
    if (!category) return alert('Select a category first.');
    openCategoryModal(category);
  });
  
  document.getElementById('inventory-delete-category').addEventListener('click', async () => {
    const category = selectedCategory();
    if (!category) return alert('Select a category first.');
    if (!confirm(`Delete ${category.name}?`)) return;
    try {
      await API.delete(`/api/categories/${category.id}`);
    } catch (error) {
      if (!confirm(`${error.message}\n\nPress OK to force delete this category and all linked history.`)) return;
      await API.delete(`/api/categories/${category.id}?force=true`);
    }
    inventoryState.selectedCardId = '';
    inventoryState.selectedCategoryId = '';
    await refreshData();
  });

  document.getElementById('inventory-new-location').addEventListener('click', () => openLocationModal());
  document.getElementById('location-list').addEventListener('click', async (event) => {
    const editId = event.target.closest('[data-edit-location]')?.dataset.editLocation;
    const deleteId = event.target.closest('[data-delete-location]')?.dataset.deleteLocation;
    if (editId) {
      const location = inventoryState.locations.find(item => String(item.id) === String(editId));
      if (location) openLocationModal(location);
      return;
    }
    if (deleteId) {
      const location = inventoryState.locations.find(item => String(item.id) === String(deleteId));
      if (!location) return;
      if (!confirm(`Delete ${location.name}?`)) return;
      try {
        await API.delete(`/api/locations/${deleteId}`);
      } catch (error) {
        if (!confirm(`${error.message}\n\nPress OK to delete it and keep linked variants unassigned.`)) return;
        await API.delete(`/api/locations/${deleteId}?force=true`);
      }
      await refreshData();
    }
  });

  document.getElementById('category-icon-picker').addEventListener('click', (event) => {
    const icon = event.target.closest('[data-icon-choice]')?.dataset.iconChoice;
    if (!icon) return;
    document.getElementById('category-icon').value = icon;
    renderIconPicker();
  });

  document.getElementById('category-image-upload').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const path = await uploadCategoryImage(file);
      document.getElementById('category-image-path').value = path;
      document.getElementById('category-image-preview').innerHTML = `<img src="${path}" alt="Category image" class="category-upload-preview">`;
    } catch (error) {
      alert(error.message);
    }
  });

  // Updated Form Submission integrating Category, Company, and bridging Model
  document.getElementById('category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Saving...';
    submitBtn.disabled = true;

    try {
      // 1. Save Category First
      const payload = {
        name: document.getElementById('category-name').value.trim(),
        icon: document.getElementById('category-icon').value,
        description: document.getElementById('category-description').value.trim(),
        image_path: document.getElementById('category-image-path').value.trim(),
      };
      
      const categoryId = document.getElementById('category-id').value;
      const savedCategory = categoryId ? await API.put(`/api/categories/${categoryId}`, payload) : await API.post('/api/categories', payload);
      
      // 2. Determine Company Link logic
      const tabCreate = document.getElementById('tab-create-company');
      const isCreatingNewCompany = tabCreate && tabCreate.classList.contains('active');
      let targetCompanyName = null;

      if (isCreatingNewCompany) {
        const newCompanyName = document.getElementById('new-company-name').value.trim();
        if (newCompanyName) {
          // Send to your backend to register the new company 
          await API.post('/api/companies', { 
            name: newCompanyName,
            image_path: document.getElementById('new-company-image-path').value 
          });
          targetCompanyName = newCompanyName;
        }
      } else {
        const selectNode = document.getElementById('category-company-select');
        if (selectNode && selectNode.value) {
          targetCompanyName = selectNode.value;
        }
      }

      // 3. Bind Company and Category via Catalog Models (The implicit bridge)
      if (targetCompanyName) {
        await API.post('/api/catalog/models', {
          category_name: savedCategory.name,
          company: targetCompanyName,
          series: 'Base Series',
          model: 'Standard',
          default_price: 0,
        });
      }

      inventoryState.selectedCardId = String(savedCategory.id);
      inventoryState.selectedCategoryId = String(savedCategory.id);
      UI.closeModal('category-modal');
      await refreshData();
      UI.toast(categoryId ? 'Category updated successfully.' : 'Category & Links created successfully.', 'success');

    } catch (error) {
      UI.showMessage(document.getElementById('category-form-message'), error.message);
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  document.getElementById('location-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: document.getElementById('location-name').value.trim(),
      description: document.getElementById('location-description').value.trim(),
    };
    const locationId = document.getElementById('location-id').value;
    try {
      await (locationId ? API.put(`/api/locations/${locationId}`, payload) : API.post('/api/locations', payload));
      UI.closeModal('location-modal');
      await refreshData();
      UI.toast(locationId ? 'Location updated.' : 'Location created.', 'success');
    } catch (error) {
      UI.showMessage(document.getElementById('location-form-message'), error.message);
    }
  });
});