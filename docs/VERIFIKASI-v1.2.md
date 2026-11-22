# Verifikasi versi publik 1.2.0

Tanggal: 23 November 2026. Pengujian memakai data contoh dan simulasi. Tidak memakai database pelanggan atau kunci API asli.

## Otomatis

- 44 tes Python: kontrak konsol, launcher, profil usaha, validasi, tiga kanal promosi, revisi, persetujuan, ekspor, penyimpanan ulang, konflik versi, dan penguncian pembuatan bersamaan.
- 25 pemeriksaan integrasi konsol pada database sementara.
- 33 tes JavaScript konsol dan kantor virtual. Normalisasi baris dalam harness tes membuatnya berjalan pada checkout Windows.
- Protokol Live pada alur usaha memakai transport sintetis: persetujuan biaya wajib, ledger pemakaian terisi, kegagalan tidak membocorkan pesan penyedia atau menyimpan hasil parsial.

## Browser

- Isi dan simpan profil usaha contoh, lalu buat promosi WhatsApp dari fakta yang diberikan.
- Edit naskah, simpan versi 2, dan setujui. Tombol unduh aktif setelah persetujuan.
- Unduh berkas `.txt` dan periksa isi naskah serta label asal simulasi.
- Muat ulang halaman: profil, riwayat, versi 2, dan persetujuan tetap tersedia. Promosi terakhir otomatis dibuka.
- Buka pengaturan konsol dan kembali ke beranda usaha; versi konsol menunjukkan 1.2.0.
- Tampilan lebar dan HP 390 × 844 diperiksa. Lebar dokumen pada HP tidak melampaui viewport. Tidak ditemukan error konsol browser pada akhir alur.
- Bukti tampilan: [desktop](tampilan-umkm-v1.2.jpg) dan [HP](tampilan-umkm-hp-v1.2.jpg). Semua informasi usaha pada gambar merupakan data contoh.

## Batas verifikasi

Belum mengirim permintaan AI berbayar sungguhan. Belum menguji pemasangan pada komputer Windows lain yang belum memiliki Python. Lingkungan virtual proyek disiapkan menggunakan paket yang sudah tersedia dalam cache. Aplikasi tidak diuji untuk publikasi server internet dan tetap ditujukan untuk satu usaha pada komputer pribadi.
