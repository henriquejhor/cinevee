/**
 * /api/watchlist — Minha Lista (tudo autenticado via sessão server-side).
 *
 * GET — lista do usuário (mais recentes primeiro): 200 { items }.
 * POST — adiciona { tmdbId, mediaType }: valida sessão + input, confirma
 *   o título no TMDB server-side, idempotente (re-adicionar não duplica).
 *   200 { ok: true, item } · 404 título inexistente · 502 TMDB fora.
 * DELETE — remove { tmdbId, mediaType }: 200 { ok: true, removed }.
 *
 * O browser nunca envia user_id; title/poster/year do body são ignorados.
 * Erros nunca vazam payload interno, stack trace ou tokens.
 */
import type { APIRoute } from "astro";
import {
  addToWatchlist,
  getUserWatchlist,
  getWatchlistSession,
  removeFromWatchlist,
  TitleNotFoundError,
} from "../../lib/watchlist/service";
import {
  WatchlistValidationError,
  validateWatchlistInput,
} from "../../lib/watchlist/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para usar sua lista.";
const LOAD_ERROR = "Não foi possível carregar sua lista.";
const SAVE_ERROR = "Não foi possível salvar na sua lista.";
const REMOVE_ERROR = "Não foi possível remover da sua lista.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const ctx = await getWatchlistSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const items = await getUserWatchlist(ctx);
    return Response.json({ items });
  } catch {
    console.error("[Watchlist] Falha ao carregar lista.");
    return Response.json({ error: LOAD_ERROR }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getWatchlistSession(request, cookies);
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
    const input = validateWatchlistInput(body);
    const item = await addToWatchlist(ctx, input);
    return Response.json({ ok: true, item });
  } catch (error) {
    if (error instanceof WatchlistValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TitleNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Watchlist] Falha ao salvar na lista.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getWatchlistSession(request, cookies);
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
    const input = validateWatchlistInput(body);
    const removed = await removeFromWatchlist(ctx, input);
    return Response.json({ ok: true, removed });
  } catch (error) {
    if (error instanceof WatchlistValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Watchlist] Falha ao remover da lista.");
    return Response.json({ error: REMOVE_ERROR }, { status: 500 });
  }
};
