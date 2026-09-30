/**
 * /api/watched — Assistidos / Já assisti (tudo autenticado via sessão server-side).
 *
 * GET — assistidos do usuário (mais recentes primeiro): 200 { items }.
 * POST — marca { tmdbId, mediaType }: valida sessão + input, confirma
 *   o título no TMDB server-side, idempotente (re-marcar não duplica) e
 *   remove o mesmo item da watchlist (se estiver lá).
 *   200 { ok: true, item, removedFromWatchlist } · 404 título inexistente.
 * DELETE — desmarca { tmdbId, mediaType }: 200 { ok: true, removed }.
 *   NÃO recria a watchlist.
 *
 * O browser nunca envia user_id; title/poster/year do body são ignorados.
 * Erros nunca vazam payload interno, stack trace ou tokens.
 */
import type { APIRoute } from "astro";
import {
  getUserWatchedTitles,
  getWatchedSession,
  markAsWatched,
  removeFromWatched,
  TitleNotFoundError,
} from "../../lib/watched/service";
import {
  WatchedValidationError,
  validateWatchedInput,
} from "../../lib/watched/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para marcar assistidos.";
const LOAD_ERROR = "Não foi possível carregar seus assistidos.";
const SAVE_ERROR = "Não foi possível marcar como assistido.";
const REMOVE_ERROR = "Não foi possível remover dos assistidos.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const ctx = await getWatchedSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const items = await getUserWatchedTitles(ctx);
    return Response.json({ items });
  } catch {
    console.error("[Watched] Falha ao carregar assistidos.");
    return Response.json({ error: LOAD_ERROR }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getWatchedSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validateWatchedInput(body);
    const { item, removedFromWatchlist } = await markAsWatched(ctx, input);
    return Response.json({ ok: true, item, removedFromWatchlist });
  } catch (error) {
    if (error instanceof WatchedValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TitleNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Watched] Falha ao marcar como assistido.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getWatchedSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validateWatchedInput(body);
    const removed = await removeFromWatched(ctx, input);
    return Response.json({ ok: true, removed });
  } catch (error) {
    if (error instanceof WatchedValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Watched] Falha ao remover dos assistidos.");
    return Response.json({ error: REMOVE_ERROR }, { status: 500 });
  }
};
