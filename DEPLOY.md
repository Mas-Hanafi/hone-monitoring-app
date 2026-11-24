# Panduan Deploy

Urutan ini sengaja begini: frontend dulu (supaya alamat app diketahui), baru fungsi yang membutuhkan alamat itu.
Semua perintah dijalankan dari folder proyek. Waktu total kira-kira 1–2 jam, sebagian besar mengisi pengaturan di dashboard.

## 0. Prasyarat

- Node.js 22 atau lebih baru, akun GitHub, akun Supabase, akun Cloudflare, akun Google (untuk Sheet).
- Cek kode sehat sebelum mulai:

```bash
npm install
npm test
```

`npm test` menjalankan 597 pengecekan (14 file) (skema di Postgres lokal, fungsi undangan, sinkron Sheet, hapus foto, hitungan dashboard, CSV dan laporan, antrean offline, notifikasi dan push). Semua harus lulus.
Ini tidak menggantikan uji di Supabase asli (langkah 9).

## 1. Buat proyek Supabase

1. supabase.com → New project. **Region: Singapore** (paling dekat ke Indonesia). Simpan kata sandi database.
2. Pakai paket **Pro sebelum data asli masuk**. Paket gratis tidak punya backup harian otomatis, sedangkan log aktivitas adalah inti app ini. Cek halaman harga Supabase untuk detail yang berlaku sekarang.
3. Catat tiga nilai dari Project Settings → API:
   - **Project URL** → dipakai sebagai `VITE_SUPABASE_URL`
   - **publishable / anon key** → `VITE_SUPABASE_ANON_KEY`
   - **Project ref** (potongan depan URL, `xxxx` di `https://xxxx.supabase.co`)
4. **Jangan pernah** menaruh *service role key* di frontend, di Git, atau di chat.

## 2. Pasang skema

1. Dashboard → SQL Editor → New query → tempel seluruh isi [schema.sql](schema.sql) → Run.
2. Dashboard → Database → Extensions: aktifkan **pg_cron** dan **pg_net** (dipakai di langkah 7). Extension **vault** biasanya sudah aktif.
3. Cek hasilnya (harus 13 baris departemen dan bucket `task-photos` privat):

```sql
select count(*) from departments;
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'task-photos';
```

`schema.sql` hanya untuk proyek **kosong**; menjalankannya dua kali error karena tipe dan tabel sudah ada.
Untuk perubahan skema setelah ini, tulis file migrasi terpisah (jangan edit lalu jalankan ulang).

## 3. Deploy frontend (Cloudflare)

1. Taruh kode di GitHub:

```bash
git init
git add .
git commit -m "feat: aplikasi monitoring tugas"
```

Buat repository **private** di GitHub, lalu `git remote add origin ...` dan `git push -u origin main`.
`.gitignore` sudah mengecualikan `.env*`, `node_modules`, `dist`, dan file kunci Google.

2. Cloudflare dashboard → Workers & Pages → buat proyek dari repository GitHub tadi. Pengaturan build:
   - Build command: `npm run build`
   - Output directory: `dist`
   - Variabel lingkungan: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, dan `NODE_VERSION` = `22`
3. Setelah build selesai, catat alamat app (misalnya `https://tugas.pages.dev` atau domain sendiri). Ini disebut **APP_URL** di bawah.

Coba lokal lebih dulu kalau mau: salin `.env.example` ke `.env.local`, isi, lalu `npm run dev`.

## 4. Pengaturan Auth di Supabase

Nama menu bisa sedikit berbeda antar versi dashboard; yang penting hasilnya:

| Pengaturan | Nilai |
|---|---|
| Pendaftaran mandiri (sign up) | **Nonaktif.** Akun hanya dibuat Developer lewat undangan |
| Site URL | APP_URL |
| Redirect URLs | APP_URL (tanpa ini tautan undangan dan reset sandi ditolak) |
| Panjang kata sandi minimum | 8 atau lebih (app juga meminta minimal 8) |
| SMTP | **Pasang SMTP sendiri** (Authentication → SMTP). SMTP bawaan sangat dibatasi per jam; mengundang puluhan orang akan gagal |

Undangan tetap bisa dikirim walau pendaftaran mandiri nonaktif.

## 5. Akun Developer pertama

1. Dashboard → Authentication → Users → Add user: isi email dan kata sandi, centang **Auto Confirm User**.
2. Buka [supabase/seed_developer.sql](supabase/seed_developer.sql), ganti email dan nama, jalankan di SQL Editor.
3. Hasil terakhir skrip harus 1 baris dengan role `developer`.
4. Buka APP_URL, masuk dengan akun itu. Tab **Pengguna** harus muncul.

## 6. Deploy Edge Function

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
```

Buat satu string acak sebagai `CRON_SECRET` (dipakai pemicu terjadwal; simpan di password manager):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Atur secret. `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` sudah disuntik otomatis, tidak perlu diatur.

```bash
npx supabase secrets set CRON_SECRET=<hasil-acak> APP_URL=<APP_URL>
```

Deploy ketiganya:

```bash
npx supabase functions deploy invite-user
npx supabase functions deploy cleanup-photos --no-verify-jwt
npx supabase functions deploy sync-sheet --no-verify-jwt
npx supabase functions deploy send-push --no-verify-jwt
```

### Notifikasi HP (web push)

Notifikasi di dalam app (lonceng) langsung jalan. Push ke layar HP butuh sepasang kunci VAPID:

```bash
npx web-push generate-vapid-keys
```

- **Kunci publik** → variabel build frontend `VITE_VAPID_PUBLIC_KEY` (Cloudflare, lalu deploy ulang frontend).
- **Kunci privat** → hanya secret Supabase, jangan dikirim ke siapa pun:

```bash
npx supabase secrets set VAPID_PUBLIC_KEY=<publik> VAPID_PRIVATE_KEY=<privat> VAPID_SUBJECT=mailto:<emailmu>
```

Jangan mengganti kunci ini setelah staff mengaktifkan push; langganan lama jadi tidak berlaku dan mereka harus mengaktifkan ulang.
Di iPhone, push hanya bekerja untuk app yang sudah dipasang ke Layar Utama (iOS 16.4 ke atas).

`send-push` dipanggil tiap menit oleh jadwal (langkah 7). `invite-user` memverifikasi JWT pemanggil dan hanya melayani Developer. Dua lainnya tanpa JWT karena dipanggil terjadwal; keduanya dijaga header `x-cron-secret`.

## 7. Jadwal otomatis (pg_cron)

1. Buka [supabase/cron.sql](supabase/cron.sql). Ganti `<PROJECT_REF>` (dua tempat) dan `<CRON_SECRET>` (satu tempat, sama persis dengan langkah 6). **Jangan commit file itu dengan secret terisi**; setelah dijalankan, kembalikan ke placeholder.
2. Jalankan seluruh isinya di SQL Editor. Baris `vault.create_secret` hanya boleh dijalankan **sekali** (nama secret harus unik).
3. Uji tanpa efek apa pun (hanya menghitung):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/cleanup-photos?dry_run=1" -H "x-cron-secret: <CRON_SECRET>"
```

Hasil yang benar: JSON `{"dryRun":true,"expired":0,"orphans":0,"orphansSkipped":false}`. Jawaban `unauthorized` berarti secret tidak cocok.

4. Cek pengingat dan push (setelah blok `daily-reminders` dan `send-push` di cron.sql ikut dijalankan):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/send-push?dry_run=1" -H "x-cron-secret: <CRON_SECRET>"
```

Hasil yang benar: `{"dryRun":true,"waiting":0}` (angka sesuai notifikasi yang belum didorong).

5. Pantau jalannya jadwal:

```sql
select jobname, status, start_time, return_message
from cron.job_run_details order by start_time desc limit 10;
```

## 8. Sinkron ke Google Sheet

1. Google Cloud Console: buat proyek → aktifkan **Google Sheets API** → IAM → Service Accounts → buat → Keys → Add key (JSON). Simpan file itu di luar folder proyek.
2. Buat spreadsheet **baru** (jangan pakai sheet lama, kolom A–N akan ditimpa). Bagikan ke email service account (`...iam.gserviceaccount.com`) sebagai **Editor**. Catat ID sheet (bagian di antara `/d/` dan `/edit` pada URL).
3. Ubah kunci JSON menjadi base64 satu baris:

```bash
base64 -w0 kunci.json
```

(PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("kunci.json"))`)

4. Atur secret, lalu **hapus file kunci**:

```bash
npx supabase secrets set SHEET_ID=<id-sheet> GOOGLE_SERVICE_ACCOUNT_JSON=<hasil-base64>
```

`SHEET_TAB` opsional (default `Tugas`).

5. Uji: `?dry_run=1` pada `sync-sheet` (sama seperti curl di atas) harus mengembalikan `"queued"` sesuai jumlah tugas yang belum tersinkron. Buat satu tugas di app, tunggu sampai 2 menit, baris harus muncul di Sheet.

Sheet adalah **salinan baca-saja**. Edit manual di Sheet ditimpa sinkron berikutnya. Berisi data kinerja karyawan: bagikan hanya ke orang yang berhak.

## 9. Uji asap di lingkungan asli

Sebagian sudah diuji otomatis di Supabase asli (lihat bagian 12). Yang di bawah ini menguji alur lengkap lewat app dan perangkat. Buat 4 akun uji lewat tab Pengguna (Staff di departemen A, SPV di A, Staff di departemen B, Manager), lalu cek:

| Cek | Hasil yang benar |
|---|---|
| Undangan sampai ke email, tautan membuka layar "Atur kata sandi" | Ya |
| Staff A hanya melihat tugasnya sendiri | Ya |
| SPV A tidak melihat tugas departemen B | Ya |
| SPV membuat tugas untuk Staff B | Ditolak (pesan "hanya… departemennya") |
| Staff mengubah status tanpa foto | Ditolak |
| Staff mengubah status dengan foto | Berhasil; foto muncul di Storage bucket `task-photos/<id-tugas>/` |
| Staff mengajukan Selesai, SPV menilai Reject dengan catatan | Tugas kembali ke Dikerjakan |
| Manager membuka tab Ringkasan | Enam kotak angka tampil, plus daftar "Perlu perhatian" (terlambat/macet) |
| Tugas baru muncul di Google Sheet | Dalam ±2 menit |
| Akun uji dinonaktifkan dari tab Pengguna | Akun itu langsung tidak melihat data apa pun |
| **Offline:** buka app sekali dengan sinyal, matikan sinyal (mode pesawat), buka lagi | App terbuka, daftar tugas tampil dengan catatan "Offline: data terakhir dimuat…" |
| **Offline:** dalam mode pesawat, laporkan progress dengan foto | Sheet tertutup, kartu bertanda "Menunggu terkirim", banner menampilkan jumlah update menunggu |
| **Notifikasi:** SPV membuat tugas untuk Staff A | Lonceng Staff A bertambah 1 (maks ±1 menit); tugas dikerjakan Staff A lalu diajukan Selesai → SPV dan Manager mendapat "Menunggu penilaian" |
| **Push HP:** Staff A buka lonceng → Aktifkan notifikasi HP → izinkan; tutup app; SPV membuat tugas baru | Notifikasi muncul di layar HP dalam ±1 menit; mengetuknya membuka app |
| **Push HP:** Staff A keluar akun, SPV membuat tugas untuk Staff A | Tidak ada push ke HP itu |
| **Offline:** nyalakan sinyal lagi | Dalam ±30 detik banner hilang, event dan foto muncul di server, tidak ada event ganda |
| Keluar akun saat masih ada update menunggu | Muncul peringatan; update terkirim saat akun yang sama masuk lagi |

Foto: unggah dari HP sungguhan. Pastikan ukuran file kecil (±300 KB) dan kamera terbuka langsung.
Setelah selesai, nonaktifkan akun uji (jangan dihapus; menghapus merusak riwayat log).

## 10. Operasional

| Hal | Cara |
|---|---|
| Ubah masa simpan foto (default 3 hari) | `update app_settings set value = '14' where key = 'photo_retention_days';` |
| Wajibkan / longgarkan foto saat ganti status | `update app_settings set value = 'false' where key = 'photo_required_on_status_change';` |
| Karyawan keluar | Tab Pengguna → edit → nonaktifkan akun. Jangan hapus |
| Lupa kata sandi | Tombol "Lupa kata sandi" di halaman login |
| Tutup bulan (rekap beku) | Tab **Laporan** → Tutup bulan (Manager/Developer, setelah bulan berakhir; tidak bisa dibatalkan). Tidak bisa dari SQL Editor karena butuh login Manager |
| Export CSV | Tab **Laporan** → pilih Rentang tanggal (Dari–Sampai, maks 366 hari) atau Bulanan → Muat laporan → Unduh rincian atau rekap per orang. Setiap halaman yang dimuat tercatat di `export_logs` |
| Rotasi secret | `npx supabase secrets set ...` lagi, lalu perbarui secret `cron_secret` di Vault (sintaks Vault belum diuji; cek dokumentasi Supabase) |
| Cek jadwal | Query `cron.job_run_details` di langkah 7 |
| Jalankan pengingat sekarang (uji) | `select generate_reminders();` di SQL Editor (aman diulang, tidak menggandakan) |
| Notifikasi tidak muncul sebagai push | Cek `send-push?dry_run=1`; pastikan perangkat mengaktifkan push; pengguna tanpa langganan tetap menerima notifikasi di lonceng |

## 11. Masalah umum

| Gejala | Kemungkinan penyebab |
|---|---|
| Layar login: "Email atau kata sandi salah" untuk akun baru | Undangan belum dibuka / sandi belum diatur |
| Tautan undangan "kedaluwarsa" atau ditolak | Redirect URL / Site URL belum diisi (langkah 4), atau tautan sudah lebih dari masa berlaku |
| Undangan gagal 502 | Batas email SMTP bawaan; pasang SMTP sendiri |
| Setelah masuk muncul "akun belum aktif atau belum punya profil" | Profil belum dibuat atau `is_active = false` |
| `invite-user` gagal CORS di browser | `APP_URL` belum diatur atau tidak sama dengan alamat app |
| Sheet tidak terisi | Cek `cron.job_run_details`; panggil `sync-sheet?dry_run=1`; pastikan sheet dibagikan ke email service account sebagai Editor |
| `sync-sheet` 500 "baca Sheet: HTTP 403" | Sheets API belum aktif atau sheet belum dibagikan |
| Foto tidak terhapus | Cek `cleanup-photos?dry_run=1`; periksa `app_settings.photo_retention_days` |

## 12. Yang belum ada / belum teruji

- **Sudah diuji di Supabase asli (8 Nov 2026, proyek "H One Monitoring App", region Singapore):**
  - `schema.sql` terpasang tanpa error.
  - 64 pengecekan di level database dengan peran `anon` dan `authenticated` sungguhan: hak akses, RLS, policy Storage, tabel/fungsi baru tidak otomatis terbuka, append-only.
  - 46 pengecekan lewat HTTP dengan login email+sandi asli: kueri persis seperti yang dipakai UI (termasuk embed `pic:profiles!tasks_pic_id_fkey(...)`), Storage API (batas 1,5 MB, hanya jpeg/webp, signed URL, staff lain ditolak), semua RPC.
  - Keempat Edge Function ter-deploy dan menyala di Deno (termasuk `npm:web-push`); tanpa secret mereka menjawab 401.
  - `pg_cron`, `pg_net`, dan Vault tersedia dan sintaksnya benar (`cron.schedule`, `vault.create_secret`, `net.http_post` dengan `timeout_milliseconds`).
  - Data uji sudah dihapus. Dua file uji kecil masih di bucket `task-photos` (Storage tidak boleh dihapus lewat SQL); dibersihkan otomatis oleh `cleanup-photos` setelah lebih dari 1 hari.
- **Masih belum diuji:** pengiriman push sungguhan, email undangan, tulis ke Google Sheet, jadwal cron yang aktif, frontend di browser/HP, dan semua yang membutuhkan secret (CRON_SECRET, VAPID, Google, APP_URL).
- Antrean offline: logikanya diuji (24 pengecekan), tetapi penyimpanan IndexedDB, pemulihan sesi saat token kedaluwarsa tanpa sinyal, dan perilaku di iPhone belum diuji di perangkat asli. Pengiriman hanya berjalan saat app terbuka (tidak ada sinkron latar belakang).
- Notifikasi: logika database dan pengiriman diuji (±60 pengecekan), tetapi `npm:web-push` di runtime Deno Supabase, penerimaan push di HP sungguhan (terutama iPhone), dan pembukaan app dari ketukan notifikasi belum diuji. Notifikasi "beban kerja berlebih" belum ada (rumus beban belum kamu putuskan); email tidak ada.
- Belum ada: kamera dalam-app (foto diambil lewat input kamera HP, galeri masih mungkin dipilih).
- `npm:web-push` ter-load di Deno, tetapi `sendNotification` ke layanan push sungguhan belum pernah dijalankan.
- **Foto belum bisa dilihat di app.** Foto diunggah dan tersimpan (policy Storage terbukti benar), tetapi belum ada layar yang menampilkannya untuk SPV/Manager. Verifikasi foto saat ini hanya bisa lewat dashboard Supabase.
- Paket yang terpasang lebih baru dari yang biasa dipakai (Vite 8, TypeScript 7, vite-plugin-pwa 2); `npm run build` lolos, tapi periksa peringatan saat `npm run dev`.
