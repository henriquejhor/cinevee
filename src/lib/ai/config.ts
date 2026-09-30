/**
 * Config central da camada de IA (server-side).
 *
 * - Groq é o provider PRIMÁRIO (`GROQ_MODEL`, default `qwen/qwen3.8-27b`).
 * - O modelo NÃO é hardcoded nos providers: todos leem daqui.
 * - Timeouts independentes: adaptativa ~8s, ranking ~14s (Groq costuma
 *   responder em <1s; sem aumento desnecessário).
 *
 * Nunca importar em código client-side: chaves sem prefixo PUBLIC_.
 */

export const GROQ_MODEL_DEFAULT = "qwen/qwen3.8-27b";

/** Pergunta adaptativa: janela curta (etapa pequena do questionário). */
export const ADAPTIVE_TIMEOUT_MS = 8000;
/** Ranking: tarefa maior (4 picks + reasons em UMA chamada). */
export const RANK_TIMEOUT_MS = 14000;

function getEnv(name: string): string | undefined {
  const fromProcess =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>)[name]
      : undefined;
  if (fromProcess) return fromProcess;
  try {
    const meta = import.meta.env as Record<string, string | undefined>;
    return meta[name];
  } catch {
    return undefined;
  }
}

export function getGroqModel(): string {
  const configured = getEnv("GROQ_MODEL")?.trim();
  return configured ? configured : GROQ_MODEL_DEFAULT;
}

export function getGroqApiKey(): string {
  const key = getEnv("GROQ_API_KEY")?.trim();
  if (!key) {
    throw new Error(
      "[Groq] GROQ_API_KEY ausente. Defina a variável no arquivo .env (server-side).",
    );
  }
  return key;
}
