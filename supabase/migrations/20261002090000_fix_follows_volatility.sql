-- CineVee · Etapa 16 (corretiva) — volatilidade das RPCs de escrita.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- DIAGNÓSTICO (auditoria cirúrgica, banco real):
--   - follow_user_by_username e unfollow_user_by_username estavam
--     declaradas STABLE, mas executam INSERT / DELETE.
--   - O PostgreSQL proíbe escrita em função não-VOLATILE:
--       follow   → 0A000 "INSERT is not allowed in a non-volatile function"
--       unfollow → 0A000 "DELETE is not allowed in a non-volatile function"
--   - A camada server (src/lib/follows/service.ts) converte QUALQUER erro
--     da RPC em "Perfil não disponível." (404 genérico, por privacidade),
--     o que mascarou o erro SQL e gerou ~53 failures em cascata no
--     verify:follows (nenhuma row de follows jamais foi criada).
--   - NÃO é discoverable: grep confirma ZERO ocorrências de "discoverable"
--     na migration da Etapa 16, e o comportamento é idêntico para alvos
--     public+discoverable=true e public+discoverable=false.
--   - Resolução do alvo INALTERADA: follow exige profile_public IS TRUE;
--     unfollow resolve qualquer username existente (permite remover relação
--     mesmo se o alvo despublicou o perfil). Sem filtro de discoverable.
--
-- O que esta migration faz:
--   1. recria as duas RPCs como VOLATILE (única mudança semântica);
--   2. mantém SECURITY DEFINER, search_path fixo, mesma assinatura,
--      mesma resolução de alvo, mesmos erros genéricos e mesmos grants
--      (nenhum GRANT precisa ser refeito — CREATE OR REPLACE preserva).
--
-- O que esta migration NÃO faz:
--   - NÃO toca em search_public_profiles / discoverable / /buscar;
--   - NÃO enfraquece RLS (policies de follows inalteradas);
--   - NÃO altera counts, listas, state ou qualquer RPC de leitura
--     (todas STABLE read-only — correto);
--   - NÃO usa service_role.

-- --------------------------------------------- 1. RPC: seguir (idempotente)
-- VOLATILE porque executa INSERT. Resolução inalterada: alvo público por
-- username; self/privado/inexistente → erro genérico da rota.
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

-- --------------------------------------------- 2. RPC: deixar de seguir
-- VOLATILE porque executa DELETE. Resolução inalterada: qualquer username
-- existente (SEM exigir profile_public — permite unfollow de alvo que
-- despublicou o perfil). Idempotente: sem relação → false, sem erro.
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
