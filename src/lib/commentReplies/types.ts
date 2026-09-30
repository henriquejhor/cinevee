/**
 * Tipos das respostas em comentários (Etapa 22, 1 nível).
 *
 * Desacoplados da linha raw do banco: o restante do app consome estes
 * tipos, nunca author_id/UUID. Resposta nunca tem filha (tabela
 * separada) — não existe recursão nem nesting na UI.
 */
export interface CommentReplyTarget {
  commentId: number;
}

export interface CommentReplyItem {
  replyId: number;
  text: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  author: {
    isPrivate: boolean;
    displayName: string | null;
    username: string | null;
    avatarUrl: string | null;
  };
  canEdit: boolean;
  canDelete: boolean;
}

export interface CommentReplyPage {
  items: CommentReplyItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Página de replies (mesmo padrão: 10 + probe, teto 24). */
export const REPLY_PAGE_SIZE = 10;
export const REPLY_PAGE_MAX = 24;
export const REPLY_TEXT_MAX_LENGTH = 500;
