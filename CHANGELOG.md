# Perubahan Kantor Sobis

## 1.2.0 — Ruang usaha untuk pemula UMKM

- Beranda baru: profil satu usaha, formulir promosi, tinjau hasil, dan riwayat lokal tanpa pendaftaran.
- Tiga format awal: pesan WhatsApp, caption Instagram, dan deskripsi toko online.
- Contoh deterministik tanpa API; mode AI memakai OpenRouter dengan persetujuan biaya per pembuatan promosi.
- Revisi manual disimpan sebagai versi baru. Versi terbaru harus disetujui sebelum ekspor; revisi membatalkan persetujuan sebelumnya.
- Profil dan arahan disimpan bersama tiap promosi agar perubahan profil tidak mengubah pekerjaan lama.
- Penolakan revisi dari tab yang tertinggal, penyamaran kesalahan penyedia, dan pencatatan biaya termasuk panggilan gagal.
- Konsol agen tetap tersedia di `/kantor`; tombol kembali menuju beranda usaha.
- `install.bat` untuk pemasangan pertama dan `run.bat` untuk pemakaian berikutnya.
- Daftar model diganti dengan snapshot model yang diperiksa melalui endpoint resmi OpenRouter; biaya tetap estimasi manual bila penyedia tidak melaporkannya.
- Tes baru untuk alur UMKM; tes konsol menormalkan format baris Windows sebelum memuat pengontrol.

## 1.1.0 — Konsol profesional lokal

- Tujuh halaman operasional, navigasi responsif, branding SolusiBisnis.com, dialog aksesibel, dan draf yang bertahan saat berpindah halaman.
- Kantor isometrik baru dengan zona berhalaman, profil agen, dan rendering berdasarkan keadaan nyata.
- Papan tugas lengkap dengan hasil dan kegagalan yang tidak disamarkan sebagai selesai.
- Tepat satu koordinator aktif, izin tool di server, validasi payload, dan perlindungan perubahan saat antrean sibuk.
- Memori menampilkan penolakan/penggantian; persetujuan key baru menggantikan fakta aktif lama secara atomik.
- Ledger pemakaian terpisah dari chat: tool-only, simulasi/live/data lama, biaya tercatat/estimasi/belum diketahui.
- Aktivasi Live memerlukan pilihan dan konfirmasi pengguna. Kesalahan provider disanitasi.
- Migrasi tambahan versi skema 3, recovery pekerjaan terputus, serta launcher menunggu kesehatan server sebelum membuka browser.
- Tidak ada dependensi/aset baru yang diunduh, tidak ada perubahan domain/VPS, dan belum ada klaim siap produksi publik.
