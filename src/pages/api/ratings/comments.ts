/**
 * /api/ratings/comments — comentários em avaliações públicas (Etapa 19).
 *
 * GET (anon ok) ?username=&tmdbId=&mediaType=[&page=][&limit=] — thread
 *   paginada (default limit 5, max 24; principal + sonda hasMore).
 *   200 { items, page, pageSize, hasMore, commentCount, commentsEnabled,
 *   isOwner, canComment } · 404 "Esta avaliação não está disponível." ·
 *   400 input inválido · 502 falha interna.
 * POST (auth) { username, tmdbId, mediaType, text } — cria.
 *   200 { comment, commentCount } · 401 deslogado · 400 texto/alvo
 *   inválido · 404 alvo indisponível · 409 self · 403 desativado.
 * PATCH (auth) { commentId, text } — edita o próprio.
 *   200 comentário atualizado · 404 "Comentário indisponível.".
 * DELETE (auth) { commentId } — autor ou dono da rating.
 *   200 { removed: true, commentCount } · 404 "Comentário indisponível.".
 *
 * O browser nunca envia author_id/owner_id (servidor usa auth.uid()) e
 * nunca recebe UUID. Erros nunca vazam SQL, stack trace ou tokens
 * (erro real vai para o log server-side).
 */
import type { APIRoute } from "astro";
import {
  CommentNotAvailableError,
  createRatingComment,
  deleteRatingComment,
  getRatingCommentsSession,
  getRatingCommentsViewer,
  listRatingComments,
  RatingCommentNotAvailableError,
  RatingCommentsDisabledError,
  SelfCommentError,
  updateRatingComment,
} from "../../../lib/ratingComments/service";
import {
  RatingCommentValidationError,
  validateCommentId,
  validateCommentsQuery,
  validateCommentText,
  validateRatingCommentTarget,
} from "../../../lib/ratingComments/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para comentar avaliações.";
const LIST_ERROR = "Não foi possível carregar os comentários agora.";
const CREATE_ERROR = "Não foi possível publicar seu comentário.";
const UPDATE_ERROR = "Não foi possível salvar seu comentário.";
const DELETE_ERROR = "Não foi possível remover este comentário.";

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const params = url.searchParams;
  let query;
  try {
    query = validateCommentsQuery({
      username: params.get("username"),
      tmdbId: params.get("tmdbId"),
      mediaType: params.get("mediaType"),
      page: params.get("page"),
      limit: params.get("limit"),
    });
  } catch (error) {
    if (error instanceof RatingCommentValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  const viewer = await getRatingCommentsViewer(request, cookies);
  try {
    const page = await listRatingComments(
      viewer,
      { username: query.username, tmdbId: query.tmdbId, mediaType: query.mediaType },
      query.page,
      query.limit,
    );
    return Response.json(page);
  } catch (error) {
    if (error instanceof RatingCommentNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[RatingComments] Falha ao listar.");
    return Response.json({ error: LIST_ERROR }, { status: 502 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingCommentsSession(request, cookies);
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
    const target = validateRatingCommentTarget(body);
    const text = validateCommentText(
      (body as Record<string, unknown>).text,
    );
    const result = await createRatingComment(ctx, target, text);
    return Response.json(result);
  } catch (error) {
    if (error instanceof RatingCommentValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SelfCommentError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RatingCommentsDisabledError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RatingCommentNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[RatingComments] Falha ao criar.");
    return Response.json({ error: CREATE_ERROR }, { status: 500 });
  }
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingCommentsSession(request, cookies);
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
    if (typeof body !== "object" || body === null) {
      throw new RatingCommentValidationError("Dados inválidos.");
    }
    const record = body as Record<string, unknown>;
    const commentId = validateCommentId(record.commentId);
    const text = validateCommentText(record.text);
    const comment = await updateRatingComment(ctx, commentId, text);
    return Response.json(comment);
  } catch (error) {
    if (error instanceof RatingCommentValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CommentNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[RatingComments] Falha ao editar.");
    return Response.json({ error: UPDATE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getRatingCommentsSession(request, cookies);
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
    if (typeof body !== "object" || body === null) {
      throw new RatingCommentValidationError("Dados inválidos.");
    }
    const commentId = validateCommentId(
      (body as Record<string, unknown>).commentId,
    );
    const result = await deleteRatingComment(ctx, commentId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof RatingCommentValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CommentNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[RatingComments] Falha ao apagar.");
    return Response.json({ error: DELETE_ERROR }, { status: 500 });
  }
};
