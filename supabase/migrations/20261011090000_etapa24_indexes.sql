-- Etapa 24 (production audit): índices de apoio faltantes.
--
-- Somente CREATE INDEX IF NOT EXISTS (aditivo, sem DDL destrutivo,
-- sem mudança de contrato). Cada índice tem causa concreta:
--
-- 1. user_blocks_blocker_idx(blocker_id, created_at DESC, id DESC)
--    → get_my_blocked_users filtra por blocker_id e ordena por
--    created_at DESC, id DESC; antes só existiam UNIQUE(blocker,blocked)
--    e o reverso (blocked,blocker), forçando sort sem apoio.
-- 2. rating_comment_replies_author_idx(author_id)
--    → FK author_id→auth.users sem índice: DELETE em cascata do autor
--    e limpezas por autor varriam a tabela.
-- 3. notifications_actor_idx(actor_id)
--    → FK actor_id→auth.users sem índice liderado por actor_id:
--    remoção de notificações cross (block/unblock) e DELETE em cascata
--    do ator varriam a tabela.
--
-- Aplicar no Dashboard (SQL Editor → Run) antes do deploy, junto das
-- demais migrations da sequência.

create index if not exists user_blocks_blocker_idx
  on public.user_blocks (blocker_id, created_at desc, id desc);

create index if not exists rating_comment_replies_author_idx
  on public.rating_comment_replies (author_id);

create index if not exists notifications_actor_idx
  on public.notifications (actor_id);
