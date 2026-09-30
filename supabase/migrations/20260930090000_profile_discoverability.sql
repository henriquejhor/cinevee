-- CineVee · Etapa 15 — Busca de pessoas (discoverable + RPC pública).
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. adiciona public.profiles.discoverable (NOT NULL DEFAULT false:
--      nenhuma conta existente aparece na busca automaticamente);
--   2. cria a RPC SECURITY DEFINER search_public_profiles (search_path
--      fixo, só leitura, sem SQL dinâmica) que retorna SOMENTE
--      display_name/username/bio/avatar_path de perfis com profile_public
--      + discoverable + username válido, com ranking determinístico
--      (username exato → prefixo → contém → display prefixo → contém,
--      desempate por username ASC);
--   3. concede EXECUTE da RPC a anon + authenticated (a tabela base
--      continua sem nenhuma policy pública).
--
-- O que esta migration NÃO faz:
--   - NÃO cria policy pública em public.profiles (policies privadas valem);
--   - NÃO expõe user_id, email, flags, preferências, watchlist, ratings,
--     watched, TasteProfile, timestamps ou metadados;
--   - NÃO pesquisa dentro da bio (só username + display_name);
--   - NÃO usa pg_trgm (ILIKE + limite pequeno é suficiente);
--   - NÃO usa service_role em lugar nenhum do app.

-- ------------------------------------------------------- 1. Flag
alter table public.profiles
  add column if not exists discoverable boolean not null default false;

-- --------------------------------------- 2. RPC: busca de pessoas
-- Query normalizada: trim + lowercase + remove UM @ inicial.
-- Menos de 2 caracteres → 0 linhas (sem pesquisa ampla).
-- Ranking: 0 exato, 1 username prefixo, 2 username contém,
-- 3 display prefixo, 4 display contém; desempate username ASC.
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

-- --------------------------------------- 3. Grants (só EXECUTE na RPC)
revoke all on function public.search_public_profiles(text, integer) from public;

grant execute on function public.search_public_profiles(text, integer) to anon, authenticated;
