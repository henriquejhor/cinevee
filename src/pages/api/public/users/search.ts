/**
 * GET /api/public/users/search — busca de pessoas (Etapa 15).
 *
 * Sem autenticação (visitante anônimo ou logado). Lê SOMENTE via RPC
 * allowlisted (search_public_profiles): retorna perfis com profile_public
 * + discoverable + username válido, ordenados (exato → prefixo → contém).
 * Params: `q` (mínimo 2 caracteres após normalização; curto → 200 []).
 * Resposta: 200 { results: [{ displayName, username, bio, avatarUrl }] }.
 * Falha interna → 502 genérico (sem vazar SQL). Nunca expõe UUID, email,
 * flags, preferências ou qualquer dado além da identidade pública.
 */
import type { APIRoute } from "astro";
import {
  getPublicSupabase,
  normalizeUserSearchQuery,
  searchPublicProfiles,
} from "../../../../lib/publicProfile/service";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const query = normalizeUserSearchQuery(url.searchParams.get("q") ?? "");
  const supabase = getPublicSupabase(request, cookies);

  try {
    const results = await searchPublicProfiles(supabase, query);
    return Response.json({ results });
  } catch {
    console.error("[PublicProfile] Falha na busca de pessoas.");
    return Response.json(
      { error: "Não foi possível buscar pessoas agora." },
      { status: 502 },
    );
  }
};
