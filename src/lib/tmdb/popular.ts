/**
 * Filmes e séries populares da Home.
 *
 * Endpoints:
 * - GET /movie/popular?language=pt-BR&page=1
 * - GET /tv/popular?language=pt-BR&page=1
 *
 * Uma requisição por seção, limitada a 12 itens.
 * Em caso de falha, usa os mocks da seção (fallback interno).
 */
import type { ContentItem } from "../../types/content";
import { popularMovies, popularSeries } from "../../data/mockContent";
import { tmdbFetch } from "./client";
import { normalizeTmdbMovie, normalizeTmdbTv } from "./normalize";
import type { TmdbListResponse, TmdbMovie, TmdbTv } from "./types";

const POPULAR_LIMIT = 12;

export interface PopularResult {
  items: ContentItem[];
  /** `true` quando caiu para os mocks (falha ou token ausente). */
  usedFallback: boolean;
}

export async function getPopularMovies(): Promise<PopularResult> {
  try {
    const data = await tmdbFetch<TmdbListResponse<TmdbMovie>>("/movie/popular", {
      params: { language: "pt-BR", page: 1 },
    });

    const items = data.results
      .slice(0, POPULAR_LIMIT)
      .map((movie) => normalizeTmdbMovie(movie));

    if (items.length === 0) {
      console.error("[TMDB] movie/popular retornou 0 itens — usando fallback mockado.");
      return { items: popularMovies, usedFallback: true };
    }

    return { items, usedFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha ao buscar movie/popular (${message}) — usando fallback mockado.`);
    return { items: popularMovies, usedFallback: true };
  }
}

export async function getPopularTv(): Promise<PopularResult> {
  try {
    const data = await tmdbFetch<TmdbListResponse<TmdbTv>>("/tv/popular", {
      params: { language: "pt-BR", page: 1 },
    });

    const items = data.results
      .slice(0, POPULAR_LIMIT)
      .map((tv) => normalizeTmdbTv(tv));

    if (items.length === 0) {
      console.error("[TMDB] tv/popular retornou 0 itens — usando fallback mockado.");
      return { items: popularSeries, usedFallback: true };
    }

    return { items, usedFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha ao buscar tv/popular (${message}) — usando fallback mockado.`);
    return { items: popularSeries, usedFallback: true };
  }
}
