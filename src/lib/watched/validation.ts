/**
 * Validação server-side do input de assistidos (nunca confiar no browser).
 * O body aceita SOMENTE { tmdbId, mediaType } — title/poster/year vindos
 * do browser são ignorados; o backend extrai do TMDB.
 */
import type { ContentType } from "../../types/content";
import type { WatchedInput } from "./types";

export class WatchedValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchedValidationError";
  }
}

/** tmdbId: inteiro positivo seguro. Lança WatchedValidationError → 400. */
export function validateWatchedInput(body: unknown): WatchedInput {
  if (typeof body !== "object" || body === null) {
    throw new WatchedValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  const { tmdbId, mediaType } = payload;

  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId <= 0
  ) {
    throw new WatchedValidationError("Título inválido.");
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new WatchedValidationError("Título inválido.");
  }

  return { tmdbId, mediaType: mediaType as ContentType };
}
