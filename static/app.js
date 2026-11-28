/* Rekan Kantor · application controller. All server data is untrusted. */
(function () {
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const U = window.SobisUI;
const esc = U.escapeHtml;
const fmt = U.number;
const money = U.money;
const PAGES = {overview:'Ringkasan',workroom:'Ruang kerja',agents:'Tim agen',tasks:'Papan tugas',memories:'Memori',usage:'Pemakaian',settings:'Setelan'};
const TASK_LABELS = {queue:'Mengantre',doing:'Dikerjakan',done:'Selesai',failed:'Gagal'};
const MEMORY_LABELS = {pending:'Menunggu',approved:'Disetujui',rejected:'Ditolak',superseded:'Digantikan'};
const TOOL_LABELS = {assign_tasks:'Bagikan tugas',create_agent:'Buat agen',list_agents:'Lihat daftar agen',usulkan_memori:'Usulkan memori'};
const state = {data:null,messages:[],messagesLoaded:false,messageError:'',streams:new Map(),connected:false,synced:false,loading:false,error:'',page:'overview',view:'chat',memoryStatus:'pending',settingsDirty:false,settingsVersion:0,editingId:null,agentDirty:false,detail:null,usage:null,usageError:'',usageLoading:false,sending:false,mutations:new Set(),lastUpdated:null};
let source = null, refreshPromise = null, refreshQueued = false, refreshTimer = null;
let snapshotEvents = null, historyEpoch = 0, detailSequence = 0, snapshotSequence = 0;
let agentFieldLocks = null;
let chatPinned = true;
const wideRoom = window.matchMedia('(min-width: 1001px)');
const desktopNav = window.matchMedia('(min-width: 761px)');

function storageGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; } }
function storageSet(key, value) { try { value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch (_) { /* Session-only draft still remains in the textarea. */ } }
function icon(name) { return '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
function empty(title, description, extra = '') { return '<div class="empty-state"><h4>' + esc(title) + '</h4><p>' + esc(description) + '</p>' + extra + '</div>'; }
function errorBox(message, retry = '') { return '<div class="inline-error" role="alert">' + esc(message) + (retry ? '<button class="btn subtle" data-action="' + esc(retry) + '">Coba lagi</button>' : '') + '</div>'; }
function pill(label, kind = 'neutral') {
  const safe = ['neutral','idle','inactive','queue','pending','mock','doing','working','live','approved','done','error','failed','rejected','superseded','legacy'].includes(kind) ? kind : 'neutral';
  return '<span class="pill ' + safe + '">' + esc(label) + '</span>';
}
function dateText(raw, short = false) {
  if (!raw) return 'Waktu tidak tersedia';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleString('id-ID', short ? {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'} : {day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function toast(text, isError = false) {
  const item = document.createElement('div');
  item.className = 'toast' + (isError ? ' error' : '');
  item.textContent = text;
  $('#toasts').append(item);
  setTimeout(() => item.remove(), isError ? 6500 : 4000);
}
function inlineError(id, text) { const el = $('#' + id); el.textContent = text; el.hidden = !text; }
function idPath(id) { return encodeURIComponent(String(id)); }
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(path, {...options, signal:controller.signal, headers:{'Accept':'application/json',...(options.body ? {'Content-Type':'application/json'} : {}),...options.headers},cache:'no-store'});
    let json = null;
    try { json = await response.json(); } catch (_) { /* A server error need not contain JSON. */ }
    if (!response.ok) {
      let detail = json && json.detail;
      if (Array.isArray(detail)) detail = detail.map(x => x.msg).filter(Boolean).join('; ');
      throw new Error(typeof detail === 'string' ? detail : 'Permintaan gagal (HTTP ' + response.status + ').');
    }
    if (!json || typeof json !== 'object') throw new Error('Respons server tidak valid.');
    return json;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Server belum merespons. Coba lagi; periksa keadaan sebelum mengulang tindakan.');
    if (error instanceof TypeError) throw new Error('Tidak dapat menjangkau server kantor. Periksa koneksi lokal.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function current() { return !!state.data && state.connected && state.synced && !state.error; }
function registryReady() { return current() && !state.data.busy && state.mutations.size === 0; }
function agentStatus(agent) {
  if (!agent.is_active) return {label:'Nonaktif',kind:'inactive'};
  const status = state.data?.agent_statuses?.[agent.name]?.status || agent.status || 'idle';
  if (!current()) return {label:'Belum tersinkron',kind:'neutral'};
  return status === 'working' ? {label:'Bekerja',kind:'working'} : status === 'error' ? {label:'Gagal',kind:'error'} : {label:'Siap',kind:'idle'};
}
function avatar(agent, extra = '') { return '<span class="avatar ' + (agent.is_orchestrator ? 'coordinator ' : '') + extra + '" aria-hidden="true">' + esc(String(agent.name || '?').slice(0,1).toUpperCase()) + '</span>'; }
function taskPill(task) { return pill(TASK_LABELS[task.status] || 'Status tidak dikenal', task.status); }
function toolTags(tools) { return Array.isArray(tools) && tools.length ? tools.map(t => '<span class="tool-tag">' + esc(t) + '</span>').join('') : '<span class="muted">Tanpa izin tool</span>'; }
function getAgents() { return Array.isArray(state.data?.agents) ? state.data.agents : null; }
function getTasks() { return Array.isArray(state.data?.tasks) ? state.data.tasks : null; }
function getMemories() { return Array.isArray(state.data?.memories) ? state.data.memories : null; }

/* Navigation changes visibility only: neither forms nor drafts are remounted. */
function setPage(page, focus = false) {
  if (!PAGES[page]) page = 'overview';
  const changed = state.page !== page;
  state.page = page;
  $$('.page').forEach(el => { el.hidden = el.id !== 'page-' + page; el.classList.toggle('active', !el.hidden); });
  $$('#main-nav [data-page]').forEach(link => {
    const on = link.dataset.page === page;
    link.classList.toggle('active', on);
    if (on) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  $('#page-title').textContent = PAGES[page];
  $('#breadcrumb-page').textContent = PAGES[page];
  document.title = PAGES[page] + ' · Rekan Kantor · SolusiBisnis.com';
  document.body.classList.toggle('workroom-active', page === 'workroom');
  closeNav(false);
  if (changed) $('#main-content').scrollTop = 0;
  syncOffice();
  if (page === 'usage' && !state.usage && state.data) loadUsage();
  if (page === 'workroom') requestAnimationFrame(() => { autoGrow(); if (chatPinned) scrollChat(true); });
  if (focus) $('#main-content').focus({preventScroll:true});
}
function navigate(page) { if (location.hash === '#' + page) setPage(page); else location.hash = page; }
function setView(view) {
  state.view = view === 'office' ? 'office' : 'chat';
  $('#workroom-layout').dataset.view = state.view;
  $$('.workroom-tabs button').forEach(button => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
    button.tabIndex = active ? 0 : -1;
  });
  // CSS and inert agree: the non-visible mobile panel cannot receive keyboard focus.
  $('#office-panel').inert = !wideRoom.matches && state.view !== 'office';
  $('#chat-panel').inert = !wideRoom.matches && state.view !== 'chat';
  storageSet('ks-room-view',state.view);
  syncOffice();
  if (state.view === 'chat') requestAnimationFrame(() => { if (chatPinned) scrollChat(true); });
}
function openNav() {
  if (desktopNav.matches) return;
  $('#sidebar').classList.add('open');
  $('#sidebar').inert = false;
  $('#nav-overlay').hidden = false;
  $('#sidebar-toggle').setAttribute('aria-expanded','true');
  document.body.classList.add('nav-open');
  $('.app-shell').inert = true;
  $('#sidebar-close').focus();
}
function closeNav(returnFocus = true) {
  const wasOpen = $('#sidebar').classList.contains('open');
  $('#sidebar').classList.remove('open');
  $('#nav-overlay').hidden = true;
  $('#sidebar-toggle').setAttribute('aria-expanded','false');
  document.body.classList.remove('nav-open');
  $('.app-shell').inert = false;
  $('#sidebar').inert = !desktopNav.matches;
  if (wasOpen && returnFocus) $('#sidebar-toggle').focus();
}

function renderConnection() {
  const label = !state.connected ? state.data ? 'Terputus' : 'Menghubungkan' : state.synced && !state.error ? 'Tersambung' : 'Sinkronisasi';
  $('#connection').className = 'connection ' + (current() ? 'online' : state.data ? 'offline' : '');
  $('#connection-label').textContent = label;
  document.body.classList.toggle('stale-data',!!state.data && !current());
  const notice = $('#data-notice');
  let text = '';
  if (state.error) text = (state.data ? 'Data terakhir ditampilkan. ' : 'Keadaan kantor belum tersedia. ') + state.error;
  else if (!state.connected && state.data) text = 'Koneksi terputus. Data mungkin usang; tindakan ditahan sampai tersinkron. Draf tetap aman di tab ini.';
  else if (state.loading || !state.data || !state.synced) text = state.data ? 'Menyinkronkan keadaan kantor. Draf dan formulir tidak diubah.' : 'Mengambil keadaan kantor…';
  notice.hidden = !text;
  notice.className = 'data-notice' + (state.error ? ' error' : state.data && !current() ? ' stale' : '');
  $('#data-notice-text').textContent = text;
  $('#retry-btn').hidden = !state.error && (state.connected || !state.data);
  if (state.data) {
    const mode = state.data.llm_mode;
    $('#mode-banner').textContent = mode === 'mock' ? 'SIMULASI' : mode === 'live' ? 'LIVE' : 'MODE BELUM DIKETAHUI';
    $('#mode-banner').className = 'mode-label ' + (mode === 'mock' || mode === 'live' ? mode : '');
    $('#app-version').textContent = state.data.version ? 'v' + state.data.version : '—';
  }
  if (state.lastUpdated) $('#last-updated').textContent = 'Sinkron ' + dateText(state.lastUpdated, true);
  renderRoomStatus();
  updateControls();
  $$('.live-message').forEach(el => {
    el.classList.toggle('stale-stream',!current());
    $('.stream-label',el).textContent = current() ? 'Menulis' : 'Aliran terputus';
  });
}
function updateControls() {
  const editable = registryReady();
  $('#btn-add-agent').disabled = !editable;
  $('#set-save').disabled = !editable || state.mutations.has('settings');
  $('#clear-history').disabled = !editable;
  $('#set-key-remove').disabled = !editable;
  $('#send-btn').disabled = !current() || state.sending || !$('#msg-input').value.trim();
  $('#msg-input').disabled = !state.data;
  for (const id of ['set-name','set-model','set-key']) $('#' + id).disabled = !state.data || state.mutations.has('settings');
  $('#set-mode').disabled = !state.data || !!state.data.mode_locked || state.mutations.has('settings');
  $('#f-save').disabled = !editable;
  $('#f-delete').disabled = !editable;
  if (state.mutations.has('agent')) {
    // Keep original permission/coordinator locks across PUT and read-back verification.
    if (!agentFieldLocks) agentFieldLocks = $$('input,textarea,select',$('#agent-form')).map(input=>[input,input.disabled]);
    for (const [input] of agentFieldLocks) input.disabled = true;
  } else if (agentFieldLocks) {
    for (const [input,disabled] of agentFieldLocks) input.disabled = disabled;
    agentFieldLocks = null;
  }
  $$('[data-mutation]').forEach(b => { b.disabled = !editable; });
}
function renderRoomStatus() {
  const data = state.data;
  let text = !data ? 'Menunggu keadaan tim…' : !current() ? 'Keadaan tim belum tersinkron' : data.busy ? 'Tim sedang mengerjakan arahan' + (Number(data.queue) > 0 ? ' · ' + fmt(data.queue) + ' pesan dalam antrean' : '') : 'Tim siap menerima arahan';
  $('#room-status').textContent = text;
  $('#office-live-label').textContent = current() ? 'Tersinkron' : 'Belum tersinkron';
  $('#workbar').hidden = !current() || !data.busy;
  $('#workbar-text').textContent = text;
}
function renderOverview() {
  if (!state.data) return;
  const data = state.data, agents = getAgents(), tasks = getTasks(), memories = getMemories();
  const summary = data.summary;
  const active = summary?.active_agents ?? agents?.filter(a=>a.is_active).length;
  const running = summary?.tasks?.doing ?? tasks?.filter(t=>t.status === 'doing').length;
  const pending = summary?.pending_memories ?? memories?.filter(m=>m.status === 'pending').length;
  const rows = [
    ['Agen aktif',active,agents ? 'dari ' + fmt(agents.length) + ' agen terdaftar' : 'Jumlah terdaftar belum tersedia'],
    ['Tugas berjalan',running, tasks ? fmt(tasks.filter(t=>t.status==='queue').length) + ' tugas mengantre' : 'Antrean belum tersedia'],
    ['Menunggu persetujuan',pending,'usulan memori bersama'],
    ['Panggilan tercatat',state.usage?.total?.pesan,'seluruh periode · semua mode']
  ];
  $('#summary-metrics').innerHTML = rows.map(([label,value,note])=>'<div class="metric"><span>' + label + '</span><strong>' + fmt(value) + '</strong><small>' + esc(note) + '</small></div>').join('');
  $('#overview-intro').textContent = !current() ? 'Menampilkan keadaan terakhir. Menunggu sinkronisasi.' : data.busy ? 'Tim sedang bekerja. Pantau hasil dan keputusan yang memerlukan Anda.' : 'Kantor siap. Buka ruang kerja untuk memberi arahan ke tim.';
  const navCount = (id, n) => { $('#' + id).hidden = !Number(n); $('#' + id).textContent = fmt(n); };
  navCount('nav-task-count', tasks?.filter(t=>['queue','doing'].includes(t.status)).length);
  navCount('nav-memory-count', pending);
  $('#recent-tasks').innerHTML = !tasks ? empty('Tugas belum tersedia','Server belum memberikan daftar tugas.') : tasks.length ? tasks.slice(0,7).map(task=>'<button class="recent-row" data-action="task-detail" data-id="' + esc(task.id) + '"><div><h4>' + esc(task.title) + '</h4><p>' + esc(task.agent || 'Tanpa agen') + ' · ' + esc(dateText(task.updated_at || task.created_at,true)) + '</p></div>' + taskPill(task) + '</button>').join('') : empty('Belum ada pekerjaan','Kirim arahan di ruang kerja. Tugas langsung dan delegasi akan tercatat di sini.','<a class="btn secondary" href="#workroom">Mulai percakapan</a>');
  const waiting = memories?.filter(m=>m.status==='pending');
  $('#overview-pending').innerHTML = !waiting ? '<p class="muted">Daftar memori belum tersedia.</p>' : waiting.length ? waiting.slice(0,3).map(m=>'<div class="mini-memory"><strong>' + esc(m.key) + '</strong><p>' + esc(m.value) + '</p><small class="caption">Usulan ' + esc(m.source || 'agen') + '</small></div>').join('') + (waiting.length > 3 ? '<a href="#memories" class="text-link">Lihat ' + fmt(waiting.length) + ' usulan</a>' : '') : '<p class="muted">Tidak ada usulan menunggu. Tim dapat mengusulkan pengetahuan baru untuk Anda tinjau.</p>';
  $('#overview-team').innerHTML = !agents ? '<p class="muted">Daftar agen belum tersedia.</p>' : agents.length ? agents.filter(a=>a.is_active).slice(0,5).map(a=>{const st=agentStatus(a);return '<div class="team-line">' + avatar(a) + '<div class="team-info"><strong>' + esc(a.name) + '</strong><small>' + esc(a.is_orchestrator ? 'Koordinator' : a.role || 'Spesialis') + '</small></div>' + pill(st.label,st.kind) + '</div>';}).join('') || '<p class="muted">Tidak ada agen aktif.</p>' : '<p class="muted">Belum ada agen terdaftar.</p>';
}

function renderAgents() {
  const agents = getAgents();
  if (!agents) { if (state.data) $('#agents-list').innerHTML=empty('Daftar agen belum tersedia','Coba muat ulang keadaan kantor.'); return; }
  const query = $('#agent-search').value.trim().toLocaleLowerCase('id-ID');
  const filter = $('#agent-filter').value;
  const filtered = agents.filter(a=>(a.name + ' ' + (a.role || '')).toLocaleLowerCase('id-ID').includes(query) && (filter === 'all' || (filter === 'active' ? a.is_active : !a.is_active)));
  $('#agent-result-count').textContent = fmt(filtered.length) + ' dari ' + fmt(agents.length) + ' agen';
  $('#agents-list').innerHTML = filtered.length ? filtered.map(a=>{
    const st=agentStatus(a);
    return '<article class="surface agent-card ' + (!a.is_active?'inactive-agent':'') + '"><div class="agent-card-head">' + avatar(a) + '<div><h3>' + esc(a.name) + '</h3><p>' + esc(a.role || 'Peran belum diatur') + '</p><span class="agent-kicker">' + (a.is_orchestrator?'KOORDINATOR':'SPESIALIS') + '</span></div>' + pill(st.label,st.kind) + '</div><dl class="agent-properties"><div><dt>Model</dt><dd>' + esc(a.model || state.data.default_model || 'Default belum diatur') + (!a.model?' <span class="muted">· default kantor</span>':'') + '</dd></div><div><dt>Izin tindakan</dt><dd>' + toolTags(a.allowed_tools) + '</dd></div>' + (a.media_models?.length?'<div><dt>Media · metadata saja</dt><dd>' + esc(a.media_models.join(', ')) + '</dd></div>':'') + '</dl><div class="agent-actions"><button class="btn secondary" data-action="agent-inspect" data-id="' + esc(a.id) + '">Lihat profil</button><button class="btn subtle" data-action="agent-edit" data-mutation data-id="' + esc(a.id) + '" ' + (!registryReady()?'disabled':'') + '>Edit agen</button></div></article>';
  }).join('') : empty(query || filter !== 'all' ? 'Tidak ada agen cocok' : 'Tim belum dibentuk',query || filter !== 'all' ? 'Coba kata pencarian atau filter lain.' : 'Tambahkan koordinator dan spesialis untuk mulai bekerja.');
}
function renderOfficeList() {
  const agents = getAgents();
  if (!agents) return;
  const active = agents.filter(a=>a.is_active);
  $('#office-agent-list').innerHTML = active.length ? active.map(a=>{const st=agentStatus(a);return '<button class="office-agent" data-action="agent-inspect" data-id="' + esc(a.id) + '">' + avatar(a) + '<span class="agent-label"><strong>' + esc(a.name) + '</strong><small>' + esc(a.is_orchestrator?'Koordinator · ' + st.label:st.label) + '</small></span></button>';}).join('') : '<p class="muted small">Tidak ada agen aktif. Kelola tim untuk menambahkan agen.</p>';
  const activeNames = active.map(a=>a.name);
  if (active.filter(a=>!a.is_orchestrator).length > 1) activeNames.push('semua');
  $('#mention-chips').innerHTML = activeNames.map(name=>'<button type="button" class="mention-chip" data-action="mention" data-name="' + esc(name) + '">@' + esc(name) + '</button>').join('');
  const orchestrator = active.find(a=>a.is_orchestrator);
  $('#chat-routing').textContent = orchestrator ? 'Tanpa @ → ' + orchestrator.name + ' · @semua → tim spesialis' : 'Belum ada koordinator aktif. Periksa Tim agen.';
  updateOfficePage();
}
function syncOffice() {
  if (!window.Office) return;
  const visible = state.page === 'workroom' && (wideRoom.matches || state.view === 'office') && !document.hidden && !!state.data;
  if (Office.setVisible) Office.setVisible(visible);
  else if (visible && Office.onShow) Office.onShow();
}
function updateOfficeData() {
  if (!window.Office || !state.data) return;
  Office.setAgents(getAgents() || []);
  Office.setTasks(getTasks() || []);
  if (Office.setStatuses) Office.setStatuses(current() ? state.data.agent_statuses || {} : {});
  updateOfficePage();
  syncOffice();
}
function updateOfficePage() {
  const info = window.Office?.pageInfo ? Office.pageInfo() : {page:1,pages:1};
  const page = Number.isFinite(Number(info.page)) ? Number(info.page) : 1;
  const pages = Math.max(1,Number(info.pages)||1);
  $('#office-page').textContent = 'Zona ' + page + ' / ' + pages;
  $('#office-prev').disabled = page <= 1;
  $('#office-next').disabled = page >= pages;
}
function stepOffice(direction) { if (window.Office?.pageInfo && Office.setPage) { Office.setPage(Office.pageInfo().page + direction); updateOfficePage(); } }

function renderTasks() {
  const tasks = getTasks();
  if (!tasks) { if (state.data) $('#task-board').innerHTML=empty('Tugas belum tersedia','Server belum memberikan daftar tugas.'); return; }
  const agentSelect = $('#task-agent'), selectedAgent = agentSelect.value;
  const names = [...new Set([...(getAgents()||[]).map(a=>a.name),...tasks.map(t=>t.agent).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'id'));
  agentSelect.innerHTML = '<option value="all">Semua agen</option>' + names.map(name=>'<option value="' + esc(name) + '">' + esc(name) + '</option>').join('');
  agentSelect.value = names.includes(selectedAgent) ? selectedAgent : 'all';
  const query = $('#task-search').value.trim().toLocaleLowerCase('id-ID'), status = $('#task-status').value;
  const filtered = tasks.filter(t=>(agentSelect.value==='all' || t.agent===agentSelect.value) && (status==='all' || t.status===status) && String(t.title||'').toLocaleLowerCase('id-ID').includes(query));
  $('#task-result-count').textContent = fmt(filtered.length) + ' dari ' + fmt(tasks.length) + ' tugas';
  const statuses = status === 'all' ? Object.keys(TASK_LABELS) : [status];
  $('#task-board').innerHTML = statuses.map(key=>{
    const rows = filtered.filter(t=>t.status===key);
    return '<section class="task-column"><div class="task-column-head"><span class="status-dot ' + key + '"></span><h3>' + TASK_LABELS[key] + '</h3><span class="count">' + fmt(rows.length) + '</span></div>' + (rows.length ? rows.map(t=>'<button class="task-card ' + (key==='failed'?'failed-card':'') + '" data-action="task-detail" data-id="' + esc(t.id) + '"><span class="task-card-id">TUGAS #' + esc(t.id) + '</span><h4>' + esc(t.title) + '</h4>' + (t.error || t.result ? '<p class="task-card-preview">' + esc(t.error || t.result) + '</p>' : '') + '<span class="task-card-footer"><strong>' + esc(t.agent || 'Tanpa agen') + '</strong><time>' + esc(dateText(t.updated_at || t.created_at,true)) + '</time></span></button>').join('') : '<p class="column-empty">' + (tasks.length?'Tidak ada tugas cocok':'Belum ada tugas') + '</p>') + '</section>';
  }).join('');
}
function renderMemories() {
  const memories = getMemories();
  if (!memories) { if(state.data) $('#memory-list').innerHTML=empty('Memori belum tersedia','Coba muat ulang keadaan kantor.'); return; }
  $$('[data-memory-count]').forEach(el=>{el.textContent=fmt(memories.filter(m=>m.status===el.dataset.memoryCount).length);});
  $$('#memory-tabs button').forEach(button=>{const on=button.dataset.status===state.memoryStatus;button.classList.toggle('active',on);button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;});
  const query = $('#memory-search').value.trim().toLocaleLowerCase('id-ID');
  const filtered = memories.filter(m=>m.status===state.memoryStatus && (String(m.key)+' '+String(m.value)+' '+String(m.source||'')).toLocaleLowerCase('id-ID').includes(query));
  const descriptions={pending:'Saat agen mengusulkan memori baru, Anda dapat meninjau isinya di sini.',approved:'Memori yang Anda setujui akan menjadi pengetahuan aktif bersama.',rejected:'Usulan yang ditolak tetap dapat ditinjau di sini.',superseded:'Memori yang digantikan oleh persetujuan baru disimpan sebagai riwayat.'};
  $('#memory-list').innerHTML = filtered.length ? filtered.map(m=>'<article class="surface memory-card"><div class="memory-card-head"><h3>' + esc(m.key) + '</h3>' + pill(MEMORY_LABELS[m.status]||'Tidak dikenal',m.status) + '</div><div class="memory-value">' + esc(m.value) + '</div><div class="memory-meta">Diusulkan oleh <b>' + esc(m.source || 'Tidak diketahui') + '</b><br>' + esc(dateText(m.created_at)) + (m.updated_at && m.updated_at!==m.created_at?'<br>Diperbarui ' + esc(dateText(m.updated_at)):'') + '</div>' + (m.status==='pending'?'<div class="memory-actions"><button class="btn primary" data-mutation data-action="memory-approve" data-id="' + esc(m.id) + '" ' + (!registryReady()?'disabled':'') + '>Setujui memori</button><button class="btn secondary" data-mutation data-action="memory-reject" data-id="' + esc(m.id) + '" ' + (!registryReady()?'disabled':'') + '>Tolak</button></div>':'') + '</article>').join('') : '<div class="surface">' + empty(query?'Tidak ada memori cocok':'Belum ada memori ' + MEMORY_LABELS[state.memoryStatus].toLowerCase(),query?'Coba kata pencarian lain.':descriptions[state.memoryStatus]) + '</div>';
}

function renderUsage() {
  if (!state.usage) {
    if (state.usageError) {
      $('#usage-summary').innerHTML=errorBox('Pemakaian belum tersedia. ' + state.usageError,'usage-retry');
      $('#usage-table').innerHTML=empty('Rincian belum tersedia','Tidak ada biaya yang diasumsikan nol.');
    }
    return;
  }
  const usage = state.usage;
  const labels = {live:'Live',mock:'Simulasi',legacy:'Data lama'};
  $('#usage-summary').innerHTML = (state.usageError ? errorBox('Menampilkan pemakaian terakhir; pembaruan gagal. ' + state.usageError,'usage-retry') : '') + ['live','mock','legacy'].map(mode=>'<section class="surface"><div class="section-head"><h3>' + labels[mode] + '</h3>' + pill(mode==='mock'?'BUKAN TAGIHAN':mode==='legacy'?'BELUM TERVERIFIKASI':'API BERBAYAR',mode) + '</div><div class="surface-body">' + U.usageMetrics(usage.by_mode?.[mode],mode) + '</div></section>').join('');
  const filter = $('#usage-mode').value;
  const rows = Array.isArray(usage.per_agent) ? usage.per_agent.filter(r=>filter==='all' || (r.mode||'legacy')===filter) : [];
  $('#usage-table').innerHTML = rows.length ? '<table class="usage-table"><caption class="sr-only">Pemakaian per agen dan mode, seluruh periode, mata uang dolar AS</caption><thead><tr><th scope="col">Agen</th><th scope="col">Mode</th><th scope="col" class="num">Panggilan</th><th scope="col" class="num">Token masuk</th><th scope="col" class="num">Token keluar</th><th scope="col" class="num">Tercatat</th><th scope="col" class="num">Estimasi manual</th><th scope="col" class="num">Subtotal diketahui</th><th scope="col" class="num">Tak diketahui</th></tr></thead><tbody>' + rows.map(r=>{const mode=['live','mock','legacy'].includes(r.mode)?r.mode:'legacy';return '<tr><td>' + esc(r.sender_name) + '</td><td>' + pill(labels[mode],mode) + '</td><td class="num">' + fmt(r.pesan) + '</td><td class="num">' + fmt(r.ptok) + '</td><td class="num">' + fmt(r.ctok) + '</td><td class="num">' + (mode==='mock'?'Bukan tagihan':money(r.recorded_cost)) + '</td><td class="num">' + (mode==='mock'?'—':money(r.estimated_cost)) + '</td><td class="num">' + (mode==='mock'?'—':money(r.cost)) + '</td><td class="num unknown-cost">' + (mode==='mock'?'—':fmt(r.unknown_count)) + '</td></tr>';}).join('') + '</tbody></table>' : empty('Belum ada catatan untuk mode ini','Catatan dibuat ketika agen menjalankan panggilan, termasuk respons tool-only.');
}
async function loadUsage() {
  if (state.usageLoading) return;
  state.usageLoading=true;
  $('#usage-refresh').disabled=true;
  try {state.usage=await api('/api/usage');state.usageError='';renderUsage();renderOverview();}
  catch(e){state.usageError=e.message;renderUsage();}
  finally{state.usageLoading=false;$('#usage-refresh').disabled=false;}
}
function renderSettings() {
  const data=state.data;
  if (!data) return;
  if (!state.settingsDirty && !state.mutations.has('settings')) {
    $('#set-name').value=data.user_name || '';
    $('#set-model').value=data.default_model || '';
    $('#set-mode').value=['mock','live'].includes(data.llm_setting)?data.llm_setting:'mock';
  }
  $('#settings-dirty').hidden=!state.settingsDirty;
  $('#key-status').textContent=data.has_key?'Kunci tersedia':'Belum ada kunci';
  $('#key-status').className='pill ' + (data.has_key?'approved':'neutral');
  $('#set-key-remove').hidden=!data.has_key;
  $('#mode-locked').hidden=!data.mode_locked;
  $('#mode-help').textContent=(data.llm_mode==='mock'?'Efektif: Simulasi. Tidak ada panggilan AI sungguhan.':'Efektif: Live. Panggilan agen dapat menimbulkan biaya.') + (data.busy?' Tunggu pekerjaan selesai sebelum menyimpan setelan.':'');
}
function fillModels() {
  $('#model-options').innerHTML=(Array.isArray(state.data?.models)?state.data.models:[]).map(m=>'<option value="' + esc(m.id) + '" label="' + esc((m.label || m.id) + (m.note?' · '+m.note:'') + ' · daftar manual, belum diverifikasi') + '"></option>').join('');
}
function renderAll() {
  renderConnection();renderOverview();renderAgents();renderOfficeList();renderTasks();renderMemories();renderUsage();renderSettings();fillModels();updateOfficeData();
}

/* Chat state is authoritative; SSE events update it before touching the DOM. */
function messageMeta(message) {
  if (message.sender_type!=='agent') return '';
  const mode=message.mode || 'legacy';
  let detail=(message.model || 'Model tidak tercatat') + ' · ' + fmt(message.ptok) + ' masuk / ' + fmt(message.ctok) + ' keluar';
  if (mode==='mock') detail+=' · token simulasi, bukan tagihan';
  else if (mode==='legacy') detail+=' · asal biaya lama belum terverifikasi';
  else detail+=' · ' + (message.cost_source==='unknown' || message.cost==null?'biaya belum diketahui':message.cost_source==='recorded'?'tercatat '+money(message.cost):message.cost_source==='estimated'?'estimasi manual '+money(message.cost):'biaya belum terverifikasi');
  return detail;
}
function messageHtml(message) {
  const type=['user','agent','system'].includes(message.sender_type)?message.sender_type:'system';
  const mode=message.mode==='mock'?'mock':message.mode==='live'?'live':'legacy';
  const badge=type==='agent'?pill(mode==='mock'?'SIMULASI':mode==='live'?'LIVE':'DATA LAMA',mode):'';
  return '<article class="message ' + type + '" data-message-id="' + esc(message.id) + '"><div class="message-header"><strong>' + esc(message.sender_name || 'Sistem') + '</strong>' + badge + '<time title="' + esc(dateText(message.created_at)) + '">' + esc(dateText(message.created_at,true)) + '</time></div><div class="message-body">' + U.markdown(message.content) + '</div><div class="message-footer"><span class="message-model">' + esc(messageMeta(message)) + '</span><button class="copy-message" data-action="copy-message" data-id="' + esc(message.id) + '" aria-label="Salin pesan dari ' + esc(message.sender_name||'Sistem') + '">' + icon('copy') + '<span>Salin</span></button></div></article>';
}
function streamHtml(agent,text) {return '<article class="message agent live-message ' + (!current()?'stale-stream':'') + '" data-live-agent="' + esc(agent) + '"><div class="message-header"><strong>' + esc(agent) + '</strong><span class="stream-marker"><span class="status-dot"></span><span class="stream-label">' + (current()?'Menulis':'Aliran terputus') + '</span></span></div><div class="message-body"></div></article>';}
function scrollChat(force = false) {
  if (force || chatPinned) {const box=$('#messages');box.scrollTop=box.scrollHeight;chatPinned=true;$('#new-messages').hidden=true;}
}
function renderMessages(force = false) {
  const box=$('#messages');
  const oldTop=box.scrollTop;
  if (!state.messagesLoaded && !state.messages.length) {
    box.innerHTML=state.messageError?empty('Percakapan belum tersedia',state.messageError,'<button class="btn secondary" data-action="refresh">Coba lagi</button>'):empty('Memuat percakapan','Riwayat tersimpan akan muncul di sini.');
    return;
  }
  box.innerHTML=(state.messageError?errorBox('Riwayat terakhir ditampilkan. ' + state.messageError,'refresh'):'') + (state.messages.length?state.messages.map(messageHtml).join(''):state.streams.size?'':empty('Percakapan dimulai dari arahan Anda','Tulis tujuan, konteks, dan hasil yang dibutuhkan. Koordinator akan membantu tim bekerja.'));
  for (const [agent, stream] of state.streams) {
    box.insertAdjacentHTML('beforeend',streamHtml(agent,stream.text));
    $('.message-body',box.lastElementChild).textContent=stream.text;
  }
  $('#chat-count').textContent=fmt(state.messages.length) + ' pesan dimuat';
  if (force || chatPinned) requestAnimationFrame(()=>scrollChat(true)); else box.scrollTop=oldTop;
}
function addMessage(message) {
  if (!message || message.id==null) return;
  const existing=state.messages.findIndex(m=>String(m.id)===String(message.id));
  state.messages=U.reconcileMessages(state.messages,[message]);
  if (message.sender_type==='agent') clearStream(message.sender_name,false);
  state.messagesLoaded=true;
  const box=$('#messages');
  if (existing>=0 || $('.empty-state',box) || state.messageError) {renderMessages();return;}
  box.insertAdjacentHTML('beforeend',messageHtml(message));
  $('#chat-count').textContent=fmt(state.messages.length) + ' pesan dimuat';
  if (chatPinned) scrollChat(); else $('#new-messages').hidden=false;
}
function addDelta(agent,text,taskId) {
  if (!agent || typeof text!=='string') return;
  const name=String(agent);
  const status=state.data?.agent_statuses?.[name];
  const task=taskId??status?.task_id;
  // During a snapshot, its roster/status may be newer than the last known state.
  if(task==null||(!snapshotEvents&&state.data&&(!(getAgents()||[]).some(a=>a.name===name&&a.is_active)||status?.status!=='working'||status.task_id!==task)))return;
  const previous=state.streams.get(name);
  state.streams.set(name,{task_id:task,text:(previous?.task_id===task?previous.text:'')+text});
  const box=$('#messages');
  let node=$$('.live-message',box).find(el=>el.dataset.liveAgent===name);
  if (!node) {
    if ($('.empty-state',box)) box.innerHTML='';
    box.insertAdjacentHTML('beforeend',streamHtml(name,''));
    node=box.lastElementChild;
  }
  $('.message-body',node).textContent=state.streams.get(name).text;
  if (chatPinned) scrollChat(); else $('#new-messages').hidden=false;
}
function clearStream(agent,render = true) {
  state.streams.delete(agent);
  $$('.live-message').filter(el=>el.dataset.liveAgent===agent).forEach(el=>el.remove());
  if (render && !state.messages.length && !state.streams.size) renderMessages();
}
function persistDraft() {
  const value=$('#msg-input').value;
  storageSet('ks-message-draft',value);
  $('#draft-status').textContent=value.trim()?'Draf di tab ini':'';
  updateControls();
}
function autoGrow() {const input=$('#msg-input');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,wideRoom.matches?130:100)+'px';}
function insertMention(name) {
  const input=$('#msg-input');
  if (state.page!=='workroom') navigate('workroom');
  const at=input.selectionStart ?? input.value.length, end=input.selectionEnd ?? at;
  const mention='@'+name+' ';
  input.value=input.value.slice(0,at)+(at>0 && !/\s$/.test(input.value.slice(0,at))?' ':'')+mention+input.value.slice(end);
  const next=at+mention.length+(at>0 && !/\s/.test(input.value.charAt(at-1))?1:0);
  input.focus({preventScroll:true});input.setSelectionRange(next,next);autoGrow();persistDraft();
}
async function sendMessage(event) {
  if (event) event.preventDefault();
  const input=$('#msg-input'), raw=input.value, content=raw.trim();
  if (!content || state.sending) return;
  if (content.length>4000) {inlineError('send-error','Pesan maksimal 4.000 karakter. Ringkas arahan atau kirim dalam beberapa bagian.');return;}
  if (!current()) {inlineError('send-error','Tunggu kantor tersambung dan tersinkron. Draf tidak dihapus.');return;}
  if (state.data.llm_mode==='live' && !state.data.has_key) {inlineError('send-error','Mode Live belum memiliki kunci API. Isi kunci di Setelan atau pilih Simulasi.');return;}
  state.sending=true;updateControls();inlineError('send-error','');
  try {
    await api('/api/messages',{method:'POST',body:JSON.stringify({content})});
    // Keep edits made while the request was in flight; never overwrite a new draft.
    if (input.value===raw) {input.value='';autoGrow();persistDraft();}
    chatPinned=true;
    await U.afterPending(refreshPromise, refreshAll);
    scrollChat(true);
  } catch(e) {inlineError('send-error','Pesan belum terkirim. ' + e.message);persistDraft();}
  finally {state.sending=false;updateControls();}
}

/* Snapshot and event reconciliation. Deltas live outside snapshots; dirty forms never reset. */
function applyEventData(event) {
  const data=state.data;
  if (!data) return;
  if (event.type==='agent_status') {
    data.agent_statuses={...(data.agent_statuses||{}),[event.agent]:{status:event.status,task_id:event.task_id??null}};
    const a=data.agents?.find(a=>a.name===event.agent);if(a)a.status=event.status;
  } else if(event.type==='room_status') {data.busy=event.status==='working';data.queue=Number(event.queue)||0;}
}
function handleEvent(event) {
  if (!event || typeof event.type!=='string') return;
  if(snapshotEvents)snapshotEvents.push(event);
  if(window.Office?.handleEvent)Office.handleEvent(event);
  applyEventData(event);
  switch(event.type) {
    case 'message':addMessage(event.message);scheduleRefresh();break;
    case 'delta':addDelta(event.agent,event.text,event.task_id);break;
    case 'agent_status':
      if(event.status!=='working'||(state.streams.has(event.agent)&&state.streams.get(event.agent).task_id!==event.task_id))clearStream(event.agent);
      renderConnection();renderAgents();renderOfficeList();renderOverview();
      if(window.Office?.setStatuses)Office.setStatuses(current()?state.data?.agent_statuses||{}:{});
      if(event.status!=='working')scheduleRefresh();break;
    case 'room_status':renderConnection();renderSettings();if(!state.data?.busy)scheduleRefresh();break;
    case 'cleared':historyEpoch++;state.messages=[];state.streams.clear();state.messagesLoaded=true;renderMessages(true);scheduleRefresh();break;
    case 'agents_changed':case 'memories_changed':case 'tasks_changed':case 'state_changed':case 'usage_changed':scheduleRefresh();break;
    case 'delegation':break;
    default:break;
  }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>refreshAll(),250);
}
async function refreshAll() {
  if (refreshPromise) {refreshQueued=true;return refreshPromise;}
  const sequence=++snapshotSequence, epoch=historyEpoch;
  state.loading=true;
  snapshotEvents=[];
  renderConnection();
  refreshPromise=(async()=>{
    const results=await Promise.allSettled([api('/api/state'),api('/api/messages')]);
    if(sequence!==snapshotSequence)return;
    const buffered=snapshotEvents||[];snapshotEvents=null;
    if(results[0].status==='fulfilled') {
      const data=results[0].value;
      if(!Array.isArray(data.agents))throw new Error('Snapshot kantor tidak lengkap.');
      state.data=data;
      state.usage=data.usage || state.usage;
      state.error='';state.synced=state.connected;state.lastUpdated=new Date().toISOString();
      for(const event of buffered)applyEventData(event);
      // Preserve fragments only for an active roster entry still working on that task.
      // Replay newer status events first so a concurrent same-task delta is not discarded.
      for(const [agent,stream] of state.streams) {
        const status=data.agent_statuses?.[agent];
        if(!data.agents.some(a=>a.name===agent&&a.is_active)||status?.status!=='working'||stream.task_id==null||status.task_id!==stream.task_id)clearStream(agent,false);
      }
    } else {
      state.error=results[0].reason.message;state.synced=false;
    }
    if(results[1].status==='fulfilled' && epoch===historyEpoch) {
      const list=results[1].value.messages;
      if(Array.isArray(list)) {
        const messagesDuringFetch=buffered.filter(e=>e.type==='message').map(e=>e.message);
        state.messages=U.reconcileMessages(list,messagesDuringFetch);
        state.messagesLoaded=true;state.messageError='';
      } else state.messageError='Respons riwayat tidak lengkap.';
    } else if(results[1].status==='rejected')state.messageError=results[1].reason.message;
    renderAll();renderMessages();
  })().catch(e=>{state.error=e.message;state.synced=false;renderConnection();if(!state.data)renderInitialFailure();})
  .finally(()=>{
    state.loading=false;refreshPromise=null;snapshotEvents=null;renderConnection();
    if(state.error&&!state.data)renderInitialFailure();
    if(refreshQueued){refreshQueued=false;scheduleRefresh();}
  });
  return refreshPromise;
}
function renderInitialFailure() {
  const html=empty('Kantor belum dapat dimuat',state.error || 'Periksa koneksi dan coba lagi.','<button class="btn secondary" data-action="refresh">Coba lagi</button>');
  for(const id of ['recent-tasks','agents-list','task-board','memory-list'])$('#'+id).innerHTML=html;
  $('#overview-team').textContent='Data tim belum tersedia.';
  $('#overview-pending').textContent='Usulan memori belum tersedia.';
  $('#agent-result-count').textContent='Data belum tersedia';
  $('#task-result-count').textContent='Data belum tersedia';
  $('#office-agent-list').textContent='Daftar agen belum tersedia. Coba hubungkan ulang kantor.';
  $('#usage-summary').innerHTML=errorBox('Pemakaian belum tersedia. Hubungkan ulang kantor untuk mengambil data.','refresh');
  $('#usage-table').innerHTML=empty('Rincian belum tersedia','Biaya tidak diasumsikan nol ketika data gagal dimuat.');
  $('#mode-help').textContent='Konfigurasi belum tersedia. Coba hubungkan ulang kantor sebelum menyimpan setelan.';
  if(!state.messagesLoaded)renderMessages();
}
function connect() {
  if(source)source.close();
  if(!('EventSource' in window)){state.error='Browser ini tidak mendukung koneksi peristiwa. Gunakan browser modern.';renderConnection();return;}
  source=new EventSource('/api/events');
  source.onopen=()=>{state.connected=true;state.synced=false;renderConnection();refreshAll();};
  source.onerror=()=>{state.connected=false;state.synced=false;renderConnection();renderAgents();renderOfficeList();updateOfficeData();};
  source.onmessage=event=>{
    try{handleEvent(JSON.parse(event.data));}
    catch(_){state.error='Pembaruan kantor tidak terbaca. Muat ulang data untuk menyinkronkan.';state.synced=false;renderConnection();scheduleRefresh();}
  };
}

/* Native modal confirmations: never browser confirm(), never implicit paid activation. */
function confirmAction(title, description, label, danger = false) {
  const dialog=$('#confirm-dialog');
  if(dialog.open)return Promise.resolve(false);
  $('#confirm-title').textContent=title;$('#confirm-description').textContent=description;
  $('#confirm-accept').textContent=label;$('#confirm-accept').className='btn '+(danger?'danger':'primary');
  dialog.returnValue='cancel';
  return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='accept'),{once:true});dialog.showModal();});
}
function showDetail(title, body, actions = '') {
  $('#detail-title').textContent=title;$('#detail-body').innerHTML=body;
  $('#detail-actions').innerHTML=actions || '<button class="btn secondary" data-close="detail-dialog">Tutup</button>';
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
function inspectAgent(agent) {
  if(!agent)return;
  state.detail={type:'agent',id:agent.id};
  const st=agentStatus(agent);
  const body='<div class="inspector-person">'+avatar(agent)+'<div><h3>'+esc(agent.name)+'</h3><p>'+esc(agent.role||'Peran belum diatur')+'</p></div></div><dl class="detail-meta"><div><dt>Peran dalam tim</dt><dd>'+esc(agent.is_orchestrator?'Koordinator':'Spesialis')+'</dd></div><div><dt>Keadaan</dt><dd>'+pill(st.label,st.kind)+'</dd></div><div><dt>Model efektif</dt><dd>'+esc(agent.model||state.data.default_model||'Belum diatur')+'</dd></div><div><dt>Izin tindakan</dt><dd>'+toolTags(agent.allowed_tools)+'</dd></div></dl><section class="detail-section"><h3>Instruksi agen</h3><div class="inspector-prompt">'+esc(agent.system_prompt||'Belum ada instruksi khusus.')+'</div></section>'+(agent.media_models?.length?'<section class="detail-section"><h3>Model media · metadata saja</h3><p class="muted small">'+esc(agent.media_models.join(', '))+'<br>Produksi media belum terhubung.</p></section>':'');
  showDetail('Profil agen',body,'<button class="btn secondary" data-mutation data-action="agent-edit" data-id="'+esc(agent.id)+'" '+(!registryReady()?'disabled':'')+'>Edit agen</button><div class="spacer"></div><button class="btn primary" data-action="agent-talk" data-id="'+esc(agent.id)+'" '+(!agent.is_active?'disabled':'')+'>Bicara dengan '+esc(agent.name)+'</button>');
}
async function inspectTask(id) {
  const sequence=++detailSequence;
  state.detail={type:'task',id};
  showDetail('Detail tugas #'+id,'<p class="muted">Mengambil hasil dan detail tugas…</p>');
  try {
    const response=await api('/api/tasks/'+idPath(id));
    if(sequence!==detailSequence||!$('#detail-dialog').open)return;
    const task=response.task;if(!task)throw new Error('Detail tugas tidak ditemukan.');
    const meta='<dl class="detail-meta"><div><dt>Status pekerjaan</dt><dd>'+taskPill(task)+'</dd></div><div><dt>Penanggung jawab</dt><dd>'+esc(task.agent||'Tanpa agen')+'</dd></div><div><dt>Dibuat</dt><dd>'+esc(dateText(task.created_at))+'</dd></div><div><dt>Diperbarui</dt><dd>'+esc(dateText(task.updated_at))+'</dd></div></dl>';
    showDetail('Tugas #'+task.id,'<p class="detail-description">'+esc(task.title)+'</p>'+meta+(task.error?'<section class="detail-section"><h3>Alasan gagal</h3><div class="result-error">'+esc(task.error)+'</div></section>':'')+'<section class="detail-section"><h3>Hasil pekerjaan</h3><div class="result-body">'+(task.result?U.markdown(task.result):'<p class="muted">'+(task.status==='queue'?'Tugas belum dimulai.':task.status==='doing'?'Hasil akan tersedia setelah agen selesai.':task.status==='failed'?'Tidak ada hasil yang tercatat.':'Tugas selesai tanpa hasil teks yang tercatat.')+'</p>')+'</div></section>');
  } catch(e) {
    if(sequence!==detailSequence||!$('#detail-dialog').open)return;
    $('#detail-body').innerHTML=errorBox(e.message)+'<button class="btn secondary" data-action="task-detail" data-id="'+esc(id)+'">Coba lagi</button>';
  }
}
function selectedTools() {return $$('input[name="allowed-tool"]:checked',$('#f-tools')).map(el=>el.value);}
function renderTools(tools) {
  const orchestrator=$('#f-orch').checked;
  $('#f-tools').innerHTML=U.TOOLS.map(tool=>{
    const allowed=orchestrator||tool==='usulkan_memori';
    return '<label class="check"><input type="checkbox" name="allowed-tool" value="'+tool+'" '+(allowed&&tools.includes(tool)?'checked ':'')+(!allowed?'disabled':'')+'><span>'+TOOL_LABELS[tool]+'<small><code>'+tool+'</code>'+(!allowed?' · khusus koordinator':'')+'</small></span></label>';
  }).join('');
}
function openAgent(agent) {
  if(!registryReady()){toast('Tunggu kantor tersinkron dan pekerjaan selesai sebelum mengubah agen.',true);return;}
  if($('#detail-dialog').open)$('#detail-dialog').close();
  state.editingId=agent?.id??null;state.agentDirty=false;
  $('#agent-form').reset();inlineError('agent-error','');
  $('#agent-dialog-title').textContent=agent?'Edit agen · '+agent.name:'Agen baru';
  $('#f-name').value=agent?.name||'';$('#f-role').value=agent?.role||'';$('#f-model').value=agent?.model||'';$('#f-prompt').value=agent?.system_prompt||'';
  $('#f-active').checked=agent?!!agent.is_active:true;$('#f-orch').checked=!!agent?.is_orchestrator;
  $('#f-orch').disabled=!!agent?.is_orchestrator;
  $('#f-active').disabled=!!agent?.is_orchestrator;
  $('#coordinator-help').textContent=agent?.is_orchestrator?'Koordinator harus tetap aktif. Untuk menggantinya, jadikan agen lain sebagai koordinator.':'Memilih koordinator baru menggantikan koordinator lama. Konfirmasi diperlukan saat menyimpan.';
  $('#f-media').value=(agent?.media_models||[]).join(', ');
  renderTools(agent?.allowed_tools||['usulkan_memori']);
  $('#f-delete').hidden=!agent||!!agent.is_orchestrator;
  $('#agent-dialog').showModal();
}
async function closeAgent() {
  if(state.mutations.has('agent'))return;
  if(state.agentDirty && !await confirmAction('Tutup tanpa menyimpan?','Perubahan formulir agen akan dibuang. Agen tersimpan tidak berubah.','Buang perubahan',true))return;
  $('#agent-dialog').close();state.agentDirty=false;
}
async function saveAgent(event) {
  event.preventDefault();
  if(!registryReady()){inlineError('agent-error','Tunggu koneksi tersinkron dan pekerjaan selesai.');return;}
  inlineError('agent-error','');
  let payload;
  try {
    payload=U.agentPayload({id:state.editingId,name:$('#f-name').value,role:$('#f-role').value,model:$('#f-model').value,system_prompt:$('#f-prompt').value,is_active:$('#f-active').checked,is_orchestrator:$('#f-orch').checked,allowed_tools:selectedTools(),media_models:$('#f-media').value.split(',')},getAgents()||[]);
    const wasCoordinator=getAgents()?.find(a=>String(a.id)===String(state.editingId))?.is_orchestrator;
    if(payload.is_orchestrator&&!wasCoordinator && !await confirmAction('Ganti koordinator tim?','Agen '+payload.name+' akan menjadi satu-satunya koordinator aktif. Koordinator sebelumnya tetap menjadi agen spesialis. Tinjau izin tindakan sebelum menyimpan.','Tetapkan koordinator'))return;
    state.mutations.add('agent');updateControls();
    const result=await api(state.editingId==null?'/api/agents':'/api/agents/'+idPath(state.editingId),{method:state.editingId==null?'POST':'PUT',body:JSON.stringify(payload)});
    await U.afterPending(refreshPromise, refreshAll);
    const saved=getAgents()?.find(a=>String(a.id)===String(state.editingId??result.agent?.id)||a.name===payload.name);
    if(state.error||!saved||saved.name!==payload.name||saved.role!==payload.role||saved.model!==payload.model||saved.system_prompt!==payload.system_prompt||!!saved.is_active!==payload.is_active||!!saved.is_orchestrator!==payload.is_orchestrator||JSON.stringify(saved.allowed_tools)!==JSON.stringify(payload.allowed_tools)||JSON.stringify(saved.media_models)!==JSON.stringify(payload.media_models))throw new Error('Permintaan diproses, tetapi hasil simpan belum dapat diverifikasi. Muat ulang sebelum mengulang.');
    $('#agent-dialog').close();state.agentDirty=false;toast('Agen '+payload.name+' disimpan.');
  }catch(e){inlineError('agent-error',e.message);}
  finally{state.mutations.delete('agent');renderAll();}
}
async function deleteAgent() {
  const agent=getAgents()?.find(a=>String(a.id)===String(state.editingId));
  if(!agent||agent.is_orchestrator||!registryReady())return;
  if(!await confirmAction('Hapus agen '+agent.name+'?','Agen akan dihapus dari tim. Riwayat pesan, tugas, pemakaian, dan memori tetap tersimpan.','Hapus agen',true))return;
  state.mutations.add('agent');updateControls();
  try {
    await api('/api/agents/'+idPath(agent.id),{method:'DELETE'});await U.afterPending(refreshPromise, refreshAll);
    if(state.error||!getAgents()||getAgents().some(a=>String(a.id)===String(agent.id)))throw new Error('Penghapusan belum terverifikasi. Muat ulang sebelum mengulang.');
    $('#agent-dialog').close();state.agentDirty=false;toast('Agen dihapus dari tim.');
  }catch(e){inlineError('agent-error',e.message);}
  finally{state.mutations.delete('agent');renderAll();}
}
async function decideMemory(id,approved) {
  const memory=getMemories()?.find(m=>String(m.id)===String(id));
  if(!memory||memory.status!=='pending'||!registryReady())return;
  const replacing=approved&&getMemories().find(m=>m.status==='approved'&&String(m.key).trim().toLowerCase()===String(memory.key).trim().toLowerCase());
  if(replacing && !await confirmAction('Ganti memori aktif?','Persetujuan untuk “'+memory.key+'” akan menggantikan versi aktif sebelumnya. Versi lama masuk daftar Digantikan.','Setujui penggantian'))return;
  state.mutations.add('memory');updateControls();
  try {
    await api('/api/memories/'+idPath(id)+'/'+(approved?'approve':'reject'),{method:'POST'});
    await U.afterPending(refreshPromise, refreshAll);
    const updated=getMemories()?.find(m=>String(m.id)===String(id));
    if(!updated||updated.status!==(approved?'approved':'rejected'))throw new Error('Keputusan belum terverifikasi. Muat ulang daftar memori.');
    toast(approved?'Memori disetujui dan aktif.':'Usulan memori ditolak.');
  }catch(e){toast(e.message,true);scheduleRefresh();}
  finally{state.mutations.delete('memory');renderAll();}
}
async function saveSettings(event) {
  event.preventDefault();
  if(!registryReady()){inlineError('settings-error','Tunggu kantor tersinkron dan pekerjaan selesai.');return;}
  inlineError('settings-error','');
  const version=state.settingsVersion;
  const values={user_name:$('#set-name').value,default_model:$('#set-model').value,llm_mode:$('#set-mode').value,api_key:$('#set-key').value,mode_locked:!!state.data.mode_locked};
  if(values.llm_mode==='live'&&!values.mode_locked) {
    if(!state.data.has_key&&!values.api_key.trim()){inlineError('settings-error','Isi kunci API sebelum memilih Live. Tidak ada fallback otomatis ke simulasi.');return;}
    if(!await confirmAction('Aktifkan pemakaian Live?','Agen akan menggunakan API OpenRouter dengan kunci Anda. Panggilan berikutnya dapat menimbulkan biaya nyata sesuai model. Menyimpan setelan ini tidak mengirim pesan atau menjalankan tugas.','Saya setuju, simpan Live'))return;
    values.confirm_live=true;
  }
  state.mutations.add('settings');updateControls();
  try {
    const payload=U.settingsPayload(values);
    await api('/api/settings',{method:'POST',body:JSON.stringify(payload)});
    await U.afterPending(refreshPromise, refreshAll);
    if(state.error||state.data.user_name!==payload.user_name||state.data.default_model!==payload.default_model||(payload.llm_mode&&state.data.llm_setting!==payload.llm_mode)||(payload.api_key&&!state.data.has_key))throw new Error('Permintaan diproses, tetapi setelan tersimpan belum terverifikasi. Muat ulang sebelum mengulang.');
    if(state.settingsVersion===version){state.settingsDirty=false;$('#set-key').value='';}
    $('#settings-feedback').textContent='Setelan tersimpan · '+dateText(new Date().toISOString(),true);
    toast('Setelan disimpan.');
  }catch(e){inlineError('settings-error',e.message);}
  finally{state.mutations.delete('settings');renderSettings();updateControls();}
}
async function removeKey() {
  if(!registryReady())return;
  if(!await confirmAction('Hapus kunci API tersimpan?','Kunci lokal akan dihapus dan mode disimpan sebagai Simulasi. Kunci yang dipasok lingkungan server, jika ada, harus dihapus di server. Isian setelan lain yang belum disimpan tetap dipertahankan.','Hapus kunci',true))return;
  state.mutations.add('settings');updateControls();
  try {
    await api('/api/settings',{method:'POST',body:JSON.stringify({remove_api_key:true,llm_mode:'mock'})});
    await U.afterPending(refreshPromise, refreshAll);
    if(state.error||state.data.llm_setting!=='mock')throw new Error('Penghapusan belum dapat diverifikasi. Muat ulang setelan.');
    $('#set-key').value='';$('#set-mode').value='mock';
    if(state.data.has_key)toast('Kunci lokal dihapus; kunci dari lingkungan server masih tersedia.',true);else toast('Kunci dihapus. Mode tersimpan: Simulasi.');
  }catch(e){inlineError('settings-error',e.message);}
  finally{state.mutations.delete('settings');renderSettings();updateControls();}
}
async function clearHistory() {
  if(!registryReady())return;
  if(!await confirmAction('Hapus seluruh riwayat chat?','Semua pesan percakapan akan dihapus permanen. Agen, tugas, memori, dan catatan pemakaian TETAP disimpan. Draf pesan Anda tidak dihapus.','Hapus riwayat chat',true))return;
  state.mutations.add('history');updateControls();
  try {
    await api('/api/history/clear',{method:'POST'});
    historyEpoch++;state.messages=[];state.streams.clear();
    await U.afterPending(refreshPromise, refreshAll);
    const verify=await api('/api/messages');
    if(!Array.isArray(verify.messages)||verify.messages.length)throw new Error('Riwayat belum kosong atau ada pesan baru. Muat ulang untuk memeriksa.');
    state.messages=[];state.messagesLoaded=true;renderMessages(true);toast('Riwayat chat dihapus. Data kantor lainnya tetap disimpan.');
  }catch(e){toast(e.message,true);}
  finally{state.mutations.delete('history');updateControls();}
}
async function copyMessage(id) {
  const message=state.messages.find(m=>String(m.id)===String(id));if(!message)return;
  try {
    if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(String(message.content||''));
    else {
      const input=document.createElement('textarea');input.value=String(message.content||'');input.className='sr-only';input.setAttribute('aria-label','Teks untuk disalin');document.body.append(input);input.select();
      const ok=document.execCommand('copy');input.remove();if(!ok)throw new Error('Penyalinan tidak didukung.');
    }
    toast('Pesan disalin.');
  }catch(_){toast('Tidak dapat menyalin otomatis. Pilih teks pesan dan salin melalui perangkat Anda.',true);}
}

function bindEvents() {
  window.addEventListener('hashchange',()=>setPage(location.hash.slice(1),true));
  $('#sidebar-toggle').addEventListener('click',openNav);
  $('#sidebar-close').addEventListener('click',()=>closeNav());
  $('#nav-overlay').addEventListener('click',()=>closeNav());
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&$('#sidebar').classList.contains('open')){event.preventDefault();closeNav();}
    if(event.key==='Tab'&&$('#sidebar').classList.contains('open')){
      const items=$$('a,button:not(:disabled)',$('#sidebar')),first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  desktopNav.addEventListener('change',()=>closeNav(false));
  wideRoom.addEventListener('change',()=>setView(state.view));
  document.addEventListener('visibilitychange',()=>{syncOffice();if(!document.hidden&&state.connected)refreshAll();});
  $('#mode-banner').addEventListener('click',()=>navigate('settings'));
  $('#refresh-btn').addEventListener('click',()=>refreshAll());
  $('#retry-btn').addEventListener('click',()=>{if(!state.connected)connect();refreshAll();});
  $$('.workroom-tabs button').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
  function tabKeyboard(root,activate){root.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const buttons=$$('button[role="tab"]',root),index=buttons.indexOf(document.activeElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;activate(buttons[next]);buttons[next].focus();});}
  tabKeyboard($('.workroom-tabs'),button=>setView(button.dataset.view));
  tabKeyboard($('#memory-tabs'),button=>{state.memoryStatus=button.dataset.status;renderMemories();});
  $('#office-prev').addEventListener('click',()=>stepOffice(-1));$('#office-next').addEventListener('click',()=>stepOffice(1));
  $('#composer').addEventListener('submit',sendMessage);
  $('#msg-input').addEventListener('input',()=>{autoGrow();persistDraft();});
  $('#msg-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage();}});
  $('#messages').addEventListener('scroll',()=>{const box=$('#messages');chatPinned=box.scrollHeight-box.scrollTop-box.clientHeight<110;if(chatPinned)$('#new-messages').hidden=true;},{passive:true});
  $('#new-messages').addEventListener('click',()=>scrollChat(true));
  $('#agent-search').addEventListener('input',renderAgents);$('#agent-filter').addEventListener('change',renderAgents);
  $('#task-search').addEventListener('input',renderTasks);$('#task-agent').addEventListener('change',renderTasks);$('#task-status').addEventListener('change',renderTasks);
  $('#memory-search').addEventListener('input',renderMemories);
  $$('#memory-tabs button').forEach(button=>button.addEventListener('click',()=>{state.memoryStatus=button.dataset.status;renderMemories();}));
  $('#usage-mode').addEventListener('change',renderUsage);$('#usage-refresh').addEventListener('click',loadUsage);
  $('#btn-add-agent').addEventListener('click',()=>openAgent(null));
  $('#agent-form').addEventListener('submit',saveAgent);$('#f-delete').addEventListener('click',deleteAgent);
  $('#agent-form').addEventListener('input',()=>{state.agentDirty=true;});
  $('#agent-form').addEventListener('change',()=>{state.agentDirty=true;});
  $('#f-orch').addEventListener('change',()=>{renderTools(selectedTools());if($('#f-orch').checked){$('#f-active').checked=true;$('#f-active').disabled=true;}else $('#f-active').disabled=false;});
  $('#agent-dialog').addEventListener('cancel',event=>{event.preventDefault();closeAgent();});
  $('#settings-form').addEventListener('submit',saveSettings);
  $('#settings-form').addEventListener('input',()=>{state.settingsDirty=true;state.settingsVersion++;$('#settings-dirty').hidden=false;$('#settings-feedback').textContent='Perubahan belum disimpan.';});
  $('#settings-form').addEventListener('change',()=>{state.settingsDirty=true;state.settingsVersion++;$('#settings-dirty').hidden=false;});
  $('#set-key-remove').addEventListener('click',removeKey);$('#clear-history').addEventListener('click',clearHistory);
  $$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom)return;if(dialog.id==='agent-dialog')closeAgent();else dialog.close('cancel');}));
  $('#detail-dialog').addEventListener('close',()=>{detailSequence++;state.detail=null;});
  document.addEventListener('click',event=>{
    const close=event.target.closest('[data-close]');
    if(close){if(close.dataset.close==='agent-dialog')closeAgent();else document.getElementById(close.dataset.close)?.close();return;}
    const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
    const id=button.dataset.id,agent=getAgents()?.find(a=>String(a.id)===String(id));
    switch(button.dataset.action){
      case 'refresh':refreshAll();break;
      case 'usage-retry':loadUsage();break;
      case 'mention':insertMention(button.dataset.name);break;
      case 'agent-inspect':inspectAgent(agent);break;
      case 'agent-edit':openAgent(agent);break;
      case 'agent-talk':if(agent){$('#detail-dialog').close();navigate('workroom');setTimeout(()=>insertMention(agent.name),0);}break;
      case 'task-detail':inspectTask(id);break;
      case 'memory-approve':decideMemory(id,true);break;
      case 'memory-reject':decideMemory(id,false);break;
      case 'copy-message':copyMessage(id);break;
      default:break;
    }
  });
  window.addEventListener('beforeunload',event=>{if(state.settingsDirty||state.agentDirty){event.preventDefault();event.returnValue='';}});
}
function init() {
  bindEvents();
  $('#msg-input').value=storageGet('ks-message-draft');persistDraft();
  state.view=storageGet('ks-room-view')==='office'?'office':'chat';
  if(window.Office)Office.init({onAgentClick:name=>inspectAgent(getAgents()?.find(a=>a.name===name)),onBoardClick:()=>navigate('tasks')});
  setView(state.view);setPage(location.hash.slice(1)||'overview');
  refreshAll();connect();
}
init();
})();
