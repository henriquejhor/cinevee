-- CineVee · Etapa 4 — Minha Lista (public.watchlist).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.watchlist (N linhas por usuário, ON DELETE CASCADE);
--   2. identidade única (user_id, media_type, tmdb_id) — sem duplicatas;
--   3. CHECKs: media_type em ('movie','tv'), tmdb_id > 0;
--   4. ativa RLS + políticas: cada usuário autenticado SELECT/INSERT/DELETE
--      SOMENTE as próprias linhas (auth.uid() = user_id). Sem UPDATE
--      (snapshots só mudam via re-adicionar), sem política pública,
--      sem service_role no app;
--   5. índice para listagem "mais recentes primeiro" (created_at DESC).
--
-- Decisão documentada: title/poster_path/release_year são SNAPSHOTS para
-- renderização eficiente da lista; o TMDB continua sendo a fonte factual
-- (o backend sempre valida o título no TMDB antes de salvar e nunca
-- confia nesses campos vindos do browser).

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.watchlist (
  user_id uuid not null references auth.users (id) on delete cascade,
  tmdb_id bigint not null,
  media_type text not null,
  title text not null,
  poster_path text,
  release_year integer,
  created_at timestamptz not null default now(),

  constraint watchlist_unique_item unique (user_id, media_type, tmdb_id),
  constraint watchlist_media_type_allowed
    check (media_type in ('movie', 'tv')),
  constraint watchlist_tmdb_id_positive
    check (tmdb_id > 0)
);

-- ------------------------------------------------------------- 2. RLS
alter table public.watchlist enable row level security;

drop policy if exists "watchlist_select_own" on public.watchlist;
create policy "watchlist_select_own"
  on public.watchlist
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "watchlist_insert_own" on public.watchlist;
create policy "watchlist_insert_own"
  on public.watchlist
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "watchlist_delete_own" on public.watchlist;
create policy "watchlist_delete_own"
  on public.watchlist
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Sem política de UPDATE: snapshot só muda re-adicionando (DELETE + POST).
-- Sem acesso anônimo: só o dono autenticado.

-- --------------------------------------------- 3. Índice (recentes primeiro)
create index if not exists watchlist_user_recent
  on public.watchlist (user_id, created_at desc);
