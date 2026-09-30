/**
 * Verificação da Etapa 8: personalização (watched exclusion + TasteProfile).
 *
 * Uso: npm run verify:personalization (servidor dev rodando em :4321
 * para a parte HTTP; partes puras e Supabase rodam sem ele).
 *
 * Cobre deterministicamente:
 * - watched exclusion (pura) + merge/dedupe de IDs;
 * - ratings → TasteProfile (pesos, evidência>=2, neutro-3, tetos);
 * - positive/negative genres; session vence histórico; profile vence tudo;
 * - bônus local limitado (±0.5) e sem dominar a sessão;
 * - prompt compacto sem PII; versão de contexto;
 * - rankLocally comportamental (tiebreak, session-wins, sem overfit);
 * - cadeia Groq→Gemini→local com chaves inválidas (ambiente controlado);
 * - RLS A/B em watched+ratings; DEV meta (taste, exclusão, aiSource);
 * - exclusão observada nos picks; invalidação de cache; deslogado; vazio.
 *
 * Nenhum segredo é impresso: só PASS/FAIL/INFO por asserção.
 */
import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register("./ts-ext-hook.mjs", import.meta.url);

const taste = await import("../src/lib/personalization/taste.ts");
const candidatesMod = await import("../src/lib/discovery/candidates.ts");
const geminiRank = await import("../src/lib/gemini/rankRecommendations.ts");
const provider = await import("../src/lib/ai/provider.ts");

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

// ---------------------------------------------------------------- A. puro
check("pesos 5/4/3/2/1 → +2/+1/0/-1/-2", (
  taste.ratingGenreWeight(5) === 2 && taste.ratingGenreWeight(4) === 1 &&
  taste.ratingGenreWeight(3) === 0 && taste.ratingGenreWeight(2) === -1 &&
  taste.ratingGenreWeight(1) === -2
));

const sig1 = taste.scoreGenreSignals([{ genres: ["science_fiction"], rating: 5 }]);
check("1 título só NÃO cria signal (evidência)", sig1.positive.length === 0 && sig1.negative.length === 0);

const sig2 = taste.scoreGenreSignals([
  { genres: ["science_fiction"], rating: 5 },
  { genres: ["science_fiction"], rating: 5 },
]);
check("dois 5s → positive (score 4, ev 2)",
  sig2.positive.length === 1 && sig2.positive[0].genre === "science_fiction" &&
  sig2.positive[0].score === 4 && sig2.positive[0].evidence === 2);

const sig3 = taste.scoreGenreSignals([
  { genres: ["drama"], rating: 3 }, { genres: ["drama"], rating: 3 }, { genres: ["drama"], rating: 3 },
]);
check("três 3s → neutro, sem signals", sig3.positive.length === 0 && sig3.negative.length === 0);

const sig4 = taste.scoreGenreSignals([
  { genres: ["romance"], rating: 1 }, { genres: ["romance"], rating: 1 }, { genres: ["romance"], rating: 2 },
]);
check("1,1,2 → negative (score -5, ev 3)",
  sig4.negative.length === 1 && sig4.negative[0].genre === "romance" &&
  sig4.negative[0].score === -5 && sig4.negative[0].evidence === 3);
const sig4b = taste.scoreGenreSignals([{ genres: ["romance"], rating: 1 }]);
check("um 1 só NÃO cria negative", sig4b.negative.length === 0);

const manyFives = Array.from({ length: 8 }, (_, i) => ({
  tmdbId: 100 + i, mediaType: "movie", rating: 5, title: `F${i}`,
  genres: ["science_fiction"], updatedAt: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
}));
const manyOnes = Array.from({ length: 6 }, (_, i) => ({
  tmdbId: 200 + i, mediaType: "movie", rating: 1, title: `R${i}`,
  genres: ["romance"], updatedAt: `2026-02-0${(i % 9) + 1}T00:00:00Z`,
}));
const ex1 = taste.selectTasteExamples([...manyFives, ...manyOnes]);
check("tetos: 8 cincos → 6 liked; 6 uns → 4 disliked",
  ex1.liked.length === 6 && ex1.disliked.length === 4);
check("prioridade: 5 antes de 4; 1 antes de 2", (() => {
  const mix = [
    { tmdbId: 1, mediaType: "movie", rating: 4, title: "Q4", genres: ["drama"], updatedAt: "2026-01-01T00:00:00Z" },
    { tmdbId: 2, mediaType: "movie", rating: 5, title: "Q5", genres: ["drama"], updatedAt: "2026-01-01T00:00:00Z" },
    { tmdbId: 3, mediaType: "movie", rating: 2, title: "D2", genres: ["drama"], updatedAt: "2026-01-01T00:00:00Z" },
    { tmdbId: 4, mediaType: "movie", rating: 1, title: "D1", genres: ["drama"], updatedAt: "2026-01-01T00:00:00Z" },
  ];
  const ex = taste.selectTasteExamples(mix);
  return ex.liked[0].rating === 5 && ex.disliked[0].rating === 1;
})());

check("session vence histórico no penalty set", (() => {
  const neg = [{ genre: "romance", score: -5, evidence: 3 }, { genre: "horror", score: -4, evidence: 2 }];
  const eff = taste.resolveTastePenaltyGenres(["romance"], neg);
  return eff.length === 1 && eff[0] === "horror";
})());

check("bônus local +0.5 / -0.5 / teto", (
  taste.localTasteBonus(["Ficção científica"], [], ["Ficção científica"], []) === 0.5 &&
  taste.localTasteBonus(["Romance"], [], [], ["Romance"]) === -0.5 &&
  taste.localTasteBonus(["X"], [], [], []) === 0
));
check("negativo NÃO penaliza gênero pedido na sessão",
  taste.localTasteBonus(["Romance"], ["Romance"], [], ["Romance"]) === 0);

const demoTaste = {
  ratedCount: 7,
  positiveGenres: [{ genre: "science_fiction", score: 6, evidence: 4 }],
  negativeGenres: [{ genre: "romance", score: -5, evidence: 3 }],
  likedExamples: [{ tmdbId: 603, mediaType: "movie", title: "Matrix", year: 1999, genres: ["science_fiction"], rating: 5 }],
  dislikedExamples: [{ tmdbId: 11036, mediaType: "movie", title: "Diário de uma Paixão", year: 2004, genres: ["romance"], rating: 1 }],
  version: "v1:w7:r7:u2026-01-01",
};
const labelFor = (g) => ({ science_fiction: "Ficção científica", romance: "Romance" })[g] ?? g;
const block = taste.formatTasteForPrompt(demoTaste, labelFor);
check("prompt compacto tem gêneros + exemplos", (
  block.includes("Ficção científica") && block.includes("Matrix") &&
  block.includes("Romance") && block.includes("SECUNDÁRIO")
));
check("prompt sem PII (email/user_id)", !/email|user_id|@example\.com/i.test(block));
check("taste vazio → bloco vazio", taste.formatTasteForPrompt(taste.emptyTasteProfile("v1:anon"), labelFor) === "");
check("regras de prioridade no prompt", (
  taste.TASTE_RANK_RULES.includes("intenção da sessão") &&
  taste.TASTE_RANK_RULES.includes("vence o gosto histórico") &&
  taste.TASTE_RANK_RULES.includes("desempate secundário") &&
  taste.TASTE_RANK_RULES.includes("NÃO penalize")
));

check("watchedKey `type:id`", taste.watchedKey("movie", 550) === "movie:550");
check("mergeIdLists com dedupe", (() => {
  const m = taste.mergeIdLists(["movie:1", "tv:2"], ["tv:2", "movie:3"]);
  return m.length === 3 && m.includes("movie:1") && m.includes("movie:3");
})());
check("versão determinística e sensível", (
  taste.tasteVersion(3, 7, ["2026-01-01T00:00:00Z"]) === taste.tasteVersion(3, 7, ["2026-01-01T00:00:00Z"]) &&
  taste.tasteVersion(3, 7, ["2026-01-01T00:00:00Z"]) !== taste.tasteVersion(3, 8, ["2026-01-02T00:00:00Z"]) &&
  taste.tasteVersion(3, 7, ["2026-01-01T00:00:00Z"]) !== taste.tasteVersion(3, 7, ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]) &&
  taste.ANON_TASTE_VERSION === "v1:anon"
));

// ------------------------------------------------------- B. exclusão pura
const poolFx = [
  { id: 1, type: "movie" }, { id: 2, type: "movie" }, { id: 3, type: "tv" },
].map((c) => ({ ...c, title: "T", overview: "o", genres: [], genreIds: [] }));
const split = candidatesMod.excludeWatchedTitles(poolFx, ["movie:1", "tv:3"]);
check("exclusão watched remove exatos + conta",
  split.kept.length === 1 && split.kept[0].id === 2 && split.excludedCount === 2);
const splitEmpty = candidatesMod.excludeWatchedTitles(poolFx, []);
check("sem watched → pool intacto", splitEmpty.kept.length === 3 && splitEmpty.excludedCount === 0);

// ------------------------------------------- C. rankLocally comportamental
const mkCand = (id, type, genres, rating) => ({
  id, type, title: `T${id}`, overview: "sinopse suficiente para teste",
  year: 2020, genres, genreIds: [], rating, voteCount: 100, popularity: 50,
});
const baseAnswers = {
  contentType: "movie", mood: "fun", preferredGenres: ["comedy"],
  adaptive: { category: "story_focus", value: "plot" },
  commitment: "any", providers: ["any"], sessionExcludedGenres: [],
};
const candsTie = [
  mkCand(1, "movie", ["Comédia"], 7),
  mkCand(2, "movie", ["Ficção científica"], 7),
  mkCand(3, "movie", ["Romance"], 7),
  mkCand(4, "movie", ["Terror"], 7),
];
const tasteCB = {
  ratedCount: 5,
  positiveGenres: [{ genre: "science_fiction", score: 5, evidence: 3 }],
  negativeGenres: [{ genre: "romance", score: -5, evidence: 3 }],
  likedExamples: [], dislikedExamples: [], version: "v1:t",
};
const orderOf = (recs) => recs.map((r) => r.item.id).join(",");
const baseOrder = orderOf(geminiRank.rankLocally(baseAnswers, candsTie, null, null));
const tasteOrder = orderOf(geminiRank.rankLocally(baseAnswers, candsTie, null, tasteCB));
check("sessão primeiro; taste desempatata (1,2,4,3)",
  baseOrder === "1,2,3,4" && tasteOrder === "1,2,4,3");

const romanceAnswers = { ...baseAnswers, preferredGenres: ["romance"] };
const candsRom = [mkCand(3, "movie", ["Romance"], 7), mkCand(4, "movie", ["Terror"], 7)];
check("session-wins: romance pedido vence histórico negativo",
  orderOf(geminiRank.rankLocally(romanceAnswers, candsRom, null, tasteCB)) === "3,4");

const vagueAnswers = { ...baseAnswers, preferredGenres: [] };
const candsVague = [mkCand(3, "movie", ["Romance"], 7), mkCand(2, "movie", ["Ficção científica"], 7)];
check("sessão vaga: taste decide (sci-fi antes)",
  orderOf(geminiRank.rankLocally(vagueAnswers, candsVague, null, tasteCB)) === "2,3");

const candsDom = [
  mkCand(9, "movie", ["Ficção científica"], 1),
  mkCand(1, "movie", ["Comédia"], 9),
];
check("taste NÃO domina sessão (0.5 << sinais explícitos)",
  orderOf(geminiRank.rankLocally(baseAnswers, candsDom, null, tasteCB)) === "1,9");

// --------------------------------- D. cadeia de fallback controlada
const savedGroq = process.env.GROQ_API_KEY;
const savedGemini = process.env.GEMINI_API_KEY;
process.env.GROQ_API_KEY = "invalid-test-key";
process.env.GEMINI_API_KEY = "invalid-test-key";
let fallbackOutcome = null;
try {
  fallbackOutcome = await provider.rankRecommendations(baseAnswers, candsTie, null, tasteCB);
} catch (e) {
  info(`fallback lançou: ${e.message}`);
}
process.env.GROQ_API_KEY = savedGroq;
process.env.GEMINI_API_KEY = savedGemini;
check("fallback local com chaves inválidas (4 válidos, sem throw)",
  fallbackOutcome !== null && fallbackOutcome.source === "local" &&
  fallbackOutcome.result.primary !== null && fallbackOutcome.result.alternatives.length === 3);
info(`fallback reasons sample: ${(fallbackOutcome?.result.primary?.reason ?? "").slice(0, 80)}…`);

// ------------------------------------------------- E. Supabase semeado
const stamp = Date.now();
async function signUp(tag) {
  const client = createClient(SUPABASE_URL, KEY);
  const email = `perso-${tag}-${stamp}@example.com`;
  const { data, error } = await client.auth.signUp({ email, password: `PersoVerificacao123!${tag}` });
  if (error || !data.session) throw new Error(`signup ${email} falhou`);
  return { client, id: data.user.id, email };
}
const A = await signUp("a");
const B = await signUp("b");
const wl = (uid, tmdb, type, title) => ({
  user_id: uid, tmdb_id: tmdb, media_type: type, title,
  poster_path: null, release_year: null,
});
const seedA = [
  [157336, "movie", "Interstellar", 5], [603, "movie", "Matrix", 5],
  [27205, "movie", "A Origem", 4], [335984, "movie", "Blade Runner 2049", 4],
  [11036, "movie", "Diário de uma Paixão", 1], [313369, "movie", "La La Land", 2],
  [122917, "movie", "A Culpa é das Estrelas", 1],
];
for (const [tmdb, type, title, rating] of seedA) {
  await A.client.from("watched_titles").insert(wl(A.id, tmdb, type, title));
  await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: tmdb, media_type: type, rating });
}
await B.client.from("watched_titles").insert(wl(B.id, 550, "movie", "Clube da Luta"));
await B.client.from("ratings").insert({ user_id: B.id, tmdb_id: 550, media_type: "movie", rating: 5 });
await B.client.from("watched_titles").insert(wl(B.id, 1396, "tv", "Breaking Bad"));
await B.client.from("ratings").insert({ user_id: B.id, tmdb_id: 1396, media_type: "tv", rating: 4 });

const seeA = await A.client.from("ratings").select("tmdb_id");
const seeB = await B.client.from("ratings").select("tmdb_id");
check("RLS: A vê 7 ratings próprios", seeA.data?.length === 7);
check("RLS: B vê 2 ratings próprios", seeB.data?.length === 2);
const crossR = await A.client.from("ratings").select("tmdb_id").eq("user_id", B.id);
check("RLS: A não lê ratings de B", crossR.data?.length === 0);
const crossW = await B.client.from("watched_titles").select("tmdb_id").eq("user_id", A.id);
check("RLS: B não lê watched de A", crossW.data?.length === 0);

// ------------------------------------------------- F. HTTP (dev meta)
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const cookieFor = (session) =>
  `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
let http = true;
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
} catch {
  http = false;
  console.log("SKIP  servidor dev indisponível em :4321 — parte HTTP pulada.");
}
if (!http) process.exit(1);

const supaA = createClient(SUPABASE_URL, KEY);
const { data: sA } = await supaA.auth.signInWithPassword({ email: A.email, password: `PersoVerificacao123!a` });
const cookieA = cookieFor(sA.session);
const answersFx = {
  contentType: "movie", mood: "fun", preferredGenres: [],
  adaptive: { category: "story_focus", value: "plot" },
  commitment: "any", providers: ["any"], sessionExcludedGenres: [],
};
async function recs(cookie, body, label) {
  const res = await fetch(`${BASE}/api/discovery/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  info(`${label}: HTTP ${res.status} aiSource=${json?.meta?.aiSource} taste=${JSON.stringify(json?.meta ? {
    used: json.meta.tasteProfileUsed, r: json.meta.ratedCount,
    pos: json.meta.positiveGenres, neg: json.meta.negativeGenres,
    wx: json.meta.watchedExcludedCount,
  } : null)}`);
  return { res, json };
}
const watchedAKeys = new Set(seedA.map(([tmdb, type]) => `${type}:${tmdb}`));

const r1 = await recs(cookieA, answersFx, "A seeded");
check("A: 200 + taste ativo (r7, sci-fi+, romance-)",
  r1.res.status === 200 && r1.json?.meta?.tasteProfileUsed === true &&
  r1.json?.meta?.ratedCount === 7 &&
  (r1.json?.meta?.positiveGenres || []).includes("science_fiction") &&
  (r1.json?.meta?.negativeGenres || []).includes("romance"));
check("A: contextVersion opaca presente", typeof r1.json?.contextVersion === "string" && r1.json.contextVersion.startsWith("v1:"));

const seenAll = new Set();
let okPicks = true;
let versionStable = true;
for (let i = 0; i < 3; i++) {
  const r = await recs(cookieA, { ...answersFx, excludeIds: [...seenAll] }, `A reroll ${i + 1}`);
  if (r.res.status !== 200) { okPicks = false; break; }
  if (r.json?.contextVersion !== r1.json?.contextVersion) versionStable = false;
  for (const rec of [r.json?.primary, ...(r.json?.alternatives || [])]) {
    if (!rec) continue;
    const key = `${rec.item.type}:${rec.item.id}`;
    seenAll.add(key);
    if (watchedAKeys.has(key)) okPicks = false;
  }
}
check("exclusão observada: nenhum pick assistido em 3 runs", okPicks && seenAll.size >= 4);
check("versão estável sem mudar histórico", versionStable);

// invalidação: novo rating muda a versão
await A.client.from("watched_titles").insert(wl(A.id, 680, "movie", "Pulp Fiction"));
await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 680, media_type: "movie", rating: 5 });
const r2 = await recs(cookieA, answersFx, "A após novo rating");
check("novo rating invalida versão", r2.res.status === 200 && r2.json?.contextVersion !== r1.json?.contextVersion);
check("ratedCount acompanha (8)", r2.json?.meta?.ratedCount === 8);
await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", 680);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 680);

const rB = await recs(cookieFor((await createClient(SUPABASE_URL, KEY).auth.signInWithPassword({ email: B.email, password: `PersoVerificacao123!b` })).data.session), answersFx, "B seeded");
check("B: contexto próprio (r2, sem sci-fi+)", rB.res.status === 200 && rB.json?.meta?.ratedCount === 2 &&
  !(rB.json?.meta?.positiveGenres || []).includes("science_fiction"));
check("A/B isolados (versões e sinais diferentes)",
  rB.json?.contextVersion !== r1.json?.contextVersion &&
  JSON.stringify(rB.json?.meta?.positiveGenres) !== JSON.stringify(r1.json?.meta?.positiveGenres));

const rOut = await recs(null, answersFx, "deslogado");
check("deslogado: sem taste, funciona normal",
  rOut.res.status === 200 && rOut.json?.meta?.tasteProfileUsed === false &&
  rOut.json?.meta?.ratedCount === 0 && (rOut.json?.meta?.positiveGenres || []).length === 0);

const C = await signUp("c");
await C.client.from("watched_titles").insert(wl(C.id, 550, "movie", "Clube da Luta"));
const supaC = createClient(SUPABASE_URL, KEY);
const { data: sC } = await supaC.auth.signInWithPassword({ email: C.email, password: `PersoVerificacao123!c` });
const rC = await recs(cookieFor(sC.session), answersFx, "C sem ratings");
check("authed sem ratings: exclusão ok, taste vazio",
  rC.res.status === 200 && rC.json?.meta?.tasteProfileUsed === false && rC.json?.meta?.ratedCount === 0);

// ------------------------------------------------- G. "Seu gosto" (/perfil)
async function perfilHtml(cookie) {
  const res = await fetch(`${BASE}/perfil`, { headers: { Cookie: cookie } });
  return { status: res.status, html: await res.text() };
}
const D = await signUp("d");
const pD = await perfilHtml(cookieFor((await createClient(SUPABASE_URL, KEY).auth.signInWithPassword({ email: D.email, password: `PersoVerificacao123!d` })).data.session));
check("gosto 0 ratings: onboarding + CTA assistidos",
  pD.status === 200 && pD.html.includes("Seu gosto ainda está começando.") &&
  pD.html.includes("Avaliar títulos assistidos") &&
  !pD.html.includes("Você costuma curtir"));

const E = await signUp("e");
await E.client.from("watched_titles").insert(wl(E.id, 550, "movie", "Clube da Luta"));
await E.client.from("ratings").insert({ user_id: E.id, tmdb_id: 550, media_type: "movie", rating: 3 });
const supaE = createClient(SUPABASE_URL, KEY);
const { data: sE } = await supaE.auth.signInWithPassword({ email: E.email, password: `PersoVerificacao123!e` });
const pE = await perfilHtml(cookieFor(sE.session));
check("gosto 1 rating: sem conclusão exagerada",
  pE.html.includes("Ainda estamos conhecendo seu gosto.") &&
  pE.html.includes("1 título avaliado") && !pE.html.includes("Você costuma curtir"));

const pA = await perfilHtml(cookieA);
check("gosto com evidência: chips pt-BR + contagem + explainer",
  pA.html.includes("Você costuma curtir") && pA.html.includes("Ficção científica") &&
  !pA.html.includes("science_fiction</li>") && pA.html.includes("Baseado em 7 avaliações") &&
  pA.html.includes("O que você escolhe no Descobrir continua tendo prioridade"));
check("gosto: sem internals no HTML", !/evidence=|score=|v1:w\d/.test(pA.html));

// limpeza (linhas; usuários via Dashboard depois)
for (const u of [A, B, C, D, E]) {
  await u.client.from("ratings").delete().eq("user_id", u.id);
  await u.client.from("watched_titles").delete().eq("user_id", u.id);
  await u.client.from("watchlist").delete().eq("user_id", u.id);
}

console.log("---");
console.log(failures === 0 ? "PERSONALIZATION OK: exclusão + taste + isolamento confirmados." : `PERSONALIZATION FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
