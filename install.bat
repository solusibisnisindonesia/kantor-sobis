@echo off
setlocal
cd /d "%~dp0"
title Pasang Rekan Kantor
echo Rekan Kantor - persiapan pertama di Windows
echo Memerlukan Python 3.12 atau lebih baru dan koneksi internet.
echo Paket aplikasi akan diunduh dari Python Package Index.
echo Setelah selesai, gunakan run.bat untuk membuka aplikasi.
echo.
if exist ".venv\Scripts\python.exe" goto packages
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)" >nul 2>nul
if errorlevel 1 goto try_python
py -3 -m venv .venv
if errorlevel 1 goto failed
goto packages
:try_python
python -c "import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)" >nul 2>nul
if errorlevel 1 goto missing
python -m venv .venv
if errorlevel 1 goto failed
:packages
".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)"
if errorlevel 1 goto missing
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
echo.
echo Selesai. Klik dua kali run.bat untuk mulai.
pause
exit /b 0
:missing
echo Python 3.12 atau lebih baru belum ditemukan.
echo Pasang Python dari https://www.python.org/downloads/windows/
echo Pilih Add Python to PATH, lalu jalankan install.bat lagi.
pause
exit /b 1
:failed
echo Penyiapan belum selesai. Periksa pesan di atas dan koneksi internet.
echo Anda bisa menjalankan install.bat lagi.
pause
exit /b 1
