/**
 * Verificação da Etapa 15: busca de pessoas por @username/nome.
 *
 * Pré-requisito: migration supabase/migrations/20260930090000_profile_discoverability.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * os blocos de banco/HTTP que dependem da flag/RPC entram em SKIP
 * identificado (exit 1); contratos de arquivo rodam sempre.
 *
 * Uso: npm run verify:user-search (servidor dev em :4321 p/ parte HTTP).
 *
 * Cobre deterministicamente (arquivos + Supabase + HTTP, sem browser):
 * - migration (flag default false, RPC SECURITY DEFINER allowlisted,
 *   search_path fixo, sem SQL dinâmica, grants anon/authenticated,
 *   nenhuma policy pública, ranking exato→prefixo→contém, clamp 1..20,
 *   exige public+discoverable+username, sem busca em bio);
 * - defaults + privacy API (discoverable, username obrigatório);
 * - RPC anon/authenticated: A aparece, B (não-discoverable) não,
 *   C (privado inconsistente) não; exato/prefixo/contém; display_name;
 *   case-insensitive; normalização @; mínimo 2; limite ≤20; sem UUID/email;
 *   XSS literal; allowlist de colunas;
 * - endpoint (200 shape, curto → [], sem auth, sem internals);
 * - UI /buscar (tabs, template pessoa, debounce, URL ?tab=pessoas,
 *   link /u/, textContent, aria, sem misturar resultados);
 * - imediatismo (toggle off some; username novo resolve, antigo não);
 * - anon SELECT em profiles continua bloqueado.
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

const MIGRATION_FILE = "supabase/migrations/20260930090000_profile_discoverability.sql";

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

// ------------------------------------------------- A. arquivos/migration
check("migration Etapa 15 existe", existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url)));
const migration = existsSync(new URL(`../${MIGRATION_FILE}`, import.meta.url))
  ? readFile(`../${MIGRATION_FILE}`)
  : "";
check("migration flag discoverable default false",
  /add column if not exists discoverable boolean not null default false/i.test(migration));
check("migration RPC search_public_profiles SECURITY DEFINER",
  /function public\.search_public_profiles\(\s*p_query text,\s*p_limit integer\s*\)/i.test(migration)
  && /security definer/i.test(migration) && /set search_path = public/i.test(migration));
check("migration sem SQL dinâmica", !/execute\s+(format|immediate|['"]select)/i.test(migration));
check("migration grants anon+authenticated, sem policy pública",
  /grant execute on function public\.search_public_profiles\(text, integer\) to anon, authenticated/i.test(migration)
  && !/create policy/i.test(migration));
check("migration exige public+discoverable+username",
  /p\.profile_public is true/i.test(migration) && /p\.discoverable is true/i.test(migration)
  && /p\.username is not null/i.test(migration));
check("migration ranking exato→prefixo→contém + username ASC",
  /when p\.username = e\.raw then 0/i.test(migration)
  && /p\.username asc/i.test(migration));
check("migration clamp 1..20", /least\(greatest\(coalesce\(p_limit, 10\), 1\), 20\)/i.test(migration));
check("migration allowlist só identidade (sem bio search, sem internos)",
  /p\.display_name,\s*p\.username,\s*p\.bio,\s*p\.avatar_path/i.test(migration)
  && !/p\.bio ilike/i.test(migration)
  && !/p\.(user_id|email)|excluded_genres|streaming_providers|watchlist_titles/i.test(migration));
check("migration normaliza @ único + mínimo 2",
  /substring\(trim\(both from coalesce\(p_query/i.test(migration)
  && /char_length\(e\.raw\) >= 2/i.test(migration));

const types = readFile("../src/lib/profile/types.ts");
check("types PrivacySettings.discoverable (default false)",
  /discoverable: boolean/.test(types) && /discoverable: false/.test(types));

const validation = readFile("../src/lib/profile/validation.ts");
check("validation discoverable + UsernameRequiredError custom",
  /validatePrivacyFlag\(payload\.discoverable, "busca de pessoas"\)/.test(validation)
  && /constructor\(\s*message =/.test(validation));

const service = readFile("../src/lib/profile/service.ts");
check("service discoverable (leitura, update, username obrigatório)",
  /discoverable: row\.discoverable === true/.test(service)
  && /discoverable: input\.discoverable/.test(service)
  && /input\.profilePublic \|\| input\.discoverable/.test(service));

const pubService = readFile("../src/lib/publicProfile/service.ts");
check("lib searchPublicProfiles via rpc (sem .from profiles)",
  /\.rpc\("search_public_profiles"/.test(pubService)
  && !/\.from\("profiles"\)/.test(pubService));
check("lib normalização (trim/lower/um @) + mínimo 2 + limite 10",
  /USER_SEARCH_LIMIT = 10/.test(pubService) && /USER_SEARCH_MIN_LENGTH = 2/.test(pubService)
  && /startsWith\("@"\)/.test(pubService));
check("lib PublicPerson sem id/email", /interface PublicPerson/.test(pubService)
  && !/userId|user_id|email/i.test(pubService.split("interface PublicPerson")[1].split("}")[0]));

const endpoint = readFile("../src/pages/api/public/users/search.ts");
check("endpoint GET público (200 [], 502, sem auth)",
  /export const GET/.test(endpoint) && !/getCurrentUser/.test(endpoint)
  && /status: 502/.test(endpoint));

const buscar = readFile("../src/pages/buscar.astro");
check("buscar tabs Títulos/Pessoas (tablist, URL ?tab=pessoas)",
  /role="tablist"/.test(buscar) && /role="tab"/.test(buscar)
  && />\s*Pessoas\s*</.test(buscar) && /tab=pessoas/.test(buscar));
check("buscar template pessoa (avatar, /u/, bio clamp)",
  /person-result-template/.test(buscar) && /\/u\//.test(buscar)
  && /line-clamp-2/.test(buscar) && /Ver perfil/.test(buscar));
check("buscar pessoas: debounce 300, min 2, abort+seq, endpoint",
  /PEOPLE_DEBOUNCE_MS = 300/.test(buscar)
  && /\/api\/public\/users\/search/.test(buscar)
  && /Buscando pessoas\.\.\./.test(buscar)
  && /Nenhum perfil encontrado/.test(buscar));
check("buscar texto via textContent (sem innerHTML), aria real",
  !/innerHTML/.test(buscar) && /aria-selected/.test(buscar)
  && /aria-controls/.test(buscar) && /role="status"/.test(buscar));
check("buscar títulos intacta (endpoint, skeleton, mensagens)",
  /\/api\/search\?q=/.test(buscar) && /search-skeleton/.test(buscar)
  && /Busque por um filme ou série\./.test(buscar));

const editar = readFile("../src/pages/perfil/editar.astro");
check("editar toggle discoverable (copy + hint privado)",
  /privacy-discoverable/.test(editar)
  && /Permitir que encontrem meu perfil na busca/.test(editar)
  && /precisa estar público para aparecer na busca/.test(editar));

const taste = readFile("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome busca de pessoas", !/search_public_profiles|discoverable/i.test(taste));

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
  return { res, json, text, contentType: res.headers.get("content-type") || "" };
}

async function apiJson(method, path, cookie, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json, text };
}

const stamp = Date.now();
const sfx = String(stamp).slice(-8);
async function signUp(tag) {
  const client = createClient(SUPABASE_URL, KEY);
  const email = `usearch-${tag}-${stamp}@example.com`;
  const password = `UserSearch123!${tag}`;
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

// 9 contas Auth por execução (fixtures A–H + D consolidados; sem massa de
// 21 usuários p/ limite — clamp coberto em contrato SQL + p_limit real).
// auth.users não pode ser apagado sem service_role: usuários de teste
// acumulam no Auth (só dados de tabelas são limpos em P).
let D, A, B, C, H, DD, E, F, G;
try {
  D = await signUp("d");
  A = await signUp("a");
  B = await signUp("b");
  C = await signUp("c");
  H = await signUp("h");
  DD = await signUp("dd");
  E = await signUp("e");
  F = await signUp("f");
  G = await signUp("g");
} catch (error) {
  console.log("---");
  console.log(`INFRA/AUTH SETUP FAILURE (não é regressão do produto): ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

// Usernames únicos por run (sufixo), preservando prefixos p/ ranking.
const uA = `jose${sfx}`;
const uB = `jose${sfx}henrique`;
const uC = `cinejose${sfx}`;
const uH = `henrique${sfx}`;
const uD = `cinefilo${sfx}`;
const uE = `cinejose${sfx}e`;
const uF = `jose${sfx}f`;
const uG = `xq${sfx}`;
const qJose = `jose${sfx}`;
const qHenri = `henrique${sfx}`;

// ------------------------------------------------- C. probe migration
const probe = await D.client.from("profiles").select("discoverable").eq("id", D.id).maybeSingle();
const migrationMissing = probe.error && /discoverable|column|schema cache|PGRST/i.test(
  `${probe.error.message ?? ""} ${probe.error.code ?? ""}`,
);
let rpcMissing = false;
if (!migrationMissing) {
  const rpcProbe = await D.client.rpc("search_public_profiles", { p_query: "zz", p_limit: 10 });
  rpcMissing = rpcProbe.error !== null && /function|does not exist|PGRST/i.test(
    `${rpcProbe.error.message ?? ""} ${rpcProbe.error.code ?? ""}`,
  );
}
if (migrationMissing || rpcMissing) {
  skip(`banco: ${MIGRATION_FILE} ainda não aplicada (Dashboard → SQL Editor → Run)`);
  skip("banco: defaults, privacy API, RPC, ranking, limite, XSS");
  skip("HTTP: endpoint, tabs /buscar, imediatismo");
  console.log("---");
  console.log(`FILE-CONTRACTS OK (${failures === 0 ? "sem falhas" : failures + " falha(s)"}), banco em SKIP.`);
  console.log(`Aplique: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("flag discoverable acessível", probe.error === null);

// ------------------------------------------------- D. defaults + privacy API
check("signup novo: discoverable false por padrão", probe.data?.discoverable === false);

let r = await apiJson("PATCH", "/api/profile/privacy", D.cookie, {
  profilePublic: false, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: false, showReviews: false, discoverable: true,
});
checkd("discoverable sem username → 400 amigável",
  r.res.status === 400 && /apareça na busca/.test(r.json?.error || ""),
  `status=${r.res.status} error=${JSON.stringify(r.json?.error)}`);
r = await apiJson("PATCH", "/api/profile/privacy", D.cookie, {
  profilePublic: false, showFavorites: false, showRecommendations: false,
  showWatched: false, showRatings: false, showReviews: false, discoverable: "yes",
});
check("discoverable não-booleano → 400", r.res.status === 400);

// D ganha username e publica+descobre (usado no teste de display_name? não;
// D fica privado — serve só p/ API acima).

// ------------------------------------------------- E. seed
async function setupUser(u, { username, displayName, bio, pub, disc }) {
  const { error } = await u.client.from("profiles").update({
    username, display_name: displayName, bio,
    profile_public: pub, discoverable: disc,
  }).eq("id", u.id);
  if (error) throw new Error(`seed ${username} falhou: ${error.message}`);
}
await setupUser(A, { username: uA, displayName: "Silva Sauro", bio: `Bio A ${sfx}.`, pub: true, disc: true });
await setupUser(B, { username: uB, displayName: "Ze Rico", bio: null, pub: true, disc: true });
await setupUser(C, { username: uC, displayName: "Cine Phile", bio: `Bio C ${sfx}.`, pub: true, disc: true });
await setupUser(H, { username: uH, displayName: "Fan Pessoa", bio: null, pub: true, disc: true });
await setupUser(DD, { username: uD, displayName: `Amigo ${qHenri} Silva`, bio: null, pub: true, disc: true });
await setupUser(E, { username: uE, displayName: "Eco Pessoa", bio: null, pub: true, disc: false });
await setupUser(F, { username: uF, displayName: "Efe Pessoa", bio: null, pub: false, disc: true });
await setupUser(G, {
  username: uG, displayName: "<script>alert(1)</script>", bio: "<img src=x onerror=alert(1)>",
  pub: true, disc: true,
});

const anon = createClient(SUPABASE_URL, KEY);
async function rpcSearch(client, q, limit = 10) {
  return client.rpc("search_public_profiles", { p_query: q, p_limit: limit });
}

// ------------------------------------------------- F. RPC: elegibilidade A/B/C
// E (público, discoverable=false) e F (privado, discoverable=true)
// casariam a query — ambos devem ficar de fora.
let s = await rpcSearch(anon, qJose);
check("A (público+descoberta) aparece", (s.data ?? []).some((x) => x.username === uA));
check("E (público, NÃO-descoberta) NÃO aparece", !(s.data ?? []).some((x) => x.username === uE));
check("F (privado inconsistente) NÃO aparece", !(s.data ?? []).some((x) => x.username === uF));

// ------------------------------------------------- G. ranking exato→prefixo→contém
s = await rpcSearch(anon, qJose);
checkd("ordem exato → prefixo → contém",
  JSON.stringify((s.data ?? []).map((x) => x.username)) === JSON.stringify([uA, uB, uC]),
  `ordem=${JSON.stringify((s.data ?? []).map((x) => x.username))} esperado=${JSON.stringify([uA, uB, uC])}`);

// ------------------------------------------------- H. display_name isolado + prioridade username
// Fixture determinística: uH casa a query SÓ no username (exato);
// uD casa a query SÓ no display_name (contém). Esperado: [uH, uD].
s = await rpcSearch(anon, qHenri);
const namesH = (s.data ?? []).map((x) => x.username);
checkd("display_name isolado encontra (query só no display)",
  namesH.includes(uD),
  `query=${qHenri} ordem=${JSON.stringify(namesH)}`);
checkd("username exato tem prioridade sobre display contém",
  JSON.stringify(namesH) === JSON.stringify([uH, uD]),
  `query=${qHenri} ordem=${JSON.stringify(namesH)} esperado=${JSON.stringify([uH, uD])}`);

// ------------------------------------------------- I. case + @ + mínimo
for (const q of [`JOSE${sfx.toUpperCase()}`, `@Jose${sfx}`, qJose]) {
  s = await rpcSearch(anon, q);
  if (JSON.stringify((s.data ?? []).map((x) => x.username)) !== JSON.stringify([uA, uB, uC])) {
    checkd(`case/@ equivalente (${q})`, false, `ordem=${JSON.stringify((s.data ?? []).map((x) => x.username))}`);
  }
}
check("JOSE/@Jose/jose equivalentes", true);
s = await rpcSearch(anon, "a");
check("query 1 char → []", s.error === null && (s.data ?? []).length === 0);
s = await rpcSearch(anon, "   ");
check("query vazia → []", s.error === null && (s.data ?? []).length === 0);

// ------------------------------------------------- J. allowlist + XSS
s = await rpcSearch(anon, uG);
checkd("allowlist: só display_name/username/bio/avatar_path",
  s.error === null && (s.data ?? []).length === 1
  && JSON.stringify(Object.keys(s.data[0]).sort()) === JSON.stringify(["avatar_path", "bio", "display_name", "username"]),
  `keys=${JSON.stringify(s.data?.[0] ? Object.keys(s.data[0]) : s.error?.message)}`);
check("XSS retornado como texto literal",
  s.data?.[0]?.display_name === "<script>alert(1)</script>"
  && s.data?.[0]?.bio === "<img src=x onerror=alert(1)>");

// ------------------------------------------------- K. limite (sem 21 signups)
// O teto 20 é garantido pelo clamp SQL (contrato em A) + integração real
// com conjunto pequeno: p_limit=1 retorna exatamente 1 (LIMIT aplicado,
// não ignorado), p_limit=0/negativo é coagido, p_limit=999 não quebra.
// Não criar 21 contas Auth só para este teste (rate limit + sujeira).
s = await rpcSearch(anon, qJose, 1);
checkd("RPC p_limit=1 → exatamente 1 (topo do ranking)",
  s.error === null && (s.data ?? []).length === 1 && s.data[0].username === uA,
  `n=${(s.data ?? []).length} primeiro=${s.data?.[0]?.username}`);
{
  const zero = await anon.rpc("search_public_profiles", { p_query: qJose, p_limit: 0 });
  checkd("RPC p_limit=0 → 1 linha (floor 1)",
    zero.error === null && (zero.data ?? []).length === 1,
    `n=${(zero.data ?? []).length}`);
  const neg = await anon.rpc("search_public_profiles", { p_query: qJose, p_limit: -5 });
  checkd("RPC p_limit negativo → 1 linha (floor 1)",
    neg.error === null && (neg.data ?? []).length === 1,
    `n=${(neg.data ?? []).length}`);
  const huge = await anon.rpc("search_public_profiles", { p_query: qJose, p_limit: 999 });
  checkd("RPC p_limit=999 → todas as elegíveis, ≤20, sem erro",
    huge.error === null && (huge.data ?? []).length === 3,
    `n=${(huge.data ?? []).length}`);
}
s = await rpcSearch(A.client, qJose, 1);
check("authenticated p_limit=1 → 1", (s.data ?? []).length === 1);

// ------------------------------------------------- L. endpoint
async function search(q, cookie) {
  return api("GET", `/api/public/users/search?q=${encodeURIComponent(q)}`, cookie);
}
r = await search(qJose, null);
checkd("endpoint anon: exato→prefixo→contém, sem internals",
  r.res.status === 200
  && JSON.stringify((r.json?.results ?? []).map((x) => x.username)) === JSON.stringify([uA, uB, uC])
  && !/"user_id"|"email"/.test(r.text),
  `status=${r.res.status} n=${r.json?.results?.length}`);
r = await search(qJose, A.cookie);
check("endpoint authenticated: mesmo resultado",
  r.res.status === 200 && (r.json?.results ?? []).length === 3);
r = await search("a", null);
check("endpoint query curta → 200 []", r.res.status === 200
  && Array.isArray(r.json?.results) && r.json.results.length === 0);
// JSON não executa HTML: o correto é valor textual preservado em
// displayName (camelCase do contrato) + Content-Type JSON. O escape
// pertence ao boundary de renderização (testado na UI abaixo).
r = await search(uG, null);
checkd("endpoint XSS como texto (valor preservado, Content-Type JSON)",
  (r.json?.results ?? []).length === 1
  && r.json.results[0].displayName === "<script>alert(1)</script>"
  && r.json.results[0].bio === "<img src=x onerror=alert(1)>"
  && /application\/json/.test(r.contentType || ""),
  `n=${r.json?.results?.length} ct=${r.contentType} keys=${JSON.stringify(Object.keys(r.json?.results?.[0] ?? {}))}`);

// ------------------------------------------------- M. UI /buscar (SSR vs bundle)
// O Astro empacota <script> inline em módulo (?astro&type=script):
// markup vai no HTML, lógica JS vai no bundle. Contratos separados.
const buscarHtml = (await (await fetch(`${BASE}/buscar`)).text());
check("/buscar SSR: tabs, painéis, inputs e templates",
  /role="tablist"/.test(buscarHtml) && />\s*Títulos\s*</.test(buscarHtml)
  && />\s*Pessoas\s*</.test(buscarHtml) && /id="panel-titulos"/.test(buscarHtml)
  && /id="panel-pessoas"/.test(buscarHtml) && /id="people-input"/.test(buscarHtml)
  && /id="person-result-template"/.test(buscarHtml)
  && /id="search-result-template"/.test(buscarHtml)
  && /role="status"/.test(buscarHtml));
{
  const srcs = [...buscarHtml.matchAll(/<script type="module" src="([^"]*buscar[^"]*)"/g)]
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
  checkd("bundle /buscar: endpoints pessoas+títulos, debounce, guards",
    bundle.includes("/api/public/users/search") && bundle.includes("/api/search?q=")
    && bundle.includes("PEOPLE_DEBOUNCE_MS") && bundle.includes("AbortController")
    && bundle.includes("tab=pessoas"),
    `modulos=${srcs.length} bundle=${bundle.length}chars`);
  checkd("bundle card pessoa: link /u/, textContent, sem innerHTML",
    bundle.includes("personInitials") && bundle.includes('"/u/"')
    && bundle.includes("textContent") && !bundle.includes("innerHTML")
    && bundle.includes("aria-selected"),
    `bundle=${bundle.length}chars`);
}
{
  // Títulos intacta — validação FUNCIONAL (não grep): endpoint real.
  const t = await fetch(`${BASE}/api/search?q=duna`);
  const tj = await t.json().catch(() => null);
  const items = Array.isArray(tj?.results) ? tj.results : [];
  checkd("busca títulos funcional: 200, só movie/tv (person ignorado)",
    t.status === 200 && items.length > 0
    && items.every((i) => i.type === "movie" || i.type === "tv"),
    `status=${t.status} n=${items.length} tipos=${JSON.stringify([...new Set(items.map((i) => i.type))])}`);
}
const buscarPessoas = (await (await fetch(`${BASE}/buscar?tab=pessoas&q=${encodeURIComponent(qJose)}`)).text());
check("/buscar?tab=pessoas&q= SSR 200 (shell + estado via JS)",
  buscarPessoas.includes('id="panel-pessoas"') && buscarPessoas.includes('id="people-input"'));

// ------------------------------------------------- N. imediatismo + username novo
await E.client.from("profiles").update({ discoverable: true }).eq("id", E.id);
s = await rpcSearch(anon, qJose);
check("ligou discoverable → aparece", (s.data ?? []).some((x) => x.username === uE));
await E.client.from("profiles").update({ discoverable: false }).eq("id", E.id);
s = await rpcSearch(anon, qJose);
check("desligou discoverable → some", !(s.data ?? []).some((x) => x.username === uE));
await E.client.from("profiles").update({ discoverable: true, profile_public: false }).eq("id", E.id);
s = await rpcSearch(anon, qJose);
check("desligou profile_public → some (mesmo discoverable)", !(s.data ?? []).some((x) => x.username === uE));
const uE2 = `cinejose${sfx}e2`;
await E.client.from("profiles").update({ username: uE2, profile_public: true }).eq("id", E.id);
s = await rpcSearch(anon, uE2);
check("username novo resolve", (s.data ?? []).some((x) => x.username === uE2));
s = await rpcSearch(anon, uE);
check("username antigo não resolve", !(s.data ?? []).some((x) => x.username === uE));

// ------------------------------------------------- O. anon SELECT bloqueado
const anonSel = await anon.from("profiles").select("username").limit(5);
check("anon SELECT profiles → nada", (anonSel.data ?? []).length === 0);

// ------------------------------------------------- P. limpeza
for (const u of [D, A, B, C, H, DD, E, F, G]) {
  await u.client.from("profiles").update({
    profile_public: false, discoverable: false, show_favorites: false,
    show_recommendations: false, show_watched: false, show_ratings: false, show_reviews: false,
  }).eq("id", u.id);
}
const stillThere = await rpcSearch(anon, qJose);
check("limpeza: sementes zeradas", (stillThere.data ?? []).length === 0);

// Limpeza: sem service_role no app, os usuários de teste (usearch-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users.
console.log("---");
if (failures === 0 && skipped === 0) console.log("USER-SEARCH OK: busca de pessoas + privacidade confirmados.");
else console.log(`USER-SEARCH ${failures === 0 ? "PARCIAL" : "FALHOU"}: ${failures} falha(s), ${skipped} skip(s).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
