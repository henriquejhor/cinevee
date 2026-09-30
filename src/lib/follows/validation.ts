/**
 * Validação server-side do alvo de follow (nunca confiar no browser).
 * O body aceita SOMENTE { username } — follower_id nunca vem do client
 * (o servidor usa auth.uid()). Mesma regra de usernames do produto
 * (lowercase, 3–24, a-z0-9_), sem criar segunda regra.
 */
import { USERNAME_PATTERN } from "../profile/validation";
import type { FollowTargetInput } from "./types";

export class FollowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowValidationError";
  }
}

/** { username } — usada no POST, DELETE e GET state. */
export function validateFollowTarget(body: unknown): FollowTargetInput {
  if (typeof body !== "object" || body === null) {
    throw new FollowValidationError("Dados inválidos.");
  }
  const { username } = body as Record<string, unknown>;
  if (typeof username !== "string") {
    throw new FollowValidationError("Perfil inválido.");
  }
  const normalized = username.trim().toLowerCase().replace(/^@/, "");
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new FollowValidationError("Perfil inválido.");
  }
  return { username: normalized };
}
