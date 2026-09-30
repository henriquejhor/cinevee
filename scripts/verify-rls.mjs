/**
 * Verificação de RLS da tabela public.profiles (Etapa 2).
 *
 * Pré-requisito: migration supabase/migrations/20260922120000_profiles.sql
 * aplicada no projeto (Dashboard → SQL Editor).
 *
 * Uso:  npm run verify:rls
 *
 * Cria dois usuários de teste (A e B) via signup com a chave publishable
 * (nada de service_role) e confirma isolamento total:
 *   A lê A · A edita A · B lê B · B edita B ·
 *   A NÃO lê/edita B · B NÃO lê/edita A.
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
  email: `rls-${tag}-${stamp}@example.com`,
  password: `RlsVerificacao123!${tag}`,
  name: `RLS ${tag.toUpperCase()} ${stamp}`,
});

let failures = 0;

function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}

async function signUpAndClient({ email, password, name }) {
  const anon = createClient(URL, KEY);
  const { data, error } = await anon.auth.signUp({
    email,
    password,
    options: { data: { display_name: name } },
  });
  if (error || !data.session || !data.user) {
    throw new Error(`signup ${email} falhou (sessão nula — confirmação de e-mail ligada?)`);
  }
  return { client: anon, id: data.user.id, email };
}

function profileOps(client) {
  return {
    read: (id) => client.from("profiles").select("id, display_name").eq("id", id),
    updateName: (id, displayName) =>
      client.from("profiles").update({ display_name: displayName }).eq("id", id).select("id"),
  };
}

const A = makeUser("a");
const B = makeUser("b");

const userA = await signUpAndClient(A);
const userB = await signUpAndClient(B);
const opsA = profileOps(userA.client);
const opsB = profileOps(userB.client);

// Espera o trigger de criação automática (eventual, normalmente imediato).
async function waitForProfile(ops, id) {
  for (let i = 0; i < 10; i += 1) {
    const { data } = await ops.read(id);
    if (data && data.length === 1) return data[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const rowA = await waitForProfile(opsA, userA.id);
const rowB = await waitForProfile(opsB, userB.id);

check("trigger criou profile de A com display_name do metadata", rowA?.display_name === A.name);
check("trigger criou profile de B com display_name do metadata", rowB?.display_name === B.name);

// Leitura própria.
const ownA = await opsA.read(userA.id);
check("A lê A (1 linha)", ownA.error === null && ownA.data?.length === 1);
const ownB = await opsB.read(userB.id);
check("B lê B (1 linha)", ownB.error === null && ownB.data?.length === 1);

// Leitura cruzada (RLS deve retornar 0 linhas, sem erro vazar dados).
const crossAB = await opsA.read(userB.id);
check("A NÃO lê B (0 linhas)", crossAB.error === null && crossAB.data?.length === 0);
const crossBA = await opsB.read(userA.id);
check("B NÃO lê A (0 linhas)", crossBA.error === null && crossBA.data?.length === 0);

// Edição própria.
const editA = await opsA.updateName(userA.id, `${A.name} editado`);
check("A edita A", editA.error === null && editA.data?.length === 1);
const editB = await opsB.updateName(userB.id, `${B.name} editado`);
check("B edita B", editB.error === null && editB.data?.length === 1);

// Edição cruzada (RLS: 0 linhas afetadas).
const evilAB = await opsA.updateName(userB.id, "invadido por A");
check("A NÃO edita B (0 linhas)", evilAB.data?.length === 0);
const evilBA = await opsB.updateName(userA.id, "invadido por B");
check("B NÃO edita A (0 linhas)", evilBA.data?.length === 0);

// Integridade: nomes cruzados intactos.
const intactB = await opsB.read(userB.id);
check("profile de B intacto após tentativa de A", intactB.data?.[0]?.display_name === `${B.name} editado`);
const intactA = await opsA.read(userA.id);
check("profile de A intacto após tentativa de B", intactA.data?.[0]?.display_name === `${A.name} editado`);

// Limpeza: sem service_role no app, os usuários de teste (rls-*@example.com)
// podem ser removidos depois via Dashboard → Authentication → Users
// (a cascata apaga os profiles).
console.log("---");
console.log(failures === 0 ? "RLS OK: isolamento total confirmado." : `RLS FALHOU: ${failures} asserção(ões).`);
process.exit(failures === 0 ? 0 : 1);
