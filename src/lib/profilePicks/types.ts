/**
 * Tipos das seleções do Sobre (Etapa 13): favoritos + recomendações.
 *
 * Desacoplados da linha raw do Supabase: componentes consomem
 * `ProfilePick` (camelCase), nunca o shape snake_case.
 * title/poster/year são SNAPSHOTS factuais extraídos do TMDB no backend
 * (o browser nunca fornece esses campos) — igual a watchlist/watched.
 */
import type { ContentType } from "../../types/content";

export type ProfilePickKind = "favorite" | "recommendation";

export const FAVORITE_LIMIT = 12;
export const RECOMMENDATION_LIMIT = 6;
export const RECOMMENDATION_NOTE_MAX = 500;

export function pickLimitFor(kind: ProfilePickKind): number {
  return kind === "favorite" ? FAVORITE_LIMIT : RECOMMENDATION_LIMIT;
}

export interface ProfilePick {
  id: string;
  tmdbId: number;
  mediaType: ContentType;
  kind: ProfilePickKind;
  title: string;
  posterPath: string | null;
  year?: number;
  /** Só recommendation tem nota (texto puro). Favorite → sempre null. */
  note: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/profile/picks — adicionar à seção. */
export interface AddPickInput {
  tmdbId: number;
  mediaType: ContentType;
  kind: ProfilePickKind;
  /** Obrigatória só para recommendation (1–500 após trim). */
  note?: string | null;
}

/** PATCH op=note — editar a justificativa (só recommendation). */
export interface UpdatePickNoteInput {
  id: string;
  note: string;
}

/** PATCH op=reorder — ordem manual completa da seção. */
export interface ReorderPicksInput {
  kind: ProfilePickKind;
  /** Ids (uuid) na nova ordem, do primeiro ao último. */
  orderedIds: string[];
}

/** DELETE /api/profile/picks — remover da seção (só aquele kind). */
export interface RemovePickInput {
  id: string;
}
