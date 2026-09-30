/**
 * Verificação da Etapa 11: Explore (páginas expandidas + filtros).
 *
 * Uso: npm run verify:explore (servidor dev em :4321 para a parte HTTP).
 *
 * Cobre deterministicamente:
 * - presets (allowlist, slug desconhecido);
 * - filtros (tipo/gênero/ano/streaming, coerções, contagem, page);
 * - dedupe por mediaType:id;
 * - 5 rotas SSR (constraints de tipo/gênero/ano, cards, links Home);
 * - API (shape, páginas válidas e internamente deduplicadas, 404/400, coerção);
 * - fusão Carregar mais com overlap simulado (A B C + C D E → A B C D E);
 * - plumbing do Carregar mais (data attrs + template).
 *
 * Sem IA, sem Supabase, sem login. Nenhum segredo impresso.
 */
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

const presets = await import("../src/lib/explore/presets.ts");
const filtersMod = await import("../src/lib/explore/filters.ts");
const service = await import("../src/lib/explore/service.ts");

const BASE = "http://localhost:4321";

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
const info = (msg) => console.log(`INFO  ${msg}`);

// ------------------------------------------------------- puro: presets
check("5 slugs válidos", (
  presets.EXPLORE_SLUGS.length === 5 &&
  ["em-alta", "nos-streamings", "muito-bem-avaliados", "filmes-populares", "series-populares"]
    .every((s) => presets.getExplorePreset(s)?.slug === s)
));
check("slug desconhecido → null", presets.getExplorePreset("top-пираты") === null && presets.getExplorePreset("") === null);
check("tipos fixos só em populares", (
  presets.getExplorePreset("filmes-populares")?.mediaTypeLocked === true &&
  presets.getExplorePreset("filmes-populares")?.defaultMediaType === "movie" &&
  presets.getExplorePreset("series-populares")?.mediaTypeLocked === true &&
  presets.getExplorePreset("series-populares")?.defaultMediaType === "tv" &&
  presets.getExplorePreset("em-alta")?.mediaTypeLocked === false
));

// ------------------------------------------------------- puro: filtros
const emAlta = presets.getExplorePreset("em-alta");
const filmes = presets.getExplorePreset("filmes-populares");
const get = (obj) => (name) => obj[name] ?? null;
check("tipo inválido → default", filtersMod.parseExploreFilters(emAlta, get({ tipo: "banana" })).mediaType === "all");
check("tipo válido passa", filtersMod.parseExploreFilters(emAlta, get({ tipo: "tv" })).mediaType === "tv");
check("preset fixo coage tipo", filtersMod.parseExploreFilters(filmes, get({ tipo: "tv" })).mediaType === "movie");
check("genero inválido → all; válido passa", (
  filtersMod.parseExploreFilters(emAlta, get({ genero: "xx" })).genre === "all" &&
  filtersMod.parseExploreFilters(emAlta, get({ genero: "horror" })).genre === "horror"
));
const nextYear = new Date().getFullYear() + 1;
check("ano inválido → null; válido passa", (
  filtersMod.parseExploreFilters(emAlta, get({ ano: "abc" })).year === null &&
  filtersMod.parseExploreFilters(emAlta, get({ ano: "1800" })).year === null &&
  filtersMod.parseExploreFilters(emAlta, get({ ano: String(nextYear) })).year === null &&
  filtersMod.parseExploreFilters(emAlta, get({ ano: "2024" })).year === 2024 &&
  filtersMod.parseExploreFilters(emAlta, get({ ano: "" })).year === null
));
check("streaming inválido → all; válido passa", (
  filtersMod.parseExploreFilters(emAlta, get({ streaming: "hbo" })).streaming === "all" &&
  filtersMod.parseExploreFilters(emAlta, get({ streaming: "netflix" })).streaming === "netflix"
));
check("contagem de filtros ativos", (
  filtersMod.activeFilterCount(emAlta, { mediaType: "all", genre: "all", year: null, streaming: "all" }) === 0 &&
  filtersMod.activeFilterCount(emAlta, { mediaType: "movie", genre: "action", year: 2025, streaming: "netflix" }) === 4 &&
  filtersMod.activeFilterCount(filmes, { mediaType: "movie", genre: "all", year: null, streaming: "all" }) === 0
));
check("query canonica roundtrip", (() => {
  const f = { mediaType: "movie", genre: "action", year: 2025, streaming: "netflix" };
  const q = filtersMod.filtersToQuery(f);
  const back = filtersMod.parseExploreFilters(emAlta, (n) => new URLSearchParams(q).get(n));
  return JSON.stringify(back) === JSON.stringify(f);
})());
check("page: ''→1, '3'→3, '0'/'abc'/'1001'→null", (
  filtersMod.parseExplorePage(null) === 1 && filtersMod.parseExplorePage("3") === 3 &&
  filtersMod.parseExplorePage("0") === null && filtersMod.parseExplorePage("abc") === null &&
  filtersMod.parseExplorePage("1001") === null
));
check("dedupe por type:id", (() => {
  const items = [
    { id: 1, type: "movie" }, { id: 1, type: "movie" }, { id: 1, type: "tv" },
  ];
  const out = service.dedupeExploreItems(items);
  return out.length === 2;
})());

// --------------------------------- suporte gênero × tipo (auditoria)
const allKeys = ["action", "adventure", "animation", "comedy", "crime", "documentary", "drama", "fantasy", "horror", "mystery", "romance", "science_fiction", "thriller"];
check("horror só em movie; demais em movie+tv+all", (
  allKeys.every((g) => filtersMod.isGenreSupportedFor("movie", g)) &&
  allKeys.filter((g) => g !== "horror").every((g) => filtersMod.isGenreSupportedFor("tv", g)) &&
  allKeys.filter((g) => g !== "horror").every((g) => filtersMod.isGenreSupportedFor("all", g)) &&
  filtersMod.isGenreSupportedFor("tv", "horror") === false &&
  filtersMod.isGenreSupportedFor("all", "horror") === false &&
  filtersMod.isGenreSupportedFor("movie", "all") === true
));
check("opções por tipo (movie 13, tv/all 12 sem horror)", (
  filtersMod.getAvailableExploreGenres("movie").length === 13 &&
  filtersMod.getAvailableExploreGenres("movie").includes("horror") &&
  filtersMod.getAvailableExploreGenres("tv").length === 12 &&
  !filtersMod.getAvailableExploreGenres("tv").includes("horror") &&
  !filtersMod.getAvailableExploreGenres("all").includes("horror")
));
{
  // tv+horror: vazio EXPLÍCITO sem nenhum fetch TMDB (determinístico).
  const r = await service.fetchExplorePage(
    presets.getExplorePreset("series-populares"),
    { mediaType: "tv", genre: "horror", year: null, streaming: "all" },
    1,
  );
  check("tv+horror: vazio explícito, sem consulta genérica",
    r.items.length === 0 && r.unsupportedCombination === true && r.hasMore === false);
}

// ------------------------------------------------------- HTTP
let http = true;
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
} catch {
  http = false;
  console.log("SKIP  servidor dev indisponível em :4321 — parte HTTP pulada.");
}
if (!http) process.exit(1);

async function getPage(path) {
  const res = await fetch(`${BASE}${path}`);
  return { res, html: await res.text() };
}
async function getApi(qs) {
  const res = await fetch(`${BASE}/api/explore${qs}`);
  const json = await res.json().catch(() => null);
  return { res, json };
}
const cardKeys = (html) => [...html.matchAll(/data-key="(movie|tv):(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);

// 5 presets SSR
const presetPaths = ["/explorar/em-alta", "/explorar/nos-streamings", "/explorar/muito-bem-avaliados", "/explorar/filmes-populares", "/explorar/series-populares"];
for (const p of presetPaths) {
  const { res, html } = await getPage(p);
  check(`${p} → 200 com grid`, res.status === 200 && html.includes('id="explore-grid"') && cardKeys(html).length > 0);
}
const bad = await getPage("/explorar/inexistente");
check("slug desconhecido → 404", bad.res.status === 404);

// constraints por preset
{
  const { html } = await getPage("/explorar/filmes-populares");
  const keys = cardKeys(html);
  check("filmes-populares: só movie", keys.length > 0 && keys.every((k) => k.startsWith("movie:")));
}
{
  const { html } = await getPage("/explorar/series-populares");
  const keys = cardKeys(html);
  check("series-populares: só tv", keys.length > 0 && keys.every((k) => k.startsWith("tv:")));
}
// filtros reais
{
  const { html } = await getPage("/explorar/em-alta?tipo=movie&genero=action");
  const keys = cardKeys(html);
  check("em-alta Filmes+Ação: só movie", keys.length > 0 && keys.every((k) => k.startsWith("movie:")));
}
{
  const { html } = await getPage("/explorar/muito-bem-avaliados?tipo=tv&genero=drama");
  const hasDrama = (html.match(/>Drama</g) || []).length;
  check("top Séries+Drama: tv + rótulo Drama", cardKeys(html).every((k) => k.startsWith("tv:")) && hasDrama > 0);
}
{
  const { html } = await getPage("/explorar/filmes-populares?ano=2024&genero=science_fiction");
  const years = [...html.matchAll(/>(\d{4})</g)].map((m) => m[1]);
  const sciFi = (html.match(/>Ficção científica</g) || []).length;
  info(`filmes 2024 sci-fi: cards=${cardKeys(html).length} anos=${years.slice(0, 4).join(",")} sciFiLabels=${sciFi}`);
  check("filmes 2024 sci-fi: ano + gênero", cardKeys(html).length > 0 &&
    years.length > 0 && years.every((y) => y === "2024") && sciFi > 0);
}
{
  const { res, html } = await getPage("/explorar/series-populares?streaming=netflix");
  check("séries Netflix: 200 + itens tv", res.status === 200 && cardKeys(html).every((k) => k.startsWith("tv:")));
}
{
  const { res } = await getPage("/explorar/nos-streamings?streaming=disney&genero=animation");
  check("streamings Disney+Animação: 200", res.status === 200);
}
{
  // Caso da auditoria (item 22): tv+horror NUNCA retorna genéricas.
  const tvHorror = await getPage("/explorar/em-alta?tipo=tv&genero=horror");
  check("tv+horror: aviso explícito, 0 cards genéricos",
    tvHorror.res.status === 200 && tvHorror.html.includes("ainda não é suportada") &&
    cardKeys(tvHorror.html).length === 0);
  const seriesHorror = await getPage("/explorar/series-populares?genero=horror");
  check("series-populares+horror: aviso, 0 cards",
    seriesHorror.html.includes("ainda não é suportada") && cardKeys(seriesHorror.html).length === 0);
  const movieHorror = await getApi("?section=filmes-populares&genero=horror");
  check("movie+horror: resultados Terror reais",
    movieHorror.res.status === 200 && (movieHorror.json?.items || []).length > 0 &&
    (movieHorror.json?.items || []).every((i) => (i.genres || []).includes("Terror")));
  const noHorrorTv = await getPage("/explorar/em-alta?tipo=tv");
  check("select tv não oferece horror", !noHorrorTv.html.includes('value="horror"'));
  const yesHorrorMovie = await getPage("/explorar/em-alta?tipo=movie");
  check("select movie oferece horror", yesHorrorMovie.html.includes('value="horror"'));
}
{
  // movie ID nunca em tv; tv ID nunca em movie (nomes oficiais por tipo).
  const tvAction = await getApi("?section=em-alta&tipo=tv&genero=action");
  check("tv+action usa ID tv (Ação e aventura)",
    (tvAction.json?.items || []).length > 0 &&
    (tvAction.json?.items || []).every((i) => (i.genres || []).includes("Ação e aventura")));
  const movieThriller = await getApi("?section=filmes-populares&genero=thriller");
  check("movie+thriller usa ID movie (Thriller)",
    (movieThriller.json?.items || []).length > 0 &&
    (movieThriller.json?.items || []).every((i) => (i.genres || []).includes("Thriller")));
  const mixedAction = await getApi("?section=em-alta&genero=action");
  const mixed = mixedAction.json?.items || [];
  check("mixed resolve por tipo independentemente",
    mixed.length > 0 &&
    mixed.filter((i) => i.type === "tv").every((i) => (i.genres || []).includes("Ação e aventura")) &&
    mixed.filter((i) => i.type === "movie").every((i) => (i.genres || []).includes("Ação")));
}
{
  // ano por tipo + provider+gênero juntos + page 2 preserva filtros.
  const tvYear = await getApi("?section=series-populares&ano=2024");
  check("tv ano=2024 respeita first_air_date",
    (tvYear.json?.items || []).length > 0 &&
    (tvYear.json?.items || []).every((i) => i.year === 2024));
  const provGenre = await getApi("?section=nos-streamings&streaming=netflix&genero=drama");
  check("provider+gênero simultâneos (200 + echo)",
    provGenre.res.status === 200 &&
    provGenre.json?.appliedFilters?.streaming === "netflix" &&
    provGenre.json?.appliedFilters?.genre === "drama");
  const pg1 = await getApi("?section=muito-bem-avaliados&tipo=tv&genero=drama&ano=2024&streaming=netflix");
  const pg2 = await getApi("?section=muito-bem-avaliados&tipo=tv&genero=drama&ano=2024&streaming=netflix&page=2");
  check("page 2 preserva filtros (echo idêntico)",
    JSON.stringify(pg1.json?.appliedFilters) === JSON.stringify(pg2.json?.appliedFilters) &&
    pg1.json?.appliedFilters?.genre === "drama");
  const filtered = await getPage("/explorar/em-alta?tipo=tv&genero=drama&streaming=netflix");
  const btn = filtered.html.includes("data-explore-more");
  check("Carregar mais leva todos os filtros",
    btn && filtered.html.includes("tipo=tv") && filtered.html.includes("genero=drama") &&
    filtered.html.includes("streaming=netflix"));
}
// API
{
  const { res, json } = await getApi("?section=em-alta");
  check("API em-alta: shape válido", res.status === 200 && Array.isArray(json?.items) && json.items.length > 0 &&
    typeof json?.page === "number" && typeof json?.hasMore === "boolean" && !!json?.appliedFilters);
}
{
  // O TMDB ao vivo pode repetir IDs entre páginas — o CineVee NUNCA exige
  // páginas disjuntas. Cada página só precisa ser válida e internamente
  // deduplicada; a fusão (renderizados + nova página) elimina o overlap.
  const p1 = await getApi("?section=filmes-populares&genero=comedy&page=1");
  const p2 = await getApi("?section=filmes-populares&genero=comedy&page=2");
  const keys1 = (p1.json?.items || []).map((i) => `${i.type}:${i.id}`);
  const keys2 = (p2.json?.items || []).map((i) => `${i.type}:${i.id}`);
  const overlap = keys2.filter((k) => keys1.includes(k));
  info(`page1=${keys1.length} page2=${keys2.length} overlap=${overlap.length} hasMore=${p2.json?.hasMore}`);
  check("páginas válidas e internamente deduplicadas",
    p1.res.status === 200 && p2.res.status === 200 &&
    keys1.length > 0 && keys2.length > 0 &&
    new Set(keys1).size === keys1.length && new Set(keys2).size === keys2.length);
  // Regra de fusão do "Carregar mais" aplicada aos dados reais (mesma
  // regra do client: pula chaves já renderizadas): final sem duplicatas,
  // preservando todos os itens novos — overlap do TMDB não vaza p/ UI.
  const known = new Set(keys1);
  const merged = [...keys1];
  for (const k of keys2) {
    if (!known.has(k)) {
      known.add(k);
      merged.push(k);
    }
  }
  const novel = keys2.filter((k) => !keys1.includes(k));
  check("fusão page1+page2: sem duplicatas, sem perder novidades",
    new Set(merged).size === merged.length &&
    novel.every((k) => merged.includes(k)) &&
    merged.length === keys1.length + novel.length);
}
{
  // Simulação determinística com overlap: page1 = A B C, page2 = C D E
  // → UI final = A B C D E (C uma vez só), via código real do serviço.
  const page1 = [
    { id: 101, type: "movie", title: "A" },
    { id: 102, type: "movie", title: "B" },
    { id: 103, type: "movie", title: "C" },
  ];
  const page2 = [
    { id: 103, type: "movie", title: "C" },
    { id: 104, type: "movie", title: "D" },
    { id: 105, type: "movie", title: "E" },
  ];
  const merged = service.dedupeExploreItems([...page1, ...page2]);
  check("overlap simulado A B C + C D E → A B C D E sem duplicar C",
    JSON.stringify(merged.map((i) => i.title)) === JSON.stringify(["A", "B", "C", "D", "E"]));
}
{
  const badSlug = await getApi("?section=xx");
  check("API slug inválido → 404", badSlug.res.status === 404);
  const badPage = await getApi("?section=em-alta&page=0");
  check("API page inválida → 400", badPage.res.status === 400);
  const coerced = await getApi("?section=filmes-populares&tipo=tv&genero=xx&ano=1700&streaming=yy");
  check("API coage inválidos p/ defaults", coerced.res.status === 200 &&
    coerced.json?.appliedFilters?.mediaType === "movie" &&
    coerced.json?.appliedFilters?.genre === "all" &&
    coerced.json?.appliedFilters?.year === null &&
    coerced.json?.appliedFilters?.streaming === "all");
}
// Home links + plumbing
{
  const { html } = await getPage("/");
  check("Home Ver mais → explorar (5 links)", [
    "/explorar/em-alta", "/explorar/nos-streamings", "/explorar/muito-bem-avaliados",
    "/explorar/filmes-populares", "/explorar/series-populares",
  ].every((h) => html.includes(`href="${h}"`)));
}
{
  const { html } = await getPage("/explorar/em-alta");
  check("plumbing Carregar mais (botão + template + query)", (
    html.includes("data-explore-more") && html.includes('id="explore-card-template"') &&
    html.includes("Carregar mais") && html.includes("data-explore-status")
  ));
}
{
  // Client elimina duplicatas antes de anexar: cards SSR carregam data-key
  // (type:id) e o script do "Carregar mais" filtra a nova página pelo
  // conjunto já renderizado. O Astro empacota o script inline em um
  // módulo (?astro&type=script) — valida o mecanismo no bundle real.
  const { html } = await getPage("/explorar/filmes-populares");
  const ssrKeys = cardKeys(html);
  const srcs = [...html.matchAll(/<script type="module" src="([^"]*explorar[^"]*)"/g)]
    .map((m) => m[1].replace(/&amp;/g, "&"));
  let bundle = "";
  for (const src of srcs) {
    try {
      const res = await fetch(`${BASE}${src}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) bundle += await res.text();
    } catch {
      // ignora falha isolada de um módulo; o check abaixo reprova se vazio
    }
  }
  info(`client bundle: ${bundle.length} chars em ${srcs.length} módulo(s), SSR keys=${ssrKeys.length}`);
  check("SSR marca cards com data-key type:id", ssrKeys.length > 0);
  check("client filtra nova página pelo conjunto renderizado",
    bundle.includes("seenKeys") && bundle.includes("known.has(key)") &&
    bundle.includes("data-key"));
}

console.log("---");
console.log(failures === 0 ? "EXPLORE OK: presets + filtros + paginação confirmados." : `EXPLORE FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
