/**
 * POST /api/auth/logout — encerra a sessão (cookies) e redireciona para /.
 *
 * Não apaga estado local do Discovery (localStorage do navegador
 * permanece intacto — só a sessão Supabase é destruída).
 */
import type { APIRoute } from "astro";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const supabase = createSupabaseServerClient(request, cookies);
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("[Auth] Falha no logout.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[Auth] Falha no logout (${message}).`);
  }

  return new Response(null, {
    status: 303,
    headers: { Location: "/" },
  });
};
