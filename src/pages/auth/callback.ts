/**
 * GET /auth/callback — retorno do Google OAuth (Supabase Auth).
 *
 * Fluxo: botão "Continuar com Google" → signInWithOAuth (browser) →
 * Google → Supabase → GET /auth/callback?code=…[&next=…] →
 * exchangeCodeForSession (cookies via @supabase/ssr) → 303 dest.
 *
 * - `code` ausente ou troca falha → 303 /entrar?error=oauth (genérico,
 *   sem vazar motivo, tokens ou PII).
 * - `next` opcional passa por sanitizeNext (anti open-redirect);
 *   ausente → "/" (padrão deste callback).
 * - GET puro: sem POST, sem impacto no checkOrigin/CSRF.
 * - Sem service_role, sem localStorage, sem provider_token, sem scopes
 *   extras (identidade básica do provider).
 * - Conta nova: o trigger public.handle_new_user cria o profile
 *   automaticamente; identity linking fica com o Supabase (sem merge
 *   manual por e-mail no app).
 */
import type { APIRoute } from "astro";
import {
  createSupabaseServerClient,
  sanitizeNext,
} from "../../lib/supabase/server";

export const prerender = false;

const OAUTH_FALLBACK = "/entrar?error=oauth";

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next");
  const dest = rawNext ? sanitizeNext(rawNext) : "/";

  const fail = () =>
    new Response(null, { status: 303, headers: { Location: OAUTH_FALLBACK } });

  // Inclui o caso "usuário negou no Google" (?error=access_denied sem code).
  if (!code) {
    return fail();
  }

  try {
    const supabase = createSupabaseServerClient(request, cookies);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[Auth] OAuth callback: troca de código falhou.");
      return fail();
    }
  } catch {
    console.error("[Auth] OAuth callback: troca de código falhou.");
    return fail();
  }

  return new Response(null, { status: 303, headers: { Location: dest } });
};
