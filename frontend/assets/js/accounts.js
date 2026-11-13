document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  function toLocalISO(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function computePresetDates(period) {
    const now = new Date();
    if (period === 'today') {
      const t = toLocalISO(now);
      return { start: t, end: t };
    }
    if (period === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      const yStr = toLocalISO(y);
      return { start: yStr, end: yStr };
    }
    if (period === 'this_week') {
      const day = now.getDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const mon = new Date(now);
      mon.setDate(now.getDate() + diff);
      return { start: toLocalISO(mon), end: toLocalISO(now) };
    }
    if (period === 'last_week') {
      const day = now.getDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const lastMon = new Date(now);
      lastMon.setDate(now.getDate() + diff - 7);
      const lastSun = new Date(now);
      lastSun.setDate(now.getDate() + diff - 1);
      return { start: toLocalISO(lastMon), end: toLocalISO(lastSun) };
    }
    if (period === 'this_month') {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: toLocalISO(first), end: toLocalISO(now) };
    }
    if (period === 'last_month') {
      const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endLast = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: toLocalISO(firstLast), end: toLocalISO(endLast) };
    }
    if (period === 'this_year') {
      const firstYear = new Date(now.getFullYear(), 0, 1);
      return { start: toLocalISO(firstYear), end: toLocalISO(now) };
    }
    if (period === 'all') {
      return { start: '', end: '' };
    }
    return { start: '', end: '' };
  }

  const defaultDates = computePresetDates('today');

  const accountsState = {
    period: 'today',
    company: '',
    startDate: defaultDates.start,
    endDate: defaultDates.end,
    search: '',
    activeTab: 'sales_invoices',
    lang: localStorage.getItem('malik_accounts_lang') || 'en',
    unlocked: false,
    data: null,
  };

  const URDU_DICT = {
    title: 'فنانشل اکاؤنٹس اور آڈٹ رپورٹ',
    subtitle: 'کاروباری ٹرانزیکشنز، برانڈ کارکردگی، اور جامع مالیاتی گوشوارہ۔',
    langBtn: 'View in English',
    langBtnEn: 'اردو میں دیکھیں',
    periodLabel: 'رپورٹنگ کا دورانیہ',
    companyLabel: 'کمپنی / برانڈ',
    allCompanies: 'تمام کمپنیاں',
    startDateLabel: 'ابتدائی تاریخ',
    endDateLabel: 'آخری تاریخ',
    searchPlaceholder: 'انوائس نمبر، خریدار، یا فون تلاش کریں...',
    filterBtn: 'فلٹر کریں',
    salesTotal: 'کل فروخت (آمدنی)',
    purchaseTotal: 'کل خریداری (لاگت)',
    grossProfit: 'مجموعی منافع',
    stockValue: 'موجودہ سٹاک مالیت',
    companyTitle: 'کمپنی وار مالیاتی کارکردگی',
    companySubtitle: 'منتخب کردہ دورانیے میں برانڈز کا منافع، خریداری اور فروخت کا تقابلی جائزہ۔',
    tabSales: 'فروخت کے بل (سیلز)',
    tabPurchases: 'خریداری کے بل (پرچیز)',
    noInvoices: 'اس دورانیے میں کوئی بل ریکارڈ نہیں ملا۔',
    viewBtn: 'تفصیل دیکھیں',
    colInvoice: 'بل نمبر',
    colDate: 'تاریخ',
    colParty: 'خریدار / سپلائر',
    colItems: 'سامان / ماڈلز',
    colQty: 'تعداد',
    colAmount: 'کل رقم',
    colStatus: 'حالت',
    colAction: 'کارروائی',
    periods: {
      today: 'آج',
      yesterday: 'گزشتہ کل',
      this_week: 'رواں ہفتہ',
      last_week: 'پچھلا ہفتہ',
      this_month: 'رواں ماہ',
      last_month: 'پچھلا ماہ',
      this_year: 'رواں سال',
      all: 'تمام ریکارڈز',
      custom: 'مخصوص تاریخ',
    },
  };

  function getDynamicPeriodTitle(period, sDate, eDate, isUrdu) {
    if (isUrdu) {
      if (period === 'today') return 'آج کا مالیاتی گوشوارہ';
      if (period === 'yesterday') return 'گزشتہ کل کا مالیاتی گوشوارہ';
      if (period === 'this_week') return 'رواں ہفتے کا مالیاتی گوشوارہ';
      if (period === 'last_week') return 'پچھلے ہفتے کا مالیاتی گوشوارہ';
      if (period === 'this_month') return 'رواں ماہ کا مالیاتی گوشوارہ';
      if (period === 'last_month') return 'پچھلے ماہ کا مالیاتی گوشوارہ';
      if (period === 'this_year') return 'رواں سال کا مالیاتی گوشوارہ';
      if (period === 'all') return 'تمام ریکارڈز کا مالیاتی گوشوارہ';
      return `${sDate || ''} تا ${eDate || ''} کا مالیاتی گوشوارہ`;
    }
    if (period === 'today') return "Today's Financial Summary";
    if (period === 'yesterday') return "Yesterday's Financial Summary";
    if (period === 'this_week') return "This Week's Financial Summary";
    if (period === 'last_week') return "Last Week's Financial Summary";
    if (period === 'this_month') return "This Month's Financial Summary";
    if (period === 'last_month') return "Last Month's Financial Summary";
    if (period === 'this_year') return "This Year's Financial Summary";
    if (period === 'all') return "All-Time Financial Summary";
    return `${sDate || 'Start'} to ${eDate || 'Present'} Financial Summary`;
  }

  function getMetricPrefix(period, isUrdu) {
    if (isUrdu) {
      if (period === 'today') return 'آج کی';
      if (period === 'yesterday') return 'گزشتہ کل کی';
      if (period === 'this_week') return 'رواں ہفتے کی';
      if (period === 'last_week') return 'پچھلے ہفتے کی';
      if (period === 'this_month') return 'رواں ماہ کی';
      if (period === 'last_month') return 'پچھلے ماہ کی';
      if (period === 'this_year') return 'رواں سال کی';
      if (period === 'all') return 'کل';
      return 'منتخب مدت کی';
    }
    if (period === 'today') return "Today's";
    if (period === 'yesterday') return "Yesterday's";
    if (period === 'this_week') return "This Week's";
    if (period === 'last_week') return "Last Week's";
    if (period === 'this_month') return "This Month's";
    if (period === 'last_month') return "Last Month's";
    if (period === 'this_year') return "This Year's";
    if (period === 'all') return "All-Time";
    return "Period";
  }

  function applyLanguage() {
    const isUrdu = accountsState.lang === 'ur';
    const mainEl = document.getElementById('accounts-main-container');
    if (mainEl) mainEl.dir = isUrdu ? 'rtl' : 'ltr';

    const btnLang = document.getElementById('btn-toggle-lang');
    if (btnLang) btnLang.textContent = isUrdu ? URDU_DICT.langBtn : URDU_DICT.langBtnEn;

    document.getElementById('txt-acc-title').textContent = isUrdu ? URDU_DICT.title : 'Accounts';
    document.getElementById('txt-acc-subtitle').textContent = isUrdu ? URDU_DICT.subtitle : 'Check daily sales, purchases, profit, and bills.';
    document.getElementById('txt-label-period').textContent = isUrdu ? URDU_DICT.periodLabel : 'Select Time';
    document.getElementById('txt-filter-company').textContent = isUrdu ? URDU_DICT.companyLabel : 'Company';
    document.getElementById('txt-filter-start').textContent = isUrdu ? URDU_DICT.startDateLabel : 'From Date';
    document.getElementById('txt-filter-end').textContent = isUrdu ? URDU_DICT.endDateLabel : 'To Date';
    document.getElementById('acc-search-input').placeholder = isUrdu ? URDU_DICT.searchPlaceholder : 'Search bill #, name, phone...';
    document.getElementById('btn-apply-filters').textContent = isUrdu ? URDU_DICT.filterBtn : 'Search';
    document.getElementById('txt-company-analysis-title').textContent = isUrdu ? URDU_DICT.companyTitle : 'Company Summary';
    document.getElementById('txt-company-analysis-subtitle').textContent = isUrdu ? URDU_DICT.companySubtitle : 'Sales, purchases, profit, and stock for each company.';
    document.getElementById('tab-btn-sales').textContent = isUrdu ? URDU_DICT.tabSales : 'Sale Bills';
    document.getElementById('tab-btn-purchases').textContent = isUrdu ? URDU_DICT.tabPurchases : 'Purchase Bills';

    document.querySelectorAll('#period-presets-strip [data-period]').forEach(btn => {
      const pKey = btn.dataset.period;
      if (isUrdu && URDU_DICT.periods[pKey]) {
        btn.textContent = URDU_DICT.periods[pKey];
      } else {
        const enMap = {
          today: 'Today', yesterday: 'Yesterday', this_week: 'This Week', last_week: 'Last Week',
          this_month: 'This Month', last_month: 'Last Month', this_year: 'This Year', all: 'All Time', custom: 'Custom Range'
        };
        btn.textContent = enMap[pKey] || pKey;
      }
    });
  }

  function syncAccountsLockButton() {
    const btn = document.getElementById('accounts-security-toggle');
    if (!btn) return;
    btn.textContent = accountsState.unlocked ? 'Lock accounts' : 'Unlock accounts';
    btn.classList.toggle('btn-accent', !accountsState.unlocked);
    btn.classList.toggle('btn-ghost', accountsState.unlocked);
  }

  async function fetchAccountsData() {
    const params = buildQuery({
      period: accountsState.period,
      company: accountsState.company,
      start_date: accountsState.startDate,
      end_date: accountsState.endDate,
    });
    const result = await API.get(`/api/accounts/summary?${params}`);
    accountsState.data = result;
    accountsState.unlocked = Boolean(result.can_view_accounts);
    syncAccountsLockButton();
    renderAll();
  }

  function accountCurrencyHTML(value) {
    if (!accountsState.unlocked) {
      return '<span class="currency-inline locked"><span class="currency-prefix">Rs</span> <span class="currency-amount masked">****</span></span>';
    }
    const safeValue = (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) ? 0 : Number(value);
    const raw = UI.formatCurrency(safeValue);
    const digits = raw.replace(/\D/g, '').length;
    const sizeClass = digits >= 13 ? 'tiny' : digits >= 10 ? 'compact' : 'normal';
    return `<span class="currency-inline ${sizeClass}"><span class="currency-prefix">Rs</span> <span class="currency-amount ${sizeClass}">${raw}</span></span>`;
  }

  function accountCurrencyText(value) {
    if (!accountsState.unlocked) return 'Rs ****';
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return 'Rs 0';
    return `Rs ${UI.formatCurrency(value)}`;
  }

  function renderKPIStats() {
    const d = accountsState.data;
    if (!d) return;
    const isUrdu = accountsState.lang === 'ur';
    const s = d.summary || {};
    const prefix = getMetricPrefix(accountsState.period, isUrdu);

    // Update dynamic header above cards
    document.getElementById('txt-summary-heading').textContent = getDynamicPeriodTitle(accountsState.period, d.start_date, d.end_date, isUrdu);
    const badgeEl = document.getElementById('txt-summary-period-badge');
    if (badgeEl) {
      badgeEl.textContent = d.start_date && d.end_date ? `${d.start_date} → ${d.end_date}` : (accountsState.period === 'all' ? 'All History' : d.period.toUpperCase());
    }

    const cards = [
      { label: `${prefix} ${isUrdu ? 'سیلز' : 'Total Sales'}`, val: s.sales_total, color: 'var(--green)', note: `${s.sales_count || 0} ${isUrdu ? 'انوائسز' : 'Sale Bills'}` },
      { label: `${prefix} ${isUrdu ? 'خریداری' : 'Total Purchases'}`, val: s.purchase_total, color: 'var(--blue-dark)', note: `${s.purchase_count || 0} ${isUrdu ? 'انوائسز' : 'Purchase Bills'}` },
      { label: `${prefix} ${isUrdu ? 'منافع' : 'Profit'}`, val: s.gross_profit, color: '#b45309', note: `${s.sold_units || 0} ${isUrdu ? 'فروخت شدہ آئٹمز' : 'Items Sold'}` },
      { label: isUrdu ? 'موجودہ اسٹاک ویلیو' : 'Stock Value', val: s.current_stock_value, color: 'var(--text)', note: `${s.current_stock_units || 0} ${isUrdu ? 'موجودہ یونٹس' : 'Items in Stock'}` },
    ];

    document.getElementById('account-stats').innerHTML = cards.map(c => `
      <article class="card stat-card" style="border-top: 4px solid ${c.color};">
        <div class="stat-label" style="font-weight: 800;">${escapeHtml(c.label)}</div>
        <div class="stat-value currency" style="color: ${c.color}; font-size: clamp(1.8rem, 2.4vw, 2.6rem);">${accountCurrencyHTML(c.val)}</div>
        <div class="stat-note" style="font-weight: 700; color: var(--muted);">${escapeHtml(c.note)}</div>
      </article>
    `).join('');
  }

  function renderCompanyBreakdown() {
    const list = accountsState.data?.company_breakdown || [];
    const wrap = document.getElementById('company-analysis-table-wrap');
    if (!wrap) return;
    const isUrdu = accountsState.lang === 'ur';

    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state">No company records available.</div>';
      return;
    }

    wrap.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem; text-align: ${isUrdu ? 'right' : 'left'};">
        <thead>
          <tr style="background: var(--surface-2); border-bottom: 2px solid var(--line);">
            <th style="padding: 10px 14px;">${isUrdu ? 'کمپنی / برانڈ' : 'Company'}</th>
            <th style="padding: 10px 14px; text-align: right;">${isUrdu ? 'سیلز آمدنی' : 'Sales Revenue'}</th>
            <th style="padding: 10px 14px; text-align: right;">${isUrdu ? 'پرچیز لاگت' : 'Purchases Spend'}</th>
            <th style="padding: 10px 14px; text-align: right;">${isUrdu ? 'منافع' : 'Gross Profit'}</th>
            <th style="padding: 10px 14px; text-align: center;">${isUrdu ? 'فروخت تعداد' : 'Sold Qty'}</th>
            <th style="padding: 10px 14px; text-align: center;">${isUrdu ? 'موجودہ سٹاک' : 'Stock Units'}</th>
            <th style="padding: 10px 14px; text-align: right;">${isUrdu ? 'سٹاک مالیت' : 'Stock Value'}</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(c => `
            <tr style="border-bottom: 1px solid var(--line);" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
              <td style="padding: 12px 14px; font-weight: 800; color: var(--blue-dark);">${escapeHtml(c.company)}</td>
              <td style="padding: 12px 14px; text-align: right;"><strong>${accountCurrencyHTML(c.sales_revenue)}</strong></td>
              <td style="padding: 12px 14px; text-align: right;">${accountCurrencyHTML(c.purchase_spend)}</td>
              <td style="padding: 12px 14px; text-align: right; color: ${c.gross_profit >= 0 ? 'var(--green)' : 'var(--red)'};">
                <strong>${accountCurrencyHTML(c.gross_profit)}</strong>
              </td>
              <td style="padding: 12px 14px; text-align: center; font-weight: 700;">${c.units_sold}</td>
              <td style="padding: 12px 14px; text-align: center; font-weight: 700;">${c.current_stock}</td>
              <td style="padding: 12px 14px; text-align: right;">${accountCurrencyHTML(c.stock_value)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderInvoicesTable() {
    const isUrdu = accountsState.lang === 'ur';
    const isSales = accountsState.activeTab === 'sales_invoices';
    const rawList = isSales ? (accountsState.data?.sales_invoices || []) : (accountsState.data?.purchase_invoices || []);
    const q = accountsState.search.trim().toLowerCase();

    const filtered = rawList.filter(inv => {
      if (!q) return true;
      const haystack = `${inv.invoice_number || inv.reference_no || ''} ${inv.customer_name || inv.supplier_name || ''} ${inv.phone_number || inv.supplier_phone || ''}`.toLowerCase();
      return haystack.includes(q);
    });

    const badge = document.getElementById('invoices-count-badge');
    if (badge) badge.textContent = `${filtered.length} ${isUrdu ? 'بل' : 'Invoices'}`;

    const wrap = document.getElementById('accounts-invoices-list');
    if (!wrap) return;

    if (!filtered.length) {
      wrap.innerHTML = `<div class="empty-state">${isUrdu ? URDU_DICT.noInvoices : 'No invoices recorded for this criteria.'}</div>`;
      return;
    }

    wrap.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.88rem; text-align: ${isUrdu ? 'right' : 'left'};">
        <thead>
          <tr style="background: var(--surface-2); border-bottom: 2px solid var(--line);">
            <th style="padding: 10px 14px;">${isUrdu ? URDU_DICT.colInvoice : 'Invoice #'}</th>
            <th style="padding: 10px 14px;">${isUrdu ? URDU_DICT.colDate : 'Date'}</th>
            <th style="padding: 10px 14px;">${isUrdu ? URDU_DICT.colParty : (isSales ? 'Customer' : 'Supplier')}</th>
            <th style="padding: 10px 14px;">${isUrdu ? URDU_DICT.colItems : 'Line Items'}</th>
            <th style="padding: 10px 14px; text-align: center;">${isUrdu ? URDU_DICT.colQty : 'Qty'}</th>
            <th style="padding: 10px 14px; text-align: right;">${isUrdu ? URDU_DICT.colAmount : 'Total Amount'}</th>
            <th style="padding: 10px 14px; text-align: center;">${isUrdu ? URDU_DICT.colStatus : 'Status'}</th>
            <th style="padding: 10px 14px; text-align: center;">${isUrdu ? URDU_DICT.colAction : 'Actions'}</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(inv => {
            const no = inv.invoice_number || inv.reference_no;
            const party = inv.customer_name || inv.supplier_name || 'N/A';
            const phone = inv.phone_number || inv.supplier_phone || '';
            const items = inv.items || [];
            const itemsSummary = items.length === 1
              ? `${escapeHtml(items[0].model || 'Item')} (${escapeHtml(items[0].company || '')})`
              : `${items.length} Products: ${items.slice(0, 2).map(i => escapeHtml(i.model)).join(', ')}${items.length > 2 ? '...' : ''}`;

            return `
              <tr style="border-bottom: 1px solid var(--line);" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
                <td style="padding: 12px 14px; font-weight: 800; color: var(--blue-dark);">${escapeHtml(no)}</td>
                <td style="padding: 12px 14px; color: var(--muted);">${UI.formatDate(inv.date)}</td>
                <td style="padding: 12px 14px;">
                  <div style="font-weight: 780;">${escapeHtml(party)}</div>${phone ? `<div style="font-size: 0.78rem; color: var(--muted);">${escapeHtml(phone)}</div>` : ''}
                </td>
                <td style="padding: 12px 14px; color: var(--text);">${itemsSummary}</td>
                <td style="padding: 12px 14px; text-align: center; font-weight: 800;">${inv.total_quantity}</td>
                <td style="padding: 12px 14px; text-align: right;" class="price-safe-box">
                  <strong style="color: var(--blue-dark); font-size: 1rem;">${UI.currencyHTML(inv.total_amount)}</strong>
                </td>
                <td style="padding: 12px 14px; text-align: center;">
                  <span class="badge ${inv.status === 'Paid' ? 'success' : 'warning'}">${inv.status || 'Recorded'}</span>
                </td>
                <td style="padding: 12px 14px; text-align: center;">
                  <button class="btn-ghost small btn-view-acc-inv" type="button" data-inv-key="${escapeHtml(no)}">${isUrdu ? URDU_DICT.viewBtn : 'View'}</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function renderAll() {
    renderKPIStats();
    renderCompanyBreakdown();
    renderInvoicesTable();
    // Force masking in accounts cards if Accounts lock is active
    if (!accountsState.unlocked) {
      document.querySelectorAll('#accounts-main-container [data-sensitive="price"]').forEach(el => {
        el.classList.add('locked');
        el.innerHTML = '<span class="currency-prefix">Rs</span> <span class="currency-amount masked">****</span>';
      });
    }
  }
function openInvoiceDetailModal(invKey) {
    const isSales = accountsState.activeTab === 'sales_invoices';
    const list = isSales ? (accountsState.data?.sales_invoices || []) : (accountsState.data?.purchase_invoices || []);
    const inv = list.find(x => (x.invoice_number || x.reference_no) === invKey);
    if (!inv) return;

    const no = inv.invoice_number || inv.reference_no;
    const party = inv.customer_name || inv.supplier_name || 'Walk-in Customer';
    const phone = inv.phone_number || inv.supplier_phone || 'N/A';
    const items = inv.items || [];

    document.getElementById('acc-invoice-modal-title').textContent = `Invoice #${no}`;
    document.getElementById('acc-invoice-modal-body').innerHTML = `
      <div class="print-invoice-sheet" style="padding: 16px; border: 1px solid #cbd5e1; border-radius: 12px; background: #fff;">
        <div style="display: flex; justify-content: space-between; align-items: start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 14px;">
          <div>
            <h1 style="font-size: 1.45rem; font-weight: 900; margin: 0; color: #0f172a;">MALIK ELECTRONIC</h1>
            <div style="font-size: 0.84rem; color: #475569;">Branch: <strong>${escapeHtml(accountsState.data?.branch_name || 'Main Branch')}</strong></div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 1.15rem; font-weight: 800; color: #0f172a;">${escapeHtml(no)}</div>
            <div style="font-size: 0.82rem; color: #475569;">Date: ${UI.formatDate(inv.date)}</div>
            <span class="badge ${inv.status === 'Paid' ? 'success' : 'info'}" style="margin-top: 4px;">${escapeHtml(inv.status || 'Recorded')}</span>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: 14px;">
          <div>
            <div style="font-size: 0.72rem; font-weight: 800; color: #64748b; text-transform: uppercase;">${isSales ? 'Customer Details' : 'Supplier Details'}</div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">${escapeHtml(party)}</div>
            <div style="font-size: 0.82rem; color: #334155;">Phone: ${escapeHtml(phone)}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 0.72rem; font-weight: 800; color: #64748b; text-transform: uppercase;">Transaction Type</div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #0f172a;">${isSales ? 'Customer Sale Invoice' : 'Supplier Purchase Invoice'}</div>
          </div>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left; margin-bottom: 14px;">
          <thead>
            <tr style="background: #0f172a; color: #fff;">
              <th style="padding: 8px 10px;">Category</th>
              <th style="padding: 8px 10px;">Company / Brand</th>
              <th style="padding: 8px 10px;">Model</th>
              <th style="padding: 8px 10px;">Color</th>
              <th style="padding: 8px 10px; text-align: center;">Qty</th>
              <th style="padding: 8px 10px; text-align: right;">Unit Price</th>
              <th style="padding: 8px 10px; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(it => {
              const unitPrice = isSales ? it.unit_price : it.unit_cost;
              const lineTot = isSales ? it.line_revenue : it.line_spend;
              return `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 8px 10px;"><span style="background:#dbeafe; color:#1e40af; font-weight:800; font-size:0.74rem; padding:2px 7px; border-radius:5px;">${escapeHtml(it.category_name || it.category || 'Appliance')}</span></td>
                  <td style="padding: 8px 10px; font-weight: 700; color: #0f172a;">${escapeHtml(it.company || '-')}</td>
                  <td style="padding: 8px 10px; font-weight: 800; color: #0f172a;">${escapeHtml(it.model)}</td>
                  <td style="padding: 8px 10px; color: #475569;">${escapeHtml(it.color || 'Standard')}</td>
                  <td style="padding: 8px 10px; text-align: center; font-weight: 800;">${it.quantity}</td>
                  <td style="padding: 8px 10px; text-align: right;">${UI.currencyText(unitPrice)}</td>
                  <td style="padding: 8px 10px; text-align: right; font-weight: 800; color: #0f172a;">${UI.currencyText(lineTot)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>

        <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
          <div style="width: 250px; font-size: 0.98rem; display: flex; justify-content: space-between; border-top: 2px solid #0f172a; padding-top: 8px; font-weight: 900;">
            <span>Grand Total:</span>
            <span style="color: var(--blue-dark);">${UI.currencyText(inv.total_amount)}</span>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btn-acc-print-modal').onclick = () => window.print();
    UI.openModal('acc-invoice-modal');
  }
  function exportWordReport() {
    const d = accountsState.data;
    if (!d) return;
    const s = d.summary || {};
    const branch = d.branch_name || 'Main Branch';
    const branchAddr = d.branch_address || '';
    const now = new Date().toLocaleString('en-PK');
    const compFilter = accountsState.company || 'All Companies';
    const periodLabel = accountsState.period.toUpperCase();

    const htmlDoc = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head><meta charset='utf-8'><title>Malik Electronic Report</title>
      <style>
        body { font-family: 'Calibri', 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #1e293b; margin: 30px; }
        h1 { font-size: 20pt; margin: 0; color: #0f172a; font-weight: 900; }
        h2 { font-size: 14pt; margin: 20px 0 8px 0; color: #1e3a8a; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; }
        .meta-box { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; margin-bottom: 20px; font-size: 10pt; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 20px; font-size: 10pt; }
        th { background: #0f172a; color: #ffffff; padding: 6px 10px; font-weight: bold; border: 1px solid #0f172a; text-align: left; }
        td { padding: 6px 10px; border: 1px solid #e2e8f0; }
        .kpi-table th { background: #1e3a8a; }
        .right { text-align: right; }
        .center { text-align: center; }
        .bold { font-weight: bold; }
      </style>
      </head>
      <body>
        <h1>MALIK ELECTRONIC</h1>
        <div style="font-size: 10.5pt; color: #64748b;">${escapeHtml(branch)} — ${escapeHtml(branchAddr)}</div>
        <div style="font-size: 13pt; font-weight: bold; color: #1e3a8a; margin-top: 8px;">FINANCIAL AUDIT &amp; TRANSACTION REPORT</div>
        
        <div class="meta-box">
          <div><strong>Report Period:</strong> ${escapeHtml(periodLabel)} (${d.start_date || 'Inception'} to ${d.end_date || 'Present'})</div>
          <div><strong>Brand Filter:</strong> ${escapeHtml(compFilter)}</div>
          <div><strong>Generated On:</strong> ${now}</div>
        </div>

        <h2>Executive Financial Summary</h2>
        <table class="kpi-table">
          <tr><th>Metric</th><th class="right">Amount (PKR)</th><th>Operational Notes</th></tr>
          <tr><td class="bold">Sales Revenue</td><td class="right bold">${UI.currencyText(s.sales_total)}</td><td>${s.sales_count || 0} Invoices, ${s.sold_units || 0} Units Sold</td></tr>
          <tr><td class="bold">Purchases Spend</td><td class="right bold">${UI.currencyText(s.purchase_total)}</td><td>${s.purchase_count || 0} Invoices, ${s.purchased_units || 0} Units Purchased</td></tr>
          <tr><td class="bold">Gross Profit</td><td class="right bold">${UI.currencyText(s.gross_profit)}</td><td>Computed from exact cost of sold stock</td></tr>
          <tr><td class="bold">Current Stock Valuation</td><td class="right bold">${UI.currencyText(s.current_stock_value)}</td><td>${s.current_stock_units || 0} Units currently available</td></tr>
        </table>

        <h2>Brand Performance Breakdown</h2>
        <table>
          <tr><th>Company</th><th class="right">Sales Revenue</th><th class="right">Purchases</th><th class="right">Gross Profit</th><th class="center">Sold</th><th class="center">Stock</th><th class="right">Stock Value</th></tr>
          ${(d.company_breakdown || []).map(c => `
            <tr>
              <td class="bold">${escapeHtml(c.company)}</td>
              <td class="right">${UI.currencyText(c.sales_revenue)}</td>
              <td class="right">${UI.currencyText(c.purchase_spend)}</td>
              <td class="right bold">${UI.currencyText(c.gross_profit)}</td>
              <td class="center">${c.units_sold}</td>
              <td class="center">${c.current_stock}</td>
              <td class="right">${UI.currencyText(c.stock_value)}</td>
            </tr>
          `).join('')}
        </table>

        <h2>Sales Invoices Ledger (${(d.sales_invoices || []).length} Records)</h2>
        <table>
          <tr><th>Invoice #</th><th>Date</th><th>Customer</th><th>Items</th><th class="center">Qty</th><th class="right">Total Amount</th><th class="center">Status</th></tr>
          ${(d.sales_invoices || []).map(inv => `
            <tr>
              <td class="bold">${escapeHtml(inv.invoice_number)}</td>
              <td>${inv.date}</td>
              <td>${escapeHtml(inv.customer_name)}</td>
              <td>${(inv.items || []).map(i => `${escapeHtml(i.model)} (x${i.quantity})`).join(', ')}</td>
              <td class="center">${inv.total_quantity}</td>
              <td class="right bold">${UI.currencyText(inv.total_amount)}</td>
              <td class="center">${inv.status}</td>
            </tr>
          `).join('')}
        </table>

        <h2>Purchase Invoices Ledger (${(d.purchase_invoices || []).length} Records)</h2>
        <table>
          <tr><th>Invoice #</th><th>Date</th><th>Supplier</th><th>Items</th><th class="center">Qty</th><th class="right">Total Spend</th></tr>
          ${(d.purchase_invoices || []).map(inv => `
            <tr>
              <td class="bold">${escapeHtml(inv.reference_no)}</td>
              <td>${inv.date}</td>
              <td>${escapeHtml(inv.supplier_name)}</td>
              <td>${(inv.items || []).map(i => `${escapeHtml(i.model)} (x${i.quantity})`).join(', ')}</td>
              <td class="center">${inv.total_quantity}</td>
              <td class="right bold">${UI.currencyText(inv.total_amount)}</td>
            </tr>
          `).join('')}
        </table>

        <div style="font-size: 8.5pt; color: #94a3b8; text-align: center; border-top: 1px solid #cbd5e1; padding-top: 8px; margin-top: 30px;">
          Official Malik Electronic ERP Document. Confidential Financial Audit.
        </div>
      </body>
      </html>
    `;

    const blob = new Blob(['\ufeff', htmlDoc], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Malik-Electronic-Financial-Report-${accountsState.period}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    UI.toast('Word report generated successfully.', 'success');
  }

  // --- INITIALIZE UI & LISTENERS ---
  applyLanguage();

  const meta = await API.get('/api/meta');
  const companies = meta.company_options || [];
  const compSelect = document.getElementById('acc-company-filter');
  if (compSelect) {
    UI.populateSelect(compSelect, companies.map(c => ({ id: c, name: c })), { includeAll: true, allLabel: 'All Companies' });
  }

  // Handle Preset Period Click (Correct local dates & highlight active preset)
  document.getElementById('period-presets-strip')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    document.querySelectorAll('#period-presets-strip [data-period]').forEach(b => {
      b.classList.remove('active');
      b.style.fontWeight = 'normal';
    });
    btn.classList.add('active');
    btn.style.fontWeight = '800';

    accountsState.period = btn.dataset.period;
    if (accountsState.period !== 'custom') {
      const dates = computePresetDates(accountsState.period);
      accountsState.startDate = dates.start;
      accountsState.endDate = dates.end;
      document.getElementById('acc-start-date').value = dates.start;
      document.getElementById('acc-end-date').value = dates.end;
    }
    await fetchAccountsData();
  });

  // Filter Form Submit
  document.getElementById('accounts-filter-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    accountsState.company = document.getElementById('acc-company-filter').value;
    accountsState.startDate = document.getElementById('acc-start-date').value;
    accountsState.endDate = document.getElementById('acc-end-date').value;
    accountsState.search = document.getElementById('acc-search-input').value;
    if (accountsState.startDate || accountsState.endDate) {
      accountsState.period = 'custom';
      document.querySelectorAll('#period-presets-strip [data-period]').forEach(b => {
        const isCustom = b.dataset.period === 'custom';
        b.classList.toggle('active', isCustom);
        b.style.fontWeight = isCustom ? '800' : 'normal';
      });
    }
    await fetchAccountsData();
  });

  // Dedicated Accounts Lock / Unlock Button
  document.getElementById('accounts-security-toggle')?.addEventListener('click', async () => {
    // If Accounts is currently unlocked, lock immediately (zero key/password required)
    if (accountsState.unlocked) {
      try {
        await API.post('/api/accounts/auth/lock');
        accountsState.unlocked = false;
        syncAccountsLockButton();
        UI.toast('Accounts locked.', 'info');
        await fetchAccountsData();
      } catch (err) {
        location.reload();
      }
      return;
    }

    // If locked, open dedicated Accounts Unlock Modal
    document.getElementById('accounts-security-key-input').value = '';
    document.getElementById('accounts-unlock-error').textContent = '';
    UI.openModal('accounts-unlock-modal');
    setTimeout(() => document.getElementById('accounts-security-key-input')?.focus(), 150);
  });

  // Biometric Accounts Unlock
  document.getElementById('btn-biometric-acc-unlock')?.addEventListener('click', async () => {
    const errorEl = document.getElementById('accounts-unlock-error');
    if (errorEl) errorEl.textContent = '';
    try {
      const bio = await UI.authenticateBiometric('unlock_accounts');
      if (bio?.verified) {
        await API.post('/api/accounts/auth/unlock', {
          security_key: bio.verification_token || bio.security_code,
          biometric_token: bio.verification_token
        });
        UI.closeModal('accounts-unlock-modal');
        UI.toast('Accounts unlocked via Biometrics.', 'success');
        accountsState.unlocked = true;
        syncAccountsLockButton();
        await fetchAccountsData();
      }
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || 'Biometric verification failed. Enter verification password below.';
    }
  });

  // Submit Accounts Security Key Unlock
  document.getElementById('accounts-unlock-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const enteredKey = document.getElementById('accounts-security-key-input').value.trim();
    const errorEl = document.getElementById('accounts-unlock-error');
    const submitBtn = document.getElementById('btn-submit-acc-unlock');
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying...';

    try {
      await API.post('/api/accounts/auth/unlock', { security_key: enteredKey });
      UI.closeModal('accounts-unlock-modal');
      UI.toast('Accounts unlocked successfully.', 'success');
      accountsState.unlocked = true;
      syncAccountsLockButton();
      await fetchAccountsData();
    } catch (err) {
      errorEl.textContent = 'Invalid security key. Accounts remain protected.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock Accounts';
    }
  });

  // Tab switching: Sales Invoices vs Purchase Invoices
  document.getElementById('acc-tab-strip')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-acc-tab]');
    if (!btn) return;
    document.querySelectorAll('#acc-tab-strip [data-acc-tab]').forEach(b => {
      b.classList.remove('active');
      b.style.borderColor = '';
      b.style.fontWeight = 'normal';
    });
    btn.classList.add('active');
    btn.style.borderColor = 'var(--blue-dark)';
    btn.style.fontWeight = '800';

    accountsState.activeTab = btn.dataset.accTab;
    renderInvoicesTable();
  });

  // Live search invoices
  document.getElementById('acc-search-input')?.addEventListener('input', (e) => {
    accountsState.search = e.target.value;
    renderInvoicesTable();
  });

  // Invoices Table delegation (View details)
  document.getElementById('accounts-invoices-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-view-acc-inv');
    if (btn) openInvoiceDetailModal(btn.dataset.invKey);
  });

  // Word Export button
  document.getElementById('btn-export-word')?.addEventListener('click', exportWordReport);

  // Excel Export button
  document.getElementById('btn-export-excel')?.addEventListener('click', async () => {
    const params = buildQuery({
      start_date: accountsState.startDate,
      end_date: accountsState.endDate,
    });
    const token = localStorage.getItem('malik_token');
    const resp = await fetch(`/api/exports/report?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      alert('Unlock Accounts first to export spreadsheet reports.');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Malik-Electronic-Financial-Report-${accountsState.period}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    UI.toast('Excel report downloaded.', 'success');
  });

  // Language Switcher Toggle
  document.getElementById('btn-toggle-lang')?.addEventListener('click', () => {
    accountsState.lang = accountsState.lang === 'ur' ? 'en' : 'ur';
    localStorage.setItem('malik_accounts_lang', accountsState.lang);
    applyLanguage();
    renderAll();
  });

  // Initial load: Default to Today
  document.getElementById('acc-start-date').value = defaultDates.start;
  document.getElementById('acc-end-date').value = defaultDates.end;
  await fetchAccountsData();
});