/**
 * POST /api/discovery/recommendation-states — trio watchlist/watched/rating
 * para os títulos exibidos (Etapa 10).
 *
 * Body: `{ items: [{ tmdbId, mediaType }] }` (1–8 itens, validados).
 * Resposta: `{ states: { "movie:123": { inWatchlist, watched, rating } } }`.
 *
 * Autenticado (sessão server-side, RLS como enforcement). Deslogado → 401
 * (o client renderiza links de login). Só o trio sai daqui — sem email,
 * user_id, profile ou histórico.
 */
import type { APIRoute } from "astro";
import {
  getRecommendationUserStates,
  getStatesSession,
  parseStateItems,
} from "../../../lib/discovery/recommendationStates";
import { perf } from "../../../lib/perf";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para ver seus estados.";
const INVALID = "Dados inválidos.";
const LOAD_ERROR = "Não foi possível carregar seus estados.";

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getStatesSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: INVALID }, { status: 400 });
  }

  const items = parseStateItems(body);
  if (!items) {
    return Response.json({ error: INVALID }, { status: 400 });
  }

  try {
    const states = await perf("recommendation.states", () =>
      getRecommendationUserStates(ctx, items),
    );
    return Response.json({ states });
  } catch {
    console.error("[RecStates] Falha ao carregar estados.");
    return Response.json({ error: LOAD_ERROR }, { status: 500 });
  }
};
