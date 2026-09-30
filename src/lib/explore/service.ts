/**
 * Serviço do Explore (Etapa 11) — presets TMDB + filtros, sem IA/Supabase.
 *
 * Fluxo: browser → CineVee → TMDB (tmdbFetch reutilizado, sem N+1).
 * Uma página ≈ 20 títulos (1 request TMDB por tipo; mixed = 2 em paralelo).
 *
 * Regras por preset:
 * - em-alta: trending/week puro; com gênero/ano/streaming → discover
 *   popularity.desc (aproximação filtrável documentada — o Trending não
 *   aceita esses filtros; tipo-only continua no trending/{type}/week);
 * - nos-streamings: discover + flatrate BR + janela recente (MESMA regra
 *   da Home via streamingRecentWindow); streaming=all = 4 providers em OR;
 * - muito-bem-avaliados: discover vote_average.desc + vote_count mínimo
 *   (TOP_RATED_MIN_VOTES — 10/10 com 2 votos nunca entra);
 * - filmes/séries populares: discover popularity.desc, tipo fixo.
 *
 * UI consome ContentItem (normalizado); filtros inválidos nunca chegam
 * ao TMDB (parseExploreFilters já coerciona para defaults seguros).
 */
import type { ContentItem, StreamingProvider } from "../../types/content";
import { genreIdsFor, genreNamesFor } from "../discovery/genres";
import { tmdbFetch } from "../tmdb/client";
import { normalizeTmdbMovie, normalizeTmdbTv } from "../tmdb/normalize";
import {
  getStreamingProviderIds,
  TMDB_WATCH_REGION,
} from "../tmdb/providers";
import { streamingRecentWindow } from "../tmdb/streaming";
import { TOP_RATED_MIN_VOTES } from "../tmdb/topRated";
import type { TmdbListResponse, TmdbMovie, TmdbTv } from "../tmdb/types";
import type {
  ExploreFilters,
  ExplorePreset,
  ExploreResult,
} from "./types";
import { isGenreSupportedFor } from "./filters";

const IS_DEV: boolean =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false;

/** Títulos por página (alinha com a página TMDB de 20). */
export const EXPLORE_PAGE_SIZE = 20;

interface DiscoverOptions {
  page: number;
  sortBy: string;
  withGenres?: string;
  providers?: string;
  recentWindow?: boolean;
  minVotes?: number;
  minAverage?: number;
  year?: number | null;
}

function cleanTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUsableMovie(movie: TmdbMovie): boolean {
  return !!movie.poster_path && cleanTitle(movie.title).length > 0;
}

function isUsableTv(tv: TmdbTv): boolean {
  return !!tv.poster_path && cleanTitle(tv.name).length > 0;
}

/** Discover retorna genre_ids (não declarados no tipo mínimo). */
type DiscoverMovie = TmdbMovie & { genre_ids?: number[] };
type DiscoverTv = TmdbTv & { genre_ids?: number[] };

async function discoverFiltered(
  type: "movie" | "tv",
  filters: ExploreFilters,
  opts: DiscoverOptions,
): Promise<{ items: ContentItem[]; totalPages: number }> {
  const params: Record<string, string | number | boolean> = {
    language: "pt-BR",
    include_adult: false,
    sort_by: opts.sortBy,
    page: opts.page,
  };
  const genreIds = filters.genre === "all" ? [] : genreIdsFor([filters.genre], type);
  if (genreIds.length > 0) params.with_genres = [...new Set(genreIds)].join("|");
  if (filters.year !== null) {
    params[type === "movie" ? "primary_release_year" : "first_air_date_year"] = filters.year;
  }
  if (opts.providers) {
    params.watch_region = TMDB_WATCH_REGION;
    params.with_watch_monetization_types = "flatrate";
    params.with_watch_providers = opts.providers;
  }
  if (opts.recentWindow) {
    const window = streamingRecentWindow();
    if (type === "movie") {
      params["primary_release_date.gte"] = window.gte;
      params["primary_release_date.lte"] = window.lte;
    } else {
      params["first_air_date.gte"] = window.gte;
      params["first_air_date.lte"] = window.lte;
    }
  }
  if (opts.minVotes !== undefined) params["vote_count.gte"] = opts.minVotes;
  if (opts.minAverage !== undefined) params["vote_average.gte"] = opts.minAverage;

  if (type === "movie") {
    const data = await tmdbFetch<TmdbListResponse<DiscoverMovie>>("/discover/movie", { params });
    const tag = providerTag(filters.streaming);
    return {
      items: data.results.filter(isUsableMovie).map((movie) => ({
        ...normalizeTmdbMovie(movie),
        genres: genreNamesFor(movie.genre_ids ?? [], "movie"),
        ...(tag ? { provider: tag } : {}),
      })),
      totalPages: data.total_pages ?? opts.page,
    };
  }
  const data = await tmdbFetch<TmdbListResponse<DiscoverTv>>("/discover/tv", { params });
  const tag = providerTag(filters.streaming);
  return {
    items: data.results.filter(isUsableTv).map((tv) => ({
      ...normalizeTmdbTv(tv),
      genres: genreNamesFor(tv.genre_ids ?? [], "tv"),
      ...(tag ? { provider: tag } : {}),
    })),
    totalPages: data.total_pages ?? opts.page,
  };
}

function providerTag(streaming: ExploreFilters["streaming"]): StreamingProvider | undefined {
  return streaming === "all" ? undefined : streaming;
}

/** Remove duplicados por `mediaType:tmdbId` (mixed movie/tv). */
export function dedupeExploreItems(items: ContentItem[]): ContentItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function trendingPage(
  mediaType: "movie" | "tv",
  page: number,
): Promise<{ items: ContentItem[]; popularities: number[]; totalPages: number }> {
  const data = await tmdbFetch<TmdbListResponse<DiscoverMovie | DiscoverTv>>(
    `/trending/${mediaType}/week`,
    { params: { language: "pt-BR", page } },
  );
  const items: ContentItem[] = [];
  const popularities: number[] = [];
  for (const entry of data.results) {
    const item =
      mediaType === "movie"
        ? {
            ...normalizeTmdbMovie(entry as TmdbMovie),
            genres: genreNamesFor((entry as DiscoverMovie).genre_ids ?? [], "movie"),
          }
        : {
            ...normalizeTmdbTv(entry as TmdbTv),
            genres: genreNamesFor((entry as DiscoverTv).genre_ids ?? [], "tv"),
          };
    if (!item.posterUrl || item.title.length === 0) continue;
    items.push(item);
    popularities.push((entry as { popularity?: number }).popularity ?? 0);
  }
  return { items, popularities, totalPages: data.total_pages ?? page };
}

function hasAdvancedFilters(filters: ExploreFilters): boolean {
  return filters.genre !== "all" || filters.year !== null || filters.streaming !== "all";
}

async function streamingProvidersParam(
  streaming: ExploreFilters["streaming"],
): Promise<string> {
  const ids = await getStreamingProviderIds();
  if (streaming !== "all") return String(ids[streaming]);
  return [ids.netflix, ids.prime, ids.disney, ids.max].join("|");
}

/**
 * Uma página do preset com os filtros. Lança erro em falha TMDB (a página
 * renderiza estado de erro amigável; a API responde 502).
 */
export async function fetchExplorePage(
  preset: ExplorePreset,
  filters: ExploreFilters,
  page: number,
): Promise<ExploreResult> {
  const wantsMovie = filters.mediaType !== "tv";
  const wantsTv = filters.mediaType !== "movie";

  if (IS_DEV) {
    console.info(
      `[explore-debug] section=${preset.slug} mediaType=${filters.mediaType} ` +
        `genreKey=${filters.genre} movieGenreIds=[${genreIdsFor(filters.genre === "all" ? [] : [filters.genre], "movie")}] ` +
        `tvGenreIds=[${genreIdsFor(filters.genre === "all" ? [] : [filters.genre], "tv")}] ` +
        `year=${filters.year ?? "-"} streaming=${filters.streaming} page=${page}`,
    );
  }

  // Invariante: filtro ativo sem representação oficial NÃO gera consulta
  // genérica — retorna vazio explícito (a UI explica em vez de mascarar).
  if (!isGenreSupportedFor(filters.mediaType, filters.genre)) {
    if (IS_DEV) {
      console.info(
        `[explore-debug] unsupported combination: genre=${filters.genre} mediaType=${filters.mediaType} (sem with_genres oficial)`,
      );
    }
    return {
      items: [],
      page,
      totalPages: page,
      hasMore: false,
      appliedFilters: { ...filters },
      unsupportedCombination: true,
    };
  }

  let items: ContentItem[] = [];
  let totalPages = page;

  if (preset.source === "trending" && !hasAdvancedFilters(filters)) {
    // Trending puro (sem filtros que o endpoint não suporta): junta os
    // dois tipos ordenando por popularity (mesma semântica da Home).
    const parts = await Promise.all([
      wantsMovie ? trendingPage("movie", page) : Promise.resolve({ items: [], popularities: [], totalPages: page }),
      wantsTv ? trendingPage("tv", page) : Promise.resolve({ items: [], popularities: [], totalPages: page }),
    ]);
    const entries = [
      ...parts[0].items.map((item, i) => ({ item, popularity: parts[0].popularities[i] ?? 0 })),
      ...parts[1].items.map((item, i) => ({ item, popularity: parts[1].popularities[i] ?? 0 })),
    ];
    entries.sort((a, b) => b.popularity - a.popularity);
    items = dedupeExploreItems(entries.map((entry) => entry.item)).slice(0, EXPLORE_PAGE_SIZE);
    totalPages = Math.max(parts[0].totalPages, parts[1].totalPages);
  } else if (preset.source === "trending") {
    // Aproximação filtrável: discover por popularidade (documentado).
    const parts = await Promise.all([
      wantsMovie
        ? discoverFiltered("movie", filters, { page, sortBy: "popularity.desc" })
        : Promise.resolve({ items: [], totalPages: page }),
      wantsTv
        ? discoverFiltered("tv", filters, { page, sortBy: "popularity.desc" })
        : Promise.resolve({ items: [], totalPages: page }),
    ]);
    items = dedupeExploreItems(interleave(parts[0].items, parts[1].items)).slice(0, EXPLORE_PAGE_SIZE);
    totalPages = Math.max(parts[0].totalPages, parts[1].totalPages);
  } else if (preset.source === "streaming") {
    // MESMA regra da Home: flatrate BR + janela recente.
    const providers = await streamingProvidersParam(filters.streaming);
    const parts = await Promise.all([
      wantsMovie
        ? discoverFiltered("movie", filters, { page, sortBy: "popularity.desc", providers, recentWindow: true })
        : Promise.resolve({ items: [], totalPages: page }),
      wantsTv
        ? discoverFiltered("tv", filters, { page, sortBy: "popularity.desc", providers, recentWindow: true })
        : Promise.resolve({ items: [], totalPages: page }),
    ]);
    items = dedupeExploreItems(interleave(parts[0].items, parts[1].items)).slice(0, EXPLORE_PAGE_SIZE);
    totalPages = Math.max(parts[0].totalPages, parts[1].totalPages);
  } else if (preset.source === "top_rated") {
    const parts = await Promise.all([
      wantsMovie
        ? discoverFiltered("movie", filters, {
            page,
            sortBy: "vote_average.desc",
            minVotes: TOP_RATED_MIN_VOTES,
          })
        : Promise.resolve({ items: [], totalPages: page }),
      wantsTv
        ? discoverFiltered("tv", filters, {
            page,
            sortBy: "vote_average.desc",
            minVotes: TOP_RATED_MIN_VOTES,
          })
        : Promise.resolve({ items: [], totalPages: page }),
    ]);
    items = dedupeExploreItems(mergeByRating(parts[0].items, parts[1].items)).slice(0, EXPLORE_PAGE_SIZE);
    totalPages = Math.max(parts[0].totalPages, parts[1].totalPages);
  } else {
    // popular_movies / popular_series: tipo fixo, uma request.
    const type = preset.source === "popular_movies" ? "movie" : "tv";
    const providers =
      filters.streaming === "all" ? undefined : await streamingProvidersParam(filters.streaming);
    const part = await discoverFiltered(type, filters, {
      page,
      sortBy: "popularity.desc",
      ...(providers ? { providers } : {}),
    });
    items = dedupeExploreItems(part.items).slice(0, EXPLORE_PAGE_SIZE);
    totalPages = part.totalPages;
  }

  return {
    items,
    page,
    totalPages,
    hasMore: page < totalPages,
    appliedFilters: { ...filters },
    unsupportedCombination: false,
  };
}

/** Intercalação movie/tv (mesma linguagem da Home de streamings). */
function interleave(movies: ContentItem[], series: ContentItem[]): ContentItem[] {
  const out: ContentItem[] = [];
  const rounds = Math.max(movies.length, series.length);
  for (let i = 0; i < rounds; i++) {
    if (movies[i]) out.push(movies[i]);
    if (series[i]) out.push(series[i]);
  }
  return out;
}

/** Fusão por qualidade (nota desc; mínimo de votos já aplicado no fetch). */
function mergeByRating(movies: ContentItem[], series: ContentItem[]): ContentItem[] {
  return [...movies, ...series].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
}
