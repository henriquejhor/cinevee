-- CineVee · Etapa 13 — Sobre: favoritos + recomendações (public.profile_picks).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.profile_picks (seleções manuais do usuário: favoritos
--      e recomendações pessoais, com snapshot TMDB + nota + posição);
--   2. unicidade (user_id, media_type, tmdb_id, kind): o mesmo título pode
--      ser favorito E recomendação, mas nunca duplicado na mesma seção;
--   3. CHECKs: media_type em ('movie','tv'), kind em
--      ('favorite','recommendation'), tmdb_id > 0, position >= 0,
--      regra de nota por kind (favorite → note NULL; recommendation →
--      texto 1–500 chars após trim);
--   4. ativa RLS + políticas: cada usuário autenticado SELECT/INSERT/
--      UPDATE/DELETE SOMENTE as próprias linhas (auth.uid() = user_id).
--      Sem política pública, sem service_role no app;
--   5. trigger de updated_at (mesmo padrão de profiles/ratings);
--   6. índice para leitura ordenada por seção (user_id, kind, position).
--
-- O que esta migration NÃO faz:
--   - não impõe os limites 12/6 no banco (enforcement server-side no
--     service/API, com erro amigável — sem trigger complexo);
--   - não cria FK para watched_titles (picks são independentes: não
--     exigem watched, rating ou review);
--   - nada público: perfil público será uma etapa separada.

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.profile_picks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tmdb_id bigint not null,
  media_type text not null,
  kind text not null,
  title text not null,
  poster_path text,
  release_year integer,
  note text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profile_picks_unique_item
    unique (user_id, media_type, tmdb_id, kind),
  constraint profile_picks_media_type_allowed
    check (media_type in ('movie', 'tv')),
  constraint profile_picks_kind_allowed
    check (kind in ('favorite', 'recommendation')),
  constraint profile_picks_tmdb_id_positive
    check (tmdb_id > 0),
  constraint profile_picks_position_allowed
    check (position >= 0),
  -- Favorito nunca tem nota; recomendação exige texto 1–500 (após trim).
  -- O app sempre grava a nota já com trim; o btrim aqui fecha a porta
  -- para escrita direta só-espaços fora do app.
  constraint profile_picks_note_by_kind
    check (
      (kind = 'favorite' and note is null)
      or (
        kind = 'recommendation'
        and note is not null
        and char_length(note) <= 500
        and char_length(btrim(note)) >= 1
      )
    )
);

-- ------------------------------------------------------------- 2. RLS
alter table public.profile_picks enable row level security;

drop policy if exists "profile_picks_select_own" on public.profile_picks;
create policy "profile_picks_select_own"
  on public.profile_picks
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "profile_picks_insert_own" on public.profile_picks;
create policy "profile_picks_insert_own"
  on public.profile_picks
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "profile_picks_update_own" on public.profile_picks;
create policy "profile_picks_update_own"
  on public.profile_picks
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "profile_picks_delete_own" on public.profile_picks;
create policy "profile_picks_delete_own"
  on public.profile_picks
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Sem acesso anônimo: só o dono autenticado. Sem política pública.

-- ------------------------------------------------------ 3. updated_at
create or replace function public.handle_profile_pick_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_profile_pick_updated_at on public.profile_picks;
create trigger set_profile_pick_updated_at
  before update on public.profile_picks
  for each row
  execute function public.handle_profile_pick_updated_at();

-- --------------------------------------------- 4. Índice (seção ordenada)
create index if not exists profile_picks_user_kind_position
  on public.profile_picks (user_id, kind, position);
