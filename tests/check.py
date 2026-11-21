"""Tes otomatis Kantor Sobis — mode simulasi (tanpa biaya API).

Jalankan dari folder kantor-sobis:
    .venv\\Scripts\\python.exe tests\\check.py
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TMP_DB = Path(tempfile.mkdtemp(prefix="ks_test_")) / "test.db"
os.environ["KANTOR_SOBIS_DB"] = str(TMP_DB)
os.environ["LLM_MODE"] = "mock"
os.environ.pop("KANTOR_SOBIS_API_KEY", None)
os.environ.pop("OPENROUTER_API_KEY", None)

import httpx  # noqa: E402

from app import db, engine, llm  # noqa: E402
from app.main import app  # noqa: E402

PASS = 0


def ok(cond, label):
    global PASS
    if not cond:
        raise AssertionError("GAGAL: " + label)
    PASS += 1
    print("  [OK] " + label)


async def send_and_wait(content):
    m = db.add_message("user", db.get_setting("user_name", "Pengguna Uji"), content)
    await engine.handle_user_message(m["id"])
    return m


def agent_msgs():
    return [m for m in db.get_messages(800) if m["sender_type"] == "agent"]


def msgs_by(name):
    return [m for m in agent_msgs() if m["sender_name"] == name]


async def main():
    db.init()
    ok(llm.get_mode() == "mock", "mode simulasi aktif untuk tes")
    names = [a["name"] for a in db.list_agents()]
    ok(names == ["Sobis", "Riset", "Penulis", "Admin"], "agen bawaan ter-seed: " + ", ".join(names))

    print("\n1) Routing langsung @Riset")
    before = len(agent_msgs())
    await send_and_wait("@Riset tolong rangkum 3 ide konten AI")
    new = agent_msgs()[before:]
    ok(len(new) == 1 and new[0]["sender_name"] == "Riset", "@Riset -> hanya Riset yang menjawab")

    print("\n2) Orkestrasi Sobis (bagi tugas)")
    before = len(agent_msgs())
    await send_and_wait("bagi tugas: buat rencana konten YouTube minggu depan")
    new = agent_msgs()[before:]
    senders = [m["sender_name"] for m in new]
    ok("Riset" in senders and "Penulis" in senders, "Riset & Penulis bekerja")
    ok(senders.count("Sobis") >= 2, "Sobis menulis rencana + rangkuman akhir")
    plan = [m for m in db.get_messages(800) if m["sender_name"] == "Rencana"]
    ok(len(plan) >= 1, "pesan rencana tampil di ruang")
    tasks = db.list_tasks()
    ok(len(tasks) >= 2 and all(t["status"] == "done" for t in tasks[:2]), "papan tugas: kartu selesai")

    print("\n3) Siaran @semua")
    before = len(agent_msgs())
    await send_and_wait("@semua laporan kilat dong")
    new = agent_msgs()[before:]
    got = {m["sender_name"] for m in new}
    ok({"Riset", "Penulis", "Admin"} <= got, "@semua -> semua agen aktif menjawab")

    print("\n4) Sobis membuat agen baru (tool create_agent)")
    await send_and_wait("Sobis, buat agen baru: Desainer, perannya desain thumbnail")
    ok(db.get_agent_by_name("Desainer") is not None, "agen 'Desainer' dibuat lewat tool")

    print("\n5) Memori: usul -> pending -> setujui")
    await send_and_wait("@Riset ingat: target upload video tiap Sabtu pagi")
    pending = db.list_memories("pending")
    ok(len(pending) >= 1, "usulan memori masuk daftar persetujuan")
    mid = pending[0]["id"]
    db.set_memory_status(mid, "approved")
    ok(any(m["id"] == mid for m in db.approved_memories()), "memori disetujui tersimpan")
    ctx = engine.build_messages(db.get_agent_by_name("Sobis"), "halo")[0]["content"]
    ok("MEMORI PROYEK" in ctx and "Sabtu" in ctx, "memori disetujui masuk konteks agen")

    print("\n6) Validasi nama agen")
    try:
        db.create_agent("Riset")
        ok(False, "nama dobel harus ditolak")
    except ValueError:
        ok(True, "nama agen dobel ditolak")
    try:
        db.create_agent("dua kata")
        ok(False, "nama tidak valid harus ditolak")
    except ValueError:
        ok(True, "nama agen tidak valid ditolak (spasi)")

    print("\n7) Orkestrator tunggal")
    d = db.get_agent_by_name("Desainer")
    db.update_agent(d["id"], is_orchestrator=True)
    ok(db.get_agent_by_name("Desainer")["is_orchestrator"] and not db.get_agent_by_name("Sobis")["is_orchestrator"],
       "pindah orkestrator menonaktifkan yang lama")
    try:
        db.update_agent(d["id"], is_orchestrator=False)
        ok(False, "kantor tidak boleh tanpa koordinator")
    except ValueError:
        ok(True, "koordinator terakhir tidak dapat dinonaktifkan tanpa pengganti")
    db.update_agent(db.get_agent_by_name("Sobis")["id"], is_orchestrator=True)
    ok(db.get_agent_by_name("Sobis")["is_orchestrator"], "orkestrator dikembalikan ke Sobis")

    print("\n8) Antrean dua pesan beruntun")
    m1 = db.add_message("user", "Pengguna Uji", "@Admin cek checklist satu")
    m2 = db.add_message("user", "Pengguna Uji", "@Admin cek checklist dua")
    await asyncio.gather(engine.handle_user_message(m1["id"]), engine.handle_user_message(m2["id"]))
    ok(len(msgs_by("Admin")) >= 2, "dua pesan beruntun diproses berurutan")

    print("\n9) Rekap biaya")
    rows = db.usage_summary()
    ok(len(rows) >= 3 and all(r["pesan"] > 0 for r in rows), "rekap biaya per agen terisi")

    print("\n10) Endpoint HTTP (ASGI)")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/state")
        ok(r.status_code == 200 and r.json()["agents"], "GET /api/state OK")
        r = await client.post("/api/messages", json={"content": "@Penulis tes via HTTP"})
        ok(r.status_code == 200, "POST /api/messages OK")
        await asyncio.sleep(0.3)
        for _ in range(200):
            if not engine.room.busy:
                break
            await asyncio.sleep(0.05)
        r = await client.get("/api/messages")
        ok(r.status_code == 200 and len(r.json()["messages"]) > 0, "GET /api/messages OK")
        r = await client.get("/api/usage")
        ok(r.status_code == 200, "GET /api/usage OK")
        r = await client.get("/api/tasks")
        ok(r.status_code == 200, "GET /api/tasks OK")

    print("\n11) Hapus riwayat")
    db.clear_messages()
    ok(len(db.get_messages(10)) == 0, "hapus riwayat bekerja")

    print("\nSEMUA LULUS -", PASS, "pemeriksaan [mode simulasi, biaya Rp 0]")


if __name__ == "__main__":
    asyncio.run(main())
