/**
 * "Em alta" — filmes + séries em tendência na semana.
 *
 * Endpoints:
 * - GET /trending/movie/week?language=pt-BR
 * - GET /trending/tv/week?language=pt-BR
 *
 * Não usa /trending/all/week (também retorna pessoas).
 * Combina os dois resultados, ordena por popularity desc e limita a 12.
 */
import type { ContentItem } from "../../types/content";
import { trendingNow } from "../../data/mockContent";
import { tmdbFetch } from "./client";
import { normalizeTmdbMovie, normalizeTmdbTv } from "./normalize";
import type { TmdbListResponse, TmdbMovie, TmdbTv } from "./types";

const TRENDING_LIMIT = 12;

interface TrendingEntry {
  item: ContentItem;
  popularity: number;
}

export interface TrendingResult {
  items: ContentItem[];
  /** `true` quando caiu para os mocks (falha ou token ausente). */
  usedFallback: boolean;
}

export async function getTrendingWeek(): Promise<TrendingResult> {
  try {
    const [movies, series] = await Promise.all([
      tmdbFetch<TmdbListResponse<TmdbMovie>>("/trending/movie/week", {
        params: { language: "pt-BR" },
      }),
      tmdbFetch<TmdbListResponse<TmdbTv>>("/trending/tv/week", {
        params: { language: "pt-BR" },
      }),
    ]);

    const entries: TrendingEntry[] = [
      ...movies.results.map((movie) => ({
        item: normalizeTmdbMovie(movie),
        popularity: movie.popularity ?? 0,
      })),
      ...series.results.map((tv) => ({
        item: normalizeTmdbTv(tv),
        popularity: tv.popularity ?? 0,
      })),
    ];

    entries.sort((a, b) => b.popularity - a.popularity);

    const items = entries.slice(0, TRENDING_LIMIT).map((entry) => entry.item);

    if (items.length === 0) {
      console.error("[TMDB] trending/week retornou 0 itens — usando fallback mockado.");
      return { items: trendingNow, usedFallback: true };
    }

    return { items, usedFallback: false };
  } catch (error) {
    // Mensagem limpa, server-side. Sem stack trace para o usuário.
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha ao buscar trending/week (${message}) — usando fallback mockado.`);
    return { items: trendingNow, usedFallback: true };
  }
}
