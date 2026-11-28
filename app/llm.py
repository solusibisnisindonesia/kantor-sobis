"""Klien LLM Rekan Kantor — OpenRouter + mode simulasi (mock)."""
import asyncio
import json
import os
import re

import httpx

from . import config, db

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def get_api_key():
    key = (os.environ.get("KANTOR_SOBIS_API_KEY") or os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if not key:
        key = (db.get_setting("openrouter_api_key", "") or "").strip()
    return key


def mode_locked():
    return os.environ.get('LLM_MODE', '').strip().lower() in ('mock', 'simulasi')


def get_mode():
    """Only explicit stored LIVE enables billing; the env may only force mock."""
    if mode_locked():
        return 'mock'
    return 'live' if db.get_setting('llm_mode', 'mock') == 'live' else 'mock'


async def stream_chat(model, messages, tools=None):
    """Hasilkan event: {"type":"delta","text"} | {"type":"tool_calls","calls"} | {"type":"usage","usage"}."""
    if get_mode() == "mock":
        async for ev in _mock_stream(model, messages, tools):
            yield ev
        return

    key = get_api_key()
    if not key:
        raise RuntimeError("Kunci API belum diisi — buka panel Setelan di aplikasi.")

    payload = {
        "model": model or config.DEFAULT_MODEL,
        "messages": messages,
        "stream": True,
        "usage": {"include": True},
    }
    if tools:
        payload["tools"] = tools
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8765",
        "X-Title": "Rekan Kantor",
    }

    tool_calls = {}
    completed = False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0)) as client:
            async with client.stream("POST", OPENROUTER_URL, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    raise RuntimeError(f'OpenRouter HTTP {resp.status_code}. Periksa konfigurasi dan ketersediaan model.')
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        completed = True
                        break
                    try:
                        chunk = json.loads(data)
                    except Exception:
                        continue
                    usage = chunk.get("usage")
                    if usage:
                        yield {"type": "usage", "usage": usage}
                    if chunk.get("error"):
                        raise RuntimeError('OpenRouter melaporkan kegagalan saat streaming.')
                    for ch in chunk.get("choices") or []:
                        d = ch.get("delta") or {}
                        if d.get("content"):
                            yield {"type": "delta", "text": d["content"]}
                        for tc in d.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            slot = tool_calls.setdefault(idx, {"id": "", "name": "", "args": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["args"] += fn["arguments"]
    except httpx.HTTPError:
        raise RuntimeError('Gagal menghubungi OpenRouter. Periksa koneksi dan coba lagi.') from None

    if not completed:
        raise RuntimeError('Respons OpenRouter terputus sebelum selesai.')
    if tool_calls:
        calls = []
        for i in sorted(tool_calls):
            s = tool_calls[i]
            try:
                args = json.loads(s["args"] or "{}")
            except Exception:
                args = {"_raw": s["args"]}
            calls.append({"id": s["id"] or f"call_{i}", "name": s["name"], "arguments": args})
        yield {"type": "tool_calls", "calls": calls}


# ─────────────────────────── Mode simulasi ───────────────────────────

def _chunks(s, n=26):
    return [s[i:i + n] for i in range(0, len(s), n)]


def _agent_name(messages):
    for m in messages:
        if m.get("role") == "system":
            mm = re.match(r"Kamu adalah\s+([A-Za-z0-9_]+)", m.get("content") or "")
            if mm:
                return mm.group(1)
            break
    return "Agen"


def _last_user(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            return m.get("content") or ""
    return ""


async def _mock_stream(model, messages, tools):
    names = [t["function"]["name"] for t in (tools or [])]
    agent = _agent_name(messages)
    text = _last_user(messages)
    low = text.lower()
    used_tools = any(m.get("role") == "tool" for m in messages)

    calls = None
    pre_text = ""

    if not used_tools and "assign_tasks" in names and any(k in low for k in ("bagi", "tugas", "rencana", "kerjakan")):
        pre_text = "Siap bos! Saya pecah dulu jadi beberapa tugas untuk tim. "
        topic = text.strip()[:160]
        calls = [{"id": "call_1", "name": "assign_tasks", "arguments": {"tasks": [
            {"agent_name": "Riset", "instruction": f"Riset bahan dan data untuk: {topic}"},
            {"agent_name": "Penulis", "instruction": f"Susun draf awal konten untuk: {topic}"},
        ]}}]
    elif not used_tools and "create_agent" in names and "buat agen" in low:
        m2 = re.search(r"nama[:\s]+([A-Za-z0-9_]+)", text)
        nm = m2.group(1) if m2 else "Desainer"
        m3 = re.search(r"(?:peran|tugas)(?:nya)?[:\s]+(.{3,120})", text)
        role = m3.group(1).strip() if m3 else "Agen baru buatan Sobis"
        pre_text = f"Baik, saya buatkan agen baru bernama {nm}. "
        calls = [{"id": "call_1", "name": "create_agent", "arguments": {
            "name": nm,
            "role": role,
            "system_prompt": f"Kamu adalah {nm}, agen tim Rekan Kantor. Peran: {role}. Jawab ringkas dalam Bahasa Indonesia.",
        }}]
    elif not used_tools and "usulkan_memori" in names and any(k in low for k in ("ingat", "memori", "catat")):
        pre_text = "Oke, saya usulkan ini masuk memori proyek dulu ya. "
        calls = [{"id": "call_1", "name": "usulkan_memori", "arguments": {"key": "catatan", "value": text.strip()[:150]}}]

    if calls:
        if pre_text:
            for piece in _chunks(pre_text):
                yield {"type": "delta", "text": piece}
                await asyncio.sleep(0.015)
        yield {"type": "tool_calls", "calls": calls}
        yield {"type": "usage", "usage": {"prompt_tokens": max(20, len(text) // 4), "completion_tokens": max(10, len(pre_text) // 4), "cost": 0.0}}
        return

    if used_tools:
        reply = (f"\U0001F9EA (simulasi) {agent}: selesai — semua tugas sudah dijalankan dan hasilnya "
                 f"muncul di atas. Ini ringkasan dalam mode simulasi ya bos.")
    elif text.strip():
        reply = (f"\U0001F9EA (simulasi) {agent} menerima: \u201C{text.strip()[:120]}\u201D — ini balasan simulasi "
                 f"(tanpa panggilan AI berbayar). Isi kunci API di panel Setelan untuk mode live.")
    else:
        reply = f"\U0001F9EA (simulasi) {agent}: halo!"

    for piece in _chunks(reply):
        yield {"type": "delta", "text": piece}
        await asyncio.sleep(0.015)
    yield {"type": "usage", "usage": {"prompt_tokens": max(20, len(text) // 4), "completion_tokens": max(10, len(reply) // 4), "cost": 0.0}}
