-- CineVee · Etapa 18 — Curtidas em avaliações (public.rating_likes).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.rating_likes (liker_id, rating_owner_id, tmdb_id,
--      media_type, created_at) com PK no quarteto (1 like por pessoa),
--      CHECK anti self-like e FKs em cascata;
--   2. FK composta (rating_owner_id, media_type, tmdb_id) → ratings
--      (user_id, media_type, tmdb_id), NA ORDEM da UNIQUE existente:
--      removeu rating (ou unwatch em cascata) → likes somem juntos;
--   3. índice para contagem por rating + RLS (INSERT/DELETE só com
--      liker_id = auth.uid(); sem SELECT amplo, sem UPDATE);
--   4. cria 3 RPCs (search_path fixo, só o necessário, sem SQL dinâmica):
--        - like_rating_by_username / unlike_rating_by_username
--          (authenticated; viewer = auth.uid(); idempotentes; erro
--          genérico p/ privado/inexistente/sem rating; self-like com
--          mensagem própria; VOLATILE pois escrevem);
--        - get_public_rating_like_states (anon+authenticated; lote de
--          até 24 targets; só ratings publicamente visíveis; sem UUID);
--   5. concede EXECUTE mínimo por função (anon só no summary).
--
-- O que esta migration NÃO faz:
--   - NÃO cria policy pública em rating_likes (counts via RPC);
--   - NÃO expõe liker_id/owner UUID/email/flags em nenhuma RPC;
--   - NÃO usa discoverable, show_activity ou show_reviews como gate
--     de likeabilidade (só profile_public + show_ratings + rating);
--   - NÃO cria lista de likers, activities, notificações ou ranking;
--   - NÃO usa service_role em lugar nenhum do app.
--
-- Decisões de privacidade (documentadas):
--   - like_count público = TOTAL de likes (likers privados contam
--     numericamente; identidades nunca são expostas);
--   - despublicar/desligar show_ratings NÃO apaga rows: o contador some
--     do público e reaparece se voltar (relação preservada por UUID);
--   - unlike funciona mesmo com alvo escondido (não prende o usuário
--     numa curtida impossível de remover — mesmo padrão do unfollow).

-- ---------------------------------------------------------------- 1. Tabela
-- Tipos idênticos aos de ratings (uuid/bigint/text); ordem da FK igual
-- à da UNIQUE ratings_unique_item (user_id, media_type, tmdb_id).
create table if not exists public.rating_likes (
  liker_id uuid not null references auth.users (id) on delete cascade,
  rating_owner_id uuid not null,
  tmdb_id bigint not null,
  media_type text not null,
  created_at timestamptz not null default now(),

  constraint rating_likes_unique_like
    primary key (liker_id, rating_owner_id, media_type, tmdb_id),
  constraint rating_likes_rating_fk
    foreign key (rating_owner_id, media_type, tmdb_id)
    references public.ratings (user_id, media_type, tmdb_id)
    on delete cascade,
  constraint rating_likes_no_self
    check (liker_id <> rating_owner_id),
  constraint rating_likes_media_type_allowed
    check (media_type in ('movie', 'tv'))
);

-- ------------------------------------------------------------- 2. Índices
-- A PK começa por liker_id (deletes do próprio usuário); este cobre a
-- contagem por rating + o batch de states (owner, media, tmdb).
create index if not exists rating_likes_rating_idx
  on public.rating_likes (rating_owner_id, media_type, tmdb_id);

-- ------------------------------------------------------------- 3. RLS
alter table public.rating_likes enable row level security;

drop policy if exists "rating_likes_insert_own" on public.rating_likes;
create policy "rating_likes_insert_own"
  on public.rating_likes
  for insert
  to authenticated
  with check (liker_id = auth.uid());

drop policy if exists "rating_likes_delete_own" on public.rating_likes;
create policy "rating_likes_delete_own"
  on public.rating_likes
  for delete
  to authenticated
  using (liker_id = auth.uid());

-- Sem política de SELECT: leitura direta bloqueada (até para o dono ver
-- a tabela crua); counts/states passam pelas RPCs allowlisted.
-- Sem política de UPDATE: like só nasce/morre (INSERT/DELETE).
-- Sem acesso anônimo: só authenticated com liker próprio.

-- --------------------------------------------- 4. RPC: curtir (idempotente)
-- Resolve o dono por username SOMENTE se a rating é publicamente
-- likeable (profile_public + show_ratings + rating existe). Self-like,
-- privado/inexistente/sem rating → exceções (self com mensagem própria).
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

  return query
  select true as liked, count(*) as like_count
  from public.rating_likes as l
  where l.rating_owner_id = v_owner
    and l.media_type = p_media_type
    and l.tmdb_id = p_tmdb_id;
end;
$$;

-- --------------------------------------------- 5. RPC: descurtir (idempotente)
-- Resolve o dono por username SEM exigir visibilidade atual: quem curtiu
-- quando era público consegue remover mesmo se o alvo despublicou ou
-- desligou show_ratings (sem prender o usuário). Idempotente: sem row →
-- removed false. O contador retornado é o total real da rating.
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

  return query
  select (v_count > 0) as removed, count(*) as like_count
  from public.rating_likes as l
  where l.rating_owner_id = v_owner
    and l.media_type = p_media_type
    and l.tmdb_id = p_tmdb_id;
end;
$$;

-- --------------------------------------------- 6. RPC: states em lote
-- Até 24 targets [{username, tmdb_id, media_type}]. Retorna SOMENTE
-- ratings publicamente visíveis (profile_public + show_ratings + rating
-- existe) — privado/escondido não retorna row (sem oracle de conteúdo
-- privado). liked_by_viewer usa auth.uid() (anon sempre false).
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

-- ------------------------------------------------------------- 7. Grants
revoke all on function public.like_rating_by_username(text, bigint, text) from public;
revoke all on function public.unlike_rating_by_username(text, bigint, text) from public;
revoke all on function public.get_public_rating_like_states(jsonb) from public;

grant execute on function public.like_rating_by_username(text, bigint, text) to authenticated;
grant execute on function public.unlike_rating_by_username(text, bigint, text) to authenticated;
grant execute on function public.get_public_rating_like_states(jsonb) to anon, authenticated;
