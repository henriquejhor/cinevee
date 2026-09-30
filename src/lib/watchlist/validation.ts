/**
 * Validação server-side do input da watchlist (nunca confiar no browser).
 * O body aceita SOMENTE { tmdbId, mediaType } — title/poster/year vindos
 * do browser são ignorados; o backend extrai do TMDB.
 */
import type { ContentType } from "../../types/content";
import type { WatchlistInput } from "./types";

export class WatchlistValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistValidationError";
  }
}

/** tmdbId: inteiro positivo seguro. Lança WatchlistValidationError → 400. */
export function validateWatchlistInput(body: unknown): WatchlistInput {
  if (typeof body !== "object" || body === null) {
    throw new WatchlistValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  const { tmdbId, mediaType } = payload;

  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId <= 0
  ) {
    throw new WatchlistValidationError("Título inválido.");
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new WatchlistValidationError("Título inválido.");
  }

  return { tmdbId, mediaType: mediaType as ContentType };
}
