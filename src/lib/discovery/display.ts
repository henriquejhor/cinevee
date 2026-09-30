/**
 * Camada APENAS visual do questionário (nenhuma regra/logica aqui).
 *
 * - `DISCOVERY_ICONS`: SVG line-art próprios (stroke 1.8, round caps,
 *   currentColor), mesma linguagem da FloatingDock. Strings estáticas
 *   confiáveis — nunca dados de API.
 * - `STEP_EYEBROWS`: contexto curto por etapa (índice = DiscoveryStep).
 * - `optionDisplay()`: ícone + microcopy por opção (chave kind:value).
 *   A pergunta adaptativa usa o símbolo sparkles para QUALQUER opção,
 *   então continua dinâmica quando o Gemini substituir o mock.
 */
import { MAX_GENRES } from "../../types/discovery";

function svg(paths: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="discovery-icon-svg">${paths}</svg>`;
}

export const DISCOVERY_ICONS: Record<string, string> = {
  movie: svg(
    '<path d="M3.5 9.5 4.6 4.2l14.9 2.9-1 2.4"/><rect x="3.5" y="9.5" width="17" height="11" rx="2"/><path d="M8.2 5.1l2.4 3.9M13 6l2.4 3.9"/>',
  ),
  series: svg(
    '<rect x="3" y="7.5" width="12.5" height="12.5" rx="2"/><path d="M7.5 7.5V6a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-1.5"/>',
  ),
  sparkles: svg(
    '<path d="M12 3.5 13.7 8.8l5.3 1.7-5.3 1.7L12 17.5l-1.7-5.3L5 10.5l5.3-1.7L12 3.5Z"/><path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z"/>',
  ),
  smile: svg(
    '<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2s1.1 1.7 3.4 1.7 3.4-1.7 3.4-1.7"/><path d="M9.2 9.6h.01M14.8 9.6h.01"/>',
  ),
  pulse: svg('<path d="M2.5 12h3.8l2.4-5.8 4.2 11.6 2.4-5.8h6.2"/>'),
  heart: svg(
    '<path d="M12 20.3C7.2 16.4 3.2 13.1 3.2 9.3c0-2.8 2.1-4.6 4.5-4.6 1.6 0 3.2.9 4.3 2.4 1.1-1.5 2.7-2.4 4.3-2.4 2.4 0 4.5 1.8 4.5 4.6 0 3.8-4 7.1-8.8 11Z"/>',
  ),
  mind: svg(
    '<circle cx="6" cy="6.5" r="2.4"/><circle cx="18" cy="6.5" r="2.4"/><circle cx="12" cy="17.5" r="2.4"/><path d="M7.9 8.2l3 6.6M16.1 8.2l-3 6.6M8.4 6.5h7.2"/>',
  ),
  moon: svg('<path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5a8.5 8.5 0 1 0 9.7 9.7Z"/>'),
  bolt: svg('<path d="M13 2.5 4.8 13.5H11l-1 8 8.2-11H12l1-8Z"/>'),
  balance: svg(
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/>',
  ),
  layers: svg('<path d="m12 3 9 4.8-9 4.8-9-4.8L12 3Z"/><path d="m3.5 12.7 8.5 4.5 8.5-4.5"/><path d="m3.5 16.7 8.5 4.5 8.5-4.5"/>'),
  screen: svg(
    '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M10.3 8.7v5l4.4-2.5-4.4-2.5Z"/><path d="M9 20.5h6"/>',
  ),
  grid: svg(
    '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  ),
  neutral: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.7 8.7l6.6 6.6"/>'),
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V8h-4.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>'),
  gem: svg('<path d="m7 3.5h10l4 5-9 12-9-12 4-5Z"/><path d="M3 8.5h18M9.5 8.5 12 20.5 14.5 8.5M7 3.5 9.5 8.5M17 3.5l-2.5 5"/>'),
};

export interface OptionDisplay {
  icon?: string;
  description?: string;
}

/** Eyebrow por etapa (índice = DiscoveryStep; 6 = conclusão, sem eyebrow). */
export const STEP_EYEBROWS: readonly string[] = [
  "",
  "Seu momento",
  "Sua vibe",
  "Pergunta personalizada",
  "Seu ritmo",
  "Onde assistir",
  "",
];

const DISPLAY_BY_VALUE: Record<string, OptionDisplay> = {
  "content:movie": { icon: "movie", description: "Uma história completa" },
  "content:tv": { icon: "series", description: "Algo para acompanhar" },
  "content:any": { icon: "sparkles", description: "Quero ser surpreendido" },
  "mood:fun": { icon: "smile", description: "Algo leve e gostoso" },
  "mood:tense": { icon: "pulse", description: "Quero ficar preso à tela" },
  "mood:emotional": { icon: "heart", description: "Algo que fique comigo" },
  "mood:thought_provoking": { icon: "mind", description: "Uma história instigante" },
  "mood:relaxing": { icon: "moon", description: "Sem exigir demais" },
  "mood:surprise": { icon: "sparkles", description: "Deixa com o CineVee" },
  "genres:none": { icon: "neutral" },
  "commitment:quick": { icon: "bolt", description: "Sem compromisso longo" },
  "commitment:balanced": { icon: "balance", description: "No ponto certo" },
  "commitment:immersive": { icon: "layers", description: "Para se perder na história" },
  "commitment:any": { icon: "sparkles" },
  "providers:netflix": { icon: "screen" },
  "providers:prime": { icon: "screen" },
  "providers:disney": { icon: "screen" },
  "providers:max": { icon: "screen" },
  "providers:any": { icon: "grid" },
};

/**
 * Visual de uma opção. `kind` usa os mesmos identificadores internos do
 * fluxo; valores futuros desconhecidos (ex.: nova pergunta do Gemini)
 * caem no símbolo sparkles quando o kind for adaptativo, senão sem ícone.
 */
export function optionDisplay(kind: string, value: string): OptionDisplay {
  const exact = DISPLAY_BY_VALUE[`${kind}:${value}`];
  if (exact) return exact;
  if (kind === "single-adaptive") return { icon: "sparkles" };
  return {};
}

export function genreCountLabel(selected: number): string {
  return `${selected}/${MAX_GENRES} selecionados`;
}
