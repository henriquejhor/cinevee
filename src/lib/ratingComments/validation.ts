/**
 * Validação server-side de comentários em avaliações (nunca confiar no
 * browser). Texto puro, sem Markdown/HTML; trim nas bordas; 1..500.
 */
import { USERNAME_PATTERN } from "../profile/validation";
import type { ContentType } from "../../types/content";
import type { RatingCommentTarget } from "./types";
import {
  RATING_COMMENT_DEFAULT_LIMIT,
  RATING_COMMENT_MAX_LENGTH,
  RATING_COMMENT_MAX_LIMIT,
} from "./types";

export class RatingCommentValidationError extends Error {
  constructor(message = "Comentário inválido.") {
    super(message);
    this.name = "RatingCommentValidationError";
  }
}

/** { username, tmdbId, mediaType } — alvo da thread, sem UUID. */
export function validateRatingCommentTarget(body: unknown): RatingCommentTarget {
  if (typeof body !== "object" || body === null) {
    throw new RatingCommentValidationError("Dados inválidos.");
  }
  const { username, tmdbId, mediaType } = body as Record<string, unknown>;

  if (typeof username !== "string") {
    throw new RatingCommentValidationError("Avaliação inválida.");
  }
  const normalized = username.trim().toLowerCase().replace(/^@/, "");
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new RatingCommentValidationError("Avaliação inválida.");
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new RatingCommentValidationError("Avaliação inválida.");
  }
  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId < 1
  ) {
    throw new RatingCommentValidationError("Avaliação inválida.");
  }
  return { username: normalized, tmdbId, mediaType: mediaType as ContentType };
}

/** Texto do comentário: trim + 1..500 (whitespace-only rejeitado). */
export function validateCommentText(value: unknown): string {
  if (typeof value !== "string") {
    throw new RatingCommentValidationError("Comentário inválido.");
  }
  const text = value.trim();
  if (
    text.length < 1 ||
    text.length > RATING_COMMENT_MAX_LENGTH
  ) {
    throw new RatingCommentValidationError(
      text.length === 0
        ? "Escreva seu comentário antes de enviar."
        : `Seu comentário deve ter no máximo ${RATING_COMMENT_MAX_LENGTH} caracteres.`,
    );
  }
  return text;
}

/** commentId vindo do browser: inteiro positivo seguro. */
export function validateCommentId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RatingCommentValidationError("Comentário inválido.");
  }
  return value;
}

export interface ValidCommentsQuery extends RatingCommentTarget {
  page: number;
  limit: number;
}

/** Query do GET: alvo + page 1..1000 + limit 1..24 (default 5). */
export function validateCommentsQuery(params: {
  username: unknown;
  tmdbId: unknown;
  mediaType: unknown;
  page: unknown;
  limit: unknown;
}): ValidCommentsQuery {
  const target = validateRatingCommentTarget({
    username: params.username,
    tmdbId:
      typeof params.tmdbId === "string" ? Number(params.tmdbId) : params.tmdbId,
    mediaType: params.mediaType,
  });
  const page =
    typeof params.page === "string" && params.page !== ""
      ? Number(params.page)
      : 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new RatingCommentValidationError("Página inválida.");
  }
  const limit =
    typeof params.limit === "string" && params.limit !== ""
      ? Number(params.limit)
      : RATING_COMMENT_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > RATING_COMMENT_MAX_LIMIT
  ) {
    throw new RatingCommentValidationError("Limite inválido.");
  }
  return { ...target, page, limit };
}
