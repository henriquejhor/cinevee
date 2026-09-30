/**
 * Tipos do social mínimo (Etapa 16): seguir/deixar de seguir.
 *
 * Seguir/deixar de seguir passam por RPCs que resolvem o alvo por
 * username server-side — UUID nunca trafega no browser.
 */
export interface FollowTargetInput {
  /** @username do perfil alvo (sem "@"). Normalizado na validação. */
  username: string;
}

export interface FollowState {
  /** O usuário DA SESSÃO segue o perfil visitado. */
  following: boolean;
  /** O perfil visitado é o do próprio usuário DA SESSÃO. */
  isSelf: boolean;
}

/** Contadores próprios (totais, sem filtro de privacidade). */
export interface MyFollowCounts {
  followersTotal: number;
  followingTotal: number;
  followingPublic: number;
}

/** Contadores públicos de um perfil (regras de contagem documentadas). */
export interface PublicFollowCounts {
  followersCount: number;
  followingCount: number;
}
