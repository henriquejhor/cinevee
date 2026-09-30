-- CineVee · Etapa 17 — Feed "Seguindo" (opt-in show_activity + RPC).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. adiciona public.profiles.show_activity (NOT NULL DEFAULT false:
--      nenhuma conta existente distribui atividade automaticamente);
--   2. cria a RPC SECURITY DEFINER get_following_feed (search_path fixo,
--      só leitura, sem SQL dinâmica) que deriva o feed de dados vivos:
--        follows (quem o viewer segue, via auth.uid()) +
--        profiles (alvo com profile_public + show_activity) +
--        ratings ⋈ watched_titles (snapshot factual) +
--        profile_picks (favorites / recommendations);
--   3. cria 2 índices de apoio (sem duplicar os existentes);
--   4. concede EXECUTE somente a authenticated (anon sem acesso).
--
-- O que esta migration NÃO faz:
--   - NÃO cria tabela de eventos nem notificações, e nem triggers;
--   - NÃO cria policy pública em nenhuma tabela base (o feed ocorre
--     exclusivamente pela RPC autenticada);
--   - NÃO filtra pela flag de busca global (ela só gateia pessoas na
--     busca; quem já é seguido aparece normalmente);
--   - NÃO expõe UUID/email/flags/datas além do allowlist da RPC;
--   - NÃO usa service_role em lugar nenhum do app.
--
-- Regras de privacidade (todas impostas no SQL):
--   - ator: profile_public IS TRUE AND show_activity IS TRUE;
--   - rating: + show_ratings; review_text só com show_reviews;
--   - favorite: + show_favorites; recommendation: + show_recommendations.
--
-- Timestamps (editar conteúdo NÃO reordena o feed):
--   - rating → rated_at (instante da criação; a coluna de edição
--     nunca é usada para ordenar);
--   - favorite/recommendation → created_at (position/note NÃO movem).

-- ------------------------------------------------------- 1. Opt-in
alter table public.profiles
  add column if not exists show_activity boolean not null default false;

-- --------------------------------------- 2. RPC: feed de quem eu sigo
-- Somente authenticated (grant abaixo). O viewer é SEMPRE auth.uid()
-- interno: ninguém consulta o feed de outra pessoa. Sem UUID na saída:
-- a chave de dedupe do client deriva de campos públicos
-- (type:username:mediaType:tmdbId — únicos por constraints UNIQUE).
create or replace function public.get_following_feed(
  p_limit integer,
  p_offset integer
)
returns table (
  event_type text,
  actor_display_name text,
  actor_username text,
  actor_avatar_path text,
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer,
  rating smallint,
  review_text text,
  note text,
  activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with followed as (
    select f.following_id as id
    from public.follows as f
    where f.follower_id = auth.uid()
  ),
  actors as (
    select
      p.id,
      p.display_name,
      p.username,
      p.avatar_path,
      p.show_ratings,
      p.show_reviews,
      p.show_favorites,
      p.show_recommendations
    from public.profiles as p
    join followed as fo
      on fo.id = p.id
    where p.profile_public is true
      and p.show_activity is true
  ),
  rating_events as (
    select
      'rating'::text as event_type,
      a.display_name as actor_display_name,
      a.username as actor_username,
      a.avatar_path as actor_avatar_path,
      r.tmdb_id as tmdb_id,
      r.media_type as media_type,
      w.title as title,
      w.poster_path as poster_path,
      w.release_year as release_year,
      r.rating as rating,
      case
        when a.show_reviews is true then r.review_text
        else null
      end as review_text,
      null::text as note,
      r.rated_at as activity_at
    from actors as a
    join public.ratings as r
      on r.user_id = a.id
    join public.watched_titles as w
      on w.user_id = r.user_id
     and w.media_type = r.media_type
     and w.tmdb_id = r.tmdb_id
    where a.show_ratings is true
  ),
  favorite_events as (
    select
      'favorite'::text as event_type,
      a.display_name as actor_display_name,
      a.username as actor_username,
      a.avatar_path as actor_avatar_path,
      pk.tmdb_id as tmdb_id,
      pk.media_type as media_type,
      pk.title as title,
      pk.poster_path as poster_path,
      pk.release_year as release_year,
      null::smallint as rating,
      null::text as review_text,
      null::text as note,
      pk.created_at as activity_at
    from actors as a
    join public.profile_picks as pk
      on pk.user_id = a.id
     and pk.kind = 'favorite'
    where a.show_favorites is true
  ),
  recommendation_events as (
    select
      'recommendation'::text as event_type,
      a.display_name as actor_display_name,
      a.username as actor_username,
      a.avatar_path as actor_avatar_path,
      pk.tmdb_id as tmdb_id,
      pk.media_type as media_type,
      pk.title as title,
      pk.poster_path as poster_path,
      pk.release_year as release_year,
      null::smallint as rating,
      null::text as review_text,
      pk.note as note,
      pk.created_at as activity_at
    from actors as a
    join public.profile_picks as pk
      on pk.user_id = a.id
     and pk.kind = 'recommendation'
    where a.show_recommendations is true
  )
  select *
  from rating_events
  union all
  select *
  from favorite_events
  union all
  select *
  from recommendation_events
  order by activity_at desc, event_type asc, actor_username asc, media_type asc, tmdb_id asc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- --------------------------------------- 3. Índices de apoio
-- follows já tem follows_follower_idx (follower_id, created_at DESC).
-- ratings tem índice por (user_id, coluna de edição DESC) — NÃO serve:
-- o feed ordena por rated_at (criação), nunca pela coluna de edição.
create index if not exists ratings_user_rated_idx
  on public.ratings (user_id, rated_at desc);
-- profile_picks tem profile_picks_user_kind_position
-- (user_id, kind, position) — NÃO serve: o feed ordena por created_at.
create index if not exists profile_picks_user_kind_created_idx
  on public.profile_picks (user_id, kind, created_at desc);

-- --------------------------------------- 4. Grants (só EXECUTE p/ auth)
revoke all on function public.get_following_feed(integer, integer) from public;

grant execute on function public.get_following_feed(integer, integer) to authenticated;
