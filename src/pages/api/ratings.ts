/**
 * /api/ratings — Avaliações de assistidos (tudo autenticado via sessão server-side).
 *
 * GET — avaliações do usuário com dados visuais (mais recentes primeiro):
 *   200 { items } (cada item inclui `reviewText: string | null`).
 * POST — cria ou altera { tmdbId, mediaType, rating 1–5, reviewText? }:
 *   exige o título em watched_titles do usuário. `reviewText` omitido →
 *   preserva a opinião existente (compat com chamadas antigas);
 *   `null`/`""` → limpa a opinião mantendo a nota.
 *   200 { ok: true, item } · 404/409 título não assistido · 400 input inválido.
 * PATCH — edita SÓ a opinião { tmdbId, mediaType, reviewText }: exige
 *   rating existente (review depende de rating). `null` remove a opinião.
 *   200 { ok: true, item } · 404 sem rating · 400 input inválido.
 * DELETE — remove { tmdbId, mediaType }: apaga nota + opinião (mesma row).
 *   Mantém o título em Assistidos. 200 { ok: true, removed }.
 *
 * O browser nunca envia user_id. Erros nunca vazam SQL, stack trace ou tokens.
 * TasteProfile NÃO consome review_text (conteúdo de perfil, não sinal).
 */
import type { APIRoute } from "astro";
import {
  getRatingsSession,
  getUserRatings,
  NotWatchedError,
  removeRating,
  ReviewRequiresRatingError,
  setRating,
  updateReview,
} from "../../lib/ratings/service";
import {
  RatingValidationError,
  validateRatingInput,
  validateRatingKey,
  validateReviewUpdateInput,
} from "../../lib/ratings/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para avaliar títulos.";
const LOAD_ERROR = "Não foi possível carregar suas avaliações.";
const SAVE_ERROR = "Não foi possível salvar sua avaliação.";
const REVIEW_SAVE_ERROR = "Não foi possível salvar sua opinião.";
const REMOVE_ERROR = "Não foi possível remover sua avaliação.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const items = await getUserRatings(ctx);
    return Response.json({ items });
  } catch {
    console.error("[Ratings] Falha ao carregar avaliações.");
    return Response.json({ error: LOAD_ERROR }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingsSession(request, cookies);
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
    const input = validateRatingInput(body);
    const item = await setRating(ctx, input);
    return Response.json({ ok: true, item });
  } catch (error) {
    if (error instanceof RatingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof NotWatchedError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("[Ratings] Falha ao salvar avaliação.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingsSession(request, cookies);
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
    const input = validateReviewUpdateInput(body);
    const item = await updateReview(ctx, input, input.reviewText);
    return Response.json({ ok: true, item });
  } catch (error) {
    if (error instanceof RatingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ReviewRequiresRatingError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Ratings] Falha ao salvar opinião.");
    return Response.json({ error: REVIEW_SAVE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingsSession(request, cookies);
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
    const key = validateRatingKey(body);
    const removed = await removeRating(ctx, key);
    return Response.json({ ok: true, removed });
  } catch (error) {
    if (error instanceof RatingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Ratings] Falha ao remover avaliação.");
    return Response.json({ error: REMOVE_ERROR }, { status: 500 });
  }
};
