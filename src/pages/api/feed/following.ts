/**
 * GET /api/feed/following — feed de quem o viewer segue (Etapa 17).
 *
 * Autenticado (sessão; viewer = auth.uid() interno, sem parâmetro de
 * usuário). Params: `page` (inteiro 1..1000, default 1), `limit`
 * opcional (inteiro 1..24, default 24 — a Home usa 6).
 * Resposta: 200 { items, page, hasMore, pageSize } · 401 deslogado ·
 * 400 página inválida · 502 sem vazar SQL.
 * Nunca expõe UUID, email, flags ou ids internos (só eventKey opaca).
 */
import type { APIRoute } from "astro";
import { privateJson } from "../../../lib/http/cache";
import {
  getFeedSession,
  getFollowingFeedPage,
} from "../../../lib/feed/service";
import { FEED_PAGE_SIZE } from "../../../lib/feed/types";
import { parsePublicPage } from "../../../lib/publicProfile/service";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para ver seu feed.";
const FEED_ERROR = "Não foi possível carregar seu feed agora.";

function parseFeedLimit(value: string | null): number | null {
  if (value === null) return FEED_PAGE_SIZE;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FEED_PAGE_SIZE) {
    return null;
  }
  return limit;
}

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const ctx = await getFeedSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  const page = parsePublicPage(url.searchParams.get("page") ?? "1");
  const limit = parseFeedLimit(url.searchParams.get("limit"));
  if (page === null || limit === null) {
    return Response.json({ error: "Página inválida." }, { status: 400 });
  }

  try {
    const result = await getFollowingFeedPage(ctx, page, limit);
    return privateJson({ ...result, pageSize: limit });
  } catch {
    console.error("[Feed] Falha ao carregar feed.");
    return Response.json({ error: FEED_ERROR }, { status: 502 });
  }
};
