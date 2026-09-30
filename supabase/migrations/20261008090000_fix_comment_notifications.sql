-- CineVee · Etapa 21 — fix: notification de comentário (42702).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez, DEPOIS de
--   20261007090000_notifications.sql.
--
-- Causa: em create_rating_comment_by_username, o INSERT da notification
-- usava `on conflict (comment_id) where type = 'rating_comment'`.
-- A função é RETURNS TABLE com parâmetro OUT `comment_id`, então o
-- árbitro referencia tanto a variável PL/pgSQL quanto a coluna da
-- tabela → erro 42702 "column reference comment_id is ambiguous"
-- (mesma classe do bug 42702 da Etapa 19 com created_at). Como a
-- exceção aborta a transação, o comentário sofria rollback junto
-- (POST 500 + nenhuma row em rating_comments/notifications).
--
-- Correção: INSERT direto, sem ON CONFLICT. É seguro porque comment_id
-- é o identity recém-criado na mesma transação (sempre novo; edições
-- não passam por aqui e o índice unique parcial continua como última
-- camada). Variável renomeada para v_comment_id (sem colisão).
-- ON CONFLICT ON CONSTRAINT não servia aqui: dedupe parcial só existe
-- via CREATE UNIQUE INDEX (constraints UNIQUE não aceitam WHERE).
-- Follow/like (verdes, sem colisão com OUT params) NÃO são tocados.
create or replace function public.create_rating_comment_by_username(
  p_username text,
  p_tmdb_id bigint,
  p_media_type text,
  p_comment_text text
)
returns table (
  comment_id bigint,
  created_at timestamptz,
  updated_at timestamptz,
  comment_text text,
  author_is_private boolean,
  author_display_name text,
  author_username text,
  author_avatar_path text,
  can_edit boolean,
  can_delete boolean,
  comment_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_text text;
  v_allows boolean;
  v_comment_id bigint;
begin
  if v_me is null then
    raise exception 'Esta avaliação não está disponível.';
  end if;

  if p_media_type not in ('movie', 'tv') then
    raise exception 'Esta avaliação não está disponível.';
  end if;

  if p_tmdb_id is null or p_tmdb_id < 1 then
    raise exception 'Esta avaliação não está disponível.';
  end if;

  v_text := trim(coalesce(p_comment_text, ''));
  if char_length(v_text) < 1 or char_length(v_text) > 500 then
    raise exception 'Comentário inválido.';
  end if;

  select p.id, (p.allow_rating_comments is true) into v_owner, v_allows
  from public.profiles as p
  join public.ratings as r
    on r.user_id = p.id
   and r.media_type = p_media_type
   and r.tmdb_id = p_tmdb_id
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_ratings is true;

  if v_owner is null then
    raise exception 'Esta avaliação não está disponível.';
  end if;

  if v_owner = v_me then
    raise exception 'Você não pode comentar sua própria avaliação.';
  end if;

  if v_allows is not true then
    raise exception 'Novos comentários estão desativados nesta avaliação.';
  end if;

  insert into public.rating_comments (author_id, rating_owner_id, tmdb_id, media_type, comment_text)
  values (v_me, v_owner, p_tmdb_id, p_media_type, v_text);

  -- Sem RETURNING (ver fix 42702): releitura qualificada.
  select c.id into v_comment_id
  from public.rating_comments as c
  where c.author_id = v_me
    and c.rating_owner_id = v_owner
    and c.media_type = p_media_type
    and c.tmdb_id = p_tmdb_id
  order by c.id desc
  limit 1;

  if v_comment_id is null then
    raise exception 'Esta avaliação não está disponível.';
  end if;

  -- INSERT direto (sem ON CONFLICT ambíguo): v_comment_id é o identity
  -- recém-criado nesta transação — sempre novo; o unique partial index
  -- notifications_unique_comment segue como última camada.
  insert into public.notifications (recipient_id, actor_id, type, media_type, tmdb_id, comment_id)
  values (v_owner, v_me, 'rating_comment', p_media_type, p_tmdb_id, v_comment_id);

  return query
  select
    c.id as comment_id,
    c.created_at as created_at,
    c.updated_at as updated_at,
    c.comment_text as comment_text,
    (ap.profile_public is not true) as author_is_private,
    case when ap.profile_public is true then ap.display_name else null end as author_display_name,
    case when ap.profile_public is true then ap.username else null end as author_username,
    case when ap.profile_public is true then ap.avatar_path else null end as author_avatar_path,
    true as can_edit,
    true as can_delete,
    (select count(*)
     from public.rating_comments as rest
     where rest.rating_owner_id = v_owner
       and rest.media_type = p_media_type
       and rest.tmdb_id = p_tmdb_id) as comment_count
  from public.rating_comments as c
  join public.profiles as ap
    on ap.id = c.author_id
  where c.id = v_comment_id;
end;
$$;
