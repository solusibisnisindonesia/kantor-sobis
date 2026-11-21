"""Isolated browser QA server. No existing database or credentials are used.
Run with the project venv. Visit http://127.0.0.1:8766/__qa in the preview.
"""
import os
import sys
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager
import asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ['LLM_MODE'] = 'mock'
os.environ['KANTOR_SOBIS_DB'] = str(Path(tempfile.mkdtemp(prefix='kantor-browser-qa-')) / 'qa.db')
os.environ.pop('OPENROUTER_API_KEY', None)
os.environ.pop('KANTOR_SOBIS_API_KEY', None)

from app import db, llm
from app.main import app
from fastapi.responses import FileResponse
import uvicorn

original_lifespan = app.router.lifespan_context
original_stream = llm.stream_chat

async def controlled_stream(model, messages, tools=None):
    latest = next((m.get('content','') for m in reversed(messages) if m.get('role')=='user'),'')
    if 'UJI_GAGAL' in latest:
        raise RuntimeError('Kegagalan terkontrol dalam server QA lokal')
    if 'UJI_LAMBAT' in latest:
        await asyncio.sleep(2)
    async for event in original_stream(model, messages, tools):
        yield event

@asynccontextmanager
async def qa_lifespan(app):
    async with original_lifespan(app):
        for i in range(1, 9):
            db.create_agent('QA'+str(i), role='Agen uji kapasitas; bukan data produksi')
        llm.stream_chat = controlled_stream
        yield

app.router.lifespan_context = qa_lifespan

@app.get('/__qa')
async def qa_page():
    return FileResponse(ROOT / 'tests' / 'browser_qa.html')

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=8766, log_level='warning')
