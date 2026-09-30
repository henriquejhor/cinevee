/**
 * Mapeamento centralizado: chaves semânticas do questionário → IDs oficiais TMDB.
 *
 * Movie e TV têm taxonomias diferentes (ex.: TV não tem Terror, Romance
 * nem Thriller dedicados). Mapas separados; valores são listas (OR).
 * Lista vazia = sem filtro por aquele gênero (o ranking decide).
 */
import type { GenreKey } from "../../types/discovery";

/** Ação, Aventura, Animação, Comédia, Crime, Documentário, Drama, ... */
export const MOVIE_GENRE_IDS: Record<GenreKey, number[]> = {
  action: [28],
  adventure: [12],
  animation: [16],
  comedy: [35],
  crime: [80],
  documentary: [99],
  drama: [18],
  fantasy: [14],
  horror: [27],
  mystery: [9648],
  romance: [10749],
  science_fiction: [878],
  thriller: [53],
};

export const TV_GENRE_IDS: Record<GenreKey, number[]> = {
  action: [10759],
  adventure: [10759],
  animation: [16],
  comedy: [35],
  crime: [80],
  documentary: [99],
  drama: [18],
  // TV sem Terror dedicado: sem filtro, o ranking decide pelo contexto.
  fantasy: [10765],
  horror: [],
  mystery: [9648],
  // TV sem Romance dedicado: dramas românticos caem em Drama.
  romance: [18],
  science_fiction: [10765],
  // TV sem Thriller dedicado: crime + mistério aproximam o clima.
  thriller: [80, 9648],
};

/** Nomes pt-BR por ID (para contexto do ranking e UI). */
export const MOVIE_GENRE_NAMES: Record<number, string> = {
  28: "Ação",
  12: "Aventura",
  16: "Animação",
  35: "Comédia",
  80: "Crime",
  99: "Documentário",
  18: "Drama",
  10751: "Família",
  14: "Fantasia",
  36: "História",
  27: "Terror",
  10402: "Música",
  9648: "Mistério",
  10749: "Romance",
  878: "Ficção científica",
  10770: "Cinema TV",
  53: "Thriller",
  10752: "Guerra",
  37: "Faroeste",
};

export const TV_GENRE_NAMES: Record<number, string> = {
  10759: "Ação e aventura",
  16: "Animação",
  35: "Comédia",
  80: "Crime",
  99: "Documentário",
  18: "Drama",
  10751: "Família",
  10762: "Infantil",
  9648: "Mistério",
  10763: "Notícias",
  10764: "Reality",
  10765: "Sci-Fi e fantasia",
  10766: "Novela",
  10767: "Talk show",
  10768: "Guerra e política",
  37: "Faroeste",
};

export function genreIdsFor(
  keys: GenreKey[],
  type: "movie" | "tv",
): number[] {
  const map = type === "movie" ? MOVIE_GENRE_IDS : TV_GENRE_IDS;
  const ids = new Set<number>();
  for (const key of keys) {
    for (const id of map[key] ?? []) ids.add(id);
  }
  return [...ids];
}

export function genreNamesFor(
  ids: number[],
  type: "movie" | "tv",
): string[] {
  const map = type === "movie" ? MOVIE_GENRE_NAMES : TV_GENRE_NAMES;
  const names: string[] = [];
  for (const id of ids) {
    const name = map[id];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
