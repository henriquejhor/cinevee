/**
 * Helper centralizado para imagens do TMDB.
 * Única fonte da URL base de imagens — não espalhar por componentes.
 */

const IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

export type TmdbPosterSize = "w342" | "w500" | "w780" | "original";

export type TmdbBackdropSize = "w780" | "w1280" | "original";

export type TmdbLogoSize = "w45" | "w92" | "w154" | "w185" | "w300" | "original";

/**
 * Monta a URL do pôster. Retorna `undefined` quando não há `poster_path`,
 * para que o card use o placeholder atual.
 */
export function buildPosterUrl(
  posterPath: string | null | undefined,
  size: TmdbPosterSize = "w500",
): string | undefined {
  if (!posterPath) return undefined;
  return `${IMAGE_BASE_URL}/${size}${posterPath}`;
}

/**
 * Monta a URL do backdrop (ex.: hero da página de detalhes).
 * Retorna `undefined` quando não há `backdrop_path`.
 */
export function buildBackdropUrl(
  backdropPath: string | null | undefined,
  size: TmdbBackdropSize = "w1280",
): string | undefined {
  if (!backdropPath) return undefined;
  return `${IMAGE_BASE_URL}/${size}${backdropPath}`;
}

/**
 * Monta a URL do logo de um Watch Provider.
 * Retorna `undefined` quando não há `logo_path`.
 */
export function buildLogoUrl(
  logoPath: string | null | undefined,
  size: TmdbLogoSize = "w92",
): string | undefined {
  if (!logoPath) return undefined;
  return `${IMAGE_BASE_URL}/${size}${logoPath}`;
}
