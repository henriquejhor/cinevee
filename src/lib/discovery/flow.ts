/**
 * Controlador do questionário /descobrir (vanilla TS, sem frameworks).
 *
 * - Uma pergunta por vez, dirigida a dados (steps + AdaptiveQuestion).
 * - Single-select avança sozinho; multi-select usa "Continuar".
 * - Persiste etapa + respostas no localStorage a cada mudança e
 *   restaura automaticamente ao voltar (sem modal de continuação).
 * - Sessão com TTL de 20 min de inatividade (Etapa 20): só ações
 *   relevantes renovam `lastActivityAt`; abrir/reload/restaurar não.
 */
import {
  COMMITMENT_OPTIONS,
  CONTENT_TYPE_OPTIONS,
  GENRE_NO_PREFERENCE_LABEL,
  GENRE_OPTIONS,
  isRecommendationRefinement,
  MAX_GENRES,
  MOCK_ADAPTIVE_QUESTION,
  MOOD_OPTIONS,
  PROVIDER_ANY_LABEL,
  PROVIDER_OPTIONS,
  RECOMMENDATIONS_STORAGE_KEY,
  REFINEMENT_OPTIONS,
  type AdaptiveOption,
  type CommitmentKey,
  type ContentTypeChoice,
  type DiscoveryAnswers,
  type DiscoveryProvider,
  type DiscoveryStep,
  type GenreKey,
  type MoodKey,
  type RecommendationRefinement,
} from "../../types/discovery";
import type { ContentItem } from "../../types/content";
import type { Recommendation } from "../gemini/rankRecommendations";
import {
  DISCOVERY_ICONS,
  STEP_EYEBROWS,
  genreCountLabel,
  optionDisplay,
} from "./display";
import {
  createInitialAnswers,
  isDiscoverySessionExpired,
  parseCategoryHistory,
  parseSeenIds,
  parseSession,
  addSeenIds,
  pushCategoryHistory,
  categoryHistoryKey,
  recommendationContextKey,
  seenKey,
  seenStorageKey,
  serializeSession,
  storageKey,
  toggleGenre,
  toggleProvider,
} from "./state";

const TRANSITION_MS = 220;
const SUMMARY_MAX_ROWS = 6;

type QuestionKind = "single-content" | "single-mood" | "multi-genres" | "single-adaptive" | "single-commitment" | "multi-providers";

interface StepDef {
  step: DiscoveryStep;
  question: string;
  hint: string;
  kind: QuestionKind;
}

function stepDefs(): StepDef[] {
  return [
    { step: 0, question: "O que você quer assistir?", hint: "", kind: "single-content" },
    { step: 1, question: "Como você quer se sentir?", hint: "Escolha o clima que combina com agora.", kind: "single-mood" },
    {
      step: 2,
      question: "Que tipo de história combina com você hoje?",
      hint: `Escolha até ${MAX_GENRES}. A gente cuida do resto.`,
      kind: "multi-genres",
    },
    {
      step: 3,
      // Renderizada a partir dos dados (mock hoje, Gemini depois).
      question: MOCK_ADAPTIVE_QUESTION.question,
      hint: "Uma resposta rápida para afinar a recomendação.",
      kind: "single-adaptive",
    },
    { step: 4, question: "Quanto você quer se envolver agora?", hint: "", kind: "single-commitment" },
    { step: 5, question: "Onde você pode assistir?", hint: "Escolha uma ou mais", kind: "multi-providers" },
  ];
}

interface OptionItem {
  value: string;
  label: string;
}

function optionsFor(kind: QuestionKind): OptionItem[] {
  switch (kind) {
    case "single-content":
      return CONTENT_TYPE_OPTIONS;
    case "single-mood":
      return MOOD_OPTIONS;
    case "multi-genres":
      return [
        ...GENRE_OPTIONS,
        { value: "none", label: GENRE_NO_PREFERENCE_LABEL },
      ];
    case "single-adaptive":
      return MOCK_ADAPTIVE_QUESTION.options;
    case "single-commitment":
      return COMMITMENT_OPTIONS;
    case "multi-providers":
      return [
        ...PROVIDER_OPTIONS,
        { value: "any", label: PROVIDER_ANY_LABEL },
      ];
  }
}

function labelOf(options: OptionItem[], value: string | null): string | null {
  if (value === null) return null;
  const found = options.find((o) => o.value === value);
  return found ? found.label : null;
}

function isPressed(kind: QuestionKind, value: string, answers: DiscoveryAnswers): boolean {
  switch (kind) {
    case "multi-genres":
      return value === "none" ? answers.preferredGenres.length === 0 : answers.preferredGenres.includes(value as GenreKey);
    case "multi-providers":
      return answers.providers.includes(value as DiscoveryProvider);
    case "single-content":
      return answers.contentType === value;
    case "single-mood":
      return answers.mood === value;
    case "single-adaptive":
      return answers.adaptive.value === value;
    case "single-commitment":
      return answers.commitment === value;
  }
}

const SELECTED_CLASSES = ["border-primary", "bg-primary/10"];

export function startDiscoveryFlow(): void {
  // Tipos declarados via `as` + guarda instanceof abaixo (o narrowing
  // não atravessa closures; a guarda valida em runtime antes de seguir).
  const stage = document.querySelector("[data-discovery-stage]") as HTMLElement;
  const questionEl = document.querySelector("[data-discovery-question]") as HTMLElement;
  const hintEl = document.querySelector("[data-discovery-hint]") as HTMLElement;
  const optionsEl = document.querySelector("[data-discovery-options]") as HTMLElement;
  const continueBtn = document.querySelector("[data-discovery-continue]") as HTMLButtonElement;
  const statusEl = document.querySelector("[data-discovery-status]") as HTMLElement;
  const countEl = document.querySelector("[data-progress-count]") as HTMLElement;
  const fillEl = document.querySelector("[data-progress-fill]") as HTMLElement;
  const barEl = document.querySelector("[data-progress-bar]") as HTMLElement;
  const backBtn = document.querySelector("[data-discovery-back]") as HTMLButtonElement;
  const restartBtn = document.querySelector("[data-discovery-restart]") as HTMLButtonElement;
  const optionTemplate = document.getElementById(
    "discovery-option-template",
  ) as HTMLTemplateElement;
  // Hooks puramente visuais (ausência não quebra o fluxo).
  const eyebrowRow = document.querySelector("[data-eyebrow-row]");
  const eyebrowEl = document.querySelector("[data-discovery-eyebrow]");
  const eyebrowIcon = document.querySelector("[data-eyebrow-icon]");
  const genreCountEl = document.querySelector("[data-genre-count]");

  if (
    !(stage instanceof HTMLElement) ||
    !(questionEl instanceof HTMLElement) ||
    !(hintEl instanceof HTMLElement) ||
    !(optionsEl instanceof HTMLElement) ||
    !(continueBtn instanceof HTMLButtonElement) ||
    !(statusEl instanceof HTMLElement) ||
    !(countEl instanceof HTMLElement) ||
    !(fillEl instanceof HTMLElement) ||
    !(barEl instanceof HTMLElement) ||
    !(backBtn instanceof HTMLButtonElement) ||
    !(restartBtn instanceof HTMLButtonElement) ||
    !(optionTemplate instanceof HTMLTemplateElement)
  ) {
    return;
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let step: DiscoveryStep = 0;
  let answers: DiscoveryAnswers = createInitialAnswers();
  let restored = false;
  /**
   * Relógio de inatividade da jornada (Etapa 20, epoch ms). Só ações
   * relevantes o renovam via touchSession(); abrir/reload/restaurar/
   * renderizar preservam o valor. 0 = sem atividade registrada.
   */
  let sessionLastActivityAt = 0;
  /** Kind da pergunta atual — só para visuais (ícones, contagem, layout). */
  let currentKind: QuestionKind | null = null;
  /** Guarda de concorrência da pergunta adaptativa (resposta velha nunca vence). */
  let adaptiveSeq = 0;
  let adaptiveAborter: AbortController | null = null;
  /** Guarda da requisição de recomendações + intervalo das mensagens. */
  let recSeq = 0;
  let recAborter: AbortController | null = null;
  let processingTimer: ReturnType<typeof setInterval> | null = null;
  /** `true` quando o processamento é um reroll (mensagens próprias). */
  let rerollMode = false;
  /**
   * Preferências permanentes da conta (Supabase, via GET
   * /api/profile/preferences). Nunca persistidas no localStorage:
   * UserPreferences (conta) ≠ DiscoveryAnswers (sessão).
   */
  let profileExcluded: GenreKey[] = [];
  let profileProviders: DiscoveryProvider[] = [];
  /** Providers atuais vieram do default do perfil (nota discreta na etapa). */
  let providersFromProfile = false;
  /** Guarda do reset pós-logout: não apagar respostas manuais frescas. */
  let userInteracted = false;
  /**
   * Refinamento rápido ativo (UM por vez, null = base). Sobrevive ao
   * reroll; some ao refazer escolhas/recomeçar/mudar respostas.
   */
  let activeRefinement: RecommendationRefinement | null = null;

  interface StoredRecommendations {
    contextKey: string;
    /** Versão opaca do histórico (resposta do servidor; ausente = snapshot antigo). */
    contextVersion?: string;
    /** Identifica o conjunto exibido (rerolls das mesmas respostas). */
    runId: number;
    /** Refinamento que gerou este conjunto (null = base). */
    refinement: RecommendationRefinement | null;
    primary: Recommendation | null;
    alternatives: Recommendation[];
    updatedAt: string;
  }

  function stopProcessingMessages(): void {
    if (processingTimer !== null) {
      clearInterval(processingTimer);
      processingTimer = null;
    }
  }

  /** Respostas mudaram → resultado anterior desatualizado. */
  function invalidateRecommendations(): void {
    // Limpa também o refinamento: nunca influenciar silenciosamente a
    // próxima geração a partir de respostas diferentes.
    activeRefinement = null;
    try {
      window.localStorage.removeItem(RECOMMENDATIONS_STORAGE_KEY);
    } catch {
      // Ignora: segue sem cache.
    }
  }

  function saveRecommendations(
    result: { primary: Recommendation | null; alternatives: Recommendation[] },
    contextVersion?: string,
  ): void {
    try {
      const snapshot: StoredRecommendations = {
        contextKey: recommendationContextKey(answers, profileExcluded),
        ...(typeof contextVersion === "string" && contextVersion.length > 0
          ? { contextVersion }
          : {}),
        runId: Date.now(),
        refinement: activeRefinement,
        primary: result.primary,
        alternatives: result.alternatives,
        updatedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(RECOMMENDATIONS_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Armazenamento indisponível: segue sem cache.
    }
  }

  /** Memória de diversidade: só IDs apresentados (nunca objetos). */
  function loadSeenIds(): string[] {
    try {
      const raw = window.localStorage.getItem(seenStorageKey());
      if (!raw) return [];
      return parseSeenIds(JSON.parse(raw)) ?? [];
    } catch {
      return [];
    }
  }

  function saveSeenIds(ids: string[]): void {
    try {
      window.localStorage.setItem(seenStorageKey(), JSON.stringify(ids));
    } catch {
      // Ignora: segue sem memória de diversidade.
    }
  }

  /** Registra o conjunto apresentado (só o que foi mostrado). */
  function markPresented(primary: Recommendation, alternatives: Recommendation[]): void {
    const ids = [primary, ...alternatives].map((rec) =>
      seenKey(rec.item.type, rec.item.id),
    );
    saveSeenIds(addSeenIds(loadSeenIds(), ids));
  }

  /** Categorias adaptativas já apresentadas (diversidade entre fluxos). */
  function loadCategoryHistory(): string[] {
    try {
      const raw = window.localStorage.getItem(categoryHistoryKey());
      if (!raw) return [];
      return parseCategoryHistory(JSON.parse(raw)) ?? [];
    } catch {
      return [];
    }
  }

  function recordCategory(category: string): void {
    if (!category) return;
    try {
      const raw = window.localStorage.getItem(categoryHistoryKey());
      const current = raw ? (parseCategoryHistory(JSON.parse(raw)) ?? []) : [];
      window.localStorage.setItem(
        categoryHistoryKey(),
        JSON.stringify(pushCategoryHistory(current, category)),
      );
    } catch {
      // Ignora: segue sem memória de categorias.
    }
  }

  function loadRecommendations(): StoredRecommendations | null {
    try {
      const raw = window.localStorage.getItem(RECOMMENDATIONS_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const snapshot = parsed as Record<string, unknown>;
      if (typeof snapshot.contextKey !== "string") return null;
      if (snapshot.contextKey !== recommendationContextKey(answers, profileExcluded)) return null;
      if (
        snapshot.primary !== null &&
        !isValidRecommendation(snapshot.primary)
      ) {
        return null;
      }
      if (
        !Array.isArray(snapshot.alternatives) ||
        !snapshot.alternatives.every(isValidRecommendation)
      ) {
        return null;
      }
      return {
        contextKey: snapshot.contextKey,
        runId: typeof snapshot.runId === "number" ? snapshot.runId : 0,
        refinement: isRecommendationRefinement(snapshot.refinement)
          ? snapshot.refinement
          : null,
        primary: snapshot.primary as Recommendation | null,
        alternatives: snapshot.alternatives as Recommendation[],
        updatedAt:
          typeof snapshot.updatedAt === "string"
            ? snapshot.updatedAt
            : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  function isValidRecommendation(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const rec = value as Record<string, unknown>;
    if (typeof rec.reason !== "string" || typeof rec.rank !== "number") return false;
    const item = rec.item as Record<string, unknown> | undefined;
    return (
      !!item &&
      typeof item.id === "number" &&
      (item.type === "movie" || item.type === "tv") &&
      typeof item.title === "string" &&
      item.title.length > 0
    );
  }

  try {
    const raw = window.localStorage.getItem(storageKey());
    if (raw) {
      const session = parseSession(JSON.parse(raw));
      if (session) {
        // TTL de inatividade (Etapa 20): expirou (ou storage legado sem
        // relógio) → apaga SÓ a jornada (sessão + snapshot de resultado) e
        // abre o início. Memória de diversidade (seen/categorias) e dados
        // da conta nunca são tocados aqui.
        if (isDiscoverySessionExpired(session.lastActivityAt)) {
          const hadJourney = session.step !== 0 || hasAnyAnswer(session.answers);
          try {
            window.localStorage.removeItem(storageKey());
            window.localStorage.removeItem(RECOMMENDATIONS_STORAGE_KEY);
          } catch {
            // Segue com o estado zerado em memória.
          }
          step = 0;
          answers = createInitialAnswers();
          sessionLastActivityAt = 0;
          if (hadJourney) {
            // Anunciado após o primeiro render (renderStep no fim do setup).
            restored = false;
            queueMicrotask(() =>
              announce("Sessão anterior expirada. Comece uma nova descoberta."),
            );
          }
        } else {
          step = session.step;
          answers = session.answers;
          sessionLastActivityAt = session.lastActivityAt;
          restored = step !== 0 || hasAnyAnswer(answers);
        }
      }
    }
  } catch {
    step = 0;
    answers = createInitialAnswers();
  }

  function hasAnyAnswer(a: DiscoveryAnswers): boolean {
    return (
      a.contentType !== null ||
      a.mood !== null ||
      a.preferredGenres.length > 0 ||
      a.adaptive.value !== null ||
      a.commitment !== null ||
      !(a.providers.length === 1 && a.providers[0] === "any")
    );
  }

  /**
   * Salva a jornada SEM renovar o relógio de inatividade (Etapa 20).
   * Abrir /descobrir, reload, restaurar storage, voltar de /titulo e
   * re-renderizar usam este caminho — a sessão antiga continua expirando.
   */
  function persist(): void {
    try {
      window.localStorage.setItem(
        storageKey(),
        serializeSession(step, answers, sessionLastActivityAt),
      );
    } catch {
      // Armazenamento indisponível: o fluxo segue só em memória.
    }
  }

  /**
   * Ação relevante da jornada (responder/alterar/avançar, gerar, reroll,
   * refinement, replacement): renova o relógio e persiste.
   */
  function touchSession(): void {
    sessionLastActivityAt = Date.now();
    persist();
  }

  /** sessionStorage (não localStorage): só marca "sessão de perfil ativa". */
  const PROFILE_ACTIVE_KEY = "cinevee.profileActive";

  /** Valida o GET /api/profile/preferences (servidor já validou; confere de novo). */
  function parseProfilePreferences(data: unknown): {
    excludedGenres: GenreKey[];
    streamingProviders: DiscoveryProvider[];
  } | null {
    if (typeof data !== "object" || data === null) return null;
    const body = data as Record<string, unknown>;
    const genreValues: readonly string[] = GENRE_OPTIONS.map((o) => o.value);
    const providerValues: readonly string[] = PROVIDER_OPTIONS.map((o) => o.value);
    if (!Array.isArray(body.excludedGenres) || !Array.isArray(body.streamingProviders)) {
      return null;
    }
    const excluded = [...new Set(body.excludedGenres)].filter(
      (g): g is GenreKey => typeof g === "string" && genreValues.includes(g),
    );
    const providers = [...new Set(body.streamingProviders)].filter(
      (p): p is DiscoveryProvider => typeof p === "string" && providerValues.includes(p),
    );
    return { excludedGenres: excluded, streamingProviders: providers };
  }

  /** Resultado em cache menciona gênero hoje excluído no perfil? */
  function cachedResultHasExcludedGenre(): boolean {
    if (profileExcluded.length === 0) return false;
    try {
      const raw = window.localStorage.getItem(RECOMMENDATIONS_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const recs = [parsed.primary, ...(Array.isArray(parsed.alternatives) ? parsed.alternatives : [])];
      const labels = new Set(
        profileExcluded
          .map((g) => GENRE_OPTIONS.find((o) => o.value === g)?.label)
          .filter((l): l is string => typeof l === "string"),
      );
      return recs.some((rec) => {
        if (typeof rec !== "object" || rec === null) return false;
        const genres = (rec as Record<string, unknown>).item as Record<string, unknown> | undefined;
        const list = genres?.genres;
        return Array.isArray(list) && list.some((g) => typeof g === "string" && labels.has(g));
      });
    } catch {
      return false;
    }
  }

  /**
   * Aplica preferências da conta à sessão (§9, §11, §12):
   * - remove excluídos permanentes de preferredGenres (saneia sessão
   *   antiga) + invalida adaptativa/resultado;
   * - resultado em cache com gênero excluído → invalidado;
   * - sessão realmente nova (passo 0, sem respostas) herda providers do
   *   perfil como default; sessão existente nunca é sobrescrita.
   */
  function applyProfilePreferences(): void {
    const excludedSet = new Set(profileExcluded);
    let changed = false;

    const before = answers.preferredGenres.length;
    answers.preferredGenres = answers.preferredGenres.filter((g) => !excludedSet.has(g));
    if (answers.preferredGenres.length !== before) {
      answers.adaptive = { category: "", value: null };
      invalidateRecommendations();
      changed = true;
    }
    if (cachedResultHasExcludedGenre()) {
      invalidateRecommendations();
      changed = true;
    }

    if (step === 0 && !hasAnyAnswer(answers) && profileProviders.length > 0) {
      answers.providers = [...profileProviders];
      providersFromProfile = true;
      changed = true;
    }

    if (changed) persist();
    // Re-renderiza etapas que dependem das respostas ou exibem notas do
    // perfil (gêneros, adaptativa, providers, resumo) — nunca exibir
    // estado contraditório nem omitir as indicações discretas.
    const showsProfileUi =
      currentKind === "multi-genres" || currentKind === "multi-providers";
    if (showsProfileUi || (changed && (step === 3 || step === 6))) {
      renderStep(step);
    }
  }

  /**
   * Carrega preferências da conta (uma vez, no início). Enforcement real é
   * server-side nos endpoints; aqui é só UI/defaults/saneamento.
   * - 401 após sessão de perfil ativa (logout) → reseta a sessão local
   *   para não vazar preferências da conta anterior;
   * - erro temporário com login → segue com preferências vazias (§16).
   */
  async function loadProfilePreferences(): Promise<void> {
    let response: Response | null = null;
    try {
      response = await fetch("/api/profile/preferences", { credentials: "same-origin" });
    } catch {
      return;
    }
    if (!response) return;

    if (response.status === 401) {
      try {
        if (window.sessionStorage.getItem(PROFILE_ACTIVE_KEY) === "1") {
          window.sessionStorage.removeItem(PROFILE_ACTIVE_KEY);
          if (!userInteracted) {
            step = 0;
            answers = createInitialAnswers();
            providersFromProfile = false;
            invalidateRecommendations();
            persist();
            renderStep(0);
            announce("Sessão anterior encerrada. Comece uma nova descoberta.");
          }
        }
      } catch {
        // Segue com a sessão local como está.
      }
      return;
    }
    if (!response.ok) return;

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      return;
    }
    const parsed = parseProfilePreferences(data);
    if (!parsed) return;
    profileExcluded = parsed.excludedGenres;
    profileProviders = parsed.streamingProviders;
    try {
      window.sessionStorage.setItem(PROFILE_ACTIVE_KEY, "1");
    } catch {
      // Sem sessionStorage: segue sem detecção de troca de conta.
    }
    applyProfilePreferences();
  }

  function announce(message: string): void {
    statusEl.textContent = message;
  }

  function renderProgress(): void {
    const counted = step >= 1 && step <= 5;
    countEl.textContent = counted ? `${step} de 5` : "";
    countEl.style.display = counted ? "" : "none";
    const ratio = step >= 6 ? 1 : step >= 1 ? step / 5 : 0;
    fillEl.style.width = `${Math.round(ratio * 100)}%`;
    barEl.setAttribute("aria-valuenow", String(step >= 6 ? 5 : Math.min(Math.max(step, 0), 5)));
    // Sem voltar na escolha inicial nem durante o processamento.
    const hideBack = step === 0 || step === 7;
    backBtn.style.display = hideBack ? "none" : "";
    backBtn.disabled = hideBack;
    // Na tela de resultados o topo fica limpo: as ações específicas
    // (incluindo "Começar de novo") estão na parte inferior.
    restartBtn.style.display = step === 8 ? "none" : "";
  }

  function setPressed(button: HTMLButtonElement, pressed: boolean): void {
    button.setAttribute("aria-pressed", String(pressed));
    if (pressed) {
      button.classList.remove("border-base-300", "bg-base-200");
      button.classList.add(...SELECTED_CLASSES);
    } else {
      button.classList.add("border-base-300", "bg-base-200");
      button.classList.remove(...SELECTED_CLASSES);
    }
    const check = button.querySelector("[data-option-check]");
    if (check instanceof HTMLElement || check instanceof SVGElement) {
      (check as Element).classList.toggle("hidden", !pressed);
    }
  }

  function clearOptions(): void {
    while (optionsEl.firstChild) optionsEl.removeChild(optionsEl.firstChild);
  }

  function isProfileExcludedGenre(kind: QuestionKind, value: string): boolean {
    return (
      kind === "multi-genres" &&
      value !== "none" &&
      (profileExcluded as string[]).includes(value)
    );
  }

  function buildOptionButton(item: OptionItem, kind: QuestionKind): HTMLButtonElement | null {
    const node = optionTemplate.content.cloneNode(true) as DocumentFragment;
    const button = node.querySelector("[data-option]");
    if (!(button instanceof HTMLButtonElement)) return null;
    button.dataset.value = item.value;
    const label = button.querySelector("[data-option-label]");
    if (label) label.textContent = item.label;
    // Gênero permanentemente excluído no perfil: visível, porém discreto e
    // não selecionável (aria-disabled + guarda no clique, sem poluir a UI).
    if (isProfileExcludedGenre(kind, item.value)) {
      button.setAttribute("aria-disabled", "true");
      button.classList.add("opacity-50");
    }
    // Visual por opção (ícone + microcopy do mapa de exibição).
    const display = optionDisplay(kind, item.value);
    const iconSlot = button.querySelector("[data-option-icon]");
    if (iconSlot instanceof HTMLElement) {
      const svg = (display.icon && DISCOVERY_ICONS[display.icon]) || "";
      if (svg) {
        iconSlot.innerHTML = svg;
        iconSlot.style.display = "";
      } else {
        iconSlot.style.display = "none";
      }
    }
    const desc = button.querySelector("[data-option-desc]");
    if (desc) desc.textContent = display.description ?? "";
    setPressed(button, isPressed(kind, item.value, answers));
    button.addEventListener("click", () => onOptionClick(kind, item.value, button));
    return button;
  }

  function onOptionClick(kind: QuestionKind, value: string, button: HTMLButtonElement): void {
    userInteracted = true;
    if (isProfileExcludedGenre(kind, value)) {
      const label = button.querySelector("[data-option-label]");
      const name = label?.textContent?.trim() || "Este gênero";
      announce(`${name} é evitado no seu perfil e não pode ser selecionado.`);
      return;
    }
    switch (kind) {
      case "single-content": {
        answers.contentType = value as ContentTypeChoice;
        setPressed(button, true);
        touchSession();
        invalidateRecommendations();
        goTo(1);
        return;
      }
      case "single-mood": {
        answers.mood = value as MoodKey;
        setPressed(button, true);
        touchSession();
        invalidateRecommendations();
        goTo(2);
        return;
      }
      case "single-adaptive": {
        // Preserva pergunta/opções em cache; só registra a resposta.
        answers.adaptive = { ...answers.adaptive, value };
        setPressed(button, true);
        touchSession();
        invalidateRecommendations();
        goTo(4);
        return;
      }
      case "single-commitment": {
        answers.commitment = value as CommitmentKey;
        setPressed(button, true);
        touchSession();
        invalidateRecommendations();
        goTo(5);
        return;
      }
      case "multi-genres": {
        const result = toggleGenre(answers.preferredGenres, value as GenreKey | "none");
        answers.preferredGenres = result.genres;
        touchSession();
        invalidateRecommendations();
        if (result.limited) announce(`Escolha até ${MAX_GENRES} gêneros.`);
        refreshPressedStates(kind);
        return;
      }
      case "multi-providers": {
        // Escolha manual substitui o default do perfil (sessão ≠ conta).
        providersFromProfile = false;
        answers.providers = toggleProvider(answers.providers, value as DiscoveryProvider);
        touchSession();
        invalidateRecommendations();
        refreshPressedStates(kind);
        return;
      }
    }
  }

  function refreshPressedStates(kind: QuestionKind): void {
    const buttons = optionsEl.querySelectorAll("[data-option]");
    buttons.forEach((el) => {
      if (el instanceof HTMLButtonElement && typeof el.dataset.value === "string") {
        setPressed(el, isPressed(kind, el.dataset.value, answers));
      }
    });
    updateGenreCount(kind);
  }

  /** Contador "n/3 selecionados" — só visível nos gêneros. */
  function updateGenreCount(kind: QuestionKind): void {
    if (!(genreCountEl instanceof HTMLElement)) return;
    if (kind === "multi-genres") {
      genreCountEl.textContent = genreCountLabel(answers.preferredGenres.length);
      genreCountEl.style.display = "";
    } else {
      genreCountEl.style.display = "none";
    }
  }

  /** Eyebrow contextual por etapa (oculto quando vazio). */
  function renderEyebrow(target: DiscoveryStep): void {
    const text = STEP_EYEBROWS[target] ?? "";
    if (eyebrowEl instanceof HTMLElement) eyebrowEl.textContent = text;
    if (eyebrowRow instanceof HTMLElement) {
      eyebrowRow.style.display = text ? "flex" : "none";
    }
    // O símbolo sparkles assina a pergunta personalizada.
    if (eyebrowIcon instanceof HTMLElement) {
      eyebrowIcon.style.display = target === 3 ? "" : "none";
    }
  }

  function renderStep(target: DiscoveryStep): void {
    step = target;
    persist();
    stopProcessingMessages();
    renderProgress();
    stage.dataset.view = "step";

    if (step === 6) {
      renderCompletion();
      return;
    }
    if (step === 7) {
      renderProcessingStep();
      return;
    }
    if (step === 8) {
      renderResultsStep();
      return;
    }

    const def = stepDefs().find((d) => d.step === step);
    if (!def) return;
    currentKind = def.kind;

    // Passo adaptativo: pergunta dinâmica (cache → loading → Gemini/fallback).
    if (def.kind === "single-adaptive") {
      renderAdaptiveStep();
      return;
    }

    renderEyebrow(target);
    questionEl.textContent = def.question;
    hintEl.textContent = def.hint;
    hintEl.style.display = def.hint ? "" : "none";
    // O layout das opções varia por kind via CSS ([data-kind]).
    optionsEl.dataset.kind = def.kind;
    updateGenreCount(def.kind);
    clearOptions();

    const isMulti = def.kind === "multi-genres" || def.kind === "multi-providers";
    continueBtn.style.display = isMulti ? "" : "none";

    for (const item of optionsFor(def.kind)) {
      const button = buildOptionButton(item, def.kind);
      if (button) optionsEl.appendChild(button);
    }

    appendProfileNote(def.kind);

    questionEl.focus({ preventScroll: true });
  }

  /**
   * Indicações discretas de integração com o perfil (só quando ativas):
   * gêneros evitados desabilitados / streamings pré-selecionados, sempre
   * com link "Editar perfil". Nada polui a interface no caso padrão.
   */
  function appendProfileNote(kind: QuestionKind): void {
    let text: string | null = null;
    if (kind === "multi-genres" && profileExcluded.length > 0) {
      text = "Algumas opções seguem suas preferências do perfil.";
    } else if (kind === "multi-providers" && providersFromProfile) {
      text = "Seus streamings foram selecionados pelo perfil.";
    }
    if (!text) return;
    const note = document.createElement("p");
    // col-span-full: ocupa a linha toda na grade de providers; inócuo no
    // flex-wrap dos gêneros (onde w-full já resolve).
    note.className = "col-span-full mt-3 w-full text-xs text-base-content/60";
    note.append(document.createTextNode(`${text} `));
    const link = document.createElement("a");
    link.href = "/perfil";
    link.className = "font-semibold text-primary underline-offset-4 hover:underline";
    link.textContent = "Editar perfil";
    note.appendChild(link);
    optionsEl.appendChild(note);
  }

  /**
   * Fingerprint do contexto que gera a pergunta adaptativa.
   * Mudou contentType/mood/gêneros/exclusões do perfil → a pergunta
   * anterior invalida (nunca reaproveitar pergunta de outro contexto).
   */
  function adaptiveContextKey(): string {
    const genres = [...answers.preferredGenres].sort().join(",");
    const permanent = [...profileExcluded].sort().join(",");
    return `${answers.contentType}|${answers.mood}|${genres}|${permanent}`;
  }

  function isValidAdaptivePayload(data: unknown): data is {
    questionId: string;
    category: string;
    question: string;
    options: AdaptiveOption[];
  } {
    if (typeof data !== "object" || data === null) return false;
    const { questionId, category, question, options } = data as Record<string, unknown>;
    if (typeof questionId !== "string" || questionId.length === 0) return false;
    if (typeof category !== "string" || category.length === 0) return false;
    if (typeof question !== "string" || question.length === 0) return false;
    if (!Array.isArray(options) || options.length === 0 || options.length > 8) {
      return false;
    }
    return options.every(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        typeof (option as Record<string, unknown>).value === "string" &&
        ((option as Record<string, unknown>).value as string).length > 0 &&
        typeof (option as Record<string, unknown>).label === "string" &&
        ((option as Record<string, unknown>).label as string).length > 0,
    );
  }

  function renderAdaptiveQuestion(question: string, options: AdaptiveOption[]): void {
    renderEyebrow(3);
    questionEl.textContent = question;
    hintEl.textContent = "Uma resposta rápida para afinar a recomendação.";
    hintEl.style.display = "";
    optionsEl.dataset.kind = "single-adaptive";
    updateGenreCount("single-adaptive");
    clearOptions();
    continueBtn.style.display = "none";

    for (const item of options) {
      const button = buildOptionButton(item, "single-adaptive");
      if (button) optionsEl.appendChild(button);
    }
  }

  function renderAdaptiveLoading(): void {
    renderEyebrow(3);
    questionEl.textContent = "Afinando sua escolha...";
    hintEl.textContent = "Estamos escolhendo a pergunta que mais ajuda agora.";
    hintEl.style.display = "";
    optionsEl.dataset.kind = "single-adaptive";
    updateGenreCount("single-adaptive");
    clearOptions();
    continueBtn.style.display = "none";

    const loading = document.createElement("div");
    loading.setAttribute("aria-hidden", "true");
    loading.className = "flex flex-col gap-3";
    for (let i = 0; i < 3; i++) {
      const row = document.createElement("div");
      row.className = "flex items-center gap-4 rounded-2xl border border-base-300 px-5 py-4";
      const icon = document.createElement("div");
      icon.className = "skeleton h-6 w-6 shrink-0 rounded-full";
      const text = document.createElement("div");
      text.className = "flex-1";
      const line = document.createElement("div");
      line.className = "skeleton h-4 w-2/3";
      text.appendChild(line);
      row.append(icon, text);
      loading.appendChild(row);
    }
    optionsEl.appendChild(loading);
    announce("Escolhendo a melhor pergunta para você...");
  }

  function applyAdaptiveResult(
    key: string,
    category: string,
    question: string,
    options: AdaptiveOption[],
    questionId?: string,
  ): void {
    // Resposta antiga pertence a outra pergunta → invalidada.
    answers.adaptive = { category, value: null, question, options, contextKey: key };
    if (questionId) answers.adaptive.questionId = questionId;
    persist();
  }

  function resolveAdaptiveView(mySeq: number): void {
    if (mySeq !== adaptiveSeq || step !== 3) return;
    // Memória de diversidade: ID da definição (ou categoria legada).
    if (answers.adaptive.questionId) recordCategory(answers.adaptive.questionId);
    else if (answers.adaptive.category) recordCategory(answers.adaptive.category);
    renderAdaptiveQuestion(
      answers.adaptive.question ?? MOCK_ADAPTIVE_QUESTION.question,
      answers.adaptive.options ?? MOCK_ADAPTIVE_QUESTION.options,
    );
    announce(`Pergunta pronta. ${answers.adaptive.question ?? ""}`);
    if (stage.contains(document.activeElement)) {
      questionEl.focus({ preventScroll: true });
    }
  }

  function useAdaptiveFallback(key: string, mySeq: number): void {
    applyAdaptiveResult(
      key,
      MOCK_ADAPTIVE_QUESTION.category,
      MOCK_ADAPTIVE_QUESTION.question,
      MOCK_ADAPTIVE_QUESTION.options.map((option) => ({ ...option })),
      "story_focus_01",
    );
    resolveAdaptiveView(mySeq);
  }

  function fetchAdaptiveQuestion(key: string): void {
    if (adaptiveAborter) adaptiveAborter.abort();
    adaptiveAborter = new AbortController();
    const mySeq = (adaptiveSeq += 1);

    // Sem contexto mínimo (ex.: sessão incompleta restaurada) → fallback local.
    if (!answers.contentType || !answers.mood) {
      useAdaptiveFallback(key, mySeq);
      return;
    }

    renderAdaptiveLoading();

    fetch("/api/discovery/adaptive-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: answers.contentType,
        mood: answers.mood,
        preferredGenres: answers.preferredGenres,
        sessionExcludedGenres: answers.sessionExcludedGenres,
        recentQuestionIds: loadCategoryHistory().slice(-8),
      }),
      signal: adaptiveAborter.signal,
    })
      .then((response) => {
        if (mySeq !== adaptiveSeq) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data: unknown) => {
        if (mySeq !== adaptiveSeq || step !== 3) return;
        if (!isValidAdaptivePayload(data)) throw new Error("payload inválido");
        // Options sempre da taxonomia local (endpoint já garante; valida de novo).
        const options = data.options
          .filter(
            (option) =>
              typeof option.value === "string" &&
              option.value.length > 0 &&
              typeof option.label === "string" &&
              option.label.length > 0,
          )
          .slice(0, 8)
          .map((option) => ({ value: option.value, label: option.label }));
        if (options.length === 0) throw new Error("sem opções");
        applyAdaptiveResult(key, data.category, data.question.trim(), options, data.questionId);
        resolveAdaptiveView(mySeq);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (mySeq !== adaptiveSeq || step !== 3) return;
        useAdaptiveFallback(key, mySeq);
      });
  }

  function renderAdaptiveStep(): void {
    const key = adaptiveContextKey();
    const cached = answers.adaptive;
    // Pergunta em cache e contexto inalterado → reutiliza, sem nova chamada.
    if (
      cached.question &&
      cached.contextKey === key &&
      cached.options &&
      cached.options.length > 0 &&
      cached.category
    ) {
      renderAdaptiveQuestion(cached.question, cached.options);
      questionEl.focus({ preventScroll: true });
      return;
    }
    fetchAdaptiveQuestion(key);
  }

  function goTo(target: DiscoveryStep): void {
    if (reduceMotion.matches) {
      renderStep(target);
      return;
    }
    stage.classList.add("opacity-0", "translate-x-4");
    window.setTimeout(() => {
      renderStep(target);
      requestAnimationFrame(() => {
        stage.classList.remove("opacity-0", "translate-x-4");
      });
    }, TRANSITION_MS);
  }

  function summaryRows(): [string, string][] {
    const genreLabels = answers.preferredGenres
      .map((g) => labelOf(GENRE_OPTIONS, g))
      .filter((l): l is string => l !== null);
    const providerLabels = answers.providers.includes("any")
      ? [PROVIDER_ANY_LABEL]
      : answers.providers
          .map((p) => labelOf(PROVIDER_OPTIONS, p))
          .filter((l): l is string => l !== null);
    const rows: [string, string][] = [
      ["Tipo", labelOf(CONTENT_TYPE_OPTIONS, answers.contentType) ?? "—"],
      ["Sensação", labelOf(MOOD_OPTIONS, answers.mood) ?? "—"],
      ["Histórias", genreLabels.length > 0 ? genreLabels.join(", ") : "Sem preferência"],
      [
        "Foco",
        labelOf(
          answers.adaptive.options ?? MOCK_ADAPTIVE_QUESTION.options,
          answers.adaptive.value,
        ) ?? "—",
      ],
      ["Envolvimento", labelOf(COMMITMENT_OPTIONS, answers.commitment) ?? "—"],
      ["Onde assistir", providerLabels.join(", ")],
    ];
    return rows.slice(0, SUMMARY_MAX_ROWS);
  }

  function renderCompletion(): void {
    currentKind = null;
    stage.dataset.view = "done";
    if (eyebrowRow instanceof HTMLElement) eyebrowRow.style.display = "none";
    if (genreCountEl instanceof HTMLElement) genreCountEl.style.display = "none";
    questionEl.textContent = "Pronto para descobrir?";
    hintEl.textContent = "Já entendemos melhor o que combina com você.";
    hintEl.style.display = "";
    clearOptions();
    continueBtn.style.display = "none";

    const list = document.createElement("dl");
    list.className = "overflow-hidden rounded-2xl border border-base-300 bg-base-200";
    for (const [term, value] of summaryRows()) {
      const row = document.createElement("div");
      row.className = "flex items-baseline justify-between gap-4 border-b border-base-300/60 px-4 py-3 last:border-0";
      const dt = document.createElement("dt");
      dt.className = "shrink-0 text-xs font-semibold uppercase tracking-wider text-base-content/50";
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.className = "min-w-0 text-right text-sm font-medium";
      dd.textContent = value;
      row.append(dt, dd);
      list.appendChild(row);
    }
    optionsEl.appendChild(list);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn btn-primary mt-6 min-h-12 w-full rounded-full";
    action.textContent = "Encontrar recomendações";
    action.addEventListener("click", () => {
      // Geração nova a partir do resumo: começa sem refinamento.
      activeRefinement = null;
      rerollMode = false;
      touchSession();
      goTo(7);
    });
    optionsEl.appendChild(action);

    questionEl.focus({ preventScroll: true });
  }

  // ---------- Recomendações (passos 7–8) ----------

  const PROCESSING_MESSAGES = [
    "Entendendo suas escolhas…",
    "Procurando candidatos…",
    "Comparando histórias…",
    "Encontramos algumas opções…",
  ];

  const REROLL_MESSAGES = [
    "Procurando outras opções…",
    "Explorando novos títulos…",
    "Comparando outras histórias…",
    "Quase lá…",
  ];

  /** Mensagens contextuais do processamento refinado (uma por refinamento). */
  const REFINEMENT_MESSAGES: Record<RecommendationRefinement, readonly string[]> = {
    shorter: [
      "Procurando opções mais rápidas…",
      "Comparando durações…",
      "Quase lá…",
    ],
    newer: [
      "Buscando histórias mais recentes…",
      "Comparando lançamentos…",
      "Quase lá…",
    ],
    more_intense: [
      "Aumentando a intensidade…",
      "Comparando climas…",
      "Quase lá…",
    ],
    less_popular: [
      "Procurando boas opções fora do óbvio…",
      "Explorando hidden gems…",
      "Quase lá…",
    ],
  };

  /** Ícone line-art por refinamento (mesma linguagem do discovery). */
  const REFINEMENT_ICONS: Record<RecommendationRefinement, string> = {
    shorter: "clock",
    newer: "calendar",
    more_intense: "bolt",
    less_popular: "gem",
  };

  /**
   * Tonalidade sutil por refinamento (~10% bg, borda da mesma família).
   * Dark-first (Cinematic Aurora): pastéis dessaturados, nada neon.
   * Texto sempre base-content (contraste); ícone um tom acima.
   */
  const REFINEMENT_TONE: Record<RecommendationRefinement, { chip: string; icon: string }> = {
    shorter: {
      chip: "border-sky-400/25 bg-sky-400/10 hover:border-sky-400/40 hover:bg-sky-400/[0.18]",
      icon: "text-sky-300",
    },
    newer: {
      chip: "border-cyan-400/25 bg-cyan-400/10 hover:border-cyan-400/40 hover:bg-cyan-400/[0.18]",
      icon: "text-cyan-300",
    },
    more_intense: {
      chip: "border-fuchsia-400/25 bg-fuchsia-400/10 hover:border-fuchsia-400/40 hover:bg-fuchsia-400/[0.18]",
      icon: "text-fuchsia-300",
    },
    less_popular: {
      chip: "border-indigo-400/25 bg-indigo-400/10 hover:border-indigo-400/40 hover:bg-indigo-400/[0.18]",
      icon: "text-indigo-300",
    },
  };

  /** Ícone refresh estático (mesmo desenho do sistema discovery). */
  const REROLL_ICON_SVG =
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V8h-4.5"/></svg>';

  function typeLabel(type: string): string {
    return type === "tv" ? "Série" : "Filme";
  }

  function hideAuxiliary(): void {
    if (eyebrowRow instanceof HTMLElement) eyebrowRow.style.display = "none";
    if (genreCountEl instanceof HTMLElement) genreCountEl.style.display = "none";
  }

  function posterThumb(item: ContentItem, widthClass: string): HTMLElement {
    const poster = document.createElement("div");
    poster.className = `cinevee-poster ${widthClass} shrink-0`;
    poster.style.setProperty("--ph", String(item.hue));
    poster.setAttribute("aria-hidden", "true");
    const star = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    star.setAttribute("aria-hidden", "true");
    star.setAttribute("viewBox", "0 0 24 24");
    star.setAttribute("fill", "currentColor");
    star.setAttribute("class", "absolute inset-0 m-auto h-8 w-8 text-white/25");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 2.5 14.3 9l6.7.1-5.4 4 2 6.5-5.6-3.9-5.6 3.9 2-6.5-5.4-4 6.7-.1L12 2.5Z",
    );
    star.appendChild(path);
    poster.appendChild(star);
    if (item.posterUrl) {
      const img = document.createElement("img");
      img.src = item.posterUrl;
      img.alt = `Pôster de ${item.title}`;
      img.width = 500;
      img.height = 750;
      img.loading = "lazy";
      img.className = "absolute inset-0 h-full w-full object-cover";
      poster.appendChild(img);
    }
    return poster;
  }

  function metaLine(item: ContentItem): string {
    const parts: string[] = [];
    if (typeof item.year === "number") parts.push(String(item.year));
    parts.push(typeLabel(item.type));
    if (typeof item.rating === "number") parts.push(`★ ${item.rating.toFixed(1)}`);
    return parts.join(" · ");
  }

  function renderProcessingStep(): void {
    currentKind = null;
    stage.dataset.view = "working";
    hideAuxiliary();
    const refining = !rerollMode && activeRefinement !== null;
    const messages = rerollMode
      ? REROLL_MESSAGES
      : refining && activeRefinement
        ? REFINEMENT_MESSAGES[activeRefinement]
        : PROCESSING_MESSAGES;
    questionEl.textContent = rerollMode
      ? "Buscando outras opções..."
      : refining
        ? "Ajustando recomendações..."
        : "Buscando recomendações...";
    hintEl.textContent = messages[0];
    hintEl.style.display = "";
    optionsEl.dataset.kind = "";
    clearOptions();
    continueBtn.style.display = "none";

    const loading = document.createElement("div");
    loading.setAttribute("aria-hidden", "true");
    loading.className = "flex flex-col gap-3";
    for (let i = 0; i < 3; i++) {
      const row = document.createElement("div");
      row.className = "flex items-center gap-4 rounded-2xl border border-base-300 px-5 py-4";
      const thumb = document.createElement("div");
      thumb.className = "skeleton h-16 w-12 shrink-0 rounded-xl";
      const lines = document.createElement("div");
      lines.className = "flex-1 space-y-2";
      const line1 = document.createElement("div");
      line1.className = "skeleton h-4 w-2/3";
      const line2 = document.createElement("div");
      line2.className = "skeleton h-3 w-1/2";
      lines.append(line1, line2);
      row.append(thumb, lines);
      loading.appendChild(row);
    }
    optionsEl.appendChild(loading);

    announce(
      rerollMode
        ? "Buscando outras opções para você..."
        : activeRefinement
          ? "Ajustando suas recomendações..."
          : "Buscando recomendações para você...",
    );
    stopProcessingMessages();
    let index = 0;
    processingTimer = setInterval(() => {
      index = (index + 1) % messages.length;
      hintEl.textContent = messages[index];
    }, 1400);

    questionEl.focus({ preventScroll: true });
    fetchRecommendations();
  }

  function isValidResultPayload(data: unknown): data is {
    primary: Recommendation | null;
    alternatives: Recommendation[];
  } {
    if (typeof data !== "object" || data === null) return false;
    const { primary, alternatives } = data as Record<string, unknown>;
    if (primary !== null && !isValidRecommendation(primary)) return false;
    return Array.isArray(alternatives) && alternatives.every(isValidRecommendation);
  }

  function fetchRecommendations(): void {
    if (recAborter) recAborter.abort();
    recAborter = new AbortController();
    const mySeq = (recSeq += 1);

    fetch("/api/discovery/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Reroll preserva critérios (inclui refinamento ativo); refinamento
      // troca UM filtro por vez; ambos somam excludeIds (recentlySeen).
      body: JSON.stringify({
        ...answers,
        excludeIds: loadSeenIds(),
        refinement: activeRefinement,
      }),
      signal: recAborter.signal,
    })
      .then((response) => {
        if (mySeq !== recSeq) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data: unknown) => {
        if (mySeq !== recSeq || step !== 7) return;
        if (!isValidResultPayload(data) || !data.primary) {
          throw new Error("payload inválido");
        }
        stopProcessingMessages();
        const contextVersion = (data as unknown as Record<string, unknown>).contextVersion;
        saveRecommendations(
          { primary: data.primary, alternatives: data.alternatives },
          typeof contextVersion === "string" ? contextVersion : undefined,
        );
        markPresented(data.primary, data.alternatives);
        rerollMode = false;
        step = 8;
        persist();
        renderProgress();
        renderResults(data.primary, data.alternatives, activeRefinement);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (mySeq !== recSeq || step !== 7) return;
        stopProcessingMessages();
        rerollMode = false;
        renderRecError();
      });
  }

  // ---------------------------------------------------------------
  // Ações rápidas nas recomendações (Etapa 10): Minha Lista + Já assisti
  // + rating read-only, com replacement localizado ao marcar assistido.
  // Um builder compartilhado serve principal e alternativas (sem duplicar
  // lógica 4 vezes). Estados vêm em batch (1 request p/ 4 cards).
  // ---------------------------------------------------------------

  /** Resultado exibido agora (p/ snapshot, reroll e replacement). */
  let currentPrimary: Recommendation | null = null;
  let currentAlternatives: Recommendation[] = [];
  /** Invalida replacements em voo quando os resultados são redesenhados. */
  let resultsRunId = 0;
  let cardActionsBound = false;

  function recKey(type: string, id: number): string {
    return `${type}:${id}`;
  }

  function cardStatus(slot: HTMLElement, message: string): void {
    const status = slot.querySelector("[data-card-status]");
    if (status) status.textContent = message;
  }

  /** Linha de avaliação read-only (estrelas + "4/5"; edição só em Details). */
  function buildRatingLine(rating: number): HTMLElement {
    const line = document.createElement("p");
    line.className = "flex items-center gap-1.5 text-sm";
    const stars = document.createElement("span");
    stars.setAttribute("aria-hidden", "true");
    stars.className = "text-base font-semibold tracking-tight text-amber-400";
    stars.textContent = "★".repeat(rating) + "☆".repeat(5 - rating);
    const value = document.createElement("span");
    value.className = "text-base-content/60";
    value.textContent = `${rating}/5`;
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = `Nota ${rating} de 5`;
    line.append(stars, value, sr);
    return line;
  }

  function actionButton(
    kind: "watchlist" | "watched",
    item: ContentItem,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(kind === "watchlist" ? "data-watchlist-btn" : "data-watched-btn", "");
    button.setAttribute("data-tmdb-id", String(item.id));
    button.setAttribute("data-media-type", item.type);
    button.setAttribute("data-title", item.title);
    button.setAttribute("aria-pressed", "false");
    button.disabled = true;
    button.className =
      "btn btn-outline min-h-12 min-w-0 gap-1.5 rounded-full px-3 text-sm";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("data-btn-icon", "");
    icon.textContent = kind === "watchlist" ? "♡" : "✓";
    const label = document.createElement("span");
    label.setAttribute("data-btn-label", "");
    label.className = "truncate";
    label.textContent = kind === "watchlist" ? "Minha Lista" : "Já assisti";
    button.append(icon, label);
    return button;
  }

  /**
   * Ações do card: linha de rating (oculta até os estados chegarem) +
   * grade 2 colunas (mobile e desktop — compacta, sem overflow) + status
   * sr-only. Botões nascem desabilitados (estado desconhecido) e são
   * pintados/habilitados pelo batch de estados.
   */
  function renderCardActions(item: ContentItem, compact: boolean): HTMLElement {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-card-actions", "");
    wrap.className = compact ? "mt-2" : "mx-5 mb-4";
    const rating = document.createElement("div");
    rating.setAttribute("data-rating-line", "");
    rating.style.display = "none";
    wrap.appendChild(rating);
    const grid = document.createElement("div");
    grid.setAttribute("data-actions-grid", "");
    grid.className = "mt-2 grid grid-cols-2 gap-2";
    grid.append(actionButton("watchlist", item), actionButton("watched", item));
    wrap.appendChild(grid);
    const status = document.createElement("p");
    status.setAttribute("data-card-status", "");
    status.setAttribute("role", "status");
    status.className = "sr-only";
    wrap.appendChild(status);
    return wrap;
  }

  /** Links de login quando deslogado (sem listas locais, sem bloqueio). */
  function renderCardLoginActions(): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "mt-2 grid grid-cols-2 gap-2";
    for (const [icon, label] of [["♡", "Minha Lista"], ["✓", "Já assisti"]] as const) {
      const link = document.createElement("a");
      link.href = "/entrar?next=/descobrir";
      link.className = "btn btn-outline min-h-12 min-w-0 gap-1.5 rounded-full px-3 text-sm";
      const iconEl = document.createElement("span");
      iconEl.setAttribute("aria-hidden", "true");
      iconEl.textContent = icon;
      const labelEl = document.createElement("span");
      labelEl.className = "truncate";
      labelEl.textContent = label;
      link.append(iconEl, labelEl);
      grid.appendChild(link);
    }
    return grid;
  }

  function paintWatchlistButton(button: HTMLButtonElement, saved: boolean): void {
    const title = button.getAttribute("data-title") ?? "este título";
    button.disabled = false;
    button.classList.remove("opacity-60");
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute(
      "aria-label",
      saved ? `Remover "${title}" da Minha Lista` : `Adicionar "${title}" à Minha Lista`,
    );
    // Salvo = primary/violeta (intenção, não conclusão — nunca o verde).
    button.classList.toggle("btn-primary", saved);
    button.classList.toggle("btn-outline", !saved);
    const icon = button.querySelector("[data-btn-icon]");
    if (icon) icon.textContent = saved ? "♥" : "♡";
    const label = button.querySelector("[data-btn-label]");
    if (label) label.textContent = saved ? "Na lista" : "Minha Lista";
  }

  function paintWatchedButton(button: HTMLButtonElement, watched: boolean): void {
    const title = button.getAttribute("data-title") ?? "este título";
    button.disabled = false;
    button.classList.remove("opacity-60");
    button.setAttribute("aria-pressed", String(watched));
    button.setAttribute(
      "aria-label",
      watched ? `Remover "${title}" dos assistidos` : `Marcar "${title}" como assistido`,
    );
    // Assistido = MESMO verde aprovado em Details (cinevee-watched-on).
    button.classList.toggle("cinevee-watched-on", watched);
    button.classList.toggle("btn-outline", !watched);
    const label = button.querySelector("[data-btn-label]");
    if (label) label.textContent = watched ? "✓ Assistido" : "Já assisti";
  }

  function paintRatingLine(slot: HTMLElement, rating: number | null): void {
    const holder = slot.querySelector("[data-rating-line]");
    if (!(holder instanceof HTMLElement)) return;
    holder.innerHTML = "";
    if (rating === null) {
      holder.style.display = "none";
      return;
    }
    holder.style.display = "";
    holder.appendChild(buildRatingLine(rating));
  }

  interface CardStates {
    inWatchlist: boolean;
    watched: boolean;
    rating: number | null;
  }

  function cardActionPayload(button: HTMLButtonElement): { tmdbId: number; mediaType: string } | null {
    const tmdbId = Number(button.getAttribute("data-tmdb-id"));
    const mediaType = button.getAttribute("data-media-type");
    if (!Number.isInteger(tmdbId) || tmdbId <= 0 || (mediaType !== "movie" && mediaType !== "tv")) {
      return null;
    }
    return { tmdbId, mediaType };
  }

  function setButtonBusy(button: HTMLButtonElement, busy: boolean): void {
    if (busy) {
      button.setAttribute("disabled", "");
      button.classList.add("opacity-60");
    } else {
      button.removeAttribute("disabled");
      button.classList.remove("opacity-60");
    }
  }

  /** POST/DELETE genérico nas APIs de lista; `null` = falha de rede/HTTP. */
  function toggleListEntry(
    path: "/api/watchlist" | "/api/watched",
    method: "POST" | "DELETE",
    payload: { tmdbId: number; mediaType: string },
  ): Promise<Record<string, unknown> | null> {
    return fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        if (!response.ok) return null;
        return response.json().catch(() => ({}));
      })
      .catch(() => null);
  }

  function slotOf(button: Element): HTMLElement | null {
    const slot = button.closest("[data-rec-slot]");
    return slot instanceof HTMLElement ? slot : null;
  }

  function handleWatchlistToggle(button: HTMLButtonElement): void {
    const payload = cardActionPayload(button);
    const slot = slotOf(button);
    if (!payload || !slot) return;
    const saved = button.getAttribute("aria-pressed") === "true";
    setButtonBusy(button, true);
    cardStatus(slot, "");
    void toggleListEntry("/api/watchlist", saved ? "DELETE" : "POST", payload).then((data) => {
      if (!data) {
        setButtonBusy(button, false);
        cardStatus(slot, "Não foi possível atualizar sua lista. Tente de novo.");
        return;
      }
      paintWatchlistButton(button, !saved);
    });
  }

  function handleWatchedToggle(button: HTMLButtonElement): void {
    const payload = cardActionPayload(button);
    const slot = slotOf(button);
    if (!payload || !slot) return;
    const watched = button.getAttribute("aria-pressed") === "true";
    setButtonBusy(button, true);
    cardStatus(slot, "");
    void toggleListEntry("/api/watched", watched ? "DELETE" : "POST", payload).then((data) => {
      if (!data) {
        setButtonBusy(button, false);
        cardStatus(slot, "Não foi possível marcar como assistido. Tente de novo.");
        return;
      }
      const nowWatched = !watched;
      paintWatchedButton(button, nowWatched);
      if (nowWatched) {
        // Backend tirou da watchlist: sincroniza o botão da lista e
        // substitui o slot (assistido não é mais recomendação válida).
        const watchlistBtn = slot.querySelector<HTMLButtonElement>("[data-watchlist-btn]");
        if (watchlistBtn) paintWatchlistButton(watchlistBtn, false);
        paintRatingLine(slot, null);
        startReplacement(slot);
      } else {
        // Cascade apagou a nota: some a linha de rating, sem recriar lista.
        paintRatingLine(slot, null);
      }
    });
  }

  /** Delegação única (slots são recriados no replacement). */
  function bindCardActionsOnce(): void {
    if (cardActionsBound) return;
    cardActionsBound = true;
    optionsEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const retry = target.closest("[data-retry-slot]");
      if (retry instanceof HTMLButtonElement) {
        const slot = slotOf(retry);
        if (slot) startReplacement(slot);
        return;
      }
      const watchlistBtn = target.closest("[data-watchlist-btn]");
      if (watchlistBtn instanceof HTMLButtonElement && !watchlistBtn.disabled) {
        handleWatchlistToggle(watchlistBtn);
        return;
      }
      const watchedBtn = target.closest("[data-watched-btn]");
      if (watchedBtn instanceof HTMLButtonElement && !watchedBtn.disabled) {
        handleWatchedToggle(watchedBtn);
      }
    });
  }

  function currentSlotKeys(): string[] {
    const keys: string[] = [];
    optionsEl.querySelectorAll("[data-rec-slot]").forEach((slot) => {
      const key = slot.getAttribute("data-item-key");
      if (key) keys.push(key);
    });
    return keys;
  }

  /** Busca o trio dos 4 cards em 1 batch e pinta os slots. */
  function loadCardStates(): Promise<void> {
    const slots = Array.from(optionsEl.querySelectorAll<HTMLElement>("[data-rec-slot]"));
    if (slots.length === 0) return Promise.resolve();
    const items = slots.map((slot) => {
      const [mediaType, id] = (slot.getAttribute("data-item-key") ?? ":").split(":");
      return { tmdbId: Number(id), mediaType };
    });
    return fetch("/api/discovery/recommendation-states", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    })
      .then((response) => {
        if (response.status === 401) {
          for (const slot of slots) paintSlot(slot, null);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data: unknown) => {
        if (!data || typeof data !== "object") return;
        const states = (data as Record<string, unknown>).states as Record<string, CardStates> | undefined;
        if (!states || typeof states !== "object") return;
        for (const slot of slots) paintSlot(slot, states);
        // Snapshot antigo com assistido restaurado: substitui o slot em
        // vez de deixar recomendação inválida na tela.
        for (const slot of slots) {
          const key = slot.getAttribute("data-item-key") ?? "";
          if (states[key]?.watched && !slot.hasAttribute("data-replacing")) {
            startReplacement(slot);
          }
        }
      })
      .catch(() => {
        // Sem estados, as recomendações continuam utilizáveis.
      });
  }

  /** Registra 1 apresentado no anti-repetição local. */
  function markOnePresented(key: string): void {
    try {
      saveSeenIds(addSeenIds(loadSeenIds(), [key]));
    } catch {
      // Ignora: segue sem memória de diversidade.
    }
  }

  function slotSkeleton(slot: HTMLElement): void {
    slot.setAttribute("aria-busy", "true");
    slot.innerHTML = "";
    const box = document.createElement("div");
    box.className = "rounded-3xl border border-base-300 bg-base-200/60 px-5 py-8";
    const text = document.createElement("p");
    text.setAttribute("role", "status");
    text.className = "text-sm text-base-content/60";
    text.textContent = "Buscando outra opção...";
    box.appendChild(text);
    slot.appendChild(box);
  }

  function slotFailure(slot: HTMLElement, itemTitle: string): void {
    slot.removeAttribute("aria-busy");
    slot.innerHTML = "";
    const box = document.createElement("div");
    box.className = "rounded-3xl border border-base-300 bg-base-200/60 px-5 py-8";
    const text = document.createElement("p");
    text.className = "text-sm font-semibold";
    text.textContent = "Marcado como assistido.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.setAttribute("data-retry-slot", "");
    retry.className = "btn btn-outline mt-3 min-h-12 rounded-full px-6 text-sm";
    retry.textContent = "Buscar outra opção";
    const note = document.createElement("p");
    note.setAttribute("role", "status");
    note.className = "mt-2 text-xs text-base-content/60";
    note.textContent = `Não foi possível buscar outra recomendação para "${itemTitle}" agora.`;
    box.append(text, retry, note);
    slot.appendChild(box);
    announce("Marcado como assistido. Não foi possível buscar outra opção agora.");
  }

  /**
   * Substitui SOMENTE o slot: skeleton → POST replacement (mesmo pipeline:
   * answers + refinement ativo + taste + hard exclusions) → novo conteúdo
   * + estados + snapshot + seen. Falha NÃO desfaz o watched.
   */
  function startReplacement(slot: HTMLElement): void {
    if (slot.hasAttribute("data-replacing")) return;
    const slotKey = slot.getAttribute("data-item-key") ?? "";
    if (!/^(movie|tv):[1-9]\d*$/.test(slotKey)) return;
    const kind = slot.getAttribute("data-rec-slot") === "primary" ? "primary" : "alt";
    const runId = resultsRunId;
    slot.setAttribute("data-replacing", "1");
    const title = slot.querySelector("[data-watched-btn]")?.getAttribute("data-title") ?? "este título";
    slotSkeleton(slot);
    announce("Buscando outra opção para este espaço.");
    fetch("/api/discovery/replacement", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers,
        refinement: activeRefinement,
        excludeIds: [...new Set([...currentSlotKeys(), ...loadSeenIds()])],
        slotKey,
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data: unknown) => {
        if (runId !== resultsRunId) return;
        if (typeof data !== "object" || data === null) throw new Error("payload inválido");
        const record = data as Record<string, unknown>;
        const rec = record.recommendation as Recommendation | undefined;
        const version = record.contextVersion;
        if (!rec || !isValidRecommendation(rec)) throw new Error("payload inválido");
        slot.removeAttribute("aria-busy");
        slot.removeAttribute("data-replacing");
        slot.innerHTML = "";
        slot.setAttribute("data-item-key", recKey(rec.item.type, rec.item.id));
        if (kind === "primary") {
          slot.appendChild(buildPrimaryCard(rec));
        } else {
          // O slot das alternativas É o <li>: reaproveita o builder e move
          // os filhos (link + ações) para dentro dele.
          const row = buildAlternativeRow(rec);
          slot.append(...Array.from(row.childNodes));
        }
        if (kind === "primary") {
          currentPrimary = rec;
        } else {
          const index = Array.from(
            optionsEl.querySelectorAll("[data-rec-slot='alt']"),
          ).indexOf(slot);
          if (index !== -1) {
            currentAlternatives = [...currentAlternatives];
            currentAlternatives[index] = rec;
          }
        }
        saveRecommendations(
          { primary: currentPrimary, alternatives: currentAlternatives },
          typeof version === "string" ? version : undefined,
        );
        // Replacement reescreve o conjunto da jornada → renova o relógio.
        touchSession();
        markOnePresented(recKey(rec.item.type, rec.item.id));
        announce(`Nova recomendação: ${rec.item.title}.`);
        // Estados do novo título (batch de 1 — sem N+1 por card).
        return fetch("/api/discovery/recommendation-states", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ tmdbId: rec.item.id, mediaType: rec.item.type }],
          }),
        })
          .then((response) => {
            if (response.status === 401) {
              paintSlot(slot, null);
              return;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((stateData: unknown) => {
            if (runId !== resultsRunId) return;
            if (typeof stateData !== "object" || stateData === null) return;
            const states = (stateData as Record<string, unknown>).states as
              | Record<string, CardStates>
              | undefined;
            if (states && typeof states === "object") paintSlot(slot, states);
          })
          .catch(() => {
            // Novo card sem estados continua utilizável.
          });
      })
      .catch(() => {
        if (runId !== resultsRunId) return;
        slot.removeAttribute("data-replacing");
        slotFailure(slot, title);
      });
  }

  /** Pinta um slot a partir do trio (ou links de login se 401). */
  function paintSlot(slot: HTMLElement, states: Record<string, CardStates> | null): void {
    const key = slot.getAttribute("data-item-key") ?? "";
    const grid = slot.querySelector("[data-actions-grid]");
    if (!grid) return;
    if (states === null) {
      // Deslogado: grade de botões vira links de login (sem listas locais).
      grid.replaceWith(renderCardLoginActions());
      return;
    }
    const watchlistBtn = slot.querySelector<HTMLButtonElement>("[data-watchlist-btn]");
    const watchedBtn = slot.querySelector<HTMLButtonElement>("[data-watched-btn]");
    if (!watchlistBtn || !watchedBtn) return;
    const state = states[key] ?? { inWatchlist: false, watched: false, rating: null };
    paintWatchlistButton(watchlistBtn, state.inWatchlist);
    paintWatchedButton(watchedBtn, state.watched);
    paintRatingLine(slot, state.watched ? state.rating : null);
  }

  /** Card da recomendação principal (reutilizado no replacement). */
  function buildPrimaryCard(rec: Recommendation): HTMLElement {
    const item = rec.item;
    const card = document.createElement("article");
    card.className = "overflow-hidden rounded-3xl border border-base-300 bg-base-200";

    if (item.backdropUrl) {
      const backdrop = document.createElement("img");
      backdrop.src = item.backdropUrl;
      backdrop.alt = "";
      backdrop.width = 1280;
      backdrop.height = 720;
      backdrop.loading = "eager";
      backdrop.className = "aspect-video w-full object-cover";
      card.appendChild(backdrop);
    }

    const body = document.createElement("div");
    body.className = "flex gap-4 p-5";
    body.appendChild(posterThumb(item, "w-24 sm:w-28"));

    const info = document.createElement("div");
    info.className = "min-w-0 flex-1";
    const badge = document.createElement("p");
    badge.className = "text-xs font-bold uppercase tracking-[0.18em] text-primary";
    badge.textContent = typeLabel(item.type);
    const title = document.createElement("h3");
    title.className = "mt-1 text-balance text-xl font-extrabold leading-tight sm:text-2xl";
    title.textContent = item.title;
    const meta = document.createElement("p");
    meta.className = "mt-1 text-sm text-base-content/60";
    meta.textContent = metaLine(item);
    info.append(badge, title, meta);
    if (item.genres && item.genres.length > 0) {
      const genres = document.createElement("p");
      genres.className = "mt-2 text-xs text-base-content/60";
      genres.textContent = item.genres.slice(0, 3).join(" · ");
      info.appendChild(genres);
    }
    body.appendChild(info);
    card.appendChild(body);

    const reason = document.createElement("p");
    reason.className = "mx-5 mb-2 border-l-2 border-primary/50 pl-3 text-pretty text-sm leading-6 text-base-content/80";
    reason.textContent = rec.reason;
    card.appendChild(reason);

    card.appendChild(renderCardActions(item, false));

    const detailLink = document.createElement("a");
    detailLink.href = `/titulo/${item.type}/${item.id}`;
    detailLink.className = "btn btn-primary mx-5 mb-5 min-h-12 rounded-full px-8";
    detailLink.textContent = "Ver detalhes";
    card.appendChild(detailLink);
    return card;
  }

  /** Linha de alternativa (link + ações; reutilizada no replacement). */
  function buildAlternativeRow(rec: Recommendation): HTMLLIElement {
    const li = document.createElement("li");
    li.setAttribute("data-rec-slot", "alt");
    li.setAttribute("data-item-key", recKey(rec.item.type, rec.item.id));
    const link = document.createElement("a");
    link.href = `/titulo/${rec.item.type}/${rec.item.id}`;
    link.className = "cinevee-card flex min-h-12 items-center gap-3 rounded-2xl p-2 hover:bg-base-200";
    link.setAttribute(
      "aria-label",
      `${rec.item.title}, ${typeLabel(rec.item.type).toLowerCase()}${typeof rec.item.year === "number" ? ` de ${rec.item.year}` : ""}`,
    );
    link.appendChild(posterThumb(rec.item, "w-16 sm:w-20"));
    const text = document.createElement("div");
    text.className = "min-w-0 flex-1 py-1";
    const name = document.createElement("p");
    name.className = "line-clamp-2 font-semibold leading-snug";
    name.textContent = rec.item.title;
    const altMeta = document.createElement("p");
    altMeta.className = "mt-1 text-sm text-base-content/60";
    altMeta.textContent = metaLine(rec.item);
    const altReason = document.createElement("p");
    altReason.className = "mt-0.5 line-clamp-3 text-sm text-base-content/60";
    altReason.textContent = rec.reason;
    text.append(name, altMeta, altReason);
    link.appendChild(text);
    li.appendChild(link);
    li.appendChild(renderCardActions(rec.item, true));
    return li;
  }

  function renderResults(
    primary: Recommendation,
    alternatives: Recommendation[],
    refinement: RecommendationRefinement | null,
  ): void {
    currentKind = null;
    stage.dataset.view = "results";
    hideAuxiliary();
    questionEl.textContent = "Suas recomendações";
    hintEl.textContent = "Escolhidas a partir das suas respostas.";
    hintEl.style.display = "";
    optionsEl.dataset.kind = "";
    clearOptions();
    continueBtn.style.display = "none";

    const slot = document.createElement("div");
    slot.setAttribute("data-rec-slot", "primary");
    slot.setAttribute("data-item-key", recKey(primary.item.type, primary.item.id));
    slot.appendChild(buildPrimaryCard(primary));
    optionsEl.appendChild(slot);

    if (alternatives.length > 0) {
      const altsTitle = document.createElement("h2");
      altsTitle.className = "mt-8 text-lg font-bold tracking-tight";
      altsTitle.textContent = "Outras que combinam com você";
      optionsEl.appendChild(altsTitle);

      const list = document.createElement("ul");
      list.className = "mt-3 flex flex-col gap-2";
      for (const alt of alternatives) {
        list.appendChild(buildAlternativeRow(alt));
      }
      optionsEl.appendChild(list);
    }

    const refineWrap = document.createElement("section");
    refineWrap.className = "mt-10";
    refineWrap.setAttribute("aria-label", "Ajustar recomendações");
    const refineTitle = document.createElement("h2");
    refineTitle.className = "text-sm font-bold tracking-tight text-base-content/80";
    refineTitle.textContent = "Quer ajustar um pouco?";
    const refineGrid = document.createElement("div");
    refineGrid.className = "mt-3 grid grid-cols-2 gap-2 md:grid-cols-4";
    for (const option of REFINEMENT_OPTIONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      const pressed = refinement === option.value;
      // Ativo = primary unificado da marca (sem quatro cores no selecionado).
      chip.className = pressed
        ? "btn btn-primary min-h-12 min-w-0 justify-center gap-2 whitespace-nowrap rounded-full border border-primary px-3 text-sm"
        : `btn min-h-12 min-w-0 justify-center gap-2 whitespace-nowrap rounded-full border px-3 text-sm text-base-content transition-colors [@media(hover:hover)]:hover:-translate-y-px motion-reduce:transform-none ${REFINEMENT_TONE[option.value].chip}`;
      chip.setAttribute("aria-pressed", String(pressed));
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      // Tamanho explícito e invariável: o SVG interno (.discovery-icon-svg,
      // width/height 100%) resolve contra estes 20px — nunca contra a célula.
      icon.className = `inline-flex h-5 w-5 shrink-0 ${pressed ? "" : REFINEMENT_TONE[option.value].icon}`;
      icon.innerHTML = DISCOVERY_ICONS[REFINEMENT_ICONS[option.value]] ?? "";
      chip.append(icon, option.label);
      chip.addEventListener("click", () => {
        // UM ativo por vez: tocar no ativo desliga; outro substitui.
        activeRefinement = pressed ? null : option.value;
        rerollMode = false;
        touchSession();
        goTo(7);
      });
      refineGrid.appendChild(chip);
    }
    refineWrap.append(refineTitle, refineGrid);
    optionsEl.appendChild(refineWrap);

    const actions = document.createElement("div");
    actions.className = "mt-6 flex flex-col gap-2";

    const reroll = document.createElement("button");
    reroll.type = "button";
    reroll.className = "btn btn-primary min-h-12 w-full gap-2 rounded-full";
    const rerollIcon = document.createElement("span");
    rerollIcon.setAttribute("aria-hidden", "true");
    rerollIcon.className = "inline-flex";
    rerollIcon.innerHTML = REROLL_ICON_SVG;
    reroll.append(rerollIcon, "Mostrar outras opções");
    reroll.addEventListener("click", () => {
      rerollMode = true;
      touchSession();
      goTo(7);
    });

    const secondary = document.createElement("div");
    secondary.className = "flex flex-col gap-2 sm:flex-row";
    const redo = document.createElement("button");
    redo.type = "button";
    redo.className = "btn btn-outline min-h-12 flex-1 rounded-full";
    redo.textContent = "Refazer escolhas";
    redo.addEventListener("click", () => {
      // Respostas preservadas, mas refinamento limpo (sem influência silenciosa).
      activeRefinement = null;
      invalidateRecommendations();
      touchSession();
      goTo(0);
    });
    const restart = document.createElement("button");
    restart.type = "button";
    // Ghost com borda sutil: claramente uma ação, mas com menos peso que o outline.
    restart.className = "btn btn-ghost min-h-12 flex-1 rounded-full border border-base-300/70 text-base-content/70";
    restart.textContent = "Começar de novo";
    restart.addEventListener("click", () => restartBtn.click());
    secondary.append(redo, restart);
    actions.append(reroll, secondary);
    optionsEl.appendChild(actions);
    // Respiro extra no fim dos resultados: soma ao pb-32 do <main> para que
    // a FloatingDock fixa (~74px + offset 16px + safe-area) nunca cubra as
    // ações. Sem mover a dock e sem tocar nos cards acima.
    const dockSpacer = document.createElement("div");
    dockSpacer.setAttribute("aria-hidden", "true");
    dockSpacer.className = "h-10";
    optionsEl.appendChild(dockSpacer);

    // Estado para actions/replacement/snapshot; depois busca o trio em batch.
    currentPrimary = primary;
    currentAlternatives = [...alternatives];
    resultsRunId += 1;
    bindCardActionsOnce();
    void loadCardStates();

    announce("Suas recomendações estão prontas.");
    questionEl.focus({ preventScroll: true });
  }

  function renderResultsStep(): void {
    const cached = loadRecommendations();
    if (!cached || !cached.primary) {
      // Sem cache válido (ex.: refresh no meio do processamento) → gera de novo.
      renderProcessingStep();
      return;
    }
    // Snapshot antigo (sem versão) ou validação indisponível → usa o
    // cache como antes. Versão divergente (assistiu/avaliou no meio
    // tempo) → regenera em vez de reutilizar resultado incompatível.
    if (!cached.contextVersion) {
      renderCachedRecommendations(cached);
      return;
    }
    fetch("/api/discovery/context-version", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const version =
          typeof data === "object" && data !== null
            ? (data as Record<string, unknown>).version
            : null;
        if (typeof version === "string" && version !== cached.contextVersion) {
          renderProcessingStep();
        } else {
          renderCachedRecommendations(cached);
        }
      })
      .catch(() => {
        renderCachedRecommendations(cached);
      });
  }

  function renderCachedRecommendations(cached: StoredRecommendations): void {
    const primary = cached.primary;
    if (!primary) {
      renderProcessingStep();
      return;
    }
    currentKind = null;
    stage.dataset.view = "results";
    renderProgress();
    // Refresh restaura resultado + refinamento, sem gerar de novo.
    activeRefinement = cached.refinement;
    renderResults(primary, cached.alternatives, cached.refinement);
  }

  function renderRecError(): void {
    currentKind = null;
    stage.dataset.view = "results";
    hideAuxiliary();
    questionEl.textContent = "Não conseguimos buscar recomendações agora.";
    hintEl.textContent = "Verifique sua conexão e tente novamente.";
    hintEl.style.display = "";
    optionsEl.dataset.kind = "";
    clearOptions();
    continueBtn.style.display = "none";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn-primary mt-2 min-h-12 w-full rounded-full";
    retry.textContent = "Tentar novamente";
    retry.addEventListener("click", () => {
      touchSession();
      renderProcessingStep();
    });
    const review = document.createElement("button");
    review.type = "button";
    review.className = "btn btn-ghost mt-2 min-h-12 w-full rounded-full text-base-content/70";
    review.textContent = "Revisar respostas";
    review.addEventListener("click", () => goTo(6));
    optionsEl.append(retry, review);

    announce("Não conseguimos buscar recomendações agora.");
    questionEl.focus({ preventScroll: true });
  }

  backBtn.addEventListener("click", () => {
    userInteracted = true;
    if (step <= 0 || step === 7) return;
    // Do resultado, voltar vai ao resumo (respostas preservadas).
    if (step === 8) {
      goTo(6);
      return;
    }
    // Voltar preserva respostas posteriores; alterar refaz o estado.
    goTo((step - 1) as DiscoveryStep);
  });

  restartBtn.addEventListener("click", () => {
    userInteracted = true;
    if (recAborter) recAborter.abort();
    recSeq++;
    stopProcessingMessages();
    try {
      window.localStorage.removeItem(storageKey());
    } catch {
      // Ignora: segue com reset em memória.
    }
    invalidateRecommendations();
    answers = createInitialAnswers();
    // Recomeço imediato, independente do TTL: nova jornada começa agora.
    sessionLastActivityAt = Date.now();
    // Recomeçar limpa sessão/progresso/resultado, mas reaplica os defaults
    // do perfil (providers). Preferências do Supabase nunca são tocadas.
    providersFromProfile = false;
    if (profileProviders.length > 0) {
      answers.providers = [...profileProviders];
      providersFromProfile = true;
    }
    announce("Questionário recomeçado.");
    goTo(0);
  });

  continueBtn.addEventListener("click", () => {
    userInteracted = true;
    if (step === 2) {
      touchSession();
      goTo(3);
    } else if (step === 5) {
      touchSession();
      goTo(6);
    }
  });

  renderStep(step);
  if (restored) announce("Progresso restaurado. Continue de onde parou.");
  // Preferências da conta chegam assíncronas (prerender preservado):
  // aplicam defaults/saneamento e re-renderizam a etapa atual se preciso.
  void loadProfilePreferences();
}
