-- CineVee · Etapa 5 — Perfil: identidade (username/bio/avatar) + Storage avatars.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. adiciona public.profiles.username (nullable, lowercase, 3–24,
--      a-z 0-9 _) com UNIQUE parcial (NULLs liberados, existentes intactos);
--   2. adiciona public.profiles.bio (nullable, ≤160 chars, texto puro);
--   3. adiciona public.profiles.avatar_path (nullable, só o caminho no bucket);
--   4. cria o bucket público `avatars` (leitura pública, escrita por policies);
--   5. policies em storage.objects: cada usuário autenticado pode INSERT /
--      UPDATE / DELETE SOMENTE dentro da própria pasta avatars/{user_id}/.
--      Sem escrita pública, sem service_role no app.
--
-- O que esta migration NÃO faz:
--   - não altera migrations antigas;
--   - não altera policies de profiles/watchlist;
--   - não gera username a partir de e-mail;
--   - não processa imagem (validação tipo+tamanho é server-side no app).

-- ------------------------------------------------------- 1. Novas colunas
alter table public.profiles
  add column if not exists username text,
  add column if not exists bio text,
  add column if not exists avatar_path text;

-- Normaliza legados acidentais (se algum valor antigo existir fora do padrão,
-- a aplicação sempre grava lowercase válido; aqui só garantimos o CHECK).
do $$
begin
  if exists (
    select 1 from public.profiles
    where username is not null
      and username <> lower(username)
  ) then
    update public.profiles set username = lower(username)
    where username is not null;
  end if;
end;
$$;

-- ------------------------------------------------------- 2. Constraints
-- username: NULL permitido; quando preenchido, 3–24 [a-z0-9_].
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_username_allowed'
  ) then
    alter table public.profiles
      add constraint profiles_username_allowed
      check (username is null or username ~ '^[a-z0-9_]{3,24}$');
  end if;
end;
$$;

-- bio: NULL permitida; vazia vira NULL no app; no máximo 160 caracteres.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_bio_length'
  ) then
    alter table public.profiles
      add constraint profiles_bio_length
      check (bio is null or char_length(bio) <= 160);
  end if;
end;
$$;

-- username único (NULLs não conflitam entre si).
create unique index if not exists profiles_username_unique
  on public.profiles (username);

-- ------------------------------------------------------- 3. Bucket avatars
-- Bucket público para LEITURA do avatar; escrita controlada por policies.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- ------------------------------------------------------- 4. Policies Storage
-- Ownership = primeiro segmento do path == auth.uid()::text.
-- Estrutura: avatars/{user_id}/{arquivo}.ext

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );

-- Leitura: bucket público (sem policy de escrita pública, sem service_role).
