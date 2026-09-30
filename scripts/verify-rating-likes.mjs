/**
 * Verificação da Etapa 18: curtidas em avaliações (rating_likes).
 *
 * Pré-requisito: migration supabase/migrations/20261004090000_rating_likes.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem da tabela/RPCs entram em SKIP
 * identificado (exit 1); contratos de arquivo rodam sempre.
 *
 * Uso: npm run verify:rating-likes (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration (tabela, PK quarteto, FK composta NA ORDEM da UNIQUE de
 *   ratings, cascades, anti-self CHECK, índice, RLS sem SELECT/UPDATE,
 *   3 RPCs SECURITY DEFINER, grants mínimos, sem discoverable/activity/
 *   reviews como gate, sem lista de likers);
 * - RLS direto (insert/delete cruzado bloqueado, self CHECK, anon nada);
 * - like/unlike (idempotentes, counts, self 409, 404 genérico);
 * - privacidade (flags independentes, preservação, unlike hidden,
 *   username change, cascades rating+watched);
 * - feed (likeCount/likedByViewer só em rating, sem reorder, sem N+1);
 * - perfil público (SSR + Carregar mais, owner estático, anon count);
 * - UI (aria-pressed, labels, optimistic+rollback, delegation, sync,
 *   sem innerHTML, sem UUID, sem display_name em aria);
 * - TasteProfile/feed-ranking intocados.
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e APENAS 4
 * Auth users (A liker, B owner, C segundo liker, D privado).
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

const MIGRATION_FILE = "supabase/migrations/20261004090000_rating_likes.sql";

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
check("migration Etapa 18 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
const migrationCode = codeOnly(migration);
check("migration tabela rating_likes (tipos iguais a ratings, PK quarteto)",
  /create table if not exists public\.rating_likes/i.test(migration)
  && /liker_id uuid not null/i.test(migration)
  && /rating_owner_id uuid not null/i.test(migration)
  && /tmdb_id bigint not null/i.test(migration)
  && /media_type text not null/i.test(migration)
  && /primary key \(liker_id, rating_owner_id, media_type, tmdb_id\)/i.test(migration));
check("migration FK composta NA ORDEM da UNIQUE + cascades + anti-self",
  /foreign key \(rating_owner_id, media_type, tmdb_id\)\s*references public\.ratings \(user_id, media_type, tmdb_id\)\s*on delete cascade/i.test(migration)
  && /liker_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /check \(liker_id <> rating_owner_id\)/i.test(migration)
  && /check \(media_type in \('movie', 'tv'\)\)/i.test(migration));
check("migration índice por rating (sem PK de liker p/ contagem)",
  /rating_likes_rating_idx[\s\S]{0,120}\(rating_owner_id, media_type, tmdb_id\)/i.test(migration));
check("migration RLS (insert/delete próprios, sem SELECT/UPDATE)",
  /enable row level security/i.test(migration)
  && /for insert[\s\S]{0,160}with check \(liker_id = auth\.uid\(\)\)/i.test(migration)
  && /for delete[\s\S]{0,160}using \(liker_id = auth\.uid\(\)\)/i.test(migration)
  && !/for update/i.test(migration)
  && !/for select/i.test(migration)
  && !/create policy[^;]*\bto\s+(anon|public)\b/i.test(migration));
check("migration 3 RPCs SECURITY DEFINER (like/unlike VOLATILE, batch STABLE)",
  /function public\.like_rating_by_username/i.test(migration)
  && /function public\.unlike_rating_by_username/i.test(migration)
  && /function public\.get_public_rating_like_states/i.test(migration)
  && (migration.match(/security definer/gi) || []).length >= 3
  && (migration.match(/set search_path = public/gi) || []).length >= 3
  && !/execute\s+format|execute\s+['"]select/i.test(migration));
check("migration gates só public+show_ratings (sem discoverable/activity/reviews)",
  /profile_public is true[\s\S]{0,400}show_ratings is true/i.test(migrationCode)
  && !/discoverable/i.test(migrationCode)
  && !/show_activity/i.test(migrationCode)
  && !/show_reviews/i.test(migrationCode));
check("migration grants mínimos (like/unlike só auth, batch anon+auth)",
  /grant execute on function public\.like_rating_by_username\(text, bigint, text\) to authenticated/i.test(migration)
  && /grant execute on function public\.unlike_rating_by_username\(text, bigint, text\) to authenticated/i.test(migration)
  && /grant execute on function public\.get_public_rating_like_states\(jsonb\) to anon, authenticated/i.test(migration)
  && (migration.match(/revoke all on function public\./gi) || []).length >= 3);
check("migration sem lista likers/activities/ranking (só count+estado)",
  !/liker.*username|liker.*display|likers list/i.test(migrationCode)
  && !/order by.*like_count/i.test(migrationCode)
  && !/create trigger/i.test(migrationCode)
  && !/returns table \([^)]*(liker_id|owner_id|email)/i.test(migrationCode));

const likeTypes = codeOnly(readFile("../src/lib/ratingLikes/types.ts"));
check("lib ratingLikes types (target sem UUID, batch 24)",
  /RatingLikeTarget/.test(likeTypes) && /RatingLikeState/.test(likeTypes)
  && /RATING_LIKE_BATCH_SIZE = 24/.test(likeTypes)
  && !/user_id|userId|liker_id|owner_id/i.test(likeTypes));
const likeValidation = codeOnly(readFile("../src/lib/ratingLikes/validation.ts"));
check("lib validation (username+tmdb+media, sem UUID)",
  /validateRatingLikeTarget/.test(likeValidation)
  && /USERNAME_PATTERN/.test(likeValidation)
  && /movie/.test(likeValidation) && /tmdbId/.test(likeValidation)
  && !/user_id|userId|liker_id|owner_id/i.test(likeValidation));
const likeService = codeOnly(readFile("../src/lib/ratingLikes/service.ts"));
check("lib service (RPCs, auth.uid server-side, log real, sem tabela direta)",
  /like_rating_by_username/.test(likeService)
  && /unlike_rating_by_username/.test(likeService)
  && /get_public_rating_like_states/.test(likeService)
  && /SelfLikeError/.test(likeService)
  && !/from\("rating_likes"\)|from\('rating_likes'\)/.test(likeService)
  && !/liker_id|owner_id/i.test(likeService));
const likesApi = codeOnly(readFile("../src/pages/api/ratings/likes.ts"));
check("API likes POST/DELETE (401/400/404/409, sem UUID)",
  /export const POST/.test(likesApi) && /export const DELETE/.test(likesApi)
  && /status: 401/.test(likesApi) && /status: 404/.test(likesApi)
  && /status: 409/.test(likesApi)
  && !/user_id|userId|liker_id|owner_id/i.test(likesApi));
const likeControl = codeOnly(readFile("../src/components/ratings/RatingLikeControl.astro"));
check("RatingLikeControl (aria-pressed, labels, 48px, sem display_name)",
  /data-rating-like/.test(likeControl) && /aria-pressed/.test(likeControl)
  && /Curtir avaliação/.test(likeControl) && /Remover curtida da avaliação/.test(likeControl)
  && /min-h-12 min-w-12/.test(likeControl)
  && !/displayName|display_name/.test(likeControl)
  && !/innerHTML/.test(likeControl));
const likeClient = codeOnly(readFile("../public/scripts/rating-likes.js"));
check("delegation compartilhada (optimistic+rollback, sync, 401→login)",
  /CineVeeRatingLikes/.test(likeClient) && /buildControl/.test(likeClient)
  && /syncAll/.test(likeClient) && /\/entrar\?next=/.test(likeClient)
  && !/innerHTML/.test(likeClient));
const feedCard = codeOnly(readFile("../src/components/feed/FeedActivityCard.astro"));
check("FeedActivityCard: like só em rating (fav/rec sem botão)",
  /RatingLikeControl/.test(feedCard) && /event\.type === "rating"/.test(feedCard)
  && /likeCount/.test(feedCard));
const feedCardsJs = codeOnly(readFile("../public/scripts/feed-cards.js"));
check("feed-cards.js hidrata like via builder (rating c/ count)",
  /like-slot/.test(feedCardsJs) && /buildControl/.test(feedCardsJs));
const homePage = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered + scripts sociais (sem sessão server-side)",
  /export const prerender = true/.test(homePage)
  && !/getCurrentUser/.test(homePage)
  && /feed-cards\.js/.test(homePage) && /rating-likes\.js/.test(homePage));
const seguindoPage = codeOnly(readFile("../src/pages/seguindo.astro"));
check("/seguindo usa delegation de likes", /rating-likes\.js/.test(seguindoPage));
const publicPage = codeOnly(readFile("../src/pages/u/[username].astro"));
check("perfil avaliacoes: controle SSR + estático p/ dono + slot client",
  /RatingLikeControl/.test(publicPage) && /interactive=\{!isSelf\}/.test(publicPage)
  && /data-viewer-is-self/.test(publicPage) && /like-slot/.test(publicPage)
  && /rating-likes\.js/.test(publicPage));
const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome likes", !/rating.?like|liker_id|likeCount/i.test(codeOnly(taste)));
check("feed sem ranking por likes (sem sort, sem order)",
  !/\.sort\(/.test(codeOnly(readFile("../src/lib/feed/service.ts")))
  && !/order by[^\n]*like/i.test(migrationCode));

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
  const email = `rlike-${tag}-${stamp}@example.com`;
  const password = `RatingLikes123!${tag}`;
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

// 4 Auth users: A liker, B owner, C segundo liker, D privado.
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
const userA = `rlikea${short}`;
const userB = `rlikeb${short}`;
const userC = `rlikec${short}`;
const userD = `rliked${short}`;

// ------------------------------------------------- C. probe migration
let rpcMissing = false;
{
  const probe = await A.client.rpc("get_public_rating_like_states", { p_targets: [] });
  rpcMissing = probe.error !== null && /function|does not exist|PGRST/i.test(
    `${probe.error.message ?? ""} ${probe.error.code ?? ""}`,
  );
}
if (rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: RLS, like/unlike, privacidade, cascatas, feed, perfil, UI");
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
  show_reviews: true, discoverable: false, ...extra,
});
await setupProfile(A, { username: userA, displayName: `Liker ${short}`, flags: pubFlags() });
await setupProfile(B, { username: userB, displayName: `Dono ${short}`, flags: pubFlags() });
await setupProfile(C, { username: userC, displayName: `Liker2 ${short}`, flags: pubFlags() });
await setupProfile(D, {
  username: userD, displayName: `Privado ${short}`,
  flags: {
    profile_public: false, show_activity: false, show_favorites: false,
    show_recommendations: false, show_watched: false, show_ratings: true,
    show_reviews: true, discoverable: false,
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
// B: rating com review (101) + rating só-estrelas (102, show_reviews=false likeable).
await seedWatched(B, 101, "movie", "Filme Base");
await seedRating(B, 101, "movie", 5, "Obra-prima.");
await seedWatched(B, 102, "movie", "Só Estrelas");
await seedRating(B, 102, "movie", 4, null);
// D privado: rating para testes de 404/batch oculto.
await seedWatched(D, 201, "movie", "Filme Privado");
await seedRating(D, 201, "movie", 5, "Invisível.");

const target = (username, tmdbId, mediaType = "movie") => ({ username, tmdbId, mediaType });
async function batch(cookie, targets) {
  const client = cookie === A.cookie ? A.client : cookie === C.cookie ? C.client : createClient(SUPABASE_URL, KEY);
  return client.rpc("get_public_rating_like_states", {
    p_targets: targets.map((t) => ({ username: t.username, tmdb_id: t.tmdbId, media_type: t.mediaType })),
  });
}

// ------------------------------------------------- E. RLS direto
const crossIns = await A.client.from("rating_likes").insert({
  liker_id: C.id, rating_owner_id: B.id, tmdb_id: 101, media_type: "movie",
}).select("liker_id");
checkd("A NÃO insere like com liker_id=C",
  (crossIns.data ?? []).length === 0,
  `linhas=${(crossIns.data ?? []).length} erro=${crossIns.error?.message ?? "nenhum"}`);
const selfIns = await B.client.from("rating_likes").insert({
  liker_id: B.id, rating_owner_id: B.id, tmdb_id: 101, media_type: "movie",
}).select("liker_id");
checkd("CHECK/RLS bloqueia self-like direto",
  (selfIns.data ?? []).length === 0 && selfIns.error !== null,
  `linhas=${(selfIns.data ?? []).length}`);
const anon = createClient(SUPABASE_URL, KEY);
const anonSel = await anon.from("rating_likes").select("liker_id").limit(5);
check("anon SELECT rating_likes → nada", (anonSel.data ?? []).length === 0);

// ------------------------------------------------- F. API like/unlike
let r = await apiJson("POST", "/api/ratings/likes", null, target(userB, 101));
check("POST deslogado → 401", r.res.status === 401);
r = await apiJson("DELETE", "/api/ratings/likes", null, target(userB, 101));
check("DELETE deslogado → 401", r.res.status === 401);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, { username: "!!", tmdbId: 1, mediaType: "movie" });
check("POST inválido → 400", r.res.status === 400);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, { username: userB, tmdbId: -5, mediaType: "movie" });
check("POST tmdb inválido → 400", r.res.status === 400);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target(userD, 201));
checkd("POST alvo privado → 404 genérico",
  r.res.status === 404 && /Avaliação indisponível/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target("zzzqnaoexiste123", 101));
check("POST alvo inexistente → 404", r.res.status === 404);
r = await apiJson("POST", "/api/ratings/likes", B.cookie, target(userB, 101));
checkd("POST self-like → 409 documentado",
  r.res.status === 409 && /própria avaliação/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 101));
checkd("A curte B:200 liked+count1",
  r.res.status === 200 && r.json?.liked === true && r.json?.likeCount === 1,
  `status=${r.res.status} body=${r.text.slice(0, 120)}`);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 101));
check("POST duplicado idempotente (1 row)",
  r.res.status === 200 && r.json?.liked === true && r.json?.likeCount === 1);
r = await apiJson("POST", "/api/ratings/likes", C.cookie, target(userB, 101));
checkd("C curte B: count 2",
  r.res.status === 200 && r.json?.likeCount === 2,
  `body=${r.text.slice(0, 120)}`);

// ------------------------------------------------- G. batch states por viewer
{
  const asA = await batch(A.cookie, [target(userB, 101)]);
  const asC = await batch(C.cookie, [target(userB, 101)]);
  const asAnon = await anon.rpc("get_public_rating_like_states", {
    p_targets: [{ username: userB, tmdb_id: 101, media_type: "movie" }],
  });
  checkd("batch A: count2 liked true",
    asA.data?.[0]?.like_count === 2 && asA.data?.[0]?.liked_by_viewer === true,
    `data=${JSON.stringify(asA.data)}`);
  check("batch C: liked true", asC.data?.[0]?.liked_by_viewer === true);
  checkd("batch anon: count2 liked false + sem UUID",
    asAnon.data?.[0]?.like_count === 2 && asAnon.data?.[0]?.liked_by_viewer === false
    && !containsKeyStartingWith(asAnon.data?.[0], "liker")
    && !("user_id" in (asAnon.data?.[0] ?? {})),
    `data=${JSON.stringify(asAnon.data)}`);
  const hidden = await batch(A.cookie, [target(userD, 201)]);
  check("batch alvo privado → 0 rows", (hidden.data ?? []).length === 0);
}

// ------------------------------------------------- H. privacidade das flags
await B.client.from("profiles").update({ show_reviews: false }).eq("id", B.id);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 102));
checkd("show_reviews=false: só-estrelas likeable (review some do perfil)",
  r.res.status === 200 && r.json?.liked === true,
  `status=${r.res.status}`);
await B.client.from("profiles").update({ show_reviews: true }).eq("id", B.id);
await B.client.from("profiles").update({ show_activity: true }).eq("id", B.id);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 101));
check("show_activity=true: like segue igual", r.res.status === 200);
await B.client.from("profiles").update({ show_activity: false }).eq("id", B.id);
await B.client.from("profiles").update({ discoverable: true }).eq("id", B.id);
r = await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 101));
check("discoverable irrelevante p/ like", r.res.status === 200);
// show_ratings=false: novo like bloqueado + summary oculto, rows ficam.
await B.client.from("profiles").update({ show_ratings: false }).eq("id", B.id);
r = await apiJson("POST", "/api/ratings/likes", C.cookie, target(userB, 101));
checkd("show_ratings=false: novo like → 404",
  r.res.status === 404, `status=${r.res.status}`);
{
  const s = await batch(A.cookie, [target(userB, 101)]);
  check("show_ratings=false: batch 0 rows", (s.data ?? []).length === 0);
}
// unlike hidden funciona (não prende o usuário).
r = await apiJson("DELETE", "/api/ratings/likes", A.cookie, target(userB, 101));
checkd("unlike com alvo escondido: removed",
  r.res.status === 200 && r.json?.liked === false,
  `status=${r.res.status} body=${r.text.slice(0, 120)}`);
await B.client.from("profiles").update({ show_ratings: true }).eq("id", B.id);
{
  const s = await batch(A.cookie, [target(userB, 101)]);
  checkd("republicado: count 1 (só C), A não mais liker",
    s.data?.[0]?.like_count === 1 && s.data?.[0]?.liked_by_viewer === false,
    `data=${JSON.stringify(s.data)}`);
}
// A curte de novo (volta a 2) + unlike idempotente.
await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 101));
r = await apiJson("DELETE", "/api/ratings/likes", A.cookie, target(userB, 101));
checkd("unlike: liked false", r.res.status === 200 && r.json?.liked === false, `body=${r.text.slice(0, 120)}`);
r = await apiJson("DELETE", "/api/ratings/likes", A.cookie, target(userB, 101));
check("unlike repetido idempotente (count não negativo)",
  r.res.status === 200 && r.json?.liked === false && r.json?.likeCount === 1);
await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB, 101));

// ------------------------------------------------- I. unpublish preserva + republica restaura
await B.client.from("profiles").update({ profile_public: false }).eq("id", B.id);
r = await apiJson("POST", "/api/ratings/likes", C.cookie, target(userB, 101));
check("perfil privado: novo like → 404", r.res.status === 404);
{
  const s = await batch(A.cookie, [target(userB, 101)]);
  check("perfil privado: batch 0 rows", (s.data ?? []).length === 0);
}
const rowsHidden = await B.client.from("rating_likes").select("liker_id").limit(10);
check("rows de like intactas p/ estranhos (sem SELECT)", (rowsHidden.data ?? []).length === 0);
await B.client.from("profiles").update({ profile_public: true }).eq("id", B.id);
{
  const s = await batch(A.cookie, [target(userB, 101)]);
  checkd("republicado: count 2 de volta",
    s.data?.[0]?.like_count === 2 && s.data?.[0]?.liked_by_viewer === true,
    `data=${JSON.stringify(s.data)}`);
}

// ------------------------------------------------- J. username change preserva
const userB2 = `${userB}x`;
await B.client.from("profiles").update({ username: userB2 }).eq("id", B.id);
{
  const sNew = await batch(A.cookie, [target(userB2, 101)]);
  const sOld = await batch(A.cookie, [target(userB, 101)]);
  checkd("username novo: liked true count preservado; antigo não resolve",
    sNew.data?.[0]?.liked_by_viewer === true && sNew.data?.[0]?.like_count === 2
    && (sOld.data ?? []).length === 0,
    `new=${JSON.stringify(sNew.data)} old=${JSON.stringify(sOld.data)}`);
}

// ------------------------------------------------- K. feed carrega likes (sem N+1, sem reorder)
// B distribui no feed p/ este bloco (flags + 1 fav + 1 rec).
await B.client.from("profiles").update({
  show_activity: true, show_favorites: true, show_recommendations: true,
}).eq("id", B.id);
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 103, media_type: "movie", kind: "favorite",
  title: "Fav Feed", poster_path: "/p.jpg", release_year: 2020, note: null,
});
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 104, media_type: "tv", kind: "recommendation",
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
  const ev101 = (f1.json?.items ?? []).find((i) => i.title?.tmdbId === 101);
  const favEv = (f1.json?.items ?? []).find((i) => i.type === "favorite");
  const orderOf = (f) => (f.json?.items ?? []).map((i) => i.eventKey).join(",");
  const atOf = (f) => (f.json?.items ?? []).map((i) => i.activityAt).join(",");
  checkd("feed rating tem likeCount/likedByViewer; fav/rec sem like",
    ev101?.likeCount === 2 && ev101?.likedByViewer === true
    && favEv !== undefined && !("likeCount" in favEv),
    `ev101=${JSON.stringify(ev101)} favKeys=${favEv ? Object.keys(favEv).join(",") : "ausente"}`);
  // 102 (só-estrelas) está curtida por A (seção H): unlike → 0, like → 1,
  // ordem e activityAt intactos nas 3 leituras.
  await apiJson("DELETE", "/api/ratings/likes", A.cookie, target(userB2, 102));
  const f2 = await feed(A.cookie);
  const ev0 = (f2.json?.items ?? []).find((i) => i.title?.tmdbId === 102);
  await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB2, 102));
  const f3 = await feed(A.cookie);
  const ev1 = (f3.json?.items ?? []).find((i) => i.title?.tmdbId === 102);
  checkd("like/unlike NÃO reordena feed nem muda activityAt (0→1)",
    orderOf(f1) === orderOf(f2) && orderOf(f2) === orderOf(f3)
    && atOf(f1) === atOf(f2) && atOf(f2) === atOf(f3)
    && ev0?.likeCount === 0 && ev1?.likeCount === 1 && ev1?.likedByViewer === true,
    `counts=${ev0?.likeCount}/${ev1?.likeCount}`);
}

// ------------------------------------------------- L. perfil público + cascatas
let p = await getPage(`/u/${userB2}?tab=avaliacoes`, A.cookie);
checkd("/u avaliacoes p/ A: botão + count + aria-pressed",
  p.res.status === 200 && /data-rating-like/.test(p.html) && /aria-pressed="true"/.test(p.html),
  `status=${p.res.status}`);
p = await getPage(`/u/${userB2}?tab=avaliacoes`, null);
checkd("/u avaliacoes anon: count visível, sem UUID",
  p.res.status === 200 && /data-rating-like/.test(p.html) && !/liker_id/.test(p.html),
  `status=${p.res.status}`);
p = await getPage(`/u/${userB2}?tab=avaliacoes`, B.cookie);
checkd("dono: controle estático (nenhum <button> de like)",
  p.res.status === 200 && /data-rating-like-static/.test(p.html)
  && !/<button[^>]*data-rating-like/.test(p.html),
  `status=${p.res.status}`);
check("HTML sem UUID/email", !new RegExp(B.id).test(p.html) && !/@example\.com/.test(p.html));
// Delete rating → likes cascade (some do batch).
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 102);
{
  const s = await batch(A.cookie, [target(userB2, 102)]);
  check("delete rating: batch 0 rows (cascade)", (s.data ?? []).length === 0);
}
// Cadeia watched→rating→likes: rating 105 com 2 likes, unwatch, tudo some.
await seedWatched(B, 105, "movie", "Cascata");
await seedRating(B, 105, "movie", 5, "Vai sumir.");
await apiJson("POST", "/api/ratings/likes", A.cookie, target(userB2, 105));
await apiJson("POST", "/api/ratings/likes", C.cookie, target(userB2, 105));
await B.client.from("watched_titles").delete().eq("user_id", B.id).eq("tmdb_id", 105);
{
  const own = await B.client.from("ratings").select("tmdb_id").eq("user_id", B.id).eq("tmdb_id", 105);
  const s = await batch(A.cookie, [target(userB2, 105)]);
  checkd("unwatch: rating some + likes cascade",
    (own.data ?? []).length === 0 && (s.data ?? []).length === 0,
    `rating=${JSON.stringify(own.data)} batch=${JSON.stringify(s.data)}`);
}
// Review removida mantém likes (like é da rating, não do texto).
await B.client.from("ratings").update({ review_text: null }).eq("user_id", B.id).eq("tmdb_id", 101);
{
  const s = await batch(A.cookie, [target(userB2, 101)]);
  checkd("review null: likes permanecem (count 2)",
    s.data?.[0]?.like_count === 2,
    `data=${JSON.stringify(s.data)}`);
}
await B.client.from("ratings").update({ rating: 4, review_text: "Editada." }).eq("user_id", B.id).eq("tmdb_id", 101);
{
  const s = await batch(A.cookie, [target(userB2, 101)]);
  check("rating 4→editada: count permanece", s.data?.[0]?.like_count === 2);
}

// ------------------------------------------------- M. limpeza (sem service_role)
for (const u of [A, B, C, D]) {
  await u.client.from("rating_likes").delete().eq("liker_id", u.id);
  await u.client.from("ratings").delete().eq("user_id", u.id);
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}
const cleanLikes = await A.client.from("rating_likes").select("liker_id").limit(5);
check("limpeza: tabela sem SELECT direto (0 rows visíveis)", (cleanLikes.data ?? []).length === 0);

// Auth users desta execução: 4 (A/B/C/D). Sem service_role no app;
// remover depois via Dashboard → Authentication → Users se necessário.
console.log("---");
console.log(failures === 0 && skipped === 0 ? "RATING-LIKES OK: curtidas + privacidade confirmadas (4 Auth users)." : `RATING-LIKES FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
