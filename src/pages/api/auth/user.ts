/**
 * GET /api/auth/user — estado de sessão para o AppHeader.
 *
 * Usa `auth.getUser()` (verificação server-side), nunca dados
 * crus do cliente. Resposta mínima, sem tokens.
 */
import type { APIRoute } from "astro";
import { getCurrentUser, getDisplayName } from "../../../lib/supabase/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies }) => {
  try {
    const { user } = await getCurrentUser(request, cookies);

    if (!user) {
      return Response.json({ authenticated: false });
    }

    return Response.json({
      authenticated: true,
      email: user.email ?? null,
      displayName: getDisplayName(user),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[Auth] Falha ao ler sessão (${message}).`);
    return Response.json({ authenticated: false }, { status: 200 });
  }
};
