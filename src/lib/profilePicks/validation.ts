/**
 * Validação server-side das seleções do Sobre (nunca confiar no browser).
 * POST aceita SOMENTE { tmdbId, mediaType, kind, note? } — title/poster/
 * year vindos do browser são ignorados; o backend extrai do TMDB.
 * PATCH aceita { op: "note", id, note } ou { op: "reorder", kind, orderedIds }.
 * DELETE aceita { id } (uuid da pick).
 */
import type { ContentType } from "../../types/content";
import {
  RECOMMENDATION_NOTE_MAX,
  type AddPickInput,
  type ProfilePickKind,
  type RemovePickInput,
  type ReorderPicksInput,
  type UpdatePickNoteInput,
} from "./types";

export class ProfilePicksValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilePicksValidationError";
  }
}

const TITLE_ERROR = "Título inválido.";
const KIND_ERROR = "Seção inválida.";
const NOTE_REQUIRED = "Conte por que você recomenda este título.";
const NOTE_TOO_LONG = `Sua recomendação deve ter no máximo ${RECOMMENDATION_NOTE_MAX} caracteres.`;
const ID_ERROR = "Seleção inválida.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateTitleKey(body: Record<string, unknown>): {
  tmdbId: number;
  mediaType: ContentType;
} {
  const { tmdbId, mediaType } = body;

  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId <= 0
  ) {
    throw new ProfilePicksValidationError(TITLE_ERROR);
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new ProfilePicksValidationError(TITLE_ERROR);
  }

  return { tmdbId, mediaType: mediaType as ContentType };
}

function validateKind(value: unknown): ProfilePickKind {
  if (value !== "favorite" && value !== "recommendation") {
    throw new ProfilePicksValidationError(KIND_ERROR);
  }
  return value;
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ProfilePicksValidationError(ID_ERROR);
  }
  return value;
}

/**
 * Normaliza a nota da recomendação: trim, texto puro 1–500.
 * Nunca trunca silenciosamente: vazio ou >500 lança erro (→ 400).
 */
export function normalizePickNote(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProfilePicksValidationError(NOTE_REQUIRED);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProfilePicksValidationError(NOTE_REQUIRED);
  }
  if (trimmed.length > RECOMMENDATION_NOTE_MAX) {
    throw new ProfilePicksValidationError(NOTE_TOO_LONG);
  }
  return trimmed;
}

/** { tmdbId, mediaType, kind, note? } — usada no POST (adicionar). */
export function validateAddPickInput(body: unknown): AddPickInput {
  if (typeof body !== "object" || body === null) {
    throw new ProfilePicksValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  const key = validateTitleKey(payload);
  const kind = validateKind(payload.kind);

  // Favorito nunca tem nota (o browser nem precisa enviar; se enviar,
  // é ignorado — a coluna fica NULL por regra de kind).
  if (kind === "favorite") {
    return { ...key, kind };
  }

  // Recommendation exige justificativa não vazia após trim.
  if (!("note" in payload) || payload.note === undefined || payload.note === null) {
    throw new ProfilePicksValidationError(NOTE_REQUIRED);
  }
  return { ...key, kind, note: normalizePickNote(payload.note) };
}

/** { op: "note", id, note } — usada no PATCH (editar justificativa). */
export function validateUpdatePickNoteInput(body: unknown): UpdatePickNoteInput {
  if (typeof body !== "object" || body === null) {
    throw new ProfilePicksValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  if (payload.op !== "note") {
    throw new ProfilePicksValidationError("Dados inválidos.");
  }
  const id = validateId(payload.id);
  if (!("note" in payload) || payload.note === undefined || payload.note === null) {
    throw new ProfilePicksValidationError(NOTE_REQUIRED);
  }
  return { id, note: normalizePickNote(payload.note) };
}

/** { op: "reorder", kind, orderedIds } — usada no PATCH (ordem manual). */
export function validateReorderPicksInput(body: unknown): ReorderPicksInput {
  if (typeof body !== "object" || body === null) {
    throw new ProfilePicksValidationError("Dados inválidos.");
  }
  const payload = body as Record<string, unknown>;
  if (payload.op !== "reorder") {
    throw new ProfilePicksValidationError("Dados inválidos.");
  }
  const kind = validateKind(payload.kind);
  const { orderedIds } = payload;

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new ProfilePicksValidationError("Ordem inválida.");
  }
  // Teto = maior limite (12): array arbitrário gigante é rejeitado.
  if (orderedIds.length > 12) {
    throw new ProfilePicksValidationError("Ordem inválida.");
  }
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const valid = validateId(id);
    if (seen.has(valid)) {
      throw new ProfilePicksValidationError("Ordem inválida.");
    }
    seen.add(valid);
  }

  return { kind, orderedIds: [...seen] };
}

/** { id } — usada no DELETE (remover da seção). */
export function validateRemovePickInput(body: unknown): RemovePickInput {
  if (typeof body !== "object" || body === null) {
    throw new ProfilePicksValidationError("Dados inválidos.");
  }
  return { id: validateId((body as Record<string, unknown>).id) };
}
