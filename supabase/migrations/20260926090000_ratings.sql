-- CineVee · Etapa 7 — Avaliações de assistidos (public.ratings).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.ratings (opinião do usuário, 1–5 estrelas inteiras);
--   2. identidade única (user_id, media_type, tmdb_id) — uma nota por título;
--   3. FK composta para watched_titles (user_id, media_type, tmdb_id)
--      ON DELETE CASCADE: avaliação só existe para título assistido e
--      morre junto se o título sair de Assistidos (sem rating órfão);
--   4. CHECKs: media_type em ('movie','tv'), rating entre 1 e 5;
--   5. ativa RLS + políticas: cada usuário autenticado SELECT/INSERT/
--      UPDATE/DELETE SOMENTE as próprias linhas (auth.uid() = user_id).
--      UPDATE existe de propósito (mudar a nota atualiza a mesma linha).
--      Sem política pública, sem service_role no app;
--   6. trigger de updated_at (mesmo padrão de public.profiles);
--   7. índice para listagem "avaliados recentemente" (updated_at DESC).
--
-- Decisão documentada: ratings NÃO duplica title/poster/year — os dados
-- visuais do título vêm de watched_titles via relação. Sem meia estrela.

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.ratings (
  user_id uuid not null,
  tmdb_id bigint not null,
  media_type text not null,
  rating smallint not null,
  rated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ratings_unique_item unique (user_id, media_type, tmdb_id),
  constraint ratings_watched_fk
    foreign key (user_id, media_type, tmdb_id)
    references public.watched_titles (user_id, media_type, tmdb_id)
    on delete cascade,
  constraint ratings_media_type_allowed
    check (media_type in ('movie', 'tv')),
  constraint ratings_value_allowed
    check (rating >= 1 and rating <= 5)
);

-- ------------------------------------------------------------- 2. RLS
alter table public.ratings enable row level security;

drop policy if exists "ratings_select_own" on public.ratings;
create policy "ratings_select_own"
  on public.ratings
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "ratings_insert_own" on public.ratings;
create policy "ratings_insert_own"
  on public.ratings
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "ratings_update_own" on public.ratings;
create policy "ratings_update_own"
  on public.ratings
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "ratings_delete_own" on public.ratings;
create policy "ratings_delete_own"
  on public.ratings
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Sem acesso anônimo: só o dono autenticado.

-- ------------------------------------------------------ 3. updated_at
create or replace function public.handle_rating_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_rating_updated_at on public.ratings;
create trigger set_rating_updated_at
  before update on public.ratings
  for each row
  execute function public.handle_rating_updated_at();

-- --------------------------------------------- 4. Índice (recentes primeiro)
create index if not exists ratings_user_recent
  on public.ratings (user_id, updated_at desc);
