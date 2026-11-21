/* Small dependency-free helpers shared by the browser and Node tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SobisUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  }
  // Escape first. No links, images, raw tags or injected attributes are supported.
  function markdown(value) {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
    let html = '', code = null, list = false;
    const inline = text => escapeHtml(text).split(/(`[^`\n]*`)/g).map(part => part.startsWith('`') && part.endsWith('`')
      ? '<code>' + part.slice(1, -1) + '</code>'
      : part.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')).join('');
    const closeList = () => { if (list) { html += '</ul>'; list = false; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        closeList();
        if (code === null) code = [];
        else { html += '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>'; code = null; }
      } else if (code !== null) code.push(line);
      else if (/^\s*[-*]\s+/.test(line)) {
        if (!list) { html += '<ul>'; list = true; }
        html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
      } else {
        closeList();
        if (line.trim()) html += /^#{1,4}\s+/.test(line) ? '<p><strong>' + inline(line.replace(/^#{1,4}\s+/, '')) + '</strong></p>' : '<p>' + inline(line) + '</p>';
      }
    }
    closeList();
    if (code !== null) html += '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>';
    return html;
  }
  function reconcileMessages(snapshot, concurrent) {
    const items = new Map();
    for (const m of [...(snapshot || []), ...(concurrent || [])]) if (m && m.id != null) items.set(String(m.id), m);
    return [...items.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }
  function settingsPayload(values) {
    if (!['mock', 'live'].includes(values.llm_mode)) throw new Error('Mode harus Simulasi atau Live.');
    if (!values.mode_locked && values.llm_mode === 'live' && values.confirm_live !== true) throw new Error('Live membutuhkan konfirmasi biaya.');
    const result = {user_name: String(values.user_name || '').trim(), default_model: String(values.default_model || '').trim()};
    if (!values.mode_locked) result.llm_mode = values.llm_mode;
    if (values.api_key && values.api_key.trim()) result.api_key = values.api_key.trim();
    if (!values.mode_locked && values.confirm_live === true) result.confirm_live = true;
    return result;
  }
  const TOOLS = ['assign_tasks', 'create_agent', 'list_agents', 'usulkan_memori'];
  function agentPayload(values, agents = []) {
    const name = String(values.name || '').trim();
    if (!/^[A-Za-z0-9_]{2,20}$/.test(name) || ['semua','all','system','sistem'].includes(name.toLowerCase())) throw new Error('Nama: 2–20 huruf, angka, atau garis bawah; bukan nama khusus.');
    if (agents.some(a => String(a.id) !== String(values.id) && a.name.toLowerCase() === name.toLowerCase())) throw new Error('Nama sudah digunakan agen lain.');
    if (values.is_orchestrator && !values.is_active) throw new Error('Koordinator harus tetap aktif.');
    const allowed = values.is_orchestrator ? TOOLS : ['usulkan_memori'];
    const tools = [...new Set(values.allowed_tools || [])];
    if (tools.some(t => !allowed.includes(t))) throw new Error('Izin tool tidak diperbolehkan untuk peran ini.');
    return {name, role:String(values.role || '').trim(), model:String(values.model || '').trim(), system_prompt:String(values.system_prompt || ''), is_active:!!values.is_active, is_orchestrator:!!values.is_orchestrator, allowed_tools:tools, media_models:[...new Set((values.media_models || []).map(String).map(s => s.trim()).filter(Boolean))]};
  }
  function number(value) { return value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value).toLocaleString('id-ID') : '—'; }
  function money(value) { return value != null && value !== '' && Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(5) : '—'; }
  function usageMetrics(row, mode) {
    if (!row) return '<p class="muted">Belum tersedia.</p>';
    const metric = (label, value) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';
    let html = '<dl class="usage-metrics">' + metric('Panggilan', number(row.pesan)) + metric('Token masuk', number(row.ptok)) + metric('Token keluar', number(row.ctok));
    if (mode === 'mock') html += '</dl><p class="muted small">Bukan tagihan. Token simulasi hanya perkiraan pengujian.</p>';
    else html += metric('Tercatat', money(row.recorded_cost)) + metric('Estimasi manual', money(row.estimated_cost)) + metric('Subtotal diketahui', money(row.cost)) + '</dl><p class="muted small">' + (mode === 'legacy' ? 'Data lama; asal biaya belum terverifikasi. ' : 'Harga manual belum diverifikasi. ') + (Number(row.unknown_count) > 0 ? number(row.unknown_count) + ' panggilan belum diketahui; total belum lengkap.' : row.unknown_count == null ? 'Kelengkapan biaya belum diketahui.' : 'Subtotal hanya mencakup biaya yang diketahui.') + '</p>';
    return html;
  }
  async function afterPending(pending, action) { if (pending) await pending; return action(); }
  return { escapeHtml, markdown, reconcileMessages, settingsPayload, agentPayload, TOOLS, number, money, usageMetrics, afterPending };
});
