"""Mesin utama Kantor Sobis: router pesan, orkestrator Sobis, konteks ruang, papan tugas."""
import asyncio
import json
import re
from datetime import datetime

from . import config, db, llm

MENTION_RE = re.compile(r"@([A-Za-z0-9_\u00C0-\u024F.-]{1,30})")


class Room:
    """Ruang chat: kunci antrean kerja + siaran event real-time (SSE)."""

    def __init__(self):
        self.lock = asyncio.Lock()
        self.subscribers = set()
        self.queue_len = 0
        self.agent_statuses = {}
        self.message_id = None
        self.stopping = False
        self.jobs = {}

    async def publish(self, event: dict):
        if event.get('type') == 'agent_status':
            self.agent_statuses[event['agent']] = {'status': event['status'], 'task_id': event.get('task_id')}
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except Exception:
                pass

    @property
    def busy(self):
        return self.lock.locked() or self.queue_len > 0


room = Room()

# ─────────────────────────── Definisi tool ───────────────────────────

USULKAN_MEMORI_TOOL = {
    "type": "function",
    "function": {
        "name": "usulkan_memori",
        "description": "Usulkan fakta penting jangka panjang ke memori proyek. Memori baru dipakai semua agen SETELAH disetujui bos.",
        "parameters": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Label singkat, mis. 'target upload'"},
                "value": {"type": "string", "description": "Isi fakta yang diusulkan"},
            },
            "required": ["key", "value"],
        },
    },
}

SOBIS_TOOLS = [
    {"type": "function", "function": {
        "name": "assign_tasks",
        "description": "Bagi pekerjaan ke agen spesialis (satu entri per agen). Tulis instruksi lengkap & mandiri.",
        "parameters": {"type": "object", "properties": {"tasks": {"type": "array", "items": {
            "type": "object",
            "properties": {"agent_name": {"type": "string"}, "instruction": {"type": "string"}},
            "required": ["agent_name", "instruction"],
        }}}, "required": ["tasks"]},
    }},
    {"type": "function", "function": {
        "name": "create_agent",
        "description": "Buat agen baru ketika bos memintanya.",
        "parameters": {"type": "object", "properties": {
            "name": {"type": "string", "description": "Satu kata, tanpa spasi"},
            "role": {"type": "string"},
            "system_prompt": {"type": "string", "description": "Prompt sistem agen (boleh dikosongkan)"},
        }, "required": ["name"]},
    }},
    {"type": "function", "function": {
        "name": "list_agents",
        "description": "Lihat daftar agen yang ada beserta perannya.",
        "parameters": {"type": "object", "properties": {}},
    }},
    USULKAN_MEMORI_TOOL,
]

WORKER_TOOLS = [USULKAN_MEMORI_TOOL]

# ─────────────────────────── Router pesan ───────────────────────────

def resolve_route(content, agents):
    found = MENTION_RE.findall(content or "")
    active = [a for a in agents if a["is_active"]]
    lookup = {a["name"].lower(): a for a in active}
    orchestrator = next((a for a in active if a["is_orchestrator"]), None)

    targets = []
    broadcast = False
    for f in found:
        fl = f.lower()
        if fl in ("semua", "all"):
            broadcast = True
        elif fl in lookup and lookup[fl] not in targets:
            targets.append(lookup[fl])

    if broadcast:
        return {"mode": "broadcast", "agents": [a for a in active if not a["is_orchestrator"]], "orchestrator": orchestrator}
    if targets:
        return {"mode": "direct", "agents": targets, "orchestrator": orchestrator}
    return {"mode": "orchestrator", "agents": ([orchestrator] if orchestrator else []), "orchestrator": orchestrator}

# ─────────────────────────── Konteks & prompt ───────────────────────────

def memory_block():
    mem = db.approved_memories()
    if not mem:
        return ""
    lines = "\n".join(f"- {m['key']}: {m['value']}" for m in mem)
    return f"\n\n\U0001F4CC MEMORI PROYEK (disetujui bos):\n{lines}\n"


def room_context(limit=30, message_id=None):
    msgs = db.recent_messages(limit, message_id=message_id)
    lines = []
    for m in msgs:
        c = (m["content"] or "").replace("\n", " ").strip()
        if len(c) > 500:
            c = c[:500] + "\u2026"
        tag = {"user": "bos", "agent": "agen", "system": "sistem"}.get(m["sender_type"], m["sender_type"])
        lines.append(f"[{tag}] {m['sender_name']}: {c}")
    return "\n".join(lines)


def build_messages(agent, user_text, message_id=None):
    parts = [(agent["system_prompt"] or f"Kamu adalah {agent['name']}.").strip()]
    if agent["is_orchestrator"]:
        others = [a for a in db.list_agents() if a["is_active"] and not a["is_orchestrator"]]
        roster = ", ".join(f"{a['name']} ({a['role'] or 'agen'})" for a in others) or "(belum ada agen lain)"
        parts.append(f"\nAgen yang tersedia saat ini: {roster}. Nama bos (user): {db.get_setting('user_name', config.USER_NAME_DEFAULT)}.")
    parts.append(f"\nWaktu sekarang: {datetime.now().strftime('%A, %d %B %Y %H:%M')}.")
    parts.append(memory_block())
    parts.append("\nSelalu jawab dalam Bahasa Indonesia.")
    ctx = room_context(30, message_id=message_id)
    system_text = "\n".join(p for p in parts if p)
    system_text += "\n\n=== RIWAYAT RUANG (pesan terakhir) ===\n" + (ctx or "(belum ada)") + "\n=== AKHIR RIWAYAT ===\n\nIkuti permintaan terbaru berikut."
    return [{"role": "system", "content": system_text}, {"role": "user", "content": user_text}]

# ─────────────────────────── Menjalankan agen ───────────────────────────

async def _system_note(text):
    m = db.add_message("system", "Sistem", text)
    await room.publish({"type": "message", "message": m})


async def run_agent(agent, user_text, tools, task_id=None):
    """Jalankan satu agen (dengan loop tool call). Kembalikan teks jawaban yang terkumpul."""
    agent = db.get_agent(agent['id'])
    if not agent or not agent['is_active']:
        raise ValueError('Agen tidak aktif')
    tools = [tool for tool in (SOBIS_TOOLS if agent['is_orchestrator'] else WORKER_TOOLS)
             if tool['function']['name'] in agent['allowed_tools']]
    name = agent["name"]
    model = (agent["model"] or "").strip() or db.get_setting("default_model", config.DEFAULT_MODEL) or config.DEFAULT_MODEL
    msgs = build_messages(agent, user_text, message_id=room.message_id)
    await room.publish({"type": "agent_status", "agent": name, "status": "working", 'task_id': task_id})
    collected = []
    try:
        for _ in range(4):
            content, calls, usage = "", None, None
            mode = llm.get_mode()
            try:
                async for ev in llm.stream_chat(model, msgs, tools=tools):
                    if ev["type"] == "delta":
                        content += ev["text"]
                        await room.publish({"type": "delta", "agent": name, "text": ev["text"],
                                            'task_id': room.agent_statuses[name]['task_id']})
                    elif ev["type"] == "tool_calls":
                        calls = ev["calls"]
                    elif ev["type"] == "usage":
                        usage = {**(usage or {}), **ev['usage']}
            finally:
                db.record_usage(name, model, usage=usage, mode=mode)
                await room.publish({'type': 'usage_changed'})
            if content.strip():
                msg = db.add_message("agent", name, content.strip(), model=model, usage=usage, mode=mode, record=False)
                await room.publish({"type": "message", "message": msg})
                collected.append(content.strip())
            if not calls:
                if not content.strip():
                    raise RuntimeError('Model tidak memberikan hasil')
                break
            msgs.append({
                "role": "assistant",
                "content": content or None,
                "tool_calls": [{"id": c["id"], "type": "function",
                                "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {}, ensure_ascii=False)}}
                               for c in calls],
            })
            for c in calls:
                result = await execute_tool(agent, c)
                if _has_error(json.loads(result)):
                    raise RuntimeError('Tool gagal atau tidak diizinkan')
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": result[:4000]})
        else:
            raise RuntimeError('Batas putaran tool tercapai')
    except BaseException:
        await room.publish({'type': 'agent_status', 'agent': name, 'status': 'error'})
        raise
    else:
        await room.publish({"type": "agent_status", "agent": name, "status": "idle"})
    return "\n\n".join(collected)


def _has_error(value):
    if isinstance(value, dict):
        return bool(value.get('error')) or any(_has_error(v) for v in value.values())
    return isinstance(value, list) and any(_has_error(v) for v in value)


async def safe_run(agent, user_text, tools, task=None):
    task = task or db.add_task(user_text, agent['name'], room.message_id)
    db.set_task_status(task['id'], 'doing')
    await room.publish({'type': 'tasks_changed'})
    try:
        result = await run_agent(agent, user_text, tools, task_id=task['id'])
        db.set_task_status(task['id'], 'done', result=result)
        return result
    except asyncio.CancelledError:
        db.set_task_status(task['id'], 'failed', error='Pekerjaan terputus saat server dihentikan.')
        raise
    except Exception:
        db.set_task_status(task['id'], 'failed', error='Pekerjaan gagal. Periksa koneksi, konfigurasi model, dan izin tool.')
        await room.publish({'type': 'agent_status', 'agent': agent['name'], 'status': 'error', 'task_id': task['id']})
        await _system_note(f"Pekerjaan {agent['name']} gagal. Periksa koneksi, konfigurasi model, dan izin tool.")
        return ""
    finally:
        await room.publish({'type': 'tasks_changed'})

# ─────────────────────────── Eksekusi tool ───────────────────────────

async def execute_tool(agent, call):
    agent = db.get_agent(agent.get('id'))
    name = call.get("name") or ""
    if not agent or not agent['is_active'] or name not in agent['allowed_tools'] or (name != 'usulkan_memori' and not agent['is_orchestrator']):
        return json.dumps({'error': 'Tool tidak diizinkan'})
    args = call.get("arguments") or {}
    if not isinstance(args, dict):
        return json.dumps({'error': 'Argumen tool harus objek'})
    try:
        if name == "assign_tasks":
            return await _tool_assign_tasks(agent, args)
        if name == "create_agent":
            return await _tool_create_agent(agent, args)
        if name == "list_agents":
            ags = [{"nama": a["name"], "peran": a["role"], "aktif": a["is_active"]} for a in db.list_agents()]
            return json.dumps(ags, ensure_ascii=False)
        if name == "usulkan_memori":
            return await _tool_usulkan_memori(agent, args)
    except Exception:
        return json.dumps({"error": 'Gagal menjalankan tool: argumen atau operasi tidak valid'}, ensure_ascii=False)
    return json.dumps({"error": f"Tool tidak dikenal: {name}"}, ensure_ascii=False)


async def _tool_assign_tasks(agent, args):
    tasks = [t for t in (args.get("tasks") or []) if isinstance(t, dict)][:5]
    if not tasks:
        return json.dumps({"error": "tasks kosong"}, ensure_ascii=False)

    lines = [f"\U0001F4CB Rencana {agent['name']}:"]
    for t in tasks:
        lines.append(f"\u2022 @{t.get('agent_name', '?')} \u2014 {(t.get('instruction') or '').strip()[:180]}")
    plan = db.add_message("system", "Rencana", "\n".join(lines))
    await room.publish({"type": "message", "message": plan})

    results = []
    for t in tasks:
        agent_name = (t.get("agent_name") or "").strip()
        instruction = (t.get("instruction") or "").strip()
        target = db.get_agent_by_name(agent_name)
        if not target or not target["is_active"] or target["is_orchestrator"]:
            results.append({"agen": agent_name, "error": "agen tidak ditemukan / tidak aktif"})
            continue
        task = db.add_task(instruction, target["name"], room.message_id)
        await room.publish({'type': 'delegation', 'from': agent['name'], 'to': target['name'], 'task_id': task['id']})
        out = await safe_run(
            target,
            f"Tugas dari {agent['name']} untukmu:\n{instruction}\n\nKerjakan sekarang dan tulis hasilnya langsung.",
            tools=WORKER_TOOLS,
            task=task,
        )
        terminal = db.get_task(task['id'])
        results.append({'agen': target['name'], 'error': terminal['error']} if terminal['status'] == 'failed'
                       else {"agen": target["name"], "hasil": (out or "(tanpa isi)")[:1200]})
    return json.dumps(results, ensure_ascii=False)


async def _tool_create_agent(agent, args):
    nm = args.get('name') or ''
    if not nm:
        return json.dumps({"error": "nama kosong"}, ensure_ascii=False)
    if db.get_agent_by_name(nm):
        return json.dumps({"error": f"Agen bernama {nm} sudah ada"}, ensure_ascii=False)
    a = db.create_agent(
        nm,
        role=(args.get("role") or "Agen buatan Sobis").strip()[:80],
        system_prompt=(args.get("system_prompt") or "").strip(),
    )
    note = db.add_message("system", "Sistem", f"\U0001F195 Agen baru dibuat: {a['name']} \u2014 {a['role']}")
    await room.publish({"type": "message", "message": note})
    await room.publish({"type": "agents_changed"})
    return json.dumps({"ok": True, "agen": a["name"], "peran": a["role"]}, ensure_ascii=False)


async def _tool_usulkan_memori(agent, args):
    key = (args.get("key") or "catatan").strip()[:60]
    val = (args.get("value") or "").strip()[:400]
    if not val:
        return json.dumps({"error": "value kosong"}, ensure_ascii=False)
    db.add_memory(key, val, source=agent["name"])
    note = db.add_message(
        "system", "Sistem",
        f"\U0001F4DD {agent['name']} mengusulkan memori baru: {key} = {val[:120]} \u2014 buka panel Persetujuan untuk menyetujui/menolak.",
    )
    await room.publish({"type": "message", "message": note})
    await room.publish({"type": "memories_changed"})
    return json.dumps({"ok": True, "catatan": "menunggu persetujuan bos"}, ensure_ascii=False)

# ─────────────────────────── Alur utama pesan ───────────────────────────

def enqueue_message(message_id):
    """Reserve queued cards synchronously before yielding to another API request."""
    if room.stopping:
        raise ValueError('Server sedang dihentikan')
    if message_id in room.jobs:
        return room.jobs[message_id]
    msg = db.get_message(message_id)
    if not msg:
        return None
    route = resolve_route(msg['content'], db.list_agents())
    tasks = [(a, db.add_task(msg['content'], a['name'], message_id)) for a in route['agents']]
    room.jobs[message_id] = tasks
    room.queue_len += 1
    return tasks


async def handle_user_message(message_id):
    jobs = enqueue_message(message_id)
    if jobs is None:
        return
    waiting = True
    try:
        await room.publish({'type': 'room_status', 'status': 'working', 'queue': room.queue_len})
        async with room.lock:
            room.queue_len -= 1
            waiting = False
            room.message_id = message_id
            await room.publish({'type': 'room_status', 'status': 'working', 'queue': room.queue_len})
            msg = db.get_message(message_id)
            if not msg:
                return
            if not jobs:
                await _system_note('Tidak ada agen aktif yang dapat menerima pesan ini.')
            for agent, task in jobs:
                await safe_run(agent, msg['content'], tools=SOBIS_TOOLS if agent['is_orchestrator'] else WORKER_TOOLS, task=task)
    except asyncio.CancelledError:
        raise
    except Exception:
        await _system_note('Pemrosesan pesan gagal. Periksa konfigurasi kantor.')
    finally:
        if waiting:
            room.queue_len -= 1
        for agent, task in jobs:
            if db.get_task(task['id'])['status'] in ('queue', 'doing'):
                db.set_task_status(task['id'], 'failed', error='Pekerjaan terputus sebelum selesai.')
        room.jobs.pop(message_id, None)
        if room.message_id == message_id:
            room.message_id = None
        await room.publish({'type': 'tasks_changed'})
        await room.publish({'type': 'room_status', 'status': 'working' if room.busy else 'idle', 'queue': room.queue_len})

