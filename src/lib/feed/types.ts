/**
 * Tipos do feed "Seguindo" (Etapa 17).
 *
 * Desacoplados da linha raw da RPC: o restante do app consome `FeedEvent`,
 * nunca o shape snake_case do banco. Nenhum UUID/email/flag passa por aqui:
 * os tipos abaixo são o allowlist — o que não está aqui não vaza.
 */
import type { ContentType } from "../../types/content";

/** Os 3 tipos de atividade da primeira versão (nada de strings espalhadas). */
export type FeedEventType = "rating" | "favorite" | "recommendation";

export const FEED_EVENT_TYPES: readonly FeedEventType[] = [
  "rating",
  "favorite",
  "recommendation",
] as const;

/** Ator: só identidade pública (link → /u/[username]). Sem id interno. */
export interface FeedActor {
  displayName: string | null;
  username: string;
  avatarUrl: string | null;
}

/** Título: snapshot factual salvo no banco (sem TMDB no feed). */
export interface FeedTitle {
  tmdbId: number;
  mediaType: ContentType;
  title: string;
  posterUrl?: string;
  year?: number;
}

export interface FeedEvent {
  /** Chave opaca p/ dedupe (`type:username:mediaType:tmdbId`, sem UUID). */
  eventKey: string;
  type: FeedEventType;
  actor: FeedActor;
  title: FeedTitle;
  /** rating 1..5 — só em eventos "rating". */
  rating?: number;
  /** reviewText (rating) ou note (recommendation). NULL = escondido. */
  text: string | null;
  /**
   * Curtidas da rating (Etapa 18) — só em eventos "rating", quando a
   * RPC de states está disponível. Ausente = sem dados (pré-migration).
   */
  likeCount?: number;
  likedByViewer?: boolean;
  /**
   * Comentários da rating (Etapa 19) — só em eventos "rating", quando
   * a RPC de states está disponível. Ausente = sem dados
   * (pré-migration). Comentar NUNCA cria evento de feed nem reordena.
   */
  commentCount?: number;
  commentsEnabled?: boolean;
  /** ISO instant do evento (rated_at / created_at da origem). */
  activityAt: string;
}

export interface FeedPage {
  items: FeedEvent[];
  page: number;
  hasMore: boolean;
}

/** Teto por página do feed (igual às listas públicas). */
export const FEED_PAGE_SIZE = 24;

/** Tamanho da prévia do feed na Home (1 request client-side). */
export const FEED_HOME_SIZE = 6;
