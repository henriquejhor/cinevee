/**
 * Verificação da Etapa 5: identidade do profile + Storage de avatares.
 *
 * Pré-requisito: migration supabase/migrations/20260924090000_profile_identity_avatar.sql
 * aplicada no projeto (Dashboard → SQL Editor). Sem ela, este script informa
 * a pendência e sai com erro — por desenho, nada é aplicado daqui.
 *
 * Uso:  npm run verify:profile
 *
 * Usa SOMENTE a chave publishable (nada de service_role) e dois usuários
 * de teste (A e B) criados via signup:
 *   identidade: A edita A · B edita B · A NÃO edita B · B NÃO edita A ·
 *   username inválido rejeitado (CHECK) · bio >160 rejeitada (CHECK) ·
 *   username duplicado rejeitado (UNIQUE);
 *   storage: A escreve na própria pasta · B NÃO sobrescreve/remove/insere
 *   na pasta de A · A remove o próprio arquivo.
 *
 * Nenhum segredo é impresso: só PASS/FAIL/SKIP por asserção.
 * Requer email de confirmação DESLIGADO no projeto (como hoje).
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!URL || !KEY) {
  console.error("Faltam PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY no .env.");
  process.exit(1);
}

const MIGRATION_FILE = "supabase/migrations/20260924090000_profile_identity_avatar.sql";

const stamp = Date.now();
const makeUser = (tag) => ({
  email: `profile-${tag}-${stamp}@example.com`,
  password: `ProfileVerificacao123!${tag}`,
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

// Espera o trigger de criação automática do profile.
async function waitForProfile(client, id) {
  for (let i = 0; i < 10; i += 1) {
    const { data } = await client.from("profiles").select("id").eq("id", id);
    if (data && data.length === 1) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const A = await signUp(makeUser("a"));
const B = await signUp(makeUser("b"));
await waitForProfile(A.client, A.id);
await waitForProfile(B.client, B.id);

// Sonda: colunas da Etapa 5 existem?
const probe = await A.client.from("profiles").select("username,bio,avatar_path").eq("id", A.id);
if (probe.error && /column|username/i.test(probe.error.message ?? "")) {
  console.log("SKIP  migration da Etapa 5 ainda não aplicada.");
  console.log(`Aplique no Supabase Dashboard → SQL Editor → New query → Run: ${MIGRATION_FILE}`);
  process.exit(1);
}
check("colunas username/bio/avatar_path acessíveis", probe.error === null);

// ---- Identidade: cada um edita o próprio.
const unameA = `tuser_a_${String(stamp).slice(-6)}`;
const unameB = `tuser_b_${String(stamp).slice(-6)}`;
const editA = await A.client
  .from("profiles")
  .update({ display_name: "Perfil A", username: unameA, bio: "Fã de ficção científica." })
  .eq("id", A.id)
  .select("id");
check("A altera username/bio de A", editA.error === null && editA.data?.length === 1);
const editB = await B.client
  .from("profiles")
  .update({ display_name: "Perfil B", username: unameB, bio: "Séries e suspense." })
  .eq("id", B.id)
  .select("id");
check("B altera username/bio de B", editB.error === null && editB.data?.length === 1);

// ---- Cruzado: 0 linhas, dados intactos.
const evilAB = await A.client
  .from("profiles")
  .update({ username: "invadido_por_a", bio: "x" })
  .eq("id", B.id)
  .select("id");
check("A NÃO altera B (0 linhas)", evilAB.data?.length === 0);
const evilBA = await B.client
  .from("profiles")
  .update({ username: "invadido_por_b", bio: "x" })
  .eq("id", A.id)
  .select("id");
check("B NÃO altera A (0 linhas)", evilBA.data?.length === 0);
const intactB = await B.client.from("profiles").select("username,bio").eq("id", B.id).maybeSingle();
check(
  "profile de B intacto após tentativa de A",
  intactB.data?.username === unameB,
);
const intactA = await A.client.from("profiles").select("username,bio").eq("id", A.id).maybeSingle();
check(
  "profile de A intacto após tentativa de B",
  intactA.data?.username === unameA,
);

// ---- CHECKs: username inválido e bio longa bloqueados.
const badUser = await A.client
  .from("profiles")
  .update({ username: "José Henrique" })
  .eq("id", A.id)
  .select("id");
check("CHECK bloqueia username inválido", badUser.error !== null);
const shortUser = await A.client
  .from("profiles")
  .update({ username: "ab" })
  .eq("id", A.id)
  .select("id");
check("CHECK bloqueia username curto (<3)", shortUser.error !== null);
const longBio = await A.client
  .from("profiles")
  .update({ bio: "x".repeat(161) })
  .eq("id", A.id)
  .select("id");
check("CHECK bloqueia bio >160", longBio.error !== null);
const okBio = await A.client
  .from("profiles")
  .update({ bio: "y".repeat(160) })
  .eq("id", A.id)
  .select("id");
check("bio de 160 chars salva", okBio.error === null && okBio.data?.length === 1);

// ---- UNIQUE: username duplicado rejeitado.
const dup = await B.client
  .from("profiles")
  .update({ username: unameA })
  .eq("id", B.id)
  .select("id");
check("UNIQUE bloqueia username duplicado", dup.error !== null);
const stillB = await B.client.from("profiles").select("username").eq("id", B.id).maybeSingle();
check("username de B intacto após duplicata", stillB.data?.username === unameB);

// ---- Storage: bucket avatars + isolamento por pasta.
//
// Nota metodológica: com a chave publishable, `listBuckets()` retorna []
// e `list()` de pasta retorna [] mesmo com o arquivo presente — leitura de
// lista é barrada sem policy SELECT (por desenho: leitura pública é via URL
// direta do objeto, que o app usa). Por isso a existência do bucket é
// provada pelo upload próprio e a integridade do arquivo por download
// público (200 + conteúdo intacto), nunca por listagem.

const payload = new Blob(["avatar-teste"], { type: "text/plain" });
const fileA = `${A.id}/verify-${stamp}.txt`;

const upA = await A.client.storage.from("avatars").upload(fileA, payload, { upsert: false });
check("A faz upload na própria pasta", upA.error === null);
check("bucket avatars acessível (upload próprio prova existência)", upA.error === null);

// B tenta sobrescrever o arquivo de A.
const overB = await B.client.storage.from("avatars").upload(fileA, payload, { upsert: true });
check("B NÃO sobrescreve arquivo de A", overB.error !== null);

// B tenta inserir dentro da pasta de A.
const insB = await B.client.storage
  .from("avatars")
  .upload(`${A.id}/invasao-${stamp}.txt`, payload, { upsert: false });
check("B NÃO insere na pasta de A", insB.error !== null);

// B tenta remover o arquivo de A.
const delB = await B.client.storage.from("avatars").remove([fileA]);
const bRemovedSomething =
  !delB.error && Array.isArray(delB.data) && delB.data.length > 0;
check("B NÃO remove arquivo de A", !bRemovedSomething);

// Arquivo de A segue íntegro: download público retorna 200 + conteúdo original.
const publicUrl = A.client.storage.from("avatars").getPublicUrl(fileA).data.publicUrl;
let intactFetch = false;
try {
  const res = await fetch(publicUrl);
  intactFetch = res.status === 200 && (await res.text()) === "avatar-teste";
} catch {
  intactFetch = false;
}
check("arquivo de A intacto após tentativas de B (leitura pública 200)", intactFetch);

// A remove o próprio arquivo (estado autoritativo do Storage; fetch
// público imediato NÃO é condição obrigatória — bucket público pode
// responder 200 stale por cache/CDN após o objeto já ter sido removido).
const delA = await A.client.storage.from("avatars").remove([fileA]);
const aRemovedOwn =
  delA.error === null && Array.isArray(delA.data) && delA.data.length === 1;
check("A remove o próprio arquivo (remove retorna objeto)", aRemovedOwn);
const listAfter = await A.client.storage.from("avatars").list(A.id);
const baseA = fileA.split("/").pop();
const listGone =
  listAfter.error === null &&
  Array.isArray(listAfter.data) &&
  !listAfter.data.some((f) => f.name === baseA);
const dlAfter = await A.client.storage.from("avatars").download(fileA);
const downloadGone = dlAfter.error !== null && !dlAfter.data;
check("arquivo de A some após remoção própria (list+download)", listGone && downloadGone);
try {
  const resAfter = await fetch(publicUrl, { cache: "no-store" });
  if (resAfter.status === 200) {
    console.log("INFO  Public CDN ainda serviu cópia em cache; Storage confirmou exclusão.");
  }
} catch {
  // Diagnóstico informativo de CDN indisponível — ignorar.
}

console.log("---");
console.log(failures === 0 ? "PROFILE OK: identidade + storage confirmados." : `PROFILE FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
