@echo off
setlocal
cd /d "%~dp0"
title Kantor Sobis - SolusiBisnis.com

if not exist ".venv\Scripts\python.exe" goto missing
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, httpx, dotenv" >nul 2>nul
if errorlevel 1 goto missing

".venv\Scripts\python.exe" launcher.py
if errorlevel 1 pause
exit /b

:missing
echo Lingkungan aplikasi belum lengkap. Tidak ada paket yang diunduh otomatis.
echo Jalankan install.bat satu kali untuk menyiapkan aplikasi.
echo Panduan penyiapan ada di README.md.
pause
exit /b 1
