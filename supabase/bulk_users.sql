-- Buat banyak akun sekaligus. Jalankan di Supabase -> SQL Editor, SETELAH schema.sql.
--
-- 1. Ganti v_pw dengan kata sandi bersama (minimal 8 karakter).
-- 2. Ubah daftar di bawah: email, nama tampilan, role (staff|supervisor|manager|developer), departemen
--    (harus persis seperti di tabel departments, misalnya 'ME', 'FnB Service').
-- 3. Run. Email yang sudah ada dilewati. Salah satu baris gagal => seluruhnya dibatalkan (tidak ada akun setengah jadi).
-- 4. Setelah semua orang masuk, JANGAN simpan kata sandi di file ini: hapus/ganti isinya sebelum disimpan atau dikirim.
--
-- Catatan keamanan: kata sandi yang sama untuk semua orang berarti satu orang yang tahu bisa masuk sebagai siapa saja.
-- Minta tiap orang menggantinya (lupa kata sandi -> email, atau Anda atur ulang per akun di dashboard).

do $$
declare
  v_pw  text := 'GANTI-DENGAN-SANDI';
  r     record;
  v_id  uuid;
  v_dept int;
begin
  if v_pw like 'GANTI%' or length(v_pw) < 8 then
    raise exception 'Isi v_pw dengan kata sandi (minimal 8 karakter) dulu';
  end if;

  for r in select * from (values
    -- Manager (lihat semua departemen; departemen di sini hanya label, ubah nanti lewat tab Pengguna)
    ('manager1@contoh.com', 'Manager 1', 'manager', 'Operasional'),
    ('manager2@contoh.com', 'Manager 2', 'manager', 'Operasional'),
    ('manager3@contoh.com', 'Manager 3', 'manager', 'Operasional'),
    ('manager4@contoh.com', 'Manager 4', 'manager', 'Operasional'),
    ('manager5@contoh.com', 'Manager 5', 'manager', 'Operasional'),
    ('manager6@contoh.com', 'Manager 6', 'manager', 'Operasional'),
    ('manager7@contoh.com', 'Manager 7', 'manager', 'Operasional'),
    -- Akun departemen (dipakai SPV/Admin departemen itu; hanya melihat departemennya sendiri)
    ('finance@contoh.com',     'Finance',     'supervisor', 'Finance/Purchasing'),
    ('hrd@contoh.com',         'HRD',         'supervisor', 'HRD'),
    ('it@contoh.com',          'IT',          'supervisor', 'IT'),
    ('operasional@contoh.com', 'Operasional', 'supervisor', 'Operasional'),
    ('marcomm@contoh.com',     'Marcomm',     'supervisor', 'Marcomm'),
    ('sales@contoh.com',       'Sales',       'supervisor', 'Sales'),
    ('fbs@contoh.com',         'FBS',         'supervisor', 'FnB Service'),
    ('fbp@contoh.com',         'FBP',         'supervisor', 'FnB Product'),
    ('hk@contoh.com',          'HK',          'supervisor', 'HK'),
    ('fo@contoh.com',          'FO',          'supervisor', 'FO'),
    ('me@contoh.com',          'ME',          'supervisor', 'ME'),
    ('sipil@contoh.com',       'Sipil',       'supervisor', 'Sipil'),
    ('garden@contoh.com',      'Garden',      'supervisor', 'Garden')
  ) as t(email, full_name, role, dept)
  loop
    if exists (select 1 from auth.users where email = r.email) then
      raise notice 'dilewati (sudah ada): %', r.email;
      continue;
    end if;

    select id into v_dept from public.departments where name = r.dept;
    if v_dept is null then raise exception 'Departemen tidak ada: % (untuk %)', r.dept, r.email; end if;

    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', r.email,
            crypt(v_pw, gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
            jsonb_build_object('sub', v_id::text, 'email', r.email, 'email_verified', true),
            'email', now(), now(), now());

    insert into public.profiles (id, full_name, role, department_id)
    values (v_id, r.full_name, r.role::app_role, v_dept);
  end loop;
end $$;

-- Cek hasilnya
select u.email, p.full_name, p.role, d.name as departemen
from public.profiles p
join auth.users u on u.id = p.id
join public.departments d on d.id = p.department_id
order by p.role, u.email;
