/**
 * Ranking de recomendações — Gemini (server-side) com fallback local.
 *
 * O Gemini recebe a lista FECHADA de candidatos e retorna até 4
 * {id, type, reason}. REGRA ANTI-HALLUCINATION: só valem IDs presentes
 * no pool, com type correspondente, sem repetidos — o resto é descartado.
 * Título/poster/ano/nota vêm sempre do pool TMDB, nunca do modelo.
 *
 * Timeout próprio (12–15s) + UM retry curto só em 5xx transitório.
 * Falha geral → ranking determinístico local (honesto, sem fingir IA).
 */
import { Type } from "@google/genai";
import type { ContentItem } from "../../types/content";
import {
  COMMITMENT_OPTIONS,
  CONTENT_TYPE_OPTIONS,
  GENRE_OPTIONS,
  MOOD_OPTIONS,
  PROVIDER_ANY_LABEL,
  PROVIDER_OPTIONS,
  type DiscoveryAnswers,
  type RecommendationRefinement,
} from "../../types/discovery";
import { getGeminiClient, getGeminiModel } from "./client";
import { ADAPTIVE_TAXONOMY } from "./adaptiveQuestion";
import {
  REFINEMENT_REASON_RULE,
  refinementUserLine,
} from "../discovery/refinement";
import {
  formatTasteForPrompt,
  localTasteBonus,
  resolveTastePenaltyGenres,
  TASTE_RANK_RULES,
  type TasteProfile,
} from "../personalization/taste";
import { toContentItem, type RecommendationCandidate } from "../discovery/candidates";

/** Timeout do ranking (tarefa maior que a pergunta adaptativa). */
export const RANK_TIMEOUT_MS = 14000;
/** Atraso do único retry em 5xx transitório. */
const RANK_RETRY_DELAY_MS = 800;
/** Recomendações finais (1 principal + 3 alternativas). */
export const MAX_RECOMMENDATIONS = 4;

export interface Recommendation {
  item: ContentItem;
  /** Explicação curta pt-BR (do Gemini ou template honesto do fallback). */
  reason: string;
  /** Posição 1–4. */
  rank: number;
}

export interface RecommendationResult {
  primary: Recommendation | null;
  alternatives: Recommendation[];
}

/** Tamanho máximo da reason (forçado server-side com corte elegante). */
export const MAX_REASON_LENGTH = 220;

/** Tamanho mínimo da reason (abaixo disso é ruído — descarta o pick). */
export const MIN_REASON_LENGTH = 40;

/** Corta no último espaço antes do limite (sem partir palavra). */
export function trimReason(reason: string): string {
  const clean = reason.trim().replace(/\s+/g, " ");
  if (clean.length <= MAX_REASON_LENGTH) return clean;
  const cut = clean.slice(0, MAX_REASON_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function labelOf(
  options: { value: string; label: string }[],
  value: string | null,
): string {
  if (!value) return "—";
  return options.find((o) => o.value === value)?.label ?? value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Variante que aborta a chamada Gemini no timeout (ver adaptiveQuestion:
 * sem `abortSignal` o socket ficaria pendurado em background).
 */
function withTimeoutAbort<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("tempo esgotado"));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isTransientStatus(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /503|500|502|504|UNAVAILABLE|overloaded|high demand/i.test(message);
}

/**
 * Resumo estruturado e curto das respostas (só o necessário para a reason).
 * Inclui pergunta + resposta adaptativa e exclusões, quando existirem.
 */
export function summarizeDiscoveryAnswers(answers: DiscoveryAnswers): string {
  const genres =
    answers.preferredGenres
      .map((g) => labelOf(GENRE_OPTIONS, g))
      .filter(Boolean)
      .join(", ") || "sem preferência";
  const providers = answers.providers.includes("any")
    ? PROVIDER_ANY_LABEL
    : answers.providers
        .map((p) => labelOf(PROVIDER_OPTIONS, p))
        .filter(Boolean)
        .join(", ");
  const adaptiveOptions =
    ADAPTIVE_TAXONOMY[answers.adaptive.category as keyof typeof ADAPTIVE_TAXONOMY];
  const adaptiveLabel = adaptiveOptions
    ? (labelOf(adaptiveOptions, answers.adaptive.value) ?? answers.adaptive.value ?? "—")
    : (answers.adaptive.value ?? "—");
  const excluded =
    answers.sessionExcludedGenres.length > 0
      ? answers.sessionExcludedGenres
          .map((g) => labelOf(GENRE_OPTIONS, g))
          .filter(Boolean)
          .join(", ")
      : "nenhuma";
  const lines = [
    `Tipo: ${labelOf(CONTENT_TYPE_OPTIONS, answers.contentType)}`,
    `Sensação: ${labelOf(MOOD_OPTIONS, answers.mood)}`,
    `Gêneros: ${genres}`,
    `Pergunta adaptativa (${answers.adaptive.category || "?"}): ${answers.adaptive.question ?? "—"}`,
    `Resposta adaptativa: ${adaptiveLabel}`,
    `Envolvimento: ${labelOf(COMMITMENT_OPTIONS, answers.commitment)}`,
    `Onde assistir: ${providers}`,
    `Gêneros excluídos: ${excluded}`,
  ];
  return lines.join("\n");
}

function summarizeAnswers(answers: DiscoveryAnswers): string {
  return summarizeDiscoveryAnswers(answers);
}

function candidateContext(candidate: RecommendationCandidate): string {
  const overview = candidate.overview.slice(0, 300);
  return [
    `id=${candidate.id} type=${candidate.type}`,
    `title="${candidate.title}"`,
    `year=${candidate.year ?? "?"}`,
    `genres=[${candidate.genres.join(", ")}]`,
    `rating=${candidate.rating ?? "?"} votes=${candidate.voteCount ?? "?"}`,
    `overview="${overview}"`,
  ].join(" ");
}

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
  "- não mencione Gemini, IA, modelo ou algoritmo;",
  "- não prometa nada além da compatibilidade com o momento.",
].join("\n");

interface RankPick {
  id: number;
  type: string;
  reason: string;
}

function parsePicks(rawText: string): RankPick[] {
  const parsed: unknown = JSON.parse(rawText);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("resposta não é objeto");
  }
  const list = (parsed as Record<string, unknown>).recommendations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("sem recomendações");
  }
  const picks: RankPick[] = [];
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

/** Aplica a regra anti-hallucination contra o pool. */
export function applyPicks(
  candidates: RecommendationCandidate[],
  picks: RankPick[],
): Recommendation[] {
  const pool = new Map(candidates.map((c) => [`${c.type}:${c.id}`, c]));
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const pick of picks) {
    const key = `${pick.type}:${pick.id}`;
    if (seen.has(key)) continue;
    const candidate = pool.get(key);
    if (!candidate) continue;
    seen.add(key);
    out.push({
      item: toContentItem(candidate),
      reason: pick.reason,
      rank: out.length + 1,
    });
    if (out.length >= MAX_RECOMMENDATIONS) break;
  }
  return out;
}

/** Exportado para o provider Gemini (fallback) em `src/lib/ai/provider.ts`. */
export async function rankWithGemini(
  answers: DiscoveryAnswers,
  candidates: RecommendationCandidate[],
  refinement: RecommendationRefinement | null = null,
  taste: TasteProfile | null = null,
): Promise<Recommendation[]> {
  const client = getGeminiClient();
  const lines = [
    "Preferências do usuário:",
    summarizeAnswers(answers),
  ];
  if (refinement) lines.push(refinementUserLine(refinement));
  const tasteBlock = taste ? formatTasteForPrompt(taste, tasteGenreLabel) : "";
  if (tasteBlock) lines.push("", tasteBlock);
  const userMessage = [
    ...lines,
    "",
    `Candidatos (escolha até ${MAX_RECOMMENDATIONS}):`,
    ...candidates.map((c, i) => `${i + 1}. ${candidateContext(c)}`),
  ].join("\n");
  const system = [
    refinement ? `${RANK_SYSTEM}\n${REFINEMENT_REASON_RULE}` : RANK_SYSTEM,
    ...(tasteBlock ? [TASTE_RANK_RULES] : []),
  ].join("\n");

  const attempt = (signal: AbortSignal): Promise<string> =>
    withTimeoutAbort(
      (innerSignal) =>
        client.models
          .generateContent({
            model: getGeminiModel(),
            contents: [{ role: "user", parts: [{ text: userMessage }] }],
            config: {
              // Teto total (outer) + teto da tentativa (inner): qualquer um aborta.
              abortSignal: AbortSignal.any([signal, innerSignal]),
              systemInstruction: system,
              responseMimeType: "application/json",
              responseJsonSchema: {
                type: Type.OBJECT,
                properties: {
                  recommendations: {
                    type: Type.ARRAY,
                    maxItems: MAX_RECOMMENDATIONS,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.INTEGER },
                        type: { type: Type.STRING, enum: ["movie", "tv"] },
                        reason: { type: Type.STRING },
                      },
                      required: ["id", "type", "reason"],
                      propertyOrdering: ["id", "type", "reason"],
                    },
                  },
                },
                required: ["recommendations"],
                propertyOrdering: ["recommendations"],
              },
            },
        })
        .then((response) => {
          const text = response.text?.trim();
          if (!text) throw new Error("resposta vazia");
          return text;
        }),
      RANK_TIMEOUT_MS,
    );

  let raw: string;
  const run = async (signal: AbortSignal): Promise<string> => {
    try {
      return await attempt(signal);
    } catch (error) {
      // UM retry curto só em 5xx transitório; depois, fallback.
      if (!isTransientStatus(error)) throw error;
      console.warn("[Gemini] Ranking 5xx transitório (tentando 1x novamente).");
      await sleep(RANK_RETRY_DELAY_MS);
      return attempt(signal);
    }
  };
  // Teto total (tentativas somadas) para não pendurar a requisição.
  raw = await withTimeoutAbort(run, RANK_TIMEOUT_MS);

  const valid = applyPicks(candidates, parsePicks(raw));
  if (valid.length === 0) throw new Error("picks fora do pool");
  return valid;
}

/** Label pt-BR de GenreKey para o bloco de gosto histórico. */
function tasteGenreLabel(genre: string): string {
  return GENRE_OPTIONS.find((o) => o.value === genre)?.label ?? genre;
}

/** Nomes pt-BR por GenreKey (pool já normalizado nesses rótulos). */
const SESSION_GENRE_LABELS: Record<string, string[]> = {
  action: ["Ação", "Ação e aventura"],
  adventure: ["Aventura", "Ação e aventura"],
  animation: ["Animação"],
  comedy: ["Comédia"],
  crime: ["Crime"],
  documentary: ["Documentário"],
  drama: ["Drama"],
  fantasy: ["Fantasia", "Sci-Fi e fantasia"],
  horror: ["Terror"],
  mystery: ["Mistério"],
  romance: ["Romance", "Drama", "Novela"],
  science_fiction: ["Ficção científica", "Sci-Fi e fantasia"],
  thriller: ["Thriller", "Crime", "Mistério"],
};

/** Fallback determinístico: relevância de gêneros + nota/votos/popularidade. */
export function rankLocally(
  answers: DiscoveryAnswers,
  candidates: RecommendationCandidate[],
  refinement: RecommendationRefinement | null = null,
  taste: TasteProfile | null = null,
): Recommendation[] {
  const genreNames = new Set(
    answers.preferredGenres.flatMap((key) => SESSION_GENRE_LABELS[key] ?? []),
  );

  // Gosto histórico como sinal secundário (±0.5 — bem menor que os
  // sinais explícitos da sessão). Negativo nunca penaliza gênero que a
  // sessão pediu (session wins); hard exclusions já saíram do pool.
  const sessionLabels = [...genreNames];
  const positiveLabels = (taste?.positiveGenres ?? []).flatMap(
    (signal) => SESSION_GENRE_LABELS[signal.genre] ?? [],
  );
  const negativeLabels = resolveTastePenaltyGenres(
    answers.preferredGenres,
    taste?.negativeGenres ?? [],
  ).flatMap((key) => SESSION_GENRE_LABELS[key] ?? []);

  const currentYear = new Date().getFullYear();
  const scored = candidates.map((candidate) => {
    const genreHits = candidate.genres.filter((g) => genreNames.has(g)).length;
    const rating = candidate.rating ?? 0;
    const votes = Math.min(2, (candidate.voteCount ?? 0) / 500);
    // less_popular: teto baixo p/ popularidade (meio-termo, não obscuridade);
    // qualidade preservada via rating/votos.
    const popularity =
      refinement === "less_popular"
        ? Math.min(0.5, (candidate.popularity ?? 0) / 100)
        : Math.min(1.5, (candidate.popularity ?? 0) / 100);
    let bonus = 0;
    if (refinement === "newer" && typeof candidate.year === "number") {
      if (candidate.year >= currentYear - 3) bonus += 2;
      else if (candidate.year >= currentYear - 7) bonus += 1;
    }
    if (refinement === "more_intense") {
      // Heurística conservadora: só sinais disponíveis (gênero/mood).
      // Nada aqui afirma intensidade específica do título.
      const intenseGenres = new Set([
        "Ação",
        "Thriller",
        "Crime",
        "Terror",
        "Aventura",
        "Mistério",
      ]);
      if (candidate.genres.some((g) => intenseGenres.has(g))) bonus += 0.75;
      if (answers.mood === "tense" || answers.mood === "surprise") bonus += 0.5;
    }
    // shorter: sem sinal por candidato (runtime não vem no discover) —
    // o efeito real está no filtro de pool (filmes); séries mantêm base.
    const tasteBonus = localTasteBonus(
      candidate.genres,
      sessionLabels,
      positiveLabels,
      negativeLabels,
    );
    return { candidate, score: genreHits * 2 + rating / 2 + votes + popularity + bonus + tasteBonus };
  });
  scored.sort((a, b) => b.score - a.score);

  const userGenres = answers.preferredGenres
    .map((g) => labelOf(GENRE_OPTIONS, g))
    .filter((label) => label !== "—");
  const adaptiveOptions =
    ADAPTIVE_TAXONOMY[answers.adaptive.category as keyof typeof ADAPTIVE_TAXONOMY];
  const adaptiveLabel = adaptiveOptions
    ? (labelOf(adaptiveOptions, answers.adaptive.value) ?? null)
    : null;

  // Dica de gosto para a reason (só com evidência: positiveGenres exige
  // evidence>=2 por construção). Linguagem agregada — sem títulos do
  // histórico, sem notas, sem gostos negativos.
  const tasteHint =
    taste?.positiveGenres[0] !== undefined
      ? (SESSION_GENRE_LABELS[taste.positiveGenres[0].genre]?.[0] ?? null)
      : null;

  return scored.slice(0, MAX_RECOMMENDATIONS).map(({ candidate }, i) => ({
    item: toContentItem(candidate),
    reason: buildFallbackReason(
      {
        typeLabel: candidate.type === "tv" ? "série" : "filme",
        moodFit: MOOD_FIT[answers.mood ?? ""] ?? null,
        moodNoun: MOOD_NOUN[answers.mood ?? ""] ?? null,
        userGenres: userGenres.slice(0, 2),
        adaptiveValue: answers.adaptive.value,
        adaptiveLabel: adaptiveLabel === "—" ? null : adaptiveLabel,
        commitmentClause: COMMITMENT_CLAUSE[answers.commitment ?? ""] ?? null,
        candidateGenres: candidate.genres.slice(0, 2),
        rating: candidate.rating,
        tasteHint,
      },
      i,
      candidate.id,
    ),
    rank: i + 1,
  }));
}

/**
 * Sinais para a reason honesta do fallback (só escolhas do usuário +
 * fatos do pool TMDB — nada inventado).
 */
export interface FallbackSignals {
  typeLabel: string;
  moodFit: string | null;
  moodNoun: string | null;
  userGenres: string[];
  adaptiveValue: string | null;
  adaptiveLabel: string | null;
  commitmentClause: string | null;
  candidateGenres: string[];
  rating: number | undefined;
  /** Rótulo de gênero bem avaliado (só com evidência) — variante opcional. */
  tasteHint: string | null;
}

const MOOD_FIT: Record<string, string> = {
  fun: "leve e divertido",
  tense: "tenso",
  emotional: "emocionante",
  thought_provoking: "instigante",
  relaxing: "tranquilo e sem pressa",
  surprise: "de descoberta",
};

const COMMITMENT_CLAUSE: Record<string, string> = {
  quick: "um ritmo mais acessível",
  immersive: "uma imersão maior",
};

const MOOD_NOUN: Record<string, string> = {
  fun: "algo divertido",
  tense: "tensão",
  emotional: "emoção",
  thought_provoking: "fazer pensar",
  relaxing: "relaxar",
  surprise: "se surpreender",
};

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Reason contextual honesta (sem fingir análise de IA): ancora nas
 * escolhas do usuário + gêneros/nota reais do pool. Seis variantes com
 * rotação determinística por (índice + id) — varia entre itens e
 * conjuntos sem aleatoriedade real.
 */
export function buildFallbackReason(
  signals: FallbackSignals,
  index: number,
  salt = 0,
): string {
  const anchor = signals.candidateGenres[0]
    ? ` de ${signals.candidateGenres[0]}`
    : signals.userGenres[0]
      ? ` para quem curte ${signals.userGenres[0]}`
      : "";
  const userGenres =
    signals.userGenres.length > 0 ? signals.userGenres.join(" e ") : "seu perfil";
  const candidateGenres =
    signals.candidateGenres.length > 0
      ? signals.candidateGenres.join(" e ")
      : "seu perfil";
  const demo = signals.typeLabel === "série" ? "esta" : "este";
  const Demo = signals.typeLabel === "série" ? "Esta" : "Este";

  const variants: (string | null)[] = [
    signals.moodFit
      ? `Para um momento ${signals.moodFit}, ${demo} ${signals.typeLabel}${anchor} combina com o clima que você buscou.`
      : null,
    signals.adaptiveLabel && signals.adaptiveValue !== "any"
      ? `Você priorizou ${lowerFirst(signals.adaptiveLabel)}; esta opção conversa bem com essa escolha.`
      : null,
    signals.commitmentClause
      ? `Com ${signals.commitmentClause}, ${demo} ${signals.typeLabel} pode funcionar bem para agora.`
      : null,
    `${Demo} ${signals.typeLabel} de ${candidateGenres} foi um dos melhores encaixes para ${userGenres}.`,
    signals.moodNoun
      ? `Se a ideia é ${signals.moodNoun}, ${demo} ${signals.typeLabel} entra bem pelo ${signals.candidateGenres[0] ?? "clima"}.`
      : null,
    signals.adaptiveLabel && signals.adaptiveValue !== "any"
      ? `Combinando ${lowerFirst(signals.adaptiveLabel)} com ${userGenres}, ${demo} ${signals.typeLabel} fecha bem com seu perfil.`
      : null,
  ];
  // Variante de gosto histórico: SÓ quando há evidência (tasteHint).
  // Ausente → `applicable` idêntico ao anterior (zero regressão).
  if (signals.tasteHint) {
    variants.push(
      `Além de combinar com o que você buscou hoje, ${demo} ${signals.typeLabel} conversa com ${lowerFirst(signals.tasteHint)} que você costuma avaliar bem.`,
    );
  }
  const applicable = variants.filter((v): v is string => v !== null);
  let reason = applicable[(index + salt) % applicable.length];

  // Nota alta entra só como complemento honesto (fato do pool).
  if (
    signals.rating !== undefined &&
    signals.rating >= 7.5 &&
    (index + salt) % 2 === 1
  ) {
    const complement = ` Nota ${signals.rating.toFixed(1)} do público.`;
    if (reason.length + complement.length <= MAX_REASON_LENGTH) {
      reason += complement;
    }
  }

  return trimReason(reason);
}

export interface RankOutcome {
  result: RecommendationResult;
  /** `true` quando o Gemini respondeu; `false` = fallback local. */
  fromAi: boolean;
}

/**
 * Pipeline de ranking: Gemini primeiro, fallback local em qualquer falha.
 * Nunca lança por causa do Gemini — só por pool vazio (erro do chamador).
 */
export async function rankRecommendations(
  answers: DiscoveryAnswers,
  candidates: RecommendationCandidate[],
): Promise<RankOutcome> {
  if (candidates.length === 0) {
    throw new Error("[Discovery] Pool de candidatos vazio.");
  }
  try {
    const ranked = await rankWithGemini(answers, candidates);
    const [primary, ...alternatives] = ranked;
    return { result: { primary: primary ?? null, alternatives }, fromAi: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[Gemini] Ranking indisponível (${message}) — usando fallback local.`);
    const ranked = rankLocally(answers, candidates);
    const [primary, ...alternatives] = ranked;
    return { result: { primary: primary ?? null, alternatives }, fromAi: false };
  }
}
