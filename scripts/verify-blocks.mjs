/**
 * Verificação da Etapa 23: bloqueio + remoção de seguidores.
 *
 * Pré-requisito: migration supabase/migrations/20261010090000_user_blocks.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP entram em SKIP identificado (exit 1); contratos
 * de arquivo rodam sempre.
 *
 * Uso: npm run verify:blocks (servidor dev em :4321 p/ parte HTTP).
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e APENAS 4
 * Auth users (A blocker, B blocked, C terceiro, D isolamento/private).
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

const MIGRATION_FILE = "supabase/migrations/20261010090000_user_blocks.sql";

let failures = 0;
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

function containsUuid(value, uuids) {
  const text = JSON.stringify(value);
  return uuids.some((u) => typeof u === "string" && u.length > 0 && text.includes(u));
}

// ------------------------------------------------- A. arquivos/migration
check("migration Etapa 23 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
const migrationCode = codeOnly(migration);
check("follows ganha id identity + unique (PK atual preservada)",
  /alter table public\.follows[\s\S]{0,120}add column if not exists id bigint generated always as identity/i.test(migration)
  && /constraint follows_unique_id unique \(id\)/i.test(migration)
  && !/drop constraint.*"follows_unique_pair"|drop constraint if exists follows_unique_pair/i.test(migrationCode));
check("user_blocks (ids, FKs cascade, unique par, anti-self)",
  /create table if not exists public\.user_blocks/i.test(migration)
  && /id bigint generated always as identity primary key/i.test(migration)
  && /blocker_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /blocked_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /constraint user_blocks_unique_pair unique \(blocker_id, blocked_id\)/i.test(migration)
  && /check \(blocker_id <> blocked_id\)/i.test(migration));
check("índice reverso (blocked, blocker)",
  /user_blocks_reverse_idx[\s\S]{0,80}\(blocked_id, blocker_id\)/i.test(migration));
check("RLS sem policies (zero acesso direto)",
  /alter table public\.user_blocks enable row level security/i.test(migration)
  && !/create policy/i.test(migrationCode));
// 42601: `position` (palavra do parser) exige aspas no DDL; o nome lógico
// continua `position` (sem rename de contrato) e recommendations mantém
// a ordem (..., note, position).
check("favorites preserva campo position (quoted, sem rename)",
  /"position" integer/.test(migration)
  && /pk\."position" as "position"/.test(migration)
  && !/pick_position|item_position|position_value/.test(migrationCode));
check("recommendations preserva ordem (note antes de position)",
  /release_year integer,\s*note text,\s*"position" integer/.test(migration));
check("helper bilateral null-safe + apply atômico (revogados)",
  /function public\.users_are_blocked\(uuid, uuid\)/i.test(migration)
  && /function public\.apply_user_block\(uuid, uuid\)/i.test(migration)
  && /revoke all on function public\.users_are_blocked\(uuid, uuid\) from public/i.test(migration)
  && /revoke all on function public\.apply_user_block\(uuid, uuid\) from public/i.test(migration)
  && !/grant execute on function public\.users_are_blocked/i.test(migrationCode)
  && !/grant execute on function public\.apply_user_block/i.test(migrationCode));
check("apply: block + follows 2 sentidos + notifications cross (sem content delete)",
  /delete from public\.follows[\s\S]{0,220}follower_id = p_blocker and following_id = p_blocked/i.test(migration)
  && /delete from public\.notifications[\s\S]{0,220}recipient_id = p_blocker and actor_id = p_blocked/i.test(migration)
  && !/delete from public\.rating_likes|delete from public\.rating_comments|delete from public\.ratings/i.test(migrationCode));
check("6 RPCs novas (block/unblock/listas/remove, auth only)",
  /function public\.block_user_by_username\(text\)/i.test(migration)
  && /function public\.block_my_follower\(bigint\)/i.test(migration)
  && /function public\.unblock_user\(bigint\)/i.test(migration)
  && /function public\.get_my_blocked_users\(\s*integer\s*,\s*integer\s*\)/i.test(migration)
  && /function public\.get_my_followers\(\s*integer\s*,\s*integer\s*\)/i.test(migration)
  && /function public\.remove_my_follower\(bigint\)/i.test(migration)
  && /grant execute on function public\.block_user_by_username\(text\) to authenticated/i.test(migration)
  && /grant execute on function public\.get_my_followers\(integer, integer\) to authenticated/i.test(migration)
  && !/to anon/i.test(migrationCode));
check("gates de escrita (follow/like/comment/reply, erro genérico)",
  /raise exception 'Perfil não disponível.';[\s\S]{0,400}users_are_blocked\(v_me, v_target\)/i.test(migration)
  && /users_are_blocked\(v_me, v_owner\)/i.test(migration)
  && /users_are_blocked\(v_me, v_rating_owner\)[\s\S]{0,120}users_are_blocked\(v_me, v_parent_author\)/i.test(migration));
check("gates de leitura (comments/replies/states/search/feed/perfis/follows/inbox)",
  /and not public\.users_are_blocked\(v_me, c\.author_id\)/i.test(migration)
  && /and not public\.users_are_blocked\(v_me, rp\.author_id\)/i.test(migration)
  && /and not public\.users_are_blocked\(auth\.uid\(\), p\.id\)/i.test(migration)
  && /and not public\.users_are_blocked\(auth\.uid\(\), fp\.id\)/i.test(migration)
  && /and not public\.users_are_blocked\(src\.recipient_id, src\.actor_id\)/i.test(migration)
  && /and not public\.users_are_blocked\(n\.recipient_id, n\.actor_id\)/i.test(migration));
check("sem reports/mute/admin/notification de block",
  !/report|mute|admin|suspend|ban\b/i.test(migrationCode)
  && !/type in \([^)]*'block'[^)]*\)/i.test(migrationCode.replace(/user_blocks|unblock|blocked/g, "")));

const blockTypes = codeOnly(readFile("../src/lib/blocks/types.ts"));
check("lib blocks types (blockId/followId, sem UUID)",
  /BlockedUserItem/.test(blockTypes) && /FollowerItem/.test(blockTypes)
  && /BLOCKS_PAGE_SIZE = 24/.test(blockTypes)
  && !/blocker_id|blocked_id|follower_id|user_id|email/i.test(blockTypes));
const blockService = codeOnly(readFile("../src/lib/blocks/service.ts"));
check("lib blocks service (6 RPCs, sem .from direto, sem UUID)",
  /block_user_by_username/.test(blockService) && /block_my_follower/.test(blockService)
  && /unblock_user/.test(blockService) && /get_my_blocked_users/.test(blockService)
  && /get_my_followers/.test(blockService) && /remove_my_follower/.test(blockService)
  && !/from\("user_blocks"\)|from\("follows"\)/.test(blockService)
  && !/blocker_id|blocked_id|follower_id/i.test(blockService));
const blocksApi = codeOnly(readFile("../src/pages/api/blocks.ts"));
check("API blocks GET/POST/DELETE (401/404/409)",
  /export const GET/.test(blocksApi) && /export const POST/.test(blocksApi)
  && /export const DELETE/.test(blocksApi) && /status: 409/.test(blocksApi));
const byFollowerApi = codeOnly(readFile("../src/pages/api/blocks/by-follower.ts"));
check("API by-follower POST (followId, sem UUID)",
  /export const POST/.test(byFollowerApi) && /followId/.test(byFollowerApi)
  && !/follower_id|followerId.*uuid|uuid/i.test(byFollowerApi));
const followersMineApi = codeOnly(readFile("../src/pages/api/followers/mine.ts"));
check("API followers/mine GET (401, paginado)",
  /export const GET/.test(followersMineApi) && /status: 401/.test(followersMineApi));
const followersRemoveApi = codeOnly(readFile("../src/pages/api/followers/remove.ts"));
check("API followers/remove POST (sem block)",
  /export const POST/.test(followersRemoveApi) && /removeFollower/.test(followersRemoveApi));
const blockedPage = codeOnly(readFile("../src/pages/perfil/bloqueados.astro"));
check("page bloqueados (SSR, unblock, empty, sem link perfil, sem UUID)",
  /getMyBlockedUsersPage/.test(blockedPage) && /Desbloquear/.test(blockedPage)
  && /Nenhum usuário bloqueado/.test(blockedPage)
  && !/\/u\//.test(blockedPage) && !/blocker_id|blocked_id/i.test(blockedPage));
const followersPage = codeOnly(readFile("../src/pages/perfil/seguidores.astro"));
check("page seguidores (SSR, remover, bloquear, sem UUID)",
  /getMyFollowersPage/.test(followersPage) && /follower-remove/.test(followersPage)
  && /follower-block/.test(followersPage) && !/follower_id/i.test(followersPage));
const publicPage = codeOnly(readFile("../src/pages/u/[username].astro"));
check("perfil público: botão Bloquear (2 cliques, redirect bloqueados)",
  /block-button/.test(publicPage) && /\/api\/blocks/.test(publicPage)
  && /\/perfil\/bloqueados\?notice=blocked/.test(publicPage));
const homePage = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered + sem sessão server-side",
  /export const prerender = true/.test(homePage) && !/getCurrentUser/.test(homePage));
const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome blocks", !/block/i.test(codeOnly(taste)));
const dock = codeOnly(readFile("../src/components/navigation/FloatingDock.astro"));
check("FloatingDock intacta", !/bloque|seguidor/i.test(dock));

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
  const email = `block-${tag}-${stamp}@example.com`;
  const password = `Blocks123!${tag}`;
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

// 4 Auth users: A blocker, B blocked, C terceiro, D isolamento/private.
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
const userA = `blocka${short}`;
const userB = `blockb${short}`;
const userC = `blockc${short}`;
const userD = `blockd${short}`;

// ------------------------------------------------- C. probe migration
let rpcMissing = false;
{
  const probe = await A.client.rpc("get_my_blocked_users", { p_limit: 1, p_offset: 0 });
  rpcMissing = probe.error !== null && /function|does not exist|PGRST|not find|Could not/i.test(
    `${probe.error.message ?? ""} ${probe.error.code ?? ""} ${probe.error.details ?? ""}`,
  );
}
if (rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: block/unblock, gates, followers, paginação, XSS, cascatas");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("RPC blocks acessível", true);

// ------------------------------------------------- D. seed
async function setupProfile(u, { username, displayName, pub, disc = true }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio: null,
    profile_public: pub, show_activity: true, show_favorites: true,
    show_recommendations: true, show_watched: true, show_ratings: true,
    show_reviews: true, discoverable: disc, allow_rating_comments: true,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
await setupProfile(A, { username: userA, displayName: `Bloqueador ${short}`, pub: true });
await setupProfile(B, { username: userB, displayName: `Bloqueado ${short}`, pub: true });
await setupProfile(C, { username: userC, displayName: `Terceiro ${short}`, pub: true });
await setupProfile(D, { username: userD, displayName: `Isolado ${short}`, pub: false });
// Ratings com snapshot (A 901, B 902, C 903).
async function seedRating(u, tmdbId, title) {
  const w = await u.client.from("watched_titles").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: "movie", title,
    poster_path: "/p.jpg", release_year: 2020,
  });
  if (w.error) throw new Error(`watched ${tmdbId} falhou: ${w.error.message}`);
  const rt = await u.client.from("ratings").insert({
    user_id: u.id, tmdb_id: tmdbId, media_type: "movie", rating: 5, review_text: "Boa.",
  });
  if (rt.error) throw new Error(`rating ${tmdbId} falhou: ${rt.error.message}`);
}
await seedRating(A, 901, "Filme A");
await seedRating(B, 902, "Filme B");
await seedRating(C, 903, "Filme C");

const blockByName = (cookie, username) =>
  apiJson("POST", "/api/blocks", cookie, { username });
const unblock = (cookie, blockId) =>
  apiJson("DELETE", "/api/blocks", cookie, { blockId });
const blockedList = (cookie, extra = "") =>
  apiJson("GET", `/api/blocks?page=1&limit=24${extra}`, cookie);
const followersMine = (cookie, extra = "") =>
  apiJson("GET", `/api/followers/mine?page=1&limit=24${extra}`, cookie);
const follow = (cookie, username) =>
  apiJson("POST", "/api/follows", cookie, { username });
const thread = (cookie, username, tmdbId) =>
  apiJson("GET", `/api/ratings/comments?username=${encodeURIComponent(username)}&tmdbId=${tmdbId}&mediaType=movie`, cookie);
const comment = (cookie, username, tmdbId, text) =>
  apiJson("POST", "/api/ratings/comments", cookie, { username, tmdbId, mediaType: "movie", text });
const like = (cookie, username, tmdbId) =>
  apiJson("POST", "/api/ratings/likes", cookie, { username, tmdbId, mediaType: "movie" });
const search = (cookie, q) =>
  apiJson("GET", `/api/public/users/search?q=${encodeURIComponent(q)}`, cookie);

// ------------------------------------------------- D2. canário block
let blocksWork = false;
{
  const can = await blockByName(A.cookie, userB);
  if (can.res.status === 200 && can.json?.blocked === true) {
    const got = await blockedList(A.cookie);
    if ((got.json?.items ?? []).some((i) => i.username === userB)) {
      blocksWork = true;
      check("canário: A bloqueia B (row + lista)", true);
      // desfaz p/ começar os testes do zero
      const bid = (got.json.items ?? []).find((i) => i.username === userB)?.blockId;
      await unblock(A.cookie, bid);
    } else {
      checkd("canário: A bloqueia B (row + lista)", false, "B ausente na lista");
    }
  } else {
    checkd("canário: A bloqueia B (row + lista)", false,
      `status=${can.res.status} body=${can.text.slice(0, 200)} — aplique ${MIGRATION_FILE} no Dashboard`);
  }
}
const needBlocks = (label) => {
  if (!blocksWork) skip(`${label} (canário block falhou)`);
  return blocksWork;
};

// ------------------------------------------------- E. RLS direto
if (needBlocks("RLS")) {
  const anon = createClient(SUPABASE_URL, KEY);
  const anonSel = await anon.from("user_blocks").select("id").limit(5);
  check("anon SELECT user_blocks → nada", (anonSel.data ?? []).length === 0);
  const authSel = await A.client.from("user_blocks").select("id").limit(5);
  check("auth SELECT direto → nada (só via RPC)", (authSel.data ?? []).length === 0);
  const ins = await A.client.from("user_blocks").insert({ blocker_id: A.id, blocked_id: B.id }).select("id");
  checkd("auth INSERT direto → negado", (ins.data ?? []).length === 0 && ins.error !== null,
    `linhas=${(ins.data ?? []).length}`);
  const del = await A.client.from("user_blocks").delete().eq("blocker_id", A.id).select("id");
  check("auth DELETE direto → nada", (del.data ?? []).length === 0);
}

// ------------------------------------------------- F. self + setup relações
if (needBlocks("self/setup")) {
  let r = await blockByName(A.cookie, userA);
  checkd("self-block: erro documentado, sem row",
    (r.res.status === 409 || r.res.status === 400) && (await blockedList(A.cookie)).json?.items?.length === 0,
    `status=${r.res.status}`);
  // A↔B seguem; cross notifications: B segue A (A notif) + A like/comment B (B notifs)
  let f1 = await follow(A.cookie, userB);
  let f2 = await follow(B.cookie, userA);
  checkd("setup follows A↔B", f1.res.status === 200 && f2.res.status === 200,
    `a=${f1.res.status} b=${f2.res.status}`);
  // Like/comment de A em B ANTES do block (fixtures do unlike antigo).
  const setupLike = await like(A.cookie, userB, 902);
  const setupComment = await comment(A.cookie, userB, 902, "A comenta B.");
  checkd("setup like/comment A→B",
    setupLike.res.status === 200 && setupLike.json?.liked === true
    && setupComment.res.status === 200,
    `like=${setupLike.res.status} comment=${setupComment.res.status}`);
  // B comenta C (thread terceira p/ visibilidade)
  const setupRootB = await comment(B.cookie, userC, 903, "B comenta C.");
  checkd("setup root B em C", setupRootB.res.status === 200
    && typeof setupRootB.json?.comment?.commentId === "number",
    `status=${setupRootB.res.status}`);
  // A segue B p/ feed
  r = await apiJson("GET", "/api/feed/following?page=1", A.cookie);
  checkd("setup: feed A tem B", (r.json?.items ?? []).some((i) => i.actor?.username === userB),
    `n=${(r.json?.items ?? []).length}`);
}

// ------------------------------------------------- G. block + cleanup
if (needBlocks("block")) {
  let r = await blockByName(A.cookie, userB);
  checkd("A bloqueia B:200", r.res.status === 200 && r.json?.blocked === true, `status=${r.res.status}`);
  r = await blockedList(A.cookie);
  checkd("1 row (lista tem B, sem UUID)",
    (r.json?.items ?? []).length === 1 && r.json.items[0]?.username === userB
    && typeof r.json.items[0]?.blockId === "number"
    && !containsUuid(r.json, [A.id, B.id]),
    `items=${JSON.stringify(r.json?.items ?? []).slice(0, 200)}`);
  const fAB = await A.client.from("follows").select("id").eq("follower_id", A.id).eq("following_id", B.id);
  const fBA = await A.client.from("follows").select("id").eq("follower_id", B.id).eq("following_id", A.id);
  check("follows A→B removido", (fAB.data ?? []).length === 0);
  check("follows B→A removido", (fBA.data ?? []).length === 0);
  r = await apiJson("GET", "/api/notifications?page=1&limit=24", A.cookie);
  const crossA = (r.json?.items ?? []).filter((i) => i.actor?.username === userB);
  checkd("notifications cross em A zeradas", crossA.length === 0, `n=${crossA.length}`);
  r = await apiJson("GET", "/api/notifications?page=1&limit=24", B.cookie);
  checkd("notifications cross em B zeradas",
    (r.json?.items ?? []).filter((i) => i.actor?.username === userA).length === 0, "");
  r = await apiJson("GET", "/api/notifications/unread-count", A.cookie);
  checkd("unread A coerente", r.res.status === 200, `unread=${r.json?.unreadCount}`);
  // duplicate
  r = await blockByName(A.cookie, userB);
  checkd("duplicate: idempotente, continua 1 row",
    r.res.status === 200 && (await blockedList(A.cookie)).json?.items?.length === 1,
    `status=${r.res.status}`);
}

// ------------------------------------------------- H. perfil/search/content 404 genérico
if (needBlocks("gates perfil/search")) {
  let p = await getPage(`/u/${userB}`, A.cookie);
  checkd("A→B: 404 genérico", p.res.status === 404, `status=${p.res.status}`);
  p = await getPage(`/u/${userA}`, B.cookie);
  checkd("B→A: 404 genérico", p.res.status === 404, `status=${p.res.status}`);
  p = await getPage(`/u/${userA}`, C.cookie);
  checkd("C→A: normal", p.res.status === 200, `status=${p.res.status}`);
  p = await getPage(`/u/${userB}`, null);
  checkd("anon→B: normal (público)", p.res.status === 200, `status=${p.res.status}`);
  let r = await search(A.cookie, userB);
  checkd("A busca B: ausente", !(r.json?.results ?? []).some((x) => x.username === userB), "");
  r = await search(B.cookie, userA);
  checkd("B busca A: ausente", !(r.json?.results ?? []).some((x) => x.username === userA), "");
  r = await search(C.cookie, userB);
  checkd("C encontra B (discoverable)", (r.json?.results ?? []).some((x) => x.username === userB), "");
  // content APIs diretas
  r = await apiJson("GET", `/api/public/profile/${userB}/ratings?page=1&limit=5`, A.cookie);
  check("A ratings B → 404", r.res.status === 404);
  r = await apiJson("GET", `/api/public/profile/${userB}/watched?page=1&limit=5`, A.cookie);
  check("A watched B → 404", r.res.status === 404);
  r = await apiJson("GET", `/api/public/profile/${userB}/followers?page=1&limit=5`, A.cookie);
  check("A followers B → 404", r.res.status === 404);
}

// ------------------------------------------------- I. follow/like/unlike/comment bloqueados
if (needBlocks("interações bloqueadas")) {
  let r = await follow(A.cookie, userB);
  checkd("A follow B → 404 genérico", r.res.status === 404, `status=${r.res.status}`);
  r = await follow(B.cookie, userA);
  checkd("B follow A → 404 genérico", r.res.status === 404, `status=${r.res.status}`);
  r = await like(B.cookie, userA, 901);
  checkd("B like A → 404", r.res.status === 404, `status=${r.res.status}`);
  r = await like(A.cookie, userB, 902);
  checkd("A like B → 404", r.res.status === 404, `status=${r.res.status}`);
  // unlike antigo (A curtiu 902 antes do block) continua funcionando.
  // Contrato real da API (verify:rating-likes): { liked: false, likeCount }.
  r = await apiJson("DELETE", "/api/ratings/likes", A.cookie, { username: userB, tmdbId: 902, mediaType: "movie" });
  checkd("unlike antigo funciona", r.res.status === 200 && r.json?.liked === false
    && Number.isSafeInteger(r.json?.likeCount),
    `status=${r.res.status} body=${r.text.slice(0, 160)}`);
  r = await comment(B.cookie, userA, 901, "Bloqueado?");
  checkd("B comment A → 404", r.res.status === 404, `status=${r.res.status}`);
  r = await comment(A.cookie, userB, 902, "Bloqueado?");
  checkd("A comment B → 404", r.res.status === 404, `status=${r.res.status}`);
}

// ------------------------------------------------- J. thread terceira + counts + replies
if (needBlocks("visibilidade terceira")) {
  // B comentou C (903) antes do block.
  let r = await thread(A.cookie, userC, 903);
  const seenByA = (r.json?.items ?? []).some((i) => i.author?.username === userB);
  checkd("A não vê comment B na thread C", r.res.status === 200 && !seenByA,
    `status=${r.res.status} n=${(r.json?.items ?? []).length}`);
  const countA = r.json?.commentCount;
  r = await thread(C.cookie, userC, 903);
  checkd("C vê B normalmente", (r.json?.items ?? []).some((i) => i.author?.username === userB), "");
  const countC = r.json?.commentCount;
  checkd("count A exclui B; count C inclui",
    typeof countA === "number" && typeof countC === "number" && countC === countA + 1,
    `A=${countA} C=${countC}`);
  r = await thread(null, userC, 903);
  checkd("anon vê B (thread pública)", (r.json?.items ?? []).some((i) => i.author?.username === userB), "");
  // A tenta responder comentário de B na rating de C
  const rootB = (await thread(C.cookie, userC, 903)).json?.items?.find((i) => i.author?.username === userB);
  r = await apiJson("POST", "/api/ratings/comments/replies", A.cookie, { commentId: rootB?.commentId, text: "Direto?" });
  checkd("A responde B (rating C): bloqueado", r.res.status === 404, `status=${r.res.status}`);
  // C responde B (permitido) → reply visibility
  r = await apiJson("POST", "/api/ratings/comments/replies", C.cookie, { commentId: rootB?.commentId, text: "Resposta C." });
  checkd("C responde B:200", r.res.status === 200, `status=${r.res.status}`);
  // reply de C tem autor C (não blocked com A) → A DEVE ver
  const rp2 = await apiJson("GET", `/api/ratings/comments/replies?commentId=${rootB?.commentId}&page=1&limit=10`, A.cookie);
  checkd("A vê reply de C (autor não-blocked)",
    (rp2.json?.items ?? []).some((i) => i.text === "Resposta C."), "");
}

// ------------------------------------------------- K. reply visibility autor blocked + edit próprio
// Fixture VÁLIDA (item 18): D comenta C; B responde D. C comentar a
// própria rating seria self-comment 409 — nunca usar como fixture.
if (needBlocks("reply visibility")) {
  const rc = await comment(D.cookie, userC, 903, "Raiz de D.");
  const rcId = rc.json?.comment?.commentId;
  let setupOk = rc.res.status === 200 && typeof rcId === "number";
  if (!setupOk) {
    checkd("setup root D em C", false, `status=${rc.res.status} body=${rc.text.slice(0, 160)}`);
  }
  let bReplyId = null;
  if (setupOk) {
    const rb = await apiJson("POST", "/api/ratings/comments/replies", B.cookie, { commentId: rcId, text: "Reply de B." });
    setupOk = rb.res.status === 200 && typeof rb.json?.reply?.replyId === "number";
    if (setupOk) {
      bReplyId = rb.json.reply.replyId;
    } else {
      checkd("setup reply B em D", false, `status=${rb.res.status} body=${rb.text.slice(0, 160)}`);
    }
  }
  if (!setupOk) {
    skip("reply visibility/edit (setup reply B falhou)");
  } else {
    let r = await apiJson("GET", `/api/ratings/comments/replies?commentId=${rcId}&page=1&limit=10`, A.cookie);
    checkd("A não vê reply de B", !(r.json?.items ?? []).some((i) => i.text === "Reply de B."), "");
    r = await apiJson("GET", `/api/ratings/comments/replies?commentId=${rcId}&page=1&limit=10`, C.cookie);
    checkd("C vê reply de B", (r.json?.items ?? []).some((i) => i.text === "Reply de B."), "");
    // B edita a própria reply mesmo com A bloqueando (target hidden p/ A, não p/ B)
    r = await apiJson("PATCH", "/api/ratings/comments/replies", B.cookie, { replyId: bReplyId, text: "B editou." });
    checkd("B edita própria reply", r.res.status === 200 && r.json?.text === "B editou.", `status=${r.res.status} body=${r.text.slice(0, 160)}`);
    // Root comment usa a API de comments (não a de replies).
    r = await apiJson("PATCH", "/api/ratings/comments", B.cookie, { commentId: rcId, text: "B hack raiz." });
    checkd("B não edita root de D → 404", r.res.status === 404, `status=${r.res.status} body=${r.text.slice(0, 120)}`);
  }
  // Item 20 — gate parent author: A comenta C; B tenta responder A.
  const rootA = await comment(A.cookie, userC, 903, "Raiz de A em C.");
  if (rootA.res.status === 200 && typeof rootA.json?.comment?.commentId === "number") {
    const rb = await apiJson("POST", "/api/ratings/comments/replies", B.cookie,
      { commentId: rootA.json.comment.commentId, text: "B responde A?" });
    checkd("B responde parent de A (blocked): 404",
      rb.res.status === 404, `status=${rb.res.status} body=${rb.text.slice(0, 120)}`);
  } else {
    checkd("setup root A em C", false, `status=${rootA.res.status}`);
  }
  // Item 21 — gate rating owner: C comenta A (901); B tenta responder.
  const rootC = await comment(C.cookie, userA, 901, "Raiz de C em A.");
  if (rootC.res.status === 200 && typeof rootC.json?.comment?.commentId === "number") {
    const rb = await apiJson("POST", "/api/ratings/comments/replies", B.cookie,
      { commentId: rootC.json.comment.commentId, text: "B responde em A?" });
    checkd("B responde em rating de A (blocked): 404",
      rb.res.status === 404, `status=${rb.res.status} body=${rb.text.slice(0, 120)}`);
  } else {
    checkd("setup root C em A", false, `status=${rootC.res.status}`);
  }
}

// ------------------------------------------------- L. feed + edit próprio comment
if (needBlocks("feed/edit")) {
  const r = await apiJson("GET", "/api/feed/following?page=1", A.cookie);
  checkd("feed A sem B",
    !(r.json?.items ?? []).some((i) => i.actor?.username === userB), `n=${(r.json?.items ?? []).length}`);
  // B edita próprio comentário na rating C (conteúdo não fica preso)
  const mine = (await thread(B.cookie, userC, 903)).json?.items?.find((i) => i.author?.username === userB);
  const e = await apiJson("PATCH", "/api/ratings/comments", B.cookie, { commentId: mine?.commentId, text: "B reeditou." });
  checkd("B edita próprio comment", e.res.status === 200, `status=${e.res.status}`);
}

// ------------------------------------------------- M. blocked list + unblock + mutual
if (needBlocks("lista/unblock/mutual")) {
  let r = await blockedList(A.cookie);
  checkd("A lista tem B (sem UUID)",
    (r.json?.items ?? []).length === 1 && r.json.items[0]?.username === userB
    && !containsUuid(r.json, [A.id, B.id]), "");
  r = await blockedList(B.cookie);
  checkd("B não vê incoming (lista própria vazia)", (r.json?.items ?? []).length === 0, "");
  // B private → continua gerenciável
  await B.client.from("profiles").update({ profile_public: false }).eq("id", B.id);
  r = await blockedList(A.cookie);
  checkd("B private: continua na lista de A", (r.json?.items ?? [])[0]?.username === userB, "");
  await B.client.from("profiles").update({ profile_public: true }).eq("id", B.id);
  // username change → block persiste
  await B.client.from("profiles").update({ username: `${userB}x` }).eq("id", B.id);
  r = await blockedList(A.cookie);
  checkd("username change: block persiste, nome atual",
    (r.json?.items ?? []).length === 1 && (r.json?.items ?? [])[0]?.username === `${userB}x`, "");
  let p = await getPage(`/u/${userB}x`, A.cookie);
  checkd("search oculta mesmo com @novo", p.res.status === 404, `status=${p.res.status}`);
  await B.client.from("profiles").update({ username: userB }).eq("id", B.id);
  // unblock
  const bid = (await blockedList(A.cookie)).json?.items?.[0]?.blockId;
  r = await unblock(A.cookie, bid);
  checkd("unblock: true", r.json?.unblocked === true, `body=${r.text.slice(0, 120)}`);
  p = await getPage(`/u/${userB}`, A.cookie);
  checkd("perfil volta (conforme privacy)", p.res.status === 200, `status=${p.res.status}`);
  r = await apiJson("GET", "/api/feed/following?page=1", A.cookie);
  void r;
  // follows continuam 0 (checado via follow state)
  r = await apiJson("GET", `/api/follows/state?username=${userB}`, A.cookie);
  checkd("follows NÃO voltam", r.json?.following === false, `body=${r.text.slice(0, 120)}`);
  // conteúdo preservado reaparece
  r = await thread(A.cookie, userC, 903);
  checkd("comment B reaparece p/ A", (r.json?.items ?? []).some((i) => i.author?.username === userB), "");
  // mutual: B bloqueia A; A desbloqueia (já desbloqueado → cria de novo p/ teste)
  await blockByName(A.cookie, userB);
  await apiJson("POST", "/api/blocks", B.cookie, { username: userA });
  const bid2 = (await blockedList(A.cookie)).json?.items?.[0]?.blockId;
  await unblock(A.cookie, bid2);
  p = await getPage(`/u/${userB}`, A.cookie);
  checkd("mutual: A remove o seu, B→A persiste → ainda indisponível",
    p.res.status === 404 && !/bloqueou você/i.test((await getPage(`/u/${userB}`, A.cookie)).html),
    `status=${p.res.status}`);
  // B desbloqueia A (limpeza p/ próximos testes)
  const bbid = (await blockedList(B.cookie)).json?.items?.[0]?.blockId;
  await unblock(B.cookie, bbid);
}

// ------------------------------------------------- N. remove follower
if (needBlocks("remove follower")) {
  await follow(C.cookie, userA);
  let r = await followersMine(A.cookie);
  const row = (r.json?.items ?? []).find((i) => i.username === userC);
  checkd("C listado (followId, sem UUID)",
    typeof row?.followId === "number" && !containsUuid(r.json, [A.id, C.id]),
    `row=${JSON.stringify(row ?? null).slice(0, 160)}`);
  const fid = row?.followId;
  r = await apiJson("POST", "/api/followers/remove", A.cookie, { followId: fid });
  checkd("remove: true", r.json?.removed === true, `body=${r.text.slice(0, 120)}`);
  r = await followersMine(A.cookie);
  checkd("C→A zerado", !(r.json?.items ?? []).some((i) => i.username === userC), "");
  // follow notification some; sem block
  r = await apiJson("GET", "/api/notifications?page=1&limit=24", A.cookie);
  checkd("follow notif de C some",
    !(r.json?.items ?? []).some((i) => i.type === "follow" && i.actor?.username === userC), "");
  r = await blockedList(A.cookie);
  checkd("nenhum block criado", (r.json?.items ?? []).length === 0, "");
  // refollow prova remove != block
  r = await follow(C.cookie, userA);
  checkd("C segue de novo:200", r.res.status === 200, `status=${r.res.status}`);
  // isolamento: B tenta remover follow C→A
  const fidC = ((await followersMine(A.cookie)).json?.items ?? []).find((i) => i.username === userC)?.followId;
  r = await apiJson("POST", "/api/followers/remove", B.cookie, { followId: fidC });
  checkd("B remove alheio: nada (404/false)",
    r.res.status === 404 || r.json?.removed === false, `status=${r.res.status} body=${r.text.slice(0, 120)}`);
  r = await followersMine(A.cookie);
  checkd("C→A intacto", (r.json?.items ?? []).some((i) => i.username === userC), "");
}

// ------------------------------------------------- O. private follower + block follower
if (needBlocks("private/block follower")) {
  await D.client.from("profiles").update({ profile_public: false }).eq("id", D.id);
  await follow(D.cookie, userA);
  let r = await followersMine(A.cookie);
  checkd("D private listado na management",
    (r.json?.items ?? []).some((i) => i.username === userD), "");
  // público continua ocultando D (regra existente) — via page followers de A? A é público; lista pública filtra private
  const pub = await apiJson("GET", `/api/public/profile/${userA}/followers?page=1&limit=24`, A.cookie);
  checkd("lista pública oculta D private",
    !(pub.json?.items ?? []).some((i) => i.username === userD), "");
  const fidD = ((await followersMine(A.cookie)).json?.items ?? []).find((i) => i.username === userD)?.followId;
  r = await apiJson("POST", "/api/followers/remove", A.cookie, { followId: fidD });
  checkd("remove D private: true", r.json?.removed === true, "");
  await follow(D.cookie, userA);
  const fidD2 = ((await followersMine(A.cookie)).json?.items ?? []).find((i) => i.username === userD)?.followId;
  r = await apiJson("POST", "/api/blocks/by-follower", A.cookie, { followId: fidD2 });
  checkd("block follower D: row + follow removido",
    r.json?.blocked === true
    && !(await followersMine(A.cookie)).json?.items?.some((i) => i.username === userD),
    `body=${r.text.slice(0, 160)}`);
  r = await blockedList(A.cookie);
  checkd("D na blocked list", (r.json?.items ?? []).some((i) => i.username === userD), "");
  const bidD = (r.json?.items ?? []).find((i) => i.username === userD)?.blockId;
  await unblock(A.cookie, bidD);
}

// ------------------------------------------------- P. XSS + paginação + pages
if (needBlocks("xss/pages")) {
  const xss = `<b>X</b><img src=x onerror=alert(5)>`;
  await B.client.from("profiles").update({ display_name: xss }).eq("id", B.id);
  await follow(C.cookie, userA);
  await blockByName(A.cookie, userB);
  const r = await blockedList(A.cookie);
  checkd("RPC literal (sem strip)",
    (r.json?.items ?? []).some((i) => i.username === userB && i.displayName === xss),
    `items=${JSON.stringify(r.json?.items ?? []).slice(0, 200)}`);
  const p = await getPage("/perfil/seguidores", A.cookie);
  checkd("HTML escapa (sem img cru)",
    p.res.status === 200 && !p.html.includes("<img src=x"), `status=${p.res.status}`);
  // pages: anon → login; auth → 200
  const anonB = await getPage("/perfil/bloqueados", null);
  checkd("bloqueados anon → login", anonB.res.status === 303, `status=${anonB.res.status}`);
  const authB = await getPage("/perfil/bloqueados", A.cookie);
  checkd("bloqueados auth 200 sem UUID",
    authB.res.status === 200 && !containsUuid(authB.html, [A.id, B.id, C.id, D.id]),
    `status=${authB.res.status}`);
  const anonF = await getPage("/perfil/seguidores", null);
  checkd("seguidores anon → login", anonF.res.status === 303, `status=${anonF.res.status}`);
  // paginação: 3 followers + limites
  const pg2 = await apiJson("GET", "/api/followers/mine?page=2&limit=24", A.cookie);
  checkd("page 2 vazia coerente", pg2.res.status === 200 && (pg2.json?.items ?? []).length === 0 && pg2.json?.hasMore === false, "");
  const bad = await apiJson("GET", "/api/followers/mine?page=0&limit=24", A.cookie);
  check("page=0 → 400", bad.res.status === 400);
  const bidX = ((await blockedList(A.cookie)).json?.items ?? []).find((i) => i.username === userB)?.blockId;
  await unblock(A.cookie, bidX);
  await B.client.from("profiles").update({ display_name: `Bloqueado ${short}` }).eq("id", B.id);
}

// ------------------------------------------------- Q. limpeza (sem service_role)
for (const u of [A, B, C, D]) {
  await u.client.from("rating_comments").delete().eq("author_id", u.id);
}
await A.client.from("ratings").delete().eq("user_id", A.id);
await B.client.from("ratings").delete().eq("user_id", B.id);
await C.client.from("ratings").delete().eq("user_id", C.id);
for (const u of [A, B, C, D]) {
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}

console.log("---");
console.log(failures === 0 ? "BLOCKS OK: bloqueio + seguidores + gates confirmados (4 Auth users)." : `BLOCKS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
