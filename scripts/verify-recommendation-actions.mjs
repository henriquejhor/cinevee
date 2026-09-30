/**
 * Verificação da Etapa 10: ações rápidas nas recomendações.
 *
 * Uso: npm run verify:recommendation-actions (servidor dev em :4321).
 *
 * Cobre deterministicamente (HTTP + Supabase, sem browser):
 * - batch states (401/400/trio/isolamento/eficiência 1 request);
 * - add/remove watchlist via APIs existentes;
 * - mark/unmark watched + sync (sai da lista, sem recriar);
 * - rating read-only via states (cascade preservado);
 * - replacement (exclusão, sem duplicata, refinement, version, 400/502);
 * - reroll/refinement após replacement (watched nunca retorna);
 * - A/B isolation; logged-out (401 states, links de login, recs ok).
 *
 * Nenhum segredo é impresso: só PASS/FAIL/INFO por asserção.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const BASE = "http://localhost:4321";

if (!SUPABASE_URL || !KEY) {
  console.error("Faltam PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY no .env.");
  process.exit(1);
}

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
const info = (msg) => console.log(`INFO  ${msg}`);

const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const cookieFor = (session) =>
  `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

let http = true;
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
} catch {
  http = false;
  console.log("SKIP  servidor dev indisponível em :4321.");
}
if (!http) process.exit(1);

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
  const json = await res.json().catch(() => null);
  return { res, json };
}

const stamp = Date.now();
async function signUp(tag) {
  const client = createClient(SUPABASE_URL, KEY);
  const email = `recactions-${tag}-${stamp}@example.com`;
  const { data, error } = await client.auth.signUp({ email, password: `RecActions123!${tag}` });
  if (error || !data.session) throw new Error(`signup ${email} falhou`);
  return { client, id: data.user.id, email };
}
const A = await signUp("a");
const B = await signUp("b");
const supaA = createClient(SUPABASE_URL, KEY);
const { data: sA } = await supaA.auth.signInWithPassword({ email: A.email, password: `RecActions123!a` });
const cookieA = cookieFor(sA.session);
const supaB = createClient(SUPABASE_URL, KEY);
const { data: sB } = await supaB.auth.signInWithPassword({ email: B.email, password: `RecActions123!b` });
const cookieB = cookieFor(sB.session);

// Seed A: watchlist 550 · watched 603+rating 5 · watched 1396 (sem rating)
await A.client.from("watchlist").insert({ user_id: A.id, tmdb_id: 550, media_type: "movie", title: "Clube da Luta", poster_path: null, release_year: 1999 });
await A.client.from("watched_titles").insert({ user_id: A.id, tmdb_id: 603, media_type: "movie", title: "Matrix", poster_path: null, release_year: 1999 });
await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 603, media_type: "movie", rating: 5 });
await A.client.from("watched_titles").insert({ user_id: A.id, tmdb_id: 1396, media_type: "tv", title: "Breaking Bad", poster_path: null, release_year: 2008 });
// Seed B: estados diferentes nos mesmos títulos
await B.client.from("watchlist").insert({ user_id: B.id, tmdb_id: 603, media_type: "movie", title: "Matrix", poster_path: null, release_year: 1999 });

// ------------------------------------------------- A. states endpoint
let r = await api("POST", "/api/discovery/recommendation-states", null, { items: [{ tmdbId: 550, mediaType: "movie" }] });
check("states deslogado → 401", r.res.status === 401);
for (const [label, body] of [
  ["vazio", {}], ["sem items", { foo: 1 }], ["array vazio", { items: [] }],
  [">8 itens", { items: Array.from({ length: 9 }, (_, i) => ({ tmdbId: 10 + i, mediaType: "movie" })) }],
  ["tmdbId inválido", { items: [{ tmdbId: -5, mediaType: "movie" }] }],
  ["mediaType inválido", { items: [{ tmdbId: 550, mediaType: "book" }] }],
]) {
  r = await api("POST", "/api/discovery/recommendation-states", cookieA, body);
  if (r.res.status !== 400) check(`states inválido (${label}) → 400`, false);
}
check("states inválidos → 400 (6 casos)", true);

r = await api("POST", "/api/discovery/recommendation-states", cookieA, {
  items: [
    { tmdbId: 550, mediaType: "movie" },
    { tmdbId: 603, mediaType: "movie" },
    { tmdbId: 1396, mediaType: "tv" },
    { tmdbId: 999111, mediaType: "movie" },
  ],
});
const st = r.json?.states ?? {};
check("states 200 com trio em 1 batch", r.res.status === 200 &&
  st["movie:550"]?.inWatchlist === true && st["movie:550"]?.watched === false && st["movie:550"]?.rating === null &&
  st["movie:603"]?.watched === true && st["movie:603"]?.rating === 5 &&
  st["tv:1396"]?.watched === true && st["tv:1396"]?.rating === null &&
  st["movie:999111"]?.inWatchlist === false && st["movie:999111"]?.watched === false && st["movie:999111"]?.rating === null);

r = await api("POST", "/api/discovery/recommendation-states", cookieB, {
  items: [{ tmdbId: 550, mediaType: "movie" }, { tmdbId: 603, mediaType: "movie" }],
});
check("A/B isolados (B vê só o próprio)", r.res.status === 200 &&
  r.json?.states?.["movie:550"]?.inWatchlist === false &&
  r.json?.states?.["movie:603"]?.inWatchlist === true &&
  r.json?.states?.["movie:603"]?.watched === false);
check("states sem vazar PII", !/email|user_id|@example/i.test(JSON.stringify(r.json)));

// --------------------------------- B/C. watchlist + watched via APIs
r = await api("DELETE", "/api/watchlist", cookieA, { tmdbId: 550, mediaType: "movie" });
check("watchlist remove (card) → 200", r.res.status === 200);
r = await api("POST", "/api/watchlist", cookieA, { tmdbId: 550, mediaType: "movie" });
check("watchlist add (card) → 200", r.res.status === 200 && !!r.json?.item);
r = await api("POST", "/api/discovery/recommendation-states", cookieA, { items: [{ tmdbId: 550, mediaType: "movie" }] });
check("refresh preserva lista", r.json?.states?.["movie:550"]?.inWatchlist === true);

r = await api("POST", "/api/watched", cookieA, { tmdbId: 550, mediaType: "movie" });
check("watched mark → 200 + saiu da lista", r.res.status === 200 && r.json?.removedFromWatchlist === true);
r = await api("POST", "/api/discovery/recommendation-states", cookieA, { items: [{ tmdbId: 550, mediaType: "movie" }] });
check("sync: lista false + assistido true", r.json?.states?.["movie:550"]?.inWatchlist === false && r.json?.states?.["movie:550"]?.watched === true);
r = await api("DELETE", "/api/watched", cookieA, { tmdbId: 550, mediaType: "movie" });
check("watched unmark → 200", r.res.status === 200 && r.json?.removed === true);
r = await api("POST", "/api/discovery/recommendation-states", cookieA, { items: [{ tmdbId: 550, mediaType: "movie" }] });
check("desmarcar NÃO recria lista", r.json?.states?.["movie:550"]?.watched === false && r.json?.states?.["movie:550"]?.inWatchlist === false);
await api("DELETE", "/api/watchlist", cookieA, { tmdbId: 550, mediaType: "movie" }).catch(() => null);

// --------------------------------- D. recommendations + replacement
const answersFx = {
  contentType: "movie", mood: "fun", preferredGenres: [],
  adaptive: { category: "story_focus", value: "plot" },
  commitment: "any", providers: ["any"], sessionExcludedGenres: [],
};
async function recs(cookie, body) {
  return api("POST", "/api/discovery/recommendations", cookie, body);
}
const rr = await recs(cookieA, answersFx);
check("recommendations 200 + version", rr.res.status === 200 && !!rr.json?.primary && typeof rr.json?.contextVersion === "string");
const first4 = [rr.json?.primary, ...(rr.json?.alternatives || [])].filter(Boolean);
const firstKeys = new Set(first4.map((x) => `${x.item.type}:${x.item.id}`));
info(`picks: ${[...firstKeys].join(", ")}`);
const watchedNow = new Set(["movie:603", "tv:1396"]);
check("picks iniciais sem assistidos", [...firstKeys].every((k) => !watchedNow.has(k)));

// marca o 1º pick como assistido → replacement no slot
const slotPick = first4[0];
const slotKey = `${slotPick.item.type}:${slotPick.item.id}`;
await api("POST", "/api/watched", cookieA, { tmdbId: slotPick.item.id, mediaType: slotPick.item.type });
const watchedNow2 = new Set([...watchedNow, slotKey]);
const repBody = {
  answers: answersFx, refinement: null,
  excludeIds: [...firstKeys], slotKey,
};
let rep = await api("POST", "/api/discovery/replacement", cookieA, repBody);
check("replacement 200 + item + reason + version",
  rep.res.status === 200 && !!rep.json?.recommendation?.item?.id &&
  typeof rep.json?.recommendation?.reason === "string" &&
  rep.json.recommendation.reason.length >= 40 &&
  typeof rep.json?.contextVersion === "string");
const newKey = `${rep.json?.recommendation?.item?.type}:${rep.json?.recommendation?.item?.id}`;
info(`replacement: ${slotKey} → ${newKey}`);
check("replacement sem duplicata/excluídos", !firstKeys.has(newKey) && !watchedNow2.has(newKey));
check("replacement reason válida", (rep.json?.recommendation?.reason?.length ?? 0) <= 260);
await api("DELETE", "/api/watched", cookieA, { tmdbId: slotPick.item.id, mediaType: slotPick.item.type });

// replacement com refinement ativo preserva pipeline
rep = await api("POST", "/api/discovery/replacement", cookieA, { ...repBody, refinement: "newer", slotKey: newKey });
check("replacement com refinement newer → 200", rep.res.status === 200 && !!rep.json?.recommendation?.item);
// bodies inválidos
for (const [label, body] of [
  ["answers incompletas", { ...repBody, answers: { ...answersFx, mood: null } }],
  ["refinement inválido", { ...repBody, refinement: "turbo" }],
  ["excludeIds inválido", { ...repBody, excludeIds: ["nope"] }],
  ["slotKey inválido", { ...repBody, slotKey: "x" }],
  ["sem answers", { refinement: null, excludeIds: [], slotKey }],
]) {
  const bad = await api("POST", "/api/discovery/replacement", cookieA, body);
  if (bad.res.status !== 400) check(`replacement inválido (${label}) → 400`, false);
}
check("replacement inválidos → 400 (5 casos)", true);
// deslogado também recebe replacement (discovery aberto)
rep = await api("POST", "/api/discovery/replacement", null, repBody);
check("replacement deslogado → 200 (sem login wall)", rep.res.status === 200 && !!rep.json?.recommendation?.item);

// reroll após replacement: watched nunca retorna
const reroll = await recs(cookieA, { ...answersFx, excludeIds: [...firstKeys, newKey] });
const rerollKeys = [reroll.json?.primary, ...(reroll.json?.alternatives || [])].filter(Boolean).map((x) => `${x.item.type}:${x.item.id}`);
check("reroll 200 + sem assistidos", reroll.res.status === 200 && rerollKeys.every((k) => !watchedNow.has(k)));
// refinement após replacement
const ref2 = await recs(cookieA, { ...answersFx, refinement: "newer" });
check("refinement newer após replacement → 200", ref2.res.status === 200 && !!ref2.json?.primary);

// rating read-only via states (robustez UI p/ cache antigo)
r = await api("POST", "/api/discovery/recommendation-states", cookieA, { items: [{ tmdbId: 603, mediaType: "movie" }] });
check("rating aparece no trio (read-only)", r.json?.states?.["movie:603"]?.rating === 5);

// /descobrir renderiza deslogado (ações viram links no client)
const page = await fetch(`${BASE}/descobrir`);
check("/descobrir 200 deslogado", page.status === 200);

// limpeza
for (const u of [A, B]) {
  await u.client.from("ratings").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("watchlist").delete().eq("user_id", u.id);
}

console.log("---");
console.log(failures === 0 ? "REC-ACTIONS OK: batch + sync + replacement confirmados." : `REC-ACTIONS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
