/**
 * Provider Groq (PRIMÁRIO) — pergunta adaptativa + ranking.
 *
 * - Prompts reaproveitam a semântica dos atuais (`src/lib/gemini/`);
 *   adaptados só no necessário (schema strict exige tudo em `required`).
 * - A Groq NUNCA inventa options: adaptativa retorna só questionId/wording
 *   dentro do contrato atual; ranking retorna só id/type/reason.
 * - Ranking = UMA chamada (4 picks + reasons), nunca uma por filme.
 * - Payload TMDB compacto: id/type/title/year/genres/overview curta/
 *   rating/voteCount/popularity.
 * - Qualquer falha lança erro → `provider.ts` cai para Gemini, depois local.
 */
import type { DiscoveryAnswers } from "../../types/discovery";
import { GENRE_OPTIONS } from "../../types/discovery";
import type { RecommendationRefinement } from "../../types/discovery";
import type { RecommendationCandidate } from "../discovery/candidates";
import {
  REFINEMENT_REASON_RULE,
  refinementUserLine,
} from "../discovery/refinement";
import {
  formatTasteForPrompt,
  TASTE_RANK_RULES,
  type TasteProfile,
} from "../personalization/taste";
import { ADAPTIVE_TIMEOUT_MS, RANK_TIMEOUT_MS } from "./config";
import { groqChatJson } from "./groqClient";
import {
  BANK_CATEGORY_OPTIONS,
  buildShortlist,
  type AdaptiveQuestionDefinition,
} from "../gemini/adaptiveBank";
import {
  SHORTLIST_LIMIT,
  type AdaptiveCategory,
  type AdaptiveContext,
  type AdaptivePick,
} from "../gemini/adaptiveQuestion";
import {
  applyPicks,
  MAX_RECOMMENDATIONS,
  MIN_REASON_LENGTH,
  summarizeDiscoveryAnswers,
  trimReason,
  type Recommendation,
} from "../gemini/rankRecommendations";

// ---------------------------------------------------------------------------
// Pergunta adaptativa
// ---------------------------------------------------------------------------

const ADAPTIVE_SYSTEM = [
  "Você ajuda o CineVee a escolher a próxima pergunta de um questionário de recomendação de filmes e séries.",
  "O usuário já respondeu tipo de conteúdo, sensação e gêneros.",
  "Você recebe uma SHORTLIST de perguntas candidatas (id + texto). Escolha o id da pergunta que fornece a informação adicional mais útil para melhorar a recomendação.",
  "Retorne questionId EXATAMENTE como está na shortlist. Nunca invente ids.",
  "Você pode ajustar levemente o texto em 'wording' (pt-BR natural, curto); se omitido, usamos o texto original. Nunca crie novas opções.",
  "Regras:",
  "- não repetir algo que já sabemos (tipo, sensação, gêneros);",
  "- considerar contentType, mood e preferredGenres;",
  "- respeitar excludedGenres;",
  "- nunca escolher pergunta centrada em um gênero de excludedGenres;",
  "- não perguntar sobre streaming (virá depois);",
  "- não perguntar sobre duração (virá depois);",
  "- não mencionar IA ou modelo;",
  "- não prometer recomendação.",
].join("\n");

const ADAPTIVE_SCHEMA = {
  type: "object",
  properties: {
    questionId: { type: "string" },
    wording: { type: "string" },
  },
  required: ["questionId", "wording"],
  additionalProperties: false,
} as Record<string, unknown>;

const QUESTION_MIN_LENGTH = 8;
const QUESTION_MAX_LENGTH = 140;

function cleanWording(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length < QUESTION_MIN_LENGTH || trimmed.length > QUESTION_MAX_LENGTH) {
    return fallback;
  }
  return trimmed;
}

function parseAdaptivePick(
  rawText: string,
  shortlist: AdaptiveQuestionDefinition[],
): AdaptivePick {
  const parsed: unknown = JSON.parse(rawText);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("resposta não é objeto");
  }
  const { questionId, wording } = parsed as Record<string, unknown>;
  if (typeof questionId !== "string") {
    throw new Error("questionId ausente");
  }
  const definition = shortlist.find((entry) => entry.id === questionId);
  if (!definition) {
    throw new Error(`questionId fora da shortlist: ${questionId}`);
  }
  if (!BANK_CATEGORY_OPTIONS[definition.category]) {
    throw new Error(`categoria inválida: ${definition.category}`);
  }
  return {
    questionId: definition.id,
    category: definition.category as AdaptiveCategory,
    question: cleanWording(wording, definition.question),
  };
}

export async function chooseAdaptiveQuestionGroq(
  context: AdaptiveContext,
  recentQuestionIds: string[] = [],
  recentCategories: AdaptiveCategory[] = [],
): Promise<AdaptivePick> {
  const shortlist = buildShortlist(
    {
      contentType: context.contentType,
      mood: context.mood,
      preferredGenres: [...context.preferredGenres],
      excludedGenres: [...context.excludedGenres],
    },
    recentQuestionIds,
    recentCategories,
    SHORTLIST_LIMIT,
  );
  if (shortlist.length === 0) {
    throw new Error("shortlist vazia");
  }
  const payload: Record<string, unknown> = {
    contentType: context.contentType,
    mood: context.mood,
    preferredGenres: context.preferredGenres,
    excludedGenres: context.excludedGenres,
    shortlist: shortlist.map((entry) => ({ id: entry.id, question: entry.question })),
  };
  if (recentCategories.length > 0) {
    payload.recentCategories = recentCategories;
    payload.recentCategoriesNote =
      "Categorias perguntadas recentemente neste aparelho. Prefira perguntas de outras categorias se forem igualmente úteis; só repita categoria se for claramente a mais útil.";
  }
  const raw = await groqChatJson({
    system: ADAPTIVE_SYSTEM,
    user: JSON.stringify(payload),
    schemaName: "adaptive_pick",
    schema: ADAPTIVE_SCHEMA,
    timeoutMs: ADAPTIVE_TIMEOUT_MS,
    maxTokens: 150,
  });
  return parseAdaptivePick(raw, shortlist);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const RANK_SYSTEM = [
  "Você escolhe recomendações de filmes e séries para o CineVee.",
  "Você recebe as preferências do usuário e uma lista FECHADA de candidatos reais (com sinopse, nota e votos).",
  "Regras obrigatórias:",
  "- retorne SOMENTE ids presentes na lista, com o type correspondente;",
  "- no máximo 4 recomendações, ordenadas da mais compatível para a menos;",
  "- sem repetidos; sem inventar títulos, anos, notas ou qualquer dado factual;",
  "- cada reason: 1–2 frases em pt-BR, aproximadamente 100–220 caracteres;",
  "- cada reason referencia EXPLICITAMENTE pelo menos 2 sinais do usuário (ex.: sensação + gênero, foco adaptativo + envolvimento, tipo + clima);",
  "- use pelo menos 1 aspecto do candidato (gênero, sinopse, título, ano, nota) para ancorar a justificativa;",
  "- varie a construção entre os itens: comece um pelo clima, outro pelo título ou gênero, outro pela escolha adaptativa, outro pela intensidade — nunca repita a abertura;",
  "- varie o foco entre os itens (clima, narrativa, gênero, intensidade);",
  "- nunca repita a mesma frase-base em dois itens;",
  "- nota/votos/popularidade só como complemento, nunca como justificativa principal;",
  "- não cite plataforma/streaming salvo se decisivo para a escolha;",
  "- não cite fatos que não estejam nos dados (diretor, elenco, prêmios);",
  "- não mencione IA, modelo ou algoritmo;",
  "- não prometa nada além da compatibilidade com o momento.",
].join("\n");

const RANK_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      minItems: 1,
      maxItems: MAX_RECOMMENDATIONS,
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          type: { type: "string", enum: ["movie", "tv"] },
          reason: { type: "string" },
        },
        required: ["id", "type", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["recommendations"],
  additionalProperties: false,
} as Record<string, unknown>;

interface GroqRankPick {
  id: number;
  type: string;
  reason: string;
}

function parseRankPicks(rawText: string): GroqRankPick[] {
  const parsed: unknown = JSON.parse(rawText);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("resposta não é objeto");
  }
  const list = (parsed as Record<string, unknown>).recommendations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("sem recomendações");
  }
  const picks: GroqRankPick[] = [];
  for (const entry of list.slice(0, MAX_RECOMMENDATIONS + 2)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, type, reason } = entry as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    if (type !== "movie" && type !== "tv") continue;
    if (typeof reason !== "string" || trimReason(reason).length < MIN_REASON_LENGTH) continue;
    picks.push({ id, type, reason: trimReason(reason) });
  }
  if (picks.length === 0) throw new Error("nenhum pick válido");
  return picks;
}

/** Label pt-BR de GenreKey para o bloco de gosto histórico. */
function tasteGenreLabel(genre: string): string {
  return GENRE_OPTIONS.find((o) => o.value === genre)?.label ?? genre;
}

/** Linha compacta por candidato (sem sinopses enormes, sem dados inúteis). */
function candidateLine(candidate: RecommendationCandidate): string {
  const compact = {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    year: candidate.year ?? null,
    genres: candidate.genres,
    overview: candidate.overview.slice(0, 140),
    rating: candidate.rating ?? null,
    voteCount: candidate.voteCount ?? null,
    popularity:
      candidate.popularity !== undefined ? Math.round(candidate.popularity * 10) / 10 : null,
  };
  return JSON.stringify(compact);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 400 transitório do strict mode (`json_validate_failed`): vale 1 retry imediato. */
function isJsonValidateFailed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 400.*json_validate_failed/i.test(message);
}

/** 429: vale 1 retry após a espera sugerida (limitada para caber no timeout). */
function retryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/HTTP 429\b/);
  if (!status) return null;
  const hint = message.match(/retry_after=([\d.]+)/);
  const suggested = hint ? Math.ceil(Number(hint[1]) * 1000) : 8000;
  if (!Number.isFinite(suggested) || suggested <= 0) return 8000;
  return Math.min(suggested + 500, 8000);
}

export async function rankWithGroq(
  answers: DiscoveryAnswers,
  candidates: RecommendationCandidate[],
  refinement: RecommendationRefinement | null = null,
  taste: TasteProfile | null = null,
): Promise<Recommendation[]> {
  const lines = [
    "Preferências do usuário:",
    summarizeDiscoveryAnswers(answers),
  ];
  if (refinement) lines.push(refinementUserLine(refinement));
  // Gosto histórico compacto (só gêneros/títulos/notas — sem PII).
  // Omitido quando vazio: sessão sem histórico comporta-se como antes.
  const tasteBlock = taste ? formatTasteForPrompt(taste, tasteGenreLabel) : "";
  if (tasteBlock) lines.push("", tasteBlock);
  const system = [
    refinement ? `${RANK_SYSTEM}\n${REFINEMENT_REASON_RULE}` : RANK_SYSTEM,
    ...(tasteBlock ? [TASTE_RANK_RULES] : []),
  ].join("\n");
  const userMessage = [
    ...lines,
    "",
    `Candidatos (escolha até ${MAX_RECOMMENDATIONS}):`,
    ...candidates.map((c) => candidateLine(c)),
  ].join("\n");

  const payload = {
    system,
    user: userMessage,
    schemaName: "rank_recommendations",
    schema: RANK_SCHEMA,
    maxTokens: 1000,
  };
  // Teto total da etapa (tentativas somadas): deadline único, sem retries agressivos.
  const deadline = Date.now() + RANK_TIMEOUT_MS;
  const remaining = (): number => Math.max(1000, deadline - Date.now());

  const attempt = async (): Promise<Recommendation[]> => {
    const raw = await groqChatJson({ ...payload, timeoutMs: remaining() });
    const valid = applyPicks(candidates, parseRankPicks(raw));
    if (valid.length === 0) throw new Error("picks fora do pool");
    return valid;
  };

  try {
    return await attempt();
  } catch (error) {
    const wait = retryAfterMs(error);
    if (wait !== null && wait < remaining() - 1500) {
      await sleep(wait);
      return attempt();
    }
    if (isJsonValidateFailed(error)) {
      return attempt();
    }
    throw error;
  }
}
