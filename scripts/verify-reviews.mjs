/**
 * Verificação da Etapa 12: opiniões textuais opcionais nas avaliações.
 *
 * Pré-requisito: migrations aplicadas no projeto
 * (Dashboard → SQL Editor → New query → Run), em ordem:
 *   supabase/migrations/20260926090000_ratings.sql (Etapa 7)
 *   supabase/migrations/20260927090000_ratings_review_text.sql (Etapa 12)
 * Sem elas, este script informa a pendência e sai com erro — por desenho,
 * nada é aplicado daqui.
 *
 * Uso:  npm run verify:reviews
 *
 * Cobre:
 * - normalização/validação puras (trim, ""→NULL, 2000/2001, tipos);
 * - compat POST antigo (sem reviewText) + PATCH só-opinião;
 * - schema: coluna review_text + CHECK <= 2000;
 * - create / sem review (NULL) / edit preservando rating / remove review
 *   mantendo rating / change rating preservando review / delete rating
 *   apaga tudo / unwatch cascade (sem voltar à watchlist);
 * - 2000 aceito, 2001 rejeitado (sem truncar);
 * - XSS armazenado como texto puro + newlines exatas;
 * - A/B isolation (review privada, RLS próprio);
 * - deslogado: nada escreve, nada lê;
 * - TasteProfile NÃO consome review (isolamento);
 * - contratos UI: Details ("Sua opinião"), /perfil/avaliacoes (preview,
 *   Ler mais/menos, editor inline), /perfil (snippet), sem HTML injetado.
 *
 * Usa SOMENTE a chave publishable (nada de service_role).
 * Nenhum segredo é impresso: só PASS/FAIL por asserção.
 * Requer email de confirmação DESLIGADO no projeto (como hoje).
 */
import { readFileSync, existsSync } from "node:fs";
import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register("./ts-ext-hook.mjs", import.meta.url);

const validation = await import("../src/lib/ratings/validation.ts");

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !KEY) {
  console.error("Faltam PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY no .env.");
  process.exit(1);
}

const MIGRATION_FILE = "supabase/migrations/20260927090000_ratings_review_text.sql";

const stamp = Date.now();
const makeUser = (tag) => ({
  email: `reviews-${tag}-${stamp}@example.com`,
  password: `ReviewsVerificacao123!${tag}`,
});

let failures = 0;

function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}

function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

// ------------------------------------------------------- A. puras: normalize
const { normalizeReviewText, validateRatingInput, validateReviewUpdateInput } = validation;
check("REVIEW_MAX_LENGTH é 2000", validation.REVIEW_MAX_LENGTH === 2000);
check("normalize trim", normalizeReviewText("  Excelente filme.  ") === "Excelente filme.");
check('normalize "" → NULL', normalizeReviewText("") === null);
check('normalize espaços → NULL', normalizeReviewText("   \n\t  ") === null);
check("normalize null → NULL", normalizeReviewText(null) === null);
check("normalize preserva quebras", normalizeReviewText("linha 1\n\nlinha 2") === "linha 1\n\nlinha 2");
check("normalize 2000 aceito", normalizeReviewText("x".repeat(2000))?.length === 2000);

let threw2001 = false;
try {
  normalizeReviewText("x".repeat(2001));
} catch (e) {
  threw2001 = e?.name === "RatingValidationError";
}
check("normalize 2001 rejeita (sem truncar)", threw2001);

let threwType = false;
try {
  normalizeReviewText(123);
} catch (e) {
  threwType = e?.name === "RatingValidationError";
}
check("normalize número rejeita", threwType);

// ------------------------------------------------------- B. puras: POST/PATCH
const legacy = validateRatingInput({ tmdbId: 550, mediaType: "movie", rating: 4 });
check("POST antigo sem reviewText continua válido", legacy.rating === 4 && !("reviewText" in legacy));
const withReview = validateRatingInput({ tmdbId: 550, mediaType: "movie", rating: 5, reviewText: "  Adorei.  " });
check("POST com reviewText normaliza", withReview.reviewText === "Adorei.");
const withEmpty = validateRatingInput({ tmdbId: 550, mediaType: "movie", rating: 5, reviewText: "   " });
check('POST reviewText "" → NULL', withEmpty.reviewText === null);
const withNull = validateRatingInput({ tmdbId: 550, mediaType: "movie", rating: 5, reviewText: null });
check("POST reviewText null → NULL", withNull.reviewText === null);

let threwPostLong = false;
try {
  validateRatingInput({ tmdbId: 550, mediaType: "movie", rating: 5, reviewText: "x".repeat(2001) });
} catch (e) {
  threwPostLong = e?.name === "RatingValidationError";
}
check("POST 2001 chars → 400 amigável", threwPostLong);

const patch = validateReviewUpdateInput({ tmdbId: 550, mediaType: "movie", reviewText: " Gostei muito. " });
check("PATCH só-opinião normaliza", patch.reviewText === "Gostei muito." && patch.tmdbId === 550);
const patchClear = validateReviewUpdateInput({ tmdbId: 550, mediaType: "movie", reviewText: null });
check("PATCH null limpa opinião", patchClear.reviewText === null);

let threwPatchMissing = false;
try {
  validateReviewUpdateInput({ tmdbId: 550, mediaType: "movie" });
} catch {
  threwPatchMissing = true;
}
check("PATCH sem reviewText rejeita", threwPatchMissing);

// ------------------------------------------------------- C. contratos UI/arquitetura
check("migration Etapa 12 existe", existsSync(new URL("../" + MIGRATION_FILE, import.meta.url)));
const migration = existsSync(new URL("../" + MIGRATION_FILE, import.meta.url))
  ? read("../" + MIGRATION_FILE)
  : "";
check("migration adiciona review_text", /add column if not exists review_text/i.test(migration));
check("migration CHECK <= 2000", /ratings_review_text_length[\s\S]{0,200}char_length\(review_text\) <= 2000/i.test(migration));
check("migration não cria tabela reviews", !/create table/i.test(migration));

const editor = read("../src/components/ratings/ReviewEditor.astro");
check("ReviewEditor reutilizável existe", editor.includes("data-review-editor"));
check("editor usa termo Sua opinião", editor.includes("Sua opinião"));
check("editor textarea maxlength=2000", editor.includes('maxlength="2000"'));
check("editor placeholder", editor.includes("O que você achou deste título?"));
check("editor contador discreto", editor.includes("/ 2000"));
check("editor salva via PATCH /api/ratings", editor.includes('method: "PATCH"') && editor.includes("/api/ratings"));
check("editor ação Remover opinião", editor.includes("Remover opinião"));
check("editor nunca injeta HTML", !editor.includes("set:html") && !editor.includes("innerHTML"));

const hero = read("../src/components/details/DetailsHero.astro");
check("Details importa ReviewEditor", hero.includes("ReviewEditor"));
check("Details seção Sua opinião", hero.includes("data-review-section"));
check("Details gate sem rating", hero.includes("Avalie com estrelas para poder escrever sua opinião."));
check("Details sem watched: só dica existente", hero.includes("Marque como assistido para avaliar."));
check("Details remove rating+review com copy clara",
  hero.includes("Remover esta avaliação e sua opinião?"));
check("Details nunca injeta HTML", !hero.includes("set:html"));

const avaliacoes = read("../src/pages/perfil/avaliacoes.astro");
check("avaliacoes importa ReviewEditor", avaliacoes.includes("ReviewEditor"));
check("avaliacoes preview limitado", avaliacoes.includes("line-clamp-4"));
check("avaliacoes Ler mais/Ler menos", avaliacoes.includes("Ler mais") && avaliacoes.includes("Ler menos"));
check("avaliacoes Editar/Adicionar opinião", avaliacoes.includes("Editar opinião") && avaliacoes.includes("Adicionar opinião"));
check("avaliacoes remove com copy clara", avaliacoes.includes("Remover esta avaliação e sua opinião?"));
check("avaliacoes texto puro escapado", avaliacoes.includes("cinevee-review-text") && !avaliacoes.includes("set:html"));

const perfil = read("../src/pages/perfil.astro");
check("perfil snippet discreto 1–2 linhas", perfil.includes("line-clamp-2") && perfil.includes("reviewText"));

const api = read("../src/pages/api/ratings.ts");
check("API tem PATCH só-opinião", api.includes("export const PATCH") && api.includes("validateReviewUpdateInput"));
check("API POST aceita reviewText opcional", api.includes("reviewText"));
check("API DELETE remove row inteira", api.includes("export const DELETE"));

const service = read("../src/lib/ratings/service.ts");
check("service updateReview existe", service.includes("export async function updateReview"));
check("service preserva opinião no POST", service.includes("preserva"));
check("service lê review_text na mesma row", service.includes("review_text"));

const taste = read("../src/lib/personalization/taste.ts");
const tasteProfile = read("../src/lib/personalization/tasteProfile.ts");
check("TasteProfile NÃO consome review", !/review/i.test(taste) && !/review/i.test(tasteProfile));

const css = read("../src/styles/global.css");
check("CSS pre-wrap seguro", css.includes("cinevee-review-text") && css.includes("pre-wrap"));

// ------------------------------------------------------- D. banco (RLS, publishable)
async function signUp({ email, password }) {
  const client = createClient(SUPABASE_URL, KEY);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`signup ${email} falhou (sessão nula — confirmação de e-mail ligada?)`);
  }
  return { client, id: data.user.id, email };
}

const A = await signUp(makeUser("a"));
const B = await signUp(makeUser("b"));

// Sonda: coluna da Etapa 12 existe?
const probe = await A.client.from("ratings").select("review_text").limit(1);
if (probe.error && /review_text|does not exist|42P01|schema cache|not find/i.test(probe.error.message ?? "")) {
  console.log("SKIP  migration da Etapa 12 ainda não aplicada.");
  console.log(`Aplique no Supabase Dashboard → SQL Editor → New query → Run: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("coluna review_text acessível", probe.error === null);

// Base: watched primeiro (FK exige título assistido).
const wA = {
  user_id: A.id, tmdb_id: 550, media_type: "movie",
  title: "Clube da Luta", poster_path: "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg", release_year: 1999,
};
const wB = {
  user_id: B.id, tmdb_id: 1396, media_type: "tv",
  title: "Breaking Bad", poster_path: "/ggFHVNu6YYI5L9pCfOacjizRGt.jpg", release_year: 2008,
};
check("A assiste movie 550", (await A.client.from("watched_titles").insert(wA).select("tmdb_id")).error === null);
check("B assiste tv 1396", (await B.client.from("watched_titles").insert(wB).select("tmdb_id")).error === null);

// Create: rating 5 + review exata.
const create = await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 550, media_type: "movie", rating: 5, review_text: "Excelente filme." })
  .select("rating,review_text");
check("create rating=5 + review exata",
  create.error === null && create.data?.[0]?.rating === 5 && create.data?.[0]?.review_text === "Excelente filme.");

// Rating sem review → NULL (comportamento anterior intacto).
const noReview = await B.client.from("ratings")
  .insert({ user_id: B.id, tmdb_id: 1396, media_type: "tv", rating: 2 })
  .select("rating,review_text");
check("rating sem review → NULL",
  noReview.error === null && noReview.data?.[0]?.rating === 2 && noReview.data?.[0]?.review_text === null);

// Edit review: mesma row, rating continua 5.
const edit = await A.client.from("ratings")
  .update({ review_text: "Gostei muito da fotografia." })
  .eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550)
  .select("rating,review_text");
const countAfterEdit = await A.client.from("ratings").select("tmdb_id").eq("user_id", A.id).eq("tmdb_id", 550);
check("edit review: mesma row, rating 5",
  edit.error === null && edit.data?.[0]?.rating === 5
  && edit.data?.[0]?.review_text === "Gostei muito da fotografia."
  && countAfterEdit.data?.length === 1);

// Remove review: rating continua, review NULL.
const clear = await A.client.from("ratings")
  .update({ review_text: null })
  .eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550)
  .select("rating,review_text");
check("remove review: rating=5, review=NULL",
  clear.error === null && clear.data?.[0]?.rating === 5 && clear.data?.[0]?.review_text === null);

// Change rating preserva review.
await A.client.from("ratings").update({ review_text: "Gostei." })
  .eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550);
const change = await A.client.from("ratings").update({ rating: 3 })
  .eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550)
  .select("rating,review_text");
check("change rating 5→3 preserva review",
  change.error === null && change.data?.[0]?.rating === 3 && change.data?.[0]?.review_text === "Gostei.");

// Delete rating apaga rating + review (watched continua).
const delR = await A.client.from("ratings").delete()
  .eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550).select("tmdb_id");
const stillW = await A.client.from("watched_titles").select("tmdb_id").eq("tmdb_id", 550).eq("media_type", "movie");
const goneR = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 550).eq("media_type", "movie");
check("delete rating remove review junto (watched continua)",
  delR.data?.length === 1 && stillW.data?.length === 1 && goneR.data?.length === 0);

// Unwatch cascade: watched+rating+review → delete watched zera tudo, sem watchlist.
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 780, title: "Filme 780" }).select("tmdb_id");
await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 780, media_type: "movie", rating: 5, review_text: "Cascade." }).select("tmdb_id");
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 780);
const w0 = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 780);
const wl0 = await A.client.from("watchlist").select("tmdb_id").eq("tmdb_id", 780).eq("media_type", "movie");
check("unwatch cascade: rating+review somem, sem watchlist",
  w0.data?.length === 0 && wl0.data?.length === 0);

// 2000 aceito / 2001 rejeitado (constraint segura, sem truncar).
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 781, title: "Filme 781" }).select("tmdb_id");
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 782, title: "Filme 782" }).select("tmdb_id");
const ok2000 = await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 781, media_type: "movie", rating: 4, review_text: "y".repeat(2000) })
  .select("review_text");
check("2000 chars aceito", ok2000.error === null && ok2000.data?.[0]?.review_text?.length === 2000);
const bad2001 = await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 782, media_type: "movie", rating: 4, review_text: "y".repeat(2001) })
  .select("tmdb_id");
check("2001 chars rejeitado", bad2001.error !== null);
const noRow2001 = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 782);
check("2001 não truncou nem criou linha", noRow2001.data?.length === 0);
await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", 781);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 781);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 782);

// XSS: armazenado como texto puro, lido byte a byte.
const xss = '<script>alert("x")</script><img src=x onerror=alert(1)>';
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 783, title: "Filme 783" }).select("tmdb_id");
const xssIns = await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 783, media_type: "movie", rating: 1, review_text: xss })
  .select("review_text");
check("XSS gravado como texto puro",
  xssIns.error === null && xssIns.data?.[0]?.review_text === xss);
await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", 783);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 783);

// Newlines: exatas na leitura.
const nl = "linha 1\n\nlinha 2";
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 784, title: "Filme 784" }).select("tmdb_id");
await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 784, media_type: "movie", rating: 4, review_text: nl })
  .select("tmdb_id");
const nlBack = await A.client.from("ratings").select("review_text").eq("tmdb_id", 784).eq("media_type", "movie");
check("newlines preservadas byte a byte", nlBack.data?.[0]?.review_text === nl);
await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", 784);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 784);

// A/B isolation: review privada.
await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 550, media_type: "movie", rating: 5, review_text: "Opinião de A." })
  .select("tmdb_id");
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 551, title: "Filme 551" }).select("tmdb_id");
const crossSel = await B.client.from("ratings").select("review_text").eq("user_id", A.id);
check("B NÃO lê review de A (0 linhas)", crossSel.error === null && crossSel.data?.length === 0);
const crossUpd = await B.client.from("ratings").update({ review_text: "invadido" }).eq("user_id", A.id).select("tmdb_id");
check("B NÃO altera review de A (0 linhas)", crossUpd.data?.length === 0);
const crossDel = await B.client.from("ratings").delete().eq("user_id", A.id).select("tmdb_id");
check("B NÃO remove review de A (0 linhas)", crossDel.data?.length === 0);
const intact = await A.client.from("ratings").select("review_text").eq("tmdb_id", 550).eq("media_type", "movie");
check("review de A intacta", intact.data?.[0]?.review_text === "Opinião de A.");

// Review sem rating é impossível: update em título sem rating afeta 0 linhas.
const orphanUpd = await A.client.from("ratings").update({ review_text: "órfã" })
  .eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 551).select("tmdb_id");
check("review sem rating não cria nada (0 linhas)", orphanUpd.data?.length === 0);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", 551);

// Deslogado: anon sem sessão não escreve nem lê.
const anon = createClient(SUPABASE_URL, KEY);
const anonIns = await anon.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 550, media_type: "movie", rating: 5, review_text: "anon" })
  .select("tmdb_id");
check("deslogado NÃO cria review", anonIns.error !== null);
const anonSel = await anon.from("ratings").select("review_text").limit(1);
check("deslogado NÃO lê reviews", anonSel.error !== null || anonSel.data?.length === 0);
const anonUpd = await anon.from("ratings").update({ review_text: "anon" }).eq("tmdb_id", 550).select("tmdb_id");
check("deslogado NÃO edita review", (anonUpd.data ?? []).length === 0);

// Limpeza (DELETE próprio, permitido pelo RLS).
await A.client.from("ratings").delete().eq("user_id", A.id);
await B.client.from("ratings").delete().eq("user_id", B.id);
await A.client.from("watched_titles").delete().eq("user_id", A.id);
await B.client.from("watched_titles").delete().eq("user_id", B.id);
const cleanA = await A.client.from("ratings").select("tmdb_id");
const cleanB = await B.client.from("ratings").select("tmdb_id");
check("limpeza: A remove as próprias", cleanA.data?.length === 0);
check("limpeza: B remove as próprias", cleanB.data?.length === 0);

// Limpeza: sem service_role no app, os usuários de teste (reviews-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users.
console.log("---");
console.log(failures === 0 ? "REVIEWS OK: coluna + RLS + cascade + contratos confirmados." : `REVIEWS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
