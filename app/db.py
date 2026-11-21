"""Database Kantor Sobis — SQLite sederhana (satu file di folder data/)."""
import re
import json
import math
import sqlite3
import threading
from datetime import datetime

from . import config

_conn = None
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    model TEXT DEFAULT '',
    media_models TEXT DEFAULT '[]',
    allowed_tools TEXT DEFAULT '[]',
    is_orchestrator INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_type TEXT DEFAULT 'user',
    sender_name TEXT DEFAULT '',
    content TEXT DEFAULT '',
    model TEXT DEFAULT '',
    ptok INTEGER DEFAULT 0,
    ctok INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT DEFAULT '',
    value TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    source TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT DEFAULT '',
    agent TEXT DEFAULT '',
    status TEXT DEFAULT 'queue',
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT DEFAULT ''
);
"""

NAME_RE = re.compile(r"^[A-Za-z0-9_]{2,20}$")


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_conn():
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
        return _conn


def init():
    with _lock:
        conn = get_conn()
        conn.executescript(SCHEMA)
        _migrate(conn)
        if not get_setting("_seeded") or not list_agents():
            _seed()
            set_setting("_seeded", "1")


def _migrate(conn):
    """Additive, transactional, versioned; never read secret settings."""
    version = int(get_setting('schema_version', '0'))
    if version >= 3:
        return
    with conn:
        conn.execute('BEGIN IMMEDIATE')
        if version < 1:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(tasks)')}
            for column, definition in {'result': "TEXT DEFAULT ''", 'error': "TEXT DEFAULT ''", 'message_id': 'INTEGER'}.items():
                if column not in columns:
                    conn.execute(f'ALTER TABLE tasks ADD COLUMN {column} {definition}')
        if version < 2:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(messages)')}
            for column, default in [('mode', 'legacy'), ('cost_source', 'legacy')]:
                if column not in columns:
                    conn.execute(f"ALTER TABLE messages ADD COLUMN {column} TEXT DEFAULT '{default}'")
            conn.execute("UPDATE messages SET mode='user' WHERE sender_type='user'")
            conn.execute('''CREATE TABLE IF NOT EXISTS usage_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT, sender_name TEXT NOT NULL, model TEXT,
                mode TEXT NOT NULL, ptok INTEGER DEFAULT 0, ctok INTEGER DEFAULT 0,
                cost REAL DEFAULT 0, cost_source TEXT NOT NULL, created_at TEXT)''')
            conn.execute("""INSERT INTO usage_records(sender_name,model,mode,ptok,ctok,cost,cost_source,created_at)
                SELECT sender_name,model,'legacy',ptok,ctok,cost,'legacy',created_at FROM messages WHERE sender_type='agent'""")
        if version < 3:
            agents = list_agents()
            chosen = next((a for a in agents if a['is_orchestrator'] and a['is_active']), None)
            chosen = chosen or next((a for a in agents if a['is_active']), None) or (agents[0] if agents else None)
            for agent in agents:
                coordinator = chosen is not None and agent['id'] == chosen['id']
                permissions = COORDINATOR_PERMISSIONS if coordinator else WORKER_PERMISSIONS
                tools = [t for t in agent['allowed_tools'] if t in permissions] if agent['allowed_tools'] else permissions
                conn.execute('UPDATE agents SET is_orchestrator=?,is_active=?,allowed_tools=? WHERE id=?',
                             (int(coordinator), int(coordinator or agent['is_active']), json.dumps(tools), agent['id']))
            conn.execute("UPDATE settings SET v='mock' WHERE k='llm_mode' AND v NOT IN ('mock','live')")
            seen = set()
            for memory in list_memories('approved'):
                key = memory['key'].strip().casefold()
                if key in seen:
                    conn.execute("UPDATE memories SET status='superseded',updated_at=? WHERE id=?", (now(), memory['id']))
                seen.add(key)
        conn.execute("INSERT INTO settings(k,v) VALUES('schema_version','3') ON CONFLICT(k) DO UPDATE SET v='3'")


def _all(sql, args=()):
    with _lock:
        return [dict(r) for r in get_conn().execute(sql, args).fetchall()]


def _one(sql, args=()):
    with _lock:
        r = get_conn().execute(sql, args).fetchone()
        return dict(r) if r else None


def _run(sql, args=()):
    with _lock:
        conn = get_conn()
        cur = conn.execute(sql, args)
        conn.commit()
        return cur.lastrowid


# ─────────────────────────── Agen ───────────────────────────

def _fix_agent(d):
    if not d:
        return d
    d["is_orchestrator"] = bool(d.get("is_orchestrator"))
    d["is_active"] = bool(d.get("is_active"))
    for field in ('allowed_tools', 'media_models'):
        try:
            value = json.loads(d.get(field) or '[]')
            d[field] = value if isinstance(value, list) else []
        except (TypeError, ValueError):
            d[field] = []
    return d


def list_agents(active_only=False):
    q = "SELECT * FROM agents"
    if active_only:
        q += " WHERE is_active=1"
    q += " ORDER BY is_orchestrator DESC, id ASC"
    return [_fix_agent(r) for r in _all(q)]


def get_agent(agent_id):
    return _fix_agent(_one("SELECT * FROM agents WHERE id=?", (agent_id,)))


def get_agent_by_name(name):
    if not name:
        return None
    return _fix_agent(_one("SELECT * FROM agents WHERE lower(name)=lower(?)", (str(name).strip().lstrip("@"),)))


WORKER_PERMISSIONS = ['usulkan_memori']
COORDINATOR_PERMISSIONS = ['assign_tasks', 'create_agent', 'list_agents', 'usulkan_memori']
RESERVED_NAMES = {'semua', 'all', 'system', 'sistem'}


def _validate_agent(data, agent_id=None):
    name = data['name']
    if not isinstance(name, str) or not NAME_RE.fullmatch(name) or name.lower() in RESERVED_NAMES:
        raise ValueError('Nama agen harus unik, 2-20 huruf/angka/_, bukan nama khusus')
    other = get_agent_by_name(name)
    if other and other['id'] != agent_id:
        raise ValueError('Nama agen sudah dipakai')
    if data['is_orchestrator'] and not data['is_active']:
        raise ValueError('Koordinator harus aktif')
    allowed = COORDINATOR_PERMISSIONS if data['is_orchestrator'] else WORKER_PERMISSIONS
    if not isinstance(data['allowed_tools'], list) or any(t not in allowed for t in data['allowed_tools']):
        raise ValueError('Izin tool tidak sesuai peran')
    if not isinstance(data['media_models'], list) or any(not isinstance(m, str) for m in data['media_models']):
        raise ValueError('Metadata model media harus daftar teks')


def _demote_coordinators(conn, except_id=0):
    for row in list_agents():
        if row['is_orchestrator'] and row['id'] != except_id:
            tools = [t for t in row['allowed_tools'] if t in WORKER_PERMISSIONS]
            conn.execute('UPDATE agents SET is_orchestrator=0, allowed_tools=? WHERE id=?',
                         (json.dumps(tools), row['id']))


def create_agent(name, role='', system_prompt='', model='', is_orchestrator=False, is_active=True,
                 allowed_tools=None, media_models=None):
    data = dict(name=name, role=role, system_prompt=system_prompt, model=model,
                is_orchestrator=is_orchestrator, is_active=is_active,
                allowed_tools=list(COORDINATOR_PERMISSIONS if is_orchestrator else WORKER_PERMISSIONS)
                if allowed_tools is None else allowed_tools,
                media_models=[] if media_models is None else media_models)
    with _lock:
        _validate_agent(data)
        if not any(a['is_active'] and a['is_orchestrator'] for a in list_agents()) and not is_orchestrator:
            raise ValueError('Kantor memerlukan satu koordinator aktif')
        conn = get_conn()
        with conn:
            if is_orchestrator:
                _demote_coordinators(conn)
            aid = conn.execute('INSERT INTO agents(name,role,system_prompt,model,is_orchestrator,is_active,allowed_tools,media_models,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                               (name, role, system_prompt, model, int(is_orchestrator), int(is_active),
                                json.dumps(data['allowed_tools']), json.dumps(data['media_models']), now())).lastrowid
        return get_agent(aid)


def update_agent(agent_id, **fields):
    with _lock:
        cur = get_agent(agent_id)
        if not cur:
            return None
        keys = ('name', 'role', 'system_prompt', 'model', 'is_active', 'is_orchestrator', 'allowed_tools', 'media_models')
        data = {**cur, **{k: v for k, v in fields.items() if k in keys}}
        if fields.get('is_orchestrator') and not cur['is_orchestrator'] and 'allowed_tools' not in fields:
            data['allowed_tools'] = list(COORDINATOR_PERMISSIONS)
        _validate_agent(data, agent_id)
        if cur['is_orchestrator'] and (not data['is_orchestrator'] or not data['is_active']):
            raise ValueError('Pindahkan koordinator ke agen aktif lain terlebih dahulu')
        conn = get_conn()
        with conn:
            if data['is_orchestrator']:
                _demote_coordinators(conn, agent_id)
            values = [json.dumps(data[k]) if k in ('allowed_tools', 'media_models') else data[k] for k in keys]
            conn.execute('UPDATE agents SET ' + ','.join(k + '=?' for k in keys) + ' WHERE id=?', values + [agent_id])
        return get_agent(agent_id)


def delete_agent(agent_id):
    with _lock:
        agent = get_agent(agent_id)
        if agent and agent['is_orchestrator']:
            raise ValueError('Pindahkan koordinator terlebih dahulu')
        _run('DELETE FROM agents WHERE id=?', (agent_id,))


# ─────────────────────────── Pesan ───────────────────────────

def usage_values(model, usage=None, mode='legacy'):
    usage = usage or {}
    def number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
    ptok = int(usage['prompt_tokens']) if number(usage.get('prompt_tokens')) else 0
    ctok = int(usage['completion_tokens']) if number(usage.get('completion_tokens')) else 0
    if mode == 'mock':
        cost, source = 0.0, 'simulation'
    elif mode == 'legacy':
        cost, source = (float(usage['cost']) if number(usage.get('cost')) else 0.0), 'legacy'
    elif number(usage.get('cost')):
        cost, source = float(usage['cost']), 'recorded'
    elif config.price_of(model) and ('prompt_tokens' in usage or 'completion_tokens' in usage):
        pin, pout = config.price_of(model)
        cost, source = (ptok * pin + ctok * pout) / 1_000_000, 'estimated'
    else:
        cost, source = 0.0, 'unknown'
    return {'ptok': ptok, 'ctok': ctok, 'cost': round(cost, 10), 'cost_source': source}


def record_usage(sender_name, model, usage=None, mode='legacy'):
    values = usage_values(model, usage, mode)
    _run('INSERT INTO usage_records(sender_name,model,mode,ptok,ctok,cost,cost_source,created_at) VALUES(?,?,?,?,?,?,?,?)',
         (sender_name, model, mode, values['ptok'], values['ctok'], values['cost'], values['cost_source'], now()))
    return values


def add_message(sender_type, sender_name, content, model='', usage=None, mode=None, record=True):
    mode = mode or ('user' if sender_type == 'user' else 'legacy')
    values = usage_values(model, usage, mode)
    if sender_type == 'agent' and record:
        record_usage(sender_name, model, usage, mode)
    mid = _run('INSERT INTO messages(sender_type,sender_name,content,model,ptok,ctok,cost,created_at,mode,cost_source) VALUES(?,?,?,?,?,?,?,?,?,?)',
               (sender_type, sender_name, content, model, values['ptok'], values['ctok'], values['cost'], now(), mode, values['cost_source']))
    return get_message(mid)


def get_message(mid):
    return _one("SELECT * FROM messages WHERE id=?", (mid,))


def get_messages(limit=300):
    rows = _all("SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,))
    return list(reversed(rows))


def recent_messages(limit=30, message_id=None):
    if message_id is None:
        return get_messages(limit)
    # Jobs run serially: completed outputs are safe, but later user instructions are not.
    return list(reversed(_all("SELECT * FROM messages WHERE (id<=? OR sender_type!='user') ORDER BY id DESC LIMIT ?", (message_id, limit))))


def clear_messages():
    _run("DELETE FROM messages")


# ─────────────────────────── Memori ───────────────────────────

def add_memory(key, value, source=""):
    mid = _run(
        "INSERT INTO memories (key, value, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (key, value, "pending", source, now(), now()),
    )
    return _one("SELECT * FROM memories WHERE id=?", (mid,))


def list_memories(status=None):
    if status:
        return _all("SELECT * FROM memories WHERE status=? ORDER BY id DESC", (status,))
    return _all("SELECT * FROM memories ORDER BY id DESC")


def set_memory_status(mid, status):
    if status not in ('approved', 'rejected'):
        raise ValueError('Hanya setujui/tolak usulan pending yang diizinkan')
    with _lock:
        conn = get_conn()
        with conn:
            memory = _one('SELECT * FROM memories WHERE id=?', (mid,))
            if not memory:
                return None
            if memory['status'] != 'pending':
                raise ValueError('Memori sudah ditinjau')
            if status == 'approved':
                for old in approved_memories():
                    if old['key'].strip().casefold() == memory['key'].strip().casefold():
                        conn.execute("UPDATE memories SET status='superseded',updated_at=? WHERE id=?", (now(), old['id']))
            conn.execute('UPDATE memories SET status=?, updated_at=? WHERE id=?', (status, now(), mid))
        return _one('SELECT * FROM memories WHERE id=?', (mid,))


def approved_memories():
    return _all("SELECT * FROM memories WHERE status='approved' ORDER BY id ASC")


# ─────────────────────────── Papan Tugas ───────────────────────────

def add_task(title, agent="", message_id=None):
    tid = _run(
        "INSERT INTO tasks (title, agent, status, created_at, updated_at, message_id) VALUES (?,?,?,?,?,?)",
        (title[:4000], agent, "queue", now(), now(), message_id),
    )
    return get_task(tid)


def get_task(tid):
    return _one("SELECT * FROM tasks WHERE id=?", (tid,))


def set_task_status(tid, status, result='', error=''):
    if status not in ('queue', 'doing', 'done', 'failed'):
        raise ValueError('Status tugas tidak valid')
    _run("UPDATE tasks SET status=?, result=?, error=?, updated_at=? WHERE id=?",
         (status, result[:16000], error[:1000], now(), tid))


def list_tasks(limit=None):
    if limit is None:
        return _all('SELECT * FROM tasks ORDER BY id DESC')
    return _all("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", (limit,))


def clear_tasks():
    _run("DELETE FROM tasks")


def recover_tasks(error='Pekerjaan terputus karena server dimulai ulang.'):
    _run("UPDATE tasks SET status='failed', error=?, updated_at=? WHERE status IN ('queue','doing')", (error, now()))


# ─────────────────────────── Setelan & Biaya ───────────────────────────

def get_setting(k, default=None):
    r = _one("SELECT v FROM settings WHERE k=?", (k,))
    return r["v"] if r else default


def set_setting(k, v):
    _run("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def set_settings(changes):
    with _lock:
        conn = get_conn()
        with conn:
            conn.executemany('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
                             [(k, str(v)) for k, v in changes.items()])


def usage_summary():
    return _all(
        "SELECT sender_name, mode, COUNT(*) AS pesan, COALESCE(SUM(ptok),0) AS ptok, COALESCE(SUM(ctok),0) AS ctok, "
        "COALESCE(SUM(cost),0) AS cost, "
        "SUM(CASE WHEN cost_source='recorded' THEN cost ELSE 0 END) AS recorded_cost, "
        "SUM(CASE WHEN cost_source='estimated' THEN cost ELSE 0 END) AS estimated_cost, "
        "SUM(CASE WHEN cost_source IN ('unknown','legacy') THEN 1 ELSE 0 END) AS unknown_count "
        "FROM usage_records GROUP BY sender_name,mode ORDER BY cost DESC,sender_name,mode"
    )


def usage_report():
    rows = usage_summary()
    fields = ('pesan', 'ptok', 'ctok', 'cost', 'recorded_cost', 'estimated_cost', 'unknown_count')
    total = dict.fromkeys(fields, 0)
    modes = {m: dict.fromkeys(fields, 0) for m in ('mock', 'live', 'legacy')}
    for row in rows:
        for key in fields:
            total[key] += row[key]
            modes[row['mode']][key] += row[key]
    return {'per_agent': rows, 'total': total, 'by_mode': modes}


# ─────────────────────────── Seed default ───────────────────────────

SOBIS_PROMPT = (
    'Kamu adalah Sobis, koordinator tim AI "Kantor Sobis" milik SolusiBisnis.com. '
    "Kamu bekerja di sebuah ruang grup bersama bos (user) dan agen-agen spesialis (Riset, Penulis, Admin, "
    "dan agen lain yang dibuat bos).\n\n"
    "Tugasmu:\n"
    "1. Pahami permintaan bos. Jika sederhana (tanya-jawab, koordinasi), jawab sendiri dengan ringkas.\n"
    "2. Jika butuh keahlian agen spesialis, pecah menjadi tugas-tugas kecil dan panggil tool assign_tasks. "
    "Tulis instruksi yang jelas dan bisa dikerjakan mandiri — agen tidak melihat diskusi selain konteks ruang dan instruksimu.\n"
    "3. Setelah agen selesai, rangkum hasil mereka menjadi satu jawaban rapi untuk bos. Jangan mengarang hasil yang tidak ada.\n"
    "4. Gunakan create_agent jika bos minta membuat agen baru; list_agents untuk melihat daftar agen; "
    "usulkan_memori untuk fakta penting jangka panjang (dipakai setelah bos menyetujui).\n\n"
    "Gaya: Bahasa Indonesia santai-profesional, ringkas, tidak bertele-tele. Kamu adalah pemimpin tim yang cekatan."
)


def _worker_prompt(name, role, skill):
    return (
        f'Kamu adalah {name}, agen spesialis "{role}" di tim AI Kantor Sobis (SolusiBisnis.com). '
        "Kamu bekerja di ruang grup bersama bos dan rekan-rekan agen.\n"
        f"- Keahlianmu: {skill}.\n"
        "- Kerjakan permintaan bos atau tugas dari Sobis sebaik mungkin; tulis hasil yang siap pakai, bukan basa-basi.\n"
        "- Jawab dalam Bahasa Indonesia, ringkas dan jelas.\n"
        "- Kamu belum punya akses internet/data terkini; jika membutuhkan data terkini, tulis asumsinya secara terbuka.\n"
        "- Fakta penting jangka panjang boleh kamu usulkan lewat tool usulkan_memori (dipakai setelah bos menyetujui)."
    )


def _seed():
    if list_agents():
        return
    create_agent("Sobis", role="Koordinator (orkestrator)", system_prompt=SOBIS_PROMPT, is_orchestrator=True)
    create_agent("Riset", role="Riset & data", system_prompt=_worker_prompt("Riset", "Riset & data", "riset pasar, kompetitor, referensi, dan merangkum informasi"))
    create_agent("Penulis", role="Penulis konten", system_prompt=_worker_prompt("Penulis", "Penulis konten", "menulis naskah video, artikel, caption, dan email"))
    create_agent("Admin", role="Administrasi", system_prompt=_worker_prompt("Admin", "Administrasi", "checklist, jadwal, SOP, struktur kerja, dan pengingat"))
    for key, value in {'user_name': config.USER_NAME_DEFAULT, 'default_model': config.DEFAULT_MODEL, 'llm_mode': 'mock'}.items():
        if get_setting(key) is None:
            set_setting(key, value)
