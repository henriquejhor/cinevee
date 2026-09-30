-- CineVee · Etapa 12 — Opinião textual opcional nas avaliações.
--
-- COMO APLICAR (sem CLI/credenciais neste ambiente):
--   Supabase Dashboard → SQL Editor → New query → colar este arquivo
--   inteiro → Run. Rodar UMA vez no projeto.
--
-- O que esta migration faz:
--   1. adiciona public.ratings.review_text (text NULL — opinião opcional);
--   2. CHECK: NULL ou até 2000 caracteres (char_length <= 2000);
--   3. NÃO altera FK/RLS/policies/índices existentes (review morre junto
--      com a rating via mesma row; cascade de watched preservado).
--
-- O que esta migration NÃO faz:
--   - não cria tabela reviews (1 avaliação = no máximo 1 opinião);
--   - não torna rating nullable (review depende de rating);
--   - não cria policy pública, visibility, likes, comments ou follow;
--   - não usa trigger (app normaliza: trim, "" → NULL);
--   - nada destrutivo (só ADD COLUMN + ADD CONSTRAINT idempotentes).

-- ------------------------------------------------------- 1. Nova coluna
alter table public.ratings
  add column if not exists review_text text;

-- ------------------------------------------------------- 2. Constraint
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ratings_review_text_length'
  ) then
    alter table public.ratings
      add constraint ratings_review_text_length
      check (
        review_text is null
        or char_length(review_text) <= 2000
      );
  end if;
end;
$$;
