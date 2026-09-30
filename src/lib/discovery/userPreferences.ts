/**
 * Ponte server-side: UserPreferences (conta) → fluxo Discovery (sessão).
 *
 * Separação mantida:
 * - UserPreferences = permanente, vive no Supabase (nunca no localStorage);
 * - DiscoveryAnswers = sessão atual, vive no localStorage + request;
 * - RecommendationContext = combinação dos dois, só em memória server-side.
 *
 * O usuário sempre vem da sessão autenticada — nenhum userId do browser.
 * Deslogado ou falha temporária → preferências vazias (Discovery igual ao
 * atual, sem exigir login e sem quebrar).
 */
import type { AstroCookies } from "astro";
import type { DiscoveryAnswers, GenreKey } from "../../types/discovery";
import { getUserProfile } from "../profile/service";
import { EMPTY_PREFERENCES, type UserPreferences } from "../profile/types";
import {
  buildPersonalization,
  type Personalization,
} from "../personalization/tasteProfile";
import type { TasteProfile } from "../personalization/taste";
import { perf } from "../perf";

export interface RecommendationContext {
  /** Respostas da sessão, como vieram do browser (validadas). */
  answers: DiscoveryAnswers;
  /** Exclusões permanentes do profile ([] se deslogado/falha). */
  profileExcludedGenres: GenreKey[];
  /** União profile + sessão, com dedupe — o HARD CONSTRAINT efetivo. */
  effectiveExcludedGenres: GenreKey[];
  /** Chaves `mediaType:tmdbId` assistidos ([] se deslogado/falha). */
  watchedTitleKeys: string[];
  /** Gosto histórico compacto (vazio se deslogado/sem ratings/falha). */
  tasteProfile: TasteProfile;
  /** Versão opaca do histórico (invalida cache do client). */
  personalizationVersion: string;
}

/**
 * Lê as preferências do usuário autenticado. Nunca lança: qualquer falha
 * (deslogado, profile ausente, erro temporário) vira preferências vazias
 * com log server-side seguro (sem dados do usuário, sem segredos).
 */
export async function getDiscoveryUserPreferences(
  request: Request,
  cookies: AstroCookies,
): Promise<UserPreferences> {
  try {
    const { user, profile } = await getUserProfile(request, cookies);
    if (!user || !profile) {
      return {
        excludedGenres: [],
        streamingProviders: [],
      };
    }
    return prefsFromProfile(profile.preferences);
  } catch {
    console.error("[Discovery] Profile indisponível — seguindo sem preferências.");
    return {
      excludedGenres: [],
      streamingProviders: [],
    };
  }
}

/** Mapeamento puro profile → preferências (sem IO; cópias defensivas). */
function prefsFromProfile(preferences: UserPreferences): UserPreferences {
  return {
    excludedGenres: [...preferences.excludedGenres],
    streamingProviders: [...preferences.streamingProviders],
  };
}

/** União profile + sessão, sem duplicatas. */
export function mergeExcludedGenres(
  profileExcluded: GenreKey[],
  sessionExcluded: GenreKey[],
): GenreKey[] {
  return [...new Set([...profileExcluded, ...sessionExcluded])];
}

export async function buildRecommendationContext(
  request: Request,
  cookies: AstroCookies,
  answers: DiscoveryAnswers,
): Promise<RecommendationContext> {
  // UMA sessão validada (1 auth.getUser) compartilhada entre prefs e
  // personalização — antes eram 2 roundtrips de auth por request.
  // Falha aqui degrada como antes (vazios), nunca quebra o Discovery.
  let session: Awaited<ReturnType<typeof getUserProfile>> | null = null;
  try {
    session = await perf("discovery.prefs", () => getUserProfile(request, cookies));
  } catch {
    console.error("[Discovery] Profile indisponível — seguindo sem preferências.");
  }
  const prefs = session?.profile ? prefsFromProfile(session.profile.preferences) : null;
  const personalization = await perf("taste.total", () =>
    buildPersonalization(
      request,
      cookies,
      session?.user ? { supabase: session.supabase, user: session.user } : null,
    ),
  );
  const excluded = prefs?.excludedGenres ?? [];
  return {
    answers,
    profileExcludedGenres: excluded,
    effectiveExcludedGenres: mergeExcludedGenres(
      excluded,
      answers.sessionExcludedGenres,
    ),
    watchedTitleKeys: personalization.watchedTitleKeys,
    tasteProfile: personalization.tasteProfile,
    personalizationVersion: personalization.version,
  };
}

export type { Personalization };

export { EMPTY_PREFERENCES };
