-- CineVee · Etapa 5 — correção mínima: SELECT próprio em storage.objects.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- Contexto: o bucket `avatars` (criado em
-- 20260924090000_profile_identity_avatar.sql) já possui policies de
-- INSERT/UPDATE/DELETE limitadas à própria pasta
-- (avatars/{user_id}/). Na prática, porém, UPDATE (upsert) próprio falha
-- com RLS e DELETE próprio via storage.remove() retorna vazio sem erro:
-- a API do Storage precisa enxergar a linha sob RLS antes de
-- atualizar/remover, e não existe policy SELECT em storage.objects.
--
-- O que esta migration faz (SOMENTE isto):
--   1. cria a policy "avatars_select_own": cada usuário autenticado pode
--      SELECT SOMENTE objetos dentro da própria pasta
--      (primeiro segmento do path == auth.uid()).
--
-- O que esta migration NÃO faz:
--   - não altera avatars_insert_own / avatars_update_own / avatars_delete_own;
--   - não altera RLS de profiles nem de watchlist;
--   - não altera o bucket (continua público para leitura via public URL);
--   - não cria SELECT amplo para authenticated (B continua sem enxergar A);
--   - não toca em Auth nem usa service_role.

drop policy if exists "avatars_select_own" on storage.objects;
create policy "avatars_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );
