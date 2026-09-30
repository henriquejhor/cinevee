/**
 * GET /api/public/profile/[username]/followers — seguidores públicos.
 *
 * Sem autenticação (visitante anônimo). Lê SOMENTE via RPC allowlisted
 * (get_public_followers): só seguidores com perfil público, recentes
 * primeiro, e só quando o dono é público. Privado/inexistente → 404
 * genérico (sem distinguir).
 * Params: `page` (inteiro 1..1000, default 1), teto 24/página.
 * Resposta: 200 { items, page, hasMore } · 404 · 502 sem vazar SQL.
 * Nunca expõe UUID, email, flags, datas ou follower_ids.
 */
import type { APIRoute } from "astro";
import {
  getPublicFollowers,
  getPublicProfile,
  getPublicSupabase,
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
    if (!profile) {
      return Response.json({ error: "Perfil não disponível." }, { status: 404 });
    }
    const result = await getPublicFollowers(supabase, username, page);
    return Response.json({ ...result, pageSize: PUBLIC_PAGE_SIZE });
  } catch {
    console.error("[PublicProfile] Falha em followers públicos.");
    return Response.json(
      { error: "Não foi possível carregar os seguidores agora." },
      { status: 502 },
    );
  }
};
