/**
 * "Muito bem avaliados" — mistura de filmes + séries com nota alta
 * e quantidade mínima relevante de votos.
 *
 * Endpoints:
 * - GET /movie/top_rated?language=pt-BR&page=1
 * - GET /tv/top_rated?language=pt-BR&page=1
 *
 * Regra anti-nota-inflada:
 * - vote_count >= MIN_VOTES (1000) — elimina títulos com média alta
 *   sustentada por poucas avaliações;
 * - ordena por vote_average desc (desempate: vote_count desc);
 * - limita a 12 itens.
 *
 * Em caso de falha, usa os mocks da seção (fallback interno).
 */
import type { ContentItem } from "../../types/content";
import { topRated } from "../../data/mockContent";
import { tmdbFetch } from "./client";
import { normalizeTmdbMovie, normalizeTmdbTv } from "./normalize";
import type { TmdbListResponse, TmdbMovie, TmdbTv } from "./types";

/** Votos mínimos para que a média seja considerada confiável. */
export const TOP_RATED_MIN_VOTES = 1000;

const TOP_RATED_LIMIT = 12;

interface RatedEntry {
  item: ContentItem;
  voteAverage: number;
  voteCount: number;
}

export interface TopRatedResult {
  items: ContentItem[];
  /** `true` quando caiu para os mocks (falha ou token ausente). */
  usedFallback: boolean;
}

export async function getTopRatedContent(): Promise<TopRatedResult> {
  try {
    const [movies, series] = await Promise.all([
      tmdbFetch<TmdbListResponse<TmdbMovie>>("/movie/top_rated", {
        params: { language: "pt-BR", page: 1 },
      }),
      tmdbFetch<TmdbListResponse<TmdbTv>>("/tv/top_rated", {
        params: { language: "pt-BR", page: 1 },
      }),
    ]);

    const entries: RatedEntry[] = [
      ...movies.results
        .filter((movie) => (movie.vote_count ?? 0) >= TOP_RATED_MIN_VOTES)
        .map((movie) => ({
          item: normalizeTmdbMovie(movie),
          voteAverage: movie.vote_average ?? 0,
          voteCount: movie.vote_count ?? 0,
        })),
      ...series.results
        .filter((tv) => (tv.vote_count ?? 0) >= TOP_RATED_MIN_VOTES)
        .map((tv) => ({
          item: normalizeTmdbTv(tv),
          voteAverage: tv.vote_average ?? 0,
          voteCount: tv.vote_count ?? 0,
        })),
    ];

    entries.sort(
      (a, b) => b.voteAverage - a.voteAverage || b.voteCount - a.voteCount,
    );

    const items = entries.slice(0, TOP_RATED_LIMIT).map((entry) => entry.item);

    if (items.length === 0) {
      console.error(
        "[TMDB] movie+tv/top_rated retornou 0 itens após filtro de votos — usando fallback mockado.",
      );
      return { items: topRated, usedFallback: true };
    }

    return { items, usedFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha ao buscar movie+tv/top_rated (${message}) — usando fallback mockado.`);
    return { items: topRated, usedFallback: true };
  }
}
