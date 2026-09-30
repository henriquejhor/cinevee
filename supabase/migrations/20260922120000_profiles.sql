-- CineVee · Etapa 2 — profiles + RLS + preferências permanentes.
--
-- COMO APLICAR (sem CLI configurado neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.profiles (1:1 com auth.users, ON DELETE CASCADE);
--   2. CHECK constraints: só chaves semânticas conhecidas nos arrays
--      (labels pt-BR e IDs TMDB nunca entram no profile);
--   3. ativa RLS + políticas: cada usuário autenticado lê/insere/edita
--      SOMENTE a própria linha (auth.uid() = id). Sem acesso cruzado,
--      sem política pública, sem service_role no app;
--   4. trigger: todo signup cria o profile automaticamente, herdando
--      display_name de raw_user_meta_data quando existir;
--   5. backfill: usuários criados antes desta migration ganham profile
--      (sem duplicar — ON CONFLICT DO NOTHING);
--   6. trigger de updated_at.

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  excluded_genres text[] not null default '{}',
  streaming_providers text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Só chaves semânticas do catálogo central (src/types/discovery.ts).
  constraint profiles_excluded_genres_allowed
    check (excluded_genres <@ array[
      'action', 'adventure', 'animation', 'comedy', 'crime',
      'documentary', 'drama', 'fantasy', 'horror', 'mystery',
      'romance', 'science_fiction', 'thriller'
    ]),
  -- Só chaves internas de streaming (src/types/content.ts).
  constraint profiles_streaming_providers_allowed
    check (streaming_providers <@ array['netflix', 'prime', 'disney', 'max'])
);

-- ------------------------------------------------------------- 2. RLS
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Sem política de DELETE: profile morre com o usuário (CASCADE).
-- Sem acesso a service_role/anônimo: só o dono autenticado.

-- --------------------------------------------- 3. Profile automático
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_name text;
begin
  meta_name := nullif(trim(both from coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');

  insert into public.profiles (id, display_name)
  values (new.id, meta_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- --------------------------------------- 4. Backfill (usuários antigos)
insert into public.profiles (id, display_name)
select
  u.id,
  nullif(trim(both from coalesce(u.raw_user_meta_data ->> 'display_name', '')), '')
from auth.users as u
left join public.profiles as p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- ------------------------------------------------------ 5. updated_at
create or replace function public.handle_profile_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_profile_updated_at on public.profiles;
create trigger set_profile_updated_at
  before update on public.profiles
  for each row
  execute function public.handle_profile_updated_at();
