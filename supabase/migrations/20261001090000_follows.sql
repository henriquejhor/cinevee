-- CineVee · Etapa 16 — Seguir usuários (public.follows).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. cria public.follows (follower_id, following_id, created_at) com
--      UNIQUE no par, CHECK anti self-follow e FKs em cascata;
--   2. índices para as duas direções de leitura (created_at DESC);
--   3. ativa RLS + políticas privadas: SELECT só em rows onde participa,
--      INSERT/DELETE só com follower_id = auth.uid(). Sem UPDATE;
--   4. cria RPCs SECURITY DEFINER (search_path fixo, só leitura/escrita
--      controlada, sem SQL dinâmica):
--        - follow_user_by_username / unfollow_user_by_username
--          (authenticated; resolve alvo público por username, bloqueia
--          self-follow, idempotentes, erro genérico p/ privado/inexistente);
--        - get_follow_state (anon+authenticated; só a relação do chamador);
--        - get_public_follow_counts (anon+authenticated; 0 rows se privado);
--        - get_public_followers / get_public_following (anon+authenticated;
--          só identidades públicas, teto 24, sem UUID/email/flags/datas);
--        - get_my_follow_counts (authenticated; totais do dono);
--   5. concede EXECUTE mínimo por função (anon só onde é seguro).
--
-- O que esta migration NÃO faz:
--   - NÃO cria policy pública em follows (anon SELECT direto bloqueado);
--   - NÃO cria SELECT amplo p/ authenticated (só rows onde participa);
--   - NÃO expõe user_id, email, flags, watchlist, timestamps ou metadados;
--   - NÃO usa service_role em lugar nenhum do app.
--
-- Decisões de contagem (documentadas):
--   - followers_count público = TOTAL de relações (número real; a lista
--     expõe só seguidores com perfil público — identidades privadas nunca
--     vazam, nem por inferência além do número agregado);
--   - following_count público = SOMENTE alvos atualmente públicos
--     (igual ao que a lista pública consegue mostrar — sem divergência);
--   - counts próprias (get_my_follow_counts) = totais, sem filtro;
--   - despublicar NÃO apaga rows: o conteúdo some do público e reaparece
--     se voltar a público (relação preservada por UUID).

-- ---------------------------------------------------------------- 1. Tabela
create table if not exists public.follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  following_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint follows_unique_pair unique (follower_id, following_id),
  constraint follows_no_self check (follower_id <> following_id)
);

-- ------------------------------------------------------------- 2. Índices
create index if not exists follows_following_idx
  on public.follows (following_id, created_at desc);
create index if not exists follows_follower_idx
  on public.follows (follower_id, created_at desc);

-- ------------------------------------------------------------- 3. RLS
alter table public.follows enable row level security;

drop policy if exists "follows_select_involved" on public.follows;
create policy "follows_select_involved"
  on public.follows
  for select
  to authenticated
  using (follower_id = auth.uid() or following_id = auth.uid());

drop policy if exists "follows_insert_own" on public.follows;
create policy "follows_insert_own"
  on public.follows
  for insert
  to authenticated
  with check (follower_id = auth.uid());

drop policy if exists "follows_delete_own" on public.follows;
create policy "follows_delete_own"
  on public.follows
  for delete
  to authenticated
  using (follower_id = auth.uid());

-- Sem política de UPDATE: relação só nasce/morre (INSERT/DELETE).
-- Sem acesso anônimo: só participantes autenticados no SELECT direto.

-- --------------------------------------------- 4. RPC: seguir (idempotente)
-- Resolve o alvo por username SOMENTE se público; self-follow e
-- privado/inexistente retornam o mesmo erro genérico da rota.
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

  return true;
end;
$$;

-- --------------------------------------------- 5. RPC: deixar de seguir
-- Idempotente: remover o que não existe retorna false, sem erro.
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
  return v_count > 0;
end;
$$;

-- --------------------------------------------- 6. RPC: estado de follow
-- Só a relação do chamador (auth.uid → perfil visitado). Anon, privado,
-- inexistente ou self: (false, false) — sem distinguir os casos.
create or replace function public.get_follow_state(p_username text)
returns table (
  following boolean,
  is_self boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select p.id, p.profile_public
    from public.profiles as p
    where p.username = lower(trim(p_username))
      and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
  )
  select
    exists (
      select 1
      from public.follows as f, target as t
      where f.follower_id = auth.uid()
        and f.following_id = t.id
        and t.profile_public is true
    ) as following,
    exists (
      select 1
      from target as t
      where t.id = auth.uid()
    ) as is_self;
$$;

-- --------------------------------------------- 7. RPC: contadores públicos
-- followers = total de relações; following = só alvos públicos.
-- Privado/inexistente: 0 rows.
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
     where f.following_id = p.id) as followers_count,
    (select count(*)
     from public.follows as f
     join public.profiles as t
       on t.id = f.following_id
      and t.profile_public is true
     where f.follower_id = p.id) as following_count
  from public.profiles as p
  where p.username = lower(trim(p_username))
    and lower(trim(p_username)) ~ '^[a-z0-9_]{3,24}$'
    and p.profile_public is true;
$$;

-- --------------------------------------------- 8. RPC: lista de seguidores
-- Só seguidores com perfil público (identidades privadas nunca expostas).
-- Mais recentes primeiro; created_at ordena mas NÃO é exposto.
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
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- --------------------------------------------- 9. RPC: lista de seguindo
-- Só alvos com perfil público (consistente com following_count).
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
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 24)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- --------------------------------------------- 10. RPC: contadores próprios
-- Totais do dono (sem filtro de privacidade). Só authenticated.
create or replace function public.get_my_follow_counts()
returns table (
  followers_total bigint,
  following_total bigint,
  following_public bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)
     from public.follows as f
     where f.following_id = auth.uid()) as followers_total,
    (select count(*)
     from public.follows as f
     where f.follower_id = auth.uid()) as following_total,
    (select count(*)
     from public.follows as f
     join public.profiles as t
       on t.id = f.following_id
      and t.profile_public is true
     where f.follower_id = auth.uid()) as following_public;
$$;

-- ------------------------------------------------------------- 11. Grants
revoke all on function public.follow_user_by_username(text) from public;
revoke all on function public.unfollow_user_by_username(text) from public;
revoke all on function public.get_follow_state(text) from public;
revoke all on function public.get_public_follow_counts(text) from public;
revoke all on function public.get_public_followers(text, integer, integer) from public;
revoke all on function public.get_public_following(text, integer, integer) from public;
revoke all on function public.get_my_follow_counts() from public;

grant execute on function public.follow_user_by_username(text) to authenticated;
grant execute on function public.unfollow_user_by_username(text) to authenticated;
grant execute on function public.get_follow_state(text) to anon, authenticated;
grant execute on function public.get_public_follow_counts(text) to anon, authenticated;
grant execute on function public.get_public_followers(text, integer, integer) to anon, authenticated;
grant execute on function public.get_public_following(text, integer, integer) to anon, authenticated;
grant execute on function public.get_my_follow_counts() to authenticated;
