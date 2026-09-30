/**
 * Validação server-side de replies (nunca confiar no browser).
 *
 * Regras: commentId/replyId inteiros positivos; texto trim 1..500
 * (mesmo limite dos comentários); page/limit com clamp 1..24.
 */
import { REPLY_PAGE_MAX, REPLY_TEXT_MAX_LENGTH } from "./types";

export class ReplyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyValidationError";
  }
}

const INVALID_TARGET = "Comentário indisponível.";
const INVALID_TEXT = "Escreva uma resposta de até 500 caracteres.";

export function validateCommentId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ReplyValidationError(INVALID_TARGET);
  }
  return value;
}

export function validateReplyId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ReplyValidationError("Resposta indisponível.");
  }
  return value;
}

export function validateReplyText(value: unknown): string {
  if (typeof value !== "string") {
    throw new ReplyValidationError(INVALID_TEXT);
  }
  const text = value.trim();
  if (text.length < 1 || text.length > REPLY_TEXT_MAX_LENGTH) {
    throw new ReplyValidationError(INVALID_TEXT);
  }
  return text;
}

export function validateRepliesQuery(value: {
  commentId: unknown;
  page: unknown;
  limit: unknown;
}): { commentId: number; page: number; limit: number } {
  const commentId = validateCommentId(
    typeof value.commentId === "string" ? Number(value.commentId) : value.commentId,
  );
  const page = value.page === undefined || value.page === null ? 1 : Number(value.page);
  const limit = value.limit === undefined || value.limit === null ? 10 : Number(value.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new ReplyValidationError("Página inválida.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPLY_PAGE_MAX) {
    throw new ReplyValidationError("Página inválida.");
  }
  return { commentId, page, limit };
}
