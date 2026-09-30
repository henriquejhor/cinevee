/**
 * Validação server-side das preferências (nunca confiar no browser).
 *
 * Allowists derivadas dos catálogos centrais — nenhuma lista duplicada:
 * - gêneros: GENRE_OPTIONS (src/types/discovery.ts);
 * - providers: PROVIDER_OPTIONS (src/types/discovery.ts).
 */
import { GENRE_OPTIONS, PROVIDER_OPTIONS } from "../../types/discovery";
import type { GenreKey } from "../../types/discovery";
import type { StreamingProvider } from "../../types/content";

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_BIO_LENGTH = 160;
export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

const ALLOWED_GENRE_KEYS: readonly string[] = GENRE_OPTIONS.map(
  (option) => option.value,
);

const ALLOWED_PROVIDER_KEYS: readonly string[] = PROVIDER_OPTIONS.map(
  (option) => option.value,
);

export class PreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreferencesValidationError";
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Nome: trim + 1..80 caracteres. */
export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new PreferencesValidationError("Informe um nome válido.");
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new PreferencesValidationError("Informe seu nome.");
  }
  if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new PreferencesValidationError(
      `O nome deve ter no máximo ${MAX_DISPLAY_NAME_LENGTH} caracteres.`,
    );
  }
  return name;
}

function validateKeyArray(
  value: unknown,
  allowed: readonly string[],
  label: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new PreferencesValidationError(`Seleção de ${label} inválida.`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item)) {
      throw new PreferencesValidationError(`Seleção de ${label} inválida.`);
    }
  }
  return dedupe(value as string[]);
}

export function validateExcludedGenres(value: unknown): GenreKey[] {
  return validateKeyArray(value, ALLOWED_GENRE_KEYS, "gêneros") as GenreKey[];
}

export function validateStreamingProviders(
  value: unknown,
): StreamingProvider[] {
  return validateKeyArray(
    value,
    ALLOWED_PROVIDER_KEYS,
    "streamings",
  ) as StreamingProvider[];
}

export class IdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityValidationError";
  }
}

/**
 * Username opcional: vazio/NULL → null (permitido).
 * Quando preenchido: trim + lowercase + 3–24 [a-z0-9_].
 * "JOSE" normaliza para "jose" (depois falha no tamanho mínimo, se for o caso).
 */
export function validateUsername(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new IdentityValidationError("Esse nome de usuário não é válido.");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new IdentityValidationError(
      "Use 3 a 24 caracteres: letras minúsculas, números e _.",
    );
  }
  return normalized;
}

/**
 * Bio opcional: trim server-side; vazia → null; máximo 160.
 * Texto puro — a UI exibe escapado (Astro escapa por padrão).
 */
export function validateBio(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new IdentityValidationError("Essa bio não é válida.");
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_BIO_LENGTH) {
    throw new IdentityValidationError(
      `A bio deve ter no máximo ${MAX_BIO_LENGTH} caracteres.`,
    );
  }
  return trimmed;
}

export interface ValidIdentityInput {
  displayName: string;
  username: string | null;
  bio: string | null;
}

/** Valida o payload de identidade (JSON). Lança IdentityValidationError → 400. */
export function validateIdentityPayload(body: unknown): ValidIdentityInput {
  if (typeof body !== "object" || body === null) {
    throw new IdentityValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  return {
    displayName: validateDisplayName(payload.displayName),
    username: validateUsername(payload.username),
    bio: validateBio(payload.bio),
  };
}

/** Erro amigável de avatar (tipo/tamanho/falha) → 400. */
export class AvatarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarValidationError";
  }
}

export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;
export const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const AVATAR_ERROR_MESSAGE = "Use uma imagem JPG, PNG ou WebP de até 3 MB.";

export interface ValidAvatarUpload {
  file: File;
  mime: string;
  extension: string;
}

/**
 * Valida o arquivo de avatar server-side (nunca confiar no accept="" do input).
 * Checa MIME real + tamanho; extensão derivada do MIME (não da filename).
 */
export function validateAvatarUpload(file: unknown): ValidAvatarUpload {
  if (!(file instanceof File)) {
    throw new AvatarValidationError(AVATAR_ERROR_MESSAGE);
  }
  if (!((ALLOWED_AVATAR_TYPES as readonly string[]).includes(file.type))) {
    throw new AvatarValidationError(AVATAR_ERROR_MESSAGE);
  }
  if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) {
    throw new AvatarValidationError(AVATAR_ERROR_MESSAGE);
  }
  return {
    file,
    mime: file.type,
    extension:
      file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg",
  };
}
export class PrivacyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyValidationError";
  }
}

/** Erro amigável quando falta username para publicar (→ 400 + CTA). */
export class UsernameRequiredError extends Error {
  constructor(
    message = "Crie um @username antes de publicar seu perfil.",
  ) {
    super(message);
    this.name = "UsernameRequiredError";
  }
}

function validatePrivacyFlag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new PrivacyValidationError(`Configuração de ${label} inválida.`);
  }
  return value;
}

export interface ValidPrivacyInput {
  profilePublic: boolean;
  showFavorites: boolean;
  showRecommendations: boolean;
  showWatched: boolean;
  showRatings: boolean;
  showReviews: boolean;
  discoverable: boolean;
  showActivity: boolean;
  allowRatingComments: boolean;
}

/**
 * Valida o payload de privacidade (JSON, só os 9 campos conhecidos —
 * qualquer outro campo é ignorado, nunca persistido).
 * Normaliza: showReviews só vale com showRatings (senão vira false).
 * showActivity é opt-in aditivo (Etapa 17): ausente → false, para não
 * quebrar payloads de 7 campos; presente com tipo errado → 400.
 * allowRatingComments (Etapa 19): ausente → false (cliente antigo de
 * 8 campos continua válido); presente com tipo errado → 400.
 */
export function validatePrivacyPayload(body: unknown): ValidPrivacyInput {
  if (typeof body !== "object" || body === null) {
    throw new PrivacyValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  const showRatings = validatePrivacyFlag(payload.showRatings, "avaliações");
  const showReviews = validatePrivacyFlag(payload.showReviews, "opiniões");
  return {
    profilePublic: validatePrivacyFlag(payload.profilePublic, "perfil público"),
    showFavorites: validatePrivacyFlag(payload.showFavorites, "favoritos"),
    showRecommendations: validatePrivacyFlag(
      payload.showRecommendations,
      "recomendações",
    ),
    showWatched: validatePrivacyFlag(payload.showWatched, "assistidos"),
    showRatings,
    // Opiniões sem avaliações não fazem sentido: normaliza para false
    // (em vez de rejeitar, para o toggle da UI salvar sem erro).
    showReviews: showRatings ? showReviews : false,
    discoverable: validatePrivacyFlag(payload.discoverable, "busca de pessoas"),
    showActivity:
      payload.showActivity === undefined
        ? false
        : validatePrivacyFlag(payload.showActivity, "atividades no feed"),
    allowRatingComments:
      payload.allowRatingComments === undefined
        ? false
        : validatePrivacyFlag(
            payload.allowRatingComments,
            "comentários nas avaliações",
          ),
  };
}

export interface ValidPreferencesInput {
  displayName: string;
  excludedGenres: GenreKey[];
  streamingProviders: StreamingProvider[];
}

/** Valida o payload da API (JSON). Lança PreferencesValidationError → 400. */
export function validatePreferencesPayload(body: unknown): ValidPreferencesInput {
  if (typeof body !== "object" || body === null) {
    throw new PreferencesValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  return {
    displayName: validateDisplayName(payload.displayName),
    excludedGenres: validateExcludedGenres(payload.excludedGenres),
    streamingProviders: validateStreamingProviders(
      payload.streamingProviders,
    ),
  };
}
