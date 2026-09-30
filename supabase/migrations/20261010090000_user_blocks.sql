-- CineVee · Etapa 23 — Bloqueio de usuários + remoção de seguidores.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto, DEPOIS de
--   20261009090000_rating_comment_replies.sql.
--
-- O que esta migration faz:
--   1. follows ganha id identity (management sem expor UUID) + unique;
--   2. cria public.user_blocks (blocker/blocked, unique par, anti-self,
--      FKs cascade, índice reverso, RLS sem policies);
--   3. helper interno users_are_blocked(a,b) (bilateral, null-safe) +
--      apply_user_block (insert + follows 2 sentidos + notifications
--      cross, atômico) — ambos SEM grants (só infra das RPCs);
--   4. block_user_by_username / block_my_follower / unblock_user /
--      get_my_blocked_users / get_my_followers / remove_my_follower
--      (authenticated; sem UUID no I/O; sem notification de block);
--   5. gates bilaterais (CREATE OR REPLACE, corpos idênticos + gate)
--      em: follow, like, comment, reply create, reply/comment/like
--      states, comment/reply lists (+counts coerentes), search, feed,
--      5 profile RPCs, followers/following/counts, inbox + unread +
--      mark counts. Edit/delete próprios e unlike/unfollow preservados.
--
-- O que esta migration NÃO faz:
--   - NÃO apaga ratings/reviews/likes/comments/replies/picks;
--   - NÃO revela block recebido (erros genéricos em todo lugar);
--   - NÃO cria notifications de block/unblock/remove;
--   - NÃO toca feed ordering, TasteProfile, TMDB, IA;
--   - NÃO usa triggers/Realtime/service_role.

-- --------------------------------------- 1. follows: surrogate id
-- Identity preenche rows existentes (PostgreSQL atribui sequence ao
-- ADD COLUMN); PK atual (follower_id, following_id) preservada.
alter table public.follows
  add column if not exists id bigint generated always as identity;
alter table public.follows
  drop constraint if exists follows_unique_id;
alter table public.follows
  add constraint follows_unique_id unique (id);

-- ------------------------------------------------- 2. user_blocks
create table if not exists public.user_blocks (
  id bigint generated always as identity primary key,
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint user_blocks_unique_pair unique (blocker_id, blocked_id),
  constraint user_blocks_no_self check (blocker_id <> blocked_id)
);

-- Descobrir blocks recebidos internamente (outbox do par).
create index if not exists user_blocks_reverse_idx
  on public.user_blocks (blocked_id, blocker_id);

-- RLS ligada SEM policies: nenhum acesso direto (só via RPCs).
alter table public.user_blocks enable row level security;

-- ----------------------------------- 3. helper + aplicação (internos)
-- Bilateral: A→B OU B→A. Null-safe (anon nunca é "blocked").
create or replace function public.users_are_blocked(p_user_a uuid, p_user_b uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_user_a is null or p_user_b is null then
    return false;
  end if;
  if p_user_a = p_user_b then
    return false;
  end if;
  return exists (
    select 1 from public.user_blocks
    where blocker_id = p_user_a and blocked_id = p_user_b
  ) or exists (
    select 1 from public.user_blocks
    where blocker_id = p_user_b and blocked_id = p_user_a
  );
end;
$$;
revoke all on function public.users_are_blocked(uuid, uuid) from public;

-- Transação de block: row + follows 2 sentidos + notifications cross.
-- Conteúdo social (likes/comments/replies) preservado (só oculto).
create or replace function public.apply_user_block(p_blocker uuid, p_blocked uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  insert into public.user_blocks (blocker_id, blocked_id)
  values (p_blocker, p_blocked)
  on conflict on constraint user_blocks_unique_pair do nothing;

  delete from public.follows
  where (follower_id = p_blocker and following_id = p_blocked)
     or (follower_id = p_blocked and following_id = p_blocker);

  delete from public.notifications
  where (recipient_id = p_blocker and actor_id = p_blocked)
     or (recipient_id = p_blocked and actor_id = p_blocker);
end;
$$;
revoke all on function public.apply_user_block(uuid, uuid) from public;

-- --------------------------------------------- 4. RPC: bloquear por nome
-- Target pode estar private (username conhecido); self → erro próprio.
create or replace function public.block_user_by_username(p_username text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_target uuid;
begin
  if v_me is null then
    raise exception 'Usuário indisponível.';
  end if;

  select p.id into v_target
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$';

  if v_target is null then
    raise exception 'Usuário indisponível.';
  end if;

  if v_target = v_me then
    raise exception 'Você não pode bloquear a si mesmo.';
  end if;

  perform public.apply_user_block(v_me, v_target);
  return true;
end;
$$;

-- --------------------------------- 5. RPC: bloquear follower (por follow)
-- Para follower private/sem username: resolve pela follow row própria.
create or replace function public.block_my_follower(p_follow_id bigint)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_follower uuid;
begin
  if v_me is null then
    raise exception 'Usuário indisponível.';
  end if;

  if p_follow_id is null or p_follow_id < 1 then
    raise exception 'Usuário indisponível.';
  end if;

  select f.follower_id into v_follower
  from public.follows as f
  where f.id = p_follow_id
    and f.following_id = v_me;

  if v_follower is null or v_follower = v_me then
    raise exception 'Usuário indisponível.';
  end if;

  perform public.apply_user_block(v_me, v_follower);
  return true;
end;
$$;

-- ------------------------------------------------ 6. RPC: desbloquear
-- Só a própria row (blocker = eu). Não recria follows/notifications.
create or replace function public.unblock_user(p_block_id bigint)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_count integer := 0;
begin
  if v_me is null then
    raise exception 'Usuário indisponível.';
  end if;

  if p_block_id is null or p_block_id < 1 then
    return false;
  end if;

  delete from public.user_blocks
  where id = p_block_id
    and blocker_id = v_me;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- ------------------------------------------ 7. RPC: meus bloqueados
-- Lista PRIVADA do blocker: identidade atual mesmo se target private.
create or replace function public.get_my_blocked_users(
  p_limit integer,
  p_offset integer
)
returns table (
  block_id bigint,
  display_name text,
  username text,
  avatar_path text,
  blocked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id as block_id,
    p.display_name as display_name,
    p.username as username,
    p.avatar_path as avatar_path,
    b.created_at as blocked_at
  from public.user_blocks as b
  join public.profiles as p
    on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
    and auth.uid() is not null
  order by b.created_at desc, b.id desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ------------------------------------------ 8. RPC: meus seguidores
-- Management privada: inclui followers private (relação direta comigo).
create or replace function public.get_my_followers(
  p_limit integer,
  p_offset integer
)
returns table (
  follow_id bigint,
  display_name text,
  username text,
  avatar_path text,
  followed_at timestamptz,
  is_public boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    f.id as follow_id,
    p.display_name as display_name,
    p.username as username,
    p.avatar_path as avatar_path,
    f.created_at as followed_at,
    (p.profile_public is true) as is_public
  from public.follows as f
  join public.profiles as p
    on p.id = f.follower_id
  where f.following_id = auth.uid()
    and auth.uid() is not null
  order by f.created_at desc, f.id desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ------------------------------------- 9. RPC: remover seguidor (sem block)
-- Apaga SÓ follower→eu + a follow notification. Não bloqueia; resto
-- (likes/comments/replies) preservado. Refollow continua possível.
create or replace function public.remove_my_follower(p_follow_id bigint)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_follower uuid;
  v_count integer := 0;
begin
  if v_me is null then
    raise exception 'Usuário indisponível.';
  end if;

  if p_follow_id is null or p_follow_id < 1 then
    return false;
  end if;

  select f.follower_id into v_follower
  from public.follows as f
  where f.id = p_follow_id
    and f.following_id = v_me;

  if v_follower is null then
    return false;
  end if;

  delete from public.follows
  where id = p_follow_id
    and following_id = v_me;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    delete from public.notifications
    where recipient_id = v_me
      and actor_id = v_follower
      and type = 'follow';
  end if;

  return v_count > 0;
end;
$$;

-- ============================ 10. GATES DE ESCRITA (par bloqueado)
-- Corpos idênticos aos atuais + gate bilateral com erro genérico
-- (nunca revela direção do block). Unfollow/unlike/edit/delete
-- próprios preservados (conteúdo nunca fica preso).

-- follow: corpo = 20261007090000 + gate (target público + não-blocked).
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

  if public.users_are_blocked(v_me, v_target) then
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

-- like: corpo = 20261007090000 + gate.
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

  if public.users_are_blocked(v_me, v_owner) then
    raise exception 'Avaliação indisponível.';
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

-- comment: corpo = 20261008090000 + gate (após self, antes de allows).
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

  if public.users_are_blocked(v_me, v_owner) then
    raise exception 'Esta avaliação não está disponível.';
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

  -- INSERT direto (identity recém-criado, sempre novo; sem ON CONFLICT
  -- ambíguo com OUT params — aprendizado 42702 da Etapa 21).
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

-- reply create: corpo = 20261009090000 + gate duplo (owner E parent).
create or replace function public.create_rating_comment_reply(
  p_comment_id bigint,
  p_text text
)
returns table (
  reply_id bigint,
  reply_text text,
  created_at timestamptz,
  updated_at timestamptz,
  author_is_private boolean,
  author_display_name text,
  author_username text,
  author_avatar_path text,
  can_edit boolean,
  can_delete boolean,
  reply_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_parent_author uuid;
  v_rating_owner uuid;
  v_media text;
  v_tmdb bigint;
  v_allows boolean;
  v_text text;
  v_reply_id bigint;
begin
  if v_me is null then
    raise exception 'Comentário indisponível.';
  end if;

  if p_comment_id is null or p_comment_id < 1 then
    raise exception 'Comentário indisponível.';
  end if;

  v_text := trim(coalesce(p_text, ''));
  if char_length(v_text) < 1 or char_length(v_text) > 500 then
    raise exception 'Resposta inválida.';
  end if;

  select c.author_id, c.rating_owner_id, c.media_type, c.tmdb_id,
         (op.allow_rating_comments is true)
    into v_parent_author, v_rating_owner, v_media, v_tmdb, v_allows
  from public.rating_comments as c
  join public.profiles as op
    on op.id = c.rating_owner_id
  join public.ratings as r
    on r.user_id = c.rating_owner_id
   and r.media_type = c.media_type
   and r.tmdb_id = c.tmdb_id
  where c.id = p_comment_id
    and op.profile_public is true
    and op.show_ratings is true;

  if v_parent_author is null then
    raise exception 'Comentário indisponível.';
  end if;

  if v_parent_author = v_me then
    raise exception 'Você não pode responder ao próprio comentário.';
  end if;

  if public.users_are_blocked(v_me, v_rating_owner)
     or public.users_are_blocked(v_me, v_parent_author) then
    raise exception 'Comentário indisponível.';
  end if;

  if v_allows is not true then
    raise exception 'Novas respostas estão desativadas nesta avaliação.';
  end if;

  insert into public.rating_comment_replies (comment_id, author_id, reply_text)
  values (p_comment_id, v_me, v_text);

  -- Releitura qualificada (sem RETURNING ambíguo — aprendizado 42702).
  select rp.id into v_reply_id
  from public.rating_comment_replies as rp
  where rp.comment_id = p_comment_id
    and rp.author_id = v_me
  order by rp.id desc
  limit 1;

  if v_reply_id is null then
    raise exception 'Comentário indisponível.';
  end if;

  -- INSERT direto (identity recém-criado, sempre novo; sem ON CONFLICT
  -- ambíguo com OUT params — aprendizado 42702 da Etapa 21).
  insert into public.notifications (recipient_id, actor_id, type, comment_id, reply_id)
  values (v_parent_author, v_me, 'comment_reply', p_comment_id, v_reply_id);

  return query
  select
    rp.id as reply_id,
    rp.reply_text as reply_text,
    rp.created_at as created_at,
    rp.updated_at as updated_at,
    (ap.profile_public is not true) as author_is_private,
    case when ap.profile_public is true then ap.display_name else null end as author_display_name,
    case when ap.profile_public is true then ap.username else null end as author_username,
    case when ap.profile_public is true then ap.avatar_path else null end as author_avatar_path,
    true as can_edit,
    true as can_delete,
    (select count(*)
     from public.rating_comment_replies as rest
     where rest.comment_id = p_comment_id) as reply_count
  from public.rating_comment_replies as rp
  join public.profiles as ap
    on ap.id = rp.author_id
  where rp.id = v_reply_id;
end;
$$;

-- ============================ 11. GATES DE LEITURA (viewer-specific)
-- Comentários/replies de autores blocked com o viewer somem para ele
-- (terceiros/anon continuam vendo). Contadores coerentes com a thread.

-- list comments: corpo = 20261009090000 + filtro de autor + reply_count
-- só com replies visíveis.
create or replace function public.get_public_rating_comments(
  p_username text,
  p_tmdb_id bigint,
  p_media_type text,
  p_limit integer,
  p_offset integer
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
  viewer_is_owner boolean,
  reply_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 24);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_media_type not in ('movie', 'tv') then
    return;
  end if;

  if p_tmdb_id is null or p_tmdb_id < 1 then
    return;
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
    return;
  end if;

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
    (v_me is not null and c.author_id = v_me) as can_edit,
    (v_me is not null and (c.author_id = v_me or c.rating_owner_id = v_me)) as can_delete,
    (v_me is not null and v_owner = v_me) as viewer_is_owner,
    (select count(*)
     from public.rating_comment_replies as rp
     where rp.comment_id = c.id
       and not public.users_are_blocked(v_me, rp.author_id)) as reply_count
  from public.rating_comments as c
  join public.profiles as ap
    on ap.id = c.author_id
  where c.rating_owner_id = v_owner
    and c.media_type = p_media_type
    and c.tmdb_id = p_tmdb_id
    and not public.users_are_blocked(v_me, c.author_id)
  order by c.created_at desc, c.id desc
  limit v_limit
  offset v_offset;
end;
$$;

-- list replies: corpo = 20261009090000 + filtro de autor.
create or replace function public.get_public_rating_comment_replies(
  p_comment_id bigint,
  p_limit integer,
  p_offset integer
)
returns table (
  reply_id bigint,
  reply_text text,
  created_at timestamptz,
  updated_at timestamptz,
  author_is_private boolean,
  author_display_name text,
  author_username text,
  author_avatar_path text,
  can_edit boolean,
  can_delete boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 24);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_visible boolean := false;
begin
  if p_comment_id is null or p_comment_id < 1 then
    return;
  end if;

  select true into v_visible
  from public.rating_comments as c
  join public.profiles as op
    on op.id = c.rating_owner_id
  join public.ratings as r
    on r.user_id = c.rating_owner_id
   and r.media_type = c.media_type
   and r.tmdb_id = c.tmdb_id
  where c.id = p_comment_id
    and op.profile_public is true
    and op.show_ratings is true;

  if v_visible is not true then
    return;
  end if;

  return query
  select
    rp.id as reply_id,
    rp.reply_text as reply_text,
    rp.created_at as created_at,
    rp.updated_at as updated_at,
    (ap.profile_public is not true) as author_is_private,
    case when ap.profile_public is true then ap.display_name else null end as author_display_name,
    case when ap.profile_public is true then ap.username else null end as author_username,
    case when ap.profile_public is true then ap.avatar_path else null end as author_avatar_path,
    (v_me is not null and rp.author_id = v_me) as can_edit,
    (v_me is not null and (rp.author_id = v_me or c.rating_owner_id = v_me)) as can_delete
  from public.rating_comment_replies as rp
  join public.rating_comments as c
    on c.id = rp.comment_id
  join public.profiles as ap
    on ap.id = rp.author_id
  where rp.comment_id = p_comment_id
    and not public.users_are_blocked(v_me, rp.author_id)
  order by rp.created_at asc, rp.id asc
  limit v_limit
  offset v_offset;
end;
$$;

-- batch comment states: corpo = 20261005090000 + gate no valid +
-- comment_count só com autores visíveis (coerente com a thread).
create or replace function public.get_public_rating_comment_states(
  p_targets jsonb
)
returns table (
  username text,
  tmdb_id bigint,
  media_type text,
  comment_count bigint,
  comments_enabled boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with targets as (
    select
      lower(trim(t.value ->> 'username')) as username,
      (t.value ->> 'tmdb_id')::bigint as tmdb_id,
      (t.value ->> 'media_type') as media_type
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) with ordinality as t(value, ord)
    where t.ord <= 24
  ),
  valid as (
    select t.username, t.tmdb_id, t.media_type, p.id as owner_id,
      (p.allow_rating_comments is true) as comments_enabled
    from targets as t
    join public.profiles as p
      on p.username = t.username
    join public.ratings as r
      on r.user_id = p.id
     and r.media_type = t.media_type
     and r.tmdb_id = t.tmdb_id
    where t.username ~ '^[a-z0-9_]{3,24}$'
      and t.media_type in ('movie', 'tv')
      and t.tmdb_id >= 1
      and p.profile_public is true
      and p.show_ratings is true
      and not public.users_are_blocked(auth.uid(), p.id)
  )
  select
    v.username as username,
    v.tmdb_id as tmdb_id,
    v.media_type as media_type,
    (select count(*)
     from public.rating_comments as c
     where c.rating_owner_id = v.owner_id
       and c.media_type = v.media_type
       and c.tmdb_id = v.tmdb_id
       and not public.users_are_blocked(auth.uid(), c.author_id)) as comment_count,
    v.comments_enabled as comments_enabled
  from valid as v;
$$;

-- batch like states: corpo = 20261004090000 + gate no valid
-- (like_count agregado preservado; row some para par blocked).
create or replace function public.get_public_rating_like_states(
  p_targets jsonb
)
returns table (
  username text,
  tmdb_id bigint,
  media_type text,
  like_count bigint,
  liked_by_viewer boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with targets as (
    select
      lower(trim(t.value ->> 'username')) as username,
      (t.value ->> 'tmdb_id')::bigint as tmdb_id,
      (t.value ->> 'media_type') as media_type
    from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) with ordinality as t(value, ord)
    where t.ord <= 24
  ),
  valid as (
    select t.username, t.tmdb_id, t.media_type, p.id as owner_id
    from targets as t
    join public.profiles as p
      on p.username = t.username
    join public.ratings as r
      on r.user_id = p.id
     and r.media_type = t.media_type
     and r.tmdb_id = t.tmdb_id
    where t.username ~ '^[a-z0-9_]{3,24}$'
      and t.media_type in ('movie', 'tv')
      and t.tmdb_id >= 1
      and p.profile_public is true
      and p.show_ratings is true
      and not public.users_are_blocked(auth.uid(), p.id)
  )
  select
    v.username as username,
    v.tmdb_id as tmdb_id,
    v.media_type as media_type,
    (select count(*)
     from public.rating_likes as l
     where l.rating_owner_id = v.owner_id
       and l.media_type = v.media_type
       and l.tmdb_id = v.tmdb_id) as like_count,
    exists (
      select 1
      from public.rating_likes as l
      where l.rating_owner_id = v.owner_id
        and l.media_type = v.media_type
        and l.tmdb_id = v.tmdb_id
        and l.liker_id = auth.uid()
    ) as liked_by_viewer
  from valid as v;
$$;

-- ================== 12. GATES: SEARCH + FEED + PERFIS + FOLLOWS
-- Mesmo padrão: corpo idêntico + `and not users_are_blocked`.
-- Anon (auth.uid() NULL) mantém comportamento atual (helper null-safe).

-- search: corpo = 20260930090000 + exclusão bilateral p/ autenticado.
create or replace function public.search_public_profiles(
  p_query text,
  p_limit integer
)
returns table (
  display_name text,
  username text,
  bio text,
  avatar_path text
)
language sql
stable
security definer
set search_path = public
as $$
  with normalized as (
    select lower(
      case
        when left(trim(both from coalesce(p_query, '')), 1) = '@'
          then substring(trim(both from coalesce(p_query, '')) from 2)
        else trim(both from coalesce(p_query, ''))
      end
    ) as raw
  ),
  -- Escapa curingas do LIKE vindos do usuário (%, _ e a própria barra).
  escaped as (
    select replace(
      replace(replace(raw, '\', '\\'), '%', '\%'),
      '_', '\_'
    ) as pat,
    raw
    from normalized
  )
  select
    p.display_name,
    p.username,
    p.bio,
    p.avatar_path
  from public.profiles as p, escaped as e
  where char_length(e.raw) >= 2
    and p.profile_public is true
    and p.discoverable is true
    and p.username is not null
    and not public.users_are_blocked(auth.uid(), p.id)
    and (
      p.username ilike e.pat || '%' escape '\'
      or p.username ilike '%' || e.pat || '%' escape '\'
      or p.display_name ilike e.pat || '%' escape '\'
      or p.display_name ilike '%' || e.pat || '%' escape '\'
    )
  order by
    case
      when p.username = e.raw then 0
      when p.username ilike e.pat || '%' escape '\' then 1
      when p.username ilike '%' || e.pat || '%' escape '\' then 2
      when p.display_name ilike e.pat || '%' escape '\' then 3
      else 4
    end,
    p.username asc
  limit least(greatest(coalesce(p_limit, 10), 1), 20);
$$;

-- feed: corpo = 20261003090000 + gate no CTE actors (cobre os 3 ramos).
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
      and not public.users_are_blocked(auth.uid(), p.id)
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

-- profile: corpo = 20260929090000 + gate (0 rows = 404 genérico no app).
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
    and p.profile_public is true
    and not public.users_are_blocked(auth.uid(), p.id);
$$;

create or replace function public.get_public_favorites(p_username text)
returns table (
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer,
  "position" integer
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
    pk."position" as "position"
  from public.profiles as p
  join public.profile_picks as pk
    on pk.user_id = p.id
   and pk.kind = 'favorite'
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_favorites is true
    and not public.users_are_blocked(auth.uid(), p.id)
  order by pk."position" asc;
$$;

create or replace function public.get_public_recommendations(p_username text)
returns table (
  tmdb_id bigint,
  media_type text,
  title text,
  poster_path text,
  release_year integer,
  note text,
  "position" integer
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
    pk."position" as "position"
  from public.profiles as p
  join public.profile_picks as pk
    on pk.user_id = p.id
   and pk.kind = 'recommendation'
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and p.show_recommendations is true
    and not public.users_are_blocked(auth.uid(), p.id)
  order by pk."position" asc;
$$;

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
    and not public.users_are_blocked(auth.uid(), p.id)
  order by w.watched_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

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
    and not public.users_are_blocked(auth.uid(), p.id)
  order by r.updated_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- followers/following/counts: corpos = 20261001090000 + exclusão de
-- quem tem block com o viewer (listas de terceiros incluídas).
create or replace function public.get_public_followers(
  p_username text,
  p_limit integer,
  p_offset integer
)
returns table (
  display_name text,
  username text,
  bio text,
  avatar_path text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    fp.display_name,
    fp.username,
    fp.bio,
    fp.avatar_path
  from public.profiles as p
  join public.follows as f
    on f.following_id = p.id
  join public.profiles as fp
    on fp.id = f.follower_id
   and fp.profile_public is true
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and not public.users_are_blocked(auth.uid(), p.id)
    and not public.users_are_blocked(auth.uid(), fp.id)
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_public_following(
  p_username text,
  p_limit integer,
  p_offset integer
)
returns table (
  display_name text,
  username text,
  bio text,
  avatar_path text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    tp.display_name,
    tp.username,
    tp.bio,
    tp.avatar_path
  from public.profiles as p
  join public.follows as f
    on f.follower_id = p.id
  join public.profiles as tp
    on tp.id = f.following_id
   and tp.profile_public is true
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and not public.users_are_blocked(auth.uid(), p.id)
    and not public.users_are_blocked(auth.uid(), tp.id)
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_public_follow_counts(p_username text)
returns table (
  followers_count bigint,
  following_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)
     from public.follows as f
     where f.following_id = p.id
       and not public.users_are_blocked(auth.uid(), f.follower_id)) as followers_count,
    (select count(*)
     from public.follows as f
     join public.profiles as t
       on t.id = f.following_id
      and t.profile_public is true
     where f.follower_id = p.id
       and not public.users_are_blocked(auth.uid(), f.following_id)) as following_count
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true
    and not public.users_are_blocked(auth.uid(), p.id);
$$;

-- ==================== 13. DEFESA NA INBOX (rows residuais/race)
-- O cleanup do block apaga as cross; o filtro garante list/unread
-- sempre coerentes mesmo assim.
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
  reply_text text,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with src as (
    select
      n.*,
      case when n.type = 'comment_reply' then rc.rating_owner_id else n.recipient_id end as title_owner_id,
      case when n.type = 'comment_reply' then rc.media_type else n.media_type end as src_media_type,
      case when n.type = 'comment_reply' then rc.tmdb_id else n.tmdb_id end as src_tmdb_id
    from public.notifications as n
    left join public.rating_comments as rc
      on rc.id = n.comment_id
     and n.type = 'comment_reply'
  )
  select
    src.id as notification_id,
    src.type as type,
    (ap.profile_public is not true) as actor_is_private,
    case when ap.profile_public is true then ap.display_name else null end as actor_display_name,
    case when ap.profile_public is true then ap.username else null end as actor_username,
    case when ap.profile_public is true then ap.avatar_path else null end as actor_avatar_path,
    case when src.type = 'comment_reply' then src.src_media_type else src.media_type end as media_type,
    case when src.type = 'comment_reply' then src.src_tmdb_id else src.tmdb_id end as tmdb_id,
    w.title as title,
    w.poster_path as poster_path,
    w.release_year as release_year,
    c.comment_text as comment_text,
    rp.reply_text as reply_text,
    src.created_at as created_at,
    src.read_at as read_at
  from src
  join public.profiles as ap
    on ap.id = src.actor_id
  left join public.watched_titles as w
    on w.user_id = src.title_owner_id
   and w.media_type = src.src_media_type
   and w.tmdb_id = src.src_tmdb_id
  left join public.rating_comments as c
    on c.id = src.comment_id
   and src.type = 'rating_comment'
  left join public.rating_comment_replies as rp
    on rp.id = src.reply_id
   and src.type = 'comment_reply'
  where src.recipient_id = auth.uid()
    and auth.uid() is not null
    and not public.users_are_blocked(src.recipient_id, src.actor_id)
  order by src.created_at desc, src.id desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

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
    and n.read_at is null
    and not public.users_are_blocked(n.recipient_id, n.actor_id);
$$;

-- mark read: corpo = 20261007090000 + unread coerente com a inbox
-- (exclui actor blocked; o UPDATE em si não muda — marcar row
-- invisível como lida é inofensivo e mantém o badge consistente).
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
      and n.read_at is null
      and not public.users_are_blocked(n.recipient_id, n.actor_id);
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
    and n.read_at is null
    and not public.users_are_blocked(n.recipient_id, n.actor_id);
end;
$$;

-- ------------------------------------------------------------- 14. Grants
-- Redefinições preservam grants antigos; aqui só as 6 RPCs novas.
revoke all on function public.block_user_by_username(text) from public;
revoke all on function public.block_my_follower(bigint) from public;
revoke all on function public.unblock_user(bigint) from public;
revoke all on function public.get_my_blocked_users(integer, integer) from public;
revoke all on function public.get_my_followers(integer, integer) from public;
revoke all on function public.remove_my_follower(bigint) from public;

grant execute on function public.block_user_by_username(text) to authenticated;
grant execute on function public.block_my_follower(bigint) to authenticated;
grant execute on function public.unblock_user(bigint) to authenticated;
grant execute on function public.get_my_blocked_users(integer, integer) to authenticated;
grant execute on function public.get_my_followers(integer, integer) to authenticated;
grant execute on function public.remove_my_follower(bigint) to authenticated;

-- PostgREST schema cache: follows ganhou coluna id; shapes inalterados.
notify pgrst, 'reload schema';
