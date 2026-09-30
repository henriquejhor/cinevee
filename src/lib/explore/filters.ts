/**
 * Filtros do Explore — parsing/validação puros (Etapa 11).
 *
 * Query params: `tipo` | `genero` | `ano` | `streaming`.
 * - Valores inválidos caem para defaults seguros (nunca 400 por filtro;
 *   nunca repassados ao TMDB sem validação);
 * - presets de tipo fixo ignoram `tipo` contraditório (coerção documentada);
 * - um gênero por vez (sem AND/OR nesta versão).
 */
import { GENRE_OPTIONS, type GenreKey } from "../../types/discovery";
import { PROVIDER_LABELS, type StreamingProvider } from "../../types/content";
import type { ExploreFilters, ExplorePreset } from "./types";

export const EXPLORE_MIN_YEAR = 1900;

const GENRE_KEYS = new Set(GENRE_OPTIONS.map((o) => o.value));
const PROVIDER_KEYS = new Set(Object.keys(PROVIDER_LABELS));

export function isGenreKey(value: string): value is GenreKey {
  return GENRE_KEYS.has(value as GenreKey);
}

export function isStreamingProvider(value: string): value is StreamingProvider {
  return PROVIDER_KEYS.has(value as StreamingProvider);
}

/**
 * Invariante central (auditoria Etapa 11): um filtro ativo na URL/UI deve
 * estar representado na consulta efetiva. `horror` só possui categoria
 * oficial em filmes (TMDB 27) — TV não tem equivalente direto, então a
 * combinação só é suportada com tipo movie.
 */
export function isGenreSupportedFor(
  mediaType: "all" | "movie" | "tv",
  genre: GenreKey | "all",
): boolean {
  if (genre === "all") return true;
  if (genre === "horror") return mediaType === "movie";
  return true;
}

/**
 * Gêneros oferecidos no select conforme o tipo (sem duplicar catálogo).
 * "all"/"tv" omitem horror (mixed não honraria o filtro na metade tv).
 */
export function getAvailableExploreGenres(
  mediaType: "all" | "movie" | "tv",
): GenreKey[] {
  const all = GENRE_OPTIONS.map((o) => o.value);
  if (mediaType === "movie") return all;
  return all.filter((genre) => genre !== "horror");
}

/** Ano atual server-side (nunca hardcoded). */
export function currentYear(): number {
  return new Date().getFullYear();
}

function parseYear(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const year = Number(raw);
  if (!Number.isInteger(year) || year < EXPLORE_MIN_YEAR || year > currentYear()) {
    return null;
  }
  return year;
}

/**
 * Totais/valores lidos de URLSearchParams (página) ou de query plana (API).
 * `get(name)` recebe o valor bruto ou null.
 */
export function parseExploreFilters(
  preset: ExplorePreset,
  get: (name: string) => string | null,
): ExploreFilters {
  const rawType = (get("tipo") ?? "").trim();
  const mediaType =
    preset.mediaTypeLocked || (rawType !== "movie" && rawType !== "tv" && rawType !== "all")
      ? preset.defaultMediaType
      : rawType;

  const rawGenre = (get("genero") ?? "").trim();
  const genre = isGenreKey(rawGenre) ? rawGenre : "all";

  const rawStreaming = (get("streaming") ?? "").trim();
  const streaming = isStreamingProvider(rawStreaming) ? rawStreaming : "all";

  return { mediaType, genre, year: parseYear(get("ano")), streaming };
}

/** Quantos filtros diferem do preset (p/ "Filtros (N)" e "Limpar filtros"). */
export function activeFilterCount(preset: ExplorePreset, filters: ExploreFilters): number {
  let count = 0;
  if (!preset.mediaTypeLocked && filters.mediaType !== preset.defaultMediaType) count += 1;
  if (filters.genre !== "all") count += 1;
  if (filters.year !== null) count += 1;
  if (filters.streaming !== "all") count += 1;
  return count;
}

/** Reconstrói a query canonica (p/ links e "Carregar mais"). */
export function filtersToQuery(filters: ExploreFilters): string {
  const params = new URLSearchParams();
  if (filters.mediaType !== "all") params.set("tipo", filters.mediaType);
  if (filters.genre !== "all") params.set("genero", filters.genre);
  if (filters.year !== null) params.set("ano", String(filters.year));
  if (filters.streaming !== "all") params.set("streaming", filters.streaming);
  return params.toString();
}

/** Página 1..1000 (TMDB); inválida → null (a API responde 400). */
export function parseExplorePage(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > 1000) return null;
  return page;
}
