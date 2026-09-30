/**
 * Tipos da Minha Lista (Etapa 4).
 *
 * Desacoplados da linha raw do Supabase: componentes consomem
 * `WatchlistItem` (camelCase), nunca o shape snake_case da tabela.
 * title/poster/year são snapshots para renderização; o TMDB é a fonte
 * factual (validado no backend antes de salvar).
 */
import type { ContentType } from "../../types/content";

export interface WatchlistItem {
  tmdbId: number;
  mediaType: ContentType;
  title: string;
  posterPath: string | null;
  year?: number;
  createdAt: string;
}

export interface WatchlistInput {
  tmdbId: number;
  mediaType: ContentType;
}
