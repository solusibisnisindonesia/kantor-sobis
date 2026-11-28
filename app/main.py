"""Server Rekan Kantor — FastAPI + SSE."""
import asyncio
import json
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import config, db, engine, llm, business
from . import __version__

STATIC_DIR = config.BASE_DIR / "static"


class StrictPayload(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')


class MessagePayload(StrictPayload):
    content: str = Field(min_length=1, max_length=4000)


class AgentUpdate(StrictPayload):
    # Omitted fields retain existing values; explicit null is invalid.
    name: str = Field(default=None, min_length=2, max_length=20)
    role: str = Field(default=None, max_length=200)
    system_prompt: str = Field(default=None, max_length=20000)
    model: str = Field(default=None, max_length=120)
    is_active: bool = None
    is_orchestrator: bool = None
    allowed_tools: list[str] = Field(default=None, max_length=4)
    media_models: list[str] = Field(default=None, max_length=20)


class AgentCreate(AgentUpdate):
    name: str = Field(min_length=2, max_length=20)


class SettingsPayload(StrictPayload):
    user_name: str = Field(default=None, min_length=1, max_length=40)
    default_model: str = Field(default=None, min_length=1, max_length=120)
    llm_mode: Literal['mock', 'live'] = None
    api_key: str = Field(default=None, max_length=1000, repr=False)
    remove_api_key: bool = False
    confirm_live: bool = False


@asynccontextmanager
async def lifespan(app):
    db.init()
    db.recover_tasks()
    engine.room = engine.Room()
    print(f"[Rekan Kantor] Mode: {llm.get_mode()} | Data: {config.DATA_DIR}")
    try:
        yield
    finally:
        engine.room.stopping = True
        pending = list(_background)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        _background.difference_update(pending)
        db.recover_tasks('Pekerjaan terputus saat server dihentikan.')
        engine.room.jobs.clear()
        engine.room.queue_len = 0
        engine.room.message_id = None
        for status in engine.room.agent_statuses.values():
            if status['status'] == 'working':
                status['status'] = 'error'


app = FastAPI(title=config.APP_NAME, lifespan=lifespan)
app.include_router(business.router)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # Do not echo request input: a malformed settings body may contain a key.
    return JSONResponse(status_code=422, content={'detail': [
        {'loc': list(error['loc']), 'msg': error['msg'], 'type': error['type']}
        for error in exc.errors()]})

_background = set()


def spawn(coro):
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


def require_idle():
    if engine.room.busy:
        raise HTTPException(409, 'Kantor sedang sibuk; tunggu semua antrean selesai')


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "business.html"))


@app.get('/kantor')
async def office():
    return FileResponse(str(STATIC_DIR / "index.html"))


def _state():
    # No awaits: room and DB are sampled in one event-loop turn, under the DB lock.
    with db._lock:
        agents = db.list_agents()
        statuses = {a['name']: dict(engine.room.agent_statuses.get(a['name'], {'status': 'idle', 'task_id': None})) for a in agents}
        for agent in agents:
            agent['status'] = statuses[agent['name']]['status']
        memories = db.list_memories()
        tasks = db.list_tasks()
        pending = [m for m in memories if m['status'] == 'pending']
        counts = {s: 0 for s in ('queue', 'doing', 'done', 'failed')}
        for task in tasks:
            counts[task['status']] += 1
        return {
            'app_name': config.APP_NAME, 'tagline': config.APP_TAGLINE, 'version': __version__,
            'llm_mode': llm.get_mode(), 'llm_setting': 'live' if db.get_setting('llm_mode') == 'live' else 'mock',
            'mode_locked': llm.mode_locked(), 'has_key': bool(llm.get_api_key()),
            'user_name': db.get_setting('user_name', config.USER_NAME_DEFAULT),
            'default_model': db.get_setting('default_model', config.DEFAULT_MODEL), 'models': config.MODELS,
            'agents': agents, 'pending': pending, 'memories': memories, 'tasks': tasks,
            'busy': engine.room.busy, 'queue': engine.room.queue_len, 'agent_statuses': statuses,
            'summary': {'active_agents': sum(a['is_active'] for a in agents),
                        'working_agents': sum(s['status'] == 'working' for s in statuses.values()),
                        'pending_memories': len(pending), 'tasks': counts,
                        'messages': db._one('SELECT COUNT(*) AS n FROM messages')['n']},
            'usage': db.usage_report(),
        }


@app.get('/api/health')
async def api_health():
    return {'ok': True, 'version': __version__}


@app.get('/api/models')
async def api_models():
    return {'models': config.MODELS}


@app.get('/api/memories')
async def api_memories():
    return {'memories': db.list_memories()}


@app.get('/api/tasks/{task_id}')
async def api_task(task_id: int):
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, 'Tugas tidak ditemukan')
    return {'task': task}


@app.get("/api/state")
async def api_state():
    return _state()


@app.get("/api/messages")
async def api_messages(limit: int = 300):
    return {"messages": db.get_messages(limit=limit)}


@app.post("/api/messages")
async def api_post_message(payload: MessagePayload):
    if engine.room.stopping:
        raise HTTPException(503, 'Server sedang dihentikan')
    content = payload.content.strip()
    if not content:
        raise HTTPException(400, "Pesan kosong")
    if len(content) > 4000:
        raise HTTPException(400, "Pesan terlalu panjang (maks 4000 karakter)")
    if llm.get_mode() == 'live' and not llm.get_api_key():
        raise HTTPException(409, 'Mode LIVE memerlukan Kunci API. Isi Setelan atau pilih SIMULASI.')
    msg = db.add_message("user", db.get_setting("user_name", config.USER_NAME_DEFAULT), content)
    engine.enqueue_message(msg['id'])
    await engine.room.publish({"type": "message", "message": msg})
    spawn(engine.handle_user_message(msg["id"]))
    return {"ok": True, "id": msg["id"]}


@app.get("/api/events")
async def api_events(request: Request):
    q = asyncio.Queue()
    engine.room.subscribers.add(q)

    async def gen():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            engine.room.subscribers.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


# ─────────────────────────── Agen ───────────────────────────

@app.post("/api/agents")
async def api_create_agent(payload: AgentCreate):
    require_idle()
    p = payload.model_dump(exclude_unset=True)
    try:
        a = db.create_agent(**p)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await engine.room.publish({"type": "agents_changed"})
    return {"ok": True, "agent": a}


@app.put("/api/agents/{agent_id}")
async def api_update_agent(agent_id: int, payload: AgentUpdate):
    require_idle()
    fields = payload.model_dump(exclude_unset=True)
    try:
        a = db.update_agent(agent_id, **fields)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not a:
        raise HTTPException(404, "Agen tidak ditemukan")
    await engine.room.publish({"type": "agents_changed"})
    return {"ok": True, "agent": a}


@app.delete("/api/agents/{agent_id}")
async def api_delete_agent(agent_id: int):
    require_idle()
    if not db.get_agent(agent_id):
        raise HTTPException(404, "Agen tidak ditemukan")
    try:
        db.delete_agent(agent_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    await engine.room.publish({"type": "agents_changed"})
    return {"ok": True}


# ─────────────────────────── Memori ───────────────────────────

@app.post("/api/memories/{mid}/approve")
async def api_memory_approve(mid: int):
    require_idle()
    try:
        m = db.set_memory_status(mid, "approved")
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    if not m:
        raise HTTPException(404, "Memori tidak ditemukan")
    note = db.add_message("system", "Sistem", f"\u2705 Memori disetujui: {m['key']} = {m['value'][:120]}")
    await engine.room.publish({"type": "message", "message": note})
    await engine.room.publish({"type": "memories_changed"})
    return {"ok": True}


@app.post("/api/memories/{mid}/reject")
async def api_memory_reject(mid: int):
    require_idle()
    try:
        m = db.set_memory_status(mid, "rejected")
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    if not m:
        raise HTTPException(404, "Memori tidak ditemukan")
    await engine.room.publish({"type": "memories_changed"})
    return {"ok": True}


# ─────────────────────────── Papan tugas & biaya ───────────────────────────

@app.get("/api/tasks")
async def api_tasks():
    return {"tasks": db.list_tasks()}


@app.post("/api/tasks/clear")
async def api_tasks_clear():
    require_idle()
    db.clear_tasks()
    await engine.room.publish({"type": "tasks_changed"})
    return {"ok": True}


@app.get("/api/usage")
async def api_usage():
    return db.usage_report()


# ─────────────────────────── Setelan & riwayat ───────────────────────────

@app.post("/api/settings")
async def api_settings(payload: SettingsPayload):
    require_idle()
    p = payload.model_dump(exclude_unset=True)
    if p.get('api_key') and p.get('remove_api_key'):
        raise HTTPException(400, 'Pilih simpan atau hapus kunci, bukan keduanya')
    if p.get('llm_mode') == 'live':
        if llm.mode_locked():
            raise HTTPException(409, 'Server dipaksa SIMULASI; mode LIVE tidak dapat diaktifkan')
        if not p.get('confirm_live'):
            raise HTTPException(400, 'Aktivasi LIVE memerlukan konfirmasi penggunaan berbayar')
        has_key = bool(p.get('api_key', '').strip()) or (not p.get('remove_api_key') and bool(llm.get_api_key()))
        if not has_key:
            raise HTTPException(400, 'Kunci API belum diisi untuk mode LIVE')
    changes = {}
    for key in ('user_name', 'default_model'):
        if key in p:
            if not p[key].strip():
                raise HTTPException(400, 'Nama pengguna/model tidak boleh kosong')
            changes[key] = p[key].strip()
    if 'llm_mode' in p:
        changes['llm_mode'] = p['llm_mode']
    if p.get('api_key', '').strip():
        changes['openrouter_api_key'] = p['api_key'].strip()
    if p.get('remove_api_key'):
        changes['openrouter_api_key'] = ''
    db.set_settings(changes)
    await engine.room.publish({"type": "state_changed"})
    return {"ok": True, **_state()}


@app.post("/api/history/clear")
async def api_clear_history():
    require_idle()
    db.clear_messages()
    await engine.room.publish({"type": "cleared"})
    return {"ok": True}
