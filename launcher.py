"""Start the local Kantor Sobis server, then open the UI after readiness.

No package installation, key probing or paid requests take place here.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent


def port_in_use(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.8):
            return True
    except OSError:
        return False


def health_ok(url):
    try:
        with urllib.request.urlopen(url.rstrip('/') + '/api/health', timeout=1) as response:
            data = json.load(response)
        return isinstance(data, dict) and data.get('ok') is True and data.get('version') == '1.1.0'
    except (OSError, ValueError, urllib.error.URLError):
        return False


def wait_ready(url, process, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if health_ok(url):
            return True
        time.sleep(0.2)
    return False


def run(open_browser=True):
    port = int(os.environ.get('PORT', '8765'))
    host = os.environ.get('HOST', '127.0.0.1')
    url = f'http://127.0.0.1:{port}'
    if port_in_use('127.0.0.1', port):
        if not health_ok(url):
            print(f'Port {port} dipakai proses lain atau versi lama. Tutup server lama terlebih dahulu.')
            return 1
        print(f'Kantor Sobis sudah berjalan: {url}')
        if open_browser:
            webbrowser.open(url)
        return 0
    command = [sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', host, '--port', str(port)]
    print(f'Menyiapkan Kantor Sobis di {url} ...', flush=True)
    process = subprocess.Popen(command, cwd=str(ROOT))
    try:
        if not wait_ready(url, process):
            print('Server belum siap. Browser tidak dibuka. Periksa pesan kesalahan di atas.')
            return 1
        print(f'Siap: {url}. Biarkan jendela ini terbuka. Ctrl+C untuk berhenti.', flush=True)
        if open_browser:
            webbrowser.open(url)
        return process.wait()
    except KeyboardInterrupt:
        print('\nMenghentikan server ...')
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Jalankan Kantor Sobis lokal')
    parser.add_argument('--no-browser', action='store_true', help='Jalankan server tanpa membuka browser')
    args = parser.parse_args()
    raise SystemExit(run(open_browser=not args.no_browser))
