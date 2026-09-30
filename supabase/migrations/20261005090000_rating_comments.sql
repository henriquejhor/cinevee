-- CineVee · Etapa 19 — Comentários em avaliações (public.rating_comments).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto, DEPOIS da Etapa 18
--   (20261004090000_rating_likes.sql).
--
-- O que esta migration faz:
--   1. adiciona profiles.allow_rating_comments (boolean NOT NULL
--      DEFAULT false): controla SOMENTE a criação de NOVOS comentários.
--      Nenhuma conta existente passa a receber comentários sozinha;
--   2. cria public.rating_comments (id identity PK, author_id,
--      rating_owner_id, tmdb_id, media_type, comment_text ≤500,
--      created_at/updated_at) com CHECK anti self-comment e FKs em
--      cascata;
--   3. FK composta (rating_owner_id, media_type, tmdb_id) → ratings
--      (user_id, media_type, tmdb_id), NA ORDEM da UNIQUE existente:
--      removeu rating (ou unwatch em cascata) → comentários somem juntos;
--   4. índices para thread (owner, media, tmdb, created DESC, id DESC)
--      + author_id; RLS (insert/update/delete próprios ou do dono da
--      rating; sem SELECT amplo);
--   5. cria 5 RPCs (search_path fixo, só o necessário, sem SQL dinâmica):
--        - get_public_rating_comments (anon+auth; thread paginada da
--          rating pública; identidade do autor anonimizada quando o
--          autor é privado; can_edit/can_delete pelo viewer);
--        - create_rating_comment_by_username (auth; VOLATILE; exige
--          rating pública + allow_rating_comments + não-owner);
--        - update_rating_comment (auth; VOLATILE; só o autor; funciona
--          mesmo com a thread escondida/desativada);
--        - delete_rating_comment (auth; VOLATILE; autor OU dono da
--          rating; funciona mesmo com a thread escondida/desativada);
--        - get_public_rating_comment_states (anon+auth; lote de até 24
--          targets; commentCount + commentsEnabled, sem UUID);
--   6. concede EXECUTE mínimo por função.
--
-- O que esta migration NÃO faz:
--   - NÃO cria respostas/replies, likes em comentários, notificações,
--     mentions, denúncias ou ranking por comentários;
--   - NÃO expõe author_id/owner UUID/email/flags em nenhuma RPC;
--   - NÃO usa discoverable, show_activity ou show_reviews como gate
--     (só profile_public + show_ratings + rating; criação exige ainda
--     allow_rating_comments);
--   - NÃO cria evento de feed para comentário (feed segue activityAt);
--   - NÃO usa service_role em lugar nenhum do app.
--
-- Decisões de privacidade (documentadas):
--   - allow_rating_comments=false bloqueia só NOVOS comentários; a thread
--     existente continua visível (profile_public + show_ratings) e
--     edit/delete continuam funcionando (sem comentário impossível de
--     remover);
--   - comment_count público = TOTAL de comentários (autores privados
--     contam numericamente; identidades privadas nunca são expostas);
--   - autor privado PODE comentar (ação pública deliberada): o texto é
--     público, a identidade vira "Usuário privado" (sem username/avatar);
--   - despublicar/desligar show_ratings NÃO apaga rows: a thread some do
--     público e reaparece se voltar (relação preservada por UUID).

-- --------------------------------------- 1. Flag de novos comentários
alter table public.profiles
  add column if not exists allow_rating_comments boolean not null default false;

-- ---------------------------------------------------------------- 2. Tabela
-- Tipos idênticos aos de ratings (uuid/bigint/text); ordem da FK igual
-- à da UNIQUE ratings_unique_item (user_id, media_type, tmdb_id).
-- id próprio (identity): um autor pode comentar N vezes; edit/delete e
-- moderação do dono identificam a row sem expor UUID de usuário.
create table if not exists public.rating_comments (
  id bigint generated always as identity primary key,
  author_id uuid not null references auth.users (id) on delete cascade,
  rating_owner_id uuid not null,
  tmdb_id bigint not null,
  media_type text not null,
  comment_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rating_comments_rating_fk
    foreign key (rating_owner_id, media_type, tmdb_id)
    references public.ratings (user_id, media_type, tmdb_id)
    on delete cascade,
  constraint rating_comments_no_self
    check (author_id <> rating_owner_id),
  constraint rating_comments_media_type_allowed
    check (media_type in ('movie', 'tv')),
  constraint rating_comments_text_length
    check (char_length(comment_text) >= 1 and char_length(comment_text) <= 500)
);

-- ------------------------------------------------------------- 3. Índices
-- Thread: owner + título, mais recentes primeiro (created DESC, id DESC
-- como desempate estável — edit NÃO reordena).
create index if not exists rating_comments_thread_idx
  on public.rating_comments (rating_owner_id, media_type, tmdb_id, created_at desc, id desc);

-- Moderação/limpeza pelos próprios comentários do autor.
create index if not exists rating_comments_author_idx
  on public.rating_comments (author_id);

-- ------------------------------------------------------------- 4. RLS
alter table public.rating_comments enable row level security;

-- Insert: só o próprio autor (o app usa a RPC; a policy cobre seeds e
-- permite ao autor limpar as próprias rows sem service_role).
drop policy if exists "rating_comments_insert_own" on public.rating_comments;
create policy "rating_comments_insert_own"
  on public.rating_comments
  for insert
  to authenticated
  with check (author_id = auth.uid());

-- Update: só o autor edita o próprio comentário.
drop policy if exists "rating_comments_update_own" on public.rating_comments;
create policy "rating_comments_update_own"
  on public.rating_comments
  for update
  to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- Delete: o autor apaga o próprio; o dono da rating remove qualquer
-- comentário da própria rating (moderação, mesmo com thread escondida).
drop policy if exists "rating_comments_delete_managed" on public.rating_comments;
create policy "rating_comments_delete_managed"
  on public.rating_comments
  for delete
  to authenticated
  using (author_id = auth.uid() or rating_owner_id = auth.uid());

-- Sem política de SELECT: leitura direta bloqueada (até para os
-- envolvidos verem a tabela crua); thread/counts passam pelas RPCs.
-- Sem acesso anônimo: só authenticated nas próprias rows/moderadas.

-- --------------------------------------------- 5. RPC: listar thread
-- Thread pública existe SOMENTE se profile_public + show_ratings + rating
-- existe (allow_rating_comments NÃO bloqueia leitura). Autor privado →
-- identidade anonimizada ("Usuário privado", sem username/avatar/link),
-- texto preservado. can_edit/can_delete pelo viewer (anon: ambos false).
-- Ordenação fixa: created_at DESC, id DESC (edit não reordena).
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
  viewer_is_owner boolean
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
    (v_me is not null and v_owner = v_me) as viewer_is_owner
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

-- --------------------------------------------- 6. RPC: criar
-- Exige: rating pública + allow_rating_comments + viewer não é o dono.
-- Self → exceção própria (409); desativado → exceção própria (403);
-- privado/inexistente/sem rating → genérico (404, sem oracle).
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
  v_id bigint;
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

  -- Sem RETURNING: `created_at` sem qualificador colidiria com o
  -- parâmetro OUT de mesmo nome (erro 42702 "column reference is
  -- ambiguous"). Releitura qualificada da row recém-inserida (maior id
  -- visível para este autor+rating na transação).
  select c.id into v_id
  from public.rating_comments as c
  where c.author_id = v_me
    and c.rating_owner_id = v_owner
    and c.media_type = p_media_type
    and c.tmdb_id = p_tmdb_id
  order by c.id desc
  limit 1;

  if v_id is null then
    raise exception 'Esta avaliação não está disponível.';
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
  where c.id = v_id;
end;
$$;

-- --------------------------------------------- 7. RPC: editar
-- Só o autor (rating owner NÃO edita alheio). Funciona mesmo com a
-- thread escondida/desativada (edit não cria conteúdo novo). updated_at
-- muda; created_at nunca muda (edit não reordena).
create or replace function public.update_rating_comment(
  p_comment_id bigint,
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
    raise exception 'Comentário indisponível.';
  end if;

  if p_comment_id is null or p_comment_id < 1 then
    raise exception 'Comentário indisponível.';
  end if;

  v_text := trim(coalesce(p_comment_text, ''));
  if char_length(v_text) < 1 or char_length(v_text) > 500 then
    raise exception 'Comentário inválido.';
  end if;

  update public.rating_comments as c
  set comment_text = v_text,
      updated_at = now()
  where c.id = p_comment_id
    and c.author_id = v_me;

  if not found then
    raise exception 'Comentário indisponível.';
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
    true as can_edit,
    true as can_delete
  from public.rating_comments as c
  join public.profiles as ap
    on ap.id = c.author_id
  where c.id = p_comment_id;
end;
$$;

-- --------------------------------------------- 8. RPC: apagar
-- Autor OU dono da rating (moderação: dono remove, nunca edita).
-- Funciona mesmo com a thread escondida/desativada (sem comentário
-- impossível de remover). Retorna o contador restante da thread.
create or replace function public.delete_rating_comment(
  p_comment_id bigint
)
returns table (
  removed boolean,
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
  v_media text;
  v_tmdb bigint;
begin
  if v_me is null then
    raise exception 'Comentário indisponível.';
  end if;

  if p_comment_id is null or p_comment_id < 1 then
    raise exception 'Comentário indisponível.';
  end if;

  select c.rating_owner_id, c.media_type, c.tmdb_id
    into v_owner, v_media, v_tmdb
  from public.rating_comments as c
  where c.id = p_comment_id;

  if v_owner is null then
    raise exception 'Comentário indisponível.';
  end if;

  delete from public.rating_comments as c
  where c.id = p_comment_id
    and (c.author_id = v_me or c.rating_owner_id = v_me);

  if not found then
    raise exception 'Comentário indisponível.';
  end if;

  return query
  select true as removed, count(*) as comment_count
  from public.rating_comments as rest
  where rest.rating_owner_id = v_owner
    and rest.media_type = v_media
    and rest.tmdb_id = v_tmdb;
end;
$$;

-- --------------------------------------------- 9. RPC: states em lote
-- Até 24 targets [{username, tmdb_id, media_type}]. Retorna SOMENTE
-- ratings publicamente visíveis (profile_public + show_ratings + rating
-- existe) — privado/escondido não retorna row (sem oracle de conteúdo
-- privado). comment_count = total (autores privados contam); sem UUID.
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
  )
  select
    v.username as username,
    v.tmdb_id as tmdb_id,
    v.media_type as media_type,
    (select count(*)
     from public.rating_comments as c
     where c.rating_owner_id = v.owner_id
       and c.media_type = v.media_type
       and c.tmdb_id = v.tmdb_id) as comment_count,
    v.comments_enabled as comments_enabled
  from valid as v;
$$;

-- ------------------------------------------------------------- 10. Grants
revoke all on function public.get_public_rating_comments(text, bigint, text, integer, integer) from public;
revoke all on function public.create_rating_comment_by_username(text, bigint, text, text) from public;
revoke all on function public.update_rating_comment(bigint, text) from public;
revoke all on function public.delete_rating_comment(bigint) from public;
revoke all on function public.get_public_rating_comment_states(jsonb) from public;

grant execute on function public.get_public_rating_comments(text, bigint, text, integer, integer) to anon, authenticated;
grant execute on function public.create_rating_comment_by_username(text, bigint, text, text) to authenticated;
grant execute on function public.update_rating_comment(bigint, text) to authenticated;
grant execute on function public.delete_rating_comment(bigint) to authenticated;
grant execute on function public.get_public_rating_comment_states(jsonb) to anon, authenticated;
