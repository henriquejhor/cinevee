/**
 * Verificação da Etapa 14: perfis públicos + privacidade (/u/[username]).
 *
 * Pré-requisito: migration supabase/migrations/20260929090000_public_profiles.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem das flags/RPCs entram em SKIP
 * identificado (exit 1); contratos de arquivo rodam sempre.
 *
 * Uso: npm run verify:public-profiles (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration (flags defaults false, 5 RPCs SECURITY DEFINER allowlisted,
 *   grants anon/authenticated, nenhuma policy pública nas tabelas base);
 * - defaults privados em signup novo;
 * - privacy API (401, validação, username obrigatório, showReviews→false);
 * - anon direto nas 4 tabelas continua bloqueado (mesmo com perfil público);
 * - RPCs: perfil privado/inexistente equivalentes (0 rows), allowlist sem
 *   user_id/email/preferências, flags por seção, review só com showReviews,
 *   showRatings=false esconde tudo, paginação >24 sem duplicatas, XSS literal;
 * - A/B isolation por username; watchlist nunca pública;
 * - HTTP: /u/* 404 privado/inexistente, tabs por flag, SEO, share, sem UUID;
 * - APIs públicas paginadas (401? não — anônimas; 404 inválidas).
 *
 * Usa SOMENTE a chave publishable (nada de service_role).
 * Nenhum segredo é impresso: só PASS/FAIL/SKIP por asserção.
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

const MIGRATION_FILE = "supabase/migrations/20260929090000_public_profiles.sql";

let failures = 0;
let skipped = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
/** check com diagnóstico resumido (endpoint/caso + expected + actual). */
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

// ------------------------------------------------- A. arquivos/migration
check("migration Etapa 14 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
for (const col of ["profile_public", "show_favorites", "show_recommendations", "show_watched", "show_ratings", "show_reviews"]) {
  if (!new RegExp(`add column if not exists ${col} boolean not null default false`, "i").test(migration)) {
    check(`migration flag ${col} default false`, false);
  }
}
check("migration 6 flags default false", true);
check("migration 5 RPCs SECURITY DEFINER", [
  "get_public_profile", "get_public_favorites", "get_public_recommendations",
  "get_public_watched", "get_public_ratings",
].every((fn) => new RegExp(`function public\\.${fn}`, "i").test(migration))
  && (migration.match(/security definer/gi) || []).length >= 5);
check("migration search_path fixo + sem SQL dinâmica",
  (migration.match(/set search_path = public/gi) || []).length >= 5
  && !/execute\s+format|execute\s+['"]select/i.test(migration));
check("migration grants anon+authenticated nas RPCs",
  /grant execute on function public\.get_public_profile\(text\) to anon, authenticated/i.test(migration)
  && /grant execute on function public\.get_public_ratings\(text, integer, integer\) to anon, authenticated/i.test(migration));
check("migration sem policy pública nas tabelas base",
  !/create policy[^;]*\bto\s+(anon|public)\b/i.test(migration)
  && !/create policy[^;]*using\s*\(\s*true\s*\)/i.test(migration));
check("migration sem show_watchlist", !/add column[^;]*show_watchlist/i.test(migration));
check("migration teto 24 + reviews condicionais no SQL",
  /least\(greatest\(coalesce\(p_limit, 24\), 1\), 24\)/i.test(migration)
  && /case when p\.show_reviews is true then r\.review_text else null end/i.test(migration));

const privacy = readFile("../src/lib/publicProfile/service.ts");
check("lib publicProfile só via rpc (sem .from em tabelas)",
  /\.rpc\("get_public_/g.test(privacy) && !/\.from\("(profiles|ratings|watched_titles|profile_picks|watchlist)"\)/.test(privacy));
check("lib sem getCurrentUser obrigatório", !/getCurrentUser/.test(privacy));
check("lib tipos sem user_id/email", !/\buserId\b|["']email["']|["']user_id["']\s*:/.test(privacy));

const profileTypes = readFile("../src/lib/profile/types.ts");
check("types PrivacySettings + defaults false", /profilePublic: boolean/.test(profileTypes)
  && /profilePublic: false/.test(profileTypes));

const profileValidation = readFile("../src/lib/profile/validation.ts");
check("validation privacy: allowlist + normaliza reviews",
  /validatePrivacyPayload/.test(profileValidation)
  && /showRatings \? showReviews : false/.test(profileValidation)
  && /UsernameRequiredError/.test(profileValidation));

const profileService = readFile("../src/lib/profile/service.ts");
check("service privacy: username obrigatório + fallback pré-migration",
  /UsernameRequiredError/.test(profileService) && /NO_PRIVACY_COLUMNS/.test(profileService));

const privacyApi = readFile("../src/pages/api/profile/privacy.ts");
check("API privacy GET+PATCH, 401/400", /export const GET/.test(privacyApi)
  && /export const PATCH/.test(privacyApi) && /status: 401/.test(privacyApi));

const watchedApi = readFile("../src/pages/api/public/profile/[username]/watched.ts");
const ratingsApi = readFile("../src/pages/api/public/profile/[username]/ratings.ts");
check("APIs públicas watched/ratings (sem auth, 404, teto)",
  /getPublicWatched/.test(watchedApi) && /getPublicRatings/.test(ratingsApi)
  && !/getCurrentUser/.test(watchedApi + ratingsApi)
  && /Página inválida/.test(watchedApi + ratingsApi));

const publicPage = readFile("../src/pages/u/[username].astro");
check("rota /u/[username] (404 único, tabs, share, SEO)",
  /Perfil não disponível/.test(publicPage) && /\?tab=/.test(publicPage)
  && /navigator\.share/.test(publicPage) && /Link copiado/.test(publicPage)
  && /\(\@\$\{profile\.username\}\) — CineVee/.test(publicPage));
check("página pública sem innerHTML/set:html e sem user_id",
  !/\.innerHTML|:set:html/.test(publicPage) && !/user\.id|user\.email|getCurrentUser|["']user_id["']\s*:/.test(publicPage));
check("pública sem Editar/Logout/TasteProfile",
  !/>(Editar perfil|Logout|Sair)<\//.test(publicPage)
  && !/buildPersonalization|TasteProfile\(/.test(publicPage));
check("pública sem Minha Lista/watchlist",
  !/Minha Lista|\.from\(\s*["']watchlist|watchlistCount|["']watchlist["']/.test(publicPage));

const editar = readFile("../src/pages/perfil/editar.astro");
check("editar tem seção Privacidade + toggles + link público",
  /Privacidade do perfil/.test(editar) && /privacy-public/.test(editar)
  && /\/api\/profile\/privacy/.test(editar) && /Minha Lista/.test(editar)
  && /Definir @username/.test(editar));

const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome público/picks novos", !/publicProfile|get_public_/i.test(taste));

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

async function api(method, path, cookie, body) {
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

async function getPage(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { res, html: await res.text() };
}

const stamp = Date.now();
async function signUp(tag) {
  const client = createClient(SUPABASE_URL, KEY);
  const email = `pub-${tag}-${stamp}@example.com`;
  const password = `PublicVerificacao123!${tag}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    // Causa real impressa (sem senha/token): distingue infra (rate limit,
    // confirmação de email, quota) de regressão do produto.
    const cause = error
      ? `status=${error.status} name=${error.name} message=${error.message} code=${error.code ?? "?"}`
      : "sessão nula";
    throw new Error(`signup ${email} falhou (${cause})`);
  }
  const fresh = createClient(SUPABASE_URL, KEY);
  const { data: s } = await fresh.auth.signInWithPassword({ email, password });
  return { client, id: data.user.id, email, cookie: cookieFor(s.session) };
}

// 8 contas Auth por execução (A–H consolidados). Falha aqui é setup/infra
// (ex.: rate limit após outra suíte) — reportada como tal, sem fingir
// regressão; tenta limpar linhas criadas antes de sair.
const created = [];
let A, B, C, D, E, F, G, H;
try {
  A = await signUp("a"); created.push(A);
  B = await signUp("b"); created.push(B);
  C = await signUp("c"); created.push(C);
  D = await signUp("d"); created.push(D);
  E = await signUp("e"); created.push(E);
  F = await signUp("f"); created.push(F);
  G = await signUp("g"); created.push(G);
  H = await signUp("h"); created.push(H);
} catch (error) {
  for (const u of created) {
    try {
      const c = u?.client;
      const id = u?.id;
      if (!c || !id) continue;
      await c.from("profile_picks").delete().eq("user_id", id);
      await c.from("ratings").delete().eq("user_id", id);
      await c.from("watchlist").delete().eq("user_id", id);
      await c.from("watched_titles").delete().eq("user_id", id);
    } catch {
      // melhor esforço; auth.users fica para limpeza via Dashboard
    }
  }
  console.log("---");
  console.log(`INFRA/AUTH SETUP FAILURE (não é regressão do produto): ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const short = String(stamp).slice(-9);
const userA = `pua${short}`;
const userB = `pub${short}`;
const userC = `puc${short}`;
const userE = `pue${short}`;
const userF = `puf${short}`;
const userG = `pug${short}`;
const userH = `puh${short}`;

// ------------------------------------------------- C. probe migration
const probe = await A.client.from("profiles").select("profile_public").eq("id", A.id).maybeSingle();
const migrationMissing = probe.error && /profile_public|column|schema cache|PGRST/i.test(
  `${probe.error.message ?? ""} ${probe.error.code ?? ""}`,
);
let rpcMissing = false;
if (!migrationMissing) {
  const rpcProbe = await A.client.rpc("get_public_profile", { p_username: "zzz" });
  rpcMissing = rpcProbe.error !== null && /function|does not exist|PGRST/i.test(
    `${rpcProbe.error.message ?? ""} ${rpcProbe.error.code ?? ""}`,
  );
}
if (migrationMissing || rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: defaults, privacy API, RLS anon, RPCs, paginação, XSS");
  skip("HTTP: /u/*, APIs públicas, SEO, share");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("flags de privacidade acessíveis", probe.error === null);

// ------------------------------------------------- D. defaults + privacy API
const dflt = await D.client.from("profiles").select(
  "profile_public,show_favorites,show_recommendations,show_watched,show_ratings,show_reviews",
).eq("id", D.id).maybeSingle();
check("signup novo: tudo privado por padrão",
  dflt.error === null && dflt.data !== null && Object.values(dflt.data).every((v) => v === false));

let r = await api("GET", "/api/profile/privacy", null);
check("privacy GET deslogado → 401", r.res.status === 401);
r = await api("PATCH", "/api/profile/privacy", null, { profilePublic: true });
check("privacy PATCH deslogado → 401", r.res.status === 401);
r = await api("GET", "/api/profile/privacy", D.cookie);
check("privacy GET próprio → defaults", r.res.status === 200
  && r.json?.privacy?.profilePublic === false && r.json?.privacy?.showReviews === false);
r = await api("PATCH", "/api/profile/privacy", D.cookie, {
  profilePublic: true, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: false, showReviews: false, discoverable: false,
});
checkd("publicar sem username → 400 amigável",
  r.res.status === 400 && /@username/.test(r.json?.error || ""),
  `status=${r.res.status} error=${JSON.stringify(r.json?.error)}`);
r = await api("PATCH", "/api/profile/privacy", D.cookie, { profilePublic: "yes" });
check("privacy flag não-booleana → 400", r.res.status === 400);
r = await api("PATCH", "/api/profile/privacy", D.cookie, {
  profilePublic: false, showFavorites: true, showRecommendations: true,
  showWatched: true, showRatings: false, showReviews: true, discoverable: false, hacker: true,
});
check("normaliza showReviews=false sem ratings (ignora extra)",
  r.res.status === 200 && r.json?.privacy?.showReviews === false
  && r.json?.privacy?.showFavorites === true);

// ------------------------------------------------- E. seed: identidades
async function setUsername(u, name) {
  const { error } = await u.client.from("profiles").update({ username: name }).eq("id", u.id);
  if (error) throw new Error(`username ${name} falhou: ${error.message}`);
}
await setUsername(A, userA);
await setUsername(B, userB);
await setUsername(C, userC);

function watchedRow(userId, tmdbId, mediaType, title, year) {
  return {
    user_id: userId, tmdb_id: tmdbId, media_type: mediaType, title,
    poster_path: "/p.jpg", release_year: year,
  };
}
// A: público parcial (fav+rec ON; watched/ratings OFF)
await A.client.from("profiles").update({
  profile_public: true, show_favorites: true, show_recommendations: true,
  show_watched: false, show_ratings: false, show_reviews: false,
}).eq("id", A.id);
await A.client.from("watched_titles").insert(watchedRow(A.id, 550, "movie", "Clube da Luta", 1999));
await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 550, media_type: "movie", rating: 5, review_text: "Secreta de A." });
// Watchlist de A usa título-marcador exclusivo da watchlist ("Matrix" é
// também título legítimo da recommendation de A — não pode ser marcador).
await A.client.from("watchlist").insert({ ...watchedRow(A.id, 604, "movie", "ZZZ Watchlist A", 1999) });
await A.client.from("profile_picks").insert({
  user_id: A.id, tmdb_id: 550, media_type: "movie", kind: "favorite",
  title: "Clube da Luta", poster_path: "/p.jpg", release_year: 1999, note: null, position: 0,
});
await A.client.from("profile_picks").insert({
  user_id: A.id, tmdb_id: 603, media_type: "movie", kind: "recommendation",
  title: "Matrix", poster_path: "/m.jpg", release_year: 1999, note: "Recomendo A.", position: 0,
});

// B: tudo permitido + volume p/ paginação (26 assistidos, 3 avaliados)
await B.client.from("profiles").update({
  profile_public: true, show_favorites: true, show_recommendations: true,
  show_watched: true, show_ratings: true, show_reviews: true,
}).eq("id", B.id);
for (let i = 0; i < 26; i += 1) {
  await B.client.from("watched_titles").insert(
    watchedRow(B.id, 1000 + i, "movie", `Filme B${i}`, 2000 + (i % 20)),
  );
}
for (const [tmdbId, rating, review] of [
  [1000, 5, "Excelente."],
  [1001, 4, '<script>alert(1)</script>'],
  [1002, 3, null],
]) {
  await B.client.from("ratings").insert({
    user_id: B.id, tmdb_id: tmdbId, media_type: "movie", rating, review_text: review,
  });
}
await B.client.from("watchlist").insert({ ...watchedRow(B.id, 2000, "movie", "ZZZ Watchlist Secreta", 2020) });
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 1000, media_type: "movie", kind: "favorite",
  title: "Filme B0", poster_path: "/b.jpg", release_year: 2000, note: null, position: 0,
});
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 1001, media_type: "movie", kind: "recommendation",
  title: "Filme B1", poster_path: "/b.jpg", release_year: 2001, note: "Nota B.", position: 0,
});
// C: privado (flags até ligadas, mas profile_public=false)
await C.client.from("profiles").update({
  profile_public: false, show_favorites: true, show_recommendations: true,
  show_watched: true, show_ratings: true, show_reviews: true,
}).eq("id", C.id);
await C.client.from("watched_titles").insert(watchedRow(C.id, 550, "movie", "Clube da Luta", 1999));

// E/F/G/H: públicos totais, volumes exatos p/ bordas de paginação
// (E=49, F=24, G=1, H=0 — watched e ratings com as mesmas contagens).
async function seedVolume(u, name, count, baseTmdb) {
  await setUsername(u, name);
  await u.client.from("profiles").update({
    profile_public: true, show_favorites: false, show_recommendations: false,
    show_watched: true, show_ratings: true, show_reviews: true,
  }).eq("id", u.id);
  for (let i = 0; i < count; i += 1) {
    const tmdbId = baseTmdb + i;
    await u.client.from("watched_titles").insert(
      watchedRow(u.id, tmdbId, "movie", `Vol ${name}${i}`, 2001),
    );
    await u.client.from("ratings").insert({
      user_id: u.id, tmdb_id: tmdbId, media_type: "movie",
      rating: (i % 5) + 1, review_text: i % 2 === 0 ? `Nota ${name}${i}.` : null,
    });
  }
}
await seedVolume(E, userE, 49, 3000);
await seedVolume(F, userF, 24, 4000);
await seedVolume(G, userG, 1, 5000);
await setUsername(H, userH);
await H.client.from("profiles").update({
  profile_public: true, show_favorites: false, show_recommendations: false,
  show_watched: true, show_ratings: true, show_reviews: true,
}).eq("id", H.id);

// ------------------------------------------------- F. anon direto continua bloqueado
const anon = createClient(SUPABASE_URL, KEY);
const anonProfiles = await anon.from("profiles").select("id,username").limit(5);
check("anon direto em profiles → nada", (anonProfiles.data ?? []).length === 0);
const anonPicks = await anon.from("profile_picks").select("tmdb_id").limit(5);
check("anon direto em profile_picks → nada", (anonPicks.data ?? []).length === 0);
const anonWatched = await anon.from("watched_titles").select("tmdb_id").limit(5);
check("anon direto em watched_titles → nada", (anonWatched.data ?? []).length === 0);
const anonRatings = await anon.from("ratings").select("tmdb_id").limit(5);
check("anon direto em ratings → nada", (anonRatings.data ?? []).length === 0);

// ------------------------------------------------- G. RPCs (anon): perfil
const pubA = await anon.rpc("get_public_profile", { p_username: userA });
check("RPC perfil A (parcial) sem user_id/email/prefs",
  pubA.error === null && pubA.data?.length === 1
  && pubA.data[0].username === userA && !("user_id" in pubA.data[0])
  && !("email" in pubA.data[0]) && !("excluded_genres" in pubA.data[0])
  && !("streaming_providers" in pubA.data[0]) && !("id" in pubA.data[0])
  && pubA.data[0].show_favorites === true && pubA.data[0].show_watched === false);
const pubC = await anon.rpc("get_public_profile", { p_username: userC });
check("RPC perfil privado C → 0 rows", pubC.error === null && (pubC.data ?? []).length === 0);
const pubUnknown = await anon.rpc("get_public_profile", { p_username: "zzz-nao-existe" });
check("RPC username inexistente → 0 rows (equivale a privado)",
  pubUnknown.error === null && (pubUnknown.data ?? []).length === 0);

// ------------------------------------------------- H. RPCs: seções + flags
const favA = await anon.rpc("get_public_favorites", { p_username: userA });
check("RPC favorites A (flag on) sem internos",
  favA.error === null && favA.data?.length === 1 && favA.data[0].tmdb_id === 550
  && !("user_id" in favA.data[0]) && !("id" in favA.data[0])
  && !("created_at" in favA.data[0]) && !("updated_at" in favA.data[0]));
const recA = await anon.rpc("get_public_recommendations", { p_username: userA });
check("RPC recommendations A com note em texto",
  recA.error === null && recA.data?.length === 1 && recA.data[0].note === "Recomendo A.");
const watA = await anon.rpc("get_public_watched", { p_username: userA, p_limit: 24, p_offset: 0 });
check("RPC watched A (flag off) → 0 rows mesmo com dado",
  watA.error === null && (watA.data ?? []).length === 0);
const ratA = await anon.rpc("get_public_ratings", { p_username: userA, p_limit: 24, p_offset: 0 });
check("RPC ratings A (flag off) → 0 rows mesmo com dado",
  ratA.error === null && (ratA.data ?? []).length === 0);

const watB1 = await anon.rpc("get_public_watched", { p_username: userB, p_limit: 24, p_offset: 0 });
const watB2 = await anon.rpc("get_public_watched", { p_username: userB, p_limit: 24, p_offset: 24 });
check("RPC watched B pagina 24+2 sem duplicatas e sem watched_at",
  watB1.error === null && watB1.data?.length === 24 && watB2.data?.length === 2
  && new Set([...watB1.data, ...watB2.data].map((w) => `${w.media_type}:${w.tmdb_id}`)).size === 26
  && !("watched_at" in (watB1.data?.[0] ?? {})) && !("user_id" in (watB1.data?.[0] ?? {})));
const watBig = await anon.rpc("get_public_watched", { p_username: userB, p_limit: 999, p_offset: -5 });
check("RPC watched respeita teto 24 e offset ≥0", watBig.error === null && (watBig.data ?? []).length === 24);

const ratB = await anon.rpc("get_public_ratings", { p_username: userB, p_limit: 24, p_offset: 0 });
const byId = Object.fromEntries((ratB.data ?? []).map((x) => [x.tmdb_id, x]));
check("RPC ratings B com reviews (inclui XSS literal)",
  ratB.error === null && (ratB.data ?? []).length === 3
  && byId[1000]?.rating === 5 && byId[1000]?.review_text === "Excelente."
  && byId[1001]?.review_text === "<script>alert(1)</script>"
  && byId[1002]?.review_text === null);

// reviews flag off → review some; ratings flag off → nada
await B.client.from("profiles").update({ show_reviews: false }).eq("id", B.id);
const ratNoRev = await anon.rpc("get_public_ratings", { p_username: userB, p_limit: 24, p_offset: 0 });
const noRevById = Object.fromEntries((ratNoRev.data ?? []).map((x) => [x.tmdb_id, x]));
check("showReviews=false → rating 5, reviewText null",
  noRevById[1000]?.rating === 5 && noRevById[1000]?.review_text === null);
await B.client.from("profiles").update({ show_reviews: true, show_ratings: false }).eq("id", B.id);
const ratNoRat = await anon.rpc("get_public_ratings", { p_username: userB, p_limit: 24, p_offset: 0 });
check("showRatings=false (+reviews true no banco) → 0 rows", (ratNoRat.data ?? []).length === 0);
await B.client.from("profiles").update({ show_ratings: true }).eq("id", B.id);

// A/B isolation: B não aparece em A e vice-versa
const favB = await anon.rpc("get_public_favorites", { p_username: userB });
check("A/B isolados por username",
  (favA.data ?? []).every((f) => f.tmdb_id === 550)
  && (favB.data ?? []).every((f) => f.tmdb_id === 1000));

// watchlist nunca pública ("Matrix" é título LEGÍTIMO da recommendation
// de A — os marcadores exclusivos de watchlist são "ZZZ Watchlist A/B").
const allPublic = JSON.stringify([pubA.data, favA.data, recA.data, watB1.data, ratB.data]);
checkd("watchlist nunca exposta (marcadores ZZZ ausentes)",
  !/ZZZ Watchlist A|ZZZ Watchlist Secreta/.test(allPublic)
  && !new RegExp(B.id).test(allPublic) && !new RegExp(B.email).test(allPublic),
  `trecho=${allPublic.slice(0, 200)}`);

// ------------------------------------------------- I. HTTP: rotas públicas
let p = await getPage(`/u/${userC}`);
check("/u/privado → 404 Perfil não disponível",
  p.res.status === 404 && /Perfil não disponível/.test(p.html));
p = await getPage("/u/zzz-nao-existe-123");
check("/u/inexistente → 404 equivalente",
  p.res.status === 404 && /Perfil não disponível/.test(p.html)
  && !/privado/i.test(p.html));
p = await getPage("/u/ABC-INVAL!DO");
check("/u/slug inválido → 404", p.res.status === 404);

p = await getPage(`/u/${userA}`);
check("/u/A parcial: identidade+fav+rec, sem assistidos/avaliacoes",
  p.res.status === 200 && p.html.includes(`@${userA}`)
  && /Clube da Luta/.test(p.html) && /Matrix/.test(p.html) && /Recomendo A\./.test(p.html)
  && !/tab=assistidos/.test(p.html) && !/tab=avaliacoes/.test(p.html)
  && !/Assistidos de/.test(p.html));
check("/u/A sem UUID/email/controles privados",
  !new RegExp(A.id).test(p.html) && !new RegExp(A.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(p.html)
  && !/Editar perfil/.test(p.html) && !/Logout/.test(p.html) && !/Minha Lista/.test(p.html));

p = await getPage(`/u/${userB}`);
// Sobre mostra identidade + 3 tabs; reviews vivem na tab Avaliações
// (nunca no Sobre) — asserts separados para não esconder a causa.
checkd("/u/B Sobre: 200 + 3 tabs",
  p.res.status === 200 && />Sobre</.test(p.html)
  && /tab=assistidos/.test(p.html) && /tab=avaliacoes/.test(p.html),
  `status=${p.res.status} tabs=${/tab=assistidos/.test(p.html)},${/tab=avaliacoes/.test(p.html)}`);
check("SEO: title @user + bio",
  new RegExp(`<title>[^<]*@${userB}[^<]*— CineVee</title>`).test(p.html)
  && /<meta name="description"/.test(p.html));
{
  // Astro empacota o <script> inline em módulo (?astro&type=script) —
  // o recurso é validado no bundle servido, não no HTML SSR.
  const srcs = [...p.html.matchAll(/<script type="module" src="([^"]*\/u\/[^"]*type=script[^"]*)"/g)]
    .map((m) => m[1].replace(/&amp;/g, "&"));
  let bundle = "";
  for (const src of srcs) {
    try {
      const res = await fetch(`${BASE}${src}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) bundle += await res.text();
    } catch {
      // ignora falha isolada; o check abaixo reprova se vazio
    }
  }
  checkd("share no bundle (navigator.share + fallback copiar)",
    /id="public-share"/.test(p.html) && bundle.includes("navigator.share")
    && bundle.includes("clipboard") && bundle.includes("Link copiado."),
    `modulos=${srcs.length} bundle=${bundle.length}chars share=${bundle.includes("navigator.share")}`);
}

p = await getPage(`/u/${userB}?tab=avaliacoes`);
checkd("/u/B avaliações: estrelas + review visível",
  p.res.status === 200 && /nota 5 de 5/.test(p.html) && /Excelente\./.test(p.html),
  `status=${p.res.status} stars=${/nota 5 de 5/.test(p.html)} review=${/Excelente\./.test(p.html)}`);
checkd("reviews escapadas (XSS literal, sem script executável)",
  /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(p.html)
  && !/<script>alert\(1\)<\/script>/.test(p.html)
  && !/innerHTML/.test(p.html),
  `escaped=${/&lt;script&gt;/.test(p.html)}`);

p = await getPage(`/u/${userB}?tab=assistidos`);
// Só cards reais têm data-key (o <template> não tem).
const ssrCards = (p.html.match(/data-public-card data-key/g) || []).length;
checkd("/u/B assistidos SSR (24 cards) + Carregar mais",
  p.res.status === 200 && /data-public-more/.test(p.html) && ssrCards === 24,
  `status=${p.res.status} more=${/data-public-more/.test(p.html)} cards=${ssrCards}`);
p = await getPage(`/u/${userA}?tab=assistidos`);
check("/u/A assistidos (flag off) → 404", p.res.status === 404);

r = await api("GET", `/api/public/profile/${userB}/watched?page=1`, null);
checkd("API watched p1 (anon): 24 + hasMore",
  r.res.status === 200 && r.json?.items?.length === 24 && r.json?.hasMore === true
  && !/"user_id"/.test(r.text),
  `status=${r.res.status} items=${r.json?.items?.length} hasMore=${r.json?.hasMore}`);
r = await api("GET", `/api/public/profile/${userB}/watched?page=2`, null);
check("API watched p2: 2 restantes, sem duplicatas",
  r.res.status === 200 && r.json?.items?.length === 2 && r.json?.hasMore === false);
r = await api("GET", `/api/public/profile/${userB}/ratings?page=1`, null);
check("API ratings (anon): 3 com review condicional",
  r.res.status === 200 && r.json?.items?.length === 3
  && r.json.items.some((i) => i.reviewText === "Excelente."));
r = await api("GET", `/api/public/profile/${userA}/watched?page=1`, null);
check("API watched flag off → 404", r.res.status === 404);
r = await api("GET", `/api/public/profile/${userB}/watched?page=0`, null);
check("API page inválida → 404", r.res.status === 404);
r = await api("GET", "/api/public/profile/zzz-nao-existe-123/watched?page=1", null);
check("API username inexistente → 404", r.res.status === 404);

// ------------------------------------------------- J. hasMore — bordas
// Casos de borda (watched e ratings, via API pública anon).
async function publicList(kind, username, page) {
  const out = await api("GET", `/api/public/profile/${username}/${kind}?page=${page}`, null);
  return {
    status: out.res.status,
    n: out.json?.items?.length ?? -1,
    hasMore: out.json?.hasMore,
    keys: (out.json?.items ?? []).map((i) => `${i.mediaType}:${i.tmdbId}`),
  };
}
for (const kind of ["watched", "ratings"]) {
  const h0 = await publicList(kind, userH, 1);
  checkd(`borda ${kind} 0 itens → 0 + false`,
    h0.status === 200 && h0.n === 0 && h0.hasMore === false,
    `status=${h0.status} n=${h0.n} hasMore=${h0.hasMore}`);
  const g1 = await publicList(kind, userG, 1);
  checkd(`borda ${kind} 1 item → 1 + false`,
    g1.status === 200 && g1.n === 1 && g1.hasMore === false,
    `status=${g1.status} n=${g1.n} hasMore=${g1.hasMore}`);
  const f1 = await publicList(kind, userF, 1);
  checkd(`borda ${kind} 24 itens → 24 + false (teto exato, sem fantasma)`,
    f1.status === 200 && f1.n === 24 && f1.hasMore === false,
    `status=${f1.status} n=${f1.n} hasMore=${f1.hasMore}`);
  const e1 = await publicList(kind, userE, 1);
  const e2 = await publicList(kind, userE, 2);
  const e3 = await publicList(kind, userE, 3);
  checkd(`borda ${kind} 49 itens → p1 24+true`,
    e1.status === 200 && e1.n === 24 && e1.hasMore === true,
    `status=${e1.status} n=${e1.n} hasMore=${e1.hasMore}`);
  checkd(`borda ${kind} 49 itens → p2 24+true (caso 48)`,
    e2.status === 200 && e2.n === 24 && e2.hasMore === true,
    `status=${e2.status} n=${e2.n} hasMore=${e2.hasMore}`);
  const union = new Set([...e1.keys, ...e2.keys, ...e3.keys]);
  checkd(`borda ${kind} 49 itens → p3 1+false, 49 únicos no total`,
    e3.status === 200 && e3.n === 1 && e3.hasMore === false && union.size === 49,
    `p3 status=${e3.status} n=${e3.n} hasMore=${e3.hasMore} unicos=${union.size}`);
}

// ------------------------------------------------- K. limpeza
for (const u of [A, B, C, D, E, F, G, H]) {
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
  await u.client.from("ratings").delete().eq("user_id", u.id);
  await u.client.from("watchlist").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
}
const cleanB = await B.client.from("watched_titles").select("tmdb_id").eq("user_id", B.id);
check("limpeza: dados de teste removidos", (cleanB.data ?? []).length === 0);

// Limpeza: sem service_role no app, os usuários de teste (pub-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users.
console.log("---");
if (failures === 0 && skipped === 0) console.log("PUBLIC OK: perfis públicos + privacidade confirmados.");
else console.log(`PUBLIC ${failures === 0 ? "PARCIAL" : "FALHOU"}: ${failures} falha(s), ${skipped} skip(s).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
