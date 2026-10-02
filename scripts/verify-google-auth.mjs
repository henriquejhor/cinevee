/**
 * Verificação do Google Login via Supabase Auth (OAuth, sem servidor).
 *
 * Uso: node scripts/verify-google-auth.mjs
 *
 * Cobre (leitura de arquivos, sem browser, sem secrets):
 * - botão "Continuar com Google" em /entrar e /cadastrar (componente
 *   compartilhado, após o qual o form e-mail/senha é preservado);
 * - provider "google" via signInWithOAuth (sem scopes extras);
 * - redirectTo `${baseUrl}/auth/callback` com baseUrl = PUBLIC_SITE_URL
 *   (produção) ou origem local (dev) — sem Render hardcodado;
 * - rota SSR GET /auth/callback com exchangeCodeForSession;
 * - callback sem code → /entrar?error=oauth (genérico) + sanitizeNext;
 * - segurança: sem service_role, sem localStorage, sem Client Secret,
 *   sem provider_token nas peças novas;
 * - e-mail/senha intactos (signInWithPassword + signUp + cookies SSR).
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const entrar = read("../src/pages/entrar.astro");
const cadastrar = read("../src/pages/cadastrar.astro");
const callback = read("../src/pages/auth/callback.ts");
const button = read("../src/components/auth/GoogleSignIn.astro");
const server = read("../src/lib/supabase/server.ts");
const oauthFiles = [entrar, cadastrar, callback, button];

// ------------------------------------------------- botões nas páginas
check(
  "/entrar traz Google antes do form e-mail/senha",
  entrar.includes("GoogleSignIn") &&
    entrar.indexOf("<GoogleSignIn") < entrar.indexOf('id="login-form"'),
);
check(
  "/cadastrar traz Google antes do form e-mail/senha",
  cadastrar.includes("GoogleSignIn") &&
    cadastrar.indexOf("<GoogleSignIn") < cadastrar.indexOf('id="signup-form"'),
);
check(
  "componente tem botão + separador 'ou' + touch target >=48px",
  button.includes("Continuar com Google") &&
    button.includes(">ou<") &&
    button.includes("min-h-12"),
);
check(
  "componente tem loading anti clique-duplo",
  button.includes('disabled = true') && button.includes("Conectando ao Google"),
);

// ------------------------------------------------- OAuth client
check(
  'provider "google" via signInWithOAuth',
  button.includes("signInWithOAuth") && button.includes('provider: "google"'),
);
check(
  "redirectTo termina em /auth/callback (com ?next= preservado)",
  button.includes("/auth/callback?next=") && button.includes("redirectTo: redirectTo"),
);
check(
  "baseUrl: PUBLIC_SITE_URL em prod, origem local em dev (sem Render fixo)",
  button.includes("PUBLIC_SITE_URL") &&
    button.includes("window.location.origin") &&
    !button.includes("onrender.com") &&
    !button.includes("localhost:4321"),
);
check(
  "sem scopes extras além da identidade básica",
  !/scope\s*:/.test(button) && !button.includes("queryParams"),
);

// ------------------------------------------------- callback SSR
check(
  "rota /auth/callback existe como GET SSR (prerender false)",
  callback.includes("export const GET") && callback.includes("prerender = false"),
);
check(
  "callback usa cliente server/cookies + exchangeCodeForSession(code)",
  callback.includes("createSupabaseServerClient") &&
    callback.includes("exchangeCodeForSession(code)"),
);
check(
  "callback sem code → /entrar?error=oauth (genérico)",
  callback.includes("if (!code)") && callback.includes("/entrar?error=oauth"),
);
check(
  "callback aplica sanitizeNext no next (ausente → /)",
  callback.includes("sanitizeNext") && callback.includes('rawNext ? sanitizeNext(rawNext) : "/"'),
);
check(
  "páginas exibem erro genérico ?error=oauth",
  entrar.includes('get("error") === "oauth"') &&
    cadastrar.includes('get("error") === "oauth"'),
);

// ------------------------------------------------- segurança
// (padrões de USO real — comentários de documentação não contam)
check(
  "sem service_role nas peças OAuth",
  !oauthFiles.some((s) => /SERVICE_ROLE|serviceRole/.test(s)),
);
check(
  "sem localStorage nas peças OAuth (sessão só em cookies)",
  !oauthFiles.some((s) => /localStorage\s*\.\s*(set|get|remove)/.test(s)),
);
check(
  "sem Google Client Secret no código",
  !oauthFiles.some((s) => /client_secret|GOOGLE_CLIENT/i.test(s)),
);
check(
  "sem provider_token exposto",
  !oauthFiles.some((s) => /\.\s*provider_token/.test(s)),
);

// ------------------------------------------------- e-mail/senha preservados
check(
  "login e-mail/senha intacto (POST + cookies + redirect)",
  entrar.includes("signInWithPassword") &&
    entrar.includes('method="post"') &&
    entrar.includes("Astro.redirect(postNext, 303)"),
);
check(
  "cadastro e-mail/senha intacto (signUp + display_name)",
  cadastrar.includes("supabase.auth.signUp") &&
    cadastrar.includes("display_name") &&
    cadastrar.includes('method="post"'),
);
check(
  "getDisplayName cobre Google (full_name/name) com fallback e-mail",
  server.includes('"full_name"') && server.includes("user?.email"),
);

console.log("---");
console.log(
  failures === 0
    ? "GOOGLE-AUTH OK: botão, callback e seguranças confirmados."
    : `GOOGLE-AUTH FALHOU: ${failures} asserção(ões).`,
);
process.exit(failures === 0 ? 0 : 1);
