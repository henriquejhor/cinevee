-- CineVee · Etapa 21 — Notificações in-app (public.notifications).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto, DEPOIS de
--   20261006090000_fix_rating_comments_create.sql.
--
-- O que esta migration faz:
--   1. cria public.notifications (recipient/actor/type, media/tmdb/
--      comment opcionais por tipo, created_at, read_at) com CHECKs de
--      tipo/shape, anti-self e FKs em cascata (rating composta NA ORDEM
--      da UNIQUE ratings_unique_item; follow com media/tmdb NULL não é
--      afetado pela FK composta — MATCH SIMPLE ignora linha com NULL);
--   2. dedupe no banco via unique partial indexes (1 follow ativo por
--      recipient+actor; 1 like ativo por recipient+actor+media+tmdb;
--      1 notification por comment_id);
--   3. índices de inbox (recipient, created_at DESC, id DESC) + unread
--      parcial; RLS sem policies (nenhum acesso direto anon/auth);
--   4. integra criação/remoção nas RPCs já aplicadas (CREATE OR REPLACE
--      com comportamento anterior 100% preservado):
--        - follow_user_by_username: follow NOVO → notification follow;
--        - unfollow_user_by_username: remove a follow notification;
--        - like_rating_by_username: like NOVO → notification rating_like;
--        - unlike_rating_by_username: remove a like notification;
--        - create_rating_comment_by_username: comment NOVO → notification
--          rating_comment (mesmo corpo do fix 42702 + insert);
--      delete de comment/rating/watched/contas usa CASCADE;
--   5. cria 4 RPCs de inbox (authenticated, search_path fixo):
--        - get_my_notifications (STABLE; actor dinâmico por
--          profile_public atual; title via watched_titles do recipient;
--          comment_text atual; sem UUID/email/flags);
--        - get_my_notification_unread_count (STABLE);
--        - mark_my_notifications_read (VOLATILE; máx 24 ids; só do dono;
--          read_at = now() onde era NULL);
--        - mark_all_my_notifications_read (VOLATILE; só do dono);
--   6. concede EXECUTE mínimo (só authenticated nas 4 de inbox).
--
-- O que esta migration NÃO faz:
--   - NÃO edita migrations antigas (só CREATE OR REPLACE das 5 RPCs);
--   - NÃO cria triggers (integração direta nas RPCs controladas);
--   - NÃO usa Realtime/WebSocket/push/e-mail;
--   - NÃO expõe recipient_id/actor_id/UUID/email/flags em leitura;
--   - NÃO chama TMDB (title vem do snapshot watched_titles);
--   - NÃO toca TasteProfile/feed/ranking;
--   - NÃO usa service_role em lugar nenhum do app.
--
-- Decisões de privacidade (documentadas):
--   - inbox é privada do recipient: sem gates de profile_public/
--     show_ratings na leitura; rating deletada remove via cascade;
--   - actor público (profile_public) → identidade mesmo com
--     discoverable=false (só controla a busca global);
--   - actor privado → "Usuário privado" (sem username/avatar/link),
--     resolvido dinamicamente a cada fetch (sem snapshot);
--   - comment editado → preview atual, sem nova notification, sem
--     tocar created_at/read_at.

-- ---------------------------------------------------------------- 1. Tabela
-- Tipos idênticos aos das tabelas-fonte (uuid/bigint/text/timestamptz).
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  actor_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  media_type text,
  tmdb_id bigint,
  comment_id bigint references public.rating_comments (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz null,

  constraint notifications_no_self
    check (actor_id <> recipient_id),
  constraint notifications_type_allowed
    check (type in ('follow', 'rating_like', 'rating_comment')),
  constraint notifications_media_type_allowed
    check (media_type is null or media_type in ('movie', 'tv')),
  constraint notifications_shape_by_type check (
    (type = 'follow'
      and media_type is null and tmdb_id is null and comment_id is null)
    or (type = 'rating_like'
      and media_type is not null and tmdb_id is not null and comment_id is null)
    or (type = 'rating_comment'
      and media_type is not null and tmdb_id is not null and comment_id is not null)
  ),
  -- Rating precisa existir (like/comment). Follow tem media/tmdb NULL,
  -- então o MATCH SIMPLE pula a checagem para ele (só checa quando as
  -- 3 colunas são NOT NULL). Ordem = UNIQUE ratings_unique_item
  -- (user_id, media_type, tmdb_id), igual a rating_likes/comments.
  constraint notifications_rating_fk
    foreign key (recipient_id, media_type, tmdb_id)
    references public.ratings (user_id, media_type, tmdb_id)
    on delete cascade
);

-- -------------------------------------------- 2. Dedupe + índices de inbox
-- Máximo 1 follow ativo por (recipient, actor).
create unique index if not exists notifications_unique_follow
  on public.notifications (recipient_id, actor_id)
  where type = 'follow';
-- Máximo 1 like ativo por (recipient, actor, media, tmdb).
create unique index if not exists notifications_unique_like
  on public.notifications (recipient_id, actor_id, media_type, tmdb_id)
  where type = 'rating_like';
-- Máximo 1 notification por comentário.
create unique index if not exists notifications_unique_comment
  on public.notifications (comment_id)
  where type = 'rating_comment';

-- Inbox do recipient, mais recentes primeiro.
create index if not exists notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc, id desc);
-- Contagem de não lidas sem varrer lidas.
create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id)
  where read_at is null;

-- ----------------------------------------------------------------- 3. RLS
-- RLS ligada SEM policies: nenhum SELECT/INSERT/UPDATE/DELETE direto
-- (nem anon, nem authenticated). Todo acesso passa pelas RPCs abaixo
-- (SECURITY DEFINER) e pela criação/remoção dentro das RPCs de origem.
alter table public.notifications enable row level security;

-- --------------------------------- 4. follow → notification (idempotente)
-- Corpo idêntico a 20261001090000 (mesmos gates/erros) + insert da
-- notification SOMENTE quando o follow é realmente novo (row_count).
create or replace function public.follow_user_by_username(p_username text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_target uuid;
  v_new integer := 0;
begin
  if v_me is null then
    raise exception 'Perfil não disponível.';
  end if;

  select p.id into v_target
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true;

  if v_target is null or v_target = v_me then
    raise exception 'Perfil não disponível.';
  end if;

  insert into public.follows (follower_id, following_id)
  values (v_me, v_target)
  on conflict on constraint follows_unique_pair do nothing;

  get diagnostics v_new = row_count;

  if v_new > 0 then
    insert into public.notifications (recipient_id, actor_id, type)
    values (v_target, v_me, 'follow')
    on conflict (recipient_id, actor_id) where type = 'follow' do nothing;
  end if;

  return true;
end;
$$;

-- ------------------------------- 5. unfollow remove a follow notification
-- Corpo idêntico a 20261001090000 + delete da notification quando a
-- relação existia. Sem "notification de unfollow".
create or replace function public.unfollow_user_by_username(p_username text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_target uuid;
  v_count integer := 0;
begin
  if v_me is null then
    raise exception 'Perfil não disponível.';
  end if;

  select p.id into v_target
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$';

  if v_target is null or v_target = v_me then
    return false;
  end if;

  delete from public.follows
  where follower_id = v_me
    and following_id = v_target;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    delete from public.notifications
    where recipient_id = v_target
      and actor_id = v_me
      and type = 'follow';
  end if;

  return v_count > 0;
end;
$$;

-- ----------------------------------- 6. like → notification (idempotente)
-- Corpo idêntico a 20261004090000 (mesmos gates/erros/retorno) + insert
-- da notification SOMENTE quando o like é realmente novo.
create or replace function public.like_rating_by_username(
  p_username text,
  p_tmdb_id bigint,
  p_media_type text
)
returns table (
  liked boolean,
  like_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_new integer := 0;
begin
  if v_me is null then
    raise exception 'Avaliação indisponível.';
  end if;

  if p_media_type not in ('movie', 'tv') then
    raise exception 'Avaliação indisponível.';
  end if;

  if p_tmdb_id is null or p_tmdb_id < 1 then
    raise exception 'Avaliação indisponível.';
  end if;

  select p.id into v_owner
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
    raise exception 'Avaliação indisponível.';
  end if;

  if v_owner = v_me then
    raise exception 'Você não pode curtir sua própria avaliação.';
  end if;

  insert into public.rating_likes (liker_id, rating_owner_id, tmdb_id, media_type)
  values (v_me, v_owner, p_tmdb_id, p_media_type)
  on conflict on constraint rating_likes_unique_like do nothing;

  get diagnostics v_new = row_count;

  if v_new > 0 then
    insert into public.notifications (recipient_id, actor_id, type, media_type, tmdb_id)
    values (v_owner, v_me, 'rating_like', p_media_type, p_tmdb_id)
    on conflict (recipient_id, actor_id, media_type, tmdb_id) where type = 'rating_like' do nothing;
  end if;

  return query
  select true as liked, count(*) as like_count
  from public.rating_likes as l
  where l.rating_owner_id = v_owner
    and l.media_type = p_media_type
    and l.tmdb_id = p_tmdb_id;
end;
$$;

-- --------------------------------- 7. unlike remove a like notification
-- Corpo idêntico a 20261004090000 + delete da notification quando o like
-- existia. Sem "notification de unlike".
create or replace function public.unlike_rating_by_username(
  p_username text,
  p_tmdb_id bigint,
  p_media_type text
)
returns table (
  removed boolean,
  like_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_count integer := 0;
begin
  if v_me is null then
    raise exception 'Avaliação indisponível.';
  end if;

  if p_media_type not in ('movie', 'tv') then
    raise exception 'Avaliação indisponível.';
  end if;

  if p_tmdb_id is null or p_tmdb_id < 1 then
    raise exception 'Avaliação indisponível.';
  end if;

  select p.id into v_owner
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$';

  if v_owner is null or v_owner = v_me then
    return query select false as removed, 0::bigint as like_count;
  end if;

  delete from public.rating_likes as l
  where l.liker_id = v_me
    and l.rating_owner_id = v_owner
    and l.media_type = p_media_type
    and l.tmdb_id = p_tmdb_id;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    delete from public.notifications
    where recipient_id = v_owner
      and actor_id = v_me
      and type = 'rating_like'
      and media_type = p_media_type
      and tmdb_id = p_tmdb_id;
  end if;

  return query
  select (v_count > 0) as removed, count(*) as like_count
  from public.rating_likes as l
  where l.rating_owner_id = v_owner
    and l.media_type = p_media_type
    and l.tmdb_id = p_tmdb_id;
end;
$$;

-- ------------------------------ 8. comment → notification (sempre nova)
-- Corpo idêntico ao fix 20261006090000 (mesmos gates/erros/retorno, sem
-- RETURNING ambíguo) + insert da notification com o comment_id criado.
-- Editar comentário não passa por aqui (sem nova notification); apagar
-- usa CASCADE via comment_id.
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

  -- INSERT direto (sem ON CONFLICT ambíguo com o OUT comment_id):
  -- v_comment_id é o identity recém-criado nesta transação.
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

-- ------------------------------------------------ 9. RPC: inbox (página)
-- Inbox PRIVADA do recipient (auth.uid(); sem gates de profile_public/
-- show_ratings — cascade cuida de rating deletada). Actor resolvido pelo
-- profile ATUAL (público→identidade mesmo com discoverable=false;
-- privado→tudo null + is_private). Title via snapshot watched_titles do
-- recipient (sem TMDB). Comment_text atual (edit reflete sem nova row).
create or replace function public.get_my_notifications(
  p_limit integer,
  p_offset integer
)
returns table (
  notification_id bigint,
  type text,
  actor_is_private boolean,
  actor_display_name text,
  actor_username text,
  actor_avatar_path text,
  media_type text,
  tmdb_id bigint,
  title text,
  poster_path text,
  release_year integer,
  comment_text text,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    n.id as notification_id,
    n.type as type,
    (ap.profile_public is not true) as actor_is_private,
    case when ap.profile_public is true then ap.display_name else null end as actor_display_name,
    case when ap.profile_public is true then ap.username else null end as actor_username,
    case when ap.profile_public is true then ap.avatar_path else null end as actor_avatar_path,
    n.media_type as media_type,
    n.tmdb_id as tmdb_id,
    w.title as title,
    w.poster_path as poster_path,
    w.release_year as release_year,
    c.comment_text as comment_text,
    n.created_at as created_at,
    n.read_at as read_at
  from public.notifications as n
  join public.profiles as ap
    on ap.id = n.actor_id
  left join public.watched_titles as w
    on w.user_id = n.recipient_id
   and w.media_type = n.media_type
   and w.tmdb_id = n.tmdb_id
  left join public.rating_comments as c
    on c.id = n.comment_id
  where n.recipient_id = auth.uid()
    and auth.uid() is not null
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ------------------------------------------- 10. RPC: unread count
create or replace function public.get_my_notification_unread_count()
returns table (
  unread_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select count(*) as unread_count
  from public.notifications as n
  where n.recipient_id = auth.uid()
    and auth.uid() is not null
    and n.read_at is null;
$$;

-- ------------------------------------------- 11. RPC: marcar lidas (lote)
-- Máx 24 ids (o app valida; aqui o update filtra pelo dono de qualquer
-- forma). Só rows ainda não lidas: read_at preservado se já lida.
create or replace function public.mark_my_notifications_read(
  p_notification_ids bigint[]
)
returns table (
  marked_count bigint,
  unread_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_marked bigint := 0;
begin
  if v_me is null then
    raise exception 'Você precisa estar logado.';
  end if;

  if p_notification_ids is null or coalesce(array_length(p_notification_ids, 1), 0) = 0 then
    return query
    select 0::bigint as marked_count, count(*) as unread_count
    from public.notifications as n
    where n.recipient_id = v_me
      and n.read_at is null;
  end if;

  with updated as (
    update public.notifications as n
    set read_at = now()
    where n.id = any (p_notification_ids)
      and n.recipient_id = v_me
      and n.read_at is null
    returning n.id
  )
  select count(*) into v_marked from updated;

  return query
  select v_marked as marked_count, count(*) as unread_count
  from public.notifications as n
  where n.recipient_id = v_me
    and n.read_at is null;
end;
$$;

-- ------------------------------------------- 12. RPC: marcar todas lidas
create or replace function public.mark_all_my_notifications_read()
returns table (
  marked_count bigint,
  unread_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_marked bigint := 0;
begin
  if v_me is null then
    raise exception 'Você precisa estar logado.';
  end if;

  update public.notifications as n
  set read_at = now()
  where n.recipient_id = v_me
    and n.read_at is null;

  get diagnostics v_marked = row_count;

  return query
  select v_marked as marked_count, 0::bigint as unread_count;
end;
$$;

-- ------------------------------------------------------------- 13. Grants
-- Tabela: nenhum grant direto (RLS sem policies bloqueia tudo).
-- RPCs de origem (follow/like/comment): grants inalterados.
revoke all on function public.get_my_notifications(integer, integer) from public;
revoke all on function public.get_my_notification_unread_count() from public;
revoke all on function public.mark_my_notifications_read(bigint[]) from public;
revoke all on function public.mark_all_my_notifications_read() from public;

grant execute on function public.get_my_notifications(integer, integer) to authenticated;
grant execute on function public.get_my_notification_unread_count() to authenticated;
grant execute on function public.mark_my_notifications_read(bigint[]) to authenticated;
grant execute on function public.mark_all_my_notifications_read() to authenticated;
