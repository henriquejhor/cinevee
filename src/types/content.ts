export type ContentType = "movie" | "tv";

export type StreamingProvider = "netflix" | "prime" | "disney" | "max";

export interface ContentItem {
  id: number;
  type: ContentType;
  title: string;
  year?: number;
  rating?: number;
  /** URL do pôster real (TMDB). Ausente → placeholder atual. */
  posterUrl?: string;
  /** URL do backdrop real (TMDB). Só preenchido onde necessário (ex.: recomendação principal). */
  backdropUrl?: string;
  /** Nomes de gêneros pt-BR. Só preenchido onde necessário (ex.: recomendações). */
  genres?: string[];
  /** Gradiente decorativo do placeholder (índice da paleta). */
  hue: number;
  provider?: StreamingProvider;
}

export const PROVIDER_LABELS: Record<StreamingProvider, string> = {
  netflix: "Netflix",
  prime: "Prime",
  disney: "Disney+",
  max: "Max",
};
