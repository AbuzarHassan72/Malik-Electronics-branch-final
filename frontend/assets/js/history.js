let historyCategories = [];

async function loadHistoryTab(tab) {
  const filters = buildQuery({
    category_id: document.getElementById('history-category').value,
    start_date: document.getElementById('history-start-date').value,
    end_date: document.getElementById('history-end-date').value,
    customer: document.getElementById('history-customer').value,
    supplier: document.getElementById('history-supplier').value,
  });
  const endpoint = tab === 'purchases' ? '/history/purchases' : tab === 'sales' ? '/history/sales' : '/history/accounts';
  const rows = await API.get(`${endpoint}?${filters}`);
  const wrap = document.getElementById('history-results');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state">No records found for this section.</div>';
    return;
  }
  if (tab === 'accounts') {
    wrap.innerHTML = rows.map(row => `
      <div class="record-card">
        <div class="record-top">
          <div>
            <h4 class="record-title">${row.transaction_type}</h4>
            <div class="record-meta"><span>${UI.formatDate(row.transaction_date)}</span><span>${row.party_name || '-'}</span><span>${row.category_name || '-'}</span></div>
          </div>
          <span class="badge ${row.direction === 'in' ? 'success' : 'warning'}">${row.direction === 'in' ? 'Money in' : 'Money out'}</span>
        </div>
        <div class="record-kpis">
          <div class="kpi-box"><div class="label">Amount</div><div class="value">${UI.currencyText(row.amount)}</div></div>
          <div class="kpi-box"><div class="label">Status</div><div class="value">${row.status}</div></div>
          <div class="kpi-box"><div class="label">Product</div><div class="value">${row.product_label || '-'}</div></div>
        </div>
        <div class="muted">${row.description || '-'}</div>
      </div>
    `).join('');
    return;
  }
  wrap.innerHTML = rows.map(row => `
    <div class="record-card">
      <div class="record-top">
        <div>
          <h4 class="record-title">${row.product_label}</h4>
          <div class="record-meta"><span>${row.category_name}</span><span>${UI.formatDate(tab === 'purchases' ? row.purchase_date : row.sale_date)}</span><span>${tab === 'purchases' ? (row.supplier_name || '-') : (row.customer_name || '-')}</span></div>
        </div>
        <span class="badge ${tab === 'purchases' ? 'info' : 'success'}">${tab === 'purchases' ? 'Purchase' : 'Sale'}</span>
      </div>
      <div class="record-kpis">
        <div class="kpi-box"><div class="label">Quantity</div><div class="value">${row.quantity}</div></div>
        <div class="kpi-box"><div class="label">Rate</div><div class="value">${UI.currencyText(tab === 'purchases' ? row.unit_cost : row.unit_price)}</div></div>
        <div class="kpi-box"><div class="label">Total</div><div class="value">${UI.currencyText(row.total_amount)}</div></div>
        ${tab === 'sales' ? `<div class="kpi-box"><div class="label">Profit</div><div class="value">${UI.currencyText(row.total_profit)}</div></div>` : ''}
      </div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  historyCategories = await API.get('/api/categories');
  UI.populateSelect(document.getElementById('history-category'), historyCategories, { includeAll: true, allLabel: 'All categories' });
  let activeTab = 'purchases';
  await loadHistoryTab(activeTab);

  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      activeTab = button.dataset.tab;
      await loadHistoryTab(activeTab);
    });
  });

  document.getElementById('history-filter-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadHistoryTab(activeTab);
  });
});
