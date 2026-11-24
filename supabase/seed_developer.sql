-- Akun Developer pertama. Jalankan SEKALI di SQL Editor setelah schema.sql.
--
-- 1. Dashboard Supabase -> Authentication -> Users -> Add user
--    (isi email dan kata sandi, centang "Auto Confirm User").
-- 2. Ganti email dan nama di bawah, lalu jalankan.
--
-- Setelah ini, akun lain dibuat lewat layar "Pengguna" di aplikasi (undangan email).

insert into profiles (id, full_name, role, department_id)
select u.id, 'Nama Developer', 'developer', d.id
from auth.users u, departments d
where u.email = 'email-kamu@contoh.com'
  and d.name = 'IT'
on conflict (id) do nothing;

-- Harus menghasilkan 1 baris:
select p.full_name, p.role, p.is_active from profiles p
join auth.users u on u.id = p.id
where u.email = 'email-kamu@contoh.com';
