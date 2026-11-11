document.addEventListener('DOMContentLoaded', async () => {
  const loginView = document.getElementById('login-view');
  const branchView = document.getElementById('branch-view');
  const loginForm = document.getElementById('login-form');
  const updateForm = document.getElementById('credential-update-form');
  const loginMessage = document.getElementById('login-message');
  const updateMessage = document.getElementById('credential-message');
  const updateSection = document.getElementById('credential-update-section');
  const toggleResetBtn = document.getElementById('toggle-reset-btn');
  const cancelResetBtn = document.getElementById('cancel-reset-btn');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  
  let availableBranches = [];

  if (new URLSearchParams(window.location.search).get('expired') === '1') {
    UI.showMessage(loginMessage, 'Your session expired after 15 minutes of inactivity. Please sign in again.', true);
  }

  document.querySelectorAll('[data-toggle-password]').forEach(button => {
    button.addEventListener('click', () => togglePasswordVisibility(button, button.dataset.togglePassword));
  });

  // --- UI Transitions ---
  function showBranchSelection(branches) {
    loginView.classList.add('hidden');
    branchView.classList.remove('hidden');
    availableBranches = branches;
    renderBranches();
  }

  function renderBranches() {
    const grid = document.getElementById('branch-grid');
    if (!availableBranches.length) {
      grid.innerHTML = '<div class="notice-card" style="grid-column: 1/-1;">No branches found. Please create one.</div>';
      return;
    }
    
    grid.innerHTML = availableBranches.map(b => `
      <article class="branch-card ${b.status === 'Closed' ? 'closed' : ''}" data-branch-id="${b.id}">
        ${b.image_path ? `<img src="${b.image_path}" class="branch-image" alt="Branch">` : `<div class="branch-image" style="display:grid; place-items:center; font-weight:800; color:#94a3b8;">No Image</div>`}
        <div>
          <div style="display:flex; justify-content:space-between; align-items:start;">
            <h3 class="branch-title">${escapeHtml(b.name)}</h3>
            <span class="badge ${b.status === 'Closed' ? 'danger' : 'success'}">${b.status}</span>
          </div>
          <div class="branch-address" style="margin-top:6px;">${escapeHtml(b.address || 'No address provided')}</div>
        </div>
        <button class="btn${b.status === 'Closed' ? '-ghost' : ''}" type="button" style="width: 100%; margin-top: 8px;">
          ${b.status === 'Closed' ? 'View Historical Data' : 'Enter Dashboard'}
        </button>
        <button class="btn-ghost small edit-branch-btn" type="button" data-edit-id="${b.id}" style="position:absolute; top:12px; right:12px; opacity:0; transition: opacity 0.2s;">Edit</button>
      </article>
    `).join('');

    // Hover effect to reveal edit button
    document.querySelectorAll('.branch-card').forEach(card => {
      card.addEventListener('mouseenter', () => { card.querySelector('.edit-branch-btn').style.opacity = '1'; });
      card.addEventListener('mouseleave', () => { card.querySelector('.edit-branch-btn').style.opacity = '0'; });
    });
  }

  // --- Session Checks ---
  const savedToken = localStorage.getItem('malik_token');
  if (savedToken) {
    try {
      const meta = await API.get('/api/app-state'); // verifies token silently
      showBranchSelection(meta.branches || []);
    } catch {
      localStorage.removeItem('malik_token');
      localStorage.removeItem('malik_user');
    }
  }

  // --- Event Listeners ---
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showMessage(loginMessage, '');
    try {
      const payload = { username: usernameInput.value.trim(), password: passwordInput.value };
      const result = await API.post('/api/auth/login', payload);
      
      // Save credentials but DO NOT redirect to dashboard yet.
      localStorage.setItem('malik_token', result.access_token);
      localStorage.setItem('malik_user', JSON.stringify(result.user));
      
      showBranchSelection(result.branches || []);
    } catch (error) {
      UI.showMessage(loginMessage, error.message);
    }
  });

  document.getElementById('branch-grid').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.edit-branch-btn');
    if (editBtn) {
      e.stopPropagation();
      const branch = availableBranches.find(b => String(b.id) === String(editBtn.dataset.editId));
      if (branch) openBranchModal(branch);
      return;
    }
    
    const card = e.target.closest('.branch-card');
    if (card) {
      // 1. Set the branch ID cookie persistently
      document.cookie = `malik_branch_id=${card.dataset.branchId}; path=/; max-age=31536000`;
      // 2. ONLY NOW redirect to the dashboard
      location.href = '/dashboard';
    }
  });

  document.getElementById('signout-session-btn').addEventListener('click', () => {
    localStorage.removeItem('malik_token');
    localStorage.removeItem('malik_user');
    document.cookie = "malik_branch_id=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    location.reload(); // Hard reload required
  });

  // --- Branch Management Modal ---
  document.getElementById('btn-manage-branches').addEventListener('click', () => openBranchModal());

  function openBranchModal(branch = null) {
    document.getElementById('branch-form').reset();
    document.getElementById('branch-id').value = branch?.id || '';
    document.getElementById('branch-name').value = branch?.name || '';
    document.getElementById('branch-address').value = branch?.address || '';
    document.getElementById('branch-description').value = branch?.description || '';
    document.getElementById('branch-status').value = branch?.status || 'Active';
    document.getElementById('branch-image-path').value = branch?.image_path || '';
    document.getElementById('branch-modal-title').textContent = branch ? 'Edit Branch' : 'New Branch';
    UI.openModal('branch-modal');
  }

  document.getElementById('branch-image-upload').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await API.upload('/api/uploads/branch-image', form);
      document.getElementById('branch-image-path').value = result.path;
      UI.toast("Image uploaded successfully", "success");
    } catch (error) { alert(error.message); }
  });

  document.getElementById('branch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('branch-id').value;
    const payload = {
      name: document.getElementById('branch-name').value.trim(),
      address: document.getElementById('branch-address').value.trim(),
      description: document.getElementById('branch-description').value.trim(),
      status: document.getElementById('branch-status').value,
      image_path: document.getElementById('branch-image-path').value
    };
    try {
      if (id) await API.put(`/api/branches/${id}`, payload);
      else await API.post('/api/branches', payload);
      UI.closeModal('branch-modal');
      // Reload branch list
      availableBranches = await API.get('/api/branches');
      renderBranches();
      UI.toast("Branch saved.", "success");
    } catch (err) { UI.showMessage(document.getElementById('branch-form-message'), err.message); }
  });

  // --- Password Reset & Security Key ---
  toggleResetBtn.addEventListener('click', () => {
    updateSection.classList.remove('hidden');
    document.getElementById('current-username').value = usernameInput.value || '';
    updateSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  cancelResetBtn.addEventListener('click', () => {
    updateSection.classList.add('hidden');
    updateForm.reset();
    UI.showMessage(updateMessage, '');
  });

  updateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showMessage(updateMessage, '');
    const submitBtn = event.currentTarget.querySelector('button[type="submit"]');
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Authorizing...';
    try {
      const payload = {
        current_username: document.getElementById('current-username').value.trim(),
        current_password: document.getElementById('current-password').value,
        new_username: document.getElementById('new-username').value.trim(),
        new_password: document.getElementById('new-password').value,
        confirm_password: document.getElementById('confirm-password').value,
        security_key: document.getElementById('security-key').value // NEW
      };
      const result = await API.post('/api/auth/update-credentials', payload);
      localStorage.setItem('malik_token', result.access_token);
      localStorage.setItem('malik_user', JSON.stringify(result.user));
      UI.showMessage(updateMessage, 'Authorized. Credentials updated successfully.', false);
      setTimeout(() => location.reload(), 1500);
    } catch (error) {
      UI.showMessage(updateMessage, error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
});