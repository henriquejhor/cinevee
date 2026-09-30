/**
 * Verificação da Etapa 13: Sobre — favoritos + recomendações (profile_picks).
 *
 * Pré-requisito: migration supabase/migrations/20260928090000_profile_picks.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem da tabela entram em SKIP identificado
 * (exit 1); contratos de arquivo/validação via HTTP independente rodam sempre.
 *
 * Uso:  npm run verify:profile-picks (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration/arquivos: tabela, checks, unique, índice, RLS, trigger,
 *   5 tabs (Sobre), limites 12/6, nota 500, TMDB snapshot, sem userId no body;
 * - RLS A/B em profile_picks (insert/select/update/delete cruzados → 0);
 * - constraints via escrita direta (kind/media/ids/position/note-by-kind/unique);
 * - API: 401 deslogado · POST favorite/tv + snapshot real TMDB ·
 *   browser metadata ignorado · duplicata 409 amigável · mesmo título nos
 *   dois kinds · limites 12/6 (409) · note ""/espaços/501 → 400 ·
 *   500 chars → 200 · XSS como texto · reorder + refresh · remoção por kind ·
 *   posições compactadas · /perfil/sobre redirect deslogado ·
 *   /api/search movie+tv sem person;
 * - UI contracts em /perfil/sobre (bio, dialog, debounce, reorder, contadores)
 *   e preview no /perfil; TasteProfile intocado (sem picks).
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

const MIGRATION_FILE = "supabase/migrations/20260928090000_profile_picks.sql";

let failures = 0;
let skipped = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
function skip(label) {
  console.log(`SKIP  ${label}`);
  skipped += 1;
}
const info = (msg) => console.log(`INFO  ${msg}`);

function readFile(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

// ------------------------------------------------- A. arquivos/migration
check("migration Etapa 13 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
check("migration cria public.profile_picks", /create table if not exists public\.profile_picks/i.test(migration));
check("migration unique (user,media,tmdb,kind)", /unique\s*\(\s*user_id\s*,\s*media_type\s*,\s*tmdb_id\s*,\s*kind\s*\)/i.test(migration));
check("migration checks media/kind/ids/position", /profile_picks_media_type_allowed[\s\S]{0,120}in\s*\('movie',\s*'tv'\)/i.test(migration)
  && /profile_picks_kind_allowed[\s\S]{0,120}in\s*\('favorite',\s*'recommendation'\)/i.test(migration)
  && /tmdb_id > 0/i.test(migration) && /position >= 0/i.test(migration));
check("migration regra note por kind", /profile_picks_note_by_kind[\s\S]{0,400}kind = 'favorite' and note is null/i.test(migration)
  && /kind = 'recommendation'[\s\S]{0,200}char_length\(note\) <= 500/i.test(migration));
check("migration índice (user,kind,position)", /profile_picks_user_kind_position[\s\S]{0,120}\(\s*user_id\s*,\s*kind\s*,\s*position\s*\)/i.test(migration));
check("migration RLS + 4 policies próprias", /enable row level security/i.test(migration)
  && /profile_picks_select_own/i.test(migration) && /profile_picks_insert_own/i.test(migration)
  && /profile_picks_update_own/i.test(migration) && /profile_picks_delete_own/i.test(migration)
  && !/to\s+(anon|public|authenticated\s*,\s*anon)/i.test(migration));
check("migration sem policy pública", !/create policy[^;]*for\s+(select|all)[^;]*to\s+public/i.test(migration)
  && !/create policy[^;]*using\s*\(\s*true\s*\)/i.test(migration));
check("migration trigger updated_at", /handle_profile_pick_updated_at/i.test(migration));
check("migration sem FK p/ watched (picks independentes)", !/references\s+public\.watched_titles/i.test(migration));

const types = readFile("../src/lib/profilePicks/types.ts");
check("types: limites 12/6 + nota 500", /FAVORITE_LIMIT = 12/.test(types)
  && /RECOMMENDATION_LIMIT = 6/.test(types) && /RECOMMENDATION_NOTE_MAX = 500/.test(types));
check("types: ProfilePickKind favorite|recommendation", /"favorite" \| "recommendation"/.test(types));

const validation = readFile("../src/lib/profilePicks/validation.ts");
check("validation ignora title/poster do body", !/payload\.(title|poster|posterPath|year)/.test(validation));
check("validation note obrigatória p/ recommendation", /NOTE_REQUIRED/.test(validation)
  && /Conte por que você recomenda/.test(validation));

const service = readFile("../src/lib/profilePicks/service.ts");
check("service usa fetchTitleSnapshot (TMDB factual)", /fetchTitleSnapshot/.test(service));
check("service sem userId do body", !/input\.user_?id|body\.user_?id/i.test(service));
check("service erros amigáveis 12/6 + duplicata", /até 12 favoritos/.test(service) && /até 6 títulos/.test(service)
  && /já está nos seus favoritos/.test(service) && /já está nas suas recomendações/.test(service));
check("service reorder valida conjunto exato", /orderedIds\.length !== currentIds\.length/.test(service));
check("service compacta posições na remoção", /compactPositions/.test(service));

const apiRoute = readFile("../src/pages/api/profile/picks.ts");
check("API GET/POST/PATCH/DELETE", /export const GET/.test(apiRoute) && /export const POST/.test(apiRoute)
  && /export const PATCH/.test(apiRoute) && /export const DELETE/.test(apiRoute));
check("API PATCH com op note|reorder", /op === "reorder"/.test(apiRoute) && /op: "note"/.test(apiRoute));
check("API 401/400/404/409 mapeados", /status: 401/.test(apiRoute) && /status: 400/.test(apiRoute)
  && /status: 404/.test(apiRoute) && /status: 409/.test(apiRoute));

const tabs = readFile("../src/components/profile/ProfileTabs.astro");
const tabItems = (tabs.match(/<li class="shrink-0">/g) || []).length;
check("ProfileTabs tem 5 itens", tabItems === 5);
check("ProfileTabs tem aba Sobre (/perfil/sobre)", /href="\/perfil\/sobre"[\s\S]{0,80}Sobre/.test(tabs));
check("ProfileTabs mobile-safe (scroll, nowrap, 48px)", /overflow-x-auto/.test(tabs)
  && /whitespace-nowrap/.test(tabs) && /min-h-12/.test(tabs) && /shrink-0/.test(tabs));
const sobreOrdem = tabs.indexOf("/perfil/sobre");
check("Sobre vem após Visão geral e antes de Minha Lista",
  tabs.indexOf("Visão geral") < sobreOrdem && sobreOrdem < tabs.indexOf("/perfil/lista"));

const shell = readFile("../src/components/profile/ProfileShell.astro");
check("ProfileShell aceita activeTab about", /"about"/.test(shell));
check("ProfileShell sem contadores de picks no header", !/favorite|recommendation/i.test(shell));

const sobre = readFile("../src/pages/perfil/sobre.astro");
check("sobre usa ProfileShell + activeTab about", /ProfileShell/.test(sobre) && /activeTab="about"/.test(sobre));
check("sobre redirect deslogado p/ /entrar?next=%2Fperfil%2Fsobre", /\/entrar\?next=%2Fperfil%2Fsobre/.test(sobre));
check("sobre seção bio (profiles.bio, sem nova coluna)", /profile\?\.bio/.test(sobre)
  && /\/perfil\/editar#identity-bio/.test(sobre) && !/bio_text|user_bio/.test(sobre));
check("sobre contadores n/12 e n/6", /FAVORITE_LIMIT/.test(sobre) && /RECOMMENDATION_LIMIT/.test(sobre));
check("sobre dialog nativo + busca", /<dialog[^>]*id="pick-dialog"/.test(sobre) && /pick-search-input/.test(sobre));
check("sobre debounce ~300ms + min 2 chars", /DEBOUNCE_MS = 300/.test(sobre) && /query\.length < 2/.test(sobre));
check("sobre textarea nota maxlength 500", /RECOMMENDATION_NOTE_MAX/.test(sobre) && /Por que você recomenda\?/.test(sobre));
check("sobre reorder cima/baixo (sem drag obrigatório)", /data-pick-up/.test(sobre) && /data-pick-down/.test(sobre)
  && /Mover .* para (cima|baixo)/.test(sobre));
check("sobre sem innerHTML (texto via textContent)", !/\.innerHTML\s*[=+]/i.test(sobre));
check("sobre empty states discretos", /Quais títulos representam o seu gosto\?/.test(sobre)
  && /Tem algo que você sempre indica/.test(sobre));

const perfil = readFile("../src/pages/perfil.astro");
check("overview preview favoritos (só se houver)", /favoritesPreview\.length > 0/.test(perfil)
  && /Ver Sobre/.test(perfil) && /getFavorites/.test(perfil));
check("overview sem Recomendo inteiro", !/getRecommendations/.test(perfil));

const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome picks", !/profile_picks|ProfilePick|favorite|recommendation/i.test(taste));

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

const stamp = Date.now();
async function signUp(tag) {
  const client = createClient(SUPABASE_URL, KEY);
  const email = `picks-${tag}-${stamp}@example.com`;
  const password = `PicksVerificacao123!${tag}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) throw new Error(`signup ${email} falhou`);
  const fresh = createClient(SUPABASE_URL, KEY);
  const { data: s } = await fresh.auth.signInWithPassword({ email, password });
  return { client, id: data.user.id, email, cookie: cookieFor(s.session) };
}

const A = await signUp("a");
const B = await signUp("b");
const C = await signUp("c");

// ------------------------------------------------- C. checks sem tabela (auth + validação + search)
let r = await api("GET", "/api/profile/picks", null);
check("GET deslogado → 401", r.res.status === 401);
r = await api("POST", "/api/profile/picks", null, { tmdbId: 550, mediaType: "movie", kind: "favorite" });
check("POST deslogado → 401", r.res.status === 401);
r = await api("PATCH", "/api/profile/picks", null, { op: "note", id: "00000000-0000-0000-0000-000000000000", note: "x" });
check("PATCH deslogado → 401", r.res.status === 401);
r = await api("DELETE", "/api/profile/picks", null, { id: "00000000-0000-0000-0000-000000000000" });
check("DELETE deslogado → 401", r.res.status === 401);

const sobrePage = await fetch(`${BASE}/perfil/sobre`, { redirect: "manual" });
check("/perfil/sobre deslogado → redirect login",
  [301, 302, 303, 307, 308].includes(sobrePage.status)
  && (sobrePage.headers.get("location") || "").includes("/entrar"));

for (const [label, body, expected] of [
  ["vazio", {}, 400],
  ["tmdbId 0", { tmdbId: 0, mediaType: "movie", kind: "favorite" }, 400],
  ["tmdbId string", { tmdbId: "550", mediaType: "movie", kind: "favorite" }, 400],
  ["mediaType book", { tmdbId: 550, mediaType: "book", kind: "favorite" }, 400],
  ["kind inválido", { tmdbId: 550, mediaType: "movie", kind: "like" }, 400],
  ["sem kind", { tmdbId: 550, mediaType: "movie" }, 400],
  ["rec sem note", { tmdbId: 550, mediaType: "movie", kind: "recommendation" }, 400],
  ["rec note vazia", { tmdbId: 550, mediaType: "movie", kind: "recommendation", note: "   " }, 400],
  ["rec note 501", { tmdbId: 550, mediaType: "movie", kind: "recommendation", note: "z".repeat(501) }, 400],
]) {
  r = await api("POST", "/api/profile/picks", C.cookie, body);
  if (r.res.status !== expected) check(`POST inválido (${label}) → ${expected}`, false);
}
check("POST inválidos → 400 (9 casos)", true);

r = await api("PATCH", "/api/profile/picks", C.cookie, { op: "note", id: "not-a-uuid", note: "x" });
check("PATCH id inválido → 400", r.res.status === 400);
r = await api("PATCH", "/api/profile/picks", C.cookie, { op: "reorder", kind: "favorite", orderedIds: [] });
check("PATCH reorder vazio → 400", r.res.status === 400);
r = await api("PATCH", "/api/profile/picks", C.cookie, { op: "reorder", kind: "favorite", orderedIds: ["not-a-uuid"] });
check("PATCH reorder id inválido → 400", r.res.status === 400);
r = await api("DELETE", "/api/profile/picks", C.cookie, { id: "nope" });
check("DELETE id inválido → 400", r.res.status === 400);

r = await api("GET", "/api/search?q=duna", null);
const results = r.json?.results ?? [];
check("search duna → 200 só movie/tv (sem person)",
  r.res.status === 200 && results.length > 0
  && results.every((it) => it.type === "movie" || it.type === "tv"));
r = await api("GET", "/api/search?q=x", null);
check("search curta (<2) → results []", r.res.status === 200 && Array.isArray(r.json?.results) && r.json.results.length === 0);

// ------------------------------------------------- D. tabela existe?
const probe = await A.client.from("profile_picks").select("id").limit(1);
const tableMissing = probe.error && /could not find|schema cache|42P01|does not exist/i.test(probe.error.message ?? "");
if (tableMissing || (probe.error && probe.error.code === "PGRST205")) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: RLS A/B em profile_picks");
  skip("banco: constraints (kind/media/ids/position/note/unique)");
  skip("HTTP: POST/PATCH/DELETE /api/profile/picks (dependem da tabela)");
  skip("HTTP: limites 12/6, snapshot, reorder, remoção por kind");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("tabela profile_picks acessível", probe.error === null);

// ------------------------------------------------- E. RLS A/B (nível tabela)
const favA = {
  user_id: A.id, tmdb_id: 550, media_type: "movie", kind: "favorite",
  title: "Clube da Luta", poster_path: "/p.jpg", release_year: 1999, note: null, position: 0,
};
const insA = await A.client.from("profile_picks").insert(favA).select("id");
check("A insere favorite próprio", insA.error === null && insA.data?.length === 1);
const pickIdA = insA.data?.[0]?.id;

const seeB = await B.client.from("profile_picks").select("id").eq("user_id", A.id);
check("B NÃO lê picks de A (0 linhas)", seeB.error === null && seeB.data?.length === 0);
const updB = await B.client.from("profile_picks").update({ position: 9 }).eq("id", pickIdA).select("id");
check("B NÃO altera pick de A (0 linhas)", (updB.data ?? []).length === 0);
const delB = await B.client.from("profile_picks").delete().eq("id", pickIdA).select("id");
check("B NÃO remove pick de A (0 linhas)", (delB.data ?? []).length === 0);
const intact = await A.client.from("profile_picks").select("id,position").eq("id", pickIdA);
check("pick de A intacta", intact.data?.length === 1 && intact.data[0].position === 0);

// ------------------------------------------------- F. constraints (nível tabela)
async function expectFail(label, row) {
  const r = await B.client.from("profile_picks").insert({ user_id: B.id, ...row }).select("id");
  check(label, r.error !== null);
  return r;
}
await expectFail("CHECK bloqueia kind inválido",
  { tmdb_id: 1, media_type: "movie", kind: "like", title: "X", position: 0 });
await expectFail("CHECK bloqueia media_type inválido",
  { tmdb_id: 1, media_type: "book", kind: "favorite", title: "X", position: 0 });
await expectFail("CHECK bloqueia tmdb_id <= 0",
  { tmdb_id: 0, media_type: "movie", kind: "favorite", title: "X", position: 0 });
await expectFail("CHECK bloqueia position < 0",
  { tmdb_id: 2, media_type: "movie", kind: "favorite", title: "X", position: -1 });
await expectFail("CHECK: favorite com note rejeitado",
  { tmdb_id: 3, media_type: "movie", kind: "favorite", title: "X", note: "ops", position: 0 });
await expectFail("CHECK: recommendation sem note rejeitada",
  { tmdb_id: 4, media_type: "movie", kind: "recommendation", title: "X", note: null, position: 0 });
await expectFail("CHECK: recommendation só-espaços rejeitada",
  { tmdb_id: 5, media_type: "movie", kind: "recommendation", title: "X", note: "   ", position: 0 });
await expectFail("CHECK: recommendation 501 chars rejeitada",
  { tmdb_id: 6, media_type: "movie", kind: "recommendation", title: "X", note: "y".repeat(501), position: 0 });
const okRec = await B.client.from("profile_picks").insert({
  user_id: B.id, tmdb_id: 7, media_type: "tv", kind: "recommendation",
  title: "Série X", note: "Boa.", position: 0,
}).select("id");
check("recommendation válida (tv, nota curta) aceita", okRec.error === null);

// UNIQUE (user,media,tmdb,kind): duplicata rejeitada; mesmo título no outro kind OK.
const dup = await A.client.from("profile_picks").insert(favA).select("id");
check("duplicata mesmo kind rejeitada (unique)", dup.error !== null);
const otherKind = await A.client.from("profile_picks").insert({
  ...favA, kind: "recommendation", note: "Clássico.",
}).select("id");
check("mesmo título no outro kind permitido", otherKind.error === null && otherKind.data?.length === 1);

// Deslogado (anon): nada escreve, nada lê.
const anon = createClient(SUPABASE_URL, KEY);
const anonIns = await anon.from("profile_picks").insert({ ...favA, user_id: A.id }).select("id");
check("deslogado NÃO insere (tabela)", anonIns.error !== null);
const anonSel = await anon.from("profile_picks").select("id").limit(1);
check("deslogado NÃO lê (tabela)", anonSel.error !== null || (anonSel.data ?? []).length === 0);

// Limpeza direta antes da parte HTTP.
await A.client.from("profile_picks").delete().eq("user_id", A.id);
await B.client.from("profile_picks").delete().eq("user_id", B.id);

// ------------------------------------------------- G. API: fluxo real (TMDB)
r = await api("POST", "/api/profile/picks", C.cookie, { tmdbId: 550, mediaType: "movie", kind: "favorite" });
check("POST favorite movie 550 → 200 + snapshot TMDB",
  r.res.status === 200 && !!r.json?.item?.id && typeof r.json.item.title === "string"
  && r.json.item.title.length > 0 && r.json.item.position === 0 && r.json.item.note === null);
const favId550 = r.json?.item?.id;
info(`snapshot favorite: "${r.json?.item?.title}" (${r.json?.item?.year ?? "s/ano"})`);

r = await api("POST", "/api/profile/picks", C.cookie, {
  tmdbId: 550, mediaType: "movie", kind: "favorite",
  title: "TÍTULO FALSO DO BROWSER", poster_path: "/falso.jpg", release_year: 1900,
});
check("duplicata favorite → 409 amigável (metadados do browser ignorados)",
  r.res.status === 409 && /já está nos seus favoritos/.test(r.json?.error || ""));

r = await api("POST", "/api/profile/picks", C.cookie, { tmdbId: 1396, mediaType: "tv", kind: "favorite" });
check("POST favorite tv 1396 → 200", r.res.status === 200 && !!r.json?.item?.id && r.json.item.position === 1);

r = await api("POST", "/api/profile/picks", C.cookie, {
  tmdbId: 550, mediaType: "movie", kind: "recommendation", note: "  Um clássico absoluto.  ",
});
check("mesmo título como recommendation → 200 (note com trim)",
  r.res.status === 200 && r.json?.item?.note === "Um clássico absoluto." && r.json.item.position === 0);
const recId550 = r.json?.item?.id;

r = await api("POST", "/api/profile/picks", C.cookie, {
  tmdbId: 550, mediaType: "movie", kind: "recommendation", note: "de novo",
});
check("duplicata recommendation → 409 amigável",
  r.res.status === 409 && /já está nas suas recomendações/.test(r.json?.error || ""));

r = await api("POST", "/api/profile/picks", C.cookie, { tmdbId: 999999999, mediaType: "movie", kind: "favorite" });
check("POST título inexistente TMDB → 404", r.res.status === 404);

r = await api("GET", "/api/profile/picks", C.cookie);
check("GET retorna seções ordenadas",
  r.res.status === 200 && Array.isArray(r.json?.favorites) && r.json.favorites.length === 2
  && r.json.favorites[0].tmdbId === 550 && r.json.favorites[1].tmdbId === 1396
  && Array.isArray(r.json?.recommendations) && r.json.recommendations.length === 1
  && r.json.recommendations[0].note === "Um clássico absoluto.");
check("GET sem vazar user_id/PII", !/"user_id"|@example/i.test(JSON.stringify(r.json)));

// Isolamento: B não vê picks de C via API.
r = await api("GET", "/api/profile/picks", B.cookie);
check("B vê só os próprios (0 de C)", r.res.status === 200
  && (r.json?.favorites ?? []).length === 0 && (r.json?.recommendations ?? []).length === 0);

// ------------------------------------------------- H. note 500/XSS + edição
const xss = '<script>alert(1)</script><img src=x onerror=alert(1)>';
r = await api("POST", "/api/profile/picks", C.cookie, {
  tmdbId: 603, mediaType: "movie", kind: "recommendation", note: xss,
});
check("note XSS aceita como texto (200)", r.res.status === 200 && r.json?.item?.note === xss);
const xssId = r.json?.item?.id;

r = await api("PATCH", "/api/profile/picks", C.cookie, { op: "note", id: xssId, note: "x".repeat(500) });
check("note 500 chars → 200", r.res.status === 200 && (r.json?.item?.note ?? "").length === 500);

r = await api("PATCH", "/api/profile/picks", C.cookie, { op: "note", id: xssId, note: "y".repeat(501) });
check("note 501 chars → 400", r.res.status === 400);

r = await api("PATCH", "/api/profile/picks", B.cookie, { op: "note", id: xssId, note: "invadido" });
check("B NÃO edita note de C (404, 0 linhas)", r.res.status === 404);

r = await api("PATCH", "/api/profile/picks", C.cookie, { op: "note", id: favId550, note: "tentando em favorito" });
check("editar note de favorito → 404", r.res.status === 404);

// ------------------------------------------------- I. reorder + remoção por kind
const orderIds = [603, 27205, 157336];
for (const id of orderIds) {
  r = await api("POST", "/api/profile/picks", A.cookie, { tmdbId: id, mediaType: "movie", kind: "favorite" });
  if (r.res.status !== 200) check(`seed reorder fav ${id} → 200`, false);
}
check("seed reorder: 3 favoritos de A", true);
r = await api("GET", "/api/profile/picks", A.cookie);
const beforeIds = (r.json?.favorites ?? []).map((p) => p.id);
check("ordem inicial A,B,C por position", r.res.status === 200 && beforeIds.length === 3);
const reversed = [...beforeIds].reverse();
r = await api("PATCH", "/api/profile/picks", A.cookie, { op: "reorder", kind: "favorite", orderedIds: reversed });
check("reorder C,B,A → 200", r.res.status === 200 && Array.isArray(r.json?.items) && r.json.items.length === 3);
r = await api("GET", "/api/profile/picks", A.cookie);
const afterIds = (r.json?.favorites ?? []).map((p) => p.id);
const afterPos = (r.json?.favorites ?? []).map((p) => p.position);
check("refresh mantém C,B,A + posições 0,1,2",
  JSON.stringify(afterIds) === JSON.stringify(reversed) && JSON.stringify(afterPos) === "[0,1,2]");

r = await api("PATCH", "/api/profile/picks", A.cookie, { op: "reorder", kind: "favorite", orderedIds: [beforeIds[0]] });
check("reorder incompleto → 404", r.res.status === 404);
r = await api("PATCH", "/api/profile/picks", B.cookie, { op: "reorder", kind: "favorite", orderedIds: reversed });
check("B NÃO reordena lista de A (404)", r.res.status === 404);

// Remoção por kind: 550 é fav + rec de C → remove fav, rec continua.
r = await api("DELETE", "/api/profile/picks", C.cookie, { id: favId550 });
check("DELETE favorite 550 → 200 removed", r.res.status === 200 && r.json?.removed === true);
r = await api("GET", "/api/profile/picks", C.cookie);
check("recommendation 550 continua (só aquele kind saiu)",
  (r.json?.recommendations ?? []).some((p) => p.id === recId550)
  && !(r.json?.favorites ?? []).some((p) => p.id === favId550));
check("posições compactadas após remoção",
  JSON.stringify((r.json?.favorites ?? []).map((p) => p.position)) === "[0]");

r = await api("DELETE", "/api/profile/picks", B.cookie, { id: recId550 });
check("B NÃO remove pick de C (removed false)", r.res.status === 200 && r.json?.removed === false);

// ------------------------------------------------- J. limites 12/6 (usuário B, tabela limpa)
const MOVIES12 = [550, 603, 27205, 157336, 155, 680, 13, 278, 238, 807, 122, 1891];
let favOk = 0;
for (const id of MOVIES12) {
  r = await api("POST", "/api/profile/picks", B.cookie, { tmdbId: id, mediaType: "movie", kind: "favorite" });
  if (r.res.status === 200) favOk += 1;
}
check("12 favoritos aceitos", favOk === 12);
r = await api("POST", "/api/profile/picks", B.cookie, { tmdbId: 1396, mediaType: "tv", kind: "favorite" });
check("13º favorito → 409 amigável",
  r.res.status === 409 && /até 12 favoritos/.test(r.json?.error || ""));

let recOk = 0;
for (const id of MOVIES12.slice(0, 6)) {
  r = await api("POST", "/api/profile/picks", B.cookie, {
    tmdbId: id, mediaType: "movie", kind: "recommendation", note: `Recomendo ${id}.`,
  });
  if (r.res.status === 200) recOk += 1;
}
check("6 recomendações aceitas", recOk === 6);
r = await api("POST", "/api/profile/picks", B.cookie, {
  tmdbId: 1399, mediaType: "tv", kind: "recommendation", note: "Sétima.",
});
check("7ª recomendação → 409 amigável",
  r.res.status === 409 && /até 6 títulos/.test(r.json?.error || ""));

// ------------------------------------------------- K. limpeza
for (const u of [A, B, C]) {
  await u.client.from("profile_picks").delete().eq("user_id", u.id);
}
const clean = await C.client.from("profile_picks").select("id");
check("limpeza: picks de teste removidas", clean.data?.length === 0);

// Limpeza: sem service_role no app, os usuários de teste (picks-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users.
console.log("---");
if (failures === 0 && skipped === 0) console.log("PICKS OK: Sobre + RLS + limites + reorder confirmados.");
else console.log(`PICKS ${failures === 0 ? "PARCIAL" : "FALHOU"}: ${failures} falha(s), ${skipped} skip(s).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
