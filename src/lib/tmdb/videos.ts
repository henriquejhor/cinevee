/**
 * Trailer da página de detalhes — GET /movie/{id}/videos e /tv/{id}/videos.
 *
 * Server-side only (via `tmdbFetch`): a página recebe apenas a key/nome
 * normalizados. Seleção SOMENTE de vídeos YouTube do tipo "Trailer":
 * oficial primeiro; entre equivalentes, o mais recente. Sem trailer
 * utilizável → `null` (o botão é omitido, sem mensagem).
 *
 * Idioma: tenta pt-BR e, só se não houver trailer aproveitável,
 * faz fallback para en-US (no máximo 2 consultas).
 */
import type { ContentType } from "../../types/content";
import { tmdbFetch } from "./client";
import type { TmdbVideo, TmdbVideosResponse } from "./types";

export interface Trailer {
  key: string;
  name: string;
  site: "YouTube";
  official: boolean;
}

function publishedTime(value?: string): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

/** Melhor "Trailer" YouTube da lista ou `null` (sem Clip/Featurette/etc). */
function pickTrailer(videos: TmdbVideo[]): Trailer | null {
  const candidates = videos.filter(
    (video) =>
      video.site === "YouTube" &&
      video.type === "Trailer" &&
      typeof video.key === "string" &&
      video.key.length > 0,
  );

  candidates.sort(
    (a, b) =>
      Number(b.official) - Number(a.official) ||
      publishedTime(b.published_at) - publishedTime(a.published_at),
  );

  const best = candidates[0];
  if (!best) return null;

  return {
    key: best.key,
    name: best.name || "Trailer",
    site: "YouTube",
    official: best.official === true,
  };
}

/**
 * Retorna o trailer ou `null`. Nunca lança: em falha de rede/TMDB,
 * registra server-side e a página apenas omite o botão.
 */
export async function getTrailer(
  type: ContentType,
  id: number,
): Promise<Trailer | null> {
  const path =
    type === "movie" ? `/movie/${id}/videos` : `/tv/${id}/videos`;

  try {
    const localized = await tmdbFetch<TmdbVideosResponse>(path, {
      params: { language: "pt-BR" },
    });
    const pick = pickTrailer(localized.results ?? []);
    if (pick) return pick;

    const fallback = await tmdbFetch<TmdbVideosResponse>(path, {
      params: { language: "en-US" },
    });
    return pickTrailer(fallback.results ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha nos vídeos ${type}/${id} (${message}).`);
    return null;
  }
}
