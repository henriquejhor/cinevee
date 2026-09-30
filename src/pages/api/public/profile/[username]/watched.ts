/**
 * GET /api/public/profile/[username]/watched — assistidos públicos.
 *
 * Sem autenticação (visitante anônimo). Lê SOMENTE via RPC allowlisted
 * (get_public_watched): retorna rows só quando profile_public + show_watched.
 * Params: `page` (inteiro 1..1000, default 1), teto 24/página.
 * Resposta: 200 { items, page, hasMore } · 404 perfil indisponível/página
 * inválida · 502 falha interna (sem vazar SQL).
 * Nunca aceita userId; nunca expõe UUID, email ou watched_at.
 */
import type { APIRoute } from "astro";
import {
  getPublicProfile,
  getPublicSupabase,
  getPublicWatched,
  normalizePublicUsername,
  parsePublicPage,
  PUBLIC_PAGE_SIZE,
} from "../../../../../lib/publicProfile/service";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, cookies, url }) => {
  const username = normalizePublicUsername(params.username);
  if (!username) {
    return Response.json({ error: "Perfil não disponível." }, { status: 404 });
  }

  const page = parsePublicPage(url.searchParams.get("page") ?? "1");
  if (page === null) {
    return Response.json({ error: "Página inválida." }, { status: 404 });
  }

  const supabase = getPublicSupabase(request, cookies);

  try {
    const profile = await getPublicProfile(supabase, username);
    if (!profile || !profile.showWatched) {
      return Response.json({ error: "Perfil não disponível." }, { status: 404 });
    }
    const result = await getPublicWatched(supabase, username, page);
    return Response.json({ ...result, pageSize: PUBLIC_PAGE_SIZE });
  } catch {
    console.error("[PublicProfile] Falha em watched público.");
    return Response.json(
      { error: "Não foi possível carregar os assistidos agora." },
      { status: 502 },
    );
  }
};
