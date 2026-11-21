"""Konfigurasi dasar Kantor Sobis."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
# Isolated mock runs never load a file that might contain credentials.
if os.environ.get('LLM_MODE', '').strip().lower() not in ('mock', 'simulasi'):
    load_dotenv(BASE_DIR / '.env')

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = os.environ.get("KANTOR_SOBIS_DB", str(DATA_DIR / "kantor_sobis.db"))
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "0.0.0.0")

APP_NAME = "Kantor Sobis"
APP_TAGLINE = "by SolusiBisnis.com"

DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"
USER_NAME_DEFAULT = os.environ.get("USER_NAME", "Pengguna")

# Daftar model manual (tanpa unduhan dari internet).
# "in"/"out" = perkiraan harga USD per 1 juta token, hanya untuk estimasi di panel Biaya.
MODELS = [
    {"id": "deepseek/deepseek-v4.1-flash", "label": "DeepSeek V4.1 Flash", "note": "termurah & kuat — disarankan", "in": 0.30, "out": 1.20},
    {"id": "z-ai/glm-5.3-flash", "label": "GLM 5.3 Flash", "note": "sangat murah", "in": 0.15, "out": 0.50},
    {"id": "openai/gpt-6-luna", "label": "GPT-6 Luna (OpenAI)", "note": "murah", "in": 0.10, "out": 0.50},
    {"id": "anthropic/claude-haiku-5.5", "label": "Claude Haiku 5.5", "note": "murah (Anthropic)", "in": 0.10, "out": 0.50},
    {"id": "google/gemini-3.8-flash", "label": "Gemini 3.8 Flash", "note": "cepat & murah", "in": 0.75, "out": 3.75},
    {"id": "minimax/minimax-m3.1-flash", "label": "MiniMax M3.1 Flash", "note": "murah", "in": 0.15, "out": 0.60},
    {"id": "moonshotai/kimi-k2.6", "label": "Kimi K2.6", "note": "nilai bagus", "in": 0.39, "out": 1.64},
    {"id": "openai/gpt-6.1-sol", "label": "GPT-6.1 Sol", "note": "kelas menengah — bagus untuk Sobis", "in": 2.0, "out": 10.0},
    {"id": "anthropic/claude-sonnet-5.5", "label": "Claude Sonnet 5.5", "note": "kelas menengah", "in": 2.0, "out": 10.0},
    {"id": "z-ai/glm-5.3", "label": "GLM 5.3", "note": "kelas menengah", "in": 1.40, "out": 4.40},
    {"id": "x-ai/grok-4.6", "label": "Grok 4.6", "note": "kelas menengah", "in": 2.0, "out": 6.0},
]

# Metadata/harga dipelihara manual; bukan janji ketersediaan atau tarif provider.
for _model in MODELS:
    _model['note'] = 'Daftar manual; model/harga belum diverifikasi, biaya hanya estimasi'
    _model['price_source'] = 'manual_unverified'


def price_of(model_id):
    """Kembalikan (harga_in, harga_out) per 1 juta token, atau None bila tak dikenal."""
    for m in MODELS:
        if m["id"] == model_id:
            return m["in"], m["out"]
    return None
