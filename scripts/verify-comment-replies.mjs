/**
 * Verificação da Etapa 22: respostas em comentários (1 nível) +
 * notification comment_reply + bugfix do pôster em /notificacoes.
 *
 * Pré-requisito: migration supabase/migrations/20261009090000_rating_comment_replies.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP entram em SKIP identificado (exit 1); contratos
 * de arquivo rodam sempre.
 *
 * Uso: npm run verify:comment-replies (servidor dev em :4321 p/ parte HTTP).
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e APENAS 4
 * Auth users (A rating owner, B comentário raiz, C terceiro/private,
 * D isolamento).
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

const MIGRATION_FILE = "supabase/migrations/20261009090000_rating_comment_replies.sql";

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
check("migration Etapa 22 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
const migrationCode = codeOnly(migration);
check("tabela replies (id identity, comment FK cascade, author FK cascade, texto 1..500)",
  /create table if not exists public\.rating_comment_replies/i.test(migration)
  && /id bigint generated always as identity primary key/i.test(migration)
  && /comment_id bigint not null references public\.rating_comments \(id\) on delete cascade/i.test(migration)
  && /author_id uuid not null references auth\.users \(id\) on delete cascade/i.test(migration)
  && /reply_text text not null/i.test(migration)
  && /check \(char_length\(reply_text\) >= 1 and char_length\(reply_text\) <= 500\)/i.test(migration));
check("índice thread cronológica (comment, created ASC, id ASC)",
  /rating_comment_replies_thread_idx[\s\S]{0,120}\(comment_id, created_at asc, id asc\)/i.test(migration));
check("RLS sem policies (sem acesso direto)",
  /alter table public\.rating_comment_replies enable row level security/i.test(migration)
  && (migrationCode.match(/create policy/gi) || []).length === 0);
check("4 RPCs de reply (list/create/update/delete)",
  /function public\.get_public_rating_comment_replies\(\s*bigint\s*,\s*integer\s*,\s*integer\s*\)/i.test(migration)
  && /function public\.create_rating_comment_reply\(\s*bigint\s*,\s*text\s*\)/i.test(migration)
  && /function public\.update_rating_comment_reply\(\s*bigint\s*,\s*text\s*\)/i.test(migration)
  && /function public\.delete_rating_comment_reply\(\s*bigint\s*\)/i.test(migration));
check("RPCs: SD + search_path + VOLATILE writes + STABLE read + sem ambiguidade",
  (migration.match(/security definer/gi) || []).length >= 5
  && (migration.match(/set search_path = public/gi) || []).length >= 5
  && /function public\.create_rating_comment_reply[\s\S]{0,600}language plpgsql\s+volatile/i.test(migration)
  && /function public\.get_public_rating_comment_replies[\s\S]{0,700}language plpgsql\s+stable/i.test(migration)
  && /v_reply_id bigint/.test(migration)
  && !/returning/i.test(migrationCode)
  && !/execute\s+format|execute\s+['"]select/i.test(migration));
check("reply_count no list de comments (sem mudar commentCount)",
  /comment_id bigint,[\s\S]{0,400}reply_count bigint[\s\S]{0,200}\n\)\s*\nlanguage plpgsql\s*\nstable/i.test(migration)
  && /\(select count\(\*\)[\s\S]{0,120}from public\.rating_comment_replies as rp[\s\S]{0,80}where rp\.comment_id = c\.id\) as reply_count/i.test(migration));
// 42P13: OUT novo exige DROP da assinatura exata antes de recriar.
check("DROP get_public_rating_comments(5 args) antes de recriar com reply_count",
  /drop function if exists public\.get_public_rating_comments\(\s*text,\s*bigint,\s*text,\s*integer,\s*integer\s*\)/i.test(migration)
  && migration.indexOf("drop function if exists public.get_public_rating_comments") <
    migration.indexOf("create function public.get_public_rating_comments"));
check("DROP get_my_notifications(2 args) antes de recriar com reply_text",
  /drop function if exists public\.get_my_notifications\(\s*integer,\s*integer\s*\)/i.test(migration));
check("grants restaurados após DROP (list anon+auth, inbox só auth)",
  /grant execute on function public\.get_public_rating_comments\(text, bigint, text, integer, integer\) to anon, authenticated/i.test(migration)
  && /grant execute on function public\.get_my_notifications\(integer, integer\) to authenticated/i.test(migration)
  && !/grant execute on function public\.get_my_notifications\(integer, integer\) to anon/i.test(migrationCode));
check("schema reload p/ PostgREST (shapes mudaram)",
  /notify pgrst,\s*'reload schema'/i.test(migration));
check("notifications: reply_id FK + 4 tipos + shape + dedupe",
  /add column if not exists reply_id bigint references public\.rating_comment_replies \(id\) on delete cascade/i.test(migration)
  && /check \(type in \('follow', 'rating_like', 'rating_comment', 'comment_reply'\)\)/i.test(migration)
  && /type = 'comment_reply'[\s\S]{0,180}media_type is null and tmdb_id is null and comment_id is not null and reply_id is not null/i.test(migration)
  && /create unique index if not exists notifications_unique_reply[\s\S]{0,120}where type = 'comment_reply'/i.test(migration));
check("inbox redefine com reply_text + title do parent (sem TMDB)",
  /reply_text text,/.test(migration)
  && /left join public\.rating_comment_replies as rp/i.test(migration)
  && !/tmdb.*http|http.*tmdb|themoviedb/i.test(migrationCode));
check("grants: reads anon+auth, writes/inbox só authenticated",
  /grant execute on function public\.get_public_rating_comment_replies\(bigint, integer, integer\) to anon, authenticated/i.test(migration)
  && /grant execute on function public\.create_rating_comment_reply\(bigint, text\) to authenticated/i.test(migration)
  && /grant execute on function public\.get_my_notifications\(integer, integer\) to authenticated/i.test(migration)
  && (migration.match(/revoke all on function public\./gi) || []).length >= 5);
check("sem nesting/feed-event/taste/realtime",
  !/parent.*parent|recursive|with recursive/i.test(migrationCode)
  && !/realtime|push|websocket/i.test(migrationCode)
  && !/taste/i.test(migrationCode));

const replyTypes = codeOnly(readFile("../src/lib/commentReplies/types.ts"));
check("lib reply types (sem UUID, page 10/24, max 500)",
  /CommentReplyItem/.test(replyTypes) && /REPLY_PAGE_SIZE = 10/.test(replyTypes)
  && /REPLY_PAGE_MAX = 24/.test(replyTypes) && /REPLY_TEXT_MAX_LENGTH = 500/.test(replyTypes)
  && !/user_id|author_id/i.test(replyTypes));
const replyValidation = codeOnly(readFile("../src/lib/commentReplies/validation.ts"));
check("lib reply validation (ids + texto 1..500 + query)",
  /validateReplyText/.test(replyValidation) && /validateReplyId/.test(replyValidation)
  && /validateRepliesQuery/.test(replyValidation));
const replyService = codeOnly(readFile("../src/lib/commentReplies/service.ts"));
check("lib reply service (4 RPCs, sem tabela direta, sem UUID)",
  /create_rating_comment_reply/.test(replyService)
  && /update_rating_comment_reply/.test(replyService)
  && /delete_rating_comment_reply/.test(replyService)
  && /get_public_rating_comment_replies/.test(replyService)
  && !/from\("rating_comment_replies"\)|from\('rating_comment_replies'\)/.test(replyService)
  && !/author_id/i.test(replyService));
const repliesApi = codeOnly(readFile("../src/pages/api/ratings/comments/replies.ts"));
check("API replies GET/POST/PATCH/DELETE (401/400/403/404/409)",
  /export const GET/.test(repliesApi) && /export const POST/.test(repliesApi)
  && /export const PATCH/.test(repliesApi) && /export const DELETE/.test(repliesApi)
  && /status: 401/.test(repliesApi) && /status: 403/.test(repliesApi)
  && /status: 404/.test(repliesApi) && /status: 409/.test(repliesApi));
const notifTypes = codeOnly(readFile("../src/lib/notifications/types.ts"));
check("notifications: type comment_reply + replyText",
  /"comment_reply"/.test(notifTypes) && /replyText/.test(notifTypes));
const notifService = codeOnly(readFile("../src/lib/notifications/service.ts"));
check("notifications service: poster normalizado + reply branch (sem path cru)",
  /buildPosterUrl/.test(notifService) && /comment_reply/.test(notifService)
  && !/posterUrl: typeof row\.poster_path/.test(notifService));
const commentsJs = codeOnly(readFile("../public/scripts/rating-comments.js"));
check("client replies (Responder, Ver N, lazy, composer, sem Responder em reply, sem innerHTML)",
  /comment-reply-toggle/.test(commentsJs) && /replies-toggle/.test(commentsJs)
  && /replies-list/.test(commentsJs) && /reply-composer-send/.test(commentsJs)
  && /reply-edit-save/.test(commentsJs) && /reply-delete/.test(commentsJs)
  && !/innerHTML/.test(commentsJs));
const notifCard = codeOnly(readFile("../src/components/notifications/NotificationCard.astro"));
check("NotificationCard: 4 tipos + preview reply + fallback poster",
  /comment_reply/.test(notifCard) && /previewText/.test(notifCard)
  && /poster-fallback/.test(notifCard) && /notification-poster/.test(notifCard)
  && !/aria-label=\{`[^`]*\$\{/.test(notifCard));
const notifPage = codeOnly(readFile("../src/pages/notificacoes.astro"));
check("notificacoes: builder reply + erro de imagem capturado",
  /comment_reply/.test(notifPage) && /notification-poster/.test(notifPage)
  && /poster-fallback/.test(notifPage));
const homePage = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered + sem sessão server-side",
  /export const prerender = true/.test(homePage) && !/getCurrentUser/.test(homePage));
const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome replies", !/repl/i.test(codeOnly(taste)));
const feedTypes = codeOnly(readFile("../src/lib/feed/types.ts"));
check("feed sem evento de reply", !/repl/i.test(feedTypes));

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
  const email = `reply-${tag}-${stamp}@example.com`;
  const password = `Replies123!${tag}`;
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

// 4 Auth users: A owner, B raiz, C terceiro/private, D isolamento.
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
const userA = `replya${short}`;
const userB = `replyb${short}`;
const userC = `replyc${short}`;
const userD = `replyd${short}`;

// ------------------------------------------------- C. probe migration
let rpcMissing = false;
{
  const anon = createClient(SUPABASE_URL, KEY);
  const probe = await anon.rpc("get_public_rating_comment_replies", {
    p_comment_id: 1, p_limit: 10, p_offset: 0,
  });
  rpcMissing = probe.error !== null && /function|does not exist|PGRST|not find|Could not/i.test(
    `${probe.error.message ?? ""} ${probe.error.code ?? ""} ${probe.error.details ?? ""}`,
  );
}
if (rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: fluxo reply, notification, privacidade, paginação, poster, cascatas");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("RPC replies acessível", true);

// ------------------------------------------------- D. seed (A rating + B root comment)
async function setupProfile(u, { username, displayName, pub }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio: null,
    profile_public: pub, show_activity: false, show_favorites: false,
    show_recommendations: false, show_watched: false, show_ratings: true,
    show_reviews: true, discoverable: false, allow_rating_comments: true,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
await setupProfile(A, { username: userA, displayName: `Dono ${short}`, pub: true });
await setupProfile(B, { username: userB, displayName: `Raiz ${short}`, pub: true });
await setupProfile(C, { username: userC, displayName: `Terceiro ${short}`, pub: true });
await setupProfile(D, { username: userD, displayName: `Isolado ${short}`, pub: true });
await A.client.from("watched_titles").insert({
  user_id: A.id, tmdb_id: 801, media_type: "movie", title: "Filme Resposta",
  poster_path: "/reply.jpg", release_year: 2024,
});
await A.client.from("ratings").insert({
  user_id: A.id, tmdb_id: 801, media_type: "movie", rating: 5, review_text: "Boa.",
});

const thread = (cookie, username, tmdbId) =>
  apiJson("GET", `/api/ratings/comments?username=${encodeURIComponent(username)}&tmdbId=${tmdbId}&mediaType=movie`, cookie);
const repliesOf = (cookie, commentId, extra = "") =>
  apiJson("GET", `/api/ratings/comments/replies?commentId=${commentId}${extra}`, cookie);
const reply = (cookie, commentId, text) =>
  apiJson("POST", "/api/ratings/comments/replies", cookie, { commentId, text });
const notifList = (cookie) => apiJson("GET", "/api/notifications?page=1&limit=24", cookie);
const notifUnread = (cookie) => apiJson("GET", "/api/notifications/unread-count", cookie);

// Root comment de B.
let r = await apiJson("POST", "/api/ratings/comments", B.cookie,
  { username: userA, tmdbId: 801, mediaType: "movie", text: "Comentário raiz." });
const rootId = r.json?.comment?.commentId;
checkd("seed: B comenta A", r.res.status === 200 && typeof rootId === "number",
  `status=${r.res.status} body=${r.text.slice(0, 120)}`);
if (typeof rootId !== "number") {
  console.log("---");
  console.log("SEED FAILURE (root comment indisponível) — restante em SKIP.");
  process.exit(1);
}

// ------------------------------------------------- D2. canário reply
let repliesWork = false;
{
  const can = await reply(A.cookie, rootId, "Canário.");
  const canId = can.json?.reply?.replyId;
  if (can.res.status === 200 && typeof canId === "number") {
    const got = await repliesOf(B.cookie, rootId);
    const found = (got.json?.items ?? []).some((i) => i.replyId === canId);
    if (found) {
      repliesWork = true;
      check("canário: reply cria row + notification", true);
      await apiJson("DELETE", "/api/ratings/comments/replies", A.cookie, { replyId: canId });
    } else {
      checkd("canário: reply cria row + notification", false, "reply ausente no list");
    }
  } else {
    checkd("canário: reply cria row + notification", false,
      `status=${can.res.status} body=${can.text.slice(0, 200)} — aplique ${MIGRATION_FILE} no Dashboard`);
  }
}
const needReplies = (label) => {
  if (!repliesWork) skip(`${label} (canário reply falhou)`);
  return repliesWork;
};

// ------------------------------------------------- E. fluxo básico + third party
if (needReplies("fluxo básico")) {
  r = await reply(A.cookie, rootId, "Também gostei dessa parte.");
  checkd("A responde B:200 + replyCount 1",
    r.res.status === 200 && typeof r.json?.reply?.replyId === "number" && r.json?.replyCount === 1,
    `status=${r.res.status} body=${r.text.slice(0, 160)}`);
  r = await notifUnread(B.cookie);
  checkd("B: 1 unread comment_reply", r.json?.unreadCount === 1, `body=${r.text.slice(0, 120)}`);
  r = await notifList(B.cookie);
  {
    const item = (r.json?.items ?? []).find((i) => i.type === "comment_reply");
    checkd("notification reply: actor A + title 801 + preview",
      item?.actor?.username === userA && item?.title?.tmdbId === 801
      && item?.replyText === "Também gostei dessa parte."
      && !containsUuid(r.json, [A.id, B.id]),
      `item=${JSON.stringify(item ?? null).slice(0, 280)}`);
  }
  r = await reply(C.cookie, rootId, "C concorda.");
  checkd("C responde B:200", r.res.status === 200, `status=${r.res.status}`);
  r = await notifUnread(B.cookie);
  checkd("B: 2 unread", r.json?.unreadCount === 2, "");
  r = await notifUnread(A.cookie);
  checkd("A NÃO recebe notification da reply de C (só o root legítimo)",
    r.json?.unreadCount === 1
    && (await notifList(A.cookie)).json?.items?.every((i) => i.type !== "comment_reply") === true,
    `unread=${r.json?.unreadCount}`);
}

// ------------------------------------------------- F. self-reply 409
if (needReplies("self-reply")) {
  r = await reply(B.cookie, rootId, "Falando sozinho.");
  checkd("B responde próprio: 409 sem row",
    r.res.status === 409 && /próprio comentário/.test(r.json?.error || ""),
    `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
}

// ------------------------------------------------- G. allow off
if (needReplies("allow off")) {
  r = await repliesOf(B.cookie, rootId);
  checkd("replies existentes continuam visíveis (allow on)",
    r.res.status === 200 && (r.json?.items ?? []).length >= 2, `n=${(r.json?.items ?? []).length}`);
  await A.client.from("profiles").update({ allow_rating_comments: false }).eq("id", A.id);
  r = await repliesOf(B.cookie, rootId);
  checkd("allow off: lista continua visível",
    r.res.status === 200 && (r.json?.items ?? []).length >= 2, `status=${r.res.status}`);
  r = await reply(C.cookie, rootId, "Bloqueada?");
  checkd("allow off: novo reply → 403",
    r.res.status === 403 && /desativadas/.test(r.json?.error || ""),
    `status=${r.res.status} erro=${JSON.stringify(r.json?.error)}`);
  await A.client.from("profiles").update({ allow_rating_comments: true }).eq("id", A.id);
}

// ------------------------------------------------- H. privacidade thread/show/discoverable
if (needReplies("privacidade")) {
  await A.client.from("profiles").update({ profile_public: false }).eq("id", A.id);
  r = await repliesOf(B.cookie, rootId);
  check("A privado: list some (404/[])", r.res.status === 404 || (r.json?.items ?? []).length === 0);
  await A.client.from("profiles").update({ profile_public: true, show_ratings: false }).eq("id", A.id);
  r = await repliesOf(B.cookie, rootId);
  check("show_ratings=false: some", r.res.status === 404 || (r.json?.items ?? []).length === 0);
  await A.client.from("profiles").update({ show_ratings: true }).eq("id", A.id);
  r = await repliesOf(B.cookie, rootId);
  checkd("republica: voltam", r.res.status === 200 && (r.json?.items ?? []).length >= 2, `status=${r.res.status}`);
  await B.client.from("profiles").update({ discoverable: false }).eq("id", B.id);
  r = await reply(A.cookie, rootId, "Mais uma de A.");
  checkd("discoverable irrelevante p/ reply", r.res.status === 200, `status=${r.res.status}`);
}

// ------------------------------------------------- I. autor privado
if (needReplies("autor privado")) {
  await C.client.from("profiles").update({ profile_public: false }).eq("id", C.id);
  r = await repliesOf(B.cookie, rootId);
  {
    const mine = (r.json?.items ?? []).filter((i) => i.author?.isPrivate === true);
    checkd("C privado: Usuário privado + texto visível, sem UUID",
      mine.length >= 1 && mine.every((i) => i.author?.username === null && i.author?.avatarUrl === null)
      && !containsUuid(r.json, [C.id]),
      `n=${(r.json?.items ?? []).length}`);
  }
  await C.client.from("profiles").update({ profile_public: true }).eq("id", C.id);
  r = await repliesOf(B.cookie, rootId);
  checkd("C público: identidade volta",
    (r.json?.items ?? []).some((i) => i.author?.username === userC), "");
  await C.client.from("profiles").update({ profile_public: false }).eq("id", C.id);
  // notification de B anonimiza junto
  r = await notifList(B.cookie);
  checkd("inbox anonimiza C privado",
    (r.json?.items ?? []).some((i) => i.type === "comment_reply" && i.actor?.isPrivate === true
      && i.actor?.username === null),
    "");
  await C.client.from("profiles").update({ profile_public: true }).eq("id", C.id);
}

// ------------------------------------------------- J. edit (sem nova notification, read preservado)
if (needReplies("edit")) {
  // marca tudo de B como lido primeiro
  const all = (await notifList(B.cookie)).json?.items ?? [];
  const ids = all.filter((i) => !i.isRead).map((i) => i.notificationId);
  if (ids.length > 0) {
    await apiJson("POST", "/api/notifications/read", B.cookie, { notificationIds: ids });
  }
  const before = await repliesOf(A.cookie, rootId);
  const target = (before.json?.items ?? []).find((i) => i.canEdit === true);
  const created = target?.createdAt;
  r = await apiJson("PATCH", "/api/ratings/comments/replies", A.cookie,
    { replyId: target?.replyId, text: "Editado por A." });
  checkd("A edita própria: trim + updated muda + created igual",
    r.res.status === 200 && r.json?.text === "Editado por A."
    && r.json?.createdAt === created && r.json?.updatedAt !== created,
    `body=${r.text.slice(0, 200)}`);
  r = await notifList(B.cookie);
  {
    const item = (r.json?.items ?? []).find(
      (i) => i.type === "comment_reply" && i.replyText === "Editado por A.");
    checkd("edit: mesma notification, preview novo, continua read, sem unread novo",
      item !== undefined && item?.isRead === true && typeof item?.readAt === "string"
      && (await notifUnread(B.cookie)).json?.unreadCount === 0,
      `item=${JSON.stringify(item ?? null).slice(0, 240)}`);
  }
}

// ------------------------------------------------- K. delete autor + moderação owner
if (needReplies("delete/moderação")) {
  // C responde (C público aqui) → A owner remove; B parent não pode.
  r = await reply(C.cookie, rootId, "Para moderar.");
  const modId = r.json?.reply?.replyId;
  checkd("C responde p/ moderação", r.res.status === 200 && typeof modId === "number", `status=${r.res.status}`);
  r = await apiJson("DELETE", "/api/ratings/comments/replies", B.cookie, { replyId: modId });
  check("B parent (não owner) NÃO remove reply de C → 404", r.res.status === 404);
  r = await apiJson("DELETE", "/api/ratings/comments/replies", A.cookie, { replyId: modId });
  checkd("A owner remove reply de C", r.res.status === 200 && r.json?.removed === true,
    `status=${r.res.status} body=${r.text.slice(0, 120)}`);
  r = await apiJson("DELETE", "/api/ratings/comments/replies", D.cookie, { replyId: modId });
  check("D estranho remove inexistente → 404", r.res.status === 404);
}

// ------------------------------------------------- L. parent delete cascade
if (needReplies("parent delete")) {
  const b2 = await apiJson("POST", "/api/ratings/comments", B.cookie,
    { username: userA, tmdbId: 801, mediaType: "movie", text: "Raiz temporária." });
  const root2 = b2.json?.comment?.commentId;
  const rp = await reply(A.cookie, root2, "Reply temporária.");
  checkd("seed parent temporário", b2.res.status === 200 && rp.res.status === 200, "");
  await apiJson("DELETE", "/api/ratings/comments", B.cookie, { commentId: root2 });
  r = await repliesOf(B.cookie, root2);
  check("parent delete: replies somem", r.res.status === 404 || (r.json?.items ?? []).length === 0);
  r = await notifList(B.cookie);
  checkd("parent delete: reply notifications somem",
    (r.json?.items ?? []).every((i) => i.type !== "comment_reply" || i.replyText !== "Reply temporária."),
    "");
}

// ------------------------------------------------- M. paginação 0/1/10/11/21 (ASC, sem dupes)
if (needReplies("paginação")) {
  const b3 = await apiJson("POST", "/api/ratings/comments", B.cookie,
    { username: userA, tmdbId: 801, mediaType: "movie", text: "Raiz paginação." });
  const root3 = b3.json?.comment?.commentId;
  const authors = [A, C];
  for (let i = 0; i < 21; i += 1) {
    const who = authors[i % 2];
    const rr = await reply(who.cookie, root3, `Paginada ${i + 1}.`);
    if (rr.res.status !== 200) {
      checkd(`seed paginação ${i + 1}`, false, `status=${rr.res.status}`);
      break;
    }
  }
  const p1 = await repliesOf(B.cookie, root3);
  const p2 = await repliesOf(B.cookie, root3, "&page=2");
  const p3 = await repliesOf(B.cookie, root3, "&page=3");
  const ids = [...(p1.json?.items ?? []), ...(p2.json?.items ?? []), ...(p3.json?.items ?? [])].map((i) => i.replyId);
  const times = [...(p1.json?.items ?? []), ...(p2.json?.items ?? []), ...(p3.json?.items ?? [])].map((i) => i.createdAt);
  const asc = times.every((t, i) => i === 0 || times[i - 1] <= t);
  checkd("21: 10+true / 10+true / 1+false, ASC, sem duplicatas",
    p1.json?.items?.length === 10 && p1.json?.hasMore === true
    && p2.json?.items?.length === 10 && p2.json?.hasMore === true
    && p3.json?.items?.length === 1 && p3.json?.hasMore === false
    && new Set(ids).size === 21 && asc,
    `ns=${p1.json?.items?.length}/${p2.json?.items?.length}/${p3.json?.items?.length}`);
  const bad = await repliesOf(B.cookie, root3, "&limit=25");
  check("limit=25 → 400", bad.res.status === 400);
}

// ------------------------------------------------- N. replyCount + commentCount global
if (needReplies("counts")) {
  r = await thread(B.cookie, userA, 801);
  const root = (r.json?.items ?? []).find((i) => i.commentId === rootId);
  checkd("root tem replyCount numérico",
    typeof root?.replyCount === "number", `root=${JSON.stringify(root ?? null).slice(0, 160)}`);
  const before = root?.replyCount ?? -1;
  const countBefore = r.json?.commentCount ?? -1;
  const add = await reply(C.cookie, rootId, "Conta para o count.");
  const addId = add.json?.reply?.replyId;
  r = await thread(B.cookie, userA, 801);
  const after = (r.json?.items ?? []).find((i) => i.commentId === rootId);
  checkd("create: replyCount +1, commentCount global inalterado",
    after?.replyCount === before + 1 && r.json?.commentCount === countBefore,
    `antes=${before} depois=${after?.replyCount} global=${r.json?.commentCount}`);
  await apiJson("DELETE", "/api/ratings/comments/replies", C.cookie, { replyId: addId });
  r = await thread(B.cookie, userA, 801);
  checkd("delete: replyCount -1",
    (r.json?.items ?? []).find((i) => i.commentId === rootId)?.replyCount === before,
    "");
  checkd("global = só raízes",
    (r.json?.commentCount ?? -1) >= 1 && (r.json?.items ?? []).length === r.json?.commentCount,
    `commentCount=${r.json?.commentCount} items=${(r.json?.items ?? []).length}`);
}

// ------------------------------------------------- O. unread/read + privada + sem falsas
if (needReplies("unread")) {
  const u0 = (await notifUnread(B.cookie)).json?.unreadCount ?? -1;
  await reply(A.cookie, rootId, "Unread 1.");
  await reply(C.cookie, rootId, "Unread 2.");
  await reply(A.cookie, rootId, "Unread 3.");
  r = await notifUnread(B.cookie);
  checkd("3 replies → +3 unread", r.json?.unreadCount === u0 + 3, `antes=${u0} depois=${r.json?.unreadCount}`);
  r = await apiJson("POST", "/api/notifications/read-all", B.cookie, {});
  checkd("mark all zera", r.json?.unreadCount === 0, "");
  // sem falsas: edit reply/parent, privacy toggle, favorite, watched, rating edit
  const u1 = (await notifUnread(B.cookie)).json?.unreadCount ?? -1;
  const lst = await repliesOf(B.cookie, rootId);
  const firstReply = (lst.json?.items ?? [])[0];
  await apiJson("PATCH", "/api/ratings/comments/replies", A.cookie, { replyId: firstReply?.replyId, text: "Reedit." });
  await apiJson("PATCH", "/api/ratings/comments", B.cookie, { commentId: rootId, text: "Raiz reeditada." });
  await apiJson("PATCH", "/api/profile/privacy", A.cookie, {
    profilePublic: true, showFavorites: false, showRecommendations: false,
    showWatched: false, showRatings: true, showReviews: true, discoverable: false,
    showActivity: false, allowRatingComments: true,
  });
  await B.client.from("profile_picks").insert({
    user_id: B.id, tmdb_id: 802, media_type: "movie", kind: "favorite",
    title: "Fav", poster_path: "/p.jpg", release_year: 2020, note: null,
  });
  await B.client.from("watched_titles").insert({
    user_id: B.id, tmdb_id: 803, media_type: "movie", title: "W",
    poster_path: "/p.jpg", release_year: 2021,
  });
  r = await notifUnread(B.cookie);
  checkd("edit/toggle/fav/watched não criam notification",
    r.json?.unreadCount === u1, `antes=${u1} depois=${r.json?.unreadCount}`);
}

// ------------------------------------------------- P. XSS reply
if (needReplies("xss")) {
  const xss = `Resposta <img src=x onerror=alert(3)> "aspas"`;
  r = await reply(A.cookie, rootId, xss);
  checkd("reply XSS: literal no RPC", r.res.status === 200 && r.json?.reply?.text === xss,
    `status=${r.res.status}`);
  r = await notifList(B.cookie);
  {
    const item = (r.json?.items ?? []).find((i) => i.type === "comment_reply" && i.replyText === xss);
    checkd("inbox devolve literal", item !== undefined, "");
  }
  {
    const p = await getPage(`/notificacoes`, B.cookie);
    checkd("HTML /notificacoes escapa reply (sem img cru)",
      p.res.status === 200 && !p.html.includes("<img src=x"),
      `status=${p.res.status}`);
  }
}

// ------------------------------------------------- Q. pôster: absoluto, null, follow, SSR+load-more
// Parte like/comment usa a inbox de A (Etapa 21, sem gate de replies);
// só a parte reply exige repliesWork.
{
  await apiJson("POST", "/api/ratings/likes", B.cookie, { username: userA, tmdbId: 801, mediaType: "movie" });
  await apiJson("POST", "/api/ratings/comments", C.cookie,
    { username: userA, tmdbId: 801, mediaType: "movie", text: "Raiz poster." });
  r = await notifList(A.cookie);
  const withPoster = (r.json?.items ?? []).filter((i) => i.title?.tmdbId === 801 && i.type !== "comment_reply");
  checkd("API devolve posterUrl absoluto (não path cru)",
    withPoster.length >= 2 && withPoster.every((i) =>
      typeof i.title?.posterUrl === "string" && i.title.posterUrl.startsWith("https://image.tmdb.org/")),
    `n=${withPoster.length} ex=${JSON.stringify(withPoster[0]?.title ?? null)}`);
  checkd("nenhum poster path cru (/x.jpg como src)",
    withPoster.every((i) => !/^\/[^/]/.test(i.title?.posterUrl ?? "/ok")),
    "");
  if (repliesWork) {
    r = await notifList(B.cookie);
    const replyPoster = (r.json?.items ?? []).filter((i) => i.type === "comment_reply" && i.title?.tmdbId === 801);
    checkd("reply API: posterUrl absoluto",
      replyPoster.length > 0 && replyPoster.every((i) =>
        typeof i.title?.posterUrl === "string" && i.title.posterUrl.startsWith("https://image.tmdb.org/")),
      `n=${replyPoster.length}`);
  } else {
    skip("reply poster absoluto (canário reply falhou)");
  }
  const p = await getPage(`/notificacoes`, A.cookie);
  checkd("HTML SSR: src absoluto + sem src vazio",
    p.res.status === 200 && !/src=""|src="null"|src="undefined"/.test(p.html)
    && (p.html.match(/https:\/\/image\.tmdb\.org\/t\/p\/w500\/reply\.jpg/g) || []).length >= 1,
    `status=${p.res.status}`);
  // follow sem poster: sem área quebrada
  await apiJson("POST", "/api/follows", C.cookie, { username: userB });
  const bl = await apiJson("GET", `/api/notifications?page=1&limit=24`, B.cookie);
  const follows = (bl.json?.items ?? []).filter((i) => i.type === "follow");
  checkd("follow sem poster (title null, sem img)",
    follows.length > 0 && follows.every((i) => i.title === null),
    `n=${follows.length}`);
  await apiJson("DELETE", "/api/follows", C.cookie, { username: userB });
}

// ------------------------------------------------- R. rating delete + unwatch cascade
if (needReplies("cascatas")) {
  await A.client.from("watched_titles").insert({
    user_id: A.id, tmdb_id: 804, media_type: "movie", title: "Cascata R",
    poster_path: "/p.jpg", release_year: 2022,
  });
  await A.client.from("ratings").insert({
    user_id: A.id, tmdb_id: 804, media_type: "movie", rating: 4, review_text: null,
  });
  const cc = await apiJson("POST", "/api/ratings/comments", B.cookie,
    { username: userA, tmdbId: 804, mediaType: "movie", text: "Raiz cascata." });
  await reply(A.cookie, cc.json?.comment?.commentId, "Reply cascata.");
  await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", 804);
  r = await repliesOf(B.cookie, cc.json?.comment?.commentId);
  check("delete rating: replies somem", (r.json?.items ?? []).length === 0);
  await A.client.from("watched_titles").insert({
    user_id: A.id, tmdb_id: 805, media_type: "movie", title: "Cascata W",
    poster_path: "/p.jpg", release_year: 2022,
  });
  await A.client.from("ratings").insert({
    user_id: A.id, tmdb_id: 805, media_type: "movie", rating: 4, review_text: null,
  });
  const cc2 = await apiJson("POST", "/api/ratings/comments", B.cookie,
    { username: userA, tmdbId: 805, mediaType: "movie", text: "Raiz unwatch." });
  await reply(A.cookie, cc2.json?.comment?.commentId, "Reply unwatch.");
  await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 805);
  r = await repliesOf(B.cookie, cc2.json?.comment?.commentId);
  check("unwatch: replies somem", (r.json?.items ?? []).length === 0);
  r = await notifList(B.cookie);
  checkd("cascatas: reply notifications 804/805 somem",
    (r.json?.items ?? []).every((i) => i.title?.tmdbId !== 804 && i.title?.tmdbId !== 805),
    "");
}

// ------------------------------------------------- S. limpeza (sem service_role)
for (const u of [A, B, C, D]) {
  await u.client.from("rating_comments").delete().eq("author_id", u.id);
}
await A.client.from("ratings").delete().eq("user_id", A.id);
for (const u of [A, B, C, D]) {
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("follows").delete().eq("follower_id", u.id);
  await u.client.from("follows").delete().eq("following_id", u.id);
}

console.log("---");
console.log(failures === 0 ? "COMMENT-REPLIES OK: 1 nível + notification + poster confirmados (4 Auth users)." : `COMMENT-REPLIES FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
