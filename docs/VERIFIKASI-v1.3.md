# Verifikasi versi publik 1.3.0 (Rekan Kantor)

Tanggal: 28 November 2026. Pengujian memakai data contoh dan mode simulasi. Tidak memakai database pelanggan atau kunci API asli.

## Perubahan pada versi ini

- Aplikasi berganti nama menjadi **Rekan Kantor** (sebelumnya Kantor Sobis). Nama koordinator di dalam aplikasi tetap **Sobis**, dan mereknya tetap **SolusiBisnis.com**.
- Beranda diperbaiki: pada layar lebar urutan langkah kini 01 → 02 → 03 (isian berdampingan di baris pertama, hasil di baris kedua). Sebelumnya kartu 03 tampil di samping kartu 01 sehingga nomor terbaca melompat.

## Otomatis

- 44 tes Python: kontrak konsol, launcher, profil usaha, validasi, tiga kanal promosi, revisi, persetujuan, ekspor, penyimpanan ulang, konflik versi, penguncian pembuatan bersamaan, dan pemeriksaan versi 1.3.0.
- 25 pemeriksaan integrasi konsol pada database sementara.
- 33 tes JavaScript konsol dan kantor virtual.
- Seluruh pengujian dijalankan dengan mode simulasi; biaya Rp 0.

## Browser dan tampilan

- Server dijalankan dengan database sementara, lalu data contoh disemai lewat API sendiri: profil usaha "Dapur Bu Rina", satu draf disetujui, satu draf menunggu tinjauan, satu pesan dan satu tugas selesai.
- Halaman diperiksa pada lebar 1440 px dan 390 px. Nama "Rekan Kantor" tampil pada kop, judul jendela, dan catatan kaki.
- Tidak ada elemen meluber pada lebar 390 px; pada lebar 1440 px urutan kartu 01, 02, 03 berurutan.
- Bukti tampilan: [beranda](tampilan-usaha-v1.3.jpg), [beranda ponsel](tampilan-umkm-hp-v1.3.jpg), [ruang kerja](tampilan-ruang-kerja-v1.3.jpg), [tim agen](tampilan-tim-agen-v1.3.jpg), dan [papan tugas](tampilan-papan-tugas-v1.3.jpg). Semua informasi usaha pada gambar adalah data contoh.

## Belum diuji

- Sambungan AI berbayar (OpenRouter) masih belum diuji pada versi ini; seluruh uji memakai simulasi.
- Pemasangan di komputer lain dengan Python baru dipasang belum diulang pada versi ini.
