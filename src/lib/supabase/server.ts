/**
 * Supabase server-side helper (SSR com cookies).
 *
 * Usar SOMENTE no servidor (frontmatter Astro / rotas API).
 * Nunca importar em <script> client-side.
 *
 * Sessão persistida via cookies através de `@supabase/ssr`
 * (`createServerClient` + `parseCookieHeader`). Nenhum token é
 * armazenado manualmente em localStorage.
 *
 * Autorização server-side: usar `getCurrentUser()`, que verifica o
 * usuário via `supabase.auth.getUser()` (validação junto ao
 * Supabase Auth), em vez de confiar em dados de sessão do cliente.
 */
import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { perf } from "../perf";

function getEnv(): { url: string; publishableKey: string } {
  const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env
    .PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;

  if (!url || !publishableKey) {
    throw new Error(
      "[Supabase] Variáveis PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY ausentes.",
    );
  }

  return { url, publishableKey };
}

/**
 * Cria um Supabase client server-side ligado aos cookies do Astro.
 * Leitura via header `Cookie`; escrita via `Astro.cookies.set`
 * (o adapter @astrojs/node serializa como `Set-Cookie`).
 */
export function createSupabaseServerClient(
  request: Request,
  cookies: AstroCookies,
): SupabaseClient {
  const { url, publishableKey } = getEnv();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get("Cookie") ?? "");
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          try {
            cookies.set(name, value, options);
          } catch {
            // Em páginas já renderizadas o Astro pode impedir escrita
            // tardia de cookies; o fluxo normal (antes de responder)
            // sempre escreve com sucesso.
          }
        });
      },
    },
  });
}

export interface CurrentUserResult {
  supabase: SupabaseClient;
  user: User | null;
}

export async function getCurrentUser(
  request: Request,
  cookies: AstroCookies,
): Promise<CurrentUserResult> {
  // Medição DEV-only (perf.ts vira passthrough em produção).
  return perf("auth.getUser", () => getCurrentUserInner(request, cookies));
}

/**
 * Retorna o usuário atual verificado server-side (`auth.getUser()`).
 * Centralizar aqui qualquer decisão de autorização SSR.
 */
async function getCurrentUserInner(
  request: Request,
  cookies: AstroCookies,
): Promise<CurrentUserResult> {
  const supabase = createSupabaseServerClient(request, cookies);
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return { supabase, user: null };
  }

  return { supabase, user: data.user };
}

/**
 * Nome de exibição: `user_metadata.display_name` (etapa fundação,
 * sem tabela profiles) com fallback para o e-mail.
 */
export function getDisplayName(
  user: Pick<User, "email" | "user_metadata"> | null | undefined,
): string {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const displayName =
    typeof meta.display_name === "string" ? meta.display_name.trim() : "";
  if (displayName.length > 0) return displayName;
  return user?.email ?? "";
}

/**
 * Valida um destino de redirecionamento pós-login (`?next=`).
 * Aceita apenas caminhos internos relativos — evita open redirect.
 * Barras invertidas e controles são rejeitados: em `Location`, o
 * parser WHATWG trata `\` como `/` para http(s), então `/\evil.com`
 * resolveria para `https://evil.com/` (bypass do filtro `//`).
 */
export function sanitizeNext(next: string | null | undefined): string {
  if (!next) return "/perfil";
  if (!next.startsWith("/")) return "/perfil";
  if (next.startsWith("//")) return "/perfil";
  // Bypass scheme-relative via backslash (`/\host`).
  if (next.length > 1 && next[1] === "\\") return "/perfil";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "/perfil";
  return next;
}

/**
 * Traduz erros comuns do Supabase Auth para mensagens amigáveis pt-BR,
 * sem expor payload interno, stack trace ou tokens.
 */
export function toFriendlyAuthError(
  error: unknown,
  fallback: string,
): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : "";

  if (
    message.includes("invalid login credentials") ||
    message.includes("invalid_grant")
  ) {
    return "E-mail ou senha incorretos. Confira e tente de novo.";
  }
  if (
    message.includes("user already registered") ||
    message.includes("already been registered") ||
    message.includes("already exists")
  ) {
    return "Este e-mail já está cadastrado. Tente entrar.";
  }
  if (message.includes("email not confirmed")) {
    return "Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.";
  }
  if (
    message.includes("password") &&
    (message.includes("short") ||
      message.includes("weak") ||
      message.includes("length") ||
      message.includes("characters"))
  ) {
    return "A senha não atende aos requisitos mínimos. Use pelo menos 8 caracteres.";
  }
  if (
    message.includes("invalid email") ||
    message.includes("invalid_email") ||
    message.includes("email address")
  ) {
    return "Informe um e-mail válido.";
  }
  if (
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("over request")
  ) {
    return "Muitas tentativas. Aguarde um momento e tente de novo.";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("failed to fetch")
  ) {
    return "Não foi possível conectar. Verifique sua internet e tente de novo.";
  }

  return fallback;
}
