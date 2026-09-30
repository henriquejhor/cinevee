/**
 * /api/ratings/comments/replies — respostas em comentários (Etapa 22).
 *
 * GET (anon ok) ?commentId=[&page=][&limit=] — replies cronológicas
 *   (default limit 10, max 24; principal + sonda hasMore).
 *   200 { items, page, pageSize, hasMore } · 404 thread indisponível ·
 *   400 input inválido · 502 falha interna.
 * POST (auth) { commentId, text } — cria + notification ao parent author.
 *   200 { reply, replyCount } · 401 deslogado · 400 texto/alvo inválido ·
 *   404 alvo indisponível · 409 self-reply · 403 desativado.
 * PATCH (auth) { replyId, text } — edita a própria (sem nova notification).
 *   200 reply atualizada · 404 "Resposta indisponível.".
 * DELETE (auth) { replyId } — autor ou dono da rating (modera).
 *   200 { removed: true, replyCount } · 404 "Resposta indisponível.".
 *
 * O browser nunca envia author_id (servidor usa auth.uid()) e nunca
 * recebe UUID. Erros nunca vazam SQL (erro real vai para o log).
 * Replies nunca têm filhas (sem nesting).
 */
import type { APIRoute } from "astro";
import {
  createCommentReply,
  deleteCommentReply,
  getCommentRepliesPage,
  getReplySession,
  getReplyViewer,
  RepliesDisabledError,
  ReplyMissingError,
  ReplyNotAvailableError,
  SelfReplyError,
  updateCommentReply,
} from "../../../../lib/commentReplies/service";
import {
  ReplyValidationError,
  validateRepliesQuery,
  validateReplyId,
  validateReplyText,
} from "../../../../lib/commentReplies/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para responder comentários.";
const LIST_ERROR = "Não foi possível carregar as respostas agora.";
const CREATE_ERROR = "Não foi possível publicar sua resposta.";
const UPDATE_ERROR = "Não foi possível salvar sua resposta.";
const DELETE_ERROR = "Não foi possível remover esta resposta.";

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const params = url.searchParams;
  let query;
  try {
    query = validateRepliesQuery({
      commentId: params.get("commentId"),
      page: params.get("page"),
      limit: params.get("limit"),
    });
  } catch (error) {
    if (error instanceof ReplyValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  const viewer = await getReplyViewer(request, cookies);
  try {
    const page = await getCommentRepliesPage(
      viewer.supabase,
      query.commentId,
      query.page,
      query.limit,
    );
    return Response.json(page);
  } catch {
    console.error("[Replies] Falha ao listar.");
    return Response.json({ error: LIST_ERROR }, { status: 502 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getReplySession(request, cookies);
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
    const record = body as Record<string, unknown>;
    const result = await createCommentReply(ctx, {
      commentId: record.commentId,
      text: record.text,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ReplyValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SelfReplyError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RepliesDisabledError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ReplyNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Replies] Falha ao criar.");
    return Response.json({ error: CREATE_ERROR }, { status: 500 });
  }
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const ctx = await getReplySession(request, cookies);
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
    const record = body as Record<string, unknown>;
    const reply = await updateCommentReply(ctx, {
      replyId: validateReplyId(record.replyId),
      text: validateReplyText(record.text),
    });
    return Response.json(reply);
  } catch (error) {
    if (error instanceof ReplyValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ReplyMissingError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Replies] Falha ao editar.");
    return Response.json({ error: UPDATE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getReplySession(request, cookies);
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
    const record = body as Record<string, unknown>;
    const result = await deleteCommentReply(ctx, record.replyId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ReplyValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ReplyMissingError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Replies] Falha ao remover.");
    return Response.json({ error: DELETE_ERROR }, { status: 500 });
  }
};
