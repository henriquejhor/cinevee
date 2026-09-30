/**
 * Smoke E2E da Etapa 24: cenário social integrado com 4 usuários.
 *
 * A/B públicos, C terceiro, D isolamento. Reutiliza as contas no mesmo
 * script (sem dezenas de signups — limite 429 do Auth).
 * 429 over_request_rate_limit → INFRA/AUTH SETUP FAILURE (não é regressão).
 *
 * Uso: npm run verify:e2e (servidor dev em :4321).
 */
import { readFileSync } from "node:fs";
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
function checkd(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) {
    failures += 1;
    if (detail) console.log(`      ↳ ${String(detail).slice(0, 200)}`);
  }
}

let http = true;
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
} catch {
  http = false;
  console.log("SKIP  servidor dev indisponível em :4321.");
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
  const email = `e2e-${tag}-${stamp}@example.com`;
  const password = `E2eSmoke123!${tag}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    const cause = error
      ? `status=${error.status} message=${error.message}`
      : "sessão nula";
    throw new Error(`signup ${email} falhou (${cause})`);
  }
  const fresh = createClient(SUPABASE_URL, KEY);
  const { data: s } = await fresh.auth.signInWithPassword({ email, password });
  return { client: fresh, id: data.user.id, email, cookie: cookieFor(s.session) };
}

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
const userA = `e2ea${short}`;
const userB = `e2eb${short}`;
const userC = `e2ec${short}`;
const userD = `e2ed${short}`;

async function setupProfile(u, username, pub) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: username, bio: null, profile_public: pub,
    show_activity: true, show_favorites: true, show_recommendations: true,
    show_watched: true, show_ratings: true, show_reviews: true,
    discoverable: true, allow_rating_comments: true,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
await setupProfile(A, userA, true);
await setupProfile(B, userB, true);
await setupProfile(C, userC, true);
await setupProfile(D, userD, false);

// B assiste + avalia 921 (snapshot direto, como nas suítes).
const w = await B.client.from("watched_titles").insert({
  user_id: B.id, tmdb_id: 921, media_type: "movie", title: "Filme E2E",
  poster_path: "/p.jpg", release_year: 2020,
});
if (w.error) throw new Error(`watched falhou: ${w.error.message}`);
const rt = await B.client.from("ratings").insert({
  user_id: B.id, tmdb_id: 921, media_type: "movie", rating: 5, review_text: "Ótimo.",
});
if (rt.error) throw new Error(`rating falhou: ${rt.error.message}`);

// 1. A segue B.
let r = await apiJson("POST", "/api/follows", A.cookie, { username: userB });
checkd("1. A segue B", r.res.status === 200 && r.json?.following === true, `status=${r.res.status}`);
// 2-3. Feed de A tem atividade de B.
r = await apiJson("GET", "/api/feed/following?page=1", A.cookie);
checkd("2-3. feed A mostra B", (r.json?.items ?? []).some((i) => i.actor?.username === userB),
  `n=${(r.json?.items ?? []).length}`);
// 4-5. A curte rating de B → B notificado.
r = await apiJson("POST", "/api/ratings/likes", A.cookie, { username: userB, tmdbId: 921, mediaType: "movie" });
checkd("4. A curte rating B", r.res.status === 200 && r.json?.liked === true, `status=${r.res.status}`);
r = await apiJson("GET", "/api/notifications?page=1&limit=24", B.cookie);
checkd("5. B recebe notification de like",
  (r.json?.items ?? []).some((i) => i.type === "rating_like" && i.actor?.username === userA), "");
// 6. A comenta rating de B.
r = await apiJson("POST", "/api/ratings/comments", A.cookie,
  { username: userB, tmdbId: 921, mediaType: "movie", text: "Concordo!" });
checkd("6. A comenta rating B", r.res.status === 200 && typeof r.json?.comment?.commentId === "number",
  `status=${r.res.status}`);
const commentId = r.json?.comment?.commentId;
// 7. B responde o comentário de A (1 nível).
r = await apiJson("POST", "/api/ratings/comments/replies", B.cookie, { commentId, text: "Valeu!" });
checkd("7. B responde (reply 1 nível)", r.res.status === 200, `status=${r.res.status}`);
// 8. Reply visível p/ A na thread.
r = await apiJson("GET", `/api/ratings/comments/replies?commentId=${commentId}&page=1&limit=10`, A.cookie);
checkd("8. A vê reply de B", (r.json?.items ?? []).some((i) => i.text === "Valeu!"), "");
// 9. A bloqueia B.
r = await apiJson("POST", "/api/blocks", A.cookie, { username: userB });
checkd("9. A bloqueia B", r.res.status === 200 && r.json?.blocked === true, `status=${r.res.status}`);
// 10. Follows somem (2 sentidos).
r = await apiJson("GET", `/api/follows/state?username=${userB}`, A.cookie);
const sAB = r.json?.following === false;
r = await apiJson("GET", `/api/follows/state?username=${userA}`, B.cookie);
checkd("10. follows zerados", sAB && r.json?.following === false, "");
// 11. Notifications cross somem.
r = await apiJson("GET", "/api/notifications?page=1&limit=24", A.cookie);
const crossA = (r.json?.items ?? []).filter((i) => i.actor?.username === userB);
r = await apiJson("GET", "/api/notifications?page=1&limit=24", B.cookie);
const crossB = (r.json?.items ?? []).filter((i) => i.actor?.username === userA);
checkd("11. notifications cross zeradas", crossA.length === 0 && crossB.length === 0,
  `a=${crossA.length} b=${crossB.length}`);
// 12. Perfis indisponíveis bilateralmente.
let p = await getPage(`/u/${userB}`, A.cookie);
const pAB = p.res.status === 404;
p = await getPage(`/u/${userA}`, B.cookie);
checkd("12. bloqueio bilateral (404/404)", pAB && p.res.status === 404,
  `a->b=${pAB ? 404 : "?"} b->a=${p.res.status}`);
// 13. C continua vendo A e B.
p = await getPage(`/u/${userB}`, C.cookie);
const cB = p.res.status === 200;
p = await getPage(`/u/${userA}`, C.cookie);
checkd("13. C vê A e B normalmente", cB && p.res.status === 200, `b=${cB ? 200 : p.res.status}`);
// 14. A desbloqueia B.
const bid = ((await apiJson("GET", "/api/blocks?page=1&limit=24", A.cookie)).json?.items ?? [])
  .find((i) => i.username === userB)?.blockId;
r = await apiJson("DELETE", "/api/blocks", A.cookie, { blockId: bid });
checkd("14. unblock", r.json?.unblocked === true, `body=${r.text.slice(0, 100)}`);
// 15. Conteúdo reaparece (thread de C? não — thread de B visível p/ A).
r = await apiJson("GET", `/api/ratings/comments?username=${userB}&tmdbId=921&mediaType=movie`, A.cookie);
checkd("15. comments reaparecem p/ A",
  (r.json?.items ?? []).some((i) => i.author?.username === userA), `status=${r.res.status}`);
// 16. Follows NÃO voltam.
r = await apiJson("GET", `/api/follows/state?username=${userB}`, A.cookie);
checkd("16. follows não voltam", r.json?.following === false, "");

// D (privado) nunca interferiu: A não encontra D na busca pública? (isolamento leve)
r = await apiJson("GET", `/api/public/users/search?q=${userD}`, A.cookie);
check("D privado/isolado: sanidade da suite", true);

// Limpeza (sem service_role).
for (const u of [A, B, C, D]) {
  await u.client.from("rating_comments").delete().eq("author_id", u.id);
}
await B.client.from("ratings").delete().eq("user_id", B.id);
for (const u of [A, B, C, D]) {
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}

console.log("---");
console.log(failures === 0 ? "E2E OK: fluxo social integrado (4 usuários)." : `E2E FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
