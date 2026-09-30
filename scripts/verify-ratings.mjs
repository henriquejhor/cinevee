/**
 * Verificação de RLS da tabela public.ratings (Etapa 7) + semântica.
 *
 * Pré-requisito: migration supabase/migrations/20260926090000_ratings.sql
 * aplicada no projeto (Dashboard → SQL Editor → New query → Run). Sem ela,
 * este script informa a pendência e sai com erro — por desenho, nada é
 * aplicado daqui.
 *
 * Uso:  npm run verify:ratings
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e dois usuários
 * de teste (A e B) criados via signup, em nível de tabela (RLS):
 *   A: watched movie 550 + rating 5 · B: watched tv 1396 + rating 2 ·
 *   A lê só A · B lê só B · cruzados 0 linhas (select/update/delete) ·
 *   update 5→3 mesma row (updated_at muda) · delete rating mantém watched ·
 *   delete watched remove rating (cascade) · rating sem watched falha (FK) ·
 *   CHECKs: 1/5 ok, 0/6/2.5 rejeitados.
 *
 * Nenhum segredo é impresso: só PASS/FAIL por asserção.
 * Requer email de confirmação DESLIGADO no projeto (como hoje).
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!URL || !KEY) {
  console.error("Faltam PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY no .env.");
  process.exit(1);
}

const MIGRATION_FILE = "supabase/migrations/20260926090000_ratings.sql";

const stamp = Date.now();
const makeUser = (tag) => ({
  email: `ratings-${tag}-${stamp}@example.com`,
  password: `RatingsVerificacao123!${tag}`,
});

let failures = 0;

function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}

async function signUp({ email, password }) {
  const client = createClient(URL, KEY);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`signup ${email} falhou (sessão nula — confirmação de e-mail ligada?)`);
  }
  return { client, id: data.user.id, email };
}

const A = await signUp(makeUser("a"));
const B = await signUp(makeUser("b"));

// Sonda: tabela da Etapa 7 existe?
const probe = await A.client.from("ratings").select("tmdb_id").limit(1);
if (probe.error && /does not exist|42P01|schema cache|not find/i.test(probe.error.message ?? "")) {
  console.log("SKIP  migration da Etapa 7 ainda não aplicada.");
  console.log(`Aplique no Supabase Dashboard → SQL Editor → New query → Run: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("tabela ratings acessível", probe.error === null);

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

// A avalia 5 · B avalia 2.
const rA = { user_id: A.id, tmdb_id: 550, media_type: "movie", rating: 5 };
const rB = { user_id: B.id, tmdb_id: 1396, media_type: "tv", rating: 2 };
const insA = await A.client.from("ratings").insert(rA).select("tmdb_id,rating");
check("A avalia movie 550 com 5", insA.error === null && insA.data?.length === 1);
const insB = await B.client.from("ratings").insert(rB).select("tmdb_id,rating");
check("B avalia tv 1396 com 2", insB.error === null && insB.data?.length === 1);

// A lê só A · B lê só B.
const seeA = await A.client.from("ratings").select("tmdb_id,rating");
check("A lê só rating A", seeA.error === null && seeA.data?.length === 1
  && seeA.data[0].tmdb_id === 550 && seeA.data[0].rating === 5);
const seeB = await B.client.from("ratings").select("tmdb_id,rating");
check("B lê só rating B", seeB.error === null && seeB.data?.length === 1
  && seeB.data[0].tmdb_id === 1396 && seeB.data[0].rating === 2);

// Cruzados: select/update/delete → 0 linhas.
const crossSel = await A.client.from("ratings").select("tmdb_id").eq("user_id", B.id);
check("A NÃO lê rating B (0 linhas)", crossSel.error === null && crossSel.data?.length === 0);
const crossUpd = await A.client.from("ratings").update({ rating: 1 }).eq("user_id", B.id).select("tmdb_id");
check("A NÃO altera rating B (0 linhas)", crossUpd.data?.length === 0);
const crossDel = await A.client.from("ratings").delete().eq("user_id", B.id).select("tmdb_id");
check("B NÃO remove rating A (0 linhas)",
  (await B.client.from("ratings").delete().eq("user_id", A.id).select("tmdb_id")).data?.length === 0
  && crossDel.data?.length === 0);

// Integridade após tentativas.
const intactA = await A.client.from("ratings").select("rating").eq("tmdb_id", 550);
const intactB = await B.client.from("ratings").select("rating").eq("tmdb_id", 1396);
check("rating de A intacto (5)", intactA.data?.length === 1 && intactA.data[0].rating === 5);
check("rating de B intacto (2)", intactB.data?.length === 1 && intactB.data[0].rating === 2);

// Create/update: 5 → 3 mesma row, updated_at muda.
const before = await A.client.from("ratings").select("rated_at,updated_at").eq("tmdb_id", 550).eq("media_type", "movie").single();
await new Promise((r) => setTimeout(r, 1100));
const upd = await A.client.from("ratings").update({ rating: 3 }).eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550).select("rating,rated_at,updated_at");
check("update próprio 5→3", upd.error === null && upd.data?.length === 1 && upd.data[0].rating === 3);
const afterUpd = await A.client.from("ratings").select("tmdb_id").eq("user_id", A.id);
check("ainda 1 row após update", afterUpd.data?.length === 1);
check("updated_at mudou no update",
  before.data && upd.data?.[0] && upd.data[0].updated_at !== before.data.updated_at);

// Valores: 1 e 5 aceitos; 0, 6 e 2.5 rejeitados (CHECK/smallint).
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 771, title: "Filme 771" }).select("tmdb_id");
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 772, title: "Filme 772" }).select("tmdb_id");
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 773, title: "Filme 773" }).select("tmdb_id");
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 774, title: "Filme 774" }).select("tmdb_id");
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 775, title: "Filme 775" }).select("tmdb_id");
const v1 = await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 771, media_type: "movie", rating: 1 }).select("tmdb_id");
check("rating 1 aceito", v1.error === null && v1.data?.length === 1);
const v5 = await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 772, media_type: "movie", rating: 5 }).select("tmdb_id");
check("rating 5 aceito", v5.error === null && v5.data?.length === 1);
const v0 = await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 773, media_type: "movie", rating: 0 }).select("tmdb_id");
check("CHECK rejeita rating 0", v0.error !== null);
const v6 = await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 774, media_type: "movie", rating: 6 }).select("tmdb_id");
check("CHECK rejeita rating 6", v6.error !== null);
const vHalf = await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 775, media_type: "movie", rating: 2.5 }).select("tmdb_id");
check("rejeita rating 2.5 (sem meia estrela)", vHalf.error !== null);
for (const id of [771, 772]) {
  await A.client.from("ratings").delete().eq("user_id", A.id).eq("tmdb_id", id);
  await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", id);
}
for (const id of [773, 774, 775]) {
  await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("tmdb_id", id);
}

// Rating sem watched falha (FK) e não cria linha.
const noWatched = await A.client.from("ratings")
  .insert({ user_id: A.id, tmdb_id: 987654, media_type: "movie", rating: 4 }).select("tmdb_id");
check("rating sem watched falha (FK)", noWatched.error !== null);
const noRow = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 987654);
check("nenhuma linha órfã criada", noRow.data?.length === 0);

// Delete rating mantém watched.
const delR = await A.client.from("ratings").delete().eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 550).select("tmdb_id");
const stillW = await A.client.from("watched_titles").select("tmdb_id").eq("tmdb_id", 550).eq("media_type", "movie");
const goneR = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 550).eq("media_type", "movie");
check("delete rating mantém watched", delR.data?.length === 1 && stillW.data?.length === 1 && goneR.data?.length === 0);

// Cascade: watched + rating → delete watched apaga rating.
await A.client.from("watched_titles").insert({ ...wA, tmdb_id: 780, title: "Filme 780" }).select("tmdb_id");
await A.client.from("ratings").insert({ user_id: A.id, tmdb_id: 780, media_type: "movie", rating: 5 }).select("tmdb_id");
const wCount1 = await A.client.from("watched_titles").select("tmdb_id").eq("tmdb_id", 780);
const rCount1 = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 780);
check("base cascade: watched 1, rating 1", wCount1.data?.length === 1 && rCount1.data?.length === 1);
await A.client.from("watched_titles").delete().eq("user_id", A.id).eq("media_type", "movie").eq("tmdb_id", 780);
const wCount0 = await A.client.from("watched_titles").select("tmdb_id").eq("tmdb_id", 780);
const rCount0 = await A.client.from("ratings").select("tmdb_id").eq("tmdb_id", 780);
check("delete watched remove rating (cascade)", wCount0.data?.length === 0 && rCount0.data?.length === 0);

// Limpeza (DELETE próprio, permitido pelo RLS).
await A.client.from("ratings").delete().eq("user_id", A.id);
await B.client.from("ratings").delete().eq("user_id", B.id);
await A.client.from("watched_titles").delete().eq("user_id", A.id);
await B.client.from("watched_titles").delete().eq("user_id", B.id);
const cleanA = await A.client.from("ratings").select("tmdb_id");
const cleanB = await B.client.from("ratings").select("tmdb_id");
check("limpeza: A remove as próprias", cleanA.data?.length === 0);
check("limpeza: B remove as próprias", cleanB.data?.length === 0);

// Limpeza: sem service_role no app, os usuários de teste (ratings-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users
// (a cascata apaga as linhas restantes, se houver).
console.log("---");
console.log(failures === 0 ? "RATINGS OK: RLS + update + cascade confirmados." : `RATINGS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
