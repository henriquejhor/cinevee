/**
 * Normalização TMDB → ContentItem (tipo interno da UI).
 * A UI nunca consome a resposta bruta do TMDB.
 */
import type { ContentItem } from "../../types/content";
import { buildPosterUrl } from "./image";
import type { TmdbMovie, TmdbTv } from "./types";

function extractYear(date?: string): number | undefined {
  if (!date || date.length < 4) return undefined;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? undefined : year;
}

/** Hue determinístico para o placeholder (usado só quando não há pôster). */
function fallbackHue(id: number): number {
  return Math.abs(id) % 360;
}

function roundRating(voteAverage?: number): number | undefined {
  if (typeof voteAverage !== "number" || voteAverage <= 0) return undefined;
  return Math.round(voteAverage * 10) / 10;
}

export function normalizeTmdbMovie(movie: TmdbMovie): ContentItem {
  return {
    id: movie.id,
    type: "movie",
    title: movie.title,
    year: extractYear(movie.release_date),
    rating: roundRating(movie.vote_average),
    posterUrl: buildPosterUrl(movie.poster_path),
    hue: fallbackHue(movie.id),
  };
}

export function normalizeTmdbTv(tv: TmdbTv): ContentItem {
  return {
    id: tv.id,
    type: "tv",
    title: tv.name,
    year: extractYear(tv.first_air_date),
    rating: roundRating(tv.vote_average),
    posterUrl: buildPosterUrl(tv.poster_path),
    hue: fallbackHue(tv.id),
  };
}
