/**
 * Tipos mínimos do TMDB — apenas os campos utilizados pela UI.
 * Não espelhar a resposta completa da API.
 */

export interface TmdbMovie {
  id: number;
  title: string;
  release_date?: string;
  vote_average?: number;
  vote_count?: number;
  poster_path: string | null;
  popularity?: number;
}

export interface TmdbTv {
  id: number;
  name: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  poster_path: string | null;
  popularity?: number;
}

export interface TmdbListResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

/**
 * Item mínimo de GET /search/multi utilizado pela busca.
 * Apenas os campos consumidos pela normalização — pessoas
 * (`media_type === "person"`) são descartadas antes de normalizar.
 */
export interface TmdbSearchMultiResult {
  id: number;
  media_type?: "movie" | "tv" | "person" | string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  poster_path: string | null;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

/** Campos de GET /movie/{id} utilizados pela página de detalhes. */
export interface TmdbMovieDetails {
  id: number;
  title: string;
  original_title?: string;
  overview?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  runtime?: number | null;
  vote_average?: number;
  vote_count?: number;
  genres?: TmdbGenre[];
  tagline?: string;
  status?: string;
}

/** Campos de GET /tv/{id} utilizados pela página de detalhes. */
export interface TmdbTvDetails {
  id: number;
  name: string;
  original_name?: string;
  overview?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date?: string;
  episode_run_time?: number[];
  vote_average?: number;
  vote_count?: number;
  genres?: TmdbGenre[];
  tagline?: string;
  status?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
}

/** Provedor individual em GET /{movie|tv}/{id}/watch/providers. */
export interface TmdbWatchProviderEntry {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

/** Disponibilidade de uma região (ex.: results.BR). */
export interface TmdbWatchRegionResult {
  link?: string;
  flatrate?: TmdbWatchProviderEntry[];
  free?: TmdbWatchProviderEntry[];
  ads?: TmdbWatchProviderEntry[];
  rent?: TmdbWatchProviderEntry[];
  buy?: TmdbWatchProviderEntry[];
}

/** Resposta mínima de GET /{movie|tv}/{id}/watch/providers. */
export interface TmdbWatchProvidersResponse {
  id: number;
  results: Record<string, TmdbWatchRegionResult>;
}

/** Vídeo mínimo de GET /{movie|tv}/{id}/videos. */
export interface TmdbVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official?: boolean;
  iso_639_1?: string;
  iso_3166_1?: string;
  published_at?: string;
}

/** Resposta mínima de GET /{movie|tv}/{id}/videos. */
export interface TmdbVideosResponse {
  id: number;
  results: TmdbVideo[];
}
