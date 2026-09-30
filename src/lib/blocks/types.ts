/**
 * Tipos de bloqueio + gestão de seguidores (Etapa 23).
 *
 * Desacoplados do banco: o app consome estes tipos, nunca
 * blocker_id/blocked_id/follower_id UUID. Gestão usa ids bigint
 * opacos (blockId/followId). O que não está aqui não vaza.
 */
export interface BlockedUserItem {
  blockId: number;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  blockedAt: string;
}

export interface BlockedUsersPage {
  items: BlockedUserItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface FollowerItem {
  followId: number;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  followedAt: string | null;
  isPublic: boolean;
}

export interface FollowersPage {
  items: FollowerItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Tamanho da página (mesmo padrão: 24 + probe). */
export const BLOCKS_PAGE_SIZE = 24;
