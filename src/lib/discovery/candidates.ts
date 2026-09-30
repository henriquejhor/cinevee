/**
 * Candidate builder — DiscoveryAnswers → pool de candidatos reais (TMDB).
 *
 * - Filmes e/ou séries conforme contentType (any = metade/metade).
 * - preferredGenres viram `with_genres` (OR via pipe, sem super-restringir).
 * - Exclusões efetivas (profile + sessão, via opts.effectiveExcludedGenres)
 *   viram `without_genres` por tipo (HARD CONSTRAINT) + validação pós-fetch.
 * - Providers específicos reutilizam a resolução de IDs existente
 *   (flatrate BR); ["any"] não filtra.
 * - Runtime só para filmes (quick ≤100, balanced 90–140); séries sem
 *   filtro de runtime (endpoint pouco confiável para isso).
 * - Filtro de qualidade leve (poster, título, overview, votos) permitindo
 *   hidden gems + deduplicação básica por título/ano.
 *
 * No máximo 2 páginas por tipo. Nunca N chamadas por card.
 */
import type { ContentItem, ContentType } from "../../types/content";
import { tmdbFetch } from "../tmdb/client";
import { buildBackdropUrl } from "../tmdb/image";
import { normalizeTmdbMovie, normalizeTmdbTv } from "../tmdb/normalize";
import {
  getStreamingProviderIds,
  TMDB_WATCH_REGION,
} from "../tmdb/providers";
import type { TmdbListResponse, TmdbMovie, TmdbTv } from "../tmdb/types";
import type { DiscoveryAnswers, GenreKey } from "../../types/discovery";
import type { RecommendationRefinement } from "../../types/discovery";
import { genreIdsFor, genreNamesFor } from "./genres";
import { watchedKey } from "../personalization/taste";

/** Candidatos enviados ao ranking (máximo ~30). */
export const CANDIDATE_POOL_SIZE = 30;
/** Por tipo quando contentType é único. */
const CANDIDATES_PER_TYPE = 30;
/** Por tipo quando any (intercalados). */
const CANDIDATES_PER_TYPE_MIXED = 20;
/** Votos mínimos para entrar no pool (moderado: permite hidden gems). */
const MIN_VOTE_COUNT = 10;
/** Abaixo disso, completa com já-vistos em vez de entregar menos de 4. */
const MIN_FRESH_RESULTS = 4;

export interface CandidatePoolOptions {
  /** IDs compostos ("movie:123") a excluir do pool — hard constraint. */
  excludeIds?: string[];
  /** Refinamento rápido (UM ativo por vez); null = sem refinamento. */
  refinement?: RecommendationRefinement | null;
  /**
   * Exclusões efetivas (profile + sessão, já com merge/dedupe).
   * Ausente → usa answers.sessionExcludedGenres (compatibilidade).
   */
  effectiveExcludedGenres?: GenreKey[];
  /**
   * Títulos assistidos (`mediaType:tmdbId`, Supabase) — hard exclusion
   * ABSOLUTA aplicada por último, sem relaxamento: nunca reapresentados,
   * nunca enviados ao AI. Ausente/vazio → sem filtro.
   */
  watchedExcludeIds?: string[];
}

/** Pool montado + quantos assistidos foram removidos (metadata dev). */
export interface CandidatePoolResult {
  candidates: RecommendationCandidate[];
  watchedExcludedCount: number;
}

export interface RecommendationCandidate {
  id: number;
  type: ContentType;
  title: string;
  overview: string;
  year?: number;
  /** Nomes de gêneros pt-BR (para ranking e UI). */
  genres: string[];
  /** IDs TMDB de gênero (validação pós-fetch de exclusões). */
  genreIds: number[];
  rating?: number;
  voteCount?: number;
  popularity?: number;
  posterUrl?: string;
  backdropUrl?: string;
}

interface DiscoverParams {
  language: string;
  watch_region?: string;
  with_watch_monetization_types?: string;
  with_watch_providers?: string;
  with_genres?: string;
  without_genres?: string;
  "with_runtime.gte"?: number;
  "with_runtime.lte"?: number;
  "primary_release_date.gte"?: string;
  "first_air_date.gte"?: string;
  "vote_count.gte"?: number;
  "vote_average.gte"?: number;
  include_adult: boolean;
  sort_by: string;
  page: number;
}

function baseParams(): Pick<
  DiscoverParams,
  "language" | "include_adult" | "sort_by"
> {
  return { language: "pt-BR", include_adult: false, sort_by: "popularity.desc" };
}

function hueFor(id: number): number {
  return Math.abs(id) % 360;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUsableMovie(movie: TmdbMovie): boolean {
  return (
    !!movie.poster_path &&
    cleanText(movie.title).length > 0 &&
    cleanText((movie as { overview?: unknown }).overview).length > 0 &&
    (movie.vote_average ?? 0) > 0 &&
    (movie.vote_count ?? 0) >= MIN_VOTE_COUNT
  );
}

function isUsableTv(tv: TmdbTv): boolean {
  return (
    !!tv.poster_path &&
    cleanText(tv.name).length > 0 &&
    cleanText((tv as { overview?: unknown }).overview).length > 0 &&
    (tv.vote_average ?? 0) > 0 &&
    (tv.vote_count ?? 0) >= MIN_VOTE_COUNT
  );
}

function normalizeMovieCandidate(movie: TmdbMovie): RecommendationCandidate {
  const item: ContentItem = normalizeTmdbMovie(movie);
  const raw = movie as TmdbMovie & { overview?: string; genre_ids?: number[] };
  return {
    id: movie.id,
    type: "movie",
    title: item.title,
    overview: cleanText(raw.overview),
    year: item.year,
    genres: genreNamesFor(raw.genre_ids ?? [], "movie"),
    genreIds: [...(raw.genre_ids ?? [])],
    rating: item.rating,
    voteCount: movie.vote_count,
    popularity: movie.popularity,
    posterUrl: item.posterUrl,
    backdropUrl: buildBackdropUrl(
      (movie as TmdbMovie & { backdrop_path?: string | null }).backdrop_path,
    ),
  };
}

function normalizeTvCandidate(tv: TmdbTv): RecommendationCandidate {
  const item: ContentItem = normalizeTmdbTv(tv);
  const raw = tv as TmdbTv & { overview?: string; genre_ids?: number[] };
  return {
    id: tv.id,
    type: "tv",
    title: item.title,
    overview: cleanText(raw.overview),
    year: item.year,
    genres: genreNamesFor(raw.genre_ids ?? [], "tv"),
    genreIds: [...(raw.genre_ids ?? [])],
    rating: item.rating,
    voteCount: tv.vote_count,
    popularity: tv.popularity,
    posterUrl: item.posterUrl,
    backdropUrl: buildBackdropUrl(
      (tv as TmdbTv & { backdrop_path?: string | null }).backdrop_path,
    ),
  };
}

/**
 * Segunda camada da hard constraint: remove candidatos cujo genre_ids
 * cruza com os IDs da exclusão (mesmos mapas do without_genres, por tipo).
 * Chaves sem equivalência no tipo (ex.: horror em TV) não têm como ser
 * detectadas aqui — mesma limitação documentada dos mapas.
 */
function hasExcludedGenre(
  candidate: RecommendationCandidate,
  excluded: GenreKey[],
): boolean {
  if (excluded.length === 0 || candidate.genreIds.length === 0) return false;
  const ids = new Set(genreIdsFor(excluded, candidate.type));
  if (ids.size === 0) return false;
  return candidate.genreIds.some((id) => ids.has(id));
}

/**
 * Hard exclusion de assistidos (pura e determinística): remove do pool
 * qualquer candidato presente em watched_titles. Roda DEPOIS de qualquer
 * relaxamento/top-up — assistido nunca volta, nunca chega ao AI.
 */
export function excludeWatchedTitles(
  candidates: RecommendationCandidate[],
  watchedKeys: string[] | Set<string>,
): { kept: RecommendationCandidate[]; excludedCount: number } {
  const watched = watchedKeys instanceof Set ? watchedKeys : new Set(watchedKeys);
  if (watched.size === 0) return { kept: candidates, excludedCount: 0 };
  const kept = candidates.filter(
    (candidate) => !watched.has(watchedKey(candidate.type, candidate.id)),
  );
  return { kept, excludedCount: candidates.length - kept.length };
}

/** Remove duplicados (mesmo id ou mesmo título+ano+tipo). */
function dedupe(candidates: RecommendationCandidate[]): RecommendationCandidate[] {  const seen = new Set<string>();
  const titles = new Set<string>();
  const out: RecommendationCandidate[] = [];
  for (const candidate of candidates) {
    const idKey = `${candidate.type}:${candidate.id}`;
    const titleKey =
      `${candidate.type}:${candidate.title.toLowerCase()}|${candidate.year ?? ""}`;
    if (seen.has(idKey) || titles.has(titleKey)) continue;
    seen.add(idKey);
    titles.add(titleKey);
    out.push(candidate);
  }
  return out;
}

export function toContentItem(candidate: RecommendationCandidate): ContentItem {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    year: candidate.year,
    rating: candidate.rating,
    posterUrl: candidate.posterUrl,
    backdropUrl: candidate.backdropUrl,
    genres: candidate.genres.length > 0 ? [...candidate.genres] : undefined,
    hue: hueFor(candidate.id),
  };
}

async function discoverMovies(
  params: DiscoverParams,
  pages: number,
  startPage = 1,
): Promise<RecommendationCandidate[]> {
  const out: RecommendationCandidate[] = [];
  for (let page = startPage; page < startPage + pages; page++) {
    const data = await tmdbFetch<TmdbListResponse<TmdbMovie>>("/discover/movie", {
      params: { ...params, page },
    });
    for (const movie of data.results) {
      if (isUsableMovie(movie)) out.push(normalizeMovieCandidate(movie));
    }
    if (data.page >= data.total_pages) break;
  }
  return out;
}

async function discoverTv(
  params: DiscoverParams,
  pages: number,
  startPage = 1,
): Promise<RecommendationCandidate[]> {
  const out: RecommendationCandidate[] = [];
  for (let page = startPage; page < startPage + pages; page++) {
    const data = await tmdbFetch<TmdbListResponse<TmdbTv>>("/discover/tv", {
      params: { ...params, page },
    });
    for (const tv of data.results) {
      if (isUsableTv(tv)) out.push(normalizeTvCandidate(tv));
    }
    if (data.page >= data.total_pages) break;
  }
  return out;
}

/**
 * Monta o pool (~20–30 candidatos frescos). `excludeIds` remove títulos
 * já apresentados ANTES do ranking (a IA nem os vê). Se sobrarem
 * poucos frescos, relaxa SOMENTE essa restrição — nunca gêneros
 * excluídos, providers ou contentType (já aplicados no discover).
 *
 * Refinamentos (UM por vez, filtros suaves para não destruir o pool):
 * - shorter: teto de runtime nos filmes (reaproveita `with_runtime`;
 *   séries sem filtro confiável → só sinal de ranking);
 * - newer: piso de data (~12 anos) + nunca títulos futuros; se o pool
 *   ficar pobre (<4), refaz sem o piso;
 * - more_intense: sem filtro de pool (só sinal de ranking);
 * - less_popular: ordena por nota com votos/nota mínimos (hidden gems
 *   com qualidade); se o pool ficar pobre, refaz no padrão.
 *
 * Lança erro em falha TMDB — o endpoint traduz em 502 amigável.
 */
export async function buildCandidates(
  answers: DiscoveryAnswers,
  opts: CandidatePoolOptions = {},
): Promise<CandidatePoolResult> {
  const refinement = opts.refinement ?? null;
  const currentYear = new Date().getFullYear();
  // Hard constraint efetivo (profile + sessão). Nunca relaxado: vale no
  // TMDB (without_genres por tipo) e na validação pós-fetch — Groq e
  // refinamentos/reroll nunca veem candidato proibido.
  const effectiveExcluded: GenreKey[] =
    opts.effectiveExcludedGenres ?? answers.sessionExcludedGenres;
  const watchedKeys = new Set(opts.watchedExcludeIds ?? []);

  const fetchPool = async (
    withRefinementFilters: boolean,
    startPage = 1,
    pageCountOverride?: number,
  ): Promise<RecommendationCandidate[]> => {
    const wantsMovie = answers.contentType !== "tv";
    const wantsTv = answers.contentType !== "movie";
    const mixed = wantsMovie && wantsTv;

    // Providers: ["any"] não filtra; demais usam OR (pipe) com flatrate BR.
    let watchProviders: string | undefined;
    if (!answers.providers.includes("any")) {
      const ids = await getStreamingProviderIds();
      const selected = answers.providers.filter((p) => p !== "any");
      const resolved = selected
        .map((p) => ids[p as keyof typeof ids])
        .filter((id): id is number => typeof id === "number");
      if (resolved.length === 0) {
        throw new Error("[Discovery] Nenhum provider resolvido para o filtro.");
      }
      watchProviders = resolved.join("|");
    }

    const excludedMovieGenreIds = genreIdsFor(effectiveExcluded, "movie");
    const excludedTvGenreIds = genreIdsFor(effectiveExcluded, "tv");
    // without_genres por tipo: IDs de filme só no /discover/movie, IDs de
    // TV só no /discover/tv. Reutiliza os mapas existentes (sem IDs novos)
    // e nunca aplica aproximação de um tipo no outro.
    const withoutMovieGenres =
      excludedMovieGenreIds.length > 0 ? [...new Set(excludedMovieGenreIds)].join(",") : undefined;
    const withoutTvGenres =
      excludedTvGenreIds.length > 0 ? [...new Set(excludedTvGenreIds)].join(",") : undefined;

    const watchParams = watchProviders
      ? {
          watch_region: TMDB_WATCH_REGION,
          with_watch_monetization_types: "flatrate",
          with_watch_providers: watchProviders,
        }
      : {};

    // Refinamento newer: piso suave (~12 anos, não só o ano atual).
    const dateFloor =
      refinement === "newer" && withRefinementFilters
        ? `${currentYear - 12}-01-01`
        : undefined;

    // Refinamento shorter (filmes): teto de runtime. quick já filtra
    // (≤100); balanced aperta para ≤120; demais ganham teto suave (≤115)
    // = "mais fácil de consumir" sem esvaziar o pool.
    const shorterLte =
      refinement === "shorter" && withRefinementFilters
        ? answers.commitment === "quick"
          ? 100
          : answers.commitment === "balanced"
            ? 120
            : 115
        : undefined;

    // Refinamento less_popular: ordena por nota (não popularidade) com
    // mínimos de qualidade — hidden gems, não obscuridade.
    const qualitySort = refinement === "less_popular" && withRefinementFilters;
    const sortBy = qualitySort ? "vote_average.desc" : baseParams().sort_by;

    const movieLimit = mixed ? CANDIDATES_PER_TYPE_MIXED : CANDIDATES_PER_TYPE;

    const [movies, series] = await Promise.all([
      (async (): Promise<RecommendationCandidate[]> => {
        if (!wantsMovie) return [];
        const withGenres = genreIdsFor(answers.preferredGenres, "movie");
        const params: DiscoverParams = {
          ...baseParams(),
          sort_by: sortBy,
          ...watchParams,
          ...(withGenres.length > 0 ? { with_genres: withGenres.join("|") } : {}),
          ...(withoutMovieGenres ? { without_genres: withoutMovieGenres } : {}),
          // Compromisso → runtime (só filmes; séries sem filtro confiável).
          ...(answers.commitment === "quick" ? { "with_runtime.lte": 100 } : {}),
          ...(answers.commitment === "balanced"
            ? { "with_runtime.gte": 90, "with_runtime.lte": 140 }
            : {}),
          ...(shorterLte !== undefined ? { "with_runtime.lte": shorterLte } : {}),
          ...(dateFloor ? { "primary_release_date.gte": dateFloor } : {}),
          ...(qualitySort ? { "vote_count.gte": 30, "vote_average.gte": 6 } : {}),
          page: 1,
        };
        const list = await discoverMovies(
          params,
          pageCountOverride ?? (mixed ? 2 : 3),
          startPage,
        );
        return list.slice(0, movieLimit);
      })(),
      (async (): Promise<RecommendationCandidate[]> => {
        if (!wantsTv) return [];
        const withGenres = genreIdsFor(answers.preferredGenres, "tv");
        const params: DiscoverParams = {
          ...baseParams(),
          sort_by: sortBy,
          ...watchParams,
          ...(withGenres.length > 0 ? { with_genres: withGenres.join("|") } : {}),
          ...(withoutTvGenres ? { without_genres: withoutTvGenres } : {}),
          ...(dateFloor ? { "first_air_date.gte": dateFloor } : {}),
          ...(qualitySort ? { "vote_count.gte": 30, "vote_average.gte": 6 } : {}),
          page: 1,
        };
        const list = await discoverTv(
          params,
          pageCountOverride ?? (mixed ? 2 : 3),
          startPage,
        );
        return list.slice(0, mixed ? CANDIDATES_PER_TYPE_MIXED : CANDIDATES_PER_TYPE);
      })(),
    ]);

    // any = intercalado; único tipo = ordem de popularidade.
    let pool: RecommendationCandidate[];
    if (mixed) {
      pool = [];
      const rounds = Math.max(movies.length, series.length);
      for (let i = 0; i < rounds && pool.length < CANDIDATE_POOL_SIZE; i++) {
        if (movies[i]) pool.push(movies[i]);
        if (pool.length >= CANDIDATE_POOL_SIZE) break;
        if (series[i]) pool.push(series[i]);
      }
    } else {
      pool = [...movies, ...series].slice(0, CANDIDATE_POOL_SIZE);
    }

    const full = dedupe(pool);
    // Nunca títulos futuros (independente de refinamento).
    const dated = full.filter(
      (candidate) => candidate.year === undefined || candidate.year <= currentYear,
    );
    // Defesa em duas camadas: TMDB filtrou, mas valida de novo antes do
    // ranking — Groq nunca recebe candidato com gênero excluído mapeável.
    return dated.filter((candidate) => !hasExcludedGenre(candidate, effectiveExcluded));
  };

  let full = await fetchPool(true);
  // Pool pobre com filtros de refinamento → refaz sem eles (relaxa SÓ o
  // refinamento; resto das restrições continua). shorter/more_intense
  // nunca chegam aqui (filtros suaves/sem filtro).
  if (
    full.length < MIN_FRESH_RESULTS &&
    (refinement === "newer" || refinement === "less_popular")
  ) {
    console.info(
      `[Discovery] Refinamento ${refinement} esvaziou o pool (${full.length}) — relaxando filtro.`,
    );
    full = await fetchPool(false);
  }

  const excluded = new Set(opts.excludeIds ?? []);
  let fresh: RecommendationCandidate[];
  if (excluded.size === 0) {
    fresh = full;
  } else {
    fresh = full.filter(
      (candidate) => !excluded.has(`${candidate.type}:${candidate.id}`),
    );
    const target = Math.min(MIN_FRESH_RESULTS, full.length);
    if (fresh.length < target) {
      // Esgotamento: prefere reapresentar um antigo a entregar menos que o
      // mínimo (hard constraints do usuário continuam intactas no pool).
      const topped = [...fresh];
      for (const candidate of full) {
        if (topped.length >= target) break;
        if (!topped.includes(candidate)) topped.push(candidate);
      }
      fresh = topped;
    }
  }

  // Hard exclusion de assistidos — ÚLTIMA etapa, sem relaxamento: o top-up
  // acima pode ter reintroduzido um assistido, então filtra de novo aqui.
  // O AI nunca recebe título assistido.
  let watchedExcludedCount = 0;
  if (watchedKeys.size > 0) {
    const split = excludeWatchedTitles(fresh, watchedKeys);
    fresh = split.kept;
    watchedExcludedCount = split.excludedCount;

    // Estratégia anti-esvaziamento (limitada): se a exclusão derrubou o
    // pool abaixo do mínimo, busca UMA página adicional por tipo (as já
    // buscadas foram 1–2 mixed / 1–3 único) e completa até o mínimo.
    // Sem loops: no máximo +1 round de TMDB por request.
    if (fresh.length < MIN_FRESH_RESULTS) {
      const wantsMovie = answers.contentType !== "tv";
      const wantsTv = answers.contentType !== "movie";
      const nextPage = wantsMovie && wantsTv ? 3 : 4;
      try {
        const extra = await fetchPool(true, nextPage, 1);
        const seen = new Set(fresh.map((c) => `${c.type}:${c.id}`));
        for (const candidate of extra) {
          if (fresh.length >= MIN_FRESH_RESULTS) break;
          const key = `${candidate.type}:${candidate.id}`;
          if (seen.has(key) || excluded.has(key) || watchedKeys.has(key)) continue;
          seen.add(key);
          fresh.push(candidate);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "erro desconhecido";
        console.error(`[Discovery] Página extra indisponível (${message}) — seguindo com o pool.`);
      }
    }
  }

  return { candidates: fresh, watchedExcludedCount };
}
