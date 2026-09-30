/**
 * Verificação da Etapa 24: readiness para produção (contratos, sem features).
 *
 * Foco em readiness/contratos e NÃO cria dezenas de usuários (no máximo
 * ZERO signups: usa só probes anônimas + leitura de arquivos + HTTP público).
 * Pré-requisito parcial: servidor (dev :4321 ou prod) p/ checks live;
 * sem servidor, a parte live entra em SKIP identificado (exit 1).
 *
 * Uso: npm run verify:production
 *
 * Cobre (arquivos + HTTP live, sem browser):
 * - env contract (nomes, sem valores): server-only sem prefixo PUBLIC_,
 *   públicas só Supabase + SITE_URL; .env.example completo;
 * - .gitignore (.env*, dist, node_modules);
 * - service_role ausente em src/public/supabase;
 * - secrets server-only fora de client/public (TMDB/GROQ/GEMINI);
 * - SECURITY DEFINER: search_path fixo, sem SQL dinâmica, helpers
 *   internos revogados, sem escrita anon;
 * - APIs: métodos, auth, limites, erros genéricos (estático);
 * - sanitizeNext unitário (incl. bypass `/\evil` da Etapa 24);
 * - SEO: Layout (noindex/OG/canonical), páginas privadas noindex;
 * - produção: start script, adapter standalone, Home prerender,
 *   Astro.session sem uso, /api/health live, dist sem secrets.
 *
 * Nenhum segredo é impresso: só PASS/FAIL/SKIP por asserção.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

const BASE = "http://localhost:4321";

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
function lsRecursive(dirUrl, out = []) {
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    const child = entry.isDirectory()
      ? new URL(`./${entry.name}/`, dirUrl)
      : new URL(`./${entry.name}`, dirUrl);
    if (entry.isDirectory()) lsRecursive(child, out);
    else out.push(child);
  }
  return out;
}

// ------------------------------------------------- A. env contract (nomes, sem valores)
const pkg = JSON.parse(readFile("../package.json"));
const envExample = existsSync(new URL("../.env.example", import.meta.url))
  ? readFile("../.env.example")
  : "";
const SERVER_ONLY = ["TMDB_ACCESS_TOKEN", "GROQ_API_KEY", "GEMINI_API_KEY"];
const SERVER_OPT = ["GROQ_MODEL", "GEMINI_MODEL"];
const PUBLIC_OK = ["PUBLIC_SUPABASE_URL", "PUBLIC_SUPABASE_PUBLISHABLE_KEY", "PUBLIC_SITE_URL"];
checkd(".env.example cobre server-only + públicas (sem valores reais)",
  SERVER_ONLY.every((v) => new RegExp(`^${v}=$`, "m").test(envExample))
  && SERVER_OPT.every((v) => new RegExp(`^${v}=$`, "m").test(envExample))
  && PUBLIC_OK.every((v) => new RegExp(`^${v}=$`, "m").test(envExample))
  && !/^\s*(SUPABASE_)?SERVICE_ROLE_KEY?\s*=/m.test(envExample),
  "vars ausentes no example");
const srcFiles = lsRecursive(new URL("../src/", import.meta.url))
  .filter((u) => /\.(ts|astro|js)$/.test(u.pathname))
  .map((u) => ({ url: u, text: readFileSync(u, "utf8") }));
const clientHits = srcFiles.filter(({ url, text }) =>
  /<script[\s>]/.test(text)
  && SERVER_ONLY.some((v) => text.includes(v))
  && !/<!--|server-only|nunca/i.test(text.split(SERVER_ONLY.find((v) => text.includes(v)) ?? "")[0]?.slice(-200) ?? ""),
).map(({ url }) => url.pathname);
checkd("secrets server-only fora de <script> browser", clientHits.length === 0, clientHits.slice(0, 3).join(","));
const publicDir = existsSync(new URL("../public/", import.meta.url))
  ? lsRecursive(new URL("../public/", import.meta.url))
  : [];
const publicHits = publicDir.filter((u) => {
  try {
    const t = readFileSync(u, "utf8");
    return SERVER_ONLY.some((v) => t.includes(v));
  } catch { return false; }
});
check("nada de secret em public/", publicHits.length === 0);

// ------------------------------------------------- B. gitignore + service_role
const gitignore = existsSync(new URL("../.gitignore", import.meta.url))
  ? readFile("../.gitignore")
  : "";
check(".gitignore cobre .env/.env.local/.env.production + dist",
  /^\.env$/m.test(gitignore) && /^\.env\.local$/m.test(gitignore)
  && /^\.env\.production$/m.test(gitignore) && /^dist\/$/m.test(gitignore));
const srHits = srcFiles.filter(({ text }) =>
  /service_role|SERVICE_ROLE|serviceRole/.test(text)
  && !/nunca service_role|sem .*service_role|somente chave publishable/i.test(text));
checkd("service_role ausente no app (src)", srHits.length === 0,
  srHits.slice(0, 3).map((s) => s.url.pathname).join(","));
const migDir = new URL("../supabase/migrations/", import.meta.url);
/** SQL sem comentários (asserts testam código, não prosa). */
function sqlCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}
const migSrReal = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => /service_role/i.test(sqlCode(readFile(`../supabase/migrations/${f}`))));
check("service_role ausente nas migrations (uso real)", migSrReal.length === 0);

// ------------------------------------------------- C. SECURITY DEFINER / grants
const migFiles = readdirSync(migDir).filter((f) => f.endsWith(".sql"));
const migTexts = migFiles.map((f) => ({ f, text: sqlCode(readFile(`../supabase/migrations/${f}`)) }));
const definerCount = migTexts.reduce((n, { text }) =>
  n + (text.match(/security definer/gi) || []).length, 0);
const searchPathCount = migTexts.reduce((n, { text }) =>
  n + (text.match(/set\s+search_path\s*(=|to)\s*public/gi) || []).length, 0);
checkd("toda SECURITY DEFINER com search_path fixo",
  definerCount > 0 && searchPathCount >= definerCount,
  `definer=${definerCount} search_path=${searchPathCount}`);
const dynSql = migTexts.filter(({ text }) =>
  /execute\s+format|execute\s+['"]select|execute\s+['"]insert|execute\s+['"]delete|execute\s+immediate/i.test(text));
check("sem SQL dinâmica nas migrations", dynSql.length === 0);
const blocksMig = migTexts.find(({ f }) => /user_blocks/.test(f))?.text ?? "";
check("helpers internos revogados (users_are_blocked/apply_user_block)",
  /revoke all on function public\.users_are_blocked/i.test(blocksMig)
  && /revoke all on function public\.apply_user_block/i.test(blocksMig)
  && !/^[^-]*grant execute on function public\.(users_are_blocked|apply_user_block)/gim.test(blocksMig));
const WRITE_FNS = ["follow_user_by_username", "unfollow_user_by_username",
  "like_rating_by_username", "unlike_rating_by_username",
  "create_rating_comment_by_username", "update_rating_comment", "delete_rating_comment",
  "create_rating_comment_reply", "update_rating_comment_reply", "delete_rating_comment_reply",
  "block_user_by_username", "block_my_follower", "unblock_user", "remove_my_follower",
  "mark_my_notifications_read", "mark_all_my_notifications_read"];
const anonWriteHits = [];
for (const { f, text } of migTexts) {
  const grants = text.match(/grant execute on function [^;]+;/gi) || [];
  for (const g of grants) {
    const fn = (g.match(/function public\.(\w+)/i) || [])[1] ?? "?";
    if (WRITE_FNS.includes(fn) && /\bto\s+anon\b/i.test(g)) anonWriteHits.push(`${f}:${fn}`);
  }
}
checkd("nenhuma escrita com GRANT a anon", anonWriteHits.length === 0, anonWriteHits.join(","));

// ------------------------------------------------- D. API contracts (estático)
const apiFiles = srcFiles.filter(({ url }) => /src\/pages\/api\//.test(url.pathname));
checkd("APIs sem handler ALL genérico", !apiFiles.some(({ text }) => /export const ALL/.test(text)), "");
const noAuthPublic = ["search.ts", "streaming.ts", "explore.ts", "discovery/recommendations.ts",
  "discovery/replacement.ts", "discovery/adaptive-question.ts", "discovery/context-version.ts",
  "auth/user.ts", "auth/logout.ts", "health.ts"];
const authMissing = apiFiles.filter(({ url, text }) => {
  const short = url.pathname.split("src/pages/api/")[1];
  if (noAuthPublic.some((p) => short.endsWith(p))) return false;
  if (/src\/pages\/api\/public\//.test(url.pathname)) return false;
  if (/src\/pages\/api\/ratings\/comments\/replies\.ts$/.test(url.pathname)) return false;
  if (/src\/pages\/api\/ratings\/(comments|likes)\.ts$/.test(url.pathname)) return false;
  return !/get[A-Z][a-zA-Z]*Session|getCurrentUser/.test(text);
});
checkd("APIs sensíveis exigem sessão server-side", authMissing.length === 0,
  authMissing.slice(0, 3).map((s) => s.url.pathname).join(","));
const cachePriv = ["api/follows/state.ts", "api/followers/mine.ts", "api/feed/following.ts",
  "api/notifications.ts", "api/notifications/unread-count.ts"];
const cacheMissing = cachePriv.filter((p) => {
  const hit = srcFiles.find(({ url }) => url.pathname.endsWith(`src/pages/${p}`));
  return !hit || !/privateJson|private,\s*no-store/.test(hit.text);
});
checkd("GETs do dono com Cache-Control private (Etapa 24)", cacheMissing.length === 0, cacheMissing.join(","));
const blocksApi = srcFiles.find(({ url }) => url.pathname.endsWith("src/pages/api/blocks.ts"));
check("blocks GET com Cache-Control private", !!blocksApi && /privateJson/.test(blocksApi.text));

// ------------------------------------------------- E. sanitizeNext unitário (Etapa 24)
let sanitizeOk = false;
let sanitizeDetail = "import falhou";
try {
  const mod = await import("../src/lib/supabase/server.ts");
  const cases = [
    ["/perfil", "/perfil"],
    ["/u/foo/seguindo", "/u/foo/seguindo"],
    ["https://malicioso.com", "/perfil"],
    ["//malicioso.com", "/perfil"],
    ["/\\malicioso.com", "/perfil"],
    ["javascript:alert(1)", "/perfil"],
    ["data:text/html,x", "/perfil"],
    ["", "/perfil"],
    [null, "/perfil"],
    ["/perfil?x=1\\", "/perfil"],
  ];
  const bad = cases.filter(([input, expected]) => mod.sanitizeNext(input) !== expected);
  sanitizeOk = bad.length === 0;
  sanitizeDetail = bad.map(([i]) => JSON.stringify(i)).join(",") || "10/10 casos";
} catch (error) {
  sanitizeDetail = error instanceof Error ? error.message : String(error);
}
checkd("sanitizeNext: só path interno (incl. bypass backslash)", sanitizeOk, sanitizeDetail);

// ------------------------------------------------- F. SEO / Layout
const layout = readFile("../src/layouts/Layout.astro");
check("Layout: noindex + OG/Twitter + canonical opcional",
  /name="robots" content="noindex/.test(layout) && /og:title/.test(layout)
  && /twitter:card/.test(layout) && /rel="canonical"/.test(layout)
  && /PUBLIC_SITE_URL/.test(layout) && !/cinevee\.com/.test(layout));
const privatePages = ["perfil.astro", "perfil/editar.astro", "perfil/seguidores.astro",
  "perfil/bloqueados.astro", "perfil/lista.astro", "perfil/sobre.astro",
  "perfil/assistidos.astro", "perfil/avaliacoes.astro", "notificacoes.astro",
  "seguindo.astro", "entrar.astro", "cadastrar.astro", "buscar.astro"];
const noindexMissing = privatePages.filter((p) => {
  const hit = srcFiles.find(({ url }) => url.pathname.endsWith(`src/pages/${p}`));
  return !hit || !/noindex/.test(hit.text);
});
checkd("páginas privadas/auth/busca com noindex", noindexMissing.length === 0, noindexMissing.join(","));
const pubNoindex = ["u/[username].astro", "titulo/[type]/[id].astro", "index.astro"]
  .filter((p) => {
    const hit = srcFiles.find(({ url }) => url.pathname.endsWith(`src/pages/${p}`));
    return hit && /noindex/.test(hit.text);
  });
check("públicas (home/título/perfil) seguem indexáveis", pubNoindex.length === 0);

// ------------------------------------------------- G. produção: scripts/adapter/session/prerender
check("start script = node ./dist/server/entry.mjs",
  pkg.scripts?.start === "node ./dist/server/entry.mjs");
const astroConfig = readFile("../astro.config.mjs");
check("adapter @astrojs/node standalone",
  /@astrojs\/node/.test(astroConfig) && /mode:\s*['"]standalone['"]/.test(astroConfig));
const indexPage = readFile("../src/pages/index.astro");
const buscarPage = readFile("../src/pages/buscar.astro");
const descobrirPage = readFile("../src/pages/descobrir.astro");
check("Home/buscar/descobrir continuam prerendered",
  /prerender\s*=\s*true/.test(indexPage) && /prerender\s*=\s*true/.test(buscarPage)
  && /prerender\s*=\s*true/.test(descobrirPage));
const sessionUse = srcFiles.filter(({ text }) => /Astro\.session|context\.session/.test(text));
check("Astro.session sem uso (filesystem storage inerte)", sessionUse.length === 0);
check("404/500 próprias existem",
  existsSync(new URL("../src/pages/404.astro", import.meta.url))
  && existsSync(new URL("../src/pages/500.astro", import.meta.url)));

// ------------------------------------------------- H. live (servidor?) + dist scan
let http = true;
try {
  await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
} catch {
  http = false;
  console.log("SKIP  servidor indisponível em :4321 (parte live pulada).");
}
if (!http) {
  skip("live: /api/health {ok:true} sem segredos");
  skip("live: Home 200 + OG sem canonical fictício");
  skip("live: /perfil deslogado redireciona p/ login");
  skip("live: 404 customizada");
  skip("live: Cache-Control private em GET do dono (401 sem sessão)");
} else {
  const getPage = async (path) => {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    return { res, html: await res.text().catch(() => "") };
  };
  const h = await (await fetch(`${BASE}/api/health`)).json().catch(() => null);
  checkd("live: /api/health {ok:true} sem segredos",
    h?.ok === true && !/key|token|secret|uuid|supabase/i.test(JSON.stringify(h)),
    JSON.stringify(h)?.slice(0, 120));
  const home = await getPage("/");
  checkd("live: Home 200 + OG, sem canonical fictício",
    home.res.status === 200 && /og:title/.test(home.html) && !/cinevee\.com/i.test(home.html),
    `status=${home.res.status}`);
  const perfil = await getPage("/perfil");
  checkd("live: /perfil deslogado → login (303)",
    perfil.res.status === 303 && /\/entrar\?next=/.test(perfil.res.headers.get("location") ?? ""),
    `status=${perfil.res.status}`);
  const nf = await getPage("/rota-que-nao-existe-24");
  checkd("live: 404 customizada", nf.res.status === 404 && /não encontrada/i.test(nf.html),
    `status=${nf.res.status}`);
  const st = await fetch(`${BASE}/api/follows/state?username=x`, { redirect: "manual" });
  checkd("live: GET do dono sem sessão → 401 (não vaza)",
    st.status === 401, `status=${st.status}`);
}
const distUrl = new URL("../dist/", import.meta.url);
if (!existsSync(distUrl)) {
  skip("dist: scan de secrets (sem build local)");
} else {
  const distFiles = lsRecursive(distUrl).filter((u) => /\.(js|html|json)$/.test(u.pathname));
  const secretHits = [];
  for (const u of distFiles) {
    let t = "";
    try { t = readFileSync(u, "utf8"); } catch { continue; }
    // Heurística: Bearer TMDB/Groq/Gemini ou chave longa típica; nomes de
    // var sozinhos não contam (falso-positivo) — procura valor plausível.
    if (/Bearer\s+[A-Za-z0-9\-_]{20,}/.test(t) && /eyJ|groq|gsk_|AIza/i.test(t)) {
      secretHits.push(u.pathname);
    }
  }
  checkd("dist: sem Bearer token real em client/HTML", secretHits.length === 0,
    secretHits.slice(0, 2).join(","));
}

console.log("---");
console.log(failures === 0 && skipped === 0
  ? "PRODUCTION OK: contratos de readiness confirmados."
  : `PRODUCTION FALHOU: ${failures} asserção(ões), ${skipped} skip(s).`);
process.exit(failures === 0 && skipped === 0 ? 0 : 1);
