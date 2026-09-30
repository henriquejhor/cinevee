/**
 * Tipos dos comentários em avaliações (Etapa 19).
 *
 * Desacoplados da linha raw do banco: o restante do app consome estes
 * tipos, nunca author_id/owner UUID. O que não está aqui não vaza.
 * Comentário NÃO é review: review_text é do dono da rating;
 * rating_comment é resposta de OUTRO usuário naquela rating.
 */
import type { ContentType } from "../../types/content";

/** Alvo de comentário vindo do browser: só campos públicos. Sem UUID. */
export interface RatingCommentTarget {
  username: string;
  tmdbId: number;
  mediaType: ContentType;
}

/**
 * Autor do comentário. Perfil público → identidade real (linkável);
 * perfil privado → "Usuário privado" (sem username/avatar/link).
 * O texto do comentário é público nos dois casos.
 */
export interface RatingCommentAuthor {
  isPrivate: boolean;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
}

/** Um comentário da thread (id público próprio, sem UUID de usuário). */
export interface RatingComment {
  commentId: number;
  author: RatingCommentAuthor;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** true quando updated_at > created_at (tolerância de 1s). */
  edited: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Replies visíveis ao viewer (Etapa 22; ausente em snapshot antigo = 0). */
  replyCount: number;
}

/** Summary público por rating (batch): sem UUID, sem autores. */
export interface RatingCommentState extends RatingCommentTarget {
  commentCount: number;
  commentsEnabled: boolean;
}

/** Página da thread: itens + paginação + gates da UI. */
export interface RatingCommentPage {
  items: RatingComment[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  commentCount: number;
  commentsEnabled: boolean;
  /** Viewer é o dono da rating (nunca comenta, mas pode moderar). */
  isOwner: boolean;
  /** Logado + não-owner + commentsEnabled (composer liberado). */
  canComment: boolean;
}

/** Teto do batch de states (igual ao teto das listas públicas). */
export const RATING_COMMENT_BATCH_SIZE = 24;

/** Limite default da thread (abertura) e teto por request. */
export const RATING_COMMENT_DEFAULT_LIMIT = 5;
export const RATING_COMMENT_MAX_LIMIT = 24;

/** Texto puro: 1..500 após trim (CHECK no banco + validação aqui). */
export const RATING_COMMENT_MAX_LENGTH = 500;
