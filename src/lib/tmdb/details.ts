/**
 * Detalhes de filme/série — busca e normalização.
 *
 * Endpoints:
 * - GET /movie/{id}?language=pt-BR
 * - GET /tv/{id}?language=pt-BR
 *
 * A página de detalhes consome apenas `ContentDetails` (tipo interno),
 * nunca a resposta bruta do TMDB.
 */
import type { ContentType } from "../../types/content";
import { tmdbFetch, TmdbNotFoundError } from "./client";
import { buildBackdropUrl, buildPosterUrl } from "./image";
import type { TmdbMovieDetails, TmdbTvDetails } from "./types";

export interface ContentDetails {
  id: number;
  type: ContentType;
  title: string;
  originalTitle?: string;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  year?: number;
  /** Duração em minutos (filme) ou por episódio (série). */
  runtime?: number;
  rating?: number;
  voteCount?: number;
  genres: string[];
  tagline?: string;
  status?: string;
  seasons?: number;
  episodes?: number;
}

/** Erro amigável quando o título não existe (404 do TMDB ou rota inválida). */
export class TitleNotFoundError extends Error {
  constructor() {
    super("Título não encontrado.");
    this.name = "TitleNotFoundError";
  }
}

function extractYear(date?: string): number | undefined {
  if (!date || date.length < 4) return undefined;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? undefined : year;
}

function cleanText(value?: string | null): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function cleanNumber(value?: number | null): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** 125 → "2h 5min" · 45 → "45min" · ausente → undefined. */
export function formatRuntime(minutes?: number): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}min`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}min`;
}

export function normalizeMovieDetails(movie: TmdbMovieDetails): ContentDetails {
  return {
    id: movie.id,
    type: "movie",
    title: movie.title,
    originalTitle:
      movie.original_title && movie.original_title !== movie.title
        ? movie.original_title
        : undefined,
    overview: cleanText(movie.overview),
    posterUrl: buildPosterUrl(movie.poster_path),
    backdropUrl: buildBackdropUrl(movie.backdrop_path),
    year: extractYear(movie.release_date),
    runtime: cleanNumber(movie.runtime),
    rating:
      typeof movie.vote_average === "number" && movie.vote_average > 0
        ? Math.round(movie.vote_average * 10) / 10
        : undefined,
    voteCount: cleanNumber(movie.vote_count),
    genres: (movie.genres ?? []).map((genre) => genre.name),
    tagline: cleanText(movie.tagline),
    status: cleanText(movie.status),
  };
}

export function normalizeTvDetails(tv: TmdbTvDetails): ContentDetails {
  return {
    id: tv.id,
    type: "tv",
    title: tv.name,
    originalTitle:
      tv.original_name && tv.original_name !== tv.name ? tv.original_name : undefined,
    overview: cleanText(tv.overview),
    posterUrl: buildPosterUrl(tv.poster_path),
    backdropUrl: buildBackdropUrl(tv.backdrop_path),
    year: extractYear(tv.first_air_date),
    runtime: cleanNumber(tv.episode_run_time?.[0]),
    rating:
      typeof tv.vote_average === "number" && tv.vote_average > 0
        ? Math.round(tv.vote_average * 10) / 10
        : undefined,
    voteCount: cleanNumber(tv.vote_count),
    genres: (tv.genres ?? []).map((genre) => genre.name),
    tagline: cleanText(tv.tagline),
    status: cleanText(tv.status),
    seasons: cleanNumber(tv.number_of_seasons),
    episodes: cleanNumber(tv.number_of_episodes),
  };
}

function parseId(rawId: string): number {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== rawId) {
    throw new TitleNotFoundError();
  }
  return id;
}

/**
 * Busca e normaliza os detalhes. Lança `TitleNotFoundError` para ID
 * inválido/inexistente e `Error` genérico para outras falhas.
 */
export async function getContentDetails(
  type: string,
  rawId: string,
): Promise<ContentDetails> {
  if (type !== "movie" && type !== "tv") {
    throw new TitleNotFoundError();
  }
  const id = parseId(rawId);

  try {
    if (type === "movie") {
      const movie = await tmdbFetch<TmdbMovieDetails>(`/movie/${id}`, {
        params: { language: "pt-BR" },
      });
      return normalizeMovieDetails(movie);
    }
    const tv = await tmdbFetch<TmdbTvDetails>(`/tv/${id}`, {
      params: { language: "pt-BR" },
    });
    return normalizeTvDetails(tv);
  } catch (error) {
    if (error instanceof TmdbNotFoundError) {
      throw new TitleNotFoundError();
    }
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha ao buscar detalhes ${type}/${id} (${message}).`);
    throw new Error("Não foi possível carregar este título agora.");
  }
}
