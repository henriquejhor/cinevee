/**
 * Verificação da Etapa 16: seguir usuários (public.follows + /u/* social).
 *
 * Pré-requisito: migration supabase/migrations/20261001090000_follows.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem da tabela/RPCs entram em SKIP
 * identificado (exit 1); contratos de arquivo rodam sempre.
 *
 * Uso: npm run verify:follows (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration (tabela, unique, anti-self CHECK, FKs cascade, índices,
 *   RLS sem SELECT público/amplo, 7 RPCs SECURITY DEFINER allowlisted,
 *   grants mínimos, sem SQL dinâmica);
 * - RLS direto: A não insere com follower_id=B; A não deleta row de B;
 *   A deleta a própria; anon SELECT → nada; auth SELECT global → só
 *   rows onde participa; CHECK bloqueia self-follow;
 * - POST follow (idempotente, 404 genérico p/ privado/inexistente/self,
 *   discoverable=false pode ser seguido, 401 deslogado, 400 inválido);
 * - DELETE unfollow (idempotente, só remove a própria);
 * - GET state (auth, só relação própria; privado → false/false);
 * - counts: self totais vs públicos (total followers / só-públicos
 *   following); unpublish esconde sem apagar; republicar restaura;
 * - lists: só identidades públicas, recentes primeiro, paginação 24/25
 *   sem duplicatas, sem UUID/email/flags/datas;
 * - username change preserva follow e reflete o novo nome;
 * - A/B isolation; XSS como texto; UI (botão, counts, links, login next).
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

const MIGRATION_FILE = "supabase/migrations/20261001090000_follows.sql";

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
check("migration Etapa 16 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
check("migration tabela follows (FKs cascade, unique, anti-self)",
  /create table if not exists public\.follows/i.test(migration)
  && /references auth\.users \(id\) on delete cascade/i.test(migration)
  && /constraint follows_unique_pair unique \(follower_id, following_id\)/i.test(migration)
  && /constraint follows_no_self check \(follower_id <> following_id\)/i.test(migration));
check("migration índices created_at desc", /follows_following_idx/i.test(migration)
  && /follows_follower_idx/i.test(migration)
  && /created_at desc/i.test(migration));
check("migration RLS sem SELECT público/amplo, sem UPDATE",
  /enable row level security/i.test(migration)
  && /follower_id = auth\.uid\(\) or following_id = auth\.uid\(\)/i.test(migration)
  && /for insert[\s\S]{0,160}with check \(follower_id = auth\.uid\(\)\)/i.test(migration)
  && /for delete[\s\S]{0,160}using \(follower_id = auth\.uid\(\)\)/i.test(migration)
  && !/for update/i.test(migration)
  && !/create policy[^;]*\bto\s+(anon|public)\b/i.test(migration)
  && !/create policy[^;]*using\s*\(\s*true\s*\)/i.test(migration));
check("migration 7 RPCs SECURITY DEFINER", [
  "follow_user_by_username", "unfollow_user_by_username", "get_follow_state",
  "get_public_follow_counts", "get_public_followers", "get_public_following",
  "get_my_follow_counts",
].every((fn) => new RegExp(`function public\\.${fn}`, "i").test(migration))
  && (migration.match(/security definer/gi) || []).length >= 7);
check("migration search_path fixo + sem SQL dinâmica",
  (migration.match(/set search_path = public/gi) || []).length >= 7
  && !/execute\s+format|execute\s+['"]select|execute\s+['"]insert|execute\s+['"]delete/i.test(migration));
check("migration grants mínimos (anon só leitura pública)",
  /grant execute on function public\.follow_user_by_username\(text\) to authenticated/i.test(migration)
  && /grant execute on function public\.get_follow_state\(text\) to anon, authenticated/i.test(migration)
  && /grant execute on function public\.get_my_follow_counts\(\) to authenticated/i.test(migration)
  && !/to anon[^;]*follow_user_by_username|to anon[^;]*unfollow_user_by_username|to anon[^;]*get_my_follow_counts/i.test(migration));
check("migration teto 24 + listas só identidade (sem UUID/email/flags)",
  /least\(greatest\(coalesce\(p_limit, 24\), 1\), 24\)/i.test(migration)
  && /returns table \(\s*display_name text,\s*username text,\s*bio text,\s*avatar_path text\s*\)/i.test(migration)
  && !/returns table \([^)]*(user_id|email|profile_public|show_|created_at|follower_id|following_id)/i.test(migration));

const followService = readFile("../src/lib/follows/service.ts");
check("lib follows (RPCs, sem follower_id do client, erros genéricos)",
  /follow_user_by_username/.test(followService)
  && /unfollow_user_by_username/.test(followService)
  && /FollowNotAvailableError/.test(followService)
  && !/"follower_id"|'follower_id'/.test(followService));
check("lib follows validation (só username, mesma regra)",
  /validateFollowTarget/.test(readFile("../src/lib/follows/validation.ts"))
  && /USERNAME_PATTERN/.test(readFile("../src/lib/follows/validation.ts"))
  && !/"follower_id"|'follower_id'|followerId/.test(readFile("../src/lib/follows/validation.ts")));

const followsApi = readFile("../src/pages/api/follows.ts");
check("API follows POST/DELETE + state GET (401/400/404, sem UUID)",
  /export const POST/.test(followsApi) && /export const DELETE/.test(followsApi)
  && /export const GET/.test(readFile("../src/pages/api/follows/state.ts"))
  && /status: 401/.test(followsApi) && /status: 404/.test(followsApi)
  && !/user_id|userId/.test(followsApi));

const followersApi = readFile("../src/pages/api/public/profile/[username]/followers.ts");
const followingApi = readFile("../src/pages/api/public/profile/[username]/following.ts");
check("APIs públicas followers/following (sem auth, 404, teto)",
  /getPublicFollowers/.test(followersApi) && /getPublicFollowing/.test(followingApi)
  && !/getCurrentUser/.test(followersApi + followingApi)
  && /Página inválida/.test(followersApi + followingApi));

const publicPage = readFile("../src/pages/u/[username].astro");
check("página /u: botão follow, counts, links, sem UUID",
  /id="follow-button"/.test(publicPage) && /data-followers-count/.test(publicPage)
  && /seguidores/.test(publicPage) && /\/seguidores/.test(publicPage)
  && /\/seguindo/.test(publicPage) && /Este é seu perfil/.test(publicPage)
  && /aria-pressed/.test(publicPage) && /Deixar de seguir/.test(publicPage)
  && !/\.innerHTML|:set:html/.test(publicPage));
check("página /u sem Minha Lista no social", !/show_watchlist|Watchlist/.test(publicPage));
check("botão redireciona p/ login em 401 (next)",
  /\/entrar\?next=/.test(publicPage));

const seguidoresPage = readFile("../src/pages/u/[username]/seguidores.astro");
const seguindoPage = readFile("../src/pages/u/[username]/seguindo.astro");
check("páginas seguidores/seguindo (SSR+Carregar mais, sem follow button)",
  /getPublicFollowers/.test(seguidoresPage) && /getPublicFollowing/.test(seguindoPage)
  && /data-people-more/.test(seguidoresPage + seguindoPage)
  && !/follow-button|Seguir</.test(seguidoresPage + seguindoPage)
  && /\/api\/public\/profile\//.test(seguidoresPage + seguindoPage));

const perfilPage = readFile("../src/pages/perfil.astro");
check("perfil próprio: seguidores→management privada, seguindo discreto (pós-Etapa 23)",
  /getMyFollowCounts/.test(perfilPage) && /seguidor/.test(perfilPage)
  && /href="\/perfil\/seguidores"/.test(perfilPage)
  && /\$\{ownFollowHref\}\/seguindo/.test(perfilPage));

const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome follows", !/follow/i.test(taste));

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
  const email = `flw-${tag}-${stamp}@example.com`;
  const password = `FollowsVerificacao123!${tag}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    const cause = error
      ? `status=${error.status} name=${error.name} message=${error.message} code=${error.code ?? "?"}`
      : "sessão nula";
    throw new Error(`signup ${email} falhou (${cause})`);
  }
  const fresh = createClient(SUPABASE_URL, KEY);
  const { data: s } = await fresh.auth.signInWithPassword({ email, password });
  return { client, id: data.user.id, email, cookie: cookieFor(s.session) };
}

// 4 contas base + 25 seguidores p/ paginação (total 29 Auth/execução).
// auth.users não é apagável sem service_role: contas acumulam no Auth
// (só rows de follows são limpas em H); usernames únicos por run evitam
// colisão entre execuções.
const created = [];
let A, B, C, D;
const fans = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  A = await signUp("a"); created.push(A);
  B = await signUp("b"); created.push(B);
  C = await signUp("c"); created.push(C);
  D = await signUp("d"); created.push(D);
  // 25 seguidores p/ paginação 24/25: espaça signups p/ não estourar
  // o rate limit do Auth (over_request_rate_limit).
  for (let i = 0; i < 25; i += 1) {
    if (i > 0) await sleep(2500);
    const f = await signUp(`f${i}`);
    fans.push(f);
    created.push(f);
  }
} catch (error) {
  console.log("---");
  console.log(`INFRA/AUTH SETUP FAILURE (não é regressão do produto): ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const short = String(stamp).slice(-9);
const userA = `flwa${short}`;
const userB = `flwb${short}`;
const userC = `flwc${short}`;
const userD = `flwd${short}`;

// ------------------------------------------------- C. probe migration
const probe = await A.client.from("follows").select("follower_id").limit(1);
const migrationMissing = probe.error && /follows|relation|does not exist|schema cache|PGRST|permission denied|42P01/i.test(
  `${probe.error.message ?? ""} ${probe.error.code ?? ""}`,
);
let rpcMissing = false;
if (!migrationMissing) {
  const rpcProbe = await A.client.rpc("get_public_follow_counts", { p_username: "zzz" });
  rpcMissing = rpcProbe.error !== null && /function|does not exist|PGRST/i.test(
    `${rpcProbe.error.message ?? ""} ${rpcProbe.error.code ?? ""}`,
  );
}
if (migrationMissing || rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: RLS, POST/DELETE, counts, listas, paginação, XSS");
  skip("HTTP: botão, counts, listas, login next");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("tabela follows acessível (probe RLS vazio)", probe.error === null);

// ------------------------------------------------- D. seed identidades
async function setupProfile(u, { username, displayName, bio, pub }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio, profile_public: pub,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
// A: público + discoverable. B: público + discoverable=false.
// C: privado. D: público + discoverable (seguidor auxiliar com XSS).
await setupProfile(A, { username: userA, displayName: `Alvo ${short}`, bio: `Bio pública ${short}.`, pub: true });
await setupProfile(B, { username: userB, displayName: `Beta ${short}`, bio: null, pub: true });
await setupProfile(C, { username: userC, displayName: `Gama ${short}`, bio: null, pub: false });
await setupProfile(D, {
  username: userD, displayName: "<script>alert(1)</script>", bio: "<img src=x onerror=alert(1)>", pub: true,
});
for (let i = 0; i < fans.length; i += 1) {
  await setupProfile(fans[i], {
    username: `flwf${short}${String(i).padStart(2, "0")}`,
    displayName: `Fã ${i}`,
    bio: null,
    pub: true,
  });
}
// NOTE: 25 fãs públicos seguem B (paginação 24+2). A divergência
// total-vs-lista (seguidor privado oculto) é testada em G com C→A.

// ------------------------------------------------- E. RLS direto na tabela
const crossIns = await A.client.from("follows").insert({
  follower_id: B.id, following_id: A.id,
}).select("follower_id");
checkd("A NÃO insere follow com follower_id=B",
  (crossIns.data ?? []).length === 0,
  `linhas=${(crossIns.data ?? []).length} erro=${crossIns.error?.message ?? "nenhum"}`);
// B segue A (via tabela, p/ montar cenário de delete cruzado).
await B.client.from("follows").insert({ follower_id: B.id, following_id: A.id });
const crossDel = await A.client.from("follows").delete()
  .eq("follower_id", B.id).eq("following_id", A.id).select("follower_id");
checkd("A NÃO deleta follow criado por B",
  (crossDel.data ?? []).length === 0,
  `linhas=${(crossDel.data ?? []).length}`);
const stillThere = await B.client.from("follows").select("follower_id")
  .eq("follower_id", B.id).eq("following_id", A.id);
check("row de B intacta após tentativa de A", (stillThere.data ?? []).length === 1);
const ownDel = await B.client.from("follows").delete()
  .eq("follower_id", B.id).eq("following_id", A.id).select("follower_id");
check("B deleta o próprio follow", (ownDel.data ?? []).length === 1);
const selfIns = await A.client.from("follows").insert({
  follower_id: A.id, following_id: A.id,
}).select("follower_id");
checkd("CHECK bloqueia self-follow direto",
  (selfIns.data ?? []).length === 0 && selfIns.error !== null,
  `linhas=${(selfIns.data ?? []).length}`);
const anon = createClient(SUPABASE_URL, KEY);
const anonSel = await anon.from("follows").select("follower_id").limit(5);
check("anon SELECT follows → nada", (anonSel.data ?? []).length === 0);
const authWide = await A.client.from("follows").select("follower_id,following_id").limit(50);
checkd("auth SELECT global → só rows onde participa",
  (authWide.data ?? []).every((r) => r.follower_id === A.id || r.following_id === A.id),
  `linhas=${(authWide.data ?? []).length}`);

// ------------------------------------------------- F. API follow/unfollow
let r = await api("POST", "/api/follows", null, { username: userA });
check("POST deslogado → 401", r.res.status === 401);
r = await api("DELETE", "/api/follows", null, { username: userA });
check("DELETE deslogado → 401", r.res.status === 401);
r = await api("GET", `/api/follows/state?username=${userA}`, null);
check("GET state deslogado → 401", r.res.status === 401);
r = await api("POST", "/api/follows", D.cookie, { username: "!!" });
check("POST username inválido → 400", r.res.status === 400);
r = await api("POST", "/api/follows", D.cookie, { username: userC });
checkd("POST alvo privado → 404 genérico",
  r.res.status === 404 && /Perfil não disponível/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await api("POST", "/api/follows", D.cookie, { username: "zzzqnaoexiste123" });
checkd("POST alvo inexistente → 404 genérico",
  r.res.status === 404 && /Perfil não disponível/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
r = await api("POST", "/api/follows", A.cookie, { username: userA });
checkd("POST self-follow bloqueado",
  r.res.status === 404 && /Perfil não disponível/.test(r.json?.error || ""),
  `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
// A segue B (B público + discoverable=false → permitido, item 10).
r = await api("POST", "/api/follows", A.cookie, { username: userB });
checkd("A segue B (public, discoverable=false) → 200",
  r.res.status === 200 && r.json?.following === true,
  `status=${r.res.status} body=${r.text.slice(0, 120)}`);
r = await api("POST", "/api/follows", A.cookie, { username: userB });
check("POST duplicado idempotente → 200 sem segunda row", r.res.status === 200 && r.json?.following === true);
const dupRows = await A.client.from("follows").select("follower_id")
  .eq("follower_id", A.id).eq("following_id", B.id);
check("ainda 1 row após duplicata", (dupRows.data ?? []).length === 1);
r = await api("POST", "/api/follows", B.cookie, { username: userA });
check("B segue A → 200", r.res.status === 200 && r.json?.following === true);
// GET state: só a própria relação.
r = await api("GET", `/api/follows/state?username=${userB}`, A.cookie);
checkd("GET state A→B: following true, isSelf false",
  r.res.status === 200 && r.json?.following === true && r.json?.isSelf === false,
  `status=${r.res.status} body=${r.text.slice(0, 120)}`);
r = await api("GET", `/api/follows/state?username=${userA}`, A.cookie);
check("GET state próprio: isSelf true", r.res.status === 200 && r.json?.isSelf === true);
r = await api("GET", `/api/follows/state?username=${userC}`, A.cookie);
check("GET state alvo privado → false/false", r.res.status === 200
  && r.json?.following === false && r.json?.isSelf === false);
// DELETE idempotente + restrito à própria row.
r = await api("DELETE", "/api/follows", A.cookie, { username: userB });
checkd("A deixa B → removed true",
  r.res.status === 200 && r.json?.following === false && r.json?.removed === true,
  `status=${r.res.status} body=${r.text.slice(0, 120)}`);
r = await api("DELETE", "/api/follows", A.cookie, { username: userB });
check("DELETE repetido → removed false", r.res.status === 200 && r.json?.removed === false);
await api("POST", "/api/follows", A.cookie, { username: userB });

// ------------------------------------------------- G. counts + listas + regras
const cntA = await anon.rpc("get_public_follow_counts", { p_username: userA });
checkd("counts A: followers total (B segue A)",
  cntA.error === null && cntA.data?.[0]?.followers_count === 1,
  `erro=${cntA.error?.message ?? "nenhum"} data=${JSON.stringify(cntA.data)}`);
// D segue A também (via API, p/ compor cenário de lista).
await api("POST", "/api/follows", D.cookie, { username: userA });
// C (privado) segue A direto na tabela (RLS permite: follower próprio).
// Testa total-vs-lista: count inclui C, lista pública não.
await C.client.from("follows").insert({ follower_id: C.id, following_id: A.id });
const cntA2 = await anon.rpc("get_public_follow_counts", { p_username: userA });
checkd("counts A: followers total 3 (B + D públicos + C privado), following 1 (B público)",
  cntA2.data?.[0]?.followers_count === 3 && cntA2.data?.[0]?.following_count === 1,
  `data=${JSON.stringify(cntA2.data)}`);
const cntC = await anon.rpc("get_public_follow_counts", { p_username: userC });
check("counts perfil privado → 0 rows", (cntC.data ?? []).length === 0);

const listA = await anon.rpc("get_public_followers", { p_username: userA, p_limit: 24, p_offset: 0 });
checkd("lista followers A: só identidades públicas, sem UUID/email/flags",
  (listA.data ?? []).length === 2
  && (listA.data ?? []).every((p) =>
    p !== null && typeof p === "object" && typeof p.username === "string"
    && !("user_id" in p) && !("id" in p)
    && !("email" in p) && !("created_at" in p) && !("follower_id" in p)
    && !("following_id" in p) && !("profile_public" in p) && !("discoverable" in p)
    && !Object.keys(p).some((key) => key.startsWith("show_"))),
  `n=${(listA.data ?? []).length} keys=${JSON.stringify(listA.data?.[0] ? Object.keys(listA.data[0]) : null)}`);
check("lista followers A ordenada e sem o privado C (D, B)",
  (listA.data ?? []).map((p) => p.username).join(",") === [userD, userB].join(","));
const wideD = await D.client.from("follows").select("follower_id,following_id").limit(50);
check("D vê via RLS só rows onde participa (D→A)",
  (wideD.data ?? []).length === 1 && wideD.data?.[0]?.follower_id === D.id);

// 25 fãs públicos seguem B via API (cada um com seu cookie).
for (let i = 0; i < fans.length; i += 1) {
  const fr = await api("POST", "/api/follows", fans[i].cookie, { username: userB });
  if (fr.res.status !== 200) {
    check(`fã ${i} segue B`, false);
  }
}
check("25 fãs seguem B (todos públicos)", true);
const cntB = await anon.rpc("get_public_follow_counts", { p_username: userB });
checkd("counts B: followers total 26 (A + 25), following só-públicos 1 (A)",
  cntB.data?.[0]?.followers_count === 26 && cntB.data?.[0]?.following_count === 1,
  `data=${JSON.stringify(cntB.data)}`);
const listB = await anon.rpc("get_public_following", { p_username: userB, p_limit: 24, p_offset: 0 });
check("lista following B: só A (alvo público)",
  (listB.data ?? []).length === 1 && listB.data?.[0]?.username === userA);
const lb1 = await anon.rpc("get_public_followers", { p_username: userB, p_limit: 24, p_offset: 0 });
const lb2 = await anon.rpc("get_public_followers", { p_username: userB, p_limit: 24, p_offset: 24 });
const allB = [...(lb1.data ?? []), ...(lb2.data ?? [])];
checkd("followers B: 26 públicos em 24+2, sem duplicatas",
  lb1.data?.length === 24 && lb2.data?.length === 2
  && new Set(allB.map((p) => p.username)).size === 26,
  `p1=${lb1.data?.length} p2=${lb2.data?.length}`);

// B despublica: row continua, público some, republicar restaura.
await B.client.from("profiles").update({ profile_public: false }).eq("id", B.id);
const cntBPriv = await anon.rpc("get_public_follow_counts", { p_username: userB });
check("B privado: counts 0 rows", (cntBPriv.data ?? []).length === 0);
const listBPriv = await anon.rpc("get_public_following", { p_username: userB, p_limit: 24, p_offset: 0 });
check("B privado: following 0 rows", (listBPriv.data ?? []).length === 0);
const stillRow = await A.client.from("follows").select("follower_id")
  .eq("follower_id", A.id).eq("following_id", B.id);
check("row A→B continua no banco (não apagada)", (stillRow.data ?? []).length === 1);
await B.client.from("profiles").update({ profile_public: true }).eq("id", B.id);
const cntBBack = await anon.rpc("get_public_follow_counts", { p_username: userB });
check("B republicado: following 1 de volta", cntBBack.data?.[0]?.following_count === 1);

// Username change: B @antigo → @novo; A continua seguindo; lista mostra novo.
const userB2 = `${userB}novo`;
await B.client.from("profiles").update({ username: userB2 }).eq("id", B.id);
const listB2 = await anon.rpc("get_public_following", { p_username: userB, p_limit: 24, p_offset: 0 });
check("username antigo não resolve", (listB2.data ?? []).length === 0);
const listB2n = await anon.rpc("get_public_following", { p_username: userB2, p_limit: 24, p_offset: 0 });
checkd("username novo resolve com a relação preservada",
  (listB2n.data ?? []).length === 1 && listB2n.data?.[0]?.username === userA,
  `n=${(listB2n.data ?? []).length}`);


// ------------------------------------------------- H. UI pública + XSS
let p = await getPage(`/u/${userB2}`);
checkd("/u/B2: 200 + botão Seguir + counts + links",
  p.res.status === 200 && /id="follow-button"/.test(p.html)
  && /data-followers-count/.test(p.html) && /seguidores/.test(p.html)
  && /\/seguidores/.test(p.html) && /\/seguindo/.test(p.html),
  `status=${p.res.status}`);
p = await getPage(`/u/${userB2}`, A.cookie);
checkd("/u/B2 p/ A (segue B): ✓ Seguindo + aria-pressed",
  /✓ Seguindo/.test(p.html) && /aria-pressed="true"/.test(p.html)
  && /Deixar de seguir/.test(p.html),
  `status=${p.res.status}`);
p = await getPage(`/u/${userB2}`, D.cookie);
check("D vê Seguir (não segue B2)", /id="follow-button"/.test(p.html)
  && />Seguir</.test(p.html) && /aria-pressed="false"/.test(p.html));
p = await getPage(`/u/${userB2}`, B.cookie);
check("B no próprio perfil: sem botão, 'Este é seu perfil'",
  !/id="follow-button"/.test(p.html) && /Este é seu perfil/.test(p.html));
p = await getPage(`/u/${userC}`);
check("C privado: 404 sem botão", p.res.status === 404 && !/id="follow-button"/.test(p.html));
p = await getPage(`/u/${userB2}/seguidores`);
checkd("/u/B2/seguidores: 200 + 24 cards SSR + Carregar mais (26 públicos)",
  p.res.status === 200 && /data-people-more/.test(p.html)
  && (p.html.match(/data-person-card data-key/g) ?? []).length === 24,
  `status=${p.res.status}`);
p = await getPage(`/u/${userC}/seguidores`);
check("/u/C/seguidores privado → 404", p.res.status === 404);
p = await getPage(`/u/${userB2}/seguindo`);
check("/u/B2/seguindo: A listado", p.res.status === 200 && p.html.includes(userA));
p = await getPage(`/u/${userB2}`, D.cookie);
check("autenticado usa botão+API (sem link de login no HTML)",
  !/\/entrar\?next=/.test(p.html));
check("HTML público sem UUID/email", !new RegExp(B.id).test(p.html)
  && !/user_id|@example\.com/.test(p.html));
// XSS: D (display script) aparece na lista de A como texto escapado.
const listAxss = await anon.rpc("get_public_followers", { p_username: userA, p_limit: 24, p_offset: 0 });
check("RPC followers A inclui D com note XSS literal",
  (listAxss.data ?? []).some((x) => x.display_name === "<script>alert(1)</script>"));
p = await getPage(`/u/${userA}/seguidores`);
checkd("UI escapa XSS (texto, sem tag executável)",
  /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(p.html)
  && /&lt;img src=x onerror=alert\(1\)&gt;/.test(p.html)
  && !/<script>alert\(1\)<\/script>/.test(p.html)
  && !/<img src=x onerror=alert\(1\)>/.test(p.html),
  `status=${p.res.status}`);

// Paginação via API pública: 26 seguidores públicos de B2.
// p1 = 24 + hasMore true; p2 = 2 + hasMore false; união 26 únicos.
r = await api("GET", `/api/public/profile/${userB2}/followers?page=1`, null);
checkd("API followers p1 (anon): 24 + hasMore + sem UUID",
  r.res.status === 200 && r.json?.items?.length === 24 && r.json?.hasMore === true
  && !/"user_id"|"follower_id"/.test(r.text),
  `status=${r.res.status} n=${r.json?.items?.length} hasMore=${r.json?.hasMore}`);
const p1keys = (r.json?.items ?? []).map((i) => i.username);
r = await api("GET", `/api/public/profile/${userB2}/followers?page=2`, null);
const p2keys = (r.json?.items ?? []).map((i) => i.username);
checkd("API followers p2: 2 + hasMore false, 26 únicos no total",
  r.res.status === 200 && r.json?.items?.length === 2 && r.json?.hasMore === false
  && new Set([...p1keys, ...p2keys]).size === 26,
  `status=${r.res.status} n=${r.json?.items?.length} hasMore=${r.json?.hasMore}`);
r = await api("GET", `/api/public/profile/${userB2}/followers?page=0`, null);
check("API followers page inválida → 404", r.res.status === 404);
r = await api("GET", `/api/public/profile/${userB2}/following?page=1`, null);
check("API following p1: A listado", r.res.status === 200
  && (r.json?.items ?? []).some((i) => i.username === userA));
r = await api("GET", `/api/public/profile/${userC}/followers?page=1`, null);
check("API followers perfil privado → 404", r.res.status === 404);


// ------------------------------------------------- I. perfil próprio + limpeza
// A: followers B, D, C (3 totais) · following B (1).
// Pós-Etapa 23: "Seguidores" do próprio /perfil aponta para a management
// privada /perfil/seguidores (funciona mesmo com perfil privado); "Seguindo"
// continua discreto (link público /u/A/seguindo só com perfil público).
p = await getPage("/perfil", A.cookie);
checkd("/perfil de A: counts próprios (3 seguidores · 1 seguindo; seguidores→management)",
  p.res.status === 200 && /3 seguidores/.test(p.html) && /1 seguindo/.test(p.html)
  && /href="\/perfil\/seguidores"/.test(p.html)
  && new RegExp(`/u/${userA}/seguindo`).test(p.html)
  && !new RegExp(`/u/${userA}/seguidores`).test(p.html),
  `status=${p.res.status}`);
// Privado: management continua acessível; rota pública continua fechada.
await A.client.from("profiles").update({ profile_public: false }).eq("id", A.id);
p = await getPage("/perfil", A.cookie);
checkd("/perfil privado de A: seguidores→management, seguindo sem link público",
  p.res.status === 200 && /3 seguidores/.test(p.html) && /1 seguindo/.test(p.html)
  && /href="\/perfil\/seguidores"/.test(p.html)
  && !new RegExp(`/u/${userA}/seguindo`).test(p.html),
  `status=${p.res.status}`);
p = await getPage("/perfil/seguidores", A.cookie);
checkd("/perfil/seguidores com perfil privado → 200",
  p.res.status === 200,
  `status=${p.res.status}`);
p = await getPage(`/u/${userA}/seguidores`, null);
check("/u/A/seguidores privado → 404 (pública continua fechada)", p.res.status === 404);
await A.client.from("profiles").update({ profile_public: true }).eq("id", A.id);
for (const u of [A, B, C, D, ...fans]) {
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}
const cleanA = await A.client.from("follows").select("follower_id")
  .eq("follower_id", A.id);
const cleanAf = await A.client.from("follows").select("follower_id")
  .eq("following_id", A.id);
check("limpeza: follows removidos", (cleanA.data ?? []).length === 0 && (cleanAf.data ?? []).length === 0);

// Limpeza: sem service_role no app, os usuários de teste (flw-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users
// (a cascata apaga as linhas restantes, se houver).
console.log("---");
console.log(failures === 0 && skipped === 0 ? "FOLLOWS OK: seguir + listas + privacidade confirmados." : `FOLLOWS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
