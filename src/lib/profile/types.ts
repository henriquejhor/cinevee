/**
 * Tipos do perfil do usuário (Etapa 2 — profiles + preferências).
 *
 * Desacoplados da linha raw do Supabase: o restante do app consome
 * `UserProfile`/`UserPreferences`, nunca o shape da tabela.
 * Chaves internas vêm dos catálogos centrais (labels pt-BR ficam na UI).
 */
import type { GenreKey } from "../../types/discovery";
import type { StreamingProvider } from "../../types/content";

export interface UserPreferences {
  /** Gêneros a evitar. Chaves semânticas (ex.: "horror"), nunca labels. */
  excludedGenres: GenreKey[];
  /** Streamings do usuário. Chaves internas (ex.: "netflix"), nunca IDs TMDB. */
  streamingProviders: StreamingProvider[];
}

export interface UserProfile {
  id: string;
  displayName: string | null;
  /** @username sem o "@". NULL = ainda não definido. Sempre lowercase. */
  username: string | null;
  /** Bio em texto puro (≤160). NULL = vazia. */
  bio: string | null;
  /** Caminho no bucket `avatars` (`{user_id}/{arquivo}`). NULL = sem foto. */
  avatarPath: string | null;
  /** URL pública do avatar. NULL = usar fallback de iniciais. */
  avatarUrl: string | null;
  preferences: UserPreferences;
  /** Privacidade do perfil público (Etapa 14). Defaults quando pré-migration. */
  privacy: PrivacySettings;
}

export const EMPTY_PREFERENCES: UserPreferences = {
  excludedGenres: [],
  streamingProviders: [],
};

/**
 * Controles de privacidade do perfil público (Etapa 14).
 * Tudo desligado por padrão (privacidade conservadora). Minha Lista não
 * tem flag — continua sempre privada. showReviews só vale com showRatings.
 */
export interface PrivacySettings {
  profilePublic: boolean;
  showFavorites: boolean;
  showRecommendations: boolean;
  showWatched: boolean;
  showRatings: boolean;
  showReviews: boolean;
  /**
   * Aparecer na busca de pessoas (Etapa 15). Só tem efeito com
   * profilePublic + username válido (a RPC exige ambos). Preservado
   * ao desligar o perfil público — volta a valer se republicar.
   */
  discoverable: boolean;
  /**
   * Distribuir atividades no feed de quem segue (Etapa 17). Opt-in,
   * desligado por padrão. Só produz conteúdo com profilePublic + as
   * flags da seção correspondente (showRatings/showFavorites/
   * showRecommendations). Preservado ao desligar o perfil público.
   */
  showActivity: boolean;
  /**
   * Permitir NOVOS comentários nas próprias avaliações (Etapa 19).
   * Opt-in, desligado por padrão (ninguém recebe comentários sozinho).
   * Desligar NÃO esconde a thread existente (só o composer) e NÃO
   * impede edit/delete (sem comentário impossível de remover).
   */
  allowRatingComments: boolean;
}

export const EMPTY_PRIVACY: PrivacySettings = {
  profilePublic: false,
  showFavorites: false,
  showRecommendations: false,
  showWatched: false,
  showRatings: false,
  showReviews: false,
  discoverable: false,
  showActivity: false,
  allowRatingComments: false,
};
