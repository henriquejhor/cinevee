/**
 * Disponibilidade por título — página de detalhes (server-side).
 *
 * - GET /movie/{id}/watch/providers
 * - GET /tv/{id}/watch/providers
 *
 * Seleciona SOMENTE `results.BR`. A UI consome `WatchAvailability`
 * (estrutura interna), nunca a resposta bruta do TMDB.
 */
import type { ContentType } from "../../types/content";
import { tmdbFetch } from "./client";
import { buildLogoUrl } from "./image";
import { TMDB_WATCH_REGION } from "./providers";
import type {
  TmdbWatchProvidersResponse,
  TmdbWatchProviderEntry,
} from "./types";

export interface WatchProvider {
  id: number;
  name: string;
  logoUrl?: string;
}

export interface WatchAvailability {
  /** Link genérico de opções de reprodução (NÃO é deep link do streaming). */
  link?: string;
  /** Assinatura (flatrate) — categoria prioritária na UI. */
  flatrate: WatchProvider[];
  /** Grátis (free). */
  free: WatchProvider[];
  /** Grátis com anúncios (ads). */
  ads: WatchProvider[];
  /** Aluguel (rent) — secundário. */
  rent: WatchProvider[];
  /** Compra (buy) — secundário. */
  buy: WatchProvider[];
}

function normalizeEntry(entry: TmdbWatchProviderEntry): WatchProvider {
  const provider: WatchProvider = {
    id: entry.provider_id,
    name: entry.provider_name,
  };
  const logoUrl = buildLogoUrl(entry.logo_path);
  if (logoUrl) provider.logoUrl = logoUrl;
  return provider;
}

/**
 * Retorna a disponibilidade no Brasil ou `null` quando não há dados BR.
 * Lança erro em falha de rede/TMDB — a página de detalhes captura e
 * exibe "Disponibilidade indisponível no momento." sem quebrar.
 */
export async function getWatchProviders(
  type: ContentType,
  id: number,
): Promise<WatchAvailability | null> {
  const path = type === "movie" ? `/movie/${id}/watch/providers` : `/tv/${id}/watch/providers`;
  const data = await tmdbFetch<TmdbWatchProvidersResponse>(path, {
    params: { language: "pt-BR" },
  });

  const region = data.results?.[TMDB_WATCH_REGION];
  if (!region) return null;

  const availability: WatchAvailability = {
    flatrate: (region.flatrate ?? []).map(normalizeEntry),
    free: (region.free ?? []).map(normalizeEntry),
    ads: (region.ads ?? []).map(normalizeEntry),
    rent: (region.rent ?? []).map(normalizeEntry),
    buy: (region.buy ?? []).map(normalizeEntry),
  };
  if (region.link) availability.link = region.link;

  return availability;
}
