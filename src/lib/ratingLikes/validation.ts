/**
 * Validação server-side do alvo de like (nunca confiar no browser).
 * O body aceita SOMENTE { username, tmdbId, mediaType } — nenhum UUID,
 * nenhum id interno. Username segue a mesma regra do produto; mediaType
 * é movie|tv; tmdbId é inteiro positivo.
 */
import { USERNAME_PATTERN } from "../profile/validation";
import type { ContentType } from "../../types/content";
import type { RatingLikeTarget } from "./types";

export class RatingLikeValidationError extends Error {
  constructor(message = "Avaliação inválida.") {
    super(message);
    this.name = "RatingLikeValidationError";
  }
}

/** { username, tmdbId, mediaType } — usada no POST e no DELETE. */
export function validateRatingLikeTarget(body: unknown): RatingLikeTarget {
  if (typeof body !== "object" || body === null) {
    throw new RatingLikeValidationError("Dados inválidos.");
  }
  const { username, tmdbId, mediaType } = body as Record<string, unknown>;

  if (typeof username !== "string") {
    throw new RatingLikeValidationError("Avaliação inválida.");
  }
  const normalized = username.trim().toLowerCase().replace(/^@/, "");
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new RatingLikeValidationError("Avaliação inválida.");
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new RatingLikeValidationError("Avaliação inválida.");
  }
  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId < 1
  ) {
    throw new RatingLikeValidationError("Avaliação inválida.");
  }
  return { username: normalized, tmdbId, mediaType: mediaType as ContentType };
}
