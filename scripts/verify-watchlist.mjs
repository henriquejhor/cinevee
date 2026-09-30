/**
 * Verificação de RLS da tabela public.watchlist (Etapa 4).
 *
 * Pré-requisito: migration supabase/migrations/20260923090000_watchlist.sql
 * aplicada no projeto (Dashboard → SQL Editor).
 *
 * Uso:  npm run verify:watchlist
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e dois usuários
 * de teste (A e B) criados via signup:
 *   A adiciona movie 550 · B adiciona outro conteúdo ·
 *   A vê A · B vê B · A NÃO vê/edita B · B NÃO vê/edita A ·
 *   duplicata não duplica · movie:550 ≠ tv:550 · CHECKs bloqueiam inválidos ·
 *   integridade intacta após tentativas.
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

const stamp = Date.now();
const makeUser = (tag) => ({
  email: `watch-${tag}-${stamp}@example.com`,
  password: `WatchVerificacao123!${tag}`,
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

const rowA = {
  user_id: A.id, tmdb_id: 550, media_type: "movie",
  title: "Clube da Luta", poster_path: "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg", release_year: 1999,
};
const rowB = {
  user_id: B.id, tmdb_id: 1396, media_type: "tv",
  title: "Breaking Bad", poster_path: "/ggFHVNu6YYI5L9pCfOacjizRGt.jpg", release_year: 2008,
};

// A adiciona movie 550 · B adiciona outro conteúdo.
const insA = await A.client.from("watchlist").insert(rowA).select("tmdb_id");
check("A adiciona movie 550", insA.error === null && insA.data?.length === 1);
const insB = await B.client.from("watchlist").insert(rowB).select("tmdb_id");
check("B adiciona tv 1396", insB.error === null && insB.data?.length === 1);

// A vê A · B vê B.
const seeA = await A.client.from("watchlist").select("tmdb_id,media_type");
check("A vê A (só a própria linha)", seeA.error === null && seeA.data?.length === 1
  && seeA.data[0].tmdb_id === 550 && seeA.data[0].media_type === "movie");
const seeB = await B.client.from("watchlist").select("tmdb_id,media_type");
check("B vê B (só a própria linha)", seeB.error === null && seeB.data?.length === 1
  && seeB.data[0].tmdb_id === 1396 && seeB.data[0].media_type === "tv");

// A NÃO vê B · B NÃO vê A (filtro cruzado retorna 0 linhas).
const crossAB = await A.client.from("watchlist").select("tmdb_id").eq("user_id", B.id);
check("A NÃO vê B (0 linhas)", crossAB.error === null && crossAB.data?.length === 0);
const crossBA = await B.client.from("watchlist").select("tmdb_id").eq("user_id", A.id);
check("B NÃO vê A (0 linhas)", crossBA.error === null && crossBA.data?.length === 0);

// A NÃO remove B · B NÃO remove A.
const delAB = await A.client.from("watchlist").delete().eq("user_id", B.id).select("tmdb_id");
check("A NÃO remove B (0 linhas)", delAB.data?.length === 0);
const delBA = await B.client.from("watchlist").delete().eq("user_id", A.id).select("tmdb_id");
check("B NÃO remove A (0 linhas)", delBA.data?.length === 0);

// Integridade após tentativas.
const intactA = await A.client.from("watchlist").select("tmdb_id");
const intactB = await B.client.from("watchlist").select("tmdb_id");
check("linha de A intacta", intactA.data?.length === 1 && intactA.data[0].tmdb_id === 550);
check("linha de B intacta", intactB.data?.length === 1 && intactB.data[0].tmdb_id === 1396);

// Duplicata: mesmo user+type+id → violação de unicidade, continua 1 linha.
const dup = await A.client.from("watchlist").insert(rowA).select("tmdb_id");
check("duplicata rejeitada (unique)", dup.error !== null);
const afterDup = await A.client.from("watchlist").select("tmdb_id").eq("tmdb_id", 550).eq("media_type", "movie");
check("ainda 1 linha após duplicata", afterDup.data?.length === 1);

// movie:550 ≠ tv:550 (identidades diferentes por media_type).
const tv550 = await A.client.from("watchlist")
  .insert({ ...rowA, media_type: "tv", title: "Série 550" }).select("tmdb_id,media_type");
check("tv:550 coexiste com movie:550", tv550.error === null && tv550.data?.length === 1);
const both = await A.client.from("watchlist").select("media_type").eq("tmdb_id", 550);
check("A tem 2 linhas para tmdb 550 (movie+tv)", both.data?.length === 2);

// CHECKs: media_type inválido e tmdb_id <= 0 bloqueados.
const badType = await A.client.from("watchlist")
  .insert({ user_id: A.id, tmdb_id: 1, media_type: "book", title: "X" }).select("tmdb_id");
check("CHECK bloqueia media_type inválido", badType.error !== null);
const badId = await A.client.from("watchlist")
  .insert({ user_id: A.id, tmdb_id: -5, media_type: "movie", title: "X" }).select("tmdb_id");
check("CHECK bloqueia tmdb_id <= 0", badId.error !== null);

// Limpeza das linhas de teste (DELETE próprio, permitido pelo RLS).
await A.client.from("watchlist").delete().eq("user_id", A.id);
await B.client.from("watchlist").delete().eq("user_id", B.id);
const cleanA = await A.client.from("watchlist").select("tmdb_id");
const cleanB = await B.client.from("watchlist").select("tmdb_id");
check("limpeza: A remove as próprias", cleanA.data?.length === 0);
check("limpeza: B remove as próprias", cleanB.data?.length === 0);

// Limpeza: sem service_role no app, os usuários de teste (watch-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users
// (a cascata apaga as linhas restantes, se houver).
console.log("---");
console.log(failures === 0 ? "RLS OK: isolamento total confirmado." : `RLS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
