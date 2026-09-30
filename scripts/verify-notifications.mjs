/**
 * Verificação da Etapa 21: notificações in-app (follow/like/comment).
 *
 * Pré-requisito: migration supabase/migrations/20261007090000_notifications.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP entram em SKIP identificado (exit 1); contratos
 * de arquivo rodam sempre.
 *
 * Uso: npm run verify:notifications (servidor dev em :4321 p/ parte HTTP).
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e APENAS 4
 * Auth users (A recipient/owner, B actor público, C actor privado,
 * D outro recipient para isolamento).
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

const MIGRATION_FILE = "supabase/migrations/20261007090000_notifications.sql";
const FIX_FILE = "supabase/migrations/20261008090000_fix_comment_notifications.sql";

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

function containsUuid(value, uuids) {
  const text = JSON.stringify(value);
  return uuids.some((u) => typeof u === "string" && u.length > 0 && text.includes(u));
}

// ------------------------------------------------- A. arquivos/migration
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
const migrationCode = codeOnly(migration);
check("migration incremental do fix 42702 existe", existsSync(new URL(`../${FIX_FILE}`, import.meta.url)));
{
  const fix = existsSync(new URL(`../${FIX_FILE}`, import.meta.url)) ? readFile(`../${FIX_FILE}`) : "";
  const fixCode = codeOnly(fix);
  check("fix redefine create sem ON CONFLICT ambíguo (v_comment_id + INSERT direto)",
    /create or replace function public\.create_rating_comment_by_username/i.test(fix)
    && /v_comment_id bigint/.test(fix)
    && !/on conflict \(comment_id\)/i.test(fixCode)
    && /insert into public\.notifications \(recipient_id, actor_id, type, media_type, tmdb_id, comment_id\)/i.test(fix));
  check("migration 21 original também corrigida (instalações futuras)",
    !/on conflict \(comment_id\)/i.test(migrationCode)
    && /v_comment_id bigint/.test(migration));
}
check("tabela notifications (id identity, recipient/actor, type, media/tmdb/comment, timestamps)",
  /create table if not exists public\.notifications/i.test(migration)
  && /id bigint generated always as identity primary key/i.test(migration)
  && /recipient_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /actor_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /comment_id bigint references public\.rating_comments \(id\) on delete cascade/i.test(migration)
  && /created_at timestamptz not null default now\(\)/i.test(migration)
  && /read_at timestamptz null/i.test(migration));
check("checks: 3 tipos + anti-self + shape por tipo + media",
  /check \(type in \('follow', 'rating_like', 'rating_comment'\)\)/i.test(migration)
  && /check \(actor_id <> recipient_id\)/i.test(migration)
  && /notifications_shape_by_type/i.test(migrationCode)
  && /type = 'follow'[\s\S]{0,120}media_type is null and tmdb_id is null and comment_id is null/i.test(migration)
  && /type = 'rating_like'[\s\S]{0,140}media_type is not null and tmdb_id is not null and comment_id is null/i.test(migration)
  && /type = 'rating_comment'[\s\S]{0,160}media_type is not null and tmdb_id is not null and comment_id is not null/i.test(migration));
check("FK composta NA ORDEM da UNIQUE ratings (recipient, media, tmdb)",
  /foreign key \(recipient_id, media_type, tmdb_id\)\s*references public\.ratings \(user_id, media_type, tmdb_id\)\s*on delete cascade/i.test(migration));
check("dedupe: 3 unique partial indexes (follow/like/comment)",
  /create unique index if not exists notifications_unique_follow[\s\S]{0,120}where type = 'follow'/i.test(migration)
  && /create unique index if not exists notifications_unique_like[\s\S]{0,160}where type = 'rating_like'/i.test(migration)
  && /create unique index if not exists notifications_unique_comment[\s\S]{0,120}where type = 'rating_comment'/i.test(migration));
check("índices inbox (recipient created/id DESC + unread parcial)",
  /notifications_recipient_idx[\s\S]{0,120}\(recipient_id, created_at desc, id desc\)/i.test(migration)
  && /notifications_recipient_unread_idx[\s\S]{0,80}\(recipient_id\)[\s\S]{0,40}where read_at is null/i.test(migration));
check("RLS ligada sem policies (nenhum acesso direto)",
  /alter table public\.notifications enable row level security/i.test(migration)
  && !/create policy/i.test(migrationCode));
check("5 RPCs de origem redefinidas (follow/unfollow/like/unlike/comment)",
  /create or replace function public\.follow_user_by_username\(/i.test(migration)
  && /create or replace function public\.unfollow_user_by_username\(/i.test(migration)
  && /create or replace function public\.like_rating_by_username\(/i.test(migration)
  && /create or replace function public\.unlike_rating_by_username\(/i.test(migration)
  && /create or replace function public\.create_rating_comment_by_username\(/i.test(migration));
check("origem preserva idempotência + cria notification só quando novo",
  /on conflict on constraint follows_unique_pair do nothing/i.test(migration)
  && /on conflict on constraint rating_likes_unique_like do nothing/i.test(migration)
  && /get diagnostics v_new = row_count/i.test(migration)
  && /if v_new > 0 then/i.test(migration));
check("unfollow/unlike removem a notification (sem evento de undo)",
  /delete from public\.notifications[\s\S]{0,200}type = 'follow'/i.test(migration)
  && /delete from public\.notifications[\s\S]{0,260}type = 'rating_like'/i.test(migration));
check("4 RPCs de inbox (list/unread/read/read-all)",
  /function public\.get_my_notifications\(\s*integer\s*,\s*integer\s*\)/i.test(migration)
  && /function public\.get_my_notification_unread_count\(\)/i.test(migration)
  && /function public\.mark_my_notifications_read\(\s*bigint\[\]\s*\)/i.test(migration)
  && /function public\.mark_all_my_notifications_read\(\)/i.test(migration));
check("RPCs: SD + search_path fixo + VOLATILE nas writes + STABLE nas reads",
  (migration.match(/security definer/gi) || []).length >= 9
  && (migration.match(/set search_path = public/gi) || []).length >= 9
  && /function public\.mark_my_notifications_read[\s\S]{0,400}language plpgsql\s+volatile/i.test(migration)
  && /function public\.mark_all_my_notifications_read[\s\S]{0,400}language plpgsql\s+volatile/i.test(migration)
  && /function public\.get_my_notifications[\s\S]{0,600}language sql\s+stable/i.test(migration)
  && /function public\.get_my_notification_unread_count[\s\S]{0,300}language sql\s+stable/i.test(migration)
  && !/execute\s+format|execute\s+['"]select/i.test(migration));
check("inbox: actor dinâmico + title via watched + comment atual (sem TMDB)",
  /case when ap\.profile_public is true then ap\.display_name else null end/i.test(migration)
  && /left join public\.watched_titles as w/i.test(migration)
  && /left join public\.rating_comments as c/i.test(migration)
  && !/tmdb.*http|http.*tmdb|themoviedb/i.test(migrationCode));
check("grants: 4 inbox só authenticated (anon nada), tabela sem grants",
  /grant execute on function public\.get_my_notifications\(integer, integer\) to authenticated/i.test(migration)
  && /grant execute on function public\.get_my_notification_unread_count\(\) to authenticated/i.test(migration)
  && /grant execute on function public\.mark_my_notifications_read\(bigint\[\]\) to authenticated/i.test(migration)
  && /grant execute on function public\.mark_all_my_notifications_read\(\) to authenticated/i.test(migration)
  && (migration.match(/revoke all on function public\./gi) || []).length >= 4
  && !/to anon/i.test(migrationCode));
check("sem realtime/push/triggers/taste/feed-event",
  !/create trigger/i.test(migrationCode)
  && !/realtime|pg_notify|push|websocket/i.test(migrationCode)
  && !/taste/i.test(migrationCode)
  && !/notif/i.test(migrationCode.replace(/notifications?/gi, "")));

const notifTypes = codeOnly(readFile("../src/lib/notifications/types.ts"));
check("lib types (3 tipos, page 24, mark 24, sem UUID)",
  /NotificationType/.test(notifTypes) && /NOTIFICATION_PAGE_SIZE = 24/.test(notifTypes)
  && /NOTIFICATION_MARK_READ_MAX = 24/.test(notifTypes)
  && /NotificationItem/.test(notifTypes)
  && !/user_id|recipient_id|actor_id|email/i.test(notifTypes));
const notifValidation = codeOnly(readFile("../src/lib/notifications/validation.ts"));
check("lib validation (ids 1..24 + dedupe + page)",
  /validateNotificationIds/.test(notifValidation) && /validateNotificationPage/.test(notifValidation));
const notifService = codeOnly(readFile("../src/lib/notifications/service.ts"));
check("lib service (4 RPCs, sem .from notifications, sem UUID)",
  /get_my_notifications/.test(notifService)
  && /get_my_notification_unread_count/.test(notifService)
  && /mark_my_notifications_read/.test(notifService)
  && /mark_all_my_notifications_read/.test(notifService)
  && !/from\("notifications"\)|from\('notifications'\)/.test(notifService)
  && !/recipient_id|actor_id/i.test(notifService));
const notifApi = codeOnly(readFile("../src/pages/api/notifications.ts"));
check("API list GET (401/400/502, sem marcar lida)",
  /export const GET/.test(notifApi) && /status: 401/.test(notifApi) && /status: 400/.test(notifApi));
const notifUnread = codeOnly(readFile("../src/pages/api/notifications/unread-count.ts"));
check("API unread GET (401, { unreadCount })",
  /export const GET/.test(notifUnread) && /unreadCount/.test(notifUnread));
const notifRead = codeOnly(readFile("../src/pages/api/notifications/read.ts"));
check("API read POST (400 validação, notificationIds → service)",
  /export const POST/.test(notifRead) && /notificationIds/.test(notifRead)
  && /markMyNotificationsRead/.test(notifRead) && /status: 400/.test(notifRead));
const notifReadAll = codeOnly(readFile("../src/pages/api/notifications/read-all.ts"));
check("API read-all POST (401, service sem body)",
  /export const POST/.test(notifReadAll) && /markAllMyNotificationsRead/.test(notifReadAll)
  && /status: 401/.test(notifReadAll));
const bell = codeOnly(readFile("../src/components/notifications/NotificationsBell.astro"));
check("Bell (48px, aria-label, badge 99+, evento, sem dropdown)",
  /min-h-12 min-w-12/.test(bell) && /aria-label/.test(bell)
  && /99\+/.test(bell) && /cinevee:notifications-updated/.test(bell)
  && /\/notificacoes/.test(bell) && !/dropdown/i.test(bell));
const dock = codeOnly(readFile("../src/components/navigation/FloatingDock.astro"));
check("FloatingDock intacta (sem sino/quinta opção)",
  !/notification|bell|sino/i.test(dock));
const notifPage = codeOnly(readFile("../src/pages/notificacoes.astro"));
check("página /notificacoes (SSR p1, mark-all, load-more, empty, error, sem UUID)",
  /getMyNotificationsPage/.test(notifPage) && /notifications-mark-all/.test(notifPage)
  && /notifications-more/.test(notifPage) && /Nenhuma notificação ainda/.test(notifPage)
  && /Tentar novamente/.test(notifPage) && !/user_id|recipient_id|actor_id|email/i.test(notifPage));
const notifCard = codeOnly(readFile("../src/components/notifications/NotificationCard.astro"));
check("NotificationCard (unread sutil, links, time, sem innerHTML)",
  /data-unread/.test(notifCard) && /<time/.test(notifCard)
  && !/innerHTML/.test(notifCard) && !/set:html/.test(notifCard));
check("NotificationCard: aria sem texto de usuário (labels estáticos)",
  !/aria-label=\{`[^`]*\$\{/.test(notifCard));
const homePage = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered + sem sessão server-side (sino é client)",
  /export const prerender = true/.test(homePage) && !/getCurrentUser/.test(homePage));
const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome notifications",
  !/notification/i.test(codeOnly(taste)));

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
  const email = `notif-${tag}-${stamp}@example.com`;
  const password = `Notifications123!${tag}`;
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

// 4 Auth users: A recipient/owner, B actor público, C actor privado, D outro recipient.
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
const userA = `notifa${short}`;
const userB = `notifb${short}`;
const userC = `notifc${short}`;
const userD = `notifd${short}`;

// ------------------------------------------------- C. probe migration
let rpcMissing = false;
{
  const probe = await A.client.rpc("get_my_notification_unread_count");
  rpcMissing = probe.error !== null && /function|does not exist|PGRST|not find|Could not/i.test(
    `${probe.error.message ?? ""} ${probe.error.code ?? ""} ${probe.error.details ?? ""}`,
  );
}
if (rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: lifecycle follow/like/comment, privacidade, read, paginação, bell, page");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("RPC inbox acessível", true);

// ------------------------------------------------- D. seed
async function setupProfile(u, { username, displayName, pub }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio: null,
    profile_public: pub, show_activity: false, show_favorites: false,
    show_recommendations: false, show_watched: false, show_ratings: true,
    show_reviews: true, discoverable: false, allow_rating_comments: true,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
await setupProfile(A, { username: userA, displayName: `Recipiente ${short}`, pub: true });
await setupProfile(B, { username: userB, displayName: `Ator Público ${short}`, pub: true });
await setupProfile(C, { username: userC, displayName: `Ator Privado ${short}`, pub: false });
await setupProfile(D, { username: userD, displayName: `Outro ${short}`, pub: true });
// A: rating pública com snapshot (601).
await A.client.from("watched_titles").insert({
  user_id: A.id, tmdb_id: 601, media_type: "movie", title: "Filme Inbox",
  poster_path: "/inbox.jpg", release_year: 2023,
});
await A.client.from("ratings").insert({
  user_id: A.id, tmdb_id: 601, media_type: "movie", rating: 5, review_text: "Ótimo.",
});

const list = (cookie, extra = "") =>
  apiJson("GET", `/api/notifications?page=1&limit=24${extra}`, cookie);
const unread = (cookie) => apiJson("GET", "/api/notifications/unread-count", cookie);
const markRead = (cookie, ids) =>
  apiJson("POST", "/api/notifications/read", cookie, { notificationIds: ids });
const markAll = (cookie) => apiJson("POST", "/api/notifications/read-all", cookie, {});
const follow = (cookie, username) =>
  apiJson("POST", "/api/follows", cookie, { username });
const unfollow = (cookie, username) =>
  apiJson("DELETE", "/api/follows", cookie, { username });
const like = (cookie, username, tmdbId) =>
  apiJson("POST", "/api/ratings/likes", cookie, { username, tmdbId, mediaType: "movie" });
const unlike = (cookie, username, tmdbId) =>
  apiJson("DELETE", "/api/ratings/likes", cookie, { username, tmdbId, mediaType: "movie" });
const comment = (cookie, username, tmdbId, text) =>
  apiJson("POST", "/api/ratings/comments", cookie, { username, tmdbId, mediaType: "movie", text });

// ------------------------------------------------- D2. canário comment→notification
// Se este canário falhar (ex.: 500/42702), as seções de comentário (H, O
// e trechos de I/N/P) entram em SKIP em vez de cascata opaca. Aplicar:
// supabase/migrations/20261008090000_fix_comment_notifications.sql
let commentWorks = false;
{
  const can = await comment(B.cookie, userA, 601, "Canário.");
  const canId = can.json?.comment?.commentId;
  if (can.res.status === 200 && typeof canId === "number") {
    const got = await list(A.cookie);
    const found = (got.json?.items ?? []).find(
      (i) => i.type === "rating_comment" && i.commentText === "Canário.");
    const un = await unread(A.cookie);
    if (found && (un.json?.unreadCount ?? 0) >= 1) {
      commentWorks = true;
      check("canário: comment cria row + notification + unread", true);
      await apiJson("DELETE", "/api/ratings/comments", B.cookie, { commentId: canId });
    } else {
      checkd("canário: comment cria row + notification + unread", false,
        `notification ausente — aplique ${FIX_FILE} no Dashboard (SQL Editor → Run)`);
    }
  } else {
    checkd("canário: comment cria row + notification + unread", false,
      `status=${can.res.status} body=${can.text.slice(0, 200)} — se 500/42702, aplique ${FIX_FILE} no Dashboard`);
  }
}

// ------------------------------------------------- E. RLS direto bloqueado
const anon = createClient(SUPABASE_URL, KEY);
const anonSel = await anon.from("notifications").select("id").limit(5);
check("anon SELECT notifications → nada", (anonSel.data ?? []).length === 0);
const authSel = await A.client.from("notifications").select("id").limit(5);
check("auth SELECT direto → nada (só via RPC)", (authSel.data ?? []).length === 0);

// ------------------------------------------------- F. follow lifecycle
let r = await follow(B.cookie, userA);
checkd("B segue A:200", r.res.status === 200, `status=${r.res.status}`);
r = await unread(A.cookie);
checkd("1 unread follow", r.res.status === 200 && r.json?.unreadCount === 1, `body=${r.text.slice(0, 120)}`);
r = await list(A.cookie);
{
  const item = r.json?.items?.[0];
  checkd("item follow: actor B público + sem UUID",
    r.json?.items?.length === 1 && item?.type === "follow"
    && item?.actor?.username === userB && item?.actor?.isPrivate === false
    && typeof item?.actor?.displayName === "string"
    && item?.title === null && item?.commentText === null
    && item?.isRead === false && typeof item?.notificationId === "number"
    && !containsUuid(r.json, [A.id, B.id]) && !containsKeyStartingWith(r.json, "recipient_id")
    && !containsKeyStartingWith(r.json, "actor_id"),
    `item=${JSON.stringify(item ?? null).slice(0, 260)}`);
}
r = await follow(B.cookie, userA);
checkd("duplicate follow: continua 1 (sem duplicata)", r.res.status === 200
  && (await unread(A.cookie)).json?.unreadCount === 1, `status=${r.res.status}`);
r = await unfollow(B.cookie, userA);
checkd("unfollow: notification some", r.res.status === 200
  && (await unread(A.cookie)).json?.unreadCount === 0
  && (await list(A.cookie)).json?.items?.length === 0, `status=${r.res.status}`);
r = await follow(B.cookie, userA);
checkd("refollow: nova notification unread", r.res.status === 200
  && (await unread(A.cookie)).json?.unreadCount === 1, `status=${r.res.status}`);

// ------------------------------------------------- G. like lifecycle (+feed intacto)
async function feedOrder(cookie) {
  const res = await fetch(`${BASE}/api/feed/following?page=1`, {
    redirect: "manual", headers: cookie ? { Cookie: cookie } : {},
  });
  const json = await res.json().catch(() => null);
  return (json?.items ?? []).map((i) => i.eventKey).join(",");
}
r = await like(B.cookie, userA, 601);
checkd("B like:200", r.res.status === 200, `status=${r.res.status} body=${r.text.slice(0, 120)}`);
r = await unread(A.cookie);
checkd("like gera unread (total 2)", r.json?.unreadCount === 2, `body=${r.text.slice(0, 120)}`);
r = await list(A.cookie);
{
  const item = (r.json?.items ?? []).find((i) => i.type === "rating_like");
  checkd("item like: title snapshot + actor B",
    item?.title?.tmdbId === 601 && item?.title?.mediaType === "movie"
    && item?.title?.title === "Filme Inbox" && item?.actor?.username === userB
    && !containsUuid(r.json, [A.id, B.id]),
    `item=${JSON.stringify(item ?? null).slice(0, 260)}`);
}
const beforeFeed = await feedOrder(B.cookie);
r = await like(B.cookie, userA, 601);
checkd("duplicate like: sem duplicata", r.res.status === 200
  && (await unread(A.cookie)).json?.unreadCount === 2, `status=${r.res.status}`);
check("like não reordena feed", (await feedOrder(B.cookie)) === beforeFeed);
r = await unlike(B.cookie, userA, 601);
checkd("unlike: notification some", r.res.status === 200
  && (await unread(A.cookie)).json?.unreadCount === 1, `status=${r.res.status}`);
r = await like(B.cookie, userA, 601);
checkd("relike: nova unread", r.res.status === 200
  && (await unread(A.cookie)).json?.unreadCount === 2, `status=${r.res.status}`);

// ------------------------------------------------- H. comment lifecycle
if (!commentWorks) {
  skip("H comment lifecycle (canário comment falhou)");
} else {
  r = await comment(B.cookie, userA, 601, "Adorei sua análise.");
  checkd("B comenta:200", r.res.status === 200, `status=${r.res.status}`);
  const commentId = r.json?.comment?.commentId;
  r = await unread(A.cookie);
  checkd("comment gera unread (total 3)", r.json?.unreadCount === 3, `body=${r.text.slice(0, 120)}`);
  r = await list(A.cookie);
  {
    const item = (r.json?.items ?? []).find((i) => i.type === "rating_comment");
    checkd("item comment: preview + ids",
      item?.commentText === "Adorei sua análise." && item?.title?.tmdbId === 601
      && item?.actor?.username === userB && typeof item?.createdAt === "string"
      && item?.readAt === null && !containsUuid(r.json, [A.id, B.id]),
      `item=${JSON.stringify(item ?? null).slice(0, 260)}`);
    var commentNotifId = item?.notificationId;
  }
  // Marca como lida, depois edita: mesma row, texto novo, read preservado.
  r = await markRead(A.cookie, [commentNotifId]);
  checkd("mark 1 comment: marked 1, unread 2", r.json?.markedCount === 1 && r.json?.unreadCount === 2,
    `body=${r.text.slice(0, 120)}`);
  r = await apiJson("PATCH", "/api/ratings/comments", B.cookie, { commentId, text: "Editado: ainda melhor." });
  checkd("edit comment:200", r.res.status === 200, `status=${r.res.status}`);
  r = await list(A.cookie);
  {
    const item = (r.json?.items ?? []).find((i) => i.type === "rating_comment");
    checkd("edit: mesma notification, texto novo, read preservado",
      item?.notificationId === commentNotifId && item?.commentText === "Editado: ainda melhor."
      && item?.isRead === true && typeof item?.readAt === "string",
      `item=${JSON.stringify(item ?? null).slice(0, 260)}`);
  }
  checkd("edit não cria nova (unread segue 2)", (await unread(A.cookie)).json?.unreadCount === 2, "");
  r = await apiJson("DELETE", "/api/ratings/comments", B.cookie, { commentId });
  checkd("delete comment:200", r.res.status === 200, `status=${r.res.status}`);
  checkd("delete comment: notification some (cascade)",
    (await list(A.cookie)).json?.items?.every((i) => i.type !== "rating_comment") === true, "");
}

// ------------------------------------------------- I. actor privado C
r = await follow(C.cookie, userA);
checkd("C privado segue A:200", r.res.status === 200, `status=${r.res.status}`);
r = await like(C.cookie, userA, 601);
checkd("C privado like:200", r.res.status === 200, `status=${r.res.status}`);
if (!commentWorks) {
  skip("C privado comenta (canário comment falhou)");
} else {
  r = await comment(C.cookie, userA, 601, "Privado comenta.");
  checkd("C privado comenta:200", r.res.status === 200, `status=${r.res.status}`);
}
r = await list(A.cookie);
{
  const mine = (r.json?.items ?? []).filter((i) => i.actor?.username === null || i.actor?.isPrivate === true);
  const privates = (r.json?.items ?? []).filter((i) => i.actor?.isPrivate === true);
  checkd("inbox anonimiza C (sem username/avatar/UUID)",
    privates.length >= (commentWorks ? 3 : 2) && mine.length === privates.length
    && privates.every((i) => i.actor?.username === null && i.actor?.avatarUrl === null
      && i.actor?.displayName === null)
    && !containsUuid(r.json, [C.id]) && !containsKeyStartingWith(r.json, "author_id"),
    `n=${(r.json?.items ?? []).length} priv=${privates.length}`);
}
await C.client.from("profiles").update({ profile_public: true }).eq("id", C.id);
r = await list(A.cookie);
checkd("C público: identidade aparece (dinâmico)",
  (r.json?.items ?? []).some((i) => i.actor?.username === userC), "");
await C.client.from("profiles").update({ profile_public: false }).eq("id", C.id);
r = await list(A.cookie);
checkd("C privado de novo: anonimiza de novo",
  !(r.json?.items ?? []).some((i) => i.actor?.username === userC)
  && (r.json?.items ?? []).some((i) => i.actor?.isPrivate === true), "");

// ------------------------------------------------- J. discoverable irrelevante
await B.client.from("profiles").update({ discoverable: false }).eq("id", B.id);
r = await list(A.cookie);
checkd("B discoverable=false: identidade continua na inbox",
  (r.json?.items ?? []).some((i) => i.actor?.username === userB
    && (i.type === "follow" || i.type === "rating_like")), "");
await B.client.from("profiles").update({ discoverable: true }).eq("id", B.id);

// ------------------------------------------------- K. recipient priva depois
await A.client.from("profiles").update({ profile_public: false }).eq("id", A.id);
r = await list(A.cookie);
checkd("A privado: própria inbox continua visível",
  r.res.status === 200 && (r.json?.items ?? []).length > 0, `n=${(r.json?.items ?? []).length}`);
await A.client.from("profiles").update({ profile_public: true, show_ratings: false }).eq("id", A.id);
r = await list(A.cookie);
checkd("A show_ratings=false: inbox continua (sem gate público)",
  r.res.status === 200 && (r.json?.items ?? []).length > 0, "");
await A.client.from("profiles").update({ show_ratings: true }).eq("id", A.id);

// ------------------------------------------------- L. read (3 unread → mark 2 → 1)
r = await unread(A.cookie);
const beforeIds = (await list(A.cookie)).json?.items ?? [];
const three = beforeIds.filter((i) => i.isRead === false).slice(0, 3).map((i) => i.notificationId);
checkd("há ≥3 unread para o teste de read", three.length >= 3, `n=${three.length}`);
r = await markRead(A.cookie, three.slice(0, 2));
checkd("mark 2: unread cai", r.json?.markedCount === 2, `body=${r.text.slice(0, 120)}`);
const afterMark = await unread(A.cookie);
const expectedAfter = Math.max(0, (await list(A.cookie)).json?.items?.filter((i) => !i.isRead).length ?? -1);
checkd("unread consistente com a lista", afterMark.json?.unreadCount === expectedAfter, `unread=${afterMark.json?.unreadCount} lista=${expectedAfter}`);
r = await markRead(A.cookie, three.slice(0, 2));
checkd("mark os mesmos: 0 novos (idempotente)", r.json?.markedCount === 0, `body=${r.text.slice(0, 120)}`);
r = await markRead(D.cookie, three.slice(0, 2));
checkd("D tenta ids de A: nada alterado", r.json?.markedCount === 0, `body=${r.text.slice(0, 120)}`);
r = await markAll(A.cookie);
checkd("mark all: 0 unread", r.json?.unreadCount === 0, `body=${r.text.slice(0, 120)}`);
checkd("mark all zerou de verdade", (await unread(A.cookie)).json?.unreadCount === 0, "");
// Validação do body.
r = await apiJson("POST", "/api/notifications/read", A.cookie, { notificationIds: "x" });
check("read body inválido → 400", r.res.status === 400);
r = await apiJson("POST", "/api/notifications/read", A.cookie, { notificationIds: Array.from({ length: 25 }, (_, i) => i + 1) });
check("read >24 ids → 400", r.res.status === 400);
r = await apiJson("POST", "/api/notifications/read", null, { notificationIds: [1] });
check("read deslogado → 401", r.res.status === 401);
r = await apiJson("POST", "/api/notifications/read-all", null, {});
check("read-all deslogado → 401", r.res.status === 401);
r = await apiJson("GET", "/api/notifications/unread-count", null);
check("unread deslogado → 401", r.res.status === 401);

// ------------------------------------------------- M. sem notifications falsas
r = await unread(A.cookie);
const baseUnread = r.json?.unreadCount ?? -1;
await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 602, media_type: "movie", kind: "favorite",
  title: "Fav", poster_path: "/p.jpg", release_year: 2020, note: null,
});
await B.client.from("watched_titles").insert({
  user_id: B.id, tmdb_id: 603, media_type: "movie", title: "W",
  poster_path: "/p.jpg", release_year: 2021,
});
await apiJson("PATCH", "/api/profile/privacy", A.cookie, {
  profilePublic: true, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: true, showReviews: true, discoverable: false,
  showActivity: false, allowRatingComments: true,
});
r = await unread(A.cookie);
checkd("favorite/watched/privacy-toggle não criam notification",
  r.json?.unreadCount === baseUnread, `antes=${baseUnread} depois=${r.json?.unreadCount}`);

// ------------------------------------------------- N. XSS
const xssName = `<script>alert(1)</scr` + `ipt><img src=x onerror=alert(1)>`;
await B.client.from("profiles").update({ display_name: xssName }).eq("id", B.id);
const xss = `XSS <img src=x onerror=alert(2)> "aspas"`;
if (!commentWorks) {
  skip("XSS via comment (canário comment falhou)");
} else {
  r = await comment(B.cookie, userA, 601, xss);
  checkd("comment XSS: armazenado literal", r.res.status === 200 && r.json?.comment?.text === xss,
    `status=${r.res.status}`);
  r = await list(A.cookie);
  {
    const item = (r.json?.items ?? []).find((i) => i.type === "rating_comment" && i.actor?.username === userB);
    checkd("RPC devolve literal (sem strip)",
      item?.commentText === xss && item?.actor?.displayName === xssName,
      `item=${JSON.stringify(item ?? null).slice(0, 200)}`);
  }
}
{
  const p = await getPage(`/notificacoes`, A.cookie);
  checkd("HTML escapa payload (sem XSS executável)",
    p.res.status === 200 && !p.html.includes("<script>alert(1)") && !p.html.includes("<img src=x"),
    `status=${p.res.status}`);
}
await B.client.from("profiles").update({ display_name: `Ator Público ${short}` }).eq("id", B.id);

// ------------------------------------------------- O. paginação 24/25/49
// Completa até EXATAMENTE 49 notifications (comments de B na rating 601
// — poucos users, sem 49 Auth users). Depois: 24+true / 24+true / 1+false.
const pageOf = (cookie, page, limit) =>
  apiJson("GET", `/api/notifications?page=${page}&limit=${limit}`, cookie);
async function totalCount(cookie) {
  let total = 0;
  for (let pg = 1; pg <= 10; pg += 1) {
    const p = await pageOf(cookie, pg, 24);
    if (p.res.status !== 200) return -1;
    total += (p.json?.items ?? []).length;
    if (p.json?.hasMore !== true) break;
  }
  return total;
}
if (!commentWorks) {
  skip("O paginação 49 via comments (canário comment falhou)");
} else {
  const have = await totalCount(A.cookie);
  checkd("contagem base legível", have >= 0, `total=${have}`);
  const need = 49 - have;
  let seeded = true;
  for (let i = 0; i < need; i += 1) {
    const rr = await comment(B.cookie, userA, 601, `Paginado ${i + 1} de ${need}.`);
    if (rr.res.status !== 200) {
      checkd(`seed paginação ${i + 1}/${need}`, false, `status=${rr.res.status} body=${rr.text.slice(0, 120)}`);
      seeded = false;
      break;
    }
  }
  if (!seeded || (await totalCount(A.cookie)) !== 49) {
    check("paginação 49 (bloqueada: seed incompleto)", false);
  } else {
    const p1 = await pageOf(A.cookie, 1, 24);
    const p2 = await pageOf(A.cookie, 2, 24);
    const p3 = await pageOf(A.cookie, 3, 24);
    const allItems = [...(p1.json?.items ?? []), ...(p2.json?.items ?? []), ...(p3.json?.items ?? [])];
    const ids = allItems.map((i) => i.notificationId);
    const times = allItems.map((i) => i.createdAt);
    const ordered = times.every((t, i) => i === 0 || times[i - 1] >= t);
    checkd("49: 24+true / 24+true / 1+false, sem duplicatas, ordem DESC",
      p1.json?.items?.length === 24 && p1.json?.hasMore === true
      && p2.json?.items?.length === 24 && p2.json?.hasMore === true
      && p3.json?.items?.length === 1 && p3.json?.hasMore === false
      && new Set(ids).size === 49 && ordered,
      `ns=${p1.json?.items?.length}/${p2.json?.items?.length}/${p3.json?.items?.length} mores=${p1.json?.hasMore}/${p2.json?.hasMore}/${p3.json?.hasMore} únicos=${new Set(ids).size}`);
    const bad = await apiJson("GET", "/api/notifications?page=0&limit=24", A.cookie);
    check("page=0 → 400", bad.res.status === 400);
    const over = await apiJson("GET", "/api/notifications?page=1&limit=25", A.cookie);
    check("limit=25 → 400", over.res.status === 400);
  }
}

// ------------------------------------------------- P. cascatas fonte
// Rating 602 de A para o teste watched→rating→notifications.
await A.client.from("watched_titles").insert({
  user_id: A.id, tmdb_id: 602, media_type: "movie", title: "Cascata",
  poster_path: "/p.jpg", release_year: 2022,
});
await A.client.from("ratings").insert({
  user_id: A.id, tmdb_id: 602, media_type: "movie", rating: 4, review_text: null,
});
await like(B.cookie, userA, 602);
if (commentWorks) {
  await comment(B.cookie, userA, 602, "Na cascata.");
} else {
  skip("comment em 602 (canário comment falhou; cascade via like)");
}
{
  const has602 = ((await list(A.cookie)).json?.items ?? []).some(
    (i) => i.title?.tmdbId === 602);
  checkd("like+comment em 602 geram notifications", has602, "");
}
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 602);
{
  const left = ((await list(A.cookie)).json?.items ?? []).filter((i) => i.title?.tmdbId === 602);
  checkd("unwatch: rating cascade → notifications somem", left.length === 0, `restam=${left.length}`);
}
// Rating delete direto remove like/comment de 601? Não — 601 segue viva;
// deleta a rating 601 e confere cascade total das restantes.
await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", 601);
{
  const left = ((await list(A.cookie)).json?.items ?? []).filter(
    (i) => i.title?.tmdbId === 601 && i.type !== "follow");
  checkd("delete rating: like/comment somem (follow fica)", left.length === 0, `restam=${left.length}`);
}

// ------------------------------------------------- Q. page + bell HTTP
{
  const anonPage = await getPage("/notificacoes", null);
  checkd("page deslogado → login next",
    anonPage.res.status === 303 && (anonPage.res.headers.get("location") || "").includes("/entrar"),
    `status=${anonPage.res.status}`);
  const authPage = await getPage("/notificacoes", A.cookie);
  checkd("page logado SSR (cards + mark-all + sem UUID/email)",
    authPage.res.status === 200 && /notifications-list/.test(authPage.html)
    && !new RegExp(A.id).test(authPage.html) && !/notif-.*@example\.com/.test(authPage.html),
    `status=${authPage.res.status}`);
  const homeAnon = await getPage("/", null);
  checkd("Home anon: sino oculto, sem badge",
    homeAnon.res.status === 200 && /notifications-bell/.test(homeAnon.html)
    && !/notifications-badge"[^>]*>[0-9]/.test(homeAnon.html),
    `status=${homeAnon.res.status}`);
  r = await unread(A.cookie);
  checkd("bell API: unread-count responde", r.res.status === 200 && typeof r.json?.unreadCount === "number",
    `body=${r.text.slice(0, 120)}`);
}

// ------------------------------------------------- R. limpeza (sem service_role)
// Unfollows via API removem as follow notifications; o resto cascateia
// (comment/rating/watched) ou é deletado direto.
await unfollow(B.cookie, userA);
await unfollow(C.cookie, userA);
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

console.log("---");
console.log(failures === 0 ? "NOTIFICATIONS OK: inbox + lifecycle + privacidade confirmados (4 Auth users)." : `NOTIFICATIONS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
