/**
 * Tipos das curtidas em avaliações (Etapa 18).
 *
 * Desacoplados da linha raw do banco: o restante do app consome estes
 * tipos, nunca liker_id/owner UUID. O que não está aqui não vaza.
 */
import type { ContentType } from "../../types/content";

/** Alvo de like vindo do browser: só campos públicos. Sem UUID. */
export interface RatingLikeTarget {
  username: string;
  tmdbId: number;
  mediaType: ContentType;
}

/** Resultado de like/unlike: estado + contador real da rating. */
export interface RatingLikeResult {
  liked: boolean;
  likeCount: number;
}

/** Summary público por rating (batch): sem UUID, sem likers. */
export interface RatingLikeState extends RatingLikeTarget {
  likeCount: number;
  likedByViewer: boolean;
}

/** Teto do batch de states (igual ao teto das listas públicas). */
export const RATING_LIKE_BATCH_SIZE = 24;
