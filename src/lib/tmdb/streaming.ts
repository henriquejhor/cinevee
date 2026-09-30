/**
 * "Novidades nos streamings" — conteúdo recente disponível em streaming no BR.
 *
 * Conceito (importante): o TMDB informa a disponibilidade ATUAL por provider,
 * mas não a data exata de entrada no catálogo. Esta seção representa
 * "recent content available on streaming": títulos relativamente novos
 * (janela dinâmica até hoje) + disponíveis no provider + ordenados por
 * popularidade. Nunca afirmar "acabou de chegar".
 *
 * Estratégia por filtro: 1 página de GET /discover/movie + 1 de /discover/tv,
 * com `with_watch_providers` (OR via pipe para "all"), `flatrate`,
 * `watch_region=BR` e janela de datas recente. Resultados intercalados
 * movie/tv, normalizados para `ContentItem`, limitados a 12.
 *
 * Home usa discover com filtros — NUNCA N chamadas a /watch/providers
 * por card. O endpoint individual é exclusivo da página de detalhes.
 */
import type { ContentItem, StreamingProvider } from "../../types/content";
import { tmdbFetch } from "./client";
import { normalizeTmdbMovie, normalizeTmdbTv } from "./normalize";
import {
  getStreamingProviderIds,
  TMDB_WATCH_REGION,
  type StreamingFilter,
} from "./providers";
import type { TmdbListResponse, TmdbMovie, TmdbTv } from "./types";

/** Janela de recentidade: últimos N meses até hoje (calculada no servidor). */
export const STREAMING_RECENT_MONTHS = 18;

/** Itens retornados por filtro. */
export const STREAMING_LIMIT = 12;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** [início, hoje] — ex.: últimos 18 meses. Sem hardcode do ano atual. */
function recentWindow(): { gte: string; lte: string } {
  const today = new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - STREAMING_RECENT_MONTHS);
  return { gte: toIsoDate(start), lte: toIsoDate(today) };
}

/**
 * Janela de recentidade compartilhada (mesma regra da Home) para a
 * página expandida /explorar/nos-streamings. Exportada para reuso —
 * sem duplicar a regra em outro módulo.
 */
export function streamingRecentWindow(): { gte: string; lte: string } {
  return recentWindow();
}

/**
 * Busca o conteúdo recente do filtro e retorna até `STREAMING_LIMIT`
 * itens intercalados (movie/tv). Lança erro em falha — o chamador decide:
 * a Home usa os mocks como fallback; /api/streaming responde 502.
 */
export async function getStreamingContent(
  filter: StreamingFilter,
): Promise<ContentItem[]> {
  const ids = await getStreamingProviderIds();
  const { gte, lte } = recentWindow();

  const withWatchProviders =
    filter === "all"
      ? [ids.netflix, ids.prime, ids.disney, ids.max].join("|")
      : String(ids[filter]);

  const [movies, series] = await Promise.all([
    tmdbFetch<TmdbListResponse<TmdbMovie>>("/discover/movie", {
      params: {
        language: "pt-BR",
        watch_region: TMDB_WATCH_REGION,
        with_watch_monetization_types: "flatrate",
        with_watch_providers: withWatchProviders,
        include_adult: false,
        sort_by: "popularity.desc",
        "primary_release_date.gte": gte,
        "primary_release_date.lte": lte,
        page: 1,
      },
    }),
    tmdbFetch<TmdbListResponse<TmdbTv>>("/discover/tv", {
      params: {
        language: "pt-BR",
        watch_region: TMDB_WATCH_REGION,
        with_watch_monetization_types: "flatrate",
        with_watch_providers: withWatchProviders,
        include_adult: false,
        sort_by: "popularity.desc",
        "first_air_date.gte": gte,
        "first_air_date.lte": lte,
        page: 1,
      },
    }),
  ]);

  const providerTag: StreamingProvider | undefined =
    filter === "all" ? undefined : filter;

  const movieItems = movies.results.map((movie) => ({
    ...normalizeTmdbMovie(movie),
    ...(providerTag ? { provider: providerTag } : {}),
  }));
  const tvItems = series.results.map((tv) => ({
    ...normalizeTmdbTv(tv),
    ...(providerTag ? { provider: providerTag } : {}),
  }));

  // Intercalação simples movie/tv (sem ranking complexo nesta etapa).
  const mixed: ContentItem[] = [];
  const rounds = Math.max(movieItems.length, tvItems.length);
  for (let i = 0; i < rounds && mixed.length < STREAMING_LIMIT; i++) {
    if (movieItems[i]) mixed.push(movieItems[i]);
    if (mixed.length >= STREAMING_LIMIT) break;
    if (tvItems[i]) mixed.push(tvItems[i]);
  }

  return mixed;
}
