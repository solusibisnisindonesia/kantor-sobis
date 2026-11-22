'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '../static/ui.js');
const UI = fs.existsSync(target) ? require(target) : {};

test('escapeHtml encodes untrusted text including attribute delimiters', () => {
  assert.equal(typeof UI.escapeHtml, 'function', 'security helper must exist');
  assert.equal(UI.escapeHtml('<img src=x onerror="alert(1)"> & \'x\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;x&#39;');
  assert.equal(UI.escapeHtml(null), '');
});

test('markdown renders safe formatting while never interpreting raw HTML or code', () => {
  assert.equal(typeof UI.markdown, 'function', 'safe markdown renderer must exist');
  const html = UI.markdown('**Judul**\n\n```html\n<img src=x onerror="boom()">\n**literal**\n```\n\n<script>alert(1)</script>\n[jahat](javascript:alert(1))');
  assert.match(html, /<strong>Judul<\/strong>/);
  assert.match(html, /<pre><code>&lt;img/);
  assert.match(html, /\*\*literal\*\*/);
  assert.doesNotMatch(html, /<img|<script|href=|onerror="/);
  assert.match(UI.markdown('`<b>`\n- satu\n- dua'), /<code>&lt;b&gt;<\/code>/);
  assert.match(UI.markdown('```\n<svg onload=x>'), /&lt;svg/);
});

test('reconcileMessages preserves events received during a reconnect snapshot and deduplicates ids', () => {
  assert.equal(typeof UI.reconcileMessages, 'function');
  const snapshot = [{id:1,content:'lama'},{id:2,content:'tersimpan'}];
  const concurrent = [{id:2,content:'baru'},{id:3,content:'SSE terbaru'}];
  assert.deepEqual(UI.reconcileMessages(snapshot, concurrent), [{id:1,content:'lama'},{id:2,content:'baru'},{id:3,content:'SSE terbaru'}]);
  assert.equal(snapshot.length, 2);
});

test('settings payload has no auto mode, omits empty key, and requires explicit live confirmation', () => {
  assert.equal(typeof UI.settingsPayload, 'function');
  assert.deepEqual(UI.settingsPayload({user_name:' Pengguna Uji ',default_model:'model',llm_mode:'mock',api_key:''}), {user_name:'Pengguna Uji',default_model:'model',llm_mode:'mock'});
  assert.throws(() => UI.settingsPayload({llm_mode:'auto'}), /Mode/);
  assert.throws(() => UI.settingsPayload({llm_mode:'live'}), /konfirmasi/);
  assert.equal(UI.settingsPayload({llm_mode:'live',confirm_live:true}).confirm_live, true);
  assert.deepEqual(UI.settingsPayload({user_name:'Pengguna Uji',default_model:'model',llm_mode:'live',mode_locked:true}), {user_name:'Pengguna Uji',default_model:'model'});
});

test('agentPayload enforces specialist permissions, reserved names, and coordinator activation', () => {
  assert.equal(typeof UI.agentPayload, 'function');
  const base = {name:'Riset',role:'Peneliti',is_active:true,is_orchestrator:false,allowed_tools:['usulkan_memori'],media_models:['x']};
  assert.deepEqual(UI.agentPayload(base).allowed_tools, ['usulkan_memori']);
  assert.deepEqual(UI.agentPayload(base).media_models, ['x']);
  assert.throws(() => UI.agentPayload({...base,allowed_tools:['assign_tasks']}), /Izin/);
  for (const name of ['semua','ALL','system','sistem','dua kata','x']) assert.throws(() => UI.agentPayload({...base,name}), /Nama/);
  assert.throws(() => UI.agentPayload({...base,is_active:false,is_orchestrator:true}), /aktif/);
  assert.throws(() => UI.agentPayload(base,[{id:9,name:'RISET'}]), /sudah/);
  assert.equal(UI.agentPayload({...base,id:9},[{id:9,name:'Riset'}]).name,'Riset');
});

test('usage markup separates recorded, manual estimate, unknown, and simulation without invented zeros', () => {
  assert.equal(typeof UI.usageMetrics, 'function');
  assert.match(UI.usageMetrics(null, 'live'), /Belum tersedia/);
  const live = UI.usageMetrics({pesan:2,ptok:20,ctok:10,cost:0.01,recorded_cost:0,estimated_cost:0.01,unknown_count:1}, 'live');
  assert.match(live, /Tercatat/);
  assert.match(live, /Estimasi manual/);
  assert.match(live, /1 panggilan belum diketahui/);
  assert.match(live, /Subtotal diketahui/);
  assert.match(UI.usageMetrics({pesan:1,ptok:12,ctok:7,cost:0,unknown_count:0}, 'mock'), /Bukan tagihan/);
  assert.match(UI.usageMetrics({pesan:1,cost:2}, 'legacy'), /belum terverifikasi/);
  assert.doesNotMatch(UI.usageMetrics({pesan:'<script>x</script>'}, 'live'), /<script>/);
});

test('application shell has seven real pages, stable composer, accessible dialogs, and the office contract', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'),'utf8');
  const pages = [...html.matchAll(/<section id="page-([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(pages.sort(), ['overview','workroom','agents','tasks','memories','usage','settings'].sort());
  assert.match(html, /id="office-canvas" width="1200" height="780"/);
  assert.match(html, /<dialog id="agent-dialog"/);
  assert.match(html, /<dialog id="confirm-dialog"/);
  assert.equal((html.match(/id="msg-input"/g) || []).length, 1);
  assert.doesNotMatch(html, /https?:\/\/|value="auto"/);
});

test('mutation verification waits for an older snapshot before reading a new one', async () => {
  assert.equal(typeof UI.afterPending, 'function');
  const order=[];
  let resolve;
  const older = new Promise(done=>{resolve=()=>{order.push('older');done();};});
  const result=UI.afterPending(older,()=>{order.push('fresh');return 42;});
  assert.deepEqual(order,[]);
  resolve();
  assert.equal(await result,42);
  assert.deepEqual(order,['older','fresh']);
});

function controller(options = {}) {
  const vm = require('node:vm');
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,dataset:{},style:{},scrollTop:0,scrollHeight:100,clientHeight:100,classList:{add(){},remove(){},toggle(){}},querySelectorAll(){return [];},querySelector(s){return s==='.message-body'?node('stream-body'):null;},insertAdjacentHTML(_,html){this.innerHTML+=html;this.lastElementChild=this;},setAttribute(){},removeAttribute(){},close(){this.open=false;},append(){},remove(){}});
    return nodes.get(selector);
  };
  const source = fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8').replace(/\r\n/g, '\n');
  const hook = 'window.controllerTest = {state, messageHtml, renderAgents, renderMemories, renderOverview, applyEventData, refreshAll, handleEvent, saveAgent, updateControls};';
  assert.match(source, /\ninit\(\);\n\}\)\(\);\s*$/);
  const window = {SobisUI:UI,matchMedia(){return {matches:true};}};
  const context = {window,document:{body:node('body'),querySelector:node,querySelectorAll(){return [];},createElement:tag=>node('created-'+tag)},console,Map,Set,Date,Number,JSON,Intl,encodeURIComponent,AbortController,setTimeout(){return 1;},clearTimeout(){},requestAnimationFrame(callback){callback();},fetch:options.fetch};
  vm.runInNewContext(source.replace(/\ninit\(\);\n\}\)\(\);\s*$/, '\n'+hook+'\n})();'), context);
  return {...window.controllerTest,nodes,node};
}

test('message rendering escapes names, ids, Markdown, and code before producing markup', () => {
  const {messageHtml} = controller();
  const html = messageHtml({id:'1" onfocus="x',sender_type:'agent',sender_name:'<img onerror=x>',content:'```\n</code><script>x</script>\n```\n**aman**',model:'<svg/onload=x>',mode:'mock',ptok:0,ctok:0});
  assert.doesNotMatch(html, /<img|<script|<svg\/onload|onfocus="x/);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/SIMULASI/);
  assert.match(html,/bukan tagihan/);
});

test('memory terminal states cannot render approval controls and escaped values remain inert', () => {
  const c = controller();
  c.state.data={agents:[],memories:[{id:1,key:'<img src=x>',value:'<script>x</script>',status:'superseded'}],agent_statuses:{}};
  c.state.memoryStatus='superseded';
  c.renderMemories();
  const html=c.node('#memory-list').innerHTML;
  assert.match(html,/Digantikan/);
  assert.doesNotMatch(html,/memory-approve|memory-reject|<script>|<img/);
});

test('controller snapshots update room statuses without touching drafts or dirty forms', () => {
  const c=controller();
  c.state.data={agents:[{name:'Riset',status:'idle'}],agent_statuses:{},busy:false};
  c.state.settingsDirty=true;
  c.node('#msg-input').value='Draf saya';
  c.node('#set-name').value='Belum disimpan';
  c.applyEventData({type:'agent_status',agent:'Riset',status:'working',task_id:8});
  c.applyEventData({type:'room_status',status:'working',queue:2});
  assert.equal(c.state.data.agent_statuses.Riset.task_id,8);
  assert.equal(c.state.data.busy,true);
  assert.equal(c.node('#msg-input').value,'Draf saya');
  assert.equal(c.node('#set-name').value,'Belum disimpan');
});

test('reconnect snapshot preserves dirty settings, draft, concurrent messages and streamed text', async () => {
  const requests = new Map();
  const c=controller({fetch:url=>new Promise(resolve=>requests.set(url, data=>resolve({ok:true,json:async()=>data}))) });
  const data={agents:[{id:1,name:'Riset',is_active:true,status:'working',allowed_tools:[]}],tasks:[],memories:[],models:[],busy:true,queue:1,llm_setting:'mock',llm_mode:'mock',user_name:'Tersimpan',default_model:'model',agent_statuses:{Riset:{status:'working',task_id:1}}};
  c.state.data=data;c.state.connected=true;c.state.synced=true;c.state.settingsDirty=true;
  c.node('#msg-input').value='Draf tetap';c.node('#set-name').value='Belum disimpan';
  c.node('#agent-filter').value='all';c.node('#task-agent').value='all';c.node('#task-status').value='all';
  c.handleEvent({type:'delta',agent:'Riset',task_id:1,text:'Awal'});
  const refreshing=c.refreshAll();
  c.handleEvent({type:'delta',agent:'Riset',task_id:1,text:' lanjutan'});
  c.handleEvent({type:'message',message:{id:3,sender_type:'user',content:'Pesan bersamaan'}});
  requests.get('/api/state')({...data});
  requests.get('/api/messages')({messages:[{id:1,sender_type:'user',content:'Pesan lama'}]});
  await refreshing;
  assert.equal(c.state.error,'');
  assert.equal(c.node('stream-body').textContent,'Awal lanjutan');
  assert.deepEqual(Array.from(c.state.messages,m=>m.id),[1,3]);
  assert.equal(c.node('#msg-input').value,'Draf tetap');
  assert.equal(c.node('#set-name').value,'Belum disimpan');
});

function roomData(taskId = 1) {
  return {agents:[{id:1,name:'Riset',is_active:true,status:'working',allowed_tools:[]}],tasks:[],memories:[],models:[],busy:true,queue:0,llm_setting:'mock',llm_mode:'mock',agent_statuses:{Riset:{status:'working',task_id:taskId}}};
}

function snapshotController(data = roomData()) {
  const requests = new Map();
  const c = controller({fetch:url=>new Promise(resolve=>requests.set(url, value=>resolve({ok:true,json:async()=>value}))) });
  c.state.data=data;c.state.connected=true;c.state.synced=true;c.state.messagesLoaded=true;
  c.node('#agent-filter').value='all';c.node('#task-agent').value='all';c.node('#task-status').value='all';
  return {...c,requests,completeSnapshot(value) {requests.get('/api/state')(value);requests.get('/api/messages')({messages:[]});}};
}

test('reconnect removes fragments from a previous task before the next task streams', async () => {
  const c=snapshotController();
  c.handleEvent({type:'delta',agent:'Riset',task_id:1,text:'Fragmen tugas lama'});
  c.state.connected=false;c.state.synced=false;
  c.state.connected=true;
  const refreshing=c.refreshAll();
  c.completeSnapshot(roomData(2));
  await refreshing;
  assert.equal(c.state.error,'');
  assert.equal(c.state.streams.size,0,'working for another task must not retain the old stream');
  c.handleEvent({type:'delta',agent:'Riset',task_id:2,text:'Tugas baru'});
  assert.equal(c.node('stream-body').textContent,'Tugas baru');
});

test('reconnect prunes renamed, deleted, inactive, and unidentifiable streams', async t => {
  const cases=[
    ['renamed',data=>{data.agents[0].name='RisetBaru';}],
    ['deleted',data=>{data.agents=[];}],
    ['inactive',data=>{data.agents[0].is_active=false;}],
    ['unidentified task',data=>{data.agent_statuses.Riset.task_id=null;}]
  ];
  for(const [name,change] of cases) await t.test(name,async()=>{
    const data=roomData();change(data);
    const c=snapshotController(name==='unidentified task'?data:roomData());
    c.handleEvent({type:'delta',agent:'Riset',task_id:name==='unidentified task'?null:1,text:'Aliran lama'});
    const refreshing=c.refreshAll();c.completeSnapshot(data);await refreshing;
    assert.equal(c.state.streams.size,0,'only active, same-task roster entries may keep a stream');
    assert.doesNotMatch(c.node('#messages').innerHTML,/data-live-agent="Riset"/);
  });
});

test('a new working task immediately clears the previous task bubble', () => {
  const c=snapshotController();
  c.handleEvent({type:'delta',agent:'Riset',task_id:1,text:'Pekerjaan lama'});
  c.handleEvent({type:'agent_status',agent:'Riset',status:'working',task_id:2});
  assert.equal(c.state.streams.size,0);
  c.handleEvent({type:'delta',agent:'Riset',task_id:2,text:'Pekerjaan baru'});
  assert.equal(c.node('stream-body').textContent,'Pekerjaan baru');
});

test('live deltas cannot revive a removed agent or a different task outside a snapshot', () => {
  const c=snapshotController();
  c.handleEvent({type:'delta',agent:'Riset',task_id:9,text:'Tugas lain'});
  c.handleEvent({type:'delta',agent:'Dihapus',task_id:1,text:'Agen tidak terdaftar'});
  assert.equal(c.state.streams.size,0);
});

test('a newer task delta during reconnect replaces old text and survives its matching snapshot', async () => {
  const c=snapshotController();
  c.handleEvent({type:'delta',agent:'Riset',task_id:1,text:'Jangan digabung'});
  const refreshing=c.refreshAll();
  // The connection missed task 2's status event; its delta arrives before the HTTP snapshot.
  c.handleEvent({type:'delta',agent:'Riset',task_id:2,text:'Awal baru'});
  c.completeSnapshot(roomData(2));await refreshing;
  assert.equal(c.node('stream-body').textContent,'Awal baru');
  c.handleEvent({type:'delta',agent:'Riset',task_id:2,text:' lanjutan'});
  assert.equal(c.node('stream-body').textContent,'Awal baru lanjutan');
});

test('buffered newer statuses win over an older snapshot without replaying delta text twice', async () => {
  const c=snapshotController();
  c.handleEvent({type:'delta',agent:'Riset',task_id:1,text:'Lama'});
  const refreshing=c.refreshAll();
  c.handleEvent({type:'agent_status',agent:'Riset',status:'working',task_id:2});
  c.handleEvent({type:'delta',agent:'Riset',task_id:2,text:'Baru'});
  c.handleEvent({type:'delta',agent:'Riset',task_id:2,text:' utuh'});
  c.completeSnapshot(roomData(1));await refreshing;
  assert.equal(c.state.data.agent_statuses.Riset.task_id,2);
  assert.equal(c.node('stream-body').textContent,'Baru utuh');
  assert.equal(c.state.streams.size,1);
});

function agentSaveController(coordinator = false) {
  const agent={id:1,name:'Riset',role:'Peneliti',model:'model',system_prompt:'Instruksi',is_active:true,is_orchestrator:coordinator,allowed_tools:[],media_models:[]};
  const data={...roomData(),agents:[agent],busy:false,agent_statuses:{Riset:{status:'idle',task_id:null}}};
  const c=snapshotController(data);
  c.state.editingId=1;c.state.agentDirty=true;c.node('#agent-dialog').open=true;
  for(const [id,key] of [['f-name','name'],['f-role','role'],['f-model','model'],['f-prompt','system_prompt']])c.node('#'+id).value=agent[key];
  c.node('#f-active').checked=true;c.node('#f-orch').checked=coordinator;
  c.node('#f-active').disabled=coordinator;c.node('#f-orch').disabled=coordinator;
  const tools=UI.TOOLS.map(value=>({value,checked:false,disabled:!coordinator&&value!=='usulkan_memori'}));
  const fields=['f-name','f-role','f-model','f-prompt','f-media','f-active','f-orch'].map(id=>c.node('#'+id)).concat(tools);
  c.node('#agent-form').querySelectorAll=selector=>selector==='input,textarea,select'?fields:[];
  c.node('#f-tools').querySelectorAll=selector=>selector.endsWith(':checked')?tools.filter(input=>input.checked):tools;
  return {...c,agent,fields};
}

test('agent fields stay locked through deferred PUT and verification snapshot then restore permissions', async () => {
  const c=agentSaveController();
  const originalDisabled=c.fields.map(input=>input.disabled);
  const saving=c.saveAgent({preventDefault(){}});
  assert.equal(c.requests.has('/api/agents/1'),true,'the real controller must issue PUT');
  assert.equal(c.fields.every(input=>input.disabled),true,'form must lock while PUT is pending');
  assert.equal(c.node('#agent-dialog').open,true);
  c.requests.get('/api/agents/1')({agent:c.agent});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.requests.has('/api/state'),true,'PUT completion must trigger server-side verification');
  c.updateControls();
  assert.equal(c.fields.every(input=>input.disabled),true,'snapshot rendering must not unlock a pending save');
  assert.equal(c.node('#agent-dialog').open,true);
  assert.equal(c.state.agentDirty,true);
  c.completeSnapshot({...c.state.data,agents:[{...c.agent}]});
  await saving;
  assert.equal(c.node('#agent-error').textContent,'');
  assert.equal(c.node('#agent-dialog').open,false);
  assert.equal(c.state.agentDirty,false);
  assert.deepEqual(c.fields.map(input=>input.disabled),originalDisabled,'specialist-only permission locks must remain');
});

test('unverified agent save retains its draft and restores coordinator locks for retry', async () => {
  const c=agentSaveController(true);
  const originalDisabled=c.fields.map(input=>input.disabled);
  const saving=c.saveAgent({preventDefault(){}});
  assert.equal(c.fields.every(input=>input.disabled),true);
  c.requests.get('/api/agents/1')({agent:c.agent});
  await new Promise(resolve=>setImmediate(resolve));
  c.completeSnapshot({...c.state.data,agents:[{...c.agent,role:'Snapshot belum sesuai'}]});
  await saving;
  assert.match(c.node('#agent-error').textContent,/belum dapat diverifikasi/);
  assert.equal(c.node('#agent-dialog').open,true);
  assert.equal(c.state.agentDirty,true);
  assert.equal(c.node('#f-role').value,'Peneliti');
  assert.deepEqual(c.fields.map(input=>input.disabled),originalDisabled);
  assert.equal(c.node('#f-orch').disabled,true);
  assert.equal(c.node('#f-active').disabled,true);
});

test('initial API failure shows unavailable states rather than leaving loading panels or inventing metrics', async () => {
  const c=controller({fetch:async()=>{throw new TypeError('offline');}});
  c.node('#summary-metrics').innerHTML='—';
  await c.refreshAll();
  assert.equal(c.state.data,null);
  assert.equal(c.node('#summary-metrics').innerHTML,'—');
  assert.match(c.node('#usage-summary').innerHTML,/belum tersedia/i);
  assert.match(c.node('#office-agent-list').textContent,/belum tersedia/i);
  assert.equal(c.node('#send-btn').disabled,true);
});
