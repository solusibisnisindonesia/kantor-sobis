"""Konfigurasi dasar Rekan Kantor."""
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
HOST = os.environ.get("HOST", "127.0.0.1")

APP_NAME = "Rekan Kantor"
APP_TAGLINE = "by SolusiBisnis.com"

DEFAULT_MODEL = "openai/gpt-4.1-mini"
USER_NAME_DEFAULT = os.environ.get("USER_NAME", "Pengguna")

# Snapshot manual dari https://openrouter.ai/api/v1/models, 23 November 2026.
# Ketersediaan dan harga dapat berubah; tidak diunduh saat aplikasi berjalan.
# "in"/"out" = perkiraan harga USD per 1 juta token, hanya untuk estimasi di panel Biaya.
MODELS = [
    {"id": "openai/gpt-4.1-mini", "label": "OpenAI GPT-4.1 Mini", "in": 0.40, "out": 1.60},
    {"id": "google/gemini-2.5-flash", "label": "Google Gemini 2.5 Flash", "in": 0.30, "out": 2.50},
    {"id": "anthropic/claude-haiku-4.5", "label": "Anthropic Claude Haiku 4.5", "in": 1.00, "out": 5.00},
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
