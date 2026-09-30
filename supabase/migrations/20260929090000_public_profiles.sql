-- CineVee · Etapa 14 — Perfis públicos + controles de privacidade.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. adiciona 6 flags a public.profiles (tudo NOT NULL DEFAULT false:
--      perfil privado por padrão; nenhuma conta existente fica pública);
--   2. cria 5 RPCs SECURITY DEFINER (search_path fixo, só leitura, sem
--      SQL dinâmica) que expõem SOMENTE colunas allowlisted e SOMENTE
--      quando profile_public + flag da seção estão ligadas;
--   3. concede EXECUTE das RPCs a anon + authenticated (as tabelas base
--      continuam sem nenhuma policy pública).
--
-- O que esta migration NÃO faz:
--   - NÃO cria policy pública em profiles/profile_picks/watched_titles/
--     ratings (as policies privadas continuam valendo);
--   - NÃO expõe user_id, email, preferências (excluded_genres,
--     streaming_providers), watchlist, timestamps internos ou metadados;
--   - NÃO cria show_watchlist (Minha Lista continua sempre privada);
--   - NÃO usa service_role em lugar nenhum do app.
--
-- Privacidade conservadora: tudo desligado por padrão. Mesmo com uma
-- subseção ligada, nada é acessível com profile_public = false.

-- ------------------------------------------------------- 1. Flags
alter table public.profiles
  add column if not exists profile_public boolean not null default false,
  add column if not exists show_favorites boolean not null default false,
  add column if not exists show_recommendations boolean not null default false,
  add column if not exists show_watched boolean not null default false,
  add column if not exists show_ratings boolean not null default false,
  add column if not exists show_reviews boolean not null default false;

-- --------------------------------------- 2. RPC: identidade pública
-- Retorna 0 linhas quando o username não existe OU o perfil é privado
-- (comportamento equivalente — sem distinguir os dois casos).
create or replace function public.get_public_profile(p_username text)
returns table (
  display_name text,
  username text,
  bio text,
  avatar_path text,
  show_favorites boolean,
  show_recommendations boolean,
  show_watched boolean,
  show_ratings boolean,
  show_reviews boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.display_name,
    p.username,
    p.bio,
    p.avatar_path,
    p.show_favorites,
    p.show_recommendations,
    p.show_watched,
    p.show_ratings,
    p.show_reviews
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true;
$$;

-- --------------------------------------- 3. RPC: favoritos públicos
create or replace function public.get_public_favorites(p_username text)
returns table (
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer,
  position integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    pk.tmdb_id,
    pk.media_type,
    pk.title,
    pk.poster_path,
    pk.release_year,
    pk.position
  from public.profiles as p
  join public.profile_picks as pk
    on pk.user_id = p.id
   and pk.kind = 'favorite'
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_favorites is true
  order by pk.position asc;
$$;

-- --------------------------------------- 4. RPC: recomendações públicas
create or replace function public.get_public_recommendations(p_username text)
returns table (
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer,
  note text,
  position integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    pk.tmdb_id,
    pk.media_type,
    pk.title,
    pk.poster_path,
    pk.release_year,
    pk.note,
    pk.position
  from public.profiles as p
  join public.profile_picks as pk
    on pk.user_id = p.id
   and pk.kind = 'recommendation'
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_recommendations is true
  order by pk.position asc;
$$;

-- --------------------------------------- 5. RPC: assistidos públicos
-- Paginação obrigatória (teto 24 por chamada); watched_at ordena
-- internamente mas NÃO é exposto ao visitante.
create or replace function public.get_public_watched(
  p_username text,
  p_limit integer,
  p_offset integer
)
returns table (
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.tmdb_id,
    w.media_type,
    w.title,
    w.poster_path,
    w.release_year
  from public.profiles as p
  join public.watched_titles as w
    on w.user_id = p.id
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_watched is true
  order by w.watched_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- --------------------------------------- 6. RPC: avaliações públicas
-- Junta ratings → watched_titles (título/pôster/ano vêm do snapshot).
-- review_text só sai quando show_reviews também está ligado; senão NULL
-- (o visitante nunca descobre review escondida).
create or replace function public.get_public_ratings(
  p_username text,
  p_limit integer,
  p_offset integer
)
returns table (
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer,
  rating smallint,
  review_text text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.tmdb_id,
    r.media_type,
    w.title,
    w.poster_path,
    w.release_year,
    r.rating,
    case when p.show_reviews is true then r.review_text else null end
  from public.profiles as p
  join public.ratings as r
    on r.user_id = p.id
  join public.watched_titles as w
    on w.user_id = p.id
   and w.media_type = r.media_type
   and w.tmdb_id = r.tmdb_id
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_ratings is true
  order by r.updated_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- --------------------------------------- 7. Grants (só EXECUTE nas RPCs)
revoke all on function public.get_public_profile(text) from public;
revoke all on function public.get_public_favorites(text) from public;
revoke all on function public.get_public_recommendations(text) from public;
revoke all on function public.get_public_watched(text, integer, integer) from public;
revoke all on function public.get_public_ratings(text, integer, integer) from public;

grant execute on function public.get_public_profile(text) to anon, authenticated;
grant execute on function public.get_public_favorites(text) to anon, authenticated;
grant execute on function public.get_public_recommendations(text) to anon, authenticated;
grant execute on function public.get_public_watched(text, integer, integer) to anon, authenticated;
grant execute on function public.get_public_ratings(text, integer, integer) to anon, authenticated;
