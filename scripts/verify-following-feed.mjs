/**
 * Verificação da Etapa 17: feed "Seguindo" (atividade de quem eu sigo).
 *
 * Pré-requisito: migration supabase/migrations/20261003090000_following_feed.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem da coluna/RPC entram em SKIP
 * identificado (exit 1); contratos de arquivo rodam sempre.
 *
 * Uso: npm run verify:following-feed (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration (show_activity default false, RPC SECURITY DEFINER
 *   authenticated-only, sem discoverable, sem tabela activities, sem
 *   triggers, índices, clamp 1..24, order activity_at DESC);
 * - privacidade (API allowlist showActivity, editar toggle, defaults);
 * - feed: só seguidos, gates profile_public/show_activity/flags,
 *   review null sem show_reviews, timestamps rated_at/created_at,
 *   edit não reordena, delete desaparece, unfollow/unpublish somem,
 *   discoverable=false aparece, sem watched, paginação 24/25/49 + dedupe,
 *   XSS literal na RPC e escapado no HTML/aria, API 401/400, sem UUID;
 * - Home continua prerendered (fetch client-side) e /seguindo (redirect,
 *   SSR, Carregar mais).
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e APENAS 4
 * Auth users (A/B/C/D). Paginação usa 1 usuário com N títulos via RLS
 * (sem TMDB, sem 25 signups). Nenhum segredo é impresso.
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

const MIGRATION_FILE = "supabase/migrations/20261003090000_following_feed.sql";

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
 * Código sem comentários (os asserts de ausência testam o código, não a
 * prosa dos comentários — evita falsos FAILs quando um comentário cita o
 * termo proibido para documentar a proibição).
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*--.*$/gm, "");
}

/**
 * true se o valor (objeto/array aninhado) contém alguma chave com o prefixo.
 * Null-safe: null/primitivas → false (nunca lança TypeError como `in`
 * sobre string/null faria).
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
check("migration Etapa 17 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
const migrationCode = codeOnly(migration);
check("migration show_activity (NOT NULL DEFAULT false, opt-in)",
  /add column if not exists show_activity boolean not null default false/i.test(migration));
check("migration RPC get_following_feed SECURITY DEFINER (viewer auth.uid)",
  /function public\.get_following_feed/i.test(migration)
  && /security definer/i.test(migration)
  && /follower_id = auth\.uid\(\)/i.test(migration)
  && /set search_path = public/i.test(migration)
  && !/execute\s+format|execute\s+['"]select/i.test(migration));
check("migration gates: public + activity + flags, review CASE, sem discoverable",
  /profile_public is true[\s\S]{0,200}show_activity is true/i.test(migrationCode)
  && /show_ratings is true/i.test(migration)
  && /show_favorites is true/i.test(migration)
  && /show_recommendations is true/i.test(migration)
  && /when a\.show_reviews is true then r\.review_text/i.test(migration)
  && !/discoverable/i.test(migrationCode));
check("migration sem tabela activities nem triggers de evento",
  !/create table[^;]*activit/i.test(migrationCode)
  && !/feed_events|notifications/i.test(migrationCode)
  && !/create trigger/i.test(migrationCode));
check("migration timestamps rated_at/created_at + order + clamp 24",
  /r\.rated_at as activity_at/i.test(migration)
  && /pk\.created_at as activity_at/i.test(migration)
  && !/updated_at/i.test(migrationCode)
  && /order by activity_at desc/i.test(migration)
  && /least\(greatest\(coalesce\(p_limit, 24\), 1\), 24\)/i.test(migration));
check("migration índices sem duplicar (rated_at / kind+created_at)",
  /ratings_user_rated_idx[\s\S]{0,120}\(user_id, rated_at desc\)/i.test(migration)
  && /profile_picks_user_kind_created_idx[\s\S]{0,120}\(user_id, kind, created_at desc\)/i.test(migration));
check("migration grant só authenticated (anon sem feed)",
  /grant execute on function public\.get_following_feed\(integer, integer\) to authenticated/i.test(migration)
  && /revoke all on function public\.get_following_feed/i.test(migration)
  && !/to anon/i.test(migration));
check("migration saída sem UUID/email/flags",
  /returns table \([^)]*event_type text[^)]*\)/i.test(migration)
  && !/returns table \([^)]*(user_id|follower_id|following_id|email|profile_public|show_)/i.test(migrationCode));

const feedTypes = codeOnly(readFile("../src/lib/feed/types.ts"));
check("lib feed types (3 tipos, sem strings espalhadas, sem UUID)",
  /FeedEventType/.test(feedTypes)
  && /"rating" \| "favorite" \| "recommendation"/.test(feedTypes)
  && /eventKey/.test(feedTypes) && !/user_id|userId/.test(feedTypes));
const feedService = codeOnly(readFile("../src/lib/feed/service.ts"));
check("lib feed service (RPC única, sessão, sem N+1, sem TMDB/IA)",
  /get_following_feed/.test(feedService)
  && /getFollowingFeedPage/.test(feedService)
  && /getFeedSession/.test(feedService)
  && !/user_id|userId/.test(feedService)
  && !/tasteProfile|groq|gemini/i.test(feedService));
const feedApi = codeOnly(readFile("../src/pages/api/feed/following.ts"));
check("API feed GET (401/400, page+limit, sem userId)",
  /export const GET/.test(feedApi) && /status: 401/.test(feedApi)
  && /status: 400/.test(feedApi) && !/user_id|userId/.test(feedApi));
const feedCard = codeOnly(readFile("../src/components/feed/FeedActivityCard.astro"));
check("FeedActivityCard (3 tipos, texto escapado, aria segura, time)",
  /avaliou/.test(feedCard) && /recomenda/.test(feedCard) && /aos favoritos/.test(feedCard)
  &&   /<time datetime/.test(feedCard) && /aspect-\[2\/3\]/.test(feedCard)
  && !/innerHTML|:set:html/.test(feedCard)
  && /accessibleName/.test(feedCard));
const homePage = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered + seção social client-side (oculta, 401 some)",
  /export const prerender = true/.test(homePage)
  && !/getCurrentUser/.test(homePage)
  && /data-feed-home/.test(homePage) && /hidden/.test(homePage)
  && /\/api\/feed\/following\?limit=6/.test(homePage)
  && /De quem você segue/.test(homePage) && /\/seguindo/.test(homePage)
  && /\/buscar\?tab=pessoas/.test(homePage)
  && !/innerHTML/.test(homePage));
const seguindoPage = codeOnly(readFile("../src/pages/seguindo.astro"));
check("página /seguindo (login next, SSR, Carregar mais + dedupe)",
  /\/entrar\?next=%2Fseguindo/.test(seguindoPage)
  && /getFollowingFeedPage/.test(seguindoPage)
  && /data-feed-more/.test(seguindoPage) && /eventKey/.test(seguindoPage)
  && /\/buscar\?tab=pessoas/.test(seguindoPage)
  && !/innerHTML|:set:html/.test(seguindoPage)
  && !/FloatingDock/.test(seguindoPage));
const feedClient = codeOnly(readFile("../public/scripts/feed-cards.js"));
check("renderer client compartilhado (textContent, sem duplicar)",
  /CineVeeFeedCards/.test(feedClient) && /textContent/.test(feedClient)
  && !/innerHTML/.test(feedClient));
const privacyTypes = readFile("../src/lib/profile/types.ts");
check("privacidade inclui showActivity (default false)",
  /showActivity: boolean/.test(privacyTypes) && /showActivity: false/.test(privacyTypes));
const privacyValidation = readFile("../src/lib/profile/validation.ts");
check("privacy validation allowlist showActivity (ausente→false, tipo errado→400)",
  /showActivity[\s\S]{0,160}validatePrivacyFlag\(payload\.showActivity/.test(privacyValidation)
  && /payload\.showActivity === undefined/.test(privacyValidation));
const editarPage = readFile("../src/pages/perfil/editar.astro");
check("/perfil/editar toggle atividades (copy + explicação)",
  /privacy-activity/.test(editarPage)
  && /Mostrar minhas atividades para quem me segue/.test(editarPage)
  && /podem\s*\n?\s*aparecer no feed de quem segue você/.test(editarPage));

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

async function api(method, path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    method,
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
  const email = `feed-${tag}-${stamp}@example.com`;
  const password = `FeedVerificacao123!${tag}`;
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

// Só 4 Auth users (A viewer, B atividade, C não-seguido, D privado).
// Paginação usa N títulos de UM usuário via RLS (sem TMDB, sem signups).
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
const userA = `feeda${short}`;
const userB = `feedb${short}`;
const userC = `feedc${short}`;
const userD = `feedd${short}`;

// ------------------------------------------------- C. probe migration
let rpcMissing = false;
{
  const probe = await A.client.rpc("get_following_feed", { p_limit: 1, p_offset: 0 });
  rpcMissing = probe.error !== null && /function|does not exist|PGRST|column|show_activity/i.test(
    `${probe.error.message ?? ""} ${probe.error.code ?? ""}`,
  );
}
if (rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: gates, eventos, ordem, paginação, XSS, API, Home, /seguindo");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("RPC get_following_feed acessível", true);

// ------------------------------------------------- D. seed identidades
async function setupProfile(u, { username, displayName, flags }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio: null, ...flags,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
const ALL_OFF = {
  profile_public: false, show_activity: false, show_favorites: false,
  show_recommendations: false, show_watched: false, show_ratings: false,
  show_reviews: false, discoverable: false,
};
// A: viewer público (flags próprias irrelevantes p/ o feed dele).
await setupProfile(A, { username: userA, displayName: `Viewer ${short}`, flags: { ...ALL_OFF, profile_public: true } });
// B: público + activity total (reviews começa OFF p/ testar null).
await setupProfile(B, {
  username: userB, displayName: `Ator ${short}`,
  flags: {
    profile_public: true, show_activity: true, show_favorites: true,
    show_recommendations: true, show_watched: false, show_ratings: true,
    show_reviews: false, discoverable: false, // discoverable=false DEVE aparecer
  },
});
// C: público + activity, mas A NÃO segue C.
await setupProfile(C, {
  username: userC, displayName: `Extra ${short}`,
  flags: {
    profile_public: true, show_activity: true, show_favorites: true,
    show_recommendations: false, show_watched: false, show_ratings: false,
    show_reviews: false, discoverable: true,
  },
});
// D: privado + activity (nunca distribui).
await setupProfile(D, {
  username: userD, displayName: `Privado ${short}`,
  flags: { ...ALL_OFF, profile_public: false, show_activity: true, show_ratings: true },
});

// ------------------------------------------------- E. seed conteúdo de B (via RLS própria)
const T1 = "2026-01-10T10:00:00.000Z"; // recommendation (mais antigo)
const T2 = "2026-02-10T10:00:00.000Z"; // favorite
const T3 = "2026-03-10T10:00:00.000Z"; // rating (mais recente)
async function seedWatched(u, tmdbId, mediaType, title, year) {
  const { error } = await u.client.from("watched_titles").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: mediaType, title,
    poster_path: "/poster.jpg", release_year: year,
  });
  if (error) throw new Error(`watched ${tmdbId} falhou: ${error.message}`);
}
async function seedRating(u, tmdbId, mediaType, rating, reviewText, ratedAt) {
  const { error } = await u.client.from("ratings").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: mediaType, rating,
    review_text: reviewText, rated_at: ratedAt,
  });
  if (error) throw new Error(`rating ${tmdbId} falhou: ${error.message}`);
}
async function seedPick(u, tmdbId, mediaType, kind, title, note, createdAt) {
  const { error } = await u.client.from("profile_picks").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: mediaType, kind, title,
    poster_path: "/poster.jpg", release_year: 2020, note, created_at: createdAt,
  });
  if (error) throw new Error(`pick ${tmdbId}/${kind} falhou: ${error.message}`);
}
// B: 1 rating (r5 + review) + 1 favorite + 1 recommendation.
await seedWatched(B, 101, "movie", "Filme Base", 2021);
await seedRating(B, 101, "movie", 5, "Obra-prima absoluta.", T3);
await seedPick(B, 102, "movie", "favorite", "Favorito Base", null, T2);
await seedPick(B, 103, "tv", "recommendation", "Série Base", "Assistam sem spoilers.", T1);
// C: atividade pública que NÃO deve vazar p/ A.
await seedPick(C, 201, "movie", "favorite", "Favorito Extra", null, T3);
// D: rating privado (com follow histórico A→D direto na tabela).
await seedWatched(D, 301, "movie", "Filme Privado", 2022);
await seedRating(D, 301, "movie", 5, "Ninguém deve ver.", T3);

// A segue B (via API). A→D direto na tabela (RLS permite; privado some do feed).
async function followViaApi(cookie, username) {
  const res = await fetch(`${BASE}/api/follows`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  return res;
}
{
  const fr = await followViaApi(A.cookie, userB);
  checkd("A segue B (setup)", fr.status === 200, `status=${fr.status}`);
}
await A.client.from("follows").insert({ follower_id: A.id, following_id: D.id });

async function feed(cookie, page = 1, limit = null) {
  const q = `page=${page}${limit === null ? "" : `&limit=${limit}`}`;
  return api("GET", `/api/feed/following?${q}`, cookie);
}
let r;
const keys = (items) => (items ?? []).map((i) => i.eventKey);

// ------------------------------------------------- F. API auth + base
r = await api("GET", "/api/feed/following?page=1", null);
check("feed deslogado → 401", r.res.status === 401);
r = await api("GET", "/api/feed/following?page=0", A.cookie);
check("feed page inválida → 400", r.res.status === 400);
r = await api("GET", "/api/feed/following?page=1&limit=25", A.cookie);
check("feed limit>24 → 400", r.res.status === 400);
r = await feed(A.cookie);
checkd("feed A: 3 eventos B em ordem (rating, favorite, recommendation)",
  r.res.status === 200
  && (r.json?.items ?? []).map((i) => i.type).join(",") === "rating,favorite,recommendation",
  `status=${r.res.status} types=${JSON.stringify((r.json?.items ?? []).map((i) => i.type))}`);
const baseItems = r.json?.items ?? [];
checkd("feed rating: 5 estrelas + review null (show_reviews=false) + snapshot",
  baseItems[0]?.rating === 5 && baseItems[0]?.text === null
  && baseItems[0]?.title?.title === "Filme Base"
  && baseItems[0]?.actor?.username === userB
  && typeof baseItems[0]?.activityAt === "string",
  `item=${JSON.stringify(baseItems[0])}`);
checkd("feed recommendation: note presente, sem rating",
  baseItems[2]?.text === "Assistam sem spoilers." && baseItems[2]?.rating === undefined,
  `item=${JSON.stringify(baseItems[2])}`);
checkd("feed sem UUID/email/flags + eventKey opaca",
  baseItems.every((i) =>
    i !== null && typeof i === "object"
    && typeof i.eventKey === "string" && !("user_id" in i) && !("id" in i)
    && !("email" in i) && !("follower_id" in i) && !("following_id" in i)
    && !("profile_public" in i) && !containsKeyStartingWith(i, "discoverable")
    && !containsKeyStartingWith(i, "show_")),
  `item=${JSON.stringify(baseItems[0])}`);
checkd("C (não seguido) e D (privado c/ follow) fora do feed",
  !(r.json?.items ?? []).some((i) => i.actor?.username === userC || i.actor?.username === userD),
  `actors=${JSON.stringify((r.json?.items ?? []).map((i) => i.actor?.username))}`);
check("feed ignora ?userId (sempre o próprio)",
  (await api("GET", `/api/feed/following?page=1&userId=${B.id}`, A.cookie)).json?.items?.length === 3);

// ------------------------------------------------- G. flags independentes
await B.client.from("profiles").update({ show_reviews: true }).eq("id", B.id);
r = await feed(A.cookie);
checkd("show_reviews=true: review aparece",
  r.json?.items?.[0]?.text === "Obra-prima absoluta.",
  `text=${JSON.stringify(r.json?.items?.[0]?.text)}`);
await B.client.from("profiles").update({ show_ratings: false }).eq("id", B.id);
r = await feed(A.cookie);
checkd("show_ratings=false: rating some (fav/rec ficam)",
  (r.json?.items ?? []).map((i) => i.type).join(",") === "favorite,recommendation",
  `types=${JSON.stringify((r.json?.items ?? []).map((i) => i.type))}`);
await B.client.from("profiles").update({ show_ratings: true, show_reviews: false }).eq("id", B.id);
await B.client.from("profiles").update({ show_favorites: false }).eq("id", B.id);
r = await feed(A.cookie);
check("show_favorites=false: favorite some", (r.json?.items ?? []).map((i) => i.type).join(",") === "rating,recommendation");
await B.client.from("profiles").update({ show_favorites: true, show_recommendations: false }).eq("id", B.id);
r = await feed(A.cookie);
check("show_recommendations=false: recommendation some", (r.json?.items ?? []).map((i) => i.type).join(",") === "rating,favorite");
await B.client.from("profiles").update({ show_recommendations: true }).eq("id", B.id);

// ------------------------------------------------- H. activity / publish / unfollow / watched
await B.client.from("profiles").update({ show_activity: false }).eq("id", B.id);
r = await feed(A.cookie);
check("show_activity=false: zero eventos B", (r.json?.items ?? []).length === 0);
await B.client.from("profiles").update({ show_activity: true }).eq("id", B.id);
r = await feed(A.cookie);
check("show_activity=true: eventos voltam (3)", (r.json?.items ?? []).length === 3);
await B.client.from("profiles").update({ profile_public: false }).eq("id", B.id);
r = await feed(A.cookie);
check("B privado: feed some", (r.json?.items ?? []).length === 0);
await B.client.from("profiles").update({ profile_public: true }).eq("id", B.id);
r = await feed(A.cookie);
check("B republicado: eventos voltam (3)", (r.json?.items ?? []).length === 3);
// watched sem rating nunca vira evento (mesmo com show_watched=true).
await B.client.from("profiles").update({ show_watched: true }).eq("id", B.id);
await seedWatched(B, 104, "movie", "Só Assistido", 2023);
r = await feed(A.cookie);
check("watched-only não cria evento", (r.json?.items ?? []).length === 3);
await B.client.from("profiles").update({ show_watched: false }).eq("id", B.id);
// unfollow: some na próxima request.
{
  const res = await fetch(`${BASE}/api/follows`, {
    method: "DELETE", redirect: "manual",
    headers: { Cookie: A.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ username: userB }),
  });
  checkd("A deixa B (setup unfollow)", res.status === 200, `status=${res.status}`);
}
r = await feed(A.cookie);
check("unfollow: zero eventos B", (r.json?.items ?? []).length === 0);
{
  const fr = await followViaApi(A.cookie, userB);
  checkd("A segue B de novo", fr.status === 200, `status=${fr.status}`);
}

// ------------------------------------------------- I. edit não reordena + delete some
const before = (await feed(A.cookie)).json?.items ?? [];
const beforeKeys = keys(before).join(",");
const beforeAt = before.map((i) => i.activityAt).join(",");
await B.client.from("ratings").update({ rating: 4, review_text: "Bom, revisto." })
  .eq("user_id", B.id).eq("tmdb_id", 101);
await B.client.from("profile_picks").update({ note: "Nota reescrita." })
  .eq("user_id", B.id).eq("tmdb_id", 103);
r = await feed(A.cookie);
checkd("edit mostra conteúdo novo sem reordenar (mesma activity_at)",
  keys(r.json?.items ?? []).join(",") === beforeKeys
  && (r.json?.items ?? []).map((i) => i.activityAt).join(",") === beforeAt
  && r.json?.items?.[0]?.rating === 4,
  `keys=${JSON.stringify(keys(r.json?.items ?? []))}`);
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 101);
r = await feed(A.cookie);
check("delete rating: evento some", !(r.json?.items ?? []).some((i) => i.type === "rating"));
// Re-seed do rating (o watched 101 continua no banco — só o rating saiu).
await seedRating(B, 101, "movie", 5, "Obra-prima absoluta.", T3);
await B.client.from("profile_picks").delete().eq("user_id", B.id).eq("tmdb_id", 102);
r = await feed(A.cookie);
check("delete favorite: evento some", !(r.json?.items ?? []).some((i) => i.type === "favorite"));
await seedPick(B, 102, "movie", "favorite", "Favorito Base", null, T2);

// ------------------------------------------------- J. XSS (RPC literal, HTML/aria escapados)
await setupProfile(B, {
  username: userB, displayName: "<script>alert(1)</script>",
  flags: {
    profile_public: true, show_activity: true, show_favorites: true,
    show_recommendations: true, show_watched: false, show_ratings: true,
    show_reviews: true, discoverable: false,
  },
});
await B.client.from("ratings").update({ review_text: "<script>alert(1)</script>" })
  .eq("user_id", B.id).eq("tmdb_id", 101);
await B.client.from("profile_picks").update({ note: "<img src=x onerror=alert(1)>" })
  .eq("user_id", B.id).eq("tmdb_id", 103);
r = await feed(A.cookie);
check("RPC XSS literal (review/note/displayName crus)",
  (r.json?.items ?? []).some((i) => i.text === "<script>alert(1)</script>")
  && (r.json?.items ?? []).some((i) => i.text === "<img src=x onerror=alert(1)>")
  && (r.json?.items ?? []).some((i) => i.actor?.displayName === "<script>alert(1)</script>"));
let p = await getPage("/seguindo", A.cookie);
checkd("UI /seguindo escapa XSS (texto, sem tag executável, aria segura)",
  /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(p.html)
  && /&lt;img src=x onerror=alert\(1\)&gt;/.test(p.html)
  && !/<script>alert\(1\)<\/script>/.test(p.html)
  && !/<img src=x onerror=alert\(1\)>/.test(p.html),
  `status=${p.res.status}`);
// Restaura identidade/conteúdo.
await setupProfile(B, {
  username: userB, displayName: `Ator ${short}`,
  flags: {
    profile_public: true, show_activity: true, show_favorites: true,
    show_recommendations: true, show_watched: false, show_ratings: true,
    show_reviews: false, discoverable: false,
  },
});
await B.client.from("ratings").update({ review_text: "Obra-prima absoluta." })
  .eq("user_id", B.id).eq("tmdb_id", 101);
await B.client.from("profile_picks").update({ note: "Assistam sem spoilers." })
  .eq("user_id", B.id).eq("tmdb_id", 103);

// ------------------------------------------------- K. paginação 49/25/24 (1 usuário, N títulos, sem TMDB)
async function seedBulk(n, startId) {
  for (let i = 0; i < n; i += 1) {
    const id = startId + i;
    const day = String(i + 1).padStart(2, "0");
    const at = `2026-04-${day}T10:00:00.000Z`;
    await seedWatched(B, id, "movie", `Bulk ${id}`, 2020);
    await seedRating(B, id, "movie", (i % 5) + 1, null, at);
  }
}
await seedBulk(25, 1000); // 25 ratings 2026-04-01..25
for (let i = 0; i < 12; i += 1) {
  await seedPick(B, 2000 + i, "movie", "favorite", `BulkFav ${i}`, null, `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`);
}
for (let i = 0; i < 12; i += 1) {
  await seedPick(B, 3000 + i, "tv", "recommendation", `BulkRec ${i}`, `Nota bulk ${i}.`, `2026-05-${String(i + 13).padStart(2, "0")}T10:00:00.000Z`);
}
// Total agora: 3 base + 25 ratings + 12 favs + 12 recs = 52.
// Remove os 3 ratings mais antigos do bulk → 49 exatos.
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 1000);
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 1001);
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 1002);
async function feedAll() {
  const out = [];
  for (let page = 1; page <= 3; page += 1) {
    const rr = await feed(A.cookie, page);
    out.push(rr);
  }
  return out;
}
{
  const [p1, p2, p3] = await feedAll();
  const all = [...(p1.json?.items ?? []), ...(p2.json?.items ?? []), ...(p3.json?.items ?? [])];
  checkd("49 eventos: 24+true, 24+true, 1+false, 49 únicos",
    p1.json?.items?.length === 24 && p1.json?.hasMore === true
    && p2.json?.items?.length === 24 && p2.json?.hasMore === true
    && p3.json?.items?.length === 1 && p3.json?.hasMore === false
    && new Set(all.map((i) => i.eventKey)).size === 49,
    `n=${p1.json?.items?.length}/${p2.json?.items?.length}/${p3.json?.items?.length} únicos=${new Set(all.map((i) => i.eventKey)).size}`);
}
// 25: remove 24 (12 favs + 12 recs).
for (let i = 0; i < 12; i += 1) {
  await B.client.from("profile_picks").delete().eq("user_id", B.id).eq("tmdb_id", 2000 + i);
  await B.client.from("profile_picks").delete().eq("user_id", B.id).eq("tmdb_id", 3000 + i);
}
{
  const q1 = await feed(A.cookie, 1);
  const q2 = await feed(A.cookie, 2);
  checkd("25 eventos: 24+true, 1+false",
    q1.json?.items?.length === 24 && q1.json?.hasMore === true
    && q2.json?.items?.length === 1 && q2.json?.hasMore === false,
    `n=${q1.json?.items?.length}/${q2.json?.items?.length}`);
}
// 24: remove 1 rating.
await B.client.from("ratings").delete().eq("user_id", B.id).eq("tmdb_id", 1003);
{
  const q1 = await feed(A.cookie, 1);
  checkd("24 eventos: 24+false",
    q1.json?.items?.length === 24 && q1.json?.hasMore === false,
    `n=${q1.json?.items?.length} hasMore=${q1.json?.hasMore}`);
}

// ------------------------------------------------- L. Home + /seguindo contracts
p = await getPage("/seguindo", null);
check("/seguindo deslogado → login next",
  (p.res.status === 302 || p.res.status === 303) && /\/entrar/.test(p.res.headers.get("location") ?? ""));
p = await getPage("/seguindo", A.cookie);
checkd("/seguindo logado: 200 + cards + (Carregar mais ou fim)",
  p.res.status === 200 && /data-feed-card data-key/.test(p.html)
  && (/data-feed-more/.test(p.html) || /Você chegou ao fim/.test(p.html)),
  `status=${p.res.status}`);
check("HTML feed sem UUID/email",
  !new RegExp(B.id).test(p.html) && !/@example\.com/.test(p.html));
p = await getPage("/", null);
checkd("Home: 200 + seção social oculta (prerender preservado)",
  p.res.status === 200 && /data-feed-home/.test(p.html) && /De quem você segue/.test(p.html),
  `status=${p.res.status}`);

// ------------------------------------------------- M. limpeza (sem service_role)
for (const u of [A, B, C, D]) {
  await u.client.from("ratings").delete().eq("user_id", u.id);
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}
const cleanCheck = await A.client.from("follows").select("follower_id").eq("follower_id", A.id);
check("limpeza: follows removidos", (cleanCheck.data ?? []).length === 0);

// Auth users desta execução: 4 (A/B/C/D). Sem service_role no app;
// remover depois via Dashboard → Authentication → Users se necessário.
console.log("---");
console.log(failures === 0 && skipped === 0 ? "FOLLOWING-FEED OK: feed + privacidade confirmados (4 Auth users)." : `FOLLOWING-FEED FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
