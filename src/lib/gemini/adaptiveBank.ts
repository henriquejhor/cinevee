/**
 * Banco de perguntas adaptativas (~36 definições controladas pelo CineVee).
 *
 * Fonte única das options por categoria (TAXONOMY usada também pelo
 * endpoint, ranking e fallback — sem duplicação nem ciclo de imports:
 * este módulo só importa tipos).
 *
 * O usuário vê UMA pergunta por questionário. Fluxo:
 * banco → shortlist filtrada pelo contexto (~8–15) → Gemini escolhe UMA
 * pelo questionId → options vêm sempre da definição local.
 */
import type {
  AdaptiveOption,
  ContentTypeChoice,
  GenreKey,
  MoodKey,
} from "../../types/discovery";

export const BANK_CATEGORY_OPTIONS: Record<string, AdaptiveOption[]> = {
  story_focus: [
    { value: "characters", label: "Personagens marcantes" },
    { value: "plot", label: "Uma trama envolvente" },
    { value: "worldbuilding", label: "Um universo interessante" },
    { value: "any", label: "Me surpreenda" },
  ],
  intensity: [
    { value: "light", label: "Algo leve" },
    { value: "balanced", label: "Na medida" },
    { value: "intense", label: "Bem intenso" },
    { value: "any", label: "Tanto faz" },
  ],
  complexity: [
    { value: "simple", label: "Fácil de acompanhar" },
    { value: "balanced", label: "Na medida" },
    { value: "complex", label: "Complexa e instigante" },
    { value: "any", label: "Tanto faz" },
  ],
  humor_style: [
    { value: "silly", label: "Humor escrachado" },
    { value: "witty", label: "Humor inteligente" },
    { value: "dark", label: "Humor ácido" },
    { value: "any", label: "Tanto faz" },
  ],
  suspense_style: [
    { value: "mystery", label: "Mistério para desvendar" },
    { value: "psychological", label: "Tensão psicológica" },
    { value: "action", label: "Ação e ritmo" },
    { value: "any", label: "Tanto faz" },
  ],
  romance_level: [
    { value: "light", label: "Só um toque" },
    { value: "important", label: "Bem presente" },
    { value: "central", label: "No centro de tudo" },
    { value: "any", label: "Tanto faz" },
  ],
  era_preference: [
    { value: "recent", label: "Lançamentos" },
    { value: "modern", label: "Últimas décadas" },
    { value: "classic", label: "Clássicos" },
    { value: "any", label: "Tanto faz" },
  ],
  popularity_preference: [
    { value: "mainstream", label: "Os mais populares" },
    { value: "balanced", label: "Um pouco de tudo" },
    { value: "hidden_gems", label: "Joias escondidas" },
    { value: "any", label: "Me surpreenda" },
  ],
  pace_preference: [
    { value: "slow", label: "Ritmo tranquilo" },
    { value: "balanced", label: "Ritmo equilibrado" },
    { value: "fast", label: "Ritmo acelerado" },
    { value: "any", label: "Tanto faz" },
  ],
  ending_tone: [
    { value: "uplifting", label: "Final leve" },
    { value: "bittersweet", label: "Final agridoce" },
    { value: "open", label: "Final em aberto" },
    { value: "any", label: "Tanto faz" },
  ],
  realism_level: [
    { value: "grounded", label: "Pé no chão" },
    { value: "balanced", label: "Equilibrado" },
    { value: "fantastical", label: "Bem fantasioso" },
    { value: "any", label: "Tanto faz" },
  ],
  narrative_style: [
    { value: "linear", label: "História direta" },
    { value: "intertwined", label: "Várias tramas" },
    { value: "nonlinear", label: "Não-linear" },
    { value: "any", label: "Tanto faz" },
  ],
  character_scope: [
    { value: "solo", label: "Um protagonista" },
    { value: "duo", label: "Uma dupla" },
    { value: "ensemble", label: "Um grupo" },
    { value: "any", label: "Tanto faz" },
  ],
  familiarity: [
    { value: "comfort", label: "Zona de conforto" },
    { value: "different", label: "Algo diferente" },
    { value: "bold", label: "Bem ousado" },
    { value: "any", label: "Me surpreenda" },
  ],
  setting_style: [
    { value: "urban", label: "Urbano e atual" },
    { value: "exotic", label: "Lugares exóticos" },
    { value: "period", label: "Outra época" },
    { value: "any", label: "Tanto faz" },
  ],
  surprise_level: [
    { value: "easy", label: "Tranquilo de acompanhar" },
    { value: "twists", label: "Com reviravoltas" },
    { value: "mindbending", label: "Quebra-cabeça" },
    { value: "any", label: "Tanto faz" },
  ],
  action_level: [
    { value: "calm", label: "Tranquilo" },
    { value: "balanced", label: "Equilibrado" },
    { value: "nonstop", label: "Sem parar" },
    { value: "any", label: "Tanto faz" },
  ],
  mystery_level: [
    { value: "solve", label: "Desvendar sozinho" },
    { value: "twists", label: "Ser surpreendido" },
    { value: "guided", label: "Ser conduzido" },
    { value: "any", label: "Tanto faz" },
  ],
  emotional_depth: [
    { value: "light", label: "Leve" },
    { value: "moving", label: "Emocionante" },
    { value: "overwhelming", label: "Arrebatadora" },
    { value: "any", label: "Tanto faz" },
  ],
  escapism: [
    { value: "mirror", label: "Espelho da realidade" },
    { value: "balanced", label: "Equilibrado" },
    { value: "escape", label: "Fuga total" },
    { value: "any", label: "Tanto faz" },
  ],
  optimism: [
    { value: "feelgood", label: "Astral leve" },
    { value: "balanced", label: "Equilibrado" },
    { value: "gritty", label: "Clima denso" },
    { value: "any", label: "Tanto faz" },
  ],
  villain_focus: [
    { value: "villain", label: "Vilão marcante" },
    { value: "hero", label: "Herói inspirador" },
    { value: "gray", label: "Zona cinzenta" },
    { value: "any", label: "Tanto faz" },
  ],
  music: [
    { value: "soundtrack", label: "Trilha marcante" },
    { value: "neutral", label: "Não ligo muito" },
    { value: "musical", label: "Pode ser musical" },
    { value: "any", label: "Tanto faz" },
  ],
  true_story: [
    { value: "based_on_true", label: "Adoro baseadas em fatos" },
    { value: "fiction", label: "Prefiro ficção" },
    { value: "any", label: "Tanto faz" },
  ],
  nostalgia: [
    { value: "nostalgic", label: "Quero nostalgia" },
    { value: "fresh", label: "Quero coisa nova" },
    { value: "any", label: "Tanto faz" },
  ],
  social: [
    { value: "solo", label: "Sozinho" },
    { value: "together", label: "Acompanhado" },
    { value: "family", label: "Com a família" },
    { value: "any", label: "Tanto faz" },
  ],
  worldbuilding: [
    { value: "setting", label: "Universo rico" },
    { value: "people", label: "Foco nas pessoas" },
    { value: "any", label: "Tanto faz" },
  ],
  plot_character: [
    { value: "plot", label: "A trama" },
    { value: "characters", label: "Os personagens" },
    { value: "balanced", label: "Equilíbrio" },
    { value: "any", label: "Tanto faz" },
  ],
  scope: [
    { value: "intimate", label: "História íntima" },
    { value: "balanced", label: "Equilibrada" },
    { value: "epic", label: "Épica" },
    { value: "any", label: "Tanto faz" },
  ],
  comfort: [
    { value: "comfort", label: "Zona de conforto" },
    { value: "balanced", label: "Equilibrado" },
    { value: "challenge", label: "Me desafie" },
    { value: "any", label: "Tanto faz" },
  ],
  style_vision: [
    { value: "realistic", label: "Visual realista" },
    { value: "balanced", label: "Equilibrado" },
    { value: "stylized", label: "Bem estilizado" },
    { value: "any", label: "Tanto faz" },
  ],
  closure: [
    { value: "closed", label: "História fechada" },
    { value: "open", label: "Em aberto" },
    { value: "any", label: "Tanto faz" },
  ],
  dialogue_balance: [
    { value: "dialogue", label: "Muita conversa" },
    { value: "balanced", label: "Equilibrado" },
    { value: "action", label: "Muito movimento" },
    { value: "any", label: "Tanto faz" },
  ],
};

export interface AdaptiveQuestionDefinition {
  id: string;
  category: string;
  question: string;
  options: AdaptiveOption[];
  triggers?: {
    moods?: MoodKey[];
    genres?: GenreKey[];
    contentTypes?: ContentTypeChoice[];
  };
}

function entry(
  id: string,
  category: string,
  question: string,
  triggers?: AdaptiveQuestionDefinition["triggers"],
): AdaptiveQuestionDefinition {
  const options = BANK_CATEGORY_OPTIONS[category];
  if (!options) throw new Error(`[Bank] Categoria sem options: ${category}`);
  return { id, category, question, options, triggers };
}

export const ADAPTIVE_BANK: AdaptiveQuestionDefinition[] = [
  entry("story_focus_01", "story_focus", "O que mais importa para você nessa história?"),
  entry("story_focus_02", "story_focus", "O que te faz continuar assistindo?", { genres: ["drama", "mystery"] }),
  entry("pace_01", "pace_preference", "Que ritmo combina com agora?", { moods: ["tense", "fun"], genres: ["action", "thriller", "comedy"] }),
  entry("pace_02", "pace_preference", "Tudo bem se demorar para engrenar?", { moods: ["relaxing", "thought_provoking"], genres: ["drama", "mystery"] }),
  entry("intensity_01", "intensity", "Qual intensidade você quer?", { moods: ["tense", "fun", "emotional"] }),
  entry("complexity_01", "complexity", "Quanto você quer pensar?", { moods: ["thought_provoking"], genres: ["mystery", "science_fiction", "drama"] }),
  entry("realism_01", "realism_level", "Quanto de fantasia pode ter?", { genres: ["fantasy", "science_fiction", "horror", "animation"] }),
  entry("escapism_01", "escapism", "Prefere realidade ou fuga total?", { moods: ["relaxing", "fun"], genres: ["fantasy", "animation", "comedy"] }),
  entry("ending_01", "ending_tone", "Que tipo de final você prefere?", { moods: ["emotional"], genres: ["drama", "romance"] }),
  entry("narrative_01", "narrative_style", "Como a história deve ser contada?", { moods: ["thought_provoking"], genres: ["mystery", "crime", "drama"] }),
  entry("character_01", "character_scope", "Quem você quer acompanhar?", { genres: ["drama", "comedy", "action"] }),
  entry("plot_character_01", "plot_character", "O que pesa mais na escolha?"),
  entry("action_01", "action_level", "Quanta ação você quer?", { genres: ["action", "adventure", "thriller", "crime"], moods: ["tense", "fun"] }),
  entry("romance_01", "romance_level", "Quanto romance você quer no centro da história?", { genres: ["romance", "drama"], moods: ["emotional"] }),
  entry("humor_01", "humor_style", "Que tipo de humor combina mais com você agora?", { genres: ["comedy", "animation"], moods: ["fun", "relaxing"] }),
  entry("suspense_01", "suspense_style", "Que tipo de tensão prende mais sua atenção?", { genres: ["thriller", "crime", "mystery", "horror"], moods: ["tense"] }),
  entry("suspense_02", "suspense_style", "Você prefere investigar junto ou ser perseguido pela trama?", { genres: ["crime", "mystery"], moods: ["tense"] }),
  entry("mystery_01", "mystery_level", "Na hora do mistério, qual é o seu papel?", { genres: ["mystery", "crime"], moods: ["thought_provoking", "tense"] }),
  entry("surprise_01", "surprise_level", "E quanto a surpresas?", { moods: ["surprise", "fun"] }),
  entry("emotion_01", "emotional_depth", "Pode mexer com você?", { moods: ["emotional"], genres: ["drama", "romance"] }),
  entry("optimism_01", "optimism", "Qual o astral geral da história?", { moods: ["fun", "relaxing", "emotional"] }),
  entry("villain_01", "villain_focus", "Que tipo de personagem central te atrai?", { genres: ["crime", "thriller", "drama", "fantasy"] }),
  entry("music_01", "music", "A trilha sonora importa?", { moods: ["emotional", "relaxing"], genres: ["drama", "romance", "animation"] }),
  entry("true_story_01", "true_story", "Baseada em fatos reais ou ficção pura?", { genres: ["drama", "crime", "documentary"] }),
  entry("nostalgia_01", "nostalgia", "Bateu nostalgia ou quer coisa nova?", { moods: ["relaxing"], genres: ["comedy", "animation", "adventure"] }),
  entry("social_01", "social", "Para ver sozinho ou acompanhado?", { moods: ["fun", "relaxing"], genres: ["comedy", "animation"] }),
  entry("world_01", "worldbuilding", "O universo da história é importante?", { genres: ["fantasy", "science_fiction", "adventure"] }),
  entry("scope_01", "scope", "História íntima ou épica?", { genres: ["drama", "action", "adventure", "fantasy"] }),
  entry("comfort_01", "comfort", "Zona de conforto ou desafio?", { moods: ["surprise", "relaxing"] }),
  entry("style_01", "style_vision", "Visual realista ou estilizado?", { genres: ["animation", "fantasy", "science_fiction", "horror"] }),
  entry("closure_01", "closure", "Prefere história fechada ou em aberto?", { contentTypes: ["tv"], genres: ["drama", "mystery"] }),
  entry("era_01", "era_preference", "De que época?", { genres: ["drama", "crime", "romance"] }),
  entry("setting_01", "setting_style", "Onde a história se passa?", { genres: ["adventure", "fantasy", "science_fiction", "mystery"] }),
  entry("popularity_01", "popularity_preference", "Certezas ou descobertas?", { moods: ["surprise"] }),
  entry("familiarity_01", "familiarity", "Familiar ou totalmente novo?", { moods: ["surprise", "relaxing"] }),
  entry("dialogue_01", "dialogue_balance", "Mais conversa ou mais movimento?", { genres: ["drama", "comedy", "action", "thriller"] }),
];

const BANK_BY_ID = new Map(ADAPTIVE_BANK.map((entry) => [entry.id, entry]));

export function getBankEntry(id: string): AdaptiveQuestionDefinition | undefined {
  return BANK_BY_ID.get(id);
}

export function bankCategoryOf(id: string): string | undefined {
  return BANK_BY_ID.get(id)?.category;
}

export interface ShortlistContext {
  contentType: string;
  mood: string;
  preferredGenres: string[];
  /** Exclusões efetivas (profile + sessão): despriorizam perguntas do gênero. */
  excludedGenres?: string[];
}

/**
 * Shortlist determinística (~8–15): pontua por triggers, exclui IDs
 * recentes, desprioriza categorias a evitar e perguntas centradas em
 * gêneros excluídos. Relevância > variedade: se filtrar demais, completa
 * com as excluídas (melhor pontuadas).
 */
export function buildShortlist(
  context: ShortlistContext,
  excludeIds: string[] = [],
  avoidCategories: string[] = [],
  limit = 12,
): AdaptiveQuestionDefinition[] {
  const excluded = new Set(excludeIds);
  const avoided = new Set(avoidCategories);
  const excludedGenres = new Set(context.excludedGenres ?? []);

  const scored = ADAPTIVE_BANK.map((entry) => {
    let score = 1;
    const triggers = entry.triggers;
    if (triggers?.moods?.includes(context.mood as MoodKey)) score += 2;
    if (triggers?.contentTypes?.includes(context.contentType as ContentTypeChoice)) score += 1;
    if (triggers?.genres) {
      for (const genre of context.preferredGenres) {
        if ((triggers.genres as string[]).includes(genre)) score += 2;
      }
      // Gênero excluído no trigger → a pergunta perde força (nunca some:
      // demote, não remoção, para não esvaziar o banco com N exclusões).
      if (
        excludedGenres.size > 0 &&
        (triggers.genres as string[]).some((genre) => excludedGenres.has(genre))
      ) {
        score -= 4;
      }
    }
    if (avoided.has(entry.category)) score -= 2;
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const fresh = scored.filter((s) => !excluded.has(s.entry.id));
  const picked = fresh.slice(0, limit).map((s) => s.entry);
  if (picked.length >= 4) return picked;

  // Poucas opções: readmite recentes melhores (relevância > variedade).
  for (const { entry } of scored) {
    if (picked.length >= 4) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked;
}
