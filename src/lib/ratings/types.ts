/**
 * Tipos das Avaliações (Etapa 7).
 *
 * Desacoplados da linha raw do Supabase: componentes consomem
 * `UserRating` / `RatedTitle` (camelCase), nunca o shape snake_case.
 * ratings NÃO duplica title/poster/year — os dados visuais do título
 * vêm de watched_titles via relação.
 */
import type { ContentType } from "../../types/content";

export interface UserRating {
  tmdbId: number;
  mediaType: ContentType;
  rating: number;
  /** Opinião textual opcional (Etapa 12). NULL = sem opinião. Texto puro. */
  reviewText: string | null;
  ratedAt: string;
  updatedAt: string;
}

/** Avaliação + snapshot visual do título (para grids e previews). */
export interface RatedTitle extends UserRating {
  title: string;
  posterPath: string | null;
  year?: number;
}

export interface RatingInput {
  tmdbId: number;
  mediaType: ContentType;
  rating: number;
  /**
   * Opinião opcional (Etapa 12). `undefined` = campo omitido → preserva a
   * opinião existente (trocar estrelas não apaga o texto). `null` ou ""
   * = limpar a opinião sem remover a nota.
   */
  reviewText?: string | null;
}

export interface RatingKey {
  tmdbId: number;
  mediaType: ContentType;
}

/** PATCH /api/ratings — edita SÓ a opinião (exige rating existente). */
export interface ReviewUpdateInput extends RatingKey {
  /** `null` = remover a opinião, mantendo as estrelas. */
  reviewText: string | null;
}
