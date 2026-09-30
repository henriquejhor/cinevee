/**
 * Snapshot factual de título via TMDB (server-side only).
 *
 * Helper compartilhado (Etapa 6) extraído da lógica validada da watchlist:
 * confirma a existência do título no TMDB e deriva title/poster_path/year.
 * O browser nunca fornece esses campos — title/poster/year no banco são
 * apenas snapshots para renderização eficiente.
 */
import type { ContentType } from "../../types/content";
import { tmdbFetch, TmdbNotFoundError } from "./client";
import type { TmdbMovieDetails, TmdbTvDetails } from "./types";

/** Erro amigável quando o título não existe no TMDB (→ 404). */
export class TitleNotFoundError extends Error {
  constructor() {
    super("Título não encontrado.");
    this.name = "TitleNotFoundError";
  }
}

export interface TitleSnapshotInput {
  tmdbId: number;
  mediaType: ContentType;
}

export interface TitleSnapshot {
  title: string;
  posterPath: string | null;
  year?: number;
}

function extractYear(date?: string): number | undefined {
  if (!date || date.length < 4) return undefined;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? undefined : year;
}

/**
 * Confirma o título no TMDB server-side e extrai o snapshot factual.
 * Lança TitleNotFoundError (→ 404 amigável) se não existir.
 */
export async function fetchTitleSnapshot(
  input: TitleSnapshotInput,
): Promise<TitleSnapshot> {
  try {
    if (input.mediaType === "movie") {
      const movie = await tmdbFetch<TmdbMovieDetails>(`/movie/${input.tmdbId}`, {
        params: { language: "pt-BR" },
      });
      const title = movie.title?.trim();
      if (!title) throw new TitleNotFoundError();
      return {
        title,
        posterPath: movie.poster_path,
        ...(extractYear(movie.release_date) !== undefined
          ? { year: extractYear(movie.release_date) as number }
          : {}),
      };
    }
    const tv = await tmdbFetch<TmdbTvDetails>(`/tv/${input.tmdbId}`, {
      params: { language: "pt-BR" },
    });
    const title = tv.name?.trim();
    if (!title) throw new TitleNotFoundError();
    return {
      title,
      posterPath: tv.poster_path,
      ...(extractYear(tv.first_air_date) !== undefined
        ? { year: extractYear(tv.first_air_date) as number }
        : {}),
    };
  } catch (error) {
    if (error instanceof TitleNotFoundError || error instanceof TmdbNotFoundError) {
      throw new TitleNotFoundError();
    }
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Snapshot indisponível (${message}).`);
    throw new Error("Não foi possível verificar este título agora.");
  }
}
