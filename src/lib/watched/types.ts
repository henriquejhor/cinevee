/**
 * Tipos dos Assistidos / Já assisti (Etapa 6).
 *
 * Desacoplados da linha raw do Supabase: componentes consomem
 * `WatchedTitle` (camelCase), nunca o shape snake_case da tabela.
 * title/poster/year são snapshots para renderização; o TMDB é a fonte
 * factual (validado no backend antes de salvar).
 */
import type { ContentType } from "../../types/content";

export interface WatchedTitle {
  tmdbId: number;
  mediaType: ContentType;
  title: string;
  posterPath: string | null;
  year?: number;
  watchedAt: string;
}

export interface WatchedInput {
  tmdbId: number;
  mediaType: ContentType;
}
