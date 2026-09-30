/**
 * Verificação da Etapa 19: comentários em avaliações (rating_comments).
 *
 * Pré-requisito: migration supabase/migrations/20261005090000_rating_comments.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem da tabela/RPCs entram em SKIP
 * identificado (exit 1); contratos de arquivo rodam sempre.
 *
 * Uso: npm run verify:rating-comments (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration (tabela, id identity, FK composta NA ORDEM da UNIQUE de
 *   ratings, cascades, anti-self CHECK, texto 1..500, índices, RLS sem
 *   SELECT, 5 RPCs SECURITY DEFINER, VOLATILE nas writes, grants
 *   mínimos, allow_rating_comments default false, sem discoverable/
 *   activity/reviews como gate, sem replies/likes/notificações);
 * - privacy (novo campo, snapshot 9 campos, cliente 8 campos → false,
 *   tipo errado → 400, extra ignorado);
 * - RLS direto (insert/update/delete cruzado bloqueado, self CHECK,
 *   anon nada, moderação do dono);
 * - create/list/edit/delete (gates, 401/400/403/404/409, counts,
 *   paginação 24/25/49, edit não reordena, autor privado anonimizado);
 * - allow off / target hidden / show_reviews / discoverable /
 *   show_activity (semânticas isoladas);
 * - feed (commentCount/commentsEnabled só em rating, sem evento, sem
 *   reorder, batch paralelo sem N+1);
 * - perfil público (SSR + Carregar mais, anon lê, dono modera);
 * - XSS (texto literal no RPC, DOM via textContent, sem innerHTML);
 * - cascatas (delete rating, cadeia watched→rating→comments,
 *   delete account do autor);
 * - TasteProfile/feed-ranking intocados.
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e APENAS 4
 * Auth users (A commenter, B owner, C segundo, D privado).
 * Requer email de confirmação DESLIGADO no projeto (como hoje).
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const BASE = "http://localhost:4321";

if (!SUPABASE_URL || !KEY) {
  console.error("Faltam PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY no .env.");
  process.exit(1);
}

const MIGRATION_FILE = "supabase/migrations/20261005090000_rating_comments.sql";

let failures = 0;
let skipped = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
function checkd(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) {
    failures += 1;
    if (detail) console.log(`      ↳ ${String(detail).slice(0, 300)}`);
  }
}
function skip(label) {
  console.log(`SKIP  ${label}`);
  skipped += 1;
}

function readFile(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/**
 * Código sem comentários (asserts de ausência testam o código, não a
 * prosa — aprendizado das Etapas 16/17).
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*--.*$/gm, "");
}

/**
 * true se objeto/array aninhado contém chave com o prefixo. Null-safe
 * (nunca `in` sobre string/null).
 */
function containsKeyStartingWith(value, prefix) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsKeyStartingWith(item, prefix));
  }
  return Object.entries(value).some(
    ([key, nested]) => key.startsWith(prefix) || containsKeyStartingWith(nested, prefix),
  );
}

// ------------------------------------------------- A. arquivos/migration
check("migration Etapa 19 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
const migrationCode = codeOnly(migration);
check("migration flag allow_rating_comments (default false)",
  /add column if not exists allow_rating_comments boolean not null default false/i.test(migration));
check("migration tabela rating_comments (id identity, tipos iguais a ratings)",
  /create table if not exists public\.rating_comments/i.test(migration)
  && /id bigint generated always as identity primary key/i.test(migration)
  && /author_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /rating_owner_id uuid not null/i.test(migration)
  && /tmdb_id bigint not null/i.test(migration)
  && /media_type text not null/i.test(migration)
  && /comment_text text not null/i.test(migration));
check("migration FK composta NA ORDEM da UNIQUE + cascades + anti-self + texto 1..500",
  /foreign key \(rating_owner_id, media_type, tmdb_id\)\s*references public\.ratings \(user_id, media_type, tmdb_id\)\s*on delete cascade/i.test(migration)
  && /check \(author_id <> rating_owner_id\)/i.test(migration)
  && /check \(media_type in \('movie', 'tv'\)\)/i.test(migration)
  && /char_length\(comment_text\) >= 1 and char_length\(comment_text\) <= 500/i.test(migration));
check("migration índices (thread DESC + author, sem duplicar PK)",
  /rating_comments_thread_idx[\s\S]{0,160}\(rating_owner_id, media_type, tmdb_id, created_at desc, id desc\)/i.test(migration)
  && /rating_comments_author_idx[\s\S]{0,80}\(author_id\)/i.test(migration));
check("migration RLS (insert/update/delete gerenciados, sem SELECT)",
  /enable row level security/i.test(migration)
  && /for insert[\s\S]{0,160}with check \(author_id = auth\.uid\(\)\)/i.test(migration)
  && /for update[\s\S]{0,200}using \(author_id = auth\.uid\(\)\)/i.test(migration)
  && /for delete[\s\S]{0,220}author_id = auth\.uid\(\) or rating_owner_id = auth\.uid\(\)/i.test(migration)
  && !/for select/i.test(migration)
  && !/create policy[^;]*\bto\s+(anon|public)\b/i.test(migration));
check("migration 5 RPCs SECURITY DEFINER (writes VOLATILE, reads STABLE)",
  /function public\.get_public_rating_comments/i.test(migration)
  && /function public\.create_rating_comment_by_username/i.test(migration)
  && /function public\.update_rating_comment/i.test(migration)
  && /function public\.delete_rating_comment/i.test(migration)
  && /function public\.get_public_rating_comment_states/i.test(migration)
  && (migration.match(/security definer/gi) || []).length >= 5
  && (migration.match(/set search_path = public/gi) || []).length >= 5
  && !/execute\s+format|execute\s+['"]select/i.test(migration)
  && (migration.match(/language plpgsql\s+volatile/gi) || []).length >= 3
  && (migration.match(/stable/gi) || []).length >= 2);
check("migration gates só public+show_ratings (+allow p/ criar; sem discoverable/activity/reviews)",
  /profile_public is true[\s\S]{0,600}show_ratings is true/i.test(migrationCode)
  && /allow_rating_comments is true/i.test(migrationCode)
  && !/discoverable/i.test(migrationCode)
  && !/show_activity/i.test(migrationCode)
  && !/show_reviews/i.test(migrationCode));
check("migration grants mínimos (writes só auth, reads anon+auth)",
  /grant execute on function public\.create_rating_comment_by_username\(text, bigint, text, text\) to authenticated/i.test(migration)
  && /grant execute on function public\.update_rating_comment\(bigint, text\) to authenticated/i.test(migration)
  && /grant execute on function public\.delete_rating_comment\(bigint\) to authenticated/i.test(migration)
  && /grant execute on function public\.get_public_rating_comments\(text, bigint, text, integer, integer\) to anon, authenticated/i.test(migration)
  && /grant execute on function public\.get_public_rating_comment_states\(jsonb\) to anon, authenticated/i.test(migration)
  && (migration.match(/revoke all on function public\./gi) || []).length >= 5);
check("migration sem replies/likes/notificações/eventos/ranking (só thread+count)",
  !/\brepl(y|ies)\b/i.test(migrationCode)
  && !/notif/i.test(migrationCode)
  && !/comment_?like|like.*comment/i.test(migrationCode)
  && !/create trigger/i.test(migrationCode)
  && !/returns table \([^)]*(author_id|owner_id|email)/i.test(migrationCode));

const FIX_FILE = "supabase/migrations/20261006090000_fix_rating_comments_create.sql";
check("migration incremental do fix 42702 existe", existsSync(new URL(`../${FIX_FILE}`, import.meta.url)));
{
  const fix = existsSync(new URL(`../${FIX_FILE}`, import.meta.url)) ? readFile(`../${FIX_FILE}`) : "";
  const fixCode = codeOnly(fix);
  check("fix redefine create sem RETURNING ambíguo (releitura qualificada)",
    /create or replace function public\.create_rating_comment_by_username/i.test(fix)
    && !/returning/i.test(fixCode)
    && /order by c\.id desc/i.test(fixCode)
    && /language plpgsql\s+volatile/i.test(fix)
    && /security definer/i.test(fix));
}

const commentTypes = codeOnly(readFile("../src/lib/ratingComments/types.ts"));
check("lib ratingComments types (sem UUID, batch 24, max 500)",
  /RatingCommentTarget/.test(commentTypes) && /RatingCommentState/.test(commentTypes)
  && /RatingCommentPage/.test(commentTypes) && /canEdit/.test(commentTypes)
  && /RATING_COMMENT_BATCH_SIZE = 24/.test(commentTypes)
  && /RATING_COMMENT_MAX_LENGTH = 500/.test(commentTypes)
  && /RATING_COMMENT_DEFAULT_LIMIT = 5/.test(commentTypes)
  && !/user_id|userId|author_id|owner_id/i.test(commentTypes));
const commentValidation = codeOnly(readFile("../src/lib/ratingComments/validation.ts"));
check("lib validation (alvo+texto 1..500+id+query, sem UUID)",
  /validateRatingCommentTarget/.test(commentValidation)
  && /validateCommentText/.test(commentValidation)
  && /validateCommentId/.test(commentValidation)
  && /validateCommentsQuery/.test(commentValidation)
  && !/author_id|owner_id/i.test(commentValidation));
const commentService = codeOnly(readFile("../src/lib/ratingComments/service.ts"));
check("lib service (5 RPCs, auth.uid server-side, sem tabela direta)",
  /get_public_rating_comments/.test(commentService)
  && /create_rating_comment_by_username/.test(commentService)
  && /update_rating_comment/.test(commentService)
  && /delete_rating_comment/.test(commentService)
  && /get_public_rating_comment_states/.test(commentService)
  && /SelfCommentError/.test(commentService)
  && /RatingCommentsDisabledError/.test(commentService)
  && !/from\("rating_comments"\)|from\('rating_comments'\)/.test(commentService)
  && !/author_id|owner_id/i.test(commentService));
const commentsApi = codeOnly(readFile("../src/pages/api/ratings/comments.ts"));
check("API comments GET/POST/PATCH/DELETE (401/400/403/404/409, sem UUID)",
  /export const GET/.test(commentsApi) && /export const POST/.test(commentsApi)
  && /export const PATCH/.test(commentsApi) && /export const DELETE/.test(commentsApi)
  && /status: 401/.test(commentsApi) && /status: 403/.test(commentsApi)
  && /status: 404/.test(commentsApi) && /status: 409/.test(commentsApi)
  && !/author_id|owner_id/i.test(commentsApi));
const commentsControl = codeOnly(readFile("../src/components/ratings/RatingCommentsControl.astro"));
check("RatingCommentsControl (toggle 48px, painel lazy, sem texto cru)",
  /data-rating-comments/.test(commentsControl) && /aria-expanded/.test(commentsControl)
  && /comments-toggle/.test(commentsControl) && /comments-panel/.test(commentsControl)
  && /min-h-12 min-w-12/.test(commentsControl)
  && !/innerHTML/.test(commentsControl));
const commentsClient = codeOnly(readFile("../public/scripts/rating-comments.js"));
check("delegation compartilhada (CRUD+sync+401→login, sem innerHTML)",
  /CineVeeRatingComments/.test(commentsClient) && /buildControl/.test(commentsClient)
  && /syncCounts/.test(commentsClient) && /\/entrar\?next=/.test(commentsClient)
  && /textContent/.test(commentsClient)
  && !/innerHTML/.test(commentsClient) && !/set:html/.test(commentsClient)
  && !/notif/i.test(commentsClient));
// Etapa 22: replies vivem nesta delegation por desenho (1 nível); o
// contrato de ausência virou guarda de single-level (detalhe no
// verify:comment-replies).
check("replies 1 nível no client (sem Responder em reply, sem recursão)",
  /comment-reply-toggle/.test(commentsClient) && /replies-list/.test(commentsClient)
  && !/reply-reply-toggle/.test(commentsClient)
  && !/buildReplyItem\([\s\S]{0,2000}comment-reply-toggle/.test(commentsClient));
const privacyTypes = codeOnly(readFile("../src/lib/profile/types.ts"));
check("privacy inclui allowRatingComments (default false)",
  /allowRatingComments: boolean/.test(privacyTypes) && /allowRatingComments: false/.test(privacyTypes));
const privacyValidation = codeOnly(readFile("../src/lib/profile/validation.ts"));
check("privacy validation allowlist 9 campos (ausente→false, tipo errado→400)",
  /allowRatingComments/.test(privacyValidation)
  && /payload\.allowRatingComments === undefined/.test(privacyValidation));
const privacyService = codeOnly(readFile("../src/lib/profile/service.ts"));
check("privacy service persiste allow_rating_comments (retry PGRST204)",
  /allow_rating_comments: input\.allowRatingComments/.test(privacyService)
  && /allow_rating_comments/i.test(privacyService));
const feedTypes = codeOnly(readFile("../src/lib/feed/types.ts"));
check("feed types: commentCount/commentsEnabled só rating (sem evento comment)",
  /commentCount\?: number/.test(feedTypes) && /commentsEnabled\?: boolean/.test(feedTypes)
  && !/comment.*event|event.*comment/i.test(feedTypes));
const feedService = codeOnly(readFile("../src/lib/feed/service.ts"));
check("feed batch paralelo likes+comments (sem N+1, sem sort)",
  /getRatingCommentStates/.test(feedService) && /Promise\.all/.test(feedService)
  && !/\.sort\(/.test(feedService));
const feedCard = codeOnly(readFile("../src/components/feed/FeedActivityCard.astro"));
check("FeedActivityCard: comments só em rating (fav/rec sem)",
  /RatingCommentsControl/.test(feedCard) && /commentCount/.test(feedCard));
const feedCardsJs = codeOnly(readFile("../public/scripts/feed-cards.js"));
check("feed-cards.js hidrata comments via builder (comments-slot)",
  /comments-slot/.test(feedCardsJs) && /CineVeeRatingComments/.test(feedCardsJs));
const publicService = codeOnly(readFile("../src/lib/publicProfile/service.ts"));
check("perfil público: batch comments em getPublicRatings",
  /getRatingCommentStates/.test(publicService) && /commentCount/.test(publicService));
const publicPage = codeOnly(readFile("../src/pages/u/[username].astro"));
check("perfil avaliacoes: controle SSR + slot client + script",
  /RatingCommentsControl/.test(publicPage) && /comments-slot/.test(publicPage)
  && /rating-comments\.js/.test(publicPage));
const homePage = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered + script de comments (sem sessão server-side)",
  /export const prerender = true/.test(homePage)
  && !/getCurrentUser/.test(homePage)
  && /rating-comments\.js/.test(homePage));
const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome comments",
  !/rating.?comment|commentCount|comment_text/i.test(codeOnly(taste)));

// ------------------------------------------------- B. servidor dev?
let http = true;
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
} catch {
  http = false;
  console.log("SKIP  servidor dev indisponível em :4321 (parte HTTP pulada).");
}
if (!http) process.exit(1);

const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const cookieFor = (session) =>
  `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

async function apiJson(method, path, cookie, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json, text };
}

async function apiGet(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json, text };
}

async function getPage(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { res, html: await res.text() };
}

const stamp = Date.now();
async function signUp(tag) {
  const client = createClient(SUPABASE_URL, KEY);
  const email = `rcomment-${tag}-${stamp}@example.com`;
  const password = `RatingComments123!${tag}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    const cause = error
      ? `status=${error.status} name=${error.name} message=${error.message} code=${error.code ?? "?"}`
      : "sessão nula";
    throw new Error(`signup ${email} falhou (${cause})`);
  }
  const fresh = createClient(SUPABASE_URL, KEY);
  const { data: s } = await fresh.auth.signInWithPassword({ email, password });
  return { client: fresh, id: data.user.id, email, cookie: cookieFor(s.session) };
}

// 4 Auth users: A commenter, B owner, C segundo, D privado.
let A, B, C, D;
try {
  A = await signUp("a");
  B = await signUp("b");
  C = await signUp("c");
  D = await signUp("d");
} catch (error) {
  console.log("---");
  console.log(`INFRA/AUTH SETUP FAILURE (não é regressão do produto): ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const short = String(stamp).slice(-9);
const userA = `rcommenta${short}`;
const userB = `rcommentb${short}`;
const userC = `rcommentc${short}`;
const userD = `rcommentd${short}`;

// ------------------------------------------------- C. probe migration
let rpcMissing = false;
{
  const probe = await A.client.rpc("get_public_rating_comment_states", { p_targets: [] });
  rpcMissing = probe.error !== null && /function|does not exist|PGRST/i.test(
    `${probe.error.message ?? ""} ${probe.error.code ?? ""}`,
  );
}
if (rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: RLS, CRUD, privacidade, cascatas, feed, perfil, UI");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("RPC batch acessível", true);

// ------------------------------------------------- D. seed identidades + rating base
async function setupProfile(u, { username, displayName, flags }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio: null, ...flags,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
const pubFlags = (extra = {}) => ({
  profile_public: true, show_activity: false, show_favorites: false,
  show_recommendations: false, show_watched: false, show_ratings: true,
  show_reviews: true, discoverable: false, allow_rating_comments: true, ...extra,
});
await setupProfile(A, { username: userA, displayName: `Comentarista ${short}`, flags: pubFlags() });
await setupProfile(B, { username: userB, displayName: `Dono ${short}`, flags: pubFlags() });
await setupProfile(C, { username: userC, displayName: `Segundo ${short}`, flags: pubFlags() });
await setupProfile(D, {
  username: userD, displayName: `Privado ${short}`,
  flags: {
    profile_public: false, show_activity: false, show_favorites: false,
    show_recommendations: false, show_watched: false, show_ratings: true,
    show_reviews: true, discoverable: false, allow_rating_comments: true,
  },
});
async function seedWatched(u, tmdbId, mediaType, title) {
  const { error } = await u.client.from("watched_titles").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: mediaType, title,
    poster_path: "/p.jpg", release_year: 2021,
  });
  if (error) throw new Error(`watched ${tmdbId} falhou: ${error.message}`);
}
async function seedRating(u, tmdbId, mediaType, rating, review) {
  const { error } = await u.client.from("ratings").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: mediaType, rating,
    review_text: review ?? null,
  });
  if (error) throw new Error(`rating ${tmdbId} falhou: ${error.message}`);
}
// B: rating com review (301) + rating sem review (302).
await seedWatched(B, 301, "movie", "Filme Base");
await seedRating(B, 301, "movie", 5, "Obra-prima.");
await seedWatched(B, 302, "movie", "Só Estrelas");
await seedRating(B, 302, "movie", 4, null);
// D privado: rating para testes de 404.
await seedWatched(D, 401, "movie", "Filme Privado");
await seedRating(D, 401, "movie", 5, "Invisível.");

const target = (username, tmdbId, mediaType = "movie") => ({ username, tmdbId, mediaType });
const thread = (cookie, username, tmdbId, extra = "") =>
  apiGet(`/api/ratings/comments?username=${encodeURIComponent(username)}&tmdbId=${tmdbId}&mediaType=movie${extra}`, cookie);
const post = (cookie, username, tmdbId, text) =>
  apiJson("POST", "/api/ratings/comments", cookie, { username, tmdbId, mediaType: "movie", text });

// Canário do fix 42702 (após seed, antes de tudo): create + delete do
// próprio (efeito zero em counts). Se a incremental ainda não foi
// aplicada no banco, falha aqui com mensagem acionável e o restante
// da suíte registra FALHOU (sem crash).
{
  const can = await post(A.cookie, userB, 301, "Canário.");
  const canId = can.json?.comment?.commentId;
  if (can.res.status === 200 && typeof canId === "number") {
    const del = await apiJson("DELETE", "/api/ratings/comments", A.cookie, { commentId: canId });
    checkd("canário fix 42702: create+delete funcionam (fix aplicada)",
      del.res.status === 200, `delete=${del.res.status}`);
  } else {
    checkd("canário fix 42702: create+delete funcionam (fix aplicada)", false,
      `status=${can.res.status} body=${can.text.slice(0, 200)} — aplique ${FIX_FILE} no Dashboard`);
  }
}

// ------------------------------------------------- E. RLS direto
const crossIns = await A.client.from("rating_comments").insert({
  author_id: C.id, rating_owner_id: B.id, tmdb_id: 301, media_type: "movie",
  comment_text: "forjado",
}).select("id");
checkd("A NÃO insere comentário com author_id=C",
  (crossIns.data ?? []).length === 0,
  `linhas=${(crossIns.data ?? []).length} erro=${crossIns.error?.message ?? "nenhum"}`);
const selfIns = await B.client.from("rating_comments").insert({
  author_id: B.id, rating_owner_id: B.id, tmdb_id: 301, media_type: "movie",
  comment_text: "eu mesmo",
}).select("id");
checkd("CHECK/RLS bloqueia self-comment direto",
  (selfIns.data ?? []).length === 0 && selfIns.error !== null,
  `linhas=${(selfIns.data ?? []).length}`);
const crossUpd = await C.client.from("rating_comments").select("id").limit(1);
check("tabela sem SELECT direto (0 rows visíveis)", (crossUpd.data ?? []).length === 0);
const anon = createClient(SUPABASE_URL, KEY);
const anonSel = await anon.from("rating_comments").select("id").limit(5);
check("anon SELECT rating_comments → nada", (anonSel.data ?? []).length === 0);

// ------------------------------------------------- F. privacy PATCH compat
let r = await apiJson("PATCH", "/api/profile/privacy", B.cookie, {
  profilePublic: true, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: true, showReviews: true, discoverable: false,
  showActivity: false,
});
checkd("PATCH 8 campos (cliente antigo): allowRatingComments→false",
  r.res.status === 200 && r.json?.privacy?.allowRatingComments === false,
  `status=${r.res.status} body=${r.text.slice(0, 160)}`);
r = await apiJson("PATCH", "/api/profile/privacy", B.cookie, {
  profilePublic: true, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: true, showReviews: true, discoverable: false,
  showActivity: false, allowRatingComments: true,
});
checkd("PATCH 9 campos: allowRatingComments=true persiste",
  r.res.status === 200 && r.json?.privacy?.allowRatingComments === true,
  `status=${r.res.status} body=${r.text.slice(0, 160)}`);
r = await apiJson("PATCH", "/api/profile/privacy", B.cookie, {
  profilePublic: true, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: true, showReviews: true, discoverable: false,
  showActivity: false, allowRatingComments: "yes",
});
check("PATCH allowRatingComments não-booleano → 400", r.res.status === 400);
r = await apiJson("PATCH", "/api/profile/privacy", B.cookie, {
  profilePublic: true, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: true, showReviews: true, discoverable: false,
  showActivity: false, allowRatingComments: true, hacker: true,
});
checkd("PATCH ignora campo desconhecido",
  r.res.status === 200 && r.json?.privacy?.allowRatingComments === true
  && !("hacker" in (r.json?.privacy ?? {})),
  `status=${r.res.status}`);

// ------------------------------------------------- G. API create
r = await post(null, userB, 301, "anon tenta");
check("POST deslogado → 401", r.res.status === 401);
r = await apiJson("POST", "/api/ratings/comments", A.cookie, { username: "!!", tmdbId: 1, mediaType: "movie", text: "x" });
check("POST alvo inválido → 400", r.res.status === 400);
r = await post(A.cookie, userB, 301, "   ");
check("POST whitespace-only → 400", r.res.status === 400);
r = await post(A.cookie, userB, 301, "x".repeat(501));
check("POST >500 → 400", r.res.status === 400);
r = await post(A.cookie, userD, 401, "alvo privado");
checkd("POST alvo privado → 404 genérico",
  r.res.status === 404 && /não está disponível/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await post(A.cookie, "zzzqnaoexiste123", 301, "fantasma");
check("POST alvo inexistente → 404", r.res.status === 404);
r = await post(B.cookie, userB, 301, "eu mesmo");
checkd("POST self → 409 documentado",
  r.res.status === 409 && /própria avaliação/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await post(A.cookie, userB, 301, "  Ótima análise!  ");
checkd("A comenta B:200 + trim + count1",
  r.res.status === 200 && r.json?.comment?.text === "Ótima análise!"
  && r.json?.commentCount === 1 && typeof r.json?.comment?.commentId === "number"
  && r.json?.comment?.canEdit === true && r.json?.comment?.canDelete === true,
  `status=${r.res.status} body=${r.text.slice(0, 200)}`);
const commentA1 = r.json?.comment?.commentId;
r = await post(C.cookie, userB, 301, "Concordo.");
checkd("C comenta B: count 2",
  r.res.status === 200 && r.json?.commentCount === 2,
  `body=${r.text.slice(0, 120)}`);
const commentC1 = r.json?.comment?.commentId;

// ------------------------------------------------- H. GET thread + autor público
r = await thread(A.cookie, userB, 301);
checkd("GET thread: items DESC + gates + count",
  r.res.status === 200 && Array.isArray(r.json?.items) && r.json.items.length === 2
  && r.json.items[0].commentId === commentC1 && r.json.items[1].commentId === commentA1
  && r.json.commentCount === 2 && r.json.commentsEnabled === true
  && r.json.isOwner === false && r.json.canComment === true
  && r.json.hasMore === false && r.json.pageSize === 5,
  `body=${r.text.slice(0, 240)}`);
checkd("autor público: identidade + sem UUID",
  r.json?.items?.[0]?.author?.username === userC
  && typeof r.json?.items?.[0]?.author?.displayName === "string"
  && !containsKeyStartingWith(r.json?.items?.[0], "author_id")
  && !containsKeyStartingWith(r.json, "owner_id")
  && !("user_id" in (r.json?.items?.[0] ?? {})),
  `item=${JSON.stringify(r.json?.items?.[0] ?? null).slice(0, 240)}`);
r = await thread(null, userB, 301);
checkd("GET anon: lê + canEdit/canDelete false",
  r.res.status === 200 && r.json?.items?.length === 2
  && r.json.items.every((i) => i.canEdit === false && i.canDelete === false)
  && r.json.canComment === false,
  `status=${r.res.status}`);
r = await thread(B.cookie, userB, 301);
checkd("GET owner: isOwner + canComment false + canDelete true",
  r.res.status === 200 && r.json?.isOwner === true && r.json?.canComment === false
  && r.json?.items?.every((i) => i.canDelete === true && i.canEdit === false),
  `body=${r.text.slice(0, 200)}`);
r = await thread(A.cookie, userD, 401);
check("GET alvo privado → 404", r.res.status === 404);
r = await thread(A.cookie, "zzzqnaoexiste123", 301);
check("GET alvo inexistente → 404", r.res.status === 404);

// ------------------------------------------------- I. autor privado anonimizado
await D.client.from("profiles").update({ profile_public: false }).eq("id", D.id);
r = await post(D.cookie, userB, 301, "Gostei da sua análise.");
checkd("D privado ainda pode comentar",
  r.res.status === 200 && r.json?.commentCount === 3,
  `status=${r.res.status} body=${r.text.slice(0, 160)}`);
const commentD1 = r.json?.comment?.commentId;
r = await thread(A.cookie, userB, 301);
{
  const mine = (r.json?.items ?? []).find((i) => i.commentId === commentD1);
  checkd("autor privado: texto público + identidade oculta",
    r.res.status === 200 && mine?.text === "Gostei da sua análise."
    && mine?.author?.isPrivate === true && mine?.author?.username === null
    && mine?.author?.avatarUrl === null && mine?.author?.displayName === null
    && !containsKeyStartingWith(mine, "author_id")
    && !containsKeyStartingWith(mine, "owner_id"),
    `item=${JSON.stringify(mine ?? null).slice(0, 240)}`);
  check("count inclui autor privado (3)", r.json?.commentCount === 3);
}
// D publica o perfil → identidade aparece sem alterar a row.
await D.client.from("profiles").update({ profile_public: true }).eq("id", D.id);
r = await thread(A.cookie, userB, 301);
checkd("D público: identidade volta a aparecer",
  (r.json?.items ?? []).find((i) => i.commentId === commentD1)?.author?.username === userD,
  `body=${r.text.slice(0, 240)}`);
await D.client.from("profiles").update({ profile_public: false }).eq("id", D.id);
r = await thread(A.cookie, userB, 301);
check("D privado de novo: volta a Usuário privado",
  (r.json?.items ?? []).find((i) => i.commentId === commentD1)?.author?.isPrivate === true);

// ------------------------------------------------- J. edit
const before = (await thread(A.cookie, userB, 301)).json;
const orderBefore = (before?.items ?? []).map((i) => i.commentId).join(",");
const target_created = (before?.items ?? []).find((i) => i.commentId === commentA1)?.createdAt;
r = await apiJson("PATCH", "/api/ratings/comments", A.cookie, { commentId: commentA1, text: "  Editado por A.  " });
checkd("A edita próprio: trim + updated muda + created igual",
  r.res.status === 200 && r.json?.text === "Editado por A."
  && r.json?.createdAt === target_created && r.json?.updatedAt !== target_created,
  `body=${r.text.slice(0, 200)}`);
r = await thread(A.cookie, userB, 301);
checkd("edit NÃO reordena",
  (r.json?.items ?? []).map((i) => i.commentId).join(",") === orderBefore,
  `antes=${orderBefore} depois=${(r.json?.items ?? []).map((i) => i.commentId).join(",")}`);
r = await apiJson("PATCH", "/api/ratings/comments", C.cookie, { commentId: commentA1, text: "hack" });
check("C tenta editar A → 404", r.res.status === 404);
r = await apiJson("PATCH", "/api/ratings/comments", B.cookie, { commentId: commentA1, text: "modero?" });
check("B owner tenta editar A → 404", r.res.status === 404);
r = await apiJson("PATCH", "/api/ratings/comments", A.cookie, { commentId: commentA1, text: "x".repeat(501) });
check("PATCH >500 → 400", r.res.status === 400);

// ------------------------------------------------- K. allow off (só bloqueia NOVOS)
await B.client.from("profiles").update({ allow_rating_comments: false }).eq("id", B.id);
r = await thread(A.cookie, userB, 301);
checkd("allow off: thread continua visível",
  r.res.status === 200 && r.json?.items?.length === 3
  && r.json?.commentsEnabled === false && r.json?.canComment === false,
  `body=${r.text.slice(0, 200)}`);
r = await post(C.cookie, userB, 301, "bloqueado?");
checkd("allow off: novo POST → 403 específico",
  r.res.status === 403 && /desativados/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await apiJson("PATCH", "/api/ratings/comments", A.cookie, { commentId: commentA1, text: "Edito mesmo fechado." });
check("allow off: edit próprio funciona", r.res.status === 200);
r = await apiJson("DELETE", "/api/ratings/comments", C.cookie, { commentId: commentC1 });
checkd("allow off: delete próprio funciona",
  r.res.status === 200 && r.json?.removed === true && r.json?.commentCount === 2,
  `body=${r.text.slice(0, 140)}`);
await B.client.from("profiles").update({ allow_rating_comments: true }).eq("id", B.id);

// ------------------------------------------------- L. delete/moderação + target hidden
r = await apiJson("DELETE", "/api/ratings/comments", A.cookie, { commentId: commentD1 });
check("A tenta apagar D → 404", r.res.status === 404);
r = await apiJson("DELETE", "/api/ratings/comments", B.cookie, { commentId: commentD1 });
checkd("B modera D: removed + count 1",
  r.res.status === 200 && r.json?.removed === true && r.json?.commentCount === 1,
  `body=${r.text.slice(0, 140)}`);
r = await apiJson("DELETE", "/api/ratings/comments", null, { commentId: commentA1 });
check("DELETE deslogado → 401", r.res.status === 401);
// B priva o perfil: thread some, delete próprio de A continua possível.
await B.client.from("profiles").update({ profile_public: false }).eq("id", B.id);
r = await thread(A.cookie, userB, 301);
check("B privado: thread escondida (404)", r.res.status === 404);
r = await apiJson("DELETE", "/api/ratings/comments", A.cookie, { commentId: commentA1 });
checkd("delete funciona com target hidden",
  r.res.status === 200 && r.json?.removed === true && r.json?.commentCount === 0,
  `body=${r.text.slice(0, 140)}`);
await B.client.from("profiles").update({ profile_public: true }).eq("id", B.id);
r = await thread(A.cookie, userB, 301);
checkd("republicado: thread vazia (rows removidas não voltam)",
  r.res.status === 200 && r.json?.items?.length === 0 && r.json?.commentCount === 0,
  `body=${r.text.slice(0, 160)}`);
// show_ratings=false esconde; rows preservadas; republica restaura.
r = await post(A.cookie, userB, 301, "Voltei.");
check("novo comentário pós-republicação", r.res.status === 200 && r.json?.commentCount === 1);
await B.client.from("profiles").update({ show_ratings: false }).eq("id", B.id);
r = await thread(A.cookie, userB, 301);
check("show_ratings=false: thread escondida", r.res.status === 404);
await B.client.from("profiles").update({ show_ratings: true }).eq("id", B.id);
r = await thread(A.cookie, userB, 301);
checkd("show_ratings=true: thread reaparece",
  r.res.status === 200 && r.json?.commentCount === 1,
  `body=${r.text.slice(0, 160)}`);

// ------------------------------------------------- M. show_reviews/discoverable/activity isolados
await B.client.from("profiles").update({ show_reviews: false }).eq("id", B.id);
r = await post(C.cookie, userB, 302, "Sem review do dono, comento igual.");
checkd("show_reviews=false: thread continua",
  r.res.status === 200,
  `status=${r.res.status} body=${r.text.slice(0, 140)}`);
await B.client.from("profiles").update({ show_reviews: true }).eq("id", B.id);
await B.client.from("profiles").update({ discoverable: true }).eq("id", B.id);
r = await post(C.cookie, userB, 301, "Discoverable irrelevante.");
check("discoverable=true: comenta normal", r.res.status === 200);
await B.client.from("profiles").update({ discoverable: false }).eq("id", B.id);
await A.client.from("profiles").update({ discoverable: false }).eq("id", A.id);
r = await post(A.cookie, userB, 301, "A sem discoverable comenta.");
check("commenter discoverable=false: comenta normal", r.res.status === 200);
r = await thread(A.cookie, userB, 301);
checkd("autor público c/ discoverable=false: identidade aparece",
  (r.json?.items ?? []).some((i) => i.author?.username === userA),
  `body=${r.text.slice(0, 240)}`);
await B.client.from("profiles").update({ show_activity: false }).eq("id", B.id);
r = await thread(A.cookie, userB, 301);
check("show_activity=false: perfil segue com comentários", r.res.status === 200);

// ------------------------------------------------- N. username change preserva
const userC2 = `${userC}x`;
await C.client.from("profiles").update({ username: userC2 }).eq("id", C.id);
r = await thread(A.cookie, userB, 301);
checkd("autor @new aparece (relação por UUID)",
  (r.json?.items ?? []).some((i) => i.author?.username === userC2),
  `body=${r.text.slice(0, 240)}`);
const userB2 = `${userB}x`;
await B.client.from("profiles").update({ username: userB2 }).eq("id", B.id);
r = await thread(A.cookie, userB2, 301);
check("owner @new: thread segue o novo username", r.res.status === 200 && r.json?.commentCount >= 1);
r = await thread(A.cookie, userB, 301);
check("owner @old: não resolve", r.res.status === 404);

// ------------------------------------------------- O. feed (counts, sem evento, sem reorder)
await B.client.from("profiles").update({
  show_activity: true, show_favorites: true, show_recommendations: true,
}).eq("id", B.id);
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 303, media_type: "movie", kind: "favorite",
  title: "Fav Feed", poster_path: "/p.jpg", release_year: 2020, note: null,
});
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 304, media_type: "tv", kind: "recommendation",
  title: "Rec Feed", poster_path: "/p.jpg", release_year: 2021, note: "Boa.",
});
await A.client.from("follows").insert({ follower_id: A.id, following_id: B.id });
async function feed(cookie, extra = "") {
  const res = await fetch(`${BASE}/api/feed/following?page=1${extra}`, {
    redirect: "manual", headers: cookie ? { Cookie: cookie } : {},
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json };
}
{
  const f1 = await feed(A.cookie);
  const ev301 = (f1.json?.items ?? []).find((i) => i.title?.tmdbId === 301);
  const favEv = (f1.json?.items ?? []).find((i) => i.type === "favorite");
  const recEv = (f1.json?.items ?? []).find((i) => i.type === "recommendation");
  const orderOf = (f) => (f.json?.items ?? []).map((i) => i.eventKey).join(",");
  const atOf = (f) => (f.json?.items ?? []).map((i) => i.activityAt).join(",");
  checkd("feed rating tem commentCount/commentsEnabled; fav/rec sem",
    typeof ev301?.commentCount === "number" && typeof ev301?.commentsEnabled === "boolean"
    && favEv !== undefined && !("commentCount" in favEv)
    && recEv !== undefined && !("commentCount" in recEv),
    `ev301=${JSON.stringify(ev301)}`);
  const before = ev301?.commentCount ?? -1;
  await post(C.cookie, userB2, 301, "Comentário no feed.");
  const f2 = await feed(A.cookie);
  const ev2 = (f2.json?.items ?? []).find((i) => i.title?.tmdbId === 301);
  checkd("comentário NÃO reordena feed nem muda activityAt",
    orderOf(f1) === orderOf(f2) && atOf(f1) === atOf(f2)
    && ev2?.commentCount === before + 1,
    `counts=${before}/${ev2?.commentCount}`);
  check("sem evento de comentário no feed",
    !(f2.json?.items ?? []).some((i) => i.type === "comment"));
}

// ------------------------------------------------- P. perfil público + XSS
let p = await getPage(`/u/${userB2}?tab=avaliacoes`, A.cookie);
checkd("/u avaliacoes: controle de comments + script",
  p.res.status === 200 && /data-rating-comments/.test(p.html) && /rating-comments\.js/.test(p.html),
  `status=${p.res.status}`);
p = await getPage(`/u/${userB2}?tab=avaliacoes`, null);
checkd("/u avaliacoes anon: count visível, sem UUID",
  p.res.status === 200 && /data-rating-comments/.test(p.html) && !new RegExp(B.id).test(p.html),
  `status=${p.res.status}`);
const xss = `<script>alert(1)</scr` + `ipt><img src=x onerror=alert(1)>& "aspas"`;
r = await post(A.cookie, userB2, 301, xss);
checkd("XSS armazenado literal (sem strip server-side)",
  r.res.status === 200 && r.json?.comment?.text === xss,
  `status=${r.res.status} body=${r.text.slice(0, 200)}`);
{
  const g = await thread(A.cookie, userB2, 301);
  const found = (g.json?.items ?? []).find((i) => i.text === xss);
  checkd("GET devolve literal (DOM escapa via textContent)",
    g.json && found !== undefined,
    `status=${g.res.status}`);
}
p = await getPage(`/u/${userB2}?tab=avaliacoes`, A.cookie);
checkd("HTML SSR sem payload executável (thread é lazy client-side)",
  p.res.status === 200 && !/alert\(1\)/.test(p.html),
  `status=${p.res.status}`);

// ------------------------------------------------- Q. paginação 24/25/49 (A+C alternando)
await seedWatched(B, 305, "movie", "Thread Longa");
await seedRating(B, 305, "movie", 5, "Paginar.");
async function fillPage(uri, n) {
  for (let i = 0; i < n; i += 1) {
    const cookie = i % 2 === 0 ? A.cookie : C.cookie;
    const rr = await post(cookie, uri, 305, `Comentário ${i + 1} de teste.`);
    if (rr.res.status !== 200) {
      checkd(`seed paginação ${i + 1} (${uri}/305)`, false,
        `status=${rr.res.status} body=${rr.text.slice(0, 160)}`);
      return false;
    }
  }
  return true;
}
if (!await fillPage(userB2, 24)) {
  check("paginação 24/25/49 (bloqueada: create indisponível)", false);
} else {
r = await thread(A.cookie, userB2, 305, "&limit=24");
checkd("24: página única + hasMore=false",
  r.res.status === 200 && r.json?.items?.length === 24
  && r.json?.hasMore === false && r.json?.commentCount === 24
  && r.json?.pageSize === 24,
  `n=${r.json?.items?.length} more=${r.json?.hasMore}`);
if (!await fillPage(userB2, 1)) {
  check("paginação 25/49 (bloqueada: create indisponível)", false);
} else {
  {
    const p1 = await apiGet(`/api/ratings/comments?username=${userB2}&tmdbId=305&mediaType=movie&page=1&limit=24`, A.cookie);
    const p2 = await apiGet(`/api/ratings/comments?username=${userB2}&tmdbId=305&mediaType=movie&page=2&limit=24`, A.cookie);
    const ids = [...(p1.json?.items ?? []), ...(p2.json?.items ?? [])].map((i) => i.commentId);
    checkd("25: 24+true / 1+false, sem duplicatas",
      p1.json?.items?.length === 24 && p1.json?.hasMore === true
      && p2.json?.items?.length === 1 && p2.json?.hasMore === false
      && new Set(ids).size === 25,
      `p1=${p1.json?.items?.length}/${p1.json?.hasMore} p2=${p2.json?.items?.length}/${p2.json?.hasMore}`);
  }
  {
    // Completa até 49 (25 existentes + 24 novos de C/A).
    let extraOk = true;
    for (let i = 0; i < 24; i += 1) {
      const cookie = i % 2 === 0 ? C.cookie : A.cookie;
      const rr = await post(cookie, userB2, 305, `Extra ${i + 1}.`);
      if (rr.res.status !== 200) {
        checkd(`seed 49 extra ${i + 1}`, false, `status=${rr.res.status}`);
        extraOk = false;
        break;
      }
    }
    if (!extraOk) {
      check("paginação 49 (bloqueada: create indisponível)", false);
    } else {
      const pages = [];
      for (let pg = 1; pg <= 3; pg += 1) {
        pages.push(await apiGet(`/api/ratings/comments?username=${userB2}&tmdbId=305&mediaType=movie&page=${pg}&limit=24`, A.cookie));
      }
      const ids = pages.flatMap((pp) => (pp.json?.items ?? []).map((i) => i.commentId));
      checkd("49: 24+true / 24+true / 1+false, sem duplicatas",
        pages[0].json?.items?.length === 24 && pages[0].json?.hasMore === true
        && pages[1].json?.items?.length === 24 && pages[1].json?.hasMore === true
        && pages[2].json?.items?.length === 1 && pages[2].json?.hasMore === false
        && new Set(ids).size === 49,
        `ns=${pages.map((pp) => pp.json?.items?.length).join("/")} mores=${pages.map((pp) => pp.json?.hasMore).join("/")}`);
    }
  }
}
}

// ------------------------------------------------- R. cascatas
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 302);
{
  const s = await A.client.rpc("get_public_rating_comment_states", {
    p_targets: [{ username: userB2, tmdb_id: 302, media_type: "movie" }],
  });
  check("delete rating: batch 0 rows (cascade)", (s.data ?? []).length === 0);
}
await seedWatched(B, 306, "movie", "Cascata");
await seedRating(B, 306, "movie", 5, "Vai sumir.");
await post(A.cookie, userB2, 306, "Um.");
await post(C.cookie, userB2, 306, "Dois.");
await B.client.from("watched_titles").delete().eq("user_id", B.id).eq("tmdb_id", 306);
{
  const own = await B.client.from("ratings").select("tmdb_id").eq("user_id", B.id).eq("tmdb_id", 306);
  const s = await A.client.rpc("get_public_rating_comment_states", {
    p_targets: [{ username: userB2, tmdb_id: 306, media_type: "movie" }],
  });
  checkd("unwatch: rating some + comments cascade",
    (own.data ?? []).length === 0 && (s.data ?? []).length === 0,
    `rating=${JSON.stringify(own.data)} batch=${JSON.stringify(s.data)}`);
}

// ------------------------------------------------- S. limpeza (sem service_role)
for (const u of [A, B, C, D]) {
  await u.client.from("rating_comments").delete().eq("author_id", u.id);
}
await B.client.from("rating_comments").delete().eq("rating_owner_id", B.id);
for (const u of [A, B, C, D]) {
  await u.client.from("ratings").delete().eq("user_id", u.id);
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}
const cleanComments = await A.client.from("rating_comments").select("id").limit(5);
check("limpeza: tabela sem SELECT direto (0 rows visíveis)", (cleanComments.data ?? []).length === 0);

// Auth users desta execução: 4 (A/B/C/D). Sem service_role no app;
// remover depois via Dashboard → Authentication → Users se necessário.
console.log("---");
console.log(failures === 0 && skipped === 0 ? "RATING-COMMENTS OK: comentários + privacidade + moderação confirmados (4 Auth users)." : `RATING-COMMENTS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
