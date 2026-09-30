/**
 * TasteProfile — lógica PURA de personalização (Etapa 8).
 *
 * SEM dependências de runtime (só `import type`): importável tanto pelo
 * bundle Astro quanto direto pelo Node (type stripping) no
 * `verify:personalization`. Nenhum fetch, nenhum Supabase, nenhum segredo.
 *
 * Semântica:
 * - ratings são SOFT SIGNALS (5→+2, 4→+1, 3→0, 2→-1, 1→-2 por gênero);
 * - watched sem rating exclui o título exato, sem inferir gosto;
 * - signals de gênero exigem evidência >= 2 (nunca 1 título só);
 * - bônus local limitado a ±0.5 (sessão >> histórico);
 * - sessão explícita vence histórico negativo (session wins).
 */
import type { ContentType } from "../../types/content";
import type { GenreKey } from "../../types/discovery";

export interface TasteGenreSignal {
  genre: GenreKey;
  score: number;
  /** Títulos com peso ≠ 0 que sustentam o sinal. */
  evidence: number;
}

export interface TasteTitleExample {
  tmdbId: number;
  mediaType: ContentType;
  title: string;
  year?: number;
  genres: GenreKey[];
  rating: number;
}

export interface TasteProfile {
  ratedCount: number;
  positiveGenres: TasteGenreSignal[];
  negativeGenres: TasteGenreSignal[];
  likedExamples: TasteTitleExample[];
  dislikedExamples: TasteTitleExample[];
  /** Versão opaca p/ invalidar cache (`v1:w…:r…:u…` ou `v1:anon`). */
  version: string;
}

/** Rating enriquecido com gêneros reais do TMDB (amostra pequena). */
export interface EnrichedRating {
  tmdbId: number;
  mediaType: ContentType;
  rating: number;
  title: string;
  year?: number;
  genres: GenreKey[];
  updatedAt: string;
}

/** Peso de cada nota na soma por gênero (3 = neutro). */
export function ratingGenreWeight(rating: number): number {
  if (rating >= 5) return 2;
  if (rating === 4) return 1;
  if (rating === 3) return 0;
  if (rating === 2) return -1;
  return -2;
}

/** Evidência mínima para um signal de gênero existir. */
export const TASTE_SIGNAL_MIN_EVIDENCE = 2;
/** |score| mínimo (com evidência) para virar signal. */
export const TASTE_SIGNAL_MIN_SCORE = 2;
/** Teto de exemplos enviados ao AI (prompt compacto). */
export const MAX_LIKED_EXAMPLES = 6;
export const MAX_DISLIKED_EXAMPLES = 4;
/** Teto de títulos enriquecidos via TMDB por recomendação. */
export const MAX_ENRICH_TITLES = 10;
/** Bônus/penalidade local por gênero (|x| << sinal explícito da sessão). */
export const TASTE_LOCAL_BONUS = 0.5;

function compareSignals(a: TasteGenreSignal, b: TasteGenreSignal): number {
  const byScore = Math.abs(b.score) - Math.abs(a.score);
  if (byScore !== 0) return byScore;
  return b.evidence - a.evidence;
}

/**
 * Soma pesos por gênero e filtra signals com evidência suficiente.
 * Entrada: ratings enriquecidos (gêneros reais do TMDB).
 */
export function scoreGenreSignals(
  items: { genres: GenreKey[]; rating: number }[],
): { positive: TasteGenreSignal[]; negative: TasteGenreSignal[] } {
  const acc = new Map<GenreKey, { score: number; evidence: number }>();
  for (const item of items) {
    const weight = ratingGenreWeight(item.rating);
    if (weight === 0) continue;
    for (const genre of new Set(item.genres)) {
      const entry = acc.get(genre) ?? { score: 0, evidence: 0 };
      entry.score += weight;
      entry.evidence += 1;
      acc.set(genre, entry);
    }
  }
  const positive: TasteGenreSignal[] = [];
  const negative: TasteGenreSignal[] = [];
  for (const [genre, { score, evidence }] of acc) {
    if (evidence < TASTE_SIGNAL_MIN_EVIDENCE) continue;
    if (score >= TASTE_SIGNAL_MIN_SCORE) {
      positive.push({ genre, score, evidence });
    } else if (score <= -TASTE_SIGNAL_MIN_SCORE) {
      negative.push({ genre, score, evidence });
    }
  }
  positive.sort(compareSignals);
  negative.sort(compareSignals);
  return { positive, negative };
}

/**
 * Seleciona exemplos: 5s antes de 4s (até 6); 1s antes de 2s (até 4).
 * Desempate: mais recente primeiro.
 */
export function selectTasteExamples(items: EnrichedRating[]): {
  liked: TasteTitleExample[];
  disliked: TasteTitleExample[];
} {
  const toExample = (item: EnrichedRating): TasteTitleExample => ({
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
    title: item.title,
    ...(item.year !== undefined ? { year: item.year } : {}),
    genres: [...item.genres],
    rating: item.rating,
  });
  const liked = items
    .filter((item) => item.rating >= 4)
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0),
    )
    .slice(0, MAX_LIKED_EXAMPLES)
    .map(toExample);
  const disliked = items
    .filter((item) => item.rating <= 2)
    .sort(
      (a, b) =>
        a.rating - b.rating ||
        (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0),
    )
    .slice(0, MAX_DISLIKED_EXAMPLES)
    .map(toExample);
  return { liked, disliked };
}

/** Monta o TasteProfile a partir da contagem total + amostra enriquecida. */
export function buildTasteProfile(input: {
  ratedCount: number;
  version: string;
  enriched: EnrichedRating[];
}): TasteProfile {
  const { positive, negative } = scoreGenreSignals(input.enriched);
  const { liked, disliked } = selectTasteExamples(input.enriched);
  return {
    ratedCount: input.ratedCount,
    positiveGenres: positive,
    negativeGenres: negative,
    likedExamples: liked,
    dislikedExamples: disliked,
    version: input.version,
  };
}

/** TasteProfile vazio (deslogado, sem ratings ou falha best-effort). */
export function emptyTasteProfile(version: string): TasteProfile {
  return {
    ratedCount: 0,
    positiveGenres: [],
    negativeGenres: [],
    likedExamples: [],
    dislikedExamples: [],
    version,
  };
}

/** Versão opaca e determinística do histórico (p/ invalidar cache). */
export function tasteVersion(
  watchedCount: number,
  ratedCount: number,
  updatedAtList: string[],
): string {
  return `v1:w${watchedCount}:r${ratedCount}:u${hashStringList(updatedAtList)}`;
}

/**
 * Hash curto e determinístico (FNV-1a, hex) de uma lista de `updated_at`.
 * Qualquer edição/remoção/adição dentro da amostra muda a versão — evita
 * a armadilha de observar só o MAX(updated_at).
 */
export function hashStringList(parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Versão para visitante deslogado (sem histórico). */
export const ANON_TASTE_VERSION = "v1:anon";

/** Chave de identidade `mediaType:tmdbId` (exclusão watched + dedupe). */
export function watchedKey(mediaType: string, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

/** União com dedupe (watched persistente + recentlySeen da request). */
export function mergeIdLists(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

/**
 * Gêneros negativos EFETIVOS: a sessão explícita vence o histórico.
 * Se o usuário pediu romance HOJE, romance sai da penalidade (mas pode
 * continuar fora do bônus — o histórico só desempata dentro do pedido).
 */
export function resolveTastePenaltyGenres(
  sessionGenres: GenreKey[],
  negative: TasteGenreSignal[],
): GenreKey[] {
  const session = new Set(sessionGenres);
  return negative.map((s) => s.genre).filter((genre) => !session.has(genre));
}

/**
 * Bônus local por candidato, limitado a ±TASTE_LOCAL_BONUS.
 * Positivo soma mesmo com sessão; negativo NÃO penaliza gênero que a
 * sessão pediu explicitamente (session wins).
 */
export function localTasteBonus(
  candidateLabels: string[],
  sessionLabels: string[],
  positiveLabels: string[],
  negativeLabels: string[],
): number {
  const candidate = new Set(candidateLabels);
  const session = new Set(sessionLabels);
  let bonus = 0;
  if (positiveLabels.some((label) => candidate.has(label))) {
    bonus += TASTE_LOCAL_BONUS;
  }
  if (
    negativeLabels.some((label) => candidate.has(label)) &&
    ![...candidate].some((label) => session.has(label))
  ) {
    bonus -= TASTE_LOCAL_BONUS;
  }
  return Math.max(-TASTE_LOCAL_BONUS, Math.min(TASTE_LOCAL_BONUS, bonus));
}

/** Linha de exemplo para o prompt ("Título" (ano, Gêneros) ★5). */
function exampleLine(
  example: TasteTitleExample,
  labelFor: (genre: GenreKey) => string,
): string {
  const genres = example.genres.map(labelFor).filter(Boolean).join(", ");
  const year = example.year !== undefined ? ` (${example.year})` : "";
  const genrePart = genres ? `, ${genres}` : "";
  return `"${example.title}"${year}${genrePart} ★${example.rating}`;
}

/**
 * Bloco compacto de gosto histórico para o prompt (Groq/Gemini).
 * Vazio quando não há evidência — o caller omite a seção.
 * Contém SÓ gêneros/títulos/notas: nenhum PII, nenhum user_id.
 */
export function formatTasteForPrompt(
  taste: TasteProfile,
  labelFor: (genre: GenreKey) => string,
): string {
  if (taste.ratedCount === 0) return "";
  const lines: string[] = [];
  if (taste.positiveGenres.length > 0) {
    lines.push(
      `Gêneros que costuma avaliar bem: ${taste.positiveGenres.map((s) => labelFor(s.genre)).filter(Boolean).join(", ")}`,
    );
  }
  if (taste.negativeGenres.length > 0) {
    lines.push(
      `Gêneros que costuma avaliar mal: ${taste.negativeGenres.map((s) => labelFor(s.genre)).filter(Boolean).join(", ")}`,
    );
  }
  if (taste.likedExamples.length > 0) {
    lines.push(
      `Exemplos bem avaliados: ${taste.likedExamples.map((e) => exampleLine(e, labelFor)).join("; ")}`,
    );
  }
  if (taste.dislikedExamples.length > 0) {
    lines.push(
      `Exemplos mal avaliados: ${taste.dislikedExamples.map((e) => exampleLine(e, labelFor)).join("; ")}`,
    );
  }
  if (lines.length === 0) return "";
  return [
    "Gosto histórico do usuário (sinal SECUNDÁRIO — a intenção da sessão acima prevalece sempre):",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

/**
 * Regras de prioridade histórica (sufixo do system prompt, Groq e Gemini).
 * Sessão vence histórico; profile vence tudo; reasons agregadas e discretas.
 */
export const TASTE_RANK_RULES = [
  "PRIORIDADE DE PERSONALIZAÇÃO: 1. respeite restrições e exclusões; 2. atenda a intenção da sessão atual — ela SEMPRE vence o gosto histórico; 3. use o gosto histórico SÓ como desempate secundário entre candidatos já adequados.",
  "se a sessão pedir explicitamente um gênero ou tema, NÃO penalize candidatos dele por causa do histórico — escolha o melhor exemplar dentro do pedido.",
  "o histórico nunca cria exclusão: só as exclusões declaradas removem candidatos (o pool já veio filtrado).",
  "reasons podem mencionar gosto agregado SOMENTE com evidência indicada (ex.: «combina com os suspenses que você costuma avaliar bem»); nunca cite títulos específicos do histórico nem notas («você deu 5 estrelas para X»); nunca destaque gostos negativos («como você odeia romance»).",
].join("\n");
