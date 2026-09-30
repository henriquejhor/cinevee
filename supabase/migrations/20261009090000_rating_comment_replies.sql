-- CineVee · Etapa 22 — Respostas em comentários (1 nível) + notification.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto, DEPOIS de
--   20261008090000_fix_comment_notifications.sql.
--
-- O que esta migration faz:
--   1. cria public.rating_comment_replies (comment raiz + autor + texto
--      1..500 + created/updated) com FKs em cascata (comment apagado →
--      replies somem; rating/unwatch cascateiam via comments; autor
--      apagado → replies somem). Tabela separada = 1 nível por
--      construção (reply nunca tem filha);
--   2. índice (comment_id, created_at ASC, id ASC) — leitura cronológica;
--   3. RLS sem policies (nenhum acesso direto; tudo via RPC);
--   4. 4 RPCs (SD, search_path fixo, sem SQL dinâmica, sem identificadores
--      ambíguos — vars v_* / params p_*, colunas qualificadas; aprendizado
--      42702 das Etapas 19/21):
--        - get_public_rating_comment_replies (STABLE; anon+auth; só thread
--          pública profile_public+show_ratings; ordem cronológica);
--        - create_rating_comment_reply (VOLATILE; gates = create de
--          comentário incl. allow_rating_comments; self-reply → 409;
--          insere reply + notification comment_reply na mesma transação);
--        - update_rating_comment_reply (VOLATILE; só autor; updated=now);
--        - delete_rating_comment_reply (VOLATILE; autor ou rating owner);
--   5. reply_count em get_public_rating_comments (DROP da assinatura
--      exata + CREATE: 42P13 impede CREATE OR REPLACE com OUT novo);
--   6. notifications: coluna reply_id (FK cascade) + type passa a aceitar
--      comment_reply + shape (media/tmdb NULL, comment/reply NOT NULL) +
--      unique partial (reply_id) — media/tmdb NULL mantém a FK composta
--      fora do caminho (MATCH SIMPLE), pois recipient da reply é o autor
--      do comentário, não o rating owner;
--   7. redefine get_my_notifications (DROP + CREATE pelo mesmo 42P13;
--      follow/like/comment preservados) com reply_text + title derivado
--      do parent (comment → owner/media/tmdb → watched snapshot; sem TMDB);
--   8. grants mínimos (reads anon+auth; writes/inbox só authenticated)
--      restaurados após os DROPs + notify pgrst reload (shapes mudaram).
--
-- O que esta migration NÃO faz:
--   - NÃO edita migrations antigas (só CREATE OR REPLACE pontuais);
--   - NÃO cria triggers/Realtime/replies de replies/likes em reply;
--   - NÃO expõe author_id/UUID/email/flags;
--   - NÃO toca feed/TasteProfile/ranking;
--   - NÃO usa service_role em lugar nenhum do app.

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.rating_comment_replies (
  id bigint generated always as identity primary key,
  comment_id bigint not null references public.rating_comments (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  reply_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rating_comment_replies_text_length
    check (char_length(reply_text) >= 1 and char_length(reply_text) <= 500)
);

-- ------------------------------------------------------------- 2. Índice
-- Leitura cronológica da conversa (mais antiga → mais nova).
create index if not exists rating_comment_replies_thread_idx
  on public.rating_comment_replies (comment_id, created_at asc, id asc);

-- ----------------------------------------------------------------- 3. RLS
alter table public.rating_comment_replies enable row level security;

-- ------------------------------------------- 4. RPC: listar (cronológica)
-- Só se a thread raiz for publicamente visível (owner public +
-- show_ratings). allow_rating_comments NÃO é gate de leitura (replies
-- existentes continuam visíveis). Anon lê; 404 genérico se escondido.
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
  order by rp.created_at asc, rp.id asc
  limit v_limit
  offset v_offset;
end;
$$;

-- --------------------------------------------- 5. RPC: criar + notificar
-- Gates = create de comentário (thread pública + allow). Self-reply
-- (autor responde o próprio comentário) → exceção própria (409).
-- Notification comment_reply: recipient = autor do parent, actor = eu.
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

-- ----------------------------------------------- 6. RPC: editar (só autor)
-- Funciona mesmo com thread escondida/desativada (conteúdo próprio
-- nunca fica preso). Não cria notification; não toca created_at.
create or replace function public.update_rating_comment_reply(
  p_reply_id bigint,
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
  can_delete boolean
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_text text;
begin
  if v_me is null then
    raise exception 'Resposta indisponível.';
  end if;

  if p_reply_id is null or p_reply_id < 1 then
    raise exception 'Resposta indisponível.';
  end if;

  v_text := trim(coalesce(p_text, ''));
  if char_length(v_text) < 1 or char_length(v_text) > 500 then
    raise exception 'Resposta inválida.';
  end if;

  update public.rating_comment_replies as rp
  set reply_text = v_text,
      updated_at = now()
  where rp.id = p_reply_id
    and rp.author_id = v_me;

  if not found then
    raise exception 'Resposta indisponível.';
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
    true as can_edit,
    true as can_delete
  from public.rating_comment_replies as rp
  join public.profiles as ap
    on ap.id = rp.author_id
  where rp.id = p_reply_id;
end;
$$;

-- ----------------------- 7. RPC: apagar (autor ou dono da rating, modera)
-- Funciona mesmo com a thread escondida. Retorna o count restante do
-- parent (para o replyCount não precisar de request extra).
create or replace function public.delete_rating_comment_reply(
  p_reply_id bigint
)
returns table (
  removed boolean,
  reply_count bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_comment_id bigint;
begin
  if v_me is null then
    raise exception 'Resposta indisponível.';
  end if;

  if p_reply_id is null or p_reply_id < 1 then
    raise exception 'Resposta indisponível.';
  end if;

  select rp.comment_id into v_comment_id
  from public.rating_comment_replies as rp
  where rp.id = p_reply_id;

  if v_comment_id is null then
    raise exception 'Resposta indisponível.';
  end if;

  delete from public.rating_comment_replies as rp
  using public.rating_comments as c
  where rp.id = p_reply_id
    and c.id = rp.comment_id
    and (rp.author_id = v_me or c.rating_owner_id = v_me);

  if not found then
    raise exception 'Resposta indisponível.';
  end if;

  return query
  select true as removed, count(*) as reply_count
  from public.rating_comment_replies as rest
  where rest.comment_id = v_comment_id;
end;
$$;

-- ----------------- 8. reply_count no list de comentários (corpo idêntico)
-- Único acréscimo: OUT reply_count via subquery. commentCount global e
-- demais contratos preservados (feed/perfil inalterados).
-- 42P13: PostgreSQL NÃO permite mudar OUT params via CREATE OR REPLACE —
-- DROP da assinatura exata antes de recriar (idempotente na reexecução).
drop function if exists public.get_public_rating_comments(
  text,
  bigint,
  text,
  integer,
  integer
);

create function public.get_public_rating_comments(
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
     where rp.comment_id = c.id) as reply_count
  from public.rating_comments as c
  join public.profiles as ap
    on ap.id = c.author_id
  where c.rating_owner_id = v_owner
    and c.media_type = p_media_type
    and c.tmdb_id = p_tmdb_id
  order by c.created_at desc, c.id desc
  limit v_limit
  offset v_offset;
end;
$$;

-- -------------------------------- 9. notifications: reply_id + novo tipo
alter table public.notifications
  add column if not exists reply_id bigint references public.rating_comment_replies (id) on delete cascade;

-- CHECKs antigos citavam só 3 tipos: recria com comment_reply.
alter table public.notifications
  drop constraint if exists notifications_shape_by_type;
alter table public.notifications
  add constraint notifications_shape_by_type check (
    (type = 'follow'
      and media_type is null and tmdb_id is null and comment_id is null and reply_id is null)
    or (type = 'rating_like'
      and media_type is not null and tmdb_id is not null and comment_id is null and reply_id is null)
    or (type = 'rating_comment'
      and media_type is not null and tmdb_id is not null and comment_id is not null and reply_id is null)
    or (type = 'comment_reply'
      and media_type is null and tmdb_id is null and comment_id is not null and reply_id is not null)
  );

alter table public.notifications
  drop constraint if exists notifications_type_allowed;
alter table public.notifications
  add constraint notifications_type_allowed check (type in ('follow', 'rating_like', 'rating_comment', 'comment_reply'));

-- Cada reply gera exatamente 1 notification.
create unique index if not exists notifications_unique_reply
  on public.notifications (reply_id)
  where type = 'comment_reply';

-- --------------------------- 10. inbox redefine (suporta comment_reply)
-- follow/like/comment preservados; reply: actor dinâmico, texto atual
-- da reply, título via parent (comment → owner/media/tmdb → watched do
-- owner). Sem TMDB, sem UUID/email/flags na saída.
-- 42P13: RETURNS TABLE ganhou reply_text → DROP da assinatura exata
-- antes de recriar (idempotente na reexecução).
drop function if exists public.get_my_notifications(
  integer,
  integer
);

create function public.get_my_notifications(
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
  order by src.created_at desc, src.id desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ------------------------------------------------------------- 11. Grants
-- DROP FUNCTION remove grants: restaura explicitamente (Etapa 19 tinha
-- get_public_rating_comments em anon+authenticated; inbox só auth).
revoke all on function public.get_public_rating_comment_replies(bigint, integer, integer) from public;
revoke all on function public.create_rating_comment_reply(bigint, text) from public;
revoke all on function public.update_rating_comment_reply(bigint, text) from public;
revoke all on function public.delete_rating_comment_reply(bigint) from public;
revoke all on function public.get_public_rating_comments(text, bigint, text, integer, integer) from public;
revoke all on function public.get_my_notifications(integer, integer) from public;

grant execute on function public.get_public_rating_comment_replies(bigint, integer, integer) to anon, authenticated;
grant execute on function public.create_rating_comment_reply(bigint, text) to authenticated;
grant execute on function public.update_rating_comment_reply(bigint, text) to authenticated;
grant execute on function public.delete_rating_comment_reply(bigint) to authenticated;
grant execute on function public.get_public_rating_comments(text, bigint, text, integer, integer) to anon, authenticated;
-- Inbox redefinida: mantém só authenticated (revoke acima removeu tudo).
grant execute on function public.get_my_notifications(integer, integer) to authenticated;

-- PostgREST schema cache: shapes de RPC mudaram (reply_count, reply_text).
notify pgrst, 'reload schema';
