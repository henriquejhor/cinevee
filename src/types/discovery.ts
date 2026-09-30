/**
 * Tipos do questionário /descobrir (primeira versão funcional, sem Gemini).
 *
 * A pergunta adaptativa é DATA (`AdaptiveQuestion`), não código: a tela
 * renderiza `question` + `options[]` dinamicamente, então trocar o mock
 * pela resposta do Gemini depois não exige redesign.
 */
import type { StreamingProvider } from "./content";

/** O que você quer assistir? (etapa inicial, fora da contagem 1–5). */
export type ContentTypeChoice = "movie" | "tv" | "any";

/** Como você quer se sentir? (1/5, seleção única). */
export type MoodKey =
  | "fun"
  | "tense"
  | "emotional"
  | "thought_provoking"
  | "relaxing"
  | "surprise";

/** Gêneros (2/5, múltipla escolha até 3). Chaves semânticas, sem TMDB. */
export type GenreKey =
  | "action"
  | "adventure"
  | "animation"
  | "comedy"
  | "crime"
  | "documentary"
  | "drama"
  | "fantasy"
  | "horror"
  | "mystery"
  | "romance"
  | "science_fiction"
  | "thriller";

/** Quanto você quer se envolver agora? (4/5, seleção única). */
export type CommitmentKey = "quick" | "balanced" | "immersive" | "any";

/**
 * Refinamento rápido do resultado (tela final, UM ativo por vez).
 * Não faz parte do questionário: é uma intenção extra aplicada ao
 * candidate pool + ranking sem refazer as respostas.
 */
export type RecommendationRefinement =
  | "shorter"
  | "newer"
  | "more_intense"
  | "less_popular";

export const REFINEMENT_OPTIONS: {
  value: RecommendationRefinement;
  label: string;
}[] = [
  { value: "shorter", label: "Mais curto" },
  { value: "newer", label: "Mais recente" },
  { value: "more_intense", label: "Mais intenso" },
  { value: "less_popular", label: "Menos conhecido" },
];

export function isRecommendationRefinement(
  value: unknown,
): value is RecommendationRefinement {
  return (
    typeof value === "string" &&
    (REFINEMENT_OPTIONS as readonly { value: string }[]).some(
      (option) => option.value === value,
    )
  );
}

/** Onde você pode assistir? (5/5, múltipla — "any" limpa as demais). */
export type DiscoveryProvider = StreamingProvider | "any";

export interface AdaptiveOption {
  value: string;
  label: string;
}

/**
 * Pergunta adaptativa (3/5). Hoje um mock; futuramente virá do Gemini
 * no MESMO formato — a tela não depende desta pergunta específica.
 */
export interface AdaptiveQuestion {
  category: string;
  question: string;
  options: AdaptiveOption[];
  /** Id da definição no banco (quando veio dele). */
  questionId?: string;
}

export interface DiscoveryAnswers {
  contentType: ContentTypeChoice | null;
  mood: MoodKey | null;
  preferredGenres: GenreKey[];
  adaptive: {
    category: string;
    value: string | null;
    /** Pergunta em cache (Gemini ou fallback). Ausente → buscar ao entrar no passo 3. */
    question?: string;
    /** Options da pergunta em cache (sempre da taxonomia local). */
    options?: AdaptiveOption[];
    /** Fingerprint do contexto que gerou a pergunta em cache. */
    contextKey?: string;
    /** Id da definição no banco (para memória de diversidade). */
    questionId?: string;
  };
  commitment: CommitmentKey | null;
  providers: DiscoveryProvider[];
  /** Reservado para exclusões futuras de perfil. Nesta versão: []. */
  sessionExcludedGenres: GenreKey[];
}

/**
 * Passo atual: 0 = tipo de conteúdo … 5 = streamings, 6 = conclusão,
 * 7 = processando recomendações, 8 = resultado.
 */
export type DiscoveryStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface DiscoverySession {
  step: DiscoveryStep;
  answers: DiscoveryAnswers;
  updatedAt: string;
  /**
   * Relógio de inatividade da jornada (Etapa 20, epoch ms).
   * Só ações relevantes o renovam (responder/alterar/avançar, gerar,
   * reroll, refinement); abrir a página, reload ou restaurar NÃO renovam.
   * Sessão expira quando `now - lastActivityAt >= DISCOVERY_SESSION_TTL_MS`.
   * Ausente/0 = storage legado → tratado como expirado.
   */
  lastActivityAt: number;
}

/** Chave única do localStorage (não espalhar a string pelo código). */
export const DISCOVERY_STORAGE_KEY = "cinevee.discovery";

/**
 * TTL de inatividade da sessão de Descoberta (Etapa 20): 20 minutos.
 * Centralizado aqui — não espalhar números mágicos pelo código.
 */
export const DISCOVERY_SESSION_TTL_MS = 20 * 60 * 1000;

/** Última recomendação gerada (respostas + resultado + timestamp). */
export const RECOMMENDATIONS_STORAGE_KEY = "cinevee.recommendations";

/**
 * Memória local de diversidade: IDs já apresentados ("movie:123").
 * NÃO é histórico de conta — só evita repetição imediata. Sobrevive
 * ao "Começar de novo" (que limpa respostas/progresso/resultado).
 */
export const SEEN_STORAGE_KEY = "cinevee.discovery.seen";

/**
 * Últimas categorias adaptativas apresentadas. Sobrevive ao recomeço
 * para que refazer o fluxo com respostas iguais possa variar a pergunta.
 */
export const CATEGORY_HISTORY_KEY = "cinevee.discovery.categories";

export const MAX_GENRES = 3;

export const CONTENT_TYPE_OPTIONS: { value: ContentTypeChoice; label: string }[] = [
  { value: "movie", label: "Filme" },
  { value: "tv", label: "Série" },
  { value: "any", label: "Tanto faz" },
];

export const MOOD_OPTIONS: { value: MoodKey; label: string }[] = [
  { value: "fun", label: "Me divertir" },
  { value: "tense", label: "Sentir tensão" },
  { value: "emotional", label: "Me emocionar" },
  { value: "thought_provoking", label: "Quero pensar" },
  { value: "relaxing", label: "Relaxar" },
  { value: "surprise", label: "Me surpreenda" },
];

export const GENRE_OPTIONS: { value: GenreKey; label: string }[] = [
  { value: "action", label: "Ação" },
  { value: "adventure", label: "Aventura" },
  { value: "animation", label: "Animação" },
  { value: "comedy", label: "Comédia" },
  { value: "crime", label: "Crime" },
  { value: "documentary", label: "Documentário" },
  { value: "drama", label: "Drama" },
  { value: "fantasy", label: "Fantasia" },
  { value: "horror", label: "Terror" },
  { value: "mystery", label: "Mistério" },
  { value: "romance", label: "Romance" },
  { value: "science_fiction", label: "Ficção científica" },
  { value: "thriller", label: "Suspense" },
];

export const GENRE_NO_PREFERENCE_LABEL = "Não tenho preferência";

export const COMMITMENT_OPTIONS: { value: CommitmentKey; label: string }[] = [
  { value: "quick", label: "Algo rápido" },
  { value: "balanced", label: "Na medida certa" },
  { value: "immersive", label: "Quero mergulhar" },
  { value: "any", label: "Tanto faz" },
];

export const PROVIDER_OPTIONS: { value: StreamingProvider; label: string }[] = [
  { value: "netflix", label: "Netflix" },
  { value: "prime", label: "Prime Video" },
  { value: "disney", label: "Disney+" },
  { value: "max", label: "Max" },
];

export const PROVIDER_ANY_LABEL = "Qualquer plataforma";

/** Mock temporário da pergunta adaptativa (será o Gemini, mesmo formato). */
export const MOCK_ADAPTIVE_QUESTION: AdaptiveQuestion = {
  category: "story_focus",
  question: "O que mais importa para você nessa história?",
  options: [
    { value: "characters", label: "Personagens marcantes" },
    { value: "plot", label: "Uma trama envolvente" },
    { value: "worldbuilding", label: "Um universo interessante" },
    { value: "any", label: "Me surpreenda" },
  ],
};
