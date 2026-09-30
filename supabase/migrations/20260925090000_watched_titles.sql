-- CineVee · Etapa 6 — Assistidos / Já assisti (public.watched_titles).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.watched_titles (N linhas por usuário, ON DELETE CASCADE);
--   2. identidade única (user_id, media_type, tmdb_id) — sem duplicatas;
--   3. CHECKs: media_type em ('movie','tv'), tmdb_id > 0;
--   4. ativa RLS + políticas: cada usuário autenticado SELECT/INSERT/DELETE
--      SOMENTE as próprias linhas (auth.uid() = user_id). Sem UPDATE
--      (marcar de novo é idempotente via INSERT + SELECT no conflito),
--      sem política pública, sem service_role no app;
--   5. índice para listagem "mais recentes primeiro" (watched_at DESC).
--
-- Decisão documentada: title/poster_path/release_year são SNAPSHOTS para
-- renderização eficiente; o TMDB continua sendo a fonte factual
-- (o backend sempre valida o título no TMDB antes de salvar e nunca
-- confia nesses campos vindos do browser).
-- Sem coluna de avaliação nesta etapa (Etapa 7 fará essa modelagem).

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.watched_titles (
  user_id uuid not null references auth.users (id) on delete cascade,
  tmdb_id bigint not null,
  media_type text not null,
  title text not null,
  poster_path text,
  release_year integer,
  watched_at timestamptz not null default now(),

  constraint watched_titles_unique_item unique (user_id, media_type, tmdb_id),
  constraint watched_titles_media_type_allowed
    check (media_type in ('movie', 'tv')),
  constraint watched_titles_tmdb_id_positive
    check (tmdb_id > 0)
);

-- ------------------------------------------------------------- 2. RLS
alter table public.watched_titles enable row level security;

drop policy if exists "watched_select_own" on public.watched_titles;
create policy "watched_select_own"
  on public.watched_titles
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "watched_insert_own" on public.watched_titles;
create policy "watched_insert_own"
  on public.watched_titles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "watched_delete_own" on public.watched_titles;
create policy "watched_delete_own"
  on public.watched_titles
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Sem política de UPDATE: re-marcar usa INSERT idempotente (conflito 23505
-- → SELECT da linha existente), mesmo padrão validado da watchlist.
-- Sem acesso anônimo: só o dono autenticado.

-- --------------------------------------------- 3. Índice (recentes primeiro)
create index if not exists watched_titles_user_recent
  on public.watched_titles (user_id, watched_at desc);
