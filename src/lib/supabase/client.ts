/**
 * Supabase browser client.
 *
 * Usar SOMENTE em <script> client-side, quando alguma ação no
 * navegador realmente precisar falar com o Supabase.
 *
 * Os fluxos de entrar/cadastrar/sair da fundação rodam server-side
 * (form POST → cookies via `@supabase/ssr`); este client existe para
 * necessidades futuras pontuais, sem duplicar lógica do server helper.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function createSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;

  const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env
    .PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;

  if (!url || !publishableKey) {
    throw new Error(
      "[Supabase] Variáveis PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_PUBLISHABLE_KEY ausentes.",
    );
  }

  cached = createBrowserClient(url, publishableKey);
  return cached;
}
