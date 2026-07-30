// ── Constants ────────────────────────────────────────────────────
const CATS = [
  { id: '餐飲', icon: '🍜', color: '#FF9500' },
  { id: '交通', icon: '🚅', color: '#0076D6' },
  { id: '購物', icon: '🛍️', color: '#AF52DE' },
  { id: '住宿', icon: '🏨', color: '#30B0C7' },
  { id: '娛樂', icon: '🎯', color: '#FF2D55' },
  { id: '其他', icon: '📦', color: '#8E8E93' },
]
const PMETHODS = ['現金', '信用卡', 'Suica（IC卡）', 'PayPay', '全支付', '玉山電支', 'Apple Pay', '其他']

// ── State ────────────────────────────────────────────────────────
let expenses = []
let settings = { exchangeRate: 0.22, geminiApiKey: '', payers: ['我', 'yh', 'carol'], cards: ['富邦J', '永豐大戶', '星展'], firebaseConfig: { apiKey: '', projectId: '' }, tripId: '' }
let editingId = null
let scanFiles = []
let scanResult = null
let db = null
let fsUnsubscribe = null
let expandedDates = null  // null = 尚未初始化
let activeCatFilter = null  // null = 全部

// ── Persistence ──────────────────────────────────────────────────
function load() {
  try { expenses = JSON.parse(localStorage.getItem('expenses') || '[]') } catch { expenses = [] }
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem('settings') || '{}') } } catch {}
  if (!Array.isArray(settings.payers) || settings.payers.length === 0) settings.payers = ['我']
  // 合併預設付款人和信用卡（不覆蓋已有的）
  const defaultPayers = ['我', 'yh', 'carol']
  const defaultCards  = ['富邦J', '永豐大戶', '星展']
  defaultPayers.forEach(p => { if (!settings.payers.includes(p)) settings.payers.push(p) })
  if (!Array.isArray(settings.cards)) settings.cards = []
  defaultCards.forEach(c => { if (!settings.cards.includes(c)) settings.cards.push(c) })
}

function save() {
  localStorage.setItem('expenses', JSON.stringify(expenses))
  localStorage.setItem('settings', JSON.stringify(settings))
}

// ── Helpers ──────────────────────────────────────────────────────
function fmt(n) { return '¥' + Math.round(n).toLocaleString() }
function fmtTWD(jpy) {
  const r = parseFloat(settings.exchangeRate) || 0.22
  return 'NT$' + Math.round(jpy * r).toLocaleString()
}
function todayStr() { return new Date().toISOString().slice(0, 10) }
function catById(id) { return CATS.find(c => c.id === id) || CATS[5] }
function itemTotal(it) { return (parseFloat(it.price) || 0) * (parseInt(it.quantity) || 1) }
function mainCat(exp) {
  if (!exp.items || exp.items.length === 0) return CATS[5]
  const counts = {}
  for (const it of exp.items) { counts[it.category] = (counts[it.category] || 0) + itemTotal(it) }
  const top = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]
  return catById(top ? top[0] : '其他')
}
function calcTotal(items, discounts, tax8, tax10, taxFree, serviceCharge) {
  const sum = (items || []).reduce((s, it) => s + itemTotal(it), 0)
  const dis = (discounts || []).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0)
  return Math.max(0, sum
    + (parseFloat(tax8) || 0)
    + (parseFloat(tax10) || 0)
    + (parseFloat(serviceCharge) || 0)
    - dis
    - (parseFloat(taxFree) || 0)
  )
}

// ── Firebase ──────────────────────────────────────────────────────
function isFirebaseReady() {
  return !!(db && settings.tripId && settings.tripId.length > 0)
}

function updateFirebaseStatus(msg) {
  const el = document.getElementById('firebase-status')
  if (el) el.textContent = msg
  const inviteWrap = document.getElementById('invite-btn-wrap')
  if (inviteWrap) inviteWrap.style.display = isFirebaseReady() ? '' : 'none'
}

function generateInviteLink() {
  const cfg = settings.firebaseConfig || {}
  if (!cfg.apiKey || !cfg.projectId || !settings.tripId) {
    showToast('請先連接 Firebase')
    return
  }
  const encoded = encodeURIComponent(btoa(JSON.stringify({ k: cfg.apiKey, p: cfg.projectId, t: settings.tripId })))
  const url = location.origin + location.pathname + '?c=' + encoded
  if (navigator.share) {
    navigator.share({ title: '旅遊記帳', text: '點連結加入共同記帳', url })
  } else {
    navigator.clipboard.writeText(url)
      .then(() => showToast('邀請連結已複製！'))
      .catch(() => prompt('複製此連結給旅伴：', url))
  }
}

function applyInviteLink() {
  const params = new URLSearchParams(location.search)
  // 清除強制更新留下的 ?_= 時間戳記
  if (params.has('_')) {
    history.replaceState(null, '', location.pathname)
    return
  }
  const c = params.get('c')
  if (!c) return
  try {
    const data = JSON.parse(atob(c))
    if (!data.k || !data.p || !data.t) return
    settings.firebaseConfig = { apiKey: data.k, projectId: data.p }
    settings.tripId = data.t
    save()
    history.replaceState(null, '', location.pathname)
    showToast('已從邀請連結自動連接！')
  } catch {}
}

function pasteInviteLink() {
  const val = (document.getElementById('paste-invite-input').value || '').trim()
  if (!val) { showToast('請貼上邀請連結'); return }
  try {
    const url = new URL(val)
    const c = new URLSearchParams(url.search).get('c')
    if (!c) { showToast('連結格式不對，找不到參數 c'); return }
    const data = JSON.parse(atob(decodeURIComponent(c)))
    if (!data.k || !data.p || !data.t) { showToast('連結缺少必要資訊'); return }
    settings.firebaseConfig = { apiKey: data.k, projectId: data.p }
    settings.tripId = data.t
    save()
    document.getElementById('setting-fbkey').value = data.k
    document.getElementById('setting-fbproject').value = data.p
    document.getElementById('setting-tripid').value = data.t
    document.getElementById('paste-invite-input').value = ''
    showToast('設定已套用，正在連接…')
    connectFirebase()
  } catch {
    showToast('連結格式不對')
  }
}

function initFirebase() {
  if (fsUnsubscribe) { fsUnsubscribe(); fsUnsubscribe = null }
  db = null
  const cfg = settings.firebaseConfig || {}
  if (!cfg.apiKey || !cfg.projectId || !settings.tripId) {
    updateFirebaseStatus('未連接')
    return
  }
  updateFirebaseStatus('連接中…')
  try {
    if (firebase.apps.length > 0) firebase.apps[0].delete()
    firebase.initializeApp({ apiKey: cfg.apiKey, projectId: cfg.projectId })
    db = firebase.firestore()
    db.enablePersistence().catch(() => {})
    setupRealtimeSync()
  } catch(e) {
    showToast('Firebase 連接失敗：' + e.message)
    updateFirebaseStatus('連接失敗')
    db = null
  }
}

function setupRealtimeSync() {
  const ref = db.collection('trips').doc(settings.tripId).collection('expenses')
  fsUnsubscribe = ref.onSnapshot(snapshot => {
    const expandedIds = new Set(expenses.filter(e => e._expanded).map(e => e.id))
    expenses = snapshot.docs.map(d => {
      const exp = d.data()
      if (expandedIds.has(exp.id)) exp._expanded = true
      return exp
    })
    renderExpenses()
    updateFirebaseStatus('已連接 ✓')
  }, err => {
    showToast('同步失敗：' + err.message)
    updateFirebaseStatus('同步失敗')
  })
}

function fsSave(exp) {
  if (!isFirebaseReady()) return
  const { _expanded, ...data } = exp
  db.collection('trips').doc(settings.tripId).collection('expenses')
    .doc(String(exp.id)).set(data)
    .catch(e => showToast('儲存失敗：' + e.message))
}

function fsDelete(id) {
  if (!isFirebaseReady()) return
  db.collection('trips').doc(settings.tripId).collection('expenses')
    .doc(String(id)).delete()
    .catch(e => showToast('刪除失敗：' + e.message))
}

function fsClearAll() {
  if (!isFirebaseReady()) return Promise.resolve()
  const colRef = db.collection('trips').doc(settings.tripId).collection('expenses')
  return colRef.get().then(snap => {
    const batch = db.batch()
    snap.docs.forEach(d => batch.delete(d.ref))
    return batch.commit()
  })
}

function fsReplaceAll(newExpenses) {
  return fsClearAll().then(() => {
    const colRef = db.collection('trips').doc(settings.tripId).collection('expenses')
    const batch = db.batch()
    newExpenses.forEach(exp => {
      const { _expanded, ...data } = exp
      batch.set(colRef.doc(String(exp.id)), data)
    })
    return batch.commit()
  }).catch(e => showToast('Firebase 同步失敗：' + e.message))
}

function generateTripCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
  settings.tripId = code
  save()
  const el = document.getElementById('setting-tripid')
  if (el) el.value = code
}

function connectFirebase() {
  settings.firebaseConfig = {
    apiKey:     document.getElementById('setting-fbkey').value.trim(),
    projectId:  document.getElementById('setting-fbproject').value.trim(),
  }
  settings.tripId = document.getElementById('setting-tripid').value.trim().toUpperCase()
  save()
  initFirebase()
}

function disconnectFirebase() {
  if (fsUnsubscribe) { fsUnsubscribe(); fsUnsubscribe = null }
  db = null
  settings.firebaseConfig = { apiKey: '', projectId: '' }
  settings.tripId = ''
  save()
  document.getElementById('setting-fbkey').value = ''
  document.getElementById('setting-fbproject').value = ''
  document.getElementById('setting-tripid').value = ''
  updateFirebaseStatus('未連接')
  showToast('已斷線，資料改為本機儲存')
}

// ── Tab switching ─────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'))
  document.querySelectorAll('.tab-item').forEach(el => el.classList.remove('active'))
  document.getElementById('tab-' + tab).classList.remove('hidden')
  document.querySelector(`.tab-item[data-tab="${tab}"]`).classList.add('active')
  if (tab === 'stats') renderStatsFiltered()
  if (tab === 'settings') renderSettings()
}

// ── Stats filter state ────────────────────────────────────────────
let statsPayerFilter   = new Set()
let statsCardFilter    = new Set()
let statsPaymentFilter = new Set()

function getStatsExpenses() {
  return expenses.filter(e => {
    if (statsPayerFilter.size   > 0 && !statsPayerFilter.has(e.payer)) return false
    if (statsCardFilter.size    > 0 && !statsCardFilter.has(e.card || '')) return false
    if (statsPaymentFilter.size > 0 && !statsPaymentFilter.has(e.paymentMethod)) return false
    return true
  })
}

function _renderChipBar(barId, labelId, items, activeSet, toggleFn) {
  const bar   = document.getElementById(barId)
  const label = document.getElementById(labelId)
  if (!bar) return
  if (items.length === 0) {
    bar.innerHTML = ''
    if (label) label.style.display = 'none'
    return
  }
  if (label) label.style.display = ''
  bar.innerHTML = items.map(v => {
    const active = activeSet.has(v) ? ' active' : ''
    return `<button class="cat-filter-btn stats-chip${active}" data-val="${esc(v)}" onclick="${toggleFn}(this.dataset.val)">${esc(v)}</button>`
  }).join('')
}

function renderStatsPayerBar() {
  const payers = [...new Set(expenses.map(e => e.payer).filter(Boolean))]
  _renderChipBar('stats-payer-bar', null, payers, statsPayerFilter, 'toggleStatsPayer')
}

function renderStatsCardBar() {
  const cards = [...new Set(expenses.filter(e => e.card).map(e => e.card))]
  _renderChipBar('stats-card-bar', 'stats-card-label', cards, statsCardFilter, 'toggleStatsCard')
}

function renderStatsPaymentBar() {
  const methods = [...new Set(expenses.map(e => e.paymentMethod).filter(Boolean))]
  _renderChipBar('stats-payment-bar', 'stats-payment-label', methods, statsPaymentFilter, 'toggleStatsPayment')
}

function toggleStatsPayer(payer) {
  if (statsPayerFilter.has(payer)) statsPayerFilter.delete(payer)
  else statsPayerFilter.add(payer)
  renderStatsFiltered()
}

function toggleStatsCard(card) {
  if (statsCardFilter.has(card)) statsCardFilter.delete(card)
  else statsCardFilter.add(card)
  renderStatsFiltered()
}

function toggleStatsPayment(method) {
  if (statsPaymentFilter.has(method)) statsPaymentFilter.delete(method)
  else statsPaymentFilter.add(method)
  renderStatsFiltered()
}

function renderStatsFiltered() {
  renderStatsPayerBar()
  renderStatsCardBar()
  renderStatsPaymentBar()
  const filtered = getStatsExpenses()
  const totalJPY = filtered.reduce((s, e) => s + (e.totalAmount || 0), 0)
  const jEl = document.getElementById('total-jpy')
  const tEl = document.getElementById('total-twd')
  if (jEl) jEl.textContent = fmt(totalJPY)
  if (tEl) tEl.textContent = fmtTWD(totalJPY)
  renderStats(filtered)
}

function clearStatsFilter() {
  statsPayerFilter   = new Set()
  statsCardFilter    = new Set()
  statsPaymentFilter = new Set()
  renderStatsFiltered()
}

// ── Render: Expense list ─────────────────────────────────────────
function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  const days = ['日','一','二','三','四','五','六']
  return `${d.getMonth()+1}/${d.getDate()}（${days[d.getDay()]}）`
}

function toggleDateGroup(date) {
  if (!expandedDates) expandedDates = new Set()
  if (expandedDates.has(date)) expandedDates.delete(date)
  else expandedDates.add(date)
  renderExpenses()
}

function clearSearch() {
  const inp = document.getElementById('search-input')
  if (inp) inp.value = ''
  const btn = document.getElementById('search-clear')
  if (btn) btn.style.display = 'none'
  renderExpenses()
}

function renderCatFilterBar() {
  const bar = document.getElementById('cat-filter-bar')
  if (!bar) return
  const usedCats = new Set()
  for (const exp of expenses) {
    for (const it of (exp.items || [])) usedCats.add(it.category)
    if (!exp.items || exp.items.length === 0) usedCats.add('其他')
  }
  const buttons = [{ id: null, icon: '', label: '全部' }]
    .concat(CATS.filter(c => usedCats.has(c.id)).map(c => ({ id: c.id, icon: c.icon, label: c.id, color: c.color })))
  bar.innerHTML = buttons.map(b => {
    const active = activeCatFilter === b.id ? ' active' : ''
    const style = (active && b.color) ? ` style="color:${b.color};border-color:${b.color}"` : ''
    const content = b.icon ? `${b.icon} ${b.label}` : b.label
    return `<button class="cat-filter-btn${active}"${style} onclick="setCatFilter(${b.id === null ? 'null' : `'${b.id}'`})">${content}</button>`
  }).join('')
}

function setCatFilter(cat) {
  activeCatFilter = cat
  renderCatFilterBar()
  renderExpenses()
}

function renderExpenseCard(exp) {
  const cat = mainCat(exp)
  const items = exp.items || []
  const discounts = exp.discounts || []
  return `
  <div class="expense-card${exp._expanded ? ' expanded' : ''}" id="card-${exp.id}">
    <div class="expense-row" onclick="toggleExpand(${exp.id})">
      <div class="expense-icon" style="background:${cat.color}22">${cat.icon}</div>
      <div class="expense-main">
        <div class="expense-store">${esc(exp.storeName) || '（未填商店）'}</div>
        <div class="expense-meta">
          ${exp.payer ? `<span class="badge">${esc(exp.payer)}</span>` : ''}
          ${exp.paymentMethod ? `<span class="badge">${esc(exp.paymentMethod)}${exp.paymentMethod === '信用卡' && exp.card ? '・' + esc(exp.card) : ''}</span>` : ''}
        </div>
      </div>
      <div class="expense-amount">
        <div class="expense-jpy">${fmt(exp.totalAmount || 0)}</div>
        <div class="expense-twd">${fmtTWD(exp.totalAmount || 0)}</div>
      </div>
      <span class="expense-chevron">›</span>
    </div>
    <div class="expense-details">
      ${items.length > 0 ? `
        <div class="detail-items">
          ${items.map(function(it) {
            var qty = parseInt(it.quantity) || 1
            var total = itemTotal(it)
            return '<div class="detail-item">' +
              '<span class="detail-name">' + esc(it.name) + '</span>' +
              (qty > 1 ? '<span class="detail-cat">\xd7' + qty + '</span>' : '') +
              '<span class="detail-cat">' + it.category + '</span>' +
              '<span class="detail-price">' + (qty > 1 ? fmt(it.price) + '\xd7' + qty + '=' : '') + fmt(total) + '</span>' +
              '</div>'
          }).join('')}
          ${discounts.map(function(d) {
            return '<div class="detail-item">' +
              '<span class="detail-name detail-discount">− ' + esc(d.name) + '</span>' +
              '<span class="detail-price detail-discount">−' + fmt(d.amount) + '</span>' +
              '</div>'
          }).join('')}
          ${exp.tax8 > 0 ? '<div class="detail-item"><span class="detail-name" style="color:var(--text2)">消費税 8%</span><span class="detail-price" style="color:var(--text2)">+' + fmt(exp.tax8) + '</span></div>' : ''}
          ${exp.tax10 > 0 ? '<div class="detail-item"><span class="detail-name" style="color:var(--text2)">消費税 10%</span><span class="detail-price" style="color:var(--text2)">+' + fmt(exp.tax10) + '</span></div>' : ''}
          ${exp.serviceCharge > 0 ? '<div class="detail-item"><span class="detail-name" style="color:var(--text2)">服務費</span><span class="detail-price" style="color:var(--text2)">+' + fmt(exp.serviceCharge) + '</span></div>' : ''}
          ${exp.taxFree > 0 ? '<div class="detail-item"><span class="detail-name detail-discount">免税額</span><span class="detail-price detail-discount">−' + fmt(exp.taxFree) + '</span></div>' : ''}
        </div>
        <div class="detail-total"><span>合計</span><span>${fmt(exp.totalAmount || 0)}（${fmtTWD(exp.totalAmount || 0)}）</span></div>
      ` : '<div style="color:var(--text2);font-size:14px">無商品明細</div>'}
      ${exp.note ? '<div style="font-size:13px;color:var(--text2);margin-top:8px">備註：' + esc(exp.note) + '</div>' : ''}
      <div class="detail-actions">
        <button class="btn-sm btn-sm-edit" onclick="openEditModal(${exp.id})">編輯</button>
        <button class="btn-sm btn-sm-delete" onclick="deleteExpense(${exp.id})">刪除</button>
      </div>
    </div>
  </div>`
}

function renderExpenses() {
  const list = document.getElementById('expense-list')

  const inp = document.getElementById('search-input')
  const keyword = inp ? inp.value.trim().toLowerCase() : ''
  const clearBtn = document.getElementById('search-clear')
  if (clearBtn) clearBtn.style.display = keyword ? '' : 'none'

  renderCatFilterBar()

  var filtered = [...expenses].sort((a, b) => b.date.localeCompare(a.date))

  if (keyword) {
    filtered = filtered.filter(function(exp) {
      var fields = [exp.storeName, exp.payer, exp.paymentMethod, exp.card, exp.note]
        .concat((exp.items || []).map(function(it) { return it.name }))
        .concat((exp.discounts || []).map(function(d) { return d.name }))
      return fields.some(function(f) { return f && f.toLowerCase().includes(keyword) })
    })
  }

  if (activeCatFilter) {
    filtered = filtered.filter(function(exp) {
      if (!exp.items || exp.items.length === 0) return activeCatFilter === '其他'
      return exp.items.some(function(it) { return it.category === activeCatFilter })
    })
  }

  if (filtered.length === 0) {
    let msg
    if (keyword) msg = '找不到「' + esc(keyword) + '」的相關費用'
    else if (activeCatFilter) msg = '沒有「' + activeCatFilter + '」分類的費用'
    else msg = '尚無費用記錄<br>點「＋」手動新增或掃描收據'
    const icon = (keyword || activeCatFilter) ? '🔍' : '🏯'
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">' + icon + '</span><span class="empty-text">' + msg + '</span></div>'
    return
  }

  var groups = {}
  filtered.forEach(function(exp) {
    if (!groups[exp.date]) groups[exp.date] = []
    groups[exp.date].push(exp)
  })
  var dates = Object.keys(groups).sort((a, b) => b.localeCompare(a))

  // 首次初始化：只展開最新日期
  if (expandedDates === null) {
    expandedDates = new Set(dates.length > 0 ? [dates[0]] : [])
  }

  list.innerHTML = dates.map(function(date) {
    var dayExps = groups[date]
    var dayTotal = dayExps.reduce((s, e) => s + (e.totalAmount || 0), 0)
    var open = expandedDates.has(date)
    return '<div class="date-header" onclick="toggleDateGroup(\'' + date + '\')">' +
      '<span class="date-header-label">' + formatDateLabel(date) + '</span>' +
      '<span class="date-header-right">' +
        '<span class="date-header-total">' + fmt(dayTotal) + '<span class="date-header-twd"> / ' + fmtTWD(dayTotal) + '</span></span>' +
        '<span class="date-chevron' + (open ? ' open' : '') + '">›</span>' +
      '</span>' +
      '</div>' +
      '<div class="date-group' + (open ? '' : ' collapsed') + '">' +
      dayExps.map(renderExpenseCard).join('') +
      '</div>'
  }).join('')
}

function toggleExpand(id) {
  const exp = expenses.find(e => e.id === id)
  if (!exp) return
  exp._expanded = !exp._expanded
  const card = document.getElementById('card-' + id)
  if (card) card.classList.toggle('expanded', exp._expanded)
}

function deleteExpense(id) {
  if (!confirm('確定要刪除這筆記錄？')) return
  if (isFirebaseReady()) {
    fsDelete(id)
  } else {
    expenses = expenses.filter(e => e.id !== id)
    save()
    renderExpenses()
  }
  showToast('已刪除')
}

// ── Render: Stats ────────────────────────────────────────────────
let donutChart = null, barChart = null
let activeChartType = 'donut'

function renderStats(filteredData) {
  const src = filteredData || expenses
  const legend = document.getElementById('stats-legend')
  if (src.length === 0) {
    if (donutChart) { donutChart.destroy(); donutChart = null }
    if (barChart) { barChart.destroy(); barChart = null }
    legend.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><span class="empty-text">尚無資料</span></div>'
    return
  }

  const totals = {}
  const catRows = {} // category -> [{date, storeName, name, price}]
  for (const exp of src) {
    const expItems = exp.items || []
    const itemSum = expItems.reduce((s, it) => s + itemTotal(it), 0)
    for (const it of expItems) {
      totals[it.category] = (totals[it.category] || 0) + itemTotal(it)
      if (!catRows[it.category]) catRows[it.category] = []
      catRows[it.category].push({ date: exp.date, storeName: exp.storeName || '', name: it.name, price: itemTotal(it) })
    }
    // Attribute tax/discount delta to dominant category so stats total = totalAmount
    if (expItems.length > 0) {
      const extra = (exp.totalAmount || 0) - itemSum
      if (extra !== 0) {
        totals[mainCat(exp).id] = (totals[mainCat(exp).id] || 0) + extra
      }
    } else if (exp.totalAmount) {
      totals[mainCat(exp).id] = (totals[mainCat(exp).id] || 0) + exp.totalAmount
      if (!catRows[mainCat(exp).id]) catRows[mainCat(exp).id] = []
      catRows[mainCat(exp).id].push({ date: exp.date, storeName: exp.storeName || '', name: exp.storeName || '（未分項）', price: exp.totalAmount })
    }
  }

  const active = CATS.filter(c => totals[c.id])
  const labels = active.map(c => c.icon + ' ' + c.id)
  const data   = active.map(c => totals[c.id])
  const colors = active.map(c => c.color)
  const total  = data.reduce((s,v) => s+v, 0)

  const isDark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme:dark)').matches)
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'
  const textColor = isDark ? '#98989D' : '#6B6B72'

  const donutWrap = document.getElementById('chart-donut-wrap')
  const barWrap = document.getElementById('chart-bar-wrap')
  const showDonut = activeChartType === 'donut'
  if (donutWrap) donutWrap.classList.toggle('hidden', !showDonut)
  if (barWrap) barWrap.classList.toggle('hidden', showDonut)

  function setDonutInfo(c, amt, pct) {
    const el = document.getElementById('donut-info')
    if (!el) return
    if (c) {
      el.innerHTML =
        `<div class="donut-info-icon">${c.icon}</div>` +
        `<div class="donut-info-cat">${c.id}</div>` +
        `<div class="donut-info-jpy">${fmt(amt)}</div>` +
        `<div class="donut-info-twd">${fmtTWD(amt)}</div>` +
        `<div class="donut-info-pct">${pct}%</div>`
    } else {
      el.innerHTML =
        `<div class="donut-info-label">總花費</div>` +
        `<div class="donut-info-jpy">${fmt(total)}</div>` +
        `<div class="donut-info-twd">${fmtTWD(total)}</div>` +
        `<div class="donut-info-pct">${active.length} 個分類</div>`
    }
  }

  if (showDonut) {
    if (barChart) { barChart.destroy(); barChart = null }
    if (donutChart) donutChart.destroy()
    donutChart = new Chart(document.getElementById('donut-chart'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }] },
      options: {
        cutout: '68%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        onClick(_, elements) {
          if (elements.length > 0) {
            const i = elements[0].index
            setDonutInfo(active[i], data[i], Math.round(data[i] / total * 100))
          } else {
            setDonutInfo(null)
          }
        }
      }
    })
    setDonutInfo(null)
  } else {
    if (donutChart) { donutChart.destroy(); donutChart = null }
    if (barChart) barChart.destroy()
    barChart = new Chart(document.getElementById('bar-chart'), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor, callback: v => '¥' + v.toLocaleString() } },
          y: { grid: { display: false }, ticks: { color: textColor } }
        }
      }
    })
  }

  legend.innerHTML = active.map(c => {
    const rows = catRows[c.id] || []
    const detailHtml = rows.map(r => `
      <div class="cat-detail-row">
        <span class="cat-detail-date">${r.date.slice(5).replace('-','/')}</span>
        <span class="cat-detail-name">${esc(r.name)}${r.storeName ? '<span class="cat-detail-store">・' + esc(r.storeName) + '</span>' : ''}</span>
        <span class="cat-detail-price">${fmt(r.price)}</span>
      </div>`).join('')
    return `
    <div class="legend-row" onclick="toggleCatDetail('cd-${c.id}')">
      <span class="legend-dot" style="background:${c.color}"></span>
      <span class="legend-name">${c.icon} ${c.id}</span>
      <span class="legend-pct">${Math.round(totals[c.id]/total*100)}%</span>
      <div class="legend-vals">
        <span class="legend-jpy">${fmt(totals[c.id])}</span>
        <span class="legend-twd">${fmtTWD(totals[c.id])}</span>
        <span class="legend-chevron" id="chv-${c.id}">›</span>
      </div>
    </div>
    <div class="cat-detail hidden" id="cd-${c.id}">${detailHtml}</div>`
  }).join('')
}

function switchChart(type) {
  activeChartType = type
  document.getElementById('btn-donut').classList.toggle('active', type === 'donut')
  document.getElementById('btn-bar').classList.toggle('active', type === 'bar')
  renderStatsFiltered()
}

function toggleCatDetail(id) {
  const el = document.getElementById(id)
  if (!el) return
  const catId = id.replace('cd-', '')
  const chv = document.getElementById('chv-' + catId)
  const open = el.classList.toggle('hidden')
  if (chv) chv.classList.toggle('open', !open)
}

// ── Render: Settings ─────────────────────────────────────────────
function renderSettings() {
  document.getElementById('setting-rate').value = settings.exchangeRate
  document.getElementById('setting-apikey').value = settings.geminiApiKey
  updateRateHint()
  renderPayerList()
  renderCardList()
  const cfg = settings.firebaseConfig || {}
  document.getElementById('setting-fbkey').value = cfg.apiKey || ''
  document.getElementById('setting-fbproject').value = cfg.projectId || ''
  document.getElementById('setting-tripid').value = settings.tripId || ''
  updateFirebaseStatus(isFirebaseReady() ? '已連接 ✓' : '未連接')
}

function updateRateHint() {
  const r = parseFloat(document.getElementById('setting-rate').value) || 0.22
  document.getElementById('rate-hint').textContent = `¥1,000 ≈ NT$${Math.round(1000 * r)}`
}

function renderPayerList() {
  const el = document.getElementById('payer-list')
  el.innerHTML = settings.payers.map((p, idx) => `
    <div class="payer-chip">
      <span>${esc(p)}</span>
      ${settings.payers.length > 1 ? `<button class="payer-chip-delete" onclick="removePayer(${idx})" aria-label="刪除">×</button>` : ''}
    </div>`).join('')
}

function addPayer() {
  const inp = document.getElementById('payer-input')
  const name = inp.value.trim()
  if (!name || settings.payers.includes(name)) return
  settings.payers.push(name)
  inp.value = ''
  save()
  renderPayerList()
}

function removePayer(idx) {
  settings.payers.splice(idx, 1)
  if (settings.payers.length === 0) settings.payers = ['我']
  save()
  renderPayerList()
}

function renderCardList() {
  const el = document.getElementById('card-list')
  if (!el) return
  el.innerHTML = settings.cards.map((c, idx) => `
    <div class="payer-chip">
      <span>${esc(c)}</span>
      <button class="payer-chip-delete" onclick="removeCard(${idx})" aria-label="刪除">×</button>
    </div>`).join('')
}

function addCard() {
  const inp = document.getElementById('card-input')
  const name = inp.value.trim()
  if (!name || settings.cards.includes(name)) return
  settings.cards.push(name)
  inp.value = ''
  save()
  renderCardList()
}

function removeCard(idx) {
  settings.cards.splice(idx, 1)
  save()
  renderCardList()
}

function populateCardSelect(selectId) {
  const el = document.getElementById(selectId)
  if (!el) return
  el.innerHTML = settings.cards.length > 0
    ? settings.cards.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
    : '<option value="">（請先在設定新增信用卡）</option>'
}

function onPaymentChange(paymentId, cardRowId, cardSelectId) {
  const isCard = document.getElementById(paymentId).value === '信用卡'
  document.getElementById(cardRowId).style.display = isCard ? '' : 'none'
  if (isCard) populateCardSelect(cardSelectId)
}

// Save settings on input blur
function initSettingListeners() {
  document.getElementById('setting-rate').addEventListener('input', () => {
    settings.exchangeRate = parseFloat(document.getElementById('setting-rate').value) || 0.22
    updateRateHint()
    save()
    renderExpenses()
  })
  document.getElementById('setting-apikey').addEventListener('change', () => {
    settings.geminiApiKey = document.getElementById('setting-apikey').value.trim()
    save()
  })
  document.getElementById('payer-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addPayer()
  })
  document.getElementById('card-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addCard()
  })
}

// ── Modal helpers ────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.remove('hidden') }
function closeModal(id) { document.getElementById(id).classList.add('hidden') }
function handleModalBg(e, id) { if (e.target === document.getElementById(id)) closeModal(id) }

// ── Add / Edit expense modal ──────────────────────────────────────
function populateSelects() {
  const payerSel = document.getElementById('f-payer')
  const paymentSel = document.getElementById('f-payment')
  payerSel.innerHTML = settings.payers.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')
  paymentSel.innerHTML = PMETHODS.map(m => `<option value="${m}">${m}</option>`).join('')
}

function populateReviewSelects() {
  const rp = document.getElementById('review-payer')
  const rm = document.getElementById('review-payment')
  if (rp) rp.innerHTML = settings.payers.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')
  if (rm) rm.innerHTML = PMETHODS.map(m => `<option value="${m}">${m}</option>`).join('')
}

function openAddModal() {
  editingId = null
  document.getElementById('modal-add-title').textContent = '新增費用'
  document.getElementById('f-store').value = ''
  document.getElementById('f-date').value = todayStr()
  document.getElementById('f-note').value = ''
  document.getElementById('items-container').innerHTML = ''
  document.getElementById('discounts-container').innerHTML = ''
  document.getElementById('f-tax8').value = ''
  document.getElementById('f-tax10').value = ''
  document.getElementById('f-taxfree').value = ''
  document.getElementById('f-service').value = ''
  document.getElementById('f-card-row').style.display = 'none'
  populateSelects()
  addItemRow()
  updateFormTotal()
  openModal('modal-add')
}

function openEditModal(id) {
  const exp = expenses.find(e => e.id === id)
  if (!exp) return
  editingId = id
  document.getElementById('modal-add-title').textContent = '編輯費用'
  document.getElementById('f-store').value = exp.storeName || ''
  document.getElementById('f-date').value = exp.date || todayStr()
  document.getElementById('f-note').value = exp.note || ''
  document.getElementById('items-container').innerHTML = ''
  document.getElementById('discounts-container').innerHTML = ''
  populateSelects()
  document.getElementById('f-payer').value = exp.payer || settings.payers[0]
  document.getElementById('f-payment').value = exp.paymentMethod || '現金'
  document.getElementById('f-tax8').value = exp.tax8 || ''
  document.getElementById('f-tax10').value = exp.tax10 || ''
  document.getElementById('f-taxfree').value = exp.taxFree || ''
  document.getElementById('f-service').value = exp.serviceCharge || ''
  if (exp.paymentMethod === '信用卡') {
    document.getElementById('f-card-row').style.display = ''
    populateCardSelect('f-card')
    document.getElementById('f-card').value = exp.card || ''
  } else {
    document.getElementById('f-card-row').style.display = 'none'
  }
  if (exp.items && exp.items.length > 0) {
    exp.items.forEach(it => addItemRow(it))
  } else {
    addItemRow()
  }
  if (exp.discounts && exp.discounts.length > 0) {
    exp.discounts.forEach(d => addDiscountRow(d))
  }
  updateFormTotal()
  openModal('modal-add')
}

function addItemRow(data = {}) {
  const container = document.getElementById('items-container')
  const div = document.createElement('div')
  div.className = 'item-row'
  div.innerHTML = `
    <div class="item-row-top">
      <input class="item-name" type="text" placeholder="商品名稱" value="${esc(data.name || '')}">
      <button class="item-delete" onclick="this.closest('.item-row').remove();updateFormTotal()" aria-label="刪除">−</button>
    </div>
    <div class="item-row-bottom">
      <input class="item-qty" type="number" placeholder="數量" min="1" value="${data.quantity || 1}" oninput="updateFormTotal()">
      <input class="item-price" type="number" placeholder="單價 ¥" min="0" value="${data.price || ''}" oninput="updateFormTotal()">
      <select class="item-cat">
        ${CATS.map(c => `<option value="${c.id}"${c.id === (data.category || '餐飲') ? ' selected' : ''}>${c.icon} ${c.id}</option>`).join('')}
      </select>
    </div>`
  container.appendChild(div)
}

function addDiscountRow(data = {}) {
  const container = document.getElementById('discounts-container')
  const div = document.createElement('div')
  div.className = 'discount-row'
  div.innerHTML = `
    <input class="discount-name" type="text" placeholder="折扣名稱" value="${esc(data.name || '')}">
    <input class="discount-amount" type="number" placeholder="折抵金額" min="0" value="${data.amount || ''}" oninput="updateFormTotal()">
    <button class="item-delete" onclick="this.parentElement.remove();updateFormTotal()" aria-label="刪除">−</button>`
  container.appendChild(div)
}

function collectExtras() {
  return {
    tax8:          parseFloat(document.getElementById('f-tax8').value) || 0,
    tax10:         parseFloat(document.getElementById('f-tax10').value) || 0,
    taxFree:       parseFloat(document.getElementById('f-taxfree').value) || 0,
    serviceCharge: parseFloat(document.getElementById('f-service').value) || 0,
  }
}

function updateFormTotal() {
  const items = collectItems()
  const discounts = collectDiscounts()
  const { tax8, tax10, taxFree, serviceCharge } = collectExtras()
  const total = calcTotal(items, discounts, tax8, tax10, taxFree, serviceCharge)
  document.getElementById('f-total').textContent = fmt(total)
}

function collectItems() {
  return [...document.querySelectorAll('#items-container .item-row')].map(row => ({
    name:     row.querySelector('.item-name').value.trim() || '（未填）',
    quantity: Math.max(1, parseInt(row.querySelector('.item-qty').value) || 1),
    price:    parseFloat(row.querySelector('.item-price').value) || 0,
    category: row.querySelector('.item-cat').value,
  })).filter(it => it.price > 0 || it.name !== '（未填）')
}

function collectDiscounts() {
  return [...document.querySelectorAll('#discounts-container .discount-row')].map(row => ({
    name:   row.querySelector('.discount-name').value.trim() || '折扣',
    amount: parseFloat(row.querySelector('.discount-amount').value) || 0,
  })).filter(d => d.amount > 0)
}

function saveExpense() {
  const items = collectItems()
  const discounts = collectDiscounts()
  const { tax8, tax10, taxFree, serviceCharge } = collectExtras()
  const total = calcTotal(items, discounts, tax8, tax10, taxFree, serviceCharge)
  const date = document.getElementById('f-date').value || todayStr()

  if (items.length === 0) { showToast('請至少新增一筆商品'); return }
  if (total === 0) { showToast('合計金額不可為 0'); return }

  const exp = {
    id:            editingId || Date.now(),
    date,
    storeName:     document.getElementById('f-store').value.trim(),
    payer:         document.getElementById('f-payer').value,
    paymentMethod: document.getElementById('f-payment').value,
    card:          document.getElementById('f-payment').value === '信用卡' ? document.getElementById('f-card').value : '',
    items,
    discounts,
    tax8, tax10, taxFree, serviceCharge,
    totalAmount:   total,
    note:          document.getElementById('f-note').value.trim(),
    _expanded:     false,
  }

  if (expandedDates) expandedDates.add(exp.date)
  if (isFirebaseReady()) {
    fsSave(exp)
  } else {
    if (editingId) {
      const idx = expenses.findIndex(e => e.id === editingId)
      if (idx >= 0) expenses[idx] = exp
    } else {
      expenses.unshift(exp)
    }
    save()
    renderExpenses()
  }

  closeModal('modal-add')
  showToast(editingId ? '已更新' : '已新增')
  editingId = null
}

// ── Receipt scanner ───────────────────────────────────────────────
async function testGeminiKey() {
  const key = document.getElementById('setting-apikey').value.trim()
  const result = document.getElementById('gemini-test-result')
  if (!key) { result.textContent = '⚠️ 請先輸入 API Key'; result.style.color = 'var(--warn)'; return }
  result.textContent = '測試中…'; result.style.color = 'var(--text2)'
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: '1+1=?' }] }] }) }
    )
    const data = await res.json()
    if (data.candidates) {
      result.textContent = '✓ API Key 正常'; result.style.color = 'var(--ok)'
    } else if (data.error?.code === 429) {
      result.textContent = '⚠️ 配額已用完（Key 有效）'; result.style.color = 'var(--warn)'
    } else {
      result.textContent = '✗ ' + (data.error?.message?.slice(0, 40) || '無效'); result.style.color = 'var(--danger)'
    }
  } catch(e) {
    result.textContent = '✗ 網路錯誤'; result.style.color = 'var(--danger)'
  }
}

function openScanModal() {
  if (!settings.geminiApiKey) {
    showToast('請先在設定頁填入 Gemini API Key')
    switchTab('settings')
    return
  }
  resetScan()
  openModal('modal-scan')
}

function resetScan() {
  scanFiles = []
  scanResult = null
  const wrap = document.getElementById('scan-preview-wrap')
  wrap.querySelectorAll('img').forEach(img => { if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src) })
  wrap.innerHTML = ''
  wrap.style.display = 'none'
  document.getElementById('scan-count').textContent = ''
  document.getElementById('scan-file').value = ''
  document.getElementById('btn-scan-go').disabled = true
  showScanStep(1)
}

function showScanStep(n) {
  document.getElementById('scan-step-1').classList.toggle('hidden', n !== 1)
  document.getElementById('scan-step-2').classList.toggle('hidden', n !== 2)
  document.getElementById('scan-step-err').classList.toggle('hidden', n !== 'err')
  document.getElementById('scan-step-3').classList.toggle('hidden', n !== 3)
}

function onFileSelected(e) {
  const files = [...e.target.files]
  if (!files.length) return
  scanFiles = files
  const wrap = document.getElementById('scan-preview-wrap')
  wrap.querySelectorAll('img').forEach(img => { if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src) })
  wrap.innerHTML = ''
  files.forEach(f => {
    const img = document.createElement('img')
    img.src = URL.createObjectURL(f)
    img.className = 'scan-preview-thumb'
    wrap.appendChild(img)
  })
  wrap.style.display = 'flex'
  document.getElementById('scan-count').textContent = files.length > 1 ? `已選 ${files.length} 張` : ''
  document.getElementById('btn-scan-go').disabled = false
}

async function runScan() {
  if (!scanFiles.length) return
  showScanStep(2)
  try {
    const base64Array = await Promise.all(scanFiles.map(fileToBase64))
    const result = await callGemini(base64Array)
    scanResult = result
    renderScanReview(result)
    showScanStep(3)
  } catch (err) {
    document.getElementById('scan-error-msg').textContent = '辨識失敗：' + err.message
    showScanStep('err')
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX = 1280
      let { width: w, height: h } = img
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX }
        else        { w = Math.round(w * MAX / h); h = MAX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片載入失敗')) }
    img.src = url
  })
}

async function callGemini(base64Array) {
  const key = settings.geminiApiKey
  const multi = base64Array.length > 1
  const prompt = `這是日本收據照片${multi ? `（共 ${base64Array.length} 張，為同一張收據的不同部分，請合併所有照片的資訊一起辨識）` : ''}，請盡力提取所有資訊。
規則：
- 能辨識的資訊請認真判斷填入；完全無法確定的欄位請留空（"" 或 [] 或 0），不要猜測
- 商店名稱通常在收據最上方
- 商品名稱翻譯成繁體中文，後面括號保留日文原文，例：「梅子飯糰（おにぎり 梅）」
- quantity 為購買數量（整數，預設 1），price 為單價（正整數日幣）
- discounts：折扣、優惠券、點數折抵（amount 為正整數折抵金額）
- tax8：消費税 8% 的稅額（食品飲料，收據上標示「※」或「軽減税率」的商品稅金）
- tax10：消費税 10% 的稅額（一般商品稅金）
- taxFree：免税額（外國旅客免税購物的折抵金額，收據上顯示「免税額」）
- serviceCharge：服務費（レストランのサービス料，正整數）
- total 填最終實付金額

只回傳純 JSON，不要有其他文字：
{"storeName":"","items":[{"name":"","quantity":1,"price":0,"category":"餐飲"}],"discounts":[{"name":"","amount":0}],"tax8":0,"tax10":0,"taxFree":0,"serviceCharge":0,"total":0}
category 判斷規則（每筆商品獨立判斷，同一張收據可以有不同 category）：
- 餐飲：食物、飲料、便利商店食品、餐廳、咖啡廳、超市食品
- 交通：電車、巴士、新幹線、計程車、IC卡儲值、停車費
- 購物：衣服、電器、藥妝、雜貨、紀念品、化妝品、日用品
- 住宿：飯店、旅館、民宿
- 娛樂：門票、遊樂園、電影、表演、溫泉、觀光景點
- 其他：以上無法明確歸類的項目`

  const imageParts = base64Array.map(b64 => ({ inlineData: { mimeType: 'image/jpeg', data: b64 } }))

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, ...imageParts] }]
      })
    }
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `HTTP ${res.status}`)
  }

  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('回應格式異常')

  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const match = clean.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('無法解析 JSON')
  return JSON.parse(match[0])
}

function renderScanReview(result) {
  const storeEl = document.getElementById('review-store')
  storeEl.innerHTML = result.storeName
    ? esc(result.storeName)
    : `<span style="color:var(--text2)">（未辨識到商店名稱）</span>`

  const items = result.items || []
  const discounts = result.discounts || []

  document.getElementById('review-items').innerHTML = `
    ${items.map((it, i) => {
      const qty = parseInt(it.quantity) || 1
      const tot = (parseFloat(it.price) || 0) * qty
      return `<div class="review-item" id="ri-${i}">
        <div class="review-check checked" onclick="toggleReviewItem(${i})">✓</div>
        <div class="review-name">${esc(it.name)}${qty > 1 ? ` <span style="color:var(--text2)">×${qty}</span>` : ''} <span style="font-size:11px;color:var(--text2)">${esc(it.category)}</span></div>
        <div class="review-price">${fmt(tot)}</div>
      </div>`}).join('')}
    ${discounts.map(d => `
      <div class="review-item">
        <div class="review-name review-discount">− ${esc(d.name)}</div>
        <div class="review-price review-discount">−${fmt(d.amount)}</div>
      </div>`).join('')}
    ${result.tax8 > 0 ? `<div class="review-item"><div class="review-name" style="color:var(--text2)">消費税 8%</div><div class="review-price" style="color:var(--text2)">+${fmt(result.tax8)}</div></div>` : ''}
    ${result.tax10 > 0 ? `<div class="review-item"><div class="review-name" style="color:var(--text2)">消費税 10%</div><div class="review-price" style="color:var(--text2)">+${fmt(result.tax10)}</div></div>` : ''}
    ${result.serviceCharge > 0 ? `<div class="review-item"><div class="review-name" style="color:var(--text2)">服務費</div><div class="review-price" style="color:var(--text2)">+${fmt(result.serviceCharge)}</div></div>` : ''}
    ${result.taxFree > 0 ? `<div class="review-item"><div class="review-name review-discount">免税額</div><div class="review-price review-discount">−${fmt(result.taxFree)}</div></div>` : ''}
    ${result.total > 0 ? `
      <div style="display:flex;justify-content:space-between;font-weight:700;padding:10px 0 0;font-size:15px">
        <span>合計</span><span>${fmt(result.total)}</span>
      </div>` : ''}
  `

  document.getElementById('review-date').value = todayStr()
  populateReviewSelects()
}

function toggleReviewItem(i) {
  const el = document.querySelector(`#ri-${i} .review-check`)
  el.classList.toggle('checked')
  el.textContent = el.classList.contains('checked') ? '✓' : ''
}

function confirmScan() {
  if (!scanResult) return
  const checkedIndices = new Set(
    [...document.querySelectorAll('.review-check.checked')]
      .map(el => parseInt(el.closest('.review-item').id?.replace('ri-','')))
      .filter(n => !isNaN(n))
  )

  const items = (scanResult.items || [])
    .filter((_, i) => checkedIndices.has(i))
    .map(it => ({
      name:     it.name,
      quantity: parseInt(it.quantity) || 1,
      price:    parseFloat(it.price) || 0,
      category: it.category || '其他',
    }))

  const discounts = (scanResult.discounts || []).map(d => ({
    name:   d.name || '折扣',
    amount: parseFloat(d.amount) || 0,
  })).filter(d => d.amount > 0)

  if (items.length === 0) { showToast('請至少勾選一項商品'); return }

  const tax8          = parseFloat(scanResult.tax8) || 0
  const tax10         = parseFloat(scanResult.tax10) || 0
  const taxFree       = parseFloat(scanResult.taxFree) || 0

  const serviceCharge = parseFloat(scanResult.serviceCharge) || 0
  const total = calcTotal(items, discounts, tax8, tax10, taxFree, serviceCharge)
  if (total === 0) { showToast('合計金額不可為 0'); return }

  const exp = {
    id:            Date.now(),
    date:          document.getElementById('review-date').value || todayStr(),
    storeName:     scanResult.storeName || '',
    payer:         document.getElementById('review-payer').value,
    paymentMethod: document.getElementById('review-payment').value,
    card:          document.getElementById('review-payment').value === '信用卡' ? document.getElementById('review-card').value : '',
    items,
    discounts,
    tax8, tax10, taxFree, serviceCharge,
    totalAmount:   total,
    note:          '',
    _expanded:     false,
  }

  if (expandedDates) expandedDates.add(exp.date)
  if (isFirebaseReady()) {
    fsSave(exp)
  } else {
    expenses.unshift(exp)
    save()
    renderExpenses()
  }
  closeModal('modal-scan')
  showToast('已新增 ' + items.length + ' 筆商品')
}

// ── Backup JSON ───────────────────────────────────────────────────
function exportJSON() {
  if (expenses.length === 0) { showToast('沒有資料可備份'); return }
  const blob = new Blob([JSON.stringify(expenses, null, 2)], { type: 'application/json' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: '旅遊記帳備份.json' })
  a.click()
  URL.revokeObjectURL(a.href)
}

function importJSON() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' })
  input.onchange = e => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const data = JSON.parse(evt.target.result)
        if (!Array.isArray(data)) throw new Error('格式錯誤')
        if (!confirm(`確定要匯入 ${data.length} 筆資料？（將取代現有資料）`)) return
        expenses = data
        save()
        if (isFirebaseReady()) {
          fsReplaceAll(data)
        } else {
          renderExpenses()
        }
        showToast('匯入成功：' + data.length + ' 筆')
      } catch (err) {
        showToast('匯入失敗：' + err.message)
      }
    }
    reader.readAsText(file)
  }
  input.click()
}

// ── Export CSV ────────────────────────────────────────────────────
function exportCSV() {
  if (expenses.length === 0) { showToast('沒有資料可匯出'); return }
  const rows = [['日期','商店','付款人','付款方式','商品','分類','數量','單價(JPY)','小計(JPY)','消費税8%','消費税10%','服務費','免税額','折扣(JPY)','合計(JPY)','台幣換算','備註']]
  for (const exp of expenses) {
    const r = parseFloat(settings.exchangeRate) || 0.22
    if ((exp.items || []).length === 0) {
      rows.push([exp.date, exp.storeName, exp.payer, exp.paymentMethod + (exp.card ? '・' + exp.card : ''), '', '', '', '', '', exp.tax8||'', exp.tax10||'', exp.serviceCharge||'', exp.taxFree||'', '', exp.totalAmount, Math.round(exp.totalAmount*r), exp.note])
    } else {
      for (const it of exp.items) {
        const qty = parseInt(it.quantity)||1
        rows.push([exp.date, exp.storeName, '', '', it.name, it.category, qty, it.price, it.price*qty, '', '', '', '', '', '', '', ''])
      }
      for (const d of (exp.discounts || [])) {
        rows.push([exp.date, exp.storeName, '', '', '（折扣）'+d.name, '', '', '', '', '', '', '', '', d.amount, '', '', ''])
      }
      rows.push([exp.date, exp.storeName, exp.payer, exp.paymentMethod + (exp.card ? '・' + exp.card : ''), '合計', '', '', '', '', exp.tax8||'', exp.tax10||'', exp.serviceCharge||'', exp.taxFree||'', '', exp.totalAmount, Math.round(exp.totalAmount*r), exp.note])
    }
  }
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: '旅遊記帳.csv' })
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── Misc ──────────────────────────────────────────────────────────
function forceUpdate() {
  showToast('更新中…')
  const bust = () => { location.href = location.pathname + '?_=' + Date.now() }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => Promise.all(regs.map(r => r.unregister())))
      .then(() => caches.keys())
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(bust)
  } else {
    bust()
  }
}

function confirmClear() {
  const pwd = prompt('請輸入密碼以清除所有資料：')
  if (pwd === null) return
  if (pwd !== '594677') { showToast('密碼錯誤'); return }
  if (isFirebaseReady()) {
    fsClearAll().then(() => showToast('已清除'))
  } else {
    expenses = []
    save()
    renderExpenses()
    showToast('已清除')
  }
}

function showToast(msg) {
  const existing = document.querySelector('.toast')
  if (existing) existing.remove()
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg })
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2100)
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── Sample data ───────────────────────────────────────────────────
function loadSampleData() {
  expenses = [
    // 7-11 便利商店 ── 我、Suica、餐飲
    { id: 1, date: '2026-07-24', storeName: '7-11 新宿店（セブン-イレブン 新宿店）', payer: '我', paymentMethod: 'Suica（IC卡）', card: '',
      items: [
        { name: '梅子飯糰（おにぎり 梅）', quantity: 2, price: 150, category: '餐飲' },
        { name: '綠茶 500ml（お茶 500ml）', quantity: 1, price: 130, category: '餐飲' },
        { name: '巧克力（チョコレート）',   quantity: 1, price: 200, category: '餐飲' },
      ], discounts: [], tax8: 42, tax10: 0, taxFree: 0, serviceCharge: 0, totalAmount: 630, note: '食品適用 8% 稅率', _expanded: false },

    // 新幹線 ── yh、Suica、交通
    { id: 2, date: '2026-07-24', storeName: '東京車站（東京駅）', payer: 'yh', paymentMethod: 'Suica（IC卡）', card: '',
      items: [
        { name: '新幹線 東京→京都 自由席', quantity: 1, price: 13320, category: '交通' },
      ], discounts: [], tax8: 0, tax10: 0, taxFree: 0, serviceCharge: 0, totalAmount: 13320, note: '自由席', _expanded: false },

    // 藥妝店 ── carol、信用卡（富邦J）、購物
    { id: 3, date: '2026-07-25', storeName: '松本清藥妝（マツモトキヨシ）', payer: 'carol', paymentMethod: '信用卡', card: '富邦J',
      items: [
        { name: '曼秀雷敦護唇膏（メンソレータム）',  quantity: 1, price: 618, category: '購物' },
        { name: '碧柔防曬乳（ビオレUV 日焼け止め）', quantity: 1, price: 891, category: '購物' },
        { name: '龍角散喉糖（龍角散 のど飴）',        quantity: 2, price: 291, category: '購物' },
      ], discounts: [{ name: '點數折抵（ポイント割引）', amount: 50 }],
      tax8: 0, tax10: 209, taxFree: 0, serviceCharge: 0, totalAmount: 2250, note: '', _expanded: false },

    // 拉麵 ── yh、現金、餐飲
    { id: 4, date: '2026-07-25', storeName: '一蘭拉麵 道頓堀店', payer: 'yh', paymentMethod: '現金', card: '',
      items: [
        { name: '豬骨拉麵（天然とんこつラーメン）', quantity: 1, price: 1091, category: '餐飲' },
        { name: '加叉燒（チャーシュー追加）',        quantity: 2, price: 182, category: '餐飲' },
      ], discounts: [], tax8: 0, tax10: 145, taxFree: 0, serviceCharge: 100, totalAmount: 1700, note: '含服務費', _expanded: false },

    // USJ ── 我、信用卡（永豐大戶）、娛樂 + 購物
    { id: 5, date: '2026-07-26', storeName: 'USJ（ユニバーサル・スタジオ・ジャパン）', payer: '我', paymentMethod: '信用卡', card: '永豐大戶',
      items: [
        { name: '一日票（1DAYパス）',                              quantity: 1, price: 10400, category: '娛樂' },
        { name: '哈利波特限定周邊（ハリー・ポッター限定グッズ）', quantity: 1, price: 2909, category: '購物' },
      ], discounts: [], tax8: 0, tax10: 0, taxFree: 3309, serviceCharge: 0, totalAmount: 10000, note: '出示護照免税', _expanded: false },

    // 飯店住宿 ── carol、信用卡（星展）、住宿
    { id: 6, date: '2026-07-24', storeName: '京都商務旅館（スーパーホテル 京都）', payer: 'carol', paymentMethod: '信用卡', card: '星展',
      items: [
        { name: '標準房 2晚（スタンダードルーム 2泊）', quantity: 2, price: 7500, category: '住宿' },
      ], discounts: [], tax8: 0, tax10: 1500, taxFree: 0, serviceCharge: 0, totalAmount: 16500, note: '含早餐', _expanded: false },

    // 大阪地鐵 ── 我、PayPay、交通
    { id: 7, date: '2026-07-25', storeName: '大阪地下鐵（Osaka Metro）', payer: '我', paymentMethod: 'PayPay', card: '',
      items: [
        { name: '大阪地鐵一日票（一日乗車券）', quantity: 1, price: 800, category: '交通' },
      ], discounts: [], tax8: 0, tax10: 0, taxFree: 0, serviceCharge: 0, totalAmount: 800, note: '', _expanded: false },

    // 燒肉居酒屋 ── 我、Apple Pay、餐飲
    { id: 8, date: '2026-07-26', storeName: '燒肉王 難波店（焼肉 きんぐ 難波店）', payer: '我', paymentMethod: 'Apple Pay', card: '',
      items: [
        { name: '牛五花（カルビ）',  quantity: 3, price: 638, category: '餐飲' },
        { name: '里肌肉（ロース）',  quantity: 2, price: 748, category: '餐飲' },
        { name: '生啤酒（生ビール）', quantity: 2, price: 528, category: '餐飲' },
        { name: '白飯（ライス）',    quantity: 2, price: 198, category: '餐飲' },
      ], discounts: [{ name: '折價券（クーポン）', amount: 300 }],
      tax8: 0, tax10: 528, taxFree: 0, serviceCharge: 200, totalAmount: 5400, note: '4人聚餐我付', _expanded: false },

    // 唐吉訶德 ── yh、全支付、購物
    { id: 9, date: '2026-07-27', storeName: '唐吉訶德 心齋橋（ドン・キホーテ 心斎橋店）', payer: 'yh', paymentMethod: '全支付', card: '',
      items: [
        { name: '美白乳液（ちふれ 美白乳液）',  quantity: 2, price: 660, category: '購物' },
        { name: 'KitKat 抹茶（キットカット）',  quantity: 3, price: 540, category: '購物' },
        { name: '扇子（うちわ）',               quantity: 2, price: 380, category: '購物' },
      ], discounts: [], tax8: 0, tax10: 0, taxFree: 2380, serviceCharge: 0, totalAmount: 3080, note: '出示護照免税', _expanded: false },

    // FamilyMart ── carol、Suica、多類別（餐飲＋購物）
    { id: 10, date: '2026-07-26', storeName: 'FamilyMart 梅田店（ファミリーマート 梅田店）', payer: 'carol', paymentMethod: 'Suica（IC卡）', card: '',
      items: [
        { name: '蛋沙拉三明治（たまごサンド）',       quantity: 1, price: 248, category: '餐飲' },
        { name: '可爾必思（カルピスウォーター）',      quantity: 2, price: 138, category: '餐飲' },
        { name: '潘婷洗髮精（パンテーン シャンプー）', quantity: 1, price: 698, category: '購物' },
        { name: '牙刷（歯ブラシ）',                   quantity: 2, price: 198, category: '購物' },
        { name: '退熱貼（熱さまシート）',              quantity: 1, price: 398, category: '購物' },
      ], discounts: [], tax8: 30, tax10: 149, taxFree: 0, serviceCharge: 0, totalAmount: 1995, note: '餐飲 8%、日用品 10%', _expanded: false },

    // Starbucks ── yh、玉山電支、餐飲
    { id: 11, date: '2026-07-27', storeName: '星巴克 京都四条（スターバックス 京都四条店）', payer: 'yh', paymentMethod: '玉山電支', card: '',
      items: [
        { name: '櫻花星冰樂（さくらフラペチーノ）', quantity: 1, price: 780, category: '餐飲' },
        { name: '焦糖拿鐵（キャラメルラテ）',       quantity: 1, price: 650, category: '餐飲' },
        { name: '起司蛋糕（チーズケーキ）',         quantity: 1, price: 480, category: '餐飲' },
      ], discounts: [], tax8: 0, tax10: 191, taxFree: 0, serviceCharge: 0, totalAmount: 2101, note: '', _expanded: false },
  ]

  save()
}

// ── Init ──────────────────────────────────────────────────────────
function init() {
  load()
  applyInviteLink()
  const fbCfg = settings.firebaseConfig || {}
  const hasFirebase = fbCfg.apiKey && fbCfg.projectId && settings.tripId
  if (!hasFirebase && expenses.length === 0) loadSampleData()
  renderExpenses()
  initSettingListeners()
  if (hasFirebase) initFirebase()
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
}

document.addEventListener('DOMContentLoaded', init)
