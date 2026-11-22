/* Single-business workflow. User input is rendered only through textContent/value. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const profileForm = $('profile-form'), briefForm = $('brief-form');
const channels = {whatsapp:'Pesan WhatsApp',instagram:'Caption Instagram',toko:'Deskripsi produk'};
let overview = null, draft = null, busy = false, profileDirty = false, briefDirty = false;

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
async function api(path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === '/drafts' ? 135000 : 15000);
  try {
  const response = await fetch('/api/business' + path, {method, cache:'no-store', signal:controller.signal,
    headers:{Accept:'application/json', ...(body ? {'Content-Type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Periksa isian: kolom wajib tidak boleh kosong atau melebihi batas karakter.');
  return data;
  } finally { clearTimeout(timeout); }
}
function latest() { return draft?.versions[0]; }
function changed() { return !!draft && $('draft-content').value.trim() !== latest().content; }
function controls() {
  profileForm.querySelector('fieldset').disabled = busy || !overview;
  briefForm.querySelector('fieldset').disabled = busy || !overview?.profile || profileDirty;
  $('profile-needed').hidden = !!overview?.profile && !profileDirty;
  $('profile-needed').textContent = profileDirty ? 'Simpan perubahan profil usaha sebelum membuat promosi.' : 'Simpan profil usaha di atas untuk mulai membuat promosi.';
  $('refresh').disabled = busy;
  const approved = draft && draft.approved_version === latest().version && !changed();
  $('draft-content').disabled = busy;
  $('save-revision').disabled = busy || !changed() || !$('draft-content').value.trim();
  $('approve').disabled = busy || !draft || changed() || approved;
  $('approve').textContent = approved ? '✓ Sudah disetujui' : 'Setujui naskah';
  $('copy').disabled = busy || !approved;
  $('download').setAttribute('aria-disabled', String(busy || !approved));
  if (approved && !busy) $('download').href = '/api/business/drafts/' + draft.id + '/download';
  else $('download').removeAttribute('href');
  document.querySelectorAll('.history-row').forEach(button => { button.disabled = busy; });
  if (draft) $('draft-hint').textContent = changed() ? 'Perubahan belum disimpan. Simpan revisi, lalu setujui naskah.' : approved ? 'Naskah sudah disetujui. Anda bisa menyalin atau mengunduhnya.' : 'Periksa harga, klaim, kontak, dan periode penawaran sebelum menyetujui.';
}
async function action(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); }
  catch (error) { notice(error instanceof TypeError || error.name === 'AbortError' ? 'Aplikasi belum merespons. Masukan Anda tetap di halaman ini. Perbarui riwayat untuk memeriksa hasil sebelum mengulang.' : error.message, true); }
  finally { busy = false; controls(); }
}
function renderHistory() {
  const container = $('history'); container.replaceChildren();
  if (!overview.drafts.length) {
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Belum ada promosi. Coba buat yang pertama.'; container.append(p);
  }
  for (const item of overview.drafts) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'history-row';
    button.setAttribute('aria-current', String(item.id === draft?.id));
    const title = document.createElement('strong'); title.textContent = item.brief.goal;
    const meta = document.createElement('span'); meta.textContent = channels[item.brief.channel] + ' · v' + item.latest_version + ' · ' + (item.approved_version === item.latest_version ? 'Disetujui' : 'Perlu ditinjau') + ' · ' + item.created_at;
    button.append(title, meta);
    button.addEventListener('click', () => {
      if (changed() && !window.confirm('Revisi belum disimpan. Buka promosi lain dan tinggalkan perubahan ini?')) return;
      action(async () => { showDraft(await api('/drafts/' + item.id)); renderHistory(); notice('Promosi tersimpan dibuka.'); $('result').scrollIntoView({block:'start'}); });
    });
    container.append(button);
  }
}
function renderMode() {
  const live = overview.mode === 'live';
  $('mode').textContent = live ? 'AI aktif · API berbayar' : 'Mode contoh · Tanpa biaya AI';
  $('mode').classList.toggle('live', live);
  $('sample-help').hidden = live; $('live-consent').hidden = !live;
  briefForm.elements.confirm_live.required = live;
  $('generate').textContent = live ? 'Buat draf dengan AI →' : 'Buat contoh promosi →';
}
async function refresh(fillProfile = false) {
  overview = await api('');
  if (fillProfile && overview.profile) {
    for (const [key,value] of Object.entries(overview.profile)) profileForm.elements[key].value = value;
    profileDirty = false; $('profile-status').textContent = 'Profil usaha tersimpan.';
  }
  renderMode(); renderHistory();
}
function showDraft(data) {
  draft = data;
  $('result-empty').hidden = true; $('draft-panel').hidden = false;
  const sample = draft.versions[draft.versions.length - 1].mode === 'mock';
  $('draft-source').textContent = sample ? 'Contoh simulasi · Pola teks' : 'Draf dari AI';
  $('draft-state').textContent = 'Versi ' + latest().version + (draft.approved_version === latest().version ? ' · Disetujui' : ' · Perlu ditinjau');
  $('draft-context').textContent = draft.profile.name + ' / ' + channels[draft.brief.channel];
  $('draft-content').value = latest().content;
  $('brief-summary').textContent = 'Tujuan: ' + draft.brief.goal + '. Fakta: ' + (draft.brief.facts || 'Tidak ada tambahan.') + ' Profil usaha disimpan bersama promosi ini.';
  const list = $('version-list'); list.replaceChildren();
  for (const version of draft.versions) {
    const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
    summary.textContent = 'Versi ' + version.version + ' · ' + (version.mode === 'manual' ? 'Diedit sendiri' : version.mode === 'mock' ? 'Contoh simulasi' : 'AI') + ' · ' + version.created_at;
    pre.textContent = version.content; details.append(summary, pre); list.append(details);
  }
  controls();
}
profileForm.addEventListener('input', () => { profileDirty = true; $('profile-status').textContent = 'Perubahan profil belum disimpan.'; controls(); });
profileForm.addEventListener('submit', event => { event.preventDefault();
  const body = Object.fromEntries(new FormData(profileForm));
  action(async () => {
  const result = await api('/profile', 'PUT', body);
  overview.profile = result.profile; profileDirty = false;
  $('profile-status').textContent = 'Profil usaha tersimpan.'; notice('Profil tersimpan. Sekarang ceritakan promosi yang ingin Anda buat.');
}); });
briefForm.addEventListener('submit', event => { event.preventDefault();
  if (changed() && !window.confirm('Revisi belum disimpan. Buat promosi baru dan tinggalkan perubahan ini?')) return;
  // FormData must be read before action() disables the fieldset.
  const body = Object.fromEntries(new FormData(briefForm)); body.confirm_live = briefForm.elements.confirm_live.checked;
  action(async () => {
    notice('Menyiapkan promosi… Tunggu hasilnya sebelum mengirim lagi.');
    showDraft(await api('/drafts', 'POST', body));
    briefDirty = false;
    briefForm.elements.confirm_live.checked = false;
    await refresh(); notice('Draf siap ditinjau. Anda bisa mengedit naskah sebelum menyetujuinya.');
    $('result').scrollIntoView({block:'start'});
  });
});
briefForm.addEventListener('input', () => { briefDirty = true; });
$('draft-content').addEventListener('input', controls);
$('save-revision').addEventListener('click', () => action(async () => {
  showDraft(await api('/drafts/' + draft.id + '/versions', 'POST', {expected_version:latest().version, content:$('draft-content').value}));
  await refresh(); notice('Revisi tersimpan sebagai versi baru. Versi sebelumnya tetap tersedia.');
}));
$('approve').addEventListener('click', () => action(async () => {
  showDraft(await api('/drafts/' + draft.id + '/approve', 'POST', {expected_version:latest().version}));
  await refresh(); notice('Naskah disetujui. Salin atau unduh untuk digunakan.');
}));
$('copy').addEventListener('click', () => action(async () => {
  try { await navigator.clipboard.writeText(latest().content); notice('Teks promosi sudah disalin.'); }
  catch (_) { $('draft-content').focus(); $('draft-content').select(); notice('Salin otomatis tidak tersedia. Tekan Ctrl+C atau pilih Salin pada perangkat Anda.'); }
}));
$('refresh').addEventListener('click', () => action(async () => { await refresh(); notice('Riwayat dan mode diperbarui.'); }));
window.addEventListener('beforeunload', event => { if (profileDirty || briefDirty || changed() || busy) { event.preventDefault(); event.returnValue = ''; } });
action(async () => {
  await refresh(true);
  if (overview.drafts.length) {
    showDraft(await api('/drafts/' + overview.drafts[0].id)); renderHistory();
    notice('Selamat datang kembali. Promosi terakhir siap dilanjutkan.');
  } else notice('Siap digunakan. Mulai dari profil usaha Anda.');
});
})();
