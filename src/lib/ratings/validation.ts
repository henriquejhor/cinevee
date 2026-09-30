/**
 * Validação server-side do input de avaliações (nunca confiar no browser).
 * POST aceita { tmdbId, mediaType, rating } + `reviewText` opcional —
 * inteiros 1–5, texto puro até 2000 chars (trim, "" → NULL).
 * PATCH aceita { tmdbId, mediaType, reviewText } (só a opinião).
 * Sem meia estrela: 2.5, strings, NaN, 0 e 6 são rejeitados.
 */
import type { ContentType } from "../../types/content";
import type { RatingInput, RatingKey, ReviewUpdateInput } from "./types";

export class RatingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatingValidationError";
  }
}

const RATING_ERROR = "Avaliação inválida. Escolha de 1 a 5 estrelas.";
export const REVIEW_MAX_LENGTH = 2000;
const REVIEW_ERROR = "Sua opinião deve ter no máximo 2000 caracteres.";

function validateKey(body: Record<string, unknown>): Omit<RatingKey, never> {
  const { tmdbId, mediaType } = body;

  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId <= 0
  ) {
    throw new RatingValidationError("Título inválido.");
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new RatingValidationError("Título inválido.");
  }

  return { tmdbId, mediaType: mediaType as ContentType };
}

/** Chave { tmdbId, mediaType } — usada no DELETE. */
export function validateRatingKey(body: unknown): RatingKey {
  if (typeof body !== "object" || body === null) {
    throw new RatingValidationError("Dados inválidos.");
  }
  return validateKey(body as Record<string, unknown>);
}

/** { tmdbId, mediaType, rating } — usada no POST (criar ou alterar). */
export function validateRatingInput(body: unknown): RatingInput {
  if (typeof body !== "object" || body === null) {
    throw new RatingValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  const key = validateKey(payload);
  const { rating } = payload;

  if (
    typeof rating !== "number" ||
    !Number.isSafeInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) {
    throw new RatingValidationError(RATING_ERROR);
  }

  // reviewText opcional: ausente → preserva; null/"" → limpa; string → texto.
  if (!("reviewText" in payload) || payload.reviewText === undefined) {
    return { ...key, rating };
  }
  return { ...key, rating, reviewText: normalizeReviewText(payload.reviewText) };
}

/**
 * Normaliza a opinião: trim nas bordas, "" → NULL, teto de 2000 chars.
 * Texto puro — sem HTML/Markdown (a UI escapa e usa white-space: pre-wrap).
 * Nunca trunca silenciosamente: >2000 lança erro (→ 400 / CHECK segura).
 */
export function normalizeReviewText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RatingValidationError(REVIEW_ERROR);
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > REVIEW_MAX_LENGTH) {
    throw new RatingValidationError(REVIEW_ERROR);
  }
  return trimmed;
}

/** { tmdbId, mediaType, reviewText } — usada no PATCH (só a opinião). */
export function validateReviewUpdateInput(body: unknown): ReviewUpdateInput {
  if (typeof body !== "object" || body === null) {
    throw new RatingValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  const key = validateKey(payload);
  if (!("reviewText" in payload) || payload.reviewText === undefined) {
    throw new RatingValidationError(REVIEW_ERROR);
  }
  return { ...key, reviewText: normalizeReviewText(payload.reviewText) };
}
