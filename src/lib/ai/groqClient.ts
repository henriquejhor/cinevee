/**
 * Cliente Groq mínimo server-side (sem SDK externo).
 *
 * A API da Groq é compatível com o formato OpenAI de chat completions,
 * então um `fetch` direto basta — evita dependência nova (AGENTS.md:
 * evitar dependências desnecessárias). A chave `GROQ_API_KEY` nunca sai
 * do servidor: não entra em HTML/JSON/logs.
 *
 * Notas medidas em teste direto (qwen/qwen3.8-27b):
 * - `response_format: json_schema strict:true` funciona (~440ms);
 * - `reasoning_effort` é aceito, mas gera tokens de reasoning que
 *   aumentam latência/consumo sem benefício nestas tarefas triviais de
 *   extração → parâmetro omitido de propósito (resposta direta e rápida).
 */
import { getGroqApiKey, getGroqModel } from "./config";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqJsonOptions {
  system: string;
  user: string;
  /** Nome do schema (só identificação). */
  schemaName: string;
  /** JSON Schema strict: todos os objetos com `additionalProperties: false` e tudo em `required`. */
  schema: Record<string, unknown>;
  timeoutMs: number;
  maxTokens: number;
}

/**
 * Race com timeout que também aborta o socket: sem `AbortController`,
 * o `fetch` continuaria pendurado em background após o timeout vencer
 * (vazamento de sockets sob carga). O chamador aplica o fallback.
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

/**
 * Chamada JSON strict à Groq. Retorna o texto JSON cru para o chamador
 * validar contra o contrato atual (validações server-side preservadas).
 * Lança erro em qualquer falha — o chamador aplica o fallback.
 */
export async function groqChatJson(options: GroqJsonOptions): Promise<string> {
  const call = (signal: AbortSignal): Promise<string> =>
    (async (): Promise<string> => {
      const response = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${getGroqApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: getGroqModel(),
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
          temperature: 0.2,
          max_tokens: options.maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: options.schemaName,
              strict: true,
              schema: options.schema,
            },
          },
        }),
      });
      if (!response.ok) {
        // Corpo só para classificar o erro (código Groq + espera sugerida).
        // Nunca contém segredos.
        let suffix = "";
        try {
          const errBody: unknown = JSON.parse(await response.text());
          const err = (errBody as { error?: { code?: unknown; message?: unknown } })?.error;
          if (err && typeof err.code === "string") suffix += ` ${err.code}`;
          if (err && typeof err.message === "string") {
            const wait = err.message.match(/try again in ([\d.]+)s/i);
            if (wait) suffix += ` retry_after=${wait[1]}`;
          }
        } catch {
          // Corpo não-JSON: mantém só o status.
        }
        throw new Error(`HTTP ${response.status}${suffix}`);
      }
      const data: unknown = await response.json();
      const text =
        typeof data === "object" && data !== null
          ? (
              data as {
                choices?: { message?: { content?: unknown } }[];
              }
            ).choices?.[0]?.message?.content
          : undefined;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("resposta vazia");
      }
      return text.trim();
    })();

  return withTimeoutAbort(call, options.timeoutMs);
}
