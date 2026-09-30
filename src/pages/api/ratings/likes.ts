/**
 * /api/ratings/likes — curtir/descurtir avaliações públicas (Etapa 18).
 *
 * POST — curte { username, tmdbId, mediaType }: idempotente.
 *   200 { liked: true, likeCount } · 404 "Avaliação indisponível." ·
 *   409 self-like · 400 input inválido · 401 deslogado.
 * DELETE — descurte (mesmo body): idempotente.
 *   200 { liked: false, likeCount }.
 *
 * O browser nunca envia liker_id/owner_id (servidor usa auth.uid()) e
 * nunca recebe UUID. Erros nunca vazam SQL, stack trace ou tokens
 * (erro real vai para o log server-side).
 */
import type { APIRoute } from "astro";
import {
  getRatingLikesSession,
  likeRating,
  RatingLikeNotAvailableError,
  SelfLikeError,
  unlikeRating,
} from "../../../lib/ratingLikes/service";
import {
  RatingLikeValidationError,
  validateRatingLikeTarget,
} from "../../../lib/ratingLikes/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para curtir avaliações.";
const LIKE_ERROR = "Não foi possível curtir esta avaliação.";
const UNLIKE_ERROR = "Não foi possível remover sua curtida.";

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingLikesSession(request, cookies);
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
    const target = validateRatingLikeTarget(body);
    const result = await likeRating(ctx, target);
    return Response.json(result);
  } catch (error) {
    if (error instanceof RatingLikeValidationError) {
      return Response.json({ error: "Avaliação inválida." }, { status: 400 });
    }
    if (error instanceof SelfLikeError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RatingLikeNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[RatingLikes] Falha ao curtir.");
    return Response.json({ error: LIKE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingLikesSession(request, cookies);
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
    const target = validateRatingLikeTarget(body);
    const result = await unlikeRating(ctx, target);
    return Response.json(result);
  } catch (error) {
    if (error instanceof RatingLikeValidationError) {
      return Response.json({ error: "Avaliação inválida." }, { status: 400 });
    }
    console.error("[RatingLikes] Falha ao descurtir.");
    return Response.json({ error: UNLIKE_ERROR }, { status: 500 });
  }
};
