/**
 * Tipos do Explore (Etapa 11) — navegação editorial/TMDB com filtros.
 *
 * Sem IA, sem Supabase, sem personalização: presets fixos + filtros
 * explícitos. A UI consome `ContentItem` (nunca raw TMDB).
 */
import type { ContentItem, ContentType, StreamingProvider } from "../../types/content";
import type { GenreKey } from "../../types/discovery";

export type ExploreSlug =
  | "em-alta"
  | "nos-streamings"
  | "muito-bem-avaliados"
  | "filmes-populares"
  | "series-populares";

export type ExploreMediaType = "all" | ContentType;
export type ExploreGenre = GenreKey | "all";
export type ExploreStreaming = StreamingProvider | "all";

export interface ExploreFilters {
  mediaType: ExploreMediaType;
  genre: ExploreGenre;
  /** Ano específico ou null (sem filtro). */
  year: number | null;
  streaming: ExploreStreaming;
}

export type ExploreSource =
  | "trending"
  | "streaming"
  | "top_rated"
  | "popular_movies"
  | "popular_series";

export interface ExplorePreset {
  slug: ExploreSlug;
  eyebrow: string;
  title: string;
  description: string;
  source: ExploreSource;
  /** Tipo padrão quando `tipo` ausente/inválido. */
  defaultMediaType: ExploreMediaType;
  /** Fixo (filmes/séries populares): UI não oferece outro tipo. */
  mediaTypeLocked: boolean;
}

export interface ExploreResult {
  items: ContentItem[];
  page: number;
  totalPages: number;
  hasMore: boolean;
  appliedFilters: ExploreFilters;
  /**
   * Combinação sem representação oficial (ex.: tv + horror): nenhuma
   * consulta genérica foi feita — a UI mostra aviso explícito em vez
   * de resultados não filtrados.
   */
  unsupportedCombination: boolean;
}
