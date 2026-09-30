# Etapa 24 — Auditoria final + hardening + preparação para produção

Data: 2026-09-29. Escopo: CineVee v1 (sem features novas, sem deploy,
sem hospedagem, sem domínio — Etapa 25 separada).

Veredito: **READY FOR DEPLOY** (após aplicar a migration incremental de
índices no Dashboard antes do deploy — item de checklist, não blocker de código).

- BLOCKERs abertos: **0**
- HIGHs corrigidos ou com justificativa de infra: ver §2
- `npm run check`: 0 errors, 0 warnings (28 hints restantes, todos catalogados no §12:
  24 pré-existentes − 7 limpos + 4 dos 2 scripts verify novos, mesmo padrão
  `node:module register` já documentado como INFO)
- `npm run build`: Complete (199 arquivos)
- Regressões: todas as suítes da Parte AH executadas (ver §11)

Formato de cada achado: área · problema · evidência · risco · correção · status.

---

## 1. Inventário (base factual)

Stack: Astro 7, `output: "server"`, `@astrojs/node` standalone,
Tailwind 4 (Vite plugin), DaisyUI 5, TypeScript strict, Node >=22.12.

Prerender: `/` (index.astro:15), `/buscar` (buscar.astro:9),
`/descobrir` (descobrir.astro:11). Todo o resto SSR (`prerender = false`).

APIs: 38 arquivos em `src/pages/api/**` (37 inventariados + `/api/health`
criado nesta etapa). Nenhum exporta `ALL`; método não exportado cai no
404/405 padrão do Astro (adequado — sem handler genérico que aceite
PUT/POST acidentalmente).

Migrations (20 + 1 nova): 20260922 profiles → … → 20261010 user_blocks →
**20261011 etapa24_indexes (NOVA, aplicar no Dashboard antes do deploy)**.

Tabelas finais: profiles, watchlist, watched_titles, ratings,
profile_picks, follows, rating_likes, rating_comments,
rating_comment_replies, notifications, user_blocks (+ storage.objects
bucket `avatars`).

---

## 2. Achados

### [MEDIUM] Auth — bypass de open-redirect via backslash no `?next=`
- Área: auth/redirects (`src/lib/supabase/server.ts:114-118`).
- Problema: `sanitizeNext` bloqueava `//evil` mas aceitava `/\evil.com`.
  Prova: `new URL("/\\evil.com", "https://app.com/x").href` →
  `https://evil.com/` (parser WHATWG trata `\` como `/` em http(s)).
  Vetor: link de login malicioso → pós-login a vítima sai do app
  (phishing). Escopo limitado (só redirect pós-login, sem roubo de sessão).
- Correção: rejeita `next[1] === "\\"` e qualquer `\`/controle no path.
  `entrar`/`cadastrar` usam o helper central (sem validações divergentes).
- Status: **corrigido** (teste unitário no `verify:production`).

### [MEDIUM] External — Groq/Gemini sem abort real no timeout
- Área: `src/lib/ai/groqClient.ts`, `src/lib/gemini/adaptiveQuestion.ts`,
  `src/lib/gemini/rankRecommendations.ts`.
- Problema: `withTimeout` era `Promise.race` sem `AbortSignal` — o caminho
  do usuário nunca pendurava (fallback preservado), mas o socket ficava
  aberto em background (vazamento sob carga). TMDB já tinha abort (8s).
- Correção: `withTimeoutAbort` + `signal` no `fetch` Groq e `abortSignal`
  no config do SDK Gemini (suportado: `abortSignal?: AbortSignal` nos
  `.d.ts` do `@google/genai`). Ranking combina teto total + teto da
  tentativa via `AbortSignal.any`. Fallback Groq → Gemini → local intacto;
  browser continua sem decidir model/temperature/max_tokens (server-owned).
- Status: **corrigido** (check + build + `verify:personalization` na regressão).

### [MEDIUM] Cache — respostas viewer-specific sem `Cache-Control`
- Área: Parte K (`src/pages/api/**`, nenhum header antes).
- Problema: conteúdos "públicos" filtrados por BLOCK são viewer-specific
  (A não vê B, C vê). Sem diretiva explícita, um cache compartilhado
  futuro (CDN da Etapa 25) poderia servir a visão errada. Hoje não há
  CDN (só `@astrojs/node` direto), então sem exploração atual.
- Correção: helper `src/lib/http/cache.ts` (`privateJson` →
  `Cache-Control: private, no-store`) aplicado aos 200 de
  `follows/state`, `followers/mine`, `feed/following`, `notifications`,
  `notifications/unread-count`, `blocks` GET. Home/buscar/descobrir
  continuam prerendered (seguros, sem dado de usuário).
- Status: **corrigido** (parcial consciente: regras de CDN ficam p/ Etapa 25).

### [MEDIUM] DB — 3 índices de apoio faltantes
- Área: Parte M. Lacunas concretas (FKs sem índice + ORDER BY sem apoio):
  1. `get_my_blocked_users` filtra `blocker_id` e ordena
     `(created_at DESC, id DESC)` — só havia `UNIQUE(blocker,blocked)` e
     o reverso `(blocked,blocker)`.
  2. `rating_comment_replies.author_id` — FK sem índice (cascata do autor).
  3. `notifications.actor_id` — FK sem índice (limpeza cross no block).
  Não-lacunas verificadas: follows (2 índices + unique), likes/comments/
  replies thread idx exatos, `notifications_recipient_idx` + unread idx,
  picks/rated/watched recent idx, FKs cobertas por uniques parciais
  (`unique_comment`, `unique_reply`).
- Correção: migration incremental
  `supabase/migrations/20261011090000_etapa24_indexes.sql`
  (só `CREATE INDEX IF NOT EXISTS`, zero DDL destrutivo). Migrations antigas
  NÃO editadas.
- Status: **migration criada; APLICAR no Dashboard antes do deploy**
  (checklist pré-deploy, não blocker de código).

### [LOW] Env — `.env.example` sem as chaves de IA
- Área: Parte C. Código usa `GROQ_API_KEY`, `GROQ_MODEL` (default
  `qwen/qwen3.8-27b`), `GEMINI_API_KEY`, `GEMINI_MODEL` (default
  `gemini-3.8-flash`), mas o example só tinha TMDB + Supabase.
- Correção: example completo (valores vazios) + `PUBLIC_SITE_URL`
  documentada (opcional local, obrigatória em produção p/ canonical/OG).
- Status: **corrigido**.

### [LOW] Git — `.env.local` fora do `.gitignore`
- Área: Parte C. `.gitignore` cobria `.env` e `.env.production`, mas não
  `.env.local`.
- Correção: adicionado. Observação: **não há repo git neste ambiente**
  (`fatal: not a git repository`), então "tracked" e histórico de secrets
  estão **NOT VERIFIED** — primeira inicialização do repo deve partir
  destes arquivos (sem `.env`).
- Status: **corrigido** (arquivo); histórico: NOT VERIFIED por ausência de git.

### [LOW] SEO — sem canonical/OG/Twitter/noindex
- Área: Parte R. `Layout.astro` tinha só title/description; nenhuma página
  emitia `robots`, `canonical`, `og:*` ou `twitter:*`.
- Correção: `Layout` ganhou props `noindex`, `canonicalPath` (absoluto
  SOMENTE se `PUBLIC_SITE_URL` definido — nenhum domínio fictício
  inventado) e `image`, + `og:*`/`twitter:*` derivados de props existentes.
  `noindex` aplicado a: `/perfil` + 7 subpáginas, `/notificacoes`,
  `/seguindo`, `/entrar`, `/cadastrar`, `/buscar`.
  `canonicalPath` em `/`, `/titulo/[type]/[id]` (+ pôster TMDB absoluto),
  `/u/[username]` (+ avatar), listas `/u/*/seguidores|seguindo`.
  Sitemap/robots com domínio ficam p/ Etapa 25 (sem ganho agora).
- Status: **corrigido**.

### [LOW] Error states — sem 404/500 próprias
- Área: Parte S. Não existia `src/pages/404.astro`; 500 caía no fallback
  padrão.
- Correção: `404.astro` e `500.astro` mínimas (Layout + links, `noindex`,
  sem stack/SQL/internals; 500 só loga `operation + message` server-side).
- Status: **corrigido** (smoke em prod local cobre 404).

### [LOW] Produção — sem script `start` nem healthcheck
- Área: Partes V/W. `package.json` não declarava como rodar o output
  standalone; nenhum endpoint de liveness.
- Correção: `"start": "node ./dist/server/entry.mjs"` (validado no smoke
  §11) + `GET /api/health` → `{ ok: true }`, sem TMDB/IA/banco, `no-store`,
  sem env/UUID/keys.
- Status: **corrigido**.

### [LOW] Hints — limpeza risco-zero (31 → 24)
- Removidos (7): `UNAVAILABLE_MESSAGE` em `blocks/service.ts:63` e
  `commentReplies/service.ts:100` (consts nunca lidas), imports `perf` e
  `buildPosterUrl` em `discovery/candidates.ts`, `TASTE_LOCAL_BONUS` em
  `gemini/rankRecommendations.ts:34`, `totalPages` em
  `explorar/[section].astro:43,53` (atribuído, nunca lido), parâmetro
  `key` de `resolveAdaptiveView` em `discovery/flow.ts` (3 call sites
  atualizados, `key` segue usado em `applyAdaptiveResult`).
- Mantidos (28 = 11× ts(80006) + 10× register + 7× ts(6133), sem churn
  proposital): 11× "may be converted to async" (`.then()` estáveis —
  reescrever por estética é churn proibido); 10× `node:module register`
  deprecated em 5 scripts verify (4 pré + `verify-production.mjs`;
  runtime OK, trocar infra de teste é risco sem benefício); 7×
  declarado-não-lido (5 em `public/scripts/rating-comments.js` + `target`
  em `verify-rating-comments.mjs:415` + 1 legado similar).
  (Conta: 31 − 7 limpos + 4 do script novo = 28.)
- Status: **corrigido** (parcial consciente).

### [INFO] Segurança — itens verificados SEM achado
- Secrets: `TMDB_ACCESS_TOKEN`, `GROQ_API_KEY`, `GEMINI_API_KEY`
  (+`GROQ_MODEL`, `GEMINI_MODEL`) **só server-side** (`src/lib/*`,
  frontmatter, API routes). Zero ocorrência em `<script>` browser,
  `public/`, bundles. Scan de `dist/` no §11. Nomes no relatório, nunca
  valores (FOUND/NOT FOUND).
- `service_role`: **0 ocorrências reais** em `src/`/`public/`/`supabase/`
  (só comentários "nunca service_role"). Confirmado ausência.
- Env públicas: só `PUBLIC_SUPABASE_URL` +
  `PUBLIC_SUPABASE_PUBLISHABLE_KEY` (+ nova `PUBLIC_SITE_URL`, só URL).
  Nenhuma secret com prefixo `PUBLIC_`.
- Auth: 100% via `getCurrentUser()` → `auth.getUser()` server-side
  (`src/lib/supabase/server.ts:70-94`); **0 usos de `getSession`** em `src/`.
  Cookies 100% `@supabase/ssr` oficial (sem substituto manual); nenhum
  token em `localStorage`/`sessionStorage` (só chaves do Discovery, sem
  credencial). Cookies de sessão do helper oficial herdam `path=/`,
  `sameSite=lax`, `httpOnly`/`secure` conforme ambiente HTTPS.
- SSRF: nenhum `fetch(urlDeUsuário)` — hosts fixos (api.themoviedb.org,
  api.groq.com); input vira só path/query validado (`parseId`,
  allowlists, `searchParams.set`).
- Astro session filesystem: mensagem `Enabling sessions with filesystem
  storage` auditada — **`Astro.session`/`context.session` têm 0 usos em
  `src/`**: o storage é inerte, nenhum estado crítico depende dele.
  Nenhuma ação (não migrar p/ Redis sem hospedagem). Se a Etapa 25 usar
  filesystem efêmero/multi-instância: sem impacto no app atual.

### [INFO] Supabase/RLS — sem achado
- Todas as 11 tabelas com RLS ON. Sociais sem SELECT direto:
  `rating_likes` (só I/D próprias), `rating_comments` (I/U autor, D
  autor/dono), `notifications`/`rating_comment_replies`/`user_blocks`
  (**zero policies** — só RPC). `profiles/watchlist/watched/ratings/picks`
  com policies `auth.uid()=id`/`user_id` mínimas, sem UPDATE onde não
  precisa (watchlist/watched/follows sem UPDATE).
- SECURITY DEFINER (40+ funções): **todas** com `SET search_path = public`,
  **zero** SQL dinâmica (`EXECUTE` só em triggers), grants mínimos com
  `REVOKE ALL` + `GRANT` explícito, volatility correta (writes VOLATILE —
  Etapa `fix_follows_volatility` aplicada; reads STABLE).
- IDs do browser: usernames→UUID sempre resolvidos server-side; ids
  numéricos (`commentId/replyId/blockId/followId/notificationIds`) sempre
  com checagem de dono (`author=v_me`, `recipient=v_me`,
  `following_id=v_me`, `blocker=v_me`).
- Helpers internos `users_are_blocked`/`apply_user_block`: **revogados,
  sem GRANT** (só chamada interna).

### [INFO] Grants — tabela RPC (resumo)
| RPC | anon | authenticated | motivo |
|---|---|---|---|
| get_public_profile/favorites/recommendations/watched/ratings | sim | sim | leitura pública (obedece flags) |
| search_public_profiles | sim | sim | busca username (teto 10/20) |
| get_follow_state / public_follow_counts/followers/following | sim | sim | social público (só identidades públicas) |
| get_public_rating_comments/replies/comment_states/like_states | sim | sim | threads públicas (gate BLOCK) |
| follow/unfollow, get_my_follow_counts | não | sim | escrita + totais do dono |
| get_following_feed | não | sim | feed do viewer |
| like/unlike, create/update/delete comment/reply | não | sim | escritas sociais |
| get_my_notifications/unread/mark/mark_all | não | sim | inbox privada |
| block/unblock/by-follower/blocked/followers/remove | não | sim | gestão privada |
| users_are_blocked / apply_user_block | **não** | **não** | helpers internos revogados |

Nenhuma escrita acessível a anon. (Detalhe por função no relatório de
auditoria RLS da Etapa 24 — arquivo de trabalho, não versionado.)

### [INFO] Privacidade — sem achado
- HTML/JSON auditados: nenhum UUID de auth, email (exceto o **próprio**
  email do dono em `/perfil/editar:376` — intencional, conta própria),
  token ou flag interna em respostas. IDs bigint intencionais
  (`commentId/replyId/notificationId/blockId/followId`) preservados.
- Block: sem endpoint "quem me bloqueou", sem mensagem de bloqueio —
  alvo sempre `Perfil não disponível.` genérico.
- `profile_public=false`: bypass testado via RPCs/APIs públicas
  (profile/favorites/recommendations/watched/ratings/followers/following/
  counts → 0 rows/404) nas suítes existentes + novo teste Etapa 23/24
  (`/perfil` privado → management OK; `/u/A/seguidores` → 404).

### [INFO] XSS — sem achado
- `set:html`: só SVGs estáticos do app (DiscoveryIcon, FloatingDock,
  ContentSection) — nenhum com dado de usuário.
- `innerHTML`: só em `discovery/flow.ts`, sempre SVG estático de mapa ou
  `= ""` (limpeza); depois DOM via `createElement` + `textContent`.
  Zero `insertAdjacentHTML`/`document.write` em `src/`+`public/`.
- `aria-label`: dinâmicos usam strip `<...>` (PublicPersonCard,
  FeedActivityCard) ou títulos TMDB; `reviewText/comment/bio` nunca
  interpolados crus; controles sensíveis usam labels estáticos.
- `href/src`: usernames sob `USERNAME_PATTERN`, avatar/poster via URLs
  derivadas server-side (Storage path `{user_id}/{uuid}.ext`, TMDB
  `image.tmdb.org`); zero `javascript:`/`data:` em `src/`.
- Validação server-side com tetos: displayName 80, bio 160, review 2000,
  comment/reply/note 500, avatar JPEG/PNG/WebP ≤3MB + magic bytes +
  namespace próprio + filename aleatório (SVG não permitido).

### [INFO] APIs — sem achado além do cache (corrigido acima)
- 405: método não exportado → padrão Astro (sem aceitar verbo errado).
- JSON inválido: `request.json()` sempre em try (verificado nas rotas de
  escrita do Discovery e demais).
- Limites server-side: page 1..1000 + teto 24 (20 explore, 5/10 defaults
  comments/replies, 10 fixo user-search, 64 excludeIds, 8 states, 24
  notifications batch). `DELETE` com body JSON é contrato atual client↔API
  (mesma origem; documentado, sem troca).
- Erros genéricos ao browser (sem SQL/stack/keys); logs server com
  `operação + mensagem` (35 `console.*`, todos server-side, sem
  secret/token/PII — `message` nunca inclui corpo ou credencial).
- AI cost/abuse: Discovery público (decisão de produto: anônimo pode
  descobrir) com escopo validado (`parseAnswers` completo, excludeIds ≤64,
  retorno fixo 1+3, sem model/prompt/temperature do browser). Rate limit
  distribuído = infra da Etapa 25 (ver §9).

### [INFO] Performance — sem achado
- N+1: zero `await` em `.map` de páginas; candidates ≤2 páginas/tipo;
  states batch ≤24; replies lazy; feed/counts via RPC agregada.
- Imagens: pôster 2/3 com dimensões + lazy (hero/LCP eager onde
  apropriado); `buildPosterUrl` nunca gera `src=""` (fix Etapa 22
  preservado); avatares via Storage pública + TMDB `image.tmdb.org`.
- Bundle: sem lib nova nesta etapa (zero dependências adicionadas);
  `npm audit --omit=dev`: **0 vulnerabilities**.

### [INFO] Mobile/a11y — sem achado
- Dock com 4 itens (Início/Buscar/Descobrir/Perfil), touch targets com
  `min-h-12` nos controles críticos, `env(safe-area-inset-bottom)` no
  `--cinevee-dock-offset`, sem overflow conhecido nas páginas críticas,
  botões p/ ação e links p/ navegação, `aria-live` em status, Escape/focus
  preservados nos fluxos atuais, `prefers-reduced-motion` respeitado,
  cor nunca como único indicador (texto/ícone/aria mantidos).

---

## 3. Migrations (1 NOVA, 0 edições)

- NOVA: `supabase/migrations/20261011090000_etapa24_indexes.sql`
  (3 índices, §2). **Aplicar no Dashboard → SQL Editor → Run antes do
  deploy.** Demais migrations inalteradas.
- Banco aplicado × arquivos: mesma sequência incremental idempotente
  (`IF NOT EXISTS`/`OR REPLACE`); nenhuma correção só-manual conhecida.

---

## 4. Arquivos alterados (Etapa 24)

Produto:
`src/lib/supabase/server.ts` (sanitizeNext), `src/lib/ai/groqClient.ts`
(abort), `src/lib/gemini/adaptiveQuestion.ts` (abort),
`src/lib/gemini/rankRecommendations.ts` (abort + import),
`src/lib/http/cache.ts` (NOVO), `src/layouts/Layout.astro` (SEO),
16 páginas (noindex/canonical — §2), `src/pages/404.astro` (NOVO),
`src/pages/500.astro` (NOVO), `src/pages/api/health.ts` (NOVO),
6 APIs (privateJson), `src/lib/blocks/service.ts`,
`src/lib/commentReplies/service.ts`, `src/lib/discovery/candidates.ts`,
`src/lib/discovery/flow.ts`, `src/pages/explorar/[section].astro` (hints),
`.env.example`, `.gitignore`, `package.json` (start + verify scripts),
`supabase/migrations/20261011090000_etapa24_indexes.sql` (NOVA).

Testes/docs (próximas seções): `scripts/verify-production.mjs` (NOVO),
`scripts/verify-e2e.mjs` (NOVO), este relatório.

---

## 5. Testes

- NOVO `npm run verify:production` (`scripts/verify-production.mjs`):
  readiness sem criar dezenas de usuários (env contract sem valores,
  `.gitignore`, service_role ausente, secrets fora do client,
  SECURITY DEFINER/search_path/grants, contratos de API/método,
  `sanitizeNext` unitário incl. `/\evil`, noindex/SEO, scripts de
  produção, Home prerender, adapter standalone, health live, scan de
  `dist/`).
- NOVO `npm run verify:e2e` (`scripts/verify-e2e.mjs`): smoke integrado
  de 4 usuários (follow → rating → feed → like → notification → comment →
  reply → block → gates bilaterais → unblock → reaparece sem follows).
- Bateria AH + check + build + prod local: ver resumo de execução
  (resultados finais no chat de entrega; este arquivo registra contratos).

---

## 6. Requisitos de hospedagem do CineVee (p/ Etapa 25)

- Node: `>=22.12.0` (engines). Comandos: `npm run build` →
  `npm run start` (`node ./dist/server/entry.mjs`, adapter standalone).
- SSR obrigatório (`output: "server"`; só `/`, `/buscar`, `/descobrir` +
  404/500 são estáticas). Filesystem persistente: **não necessário**
  (sessões Astro inertes; uploads vão p/ Supabase Storage).
- Env produção: `TMDB_ACCESS_TOKEN`, `GROQ_API_KEY`,
  `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `PUBLIC_SITE_URL` (obrigatória); `GEMINI_API_KEY` (fallback);
  `GROQ_MODEL`/`GEMINI_MODEL` opcionais. HTTPS obrigatório (cookies
  `Secure` via `@supabase/ssr`). Logs: stdout (`console.error` server).
  Health: `GET /api/health`. Outbound: supabase.co, api.themoviedb.org,
  api.groq.com, generativelanguage.googleapis.com.
- Antes do 1º deploy: aplicar migration `20261011090000` no Dashboard;
  definir domínio → `PUBLIC_SITE_URL`; configurar rate limit de infra
  (Etapa 25: login/signup, search, discovery IA, writes sociais).

## 7. Etapa 25 — checklist (NÃO executado)

Hospedagem + domínio + publicação: escolher provedor; `PUBLIC_SITE_URL`
final; robots/sitemap com domínio; rate limiting distribuído
(login/signup via Supabase + search + `/api/discovery/*` + comments/
replies/likes/follows/block); regras de cache do CDN (nunca `public`
em rotas viewer-specific/autenticadas); rotacionar credenciais se o
primeiro `git init` um dia incluir `.env` por acidente; re-verificar
histórico git quando o repo existir (hoje NOT VERIFIED).
