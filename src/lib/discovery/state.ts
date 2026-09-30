/**
 * Estado puro do questionário (sem DOM): respostas, sessão e validação.
 * O controlador DOM (`flow.ts`) usa estas funções; a lógica é testável
 * isoladamente com `node`.
 */
import {
  COMMITMENT_OPTIONS,
  CONTENT_TYPE_OPTIONS,
  CATEGORY_HISTORY_KEY,
  DISCOVERY_SESSION_TTL_MS,
  DISCOVERY_STORAGE_KEY,
  GENRE_OPTIONS,
  isRecommendationRefinement,
  MAX_GENRES,
  MOOD_OPTIONS,
  PROVIDER_OPTIONS,
  SEEN_STORAGE_KEY,
  type AdaptiveOption,
  type CommitmentKey,
  type ContentTypeChoice,
  type DiscoveryAnswers,
  type DiscoveryProvider,
  type DiscoverySession,
  type DiscoveryStep,
  type GenreKey,
  type MoodKey,
  type RecommendationRefinement,
} from "../../types/discovery";

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const CONTENT_VALUES = CONTENT_TYPE_OPTIONS.map((o) => o.value);
const MOOD_VALUES = MOOD_OPTIONS.map((o) => o.value);
const GENRE_VALUES = GENRE_OPTIONS.map((o) => o.value);
const COMMITMENT_VALUES = COMMITMENT_OPTIONS.map((o) => o.value);
const PROVIDER_VALUES: readonly string[] = [
  ...PROVIDER_OPTIONS.map((o) => o.value),
  "any",
];

export function createInitialAnswers(): DiscoveryAnswers {
  return {
    contentType: null,
    mood: null,
    preferredGenres: [],
    adaptive: { category: "", value: null },
    commitment: null,
    providers: ["any"],
    sessionExcludedGenres: [],
  };
}

export function isValidStep(value: unknown): value is DiscoveryStep {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 8
  );
}

/**
 * Valida um DiscoveryAnswers (corpo do endpoint ou sessão).
 * `null` = inválido. Não exige completude: campos null são aceitos
 * (o endpoint de recomendações exige completude à parte).
 */
export function parseAnswers(raw: unknown): DiscoveryAnswers | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;

  if (a.contentType !== null && !isOneOf(a.contentType, CONTENT_VALUES)) return null;
  if (a.mood !== null && !isOneOf(a.mood, MOOD_VALUES)) return null;
  if (
    !Array.isArray(a.preferredGenres) ||
    !a.preferredGenres.every((g) => isOneOf(g, GENRE_VALUES)) ||
    a.preferredGenres.length > MAX_GENRES
  ) {
    return null;
  }
  if (typeof a.adaptive !== "object" || a.adaptive === null) return null;
  const adaptive = a.adaptive as Record<string, unknown>;
  if (typeof adaptive.category !== "string") return null;
  if (adaptive.value !== null && typeof adaptive.value !== "string") return null;
  // Campos de cache da pergunta adaptativa (opcionais; sessões antigas não têm).
  if (
    adaptive.question !== undefined &&
    (typeof adaptive.question !== "string" ||
      adaptive.question.length === 0 ||
      adaptive.question.length > 200)
  ) {
    return null;
  }
  if (
    adaptive.contextKey !== undefined &&
    (typeof adaptive.contextKey !== "string" ||
      adaptive.contextKey.length === 0 ||
      adaptive.contextKey.length > 160)
  ) {
    return null;
  }
  if (
    adaptive.questionId !== undefined &&
    (typeof adaptive.questionId !== "string" ||
      adaptive.questionId.length === 0 ||
      adaptive.questionId.length > 80)
  ) {
    return null;
  }
  let adaptiveOptions: AdaptiveOption[] | undefined;
  if (adaptive.options !== undefined) {
    if (
      !Array.isArray(adaptive.options) ||
      adaptive.options.length === 0 ||
      adaptive.options.length > 8
    ) {
      return null;
    }
    const clean: AdaptiveOption[] = [];
    for (const option of adaptive.options) {
      if (typeof option !== "object" || option === null) return null;
      const { value, label } = option as Record<string, unknown>;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 60 ||
        typeof label !== "string" ||
        label.length === 0 ||
        label.length > 80
      ) {
        return null;
      }
      clean.push({ value, label });
    }
    adaptiveOptions = clean;
  }
  if (a.commitment !== null && !isOneOf(a.commitment, COMMITMENT_VALUES)) return null;
  if (
    !Array.isArray(a.providers) ||
    a.providers.length === 0 ||
    !a.providers.every((p) => typeof p === "string" && PROVIDER_VALUES.includes(p))
  ) {
    return null;
  }
  if (
    !Array.isArray(a.sessionExcludedGenres) ||
    !a.sessionExcludedGenres.every((g) => isOneOf(g, GENRE_VALUES))
  ) {
    return null;
  }

  return {
    contentType: a.contentType as ContentTypeChoice | null,
    mood: a.mood as MoodKey | null,
    preferredGenres: [...new Set(a.preferredGenres)] as GenreKey[],
      adaptive: {
        category: adaptive.category,
        value: adaptive.value as string | null,
        ...(typeof adaptive.question === "string" ? { question: adaptive.question } : {}),
        ...(adaptiveOptions ? { options: adaptiveOptions } : {}),
        ...(typeof adaptive.contextKey === "string" ? { contextKey: adaptive.contextKey } : {}),
        ...(typeof adaptive.questionId === "string" ? { questionId: adaptive.questionId } : {}),
      },
    commitment: a.commitment as CommitmentKey | null,
    providers: [...new Set(a.providers)] as DiscoveryProvider[],
    sessionExcludedGenres: [],
  };
}

/** Valida sessão lida do localStorage; `null` = corrompida → recomeçar. */
export function parseSession(raw: unknown): DiscoverySession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const session = raw as Record<string, unknown>;
  if (!isValidStep(session.step)) return null;
  const answers = parseAnswers(session.answers);
  if (!answers) return null;

  // Storage legado (pré-Etapa 20) não tem relógio → 0 = expirado.
  const lastActivityAt =
    typeof session.lastActivityAt === "number" &&
    Number.isFinite(session.lastActivityAt) &&
    session.lastActivityAt >= 0
      ? session.lastActivityAt
      : 0;

  return {
    step: session.step,
    answers,
    updatedAt:
      typeof session.updatedAt === "string"
        ? session.updatedAt
        : new Date().toISOString(),
    lastActivityAt,
  };
}

export function serializeSession(
  step: DiscoveryStep,
  answers: DiscoveryAnswers,
  lastActivityAt: number,
): string {
  const session: DiscoverySession = {
    step,
    answers,
    updatedAt: new Date().toISOString(),
    lastActivityAt,
  };
  return JSON.stringify(session);
}

/**
 * TTL de inatividade da sessão de Descoberta (Etapa 20, função pura).
 * Expira quando `now - lastActivityAt >= DISCOVERY_SESSION_TTL_MS`.
 * Relógio ausente/inválido/legado (0) → expirado: resultados antigos
 * nunca ressuscitam. `now` injetável para testes determinísticos.
 */
export function isDiscoverySessionExpired(
  lastActivityAt: unknown,
  now: number = Date.now(),
): boolean {
  if (
    typeof lastActivityAt !== "number" ||
    !Number.isFinite(lastActivityAt) ||
    lastActivityAt <= 0
  ) {
    return true;
  }
  return now - lastActivityAt >= DISCOVERY_SESSION_TTL_MS;
}

/**
 * Fingerprint determinístico do conjunto COMPLETO de respostas.
 * Mudou qualquer resposta → resultado anterior desatualizado.
 * `profileExcluded` (exclusões permanentes, fora das answers por desenho)
 * entra no fingerprint para invalidar caches gerados sob outras exclusões.
 */
export function recommendationContextKey(
  answers: DiscoveryAnswers,
  profileExcluded: GenreKey[] = [],
): string {
  const genres = [...answers.preferredGenres].sort().join(",");
  const providers = [...answers.providers].sort().join(",");
  const excluded = [...answers.sessionExcludedGenres].sort().join(",");
  const permanent = [...profileExcluded].sort().join(",");
  return [
    answers.contentType ?? "",
    answers.mood ?? "",
    genres,
    `${answers.adaptive.category}:${answers.adaptive.value ?? ""}`,
    answers.commitment ?? "",
    providers,
    excluded,
    permanent,
  ].join("|");
}

/**
 * Completude exigida pelos endpoints de recomendação (questionário todo
 * respondido). Replacement reutiliza o mesmo critério.
 */
export function isCompleteAnswers(answers: DiscoveryAnswers): boolean {
  return (
    answers.contentType !== null &&
    answers.mood !== null &&
    answers.commitment !== null &&
    answers.adaptive.value !== null &&
    answers.adaptive.category.length > 0 &&
    answers.providers.length > 0
  );
}

/** Gêneros: alterna; "no preference" (vazio) limpa; respeita o limite. */
export function toggleGenre(
  current: GenreKey[],
  genre: GenreKey | "none",
): { genres: GenreKey[]; limited: boolean } {
  if (genre === "none") return { genres: [], limited: false };
  if (current.includes(genre)) {
    return { genres: current.filter((g) => g !== genre), limited: false };
  }
  if (current.length >= MAX_GENRES) return { genres: current, limited: true };
  return { genres: [...current, genre], limited: false };
}

/** Providers: "any" limpa as demais; sem nenhuma → volta a ["any"]. */
export function toggleProvider(
  current: DiscoveryProvider[],
  provider: DiscoveryProvider,
): DiscoveryProvider[] {
  if (provider === "any") return ["any"];
  const withoutAny = current.filter((p) => p !== "any");
  if (withoutAny.includes(provider)) {
    const next = withoutAny.filter((p) => p !== provider);
    return next.length === 0 ? ["any"] : next;
  }
  return [...withoutAny, provider];
}

export function storageKey(): string {
  return DISCOVERY_STORAGE_KEY;
}

export function seenStorageKey(): string {
  return SEEN_STORAGE_KEY;
}

/** Máximo de IDs recentes guardados (remove os mais antigos). */
export const MAX_SEEN_IDS = 40;

/** Limite da lista excludeIds aceita pelo endpoint. */
export const MAX_EXCLUDE_IDS = 64;

const SEEN_ID_PATTERN = /^(movie|tv):[1-9]\d*$/;

export function isSeenId(value: unknown): value is string {
  return typeof value === "string" && SEEN_ID_PATTERN.test(value);
}

/** Valida refinamento do endpoint; `null` = ausente, nunca lança. Inválido → undefined. */
export function parseRefinement(raw: unknown): RecommendationRefinement | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (isRecommendationRefinement(raw)) return raw;
  return undefined;
}

/** Valida lista de IDs compostos; `null` = inválida. */
export function parseSeenIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_EXCLUDE_IDS) return null;
  if (!raw.every(isSeenId)) return null;
  return [...new Set(raw)];
}

/** Acrescenta IDs (sem duplicar), mantendo só os 40 mais recentes. */
export function addSeenIds(current: string[], ids: string[]): string[] {
  const merged = [...current];
  for (const id of ids) {
    if (!isSeenId(id)) continue;
    const at = merged.indexOf(id);
    if (at !== -1) merged.splice(at, 1);
    merged.push(id);
  }
  return merged.slice(-MAX_SEEN_IDS);
}

export function seenKey(type: string, id: number): string {
  return `${type}:${id}`;
}

/** Máximo de perguntas adaptativas lembradas. */
export const MAX_CATEGORY_HISTORY = 8;

export function categoryHistoryKey(): string {
  return CATEGORY_HISTORY_KEY;
}

/**
 * Valida histórico de perguntas/categorias; `null` = inválido.
 * Aceita IDs do banco ("suspense_style_01") e nomes legados de
 * categoria ("suspense_style").
 */
export function parseQuestionHistory(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (
    !raw.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 80,
    )
  ) {
    return null;
  }
  return [...new Set(raw)].slice(-MAX_CATEGORY_HISTORY);
}

/** Registra pergunta/categoria (sem repetição em sequência). */
export function pushQuestionHistory(history: string[], id: string): string[] {
  const next = history.filter((item) => item !== id);
  next.push(id);
  return next.slice(-MAX_CATEGORY_HISTORY);
}

/** Aliases legados (histórico era só categoria). */
export const parseCategoryHistory = parseQuestionHistory;
export const pushCategoryHistory = pushQuestionHistory;
