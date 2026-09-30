/**
 * Busca de filmes e séries — GET /search/multi.
 *
 * Server-side only (via `tmdbFetch`): o token nunca chega ao navegador.
 * O endpoint multi também retorna pessoas — aceitamos SOMENTE
 * `movie` e `tv`, descartando `person`.
 */
import type { ContentItem } from "../../types/content";
import { tmdbFetch } from "./client";
import { normalizeTmdbMovie, normalizeTmdbTv } from "./normalize";
import type { TmdbListResponse, TmdbSearchMultiResult } from "./types";

/** Máximo de resultados úteis por busca (uma única página do TMDB). */
export const SEARCH_LIMIT = 20;

function hasTitle(value?: string): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Busca filmes e séries no TMDB e normaliza para `ContentItem`.
 * Retorna no máximo `SEARCH_LIMIT` itens (movie + tv, sem pessoas).
 */
export async function searchTmdb(query: string): Promise<ContentItem[]> {
  const data = await tmdbFetch<TmdbListResponse<TmdbSearchMultiResult>>(
    "/search/multi",
    {
      params: {
        query,
        language: "pt-BR",
        include_adult: false,
        page: 1,
      },
    },
  );

  const items: ContentItem[] = [];

  for (const result of data.results) {
    if (result.media_type === "movie") {
      if (!hasTitle(result.title)) continue;
      items.push(
        normalizeTmdbMovie({
          id: result.id,
          title: result.title,
          release_date: result.release_date,
          vote_average: result.vote_average,
          poster_path: result.poster_path,
        }),
      );
    } else if (result.media_type === "tv") {
      if (!hasTitle(result.name)) continue;
      items.push(
        normalizeTmdbTv({
          id: result.id,
          name: result.name,
          first_air_date: result.first_air_date,
          vote_average: result.vote_average,
          poster_path: result.poster_path,
        }),
      );
    }
    // `person` e outros tipos são descartados.

    if (items.length >= SEARCH_LIMIT) break;
  }

  return items;
}
