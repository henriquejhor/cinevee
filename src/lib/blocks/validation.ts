/**
 * Validação server-side de block/followers (nunca confiar no browser).
 *
 * Usernames seguem a regra global: ^[a-z0-9_]{3,24}$ (lowercase).
 * Ids: bigint/int positivo (blockId/followId opacos, sem UUID).
 */
export class BlockValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockValidationError";
  }
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const INVALID_USER = "Usuário indisponível.";
const INVALID_ID = "Selecione um item válido.";

/** Normaliza username (trim + lowercase) ou lança 404 genérico. */
export function validateBlockUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new BlockValidationError(INVALID_USER);
  }
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new BlockValidationError(INVALID_USER);
  }
  return username;
}

function validateBigId(value: unknown, label: string): number {
  const id = typeof value === "string" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new BlockValidationError(label);
  }
  return id;
}

export function validateBlockId(value: unknown): number {
  return validateBigId(value, INVALID_ID);
}

export function validateFollowId(value: unknown): number {
  return validateBigId(value, INVALID_ID);
}

/** Valida page/limit de GETs paginados (1..24, default 24). */
export function validateBlocksPage(
  pageRaw: string | null,
  limitRaw: string | null,
  maxLimit: number,
): { page: number; limit: number } | null {
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const limit = limitRaw === null ? maxLimit : Number(limitRaw);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) return null;
  return { page, limit };
}
