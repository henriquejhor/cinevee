/**
 * Pergunta adaptativa do /descobrir (passo 3/5) via Gemini.
 *
 * Filosofia: o Gemini NÃO cria perguntas livremente. Ele escolhe UMA
 * categoria de uma lista FECHADA + o wording em pt-BR. As opções
 * (values/labels) vêm sempre da taxonomia local abaixo — nunca do modelo.
 *
 * Falha/timeout/validação → fallback local (mock story_focus). A
 * experiência nunca depende do Gemini estar disponível.
 */
import { Type } from "@google/genai";
import {
  MOCK_ADAPTIVE_QUESTION,
  type AdaptiveOption,
  type AdaptiveQuestion,
  type ContentTypeChoice,
  type GenreKey,
  type MoodKey,
} from "../../types/discovery";
import { getGeminiClient, getGeminiModel } from "./client";
import {
  BANK_CATEGORY_OPTIONS,
  buildShortlist,
  getBankEntry,
  type AdaptiveQuestionDefinition,
} from "./adaptiveBank";

/** Pergunta de fallback: sempre a mesma (story_focus_01). */
export const FALLBACK_QUESTION_ID = "story_focus_01";

/** Timeout server-side da chamada ao Gemini (sem retries nesta etapa). */
export const ADAPTIVE_TIMEOUT_MS = 8000;

export type AdaptiveCategory =
  | "story_focus"
  | "intensity"
  | "complexity"
  | "humor_style"
  | "suspense_style"
  | "romance_level"
  | "era_preference"
  | "popularity_preference"
  | "pace_preference"
  | "ending_tone"
  | "realism_level"
  | "narrative_style"
  | "character_scope"
  | "familiarity"
  | "setting_style"
  | "surprise_level"
  | "action_level"
  | "mystery_level"
  | "emotional_depth"
  | "escapism"
  | "optimism"
  | "villain_focus"
  | "music"
  | "true_story"
  | "nostalgia"
  | "social"
  | "worldbuilding"
  | "plot_character"
  | "scope"
  | "comfort"
  | "style_vision"
  | "closure"
  | "dialogue_balance";

const ADAPTIVE_CATEGORIES: readonly AdaptiveCategory[] = [
  "story_focus",
  "intensity",
  "complexity",
  "humor_style",
  "suspense_style",
  "romance_level",
  "era_preference",
  "popularity_preference",
  "pace_preference",
  "ending_tone",
  "realism_level",
  "narrative_style",
  "character_scope",
  "familiarity",
  "setting_style",
  "surprise_level",
  "action_level",
  "mystery_level",
  "emotional_depth",
  "escapism",
  "optimism",
  "villain_focus",
  "music",
  "true_story",
  "nostalgia",
  "social",
  "worldbuilding",
  "plot_character",
  "scope",
  "comfort",
  "style_vision",
  "closure",
  "dialogue_balance",
];

/**
 * Taxonomia local: espelha as options do banco (fonte única em
 * adaptiveBank.ts — sem duplicação). Única fonte das options
 * servidas ao browser.
 */
export const ADAPTIVE_TAXONOMY: Record<AdaptiveCategory, AdaptiveOption[]> = (() => {
  const map = {} as Record<AdaptiveCategory, AdaptiveOption[]>;
  for (const category of ADAPTIVE_CATEGORIES) {
    const options = BANK_CATEGORY_OPTIONS[category];
    if (!options) {
      throw new Error(`[Bank] Categoria sem options: ${category}`);
    }
    map[category] = options;
  }
  return map;
})();

export function isAdaptiveCategory(value: unknown): value is AdaptiveCategory {
  return (
    typeof value === "string" &&
    (ADAPTIVE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function optionsForCategory(category: AdaptiveCategory): AdaptiveOption[] {
  return ADAPTIVE_TAXONOMY[category].map((option) => ({ ...option }));
}

export interface AdaptiveContext {
  contentType: ContentTypeChoice;
  mood: MoodKey;
  preferredGenres: GenreKey[];
  /** Exclusões da sessão (hoje []) + futuras exclusões do perfil. */
  excludedGenres: GenreKey[];
}

export interface AdaptivePick {
  questionId: string;
  category: AdaptiveCategory;
  question: string;
}

const QUESTION_MIN_LENGTH = 8;
const QUESTION_MAX_LENGTH = 140;

/** Shortlist típica enviada ao Gemini (equilíbrio contexto × tokens). */
export const SHORTLIST_LIMIT = 12;

const SYSTEM_INSTRUCTION = [
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
  "- não mencionar Gemini, IA ou modelo;",
  "- não prometer recomendação.",
].join("\n");

interface ShortlistEntry {
  id: string;
  question: string;
}

function buildUserMessage(
  context: AdaptiveContext,
  shortlist: ShortlistEntry[],
  recentCategories: AdaptiveCategory[] = [],
): string {
  const payload: Record<string, unknown> = {
    contentType: context.contentType,
    mood: context.mood,
    preferredGenres: context.preferredGenres,
    excludedGenres: context.excludedGenres,
    shortlist,
  };
  if (recentCategories.length > 0) {
    payload.recentCategories = recentCategories;
    payload.recentCategoriesNote =
      "Categorias perguntadas recentemente neste aparelho. Prefira perguntas de outras categorias se forem igualmente úteis; só repita categoria se for claramente a mais útil.";
  }
  return JSON.stringify(payload);
}

/**
 * Race com timeout que também aborta a chamada: sem `abortSignal`, o
 * socket do SDK continuaria pendurado em background após o timeout
 * (vazamento de sockets sob carga). Falha → fallback local.
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

function cleanWording(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (
    trimmed.length < QUESTION_MIN_LENGTH ||
    trimmed.length > QUESTION_MAX_LENGTH
  ) {
    return fallback;
  }
  return trimmed;
}

function parsePick(
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
  if (!isAdaptiveCategory(definition.category)) {
    throw new Error(`categoria inválida: ${definition.category}`);
  }
  return {
    questionId: definition.id,
    category: definition.category,
    question: cleanWording(wording, definition.question),
  };
}

/**
 * Monta a shortlist e pergunta ao Gemini qual usar. Lança erro em
 * qualquer falha (timeout, HTTP, JSON/esquema, id fora da shortlist) —
 * o chamador aplica o fallback local.
 */
export async function getAdaptivePick(
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

  const client = getGeminiClient();
  const call = (signal: AbortSignal) =>
    client.models.generateContent({
      model: getGeminiModel(),
      contents: [
        {
          role: "user",
          parts: [
            {
              text: buildUserMessage(
                context,
                shortlist.map((entry) => ({ id: entry.id, question: entry.question })),
                recentCategories,
              ),
            },
          ],
        },
      ],
      config: {
        abortSignal: signal,
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: Type.OBJECT,
          properties: {
            questionId: { type: Type.STRING },
            wording: { type: Type.STRING },
          },
          required: ["questionId"],
          propertyOrdering: ["questionId", "wording"],
        },
      },
    });

  const response = await withTimeoutAbort(call, ADAPTIVE_TIMEOUT_MS);
  const text = response.text?.trim();
  if (!text) throw new Error("resposta vazia");
  return parsePick(text, shortlist);
}

/** Fallback local: sempre story_focus_01 (texto e options conhecidos). */
export function getFallbackQuestion(): AdaptiveQuestion {
  const definition = getBankEntry(FALLBACK_QUESTION_ID);
  if (!definition) {
    return {
      category: MOCK_ADAPTIVE_QUESTION.category,
      question: MOCK_ADAPTIVE_QUESTION.question,
      options: MOCK_ADAPTIVE_QUESTION.options.map((option) => ({ ...option })),
    };
  }
  return {
    questionId: definition.id,
    category: definition.category as AdaptiveCategory,
    question: definition.question,
    options: definition.options.map((option) => ({ ...option })),
  };
}

/** Monta a resposta completa: pergunta (Gemini ou fallback) + options locais. */
export function buildAdaptiveResponse(pick: AdaptivePick): AdaptiveQuestion {
  const definition = getBankEntry(pick.questionId);
  const options = definition
    ? definition.options.map((option) => ({ ...option }))
    : optionsForCategory(pick.category);
  return {
    questionId: pick.questionId,
    category: pick.category,
    question: pick.question,
    options,
  };
}
