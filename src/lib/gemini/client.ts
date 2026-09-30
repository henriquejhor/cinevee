/**
 * Cliente Gemini exclusivamente server-side.
 *
 * Usa a SDK oficial `@google/genai` com `GEMINI_API_KEY` (sem prefixo
 * PUBLIC_). Nunca importar este módulo em scripts client-side nem
 * vazar a chave para o navegador/logs.
 */
import { GoogleGenAI } from "@google/genai";

/** Modelo padrão centralizado (sobrescrevível via `GEMINI_MODEL`). */
export const GEMINI_MODEL = "gemini-3.8-flash";

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

export function getGeminiModel(): string {
  const configured = getEnv("GEMINI_MODEL")?.trim();
  return configured ? configured : GEMINI_MODEL;
}

function getApiKey(): string {
  const key = getEnv("GEMINI_API_KEY")?.trim();
  if (!key) {
    throw new Error(
      "[Gemini] GEMINI_API_KEY ausente. Defina a variável no arquivo .env (server-side).",
    );
  }
  return key;
}

let cached: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!cached) {
    cached = new GoogleGenAI({ apiKey: getApiKey() });
  }
  return cached;
}
