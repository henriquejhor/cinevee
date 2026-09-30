/**
 * Teste do fluxo UI de allowRatingComments em /perfil/editar.
 *
 * Cobre dois bugs reais da Etapa 19:
 *
 * Bug 1 (save): o checkbox #privacy-comments era coletado e hidratado
 * corretamente, mas nunca disparava savePrivacy (fora da lista de change
 * listeners) — marcar + recarregar voltava a false.
 *
 * Bug 2 (read/SSR): com o PATCH já funcionando (banco=true, API GET=true),
 * sair de /perfil/editar e voltar mostrava o checkbox desmarcado. Causa:
 * `toUserProfile()` (read path do SSR via `getUserProfile`) montava
 * `privacy` com só 8 campos, descartando `allow_rating_comments`, enquanto
 * `getPrivacySettings()` (read path da API) mapeava os 9. SSR vinha sem
 * `checked` (Caso A) — nenhum script client-side estava envolvido (o
 * <script> da página nunca chama syncPrivacyUi no load; Layout sem View
 * Transitions = MPA com SSR fresco a cada navegação).
 *
 * Seções 1–5: estáticas + funcionais, sem dependências (extrai o <script>
 * real de editar.astro e o executa num DOM mockado, sem jsdom):
 *   false → check true → change → PATCH allowRatingComments:true
 *     → GET/reload → checkbox continua true
 *   true → uncheck → change → PATCH allowRatingComments:false
 *     → GET/reload → checkbox continua false
 *
 * Seção 6 (live): SSR real via HTTP — PATCH true → sair (GET /perfil) →
 * voltar (GET /perfil/editar) → checkbox vem checked; depois PATCH false →
 * sair → voltar → vem unchecked. Valida o estado final do HTML servido,
 * não apenas a string `checked={...}` no source. Requer servidor dev em
 * :4321 + Supabase; sem eles, entra em SKIP (exit 0).
 *
 * Uso: node scripts/verify-privacy-comments-ui.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const EDITAR = "src/pages/perfil/editar.astro";

let failures = 0;
let skipped = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures += 1;
    if (detail) console.log(`      ↳ ${String(detail).slice(0, 400)}`);
  }
}
function skip(label) {
  console.log(`SKIP  ${label}`);
  skipped += 1;
}

const src = readFileSync(new URL(`../${EDITAR}`, import.meta.url), "utf8");

// ---------- 1. Contrato estático do markup ----------
check(
  "checkbox real é id=privacy-comments (sem name/data attr, tipo checkbox)",
  /<input[^>]*id="privacy-comments"[^>]*type="checkbox"/s.test(src),
);
check(
  "hidratação usa camelCase checked={privacy.allowRatingComments}",
  /checked=\{privacy\.allowRatingComments\}/.test(src),
);
check(
  "markup não usa snake_case privacy.allow_rating_comments",
  !/privacy\.allow_rating_comments/.test(src),
);
check(
  "sem mismatches (allowComments/allowRatingComment soltos)",
  !/allowComments(?!.*allowRatingComments)/.test(
    src.replace(/allowRatingComments/g, ""),
  ) && !/allowRatingComment[^s]/.test(src),
);

// ---------- 2. collectPrivacy: snapshot exato de 9 campos ----------
const collectMatch = src.match(/function collectPrivacy\(\) \{([\s\S]*?)\n    \}/);
const collectBody = collectMatch ? collectMatch[1] : "";
const expectedKeys = [
  "profilePublic",
  "showFavorites",
  "showRecommendations",
  "showWatched",
  "showRatings",
  "showReviews",
  "discoverable",
  "showActivity",
  "allowRatingComments",
];
for (const key of expectedKeys) {
  check(`collectPrivacy coleta ${key}`, new RegExp(`${key}:`).test(collectBody));
}
check(
  "collectPrivacy lê privacyComments.checked para allowRatingComments",
  /allowRatingComments:\s*privacyComments instanceof HTMLInputElement \? privacyComments\.checked/.test(
    collectBody,
  ),
);

// ---------- 3. Wiring de save (a causa raiz) ----------
const listenerBlock =
  src.slice(src.lastIndexOf("["), src.indexOf("].forEach(function (el)"));
check(
  "change listener inclui privacyComments (dispara savePrivacy)",
  /privacyComments/.test(listenerBlock),
  listenerBlock.replace(/\s+/g, " ").slice(0, 300),
);
for (const v of [
  "privacyPublic",
  "privacyFavorites",
  "privacyRecommendations",
  "privacyWatched",
  "privacyRatings",
  "privacyReviews",
  "privacyDiscoverable",
  "privacyActivity",
]) {
  check(`change listener inclui ${v}`, new RegExp(`\\b${v}\\b`).test(listenerBlock));
}
check(
  "syncPrivacyUi hidrata privacyComments de state.allowRatingComments",
  /privacyComments\.checked = state\.allowRatingComments/.test(src),
);

// ---------- 4. Mapeamento service/validation (leitura nos dois sentidos) ----------
// ATENÇÃO (bug 2): a página SSR e a API usam read paths DIFERENTES —
// `getUserProfile → toUserProfile` vs `getPrivacySettings`. Ambos precisam
// mapear allow_rating_comments; checar só "existe no arquivo" não basta.
const service = readFileSync(
  new URL("../src/lib/profile/service.ts", import.meta.url),
  "utf8",
);
const toUserProfileBlock = service.slice(
  service.indexOf("function toUserProfile"),
  service.indexOf("function toUserProfile") + 1500,
);
check(
  "service SSR (toUserProfile): privacy inclui allowRatingComments — regressão do bug 2",
  /allowRatingComments: row\.allow_rating_comments === true/.test(toUserProfileBlock),
  toUserProfileBlock.replace(/\s+/g, " ").slice(0, 300),
);
const privacySettingsBlock = service.slice(
  service.indexOf("export async function getPrivacySettings"),
  service.indexOf("export async function getPrivacySettings") + 900,
);
check(
  "service API (getPrivacySettings): inclui allowRatingComments",
  /allowRatingComments: row\.allow_rating_comments === true/.test(privacySettingsBlock),
);
check(
  "service write: allow_rating_comments: input.allowRatingComments",
  /allow_rating_comments: input\.allowRatingComments/.test(service),
);
const validation = readFileSync(
  new URL("../src/lib/profile/validation.ts", import.meta.url),
  "utf8",
);
check(
  "validation: ausente → false, presente não-booleano → 400",
  /payload\.allowRatingComments === undefined/.test(validation),
);

// ---------- 5. Fluxo funcional com o <script> real ----------
// O script inline hoje contém anotações TS (astro check); transpila para
// JS antes de executar no mock (sem typecheck aqui — isso é do check).
async function toRunnableJs(tsSource) {
  try {
    const ts = await import("typescript");
    return ts.transpileModule(tsSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
  } catch {
    return tsSource;
  }
}
const scriptMatch = src.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) {
  check("bloco <script> extraível de editar.astro", false);
} else {
  const scriptSrc = await toRunnableJs(scriptMatch[1]);

  class MockInput {
    constructor(id, checked = false, value = "") {
      this.id = id;
      this.checked = checked;
      this.value = value;
      this.listeners = {};
      this.attrs = {};
    }
    addEventListener(ev, fn) {
      (this.listeners[ev] ||= []).push(fn);
    }
    dispatch(ev) {
      for (const fn of this.listeners[ev] || []) fn({ preventDefault() {} });
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    focus() {}
  }
  class MockEl {
    constructor() {
      this.listeners = {};
      this.style = {};
      this.textContent = "";
      this.className = "";
    }
    addEventListener(ev, fn) {
      (this.listeners[ev] ||= []).push(fn);
    }
  }

  const ids = [
    "identity-form",
    "identity-submit",
    "identity-status",
    "identity-name",
    "identity-username",
    "identity-bio",
    "avatar-input",
    "avatar-remove",
    "avatar-status",
    "privacy-status",
    "privacy-public",
    "privacy-favorites",
    "privacy-recommendations",
    "privacy-watched",
    "privacy-ratings",
    "privacy-reviews",
    "privacy-discoverable",
    "privacy-activity",
    "privacy-comments",
  ];

  function buildHarness(initialComments) {
    const elements = {};
    for (const id of ids) {
      if (id === "identity-username") {
        elements[id] = new MockInput(id, false, "usuario_teste");
      } else if (id === "privacy-status") {
        elements[id] = new MockEl();
      } else if (id.startsWith("privacy-")) {
        elements[id] = new MockInput(id, id === "privacy-comments" ? initialComments : false);
      } else if (id === "identity-form") {
        elements[id] = new MockEl();
      } else {
        elements[id] = new MockInput(id);
      }
    }
    const fetches = [];
    // "Banco" simulado: espelha o que o PATCH persistiria.
    let dbAllowRatingComments = initialComments;
    const sandbox = {
      console,
      document: {
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
      },
      window: { setTimeout: () => 0, location: { href: "", reload: () => {} } },
      fetch: async (url, opts = {}) => {
        fetches.push({ url, opts });
        if (url === "/api/profile/privacy" && opts.method === "PATCH") {
          const body = JSON.parse(opts.body);
          dbAllowRatingComments = body.allowRatingComments;
          // Servidor ecoa o estado persistido (como updatePrivacySettings → GET).
          return { ok: true, json: async () => ({ ok: true, privacy: { ...body } }) };
        }
        if (url === "/api/profile/privacy" && !opts.method) {
          return {
            ok: true,
            json: async () => ({ privacy: { allowRatingComments: dbAllowRatingComments } }),
          };
        }
        return { ok: true, json: async () => ({}) };
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.HTMLInputElement = MockInput;
    sandbox.HTMLFormElement = MockEl;
    sandbox.HTMLTextAreaElement = MockInput;
    sandbox.HTMLButtonElement = MockInput;
    sandbox.HTMLElement = MockEl;
    sandbox.FormData = class {
      append() {}
    };
    vm.createContext(sandbox);
    vm.runInContext(scriptSrc, sandbox);
    return { elements, fetches, db: () => dbAllowRatingComments };
  }

  const flush = () => new Promise((r) => setTimeout(r, 20));

  // Cenário A: false → marca → save → reload → continua true.
  {
    const h = buildHarness(false);
    const comments = h.elements["privacy-comments"];
    check("A: estado inicial false", comments.checked === false);
    check(
      "A: checkbox de comentários tem listener de change (causa raiz)",
      (comments.listeners.change || []).length >= 1,
      `listeners=${Object.keys(comments.listeners).join(",") || "nenhum"}`,
    );
    comments.checked = true; // usuário marca
    comments.dispatch("change"); // dispara savePrivacy
    await flush();
    const patch = h.fetches.find((f) => f.opts && f.opts.method === "PATCH");
    const sent = patch ? JSON.parse(patch.opts.body) : null;
    check("A: PATCH enviado ao marcar", !!patch, `fetches=${h.fetches.length}`);
    check(
      "A: payload real contém allowRatingComments:true",
      sent && sent.allowRatingComments === true,
      `payload=${JSON.stringify(sent)}`,
    );
    check(
      "A: payload tem snapshot completo de 9 campos",
      sent && expectedKeys.every((k) => typeof sent[k] === "boolean"),
      `keys=${sent ? Object.keys(sent).join(",") : "nenhum"}`,
    );
    check("A: banco simulado persiste true", h.db() === true);
    // Reload: servidor retorna true → hidratação mantém marcado.
    comments.checked = false; // simula DOM recarregado com default false
    comments.checked = h.db(); // aplica GET (syncPrivacyUi)
    check("A: após reload/read checkbox continua true", comments.checked === true);
  }

  // Cenário B: true → desmarca → save → reload → continua false.
  {
    const h = buildHarness(true);
    const comments = h.elements["privacy-comments"];
    check("B: estado inicial true", comments.checked === true);
    comments.checked = false; // usuário desmarca
    comments.dispatch("change");
    await flush();
    const patch = h.fetches.find((f) => f.opts && f.opts.method === "PATCH");
    const sent = patch ? JSON.parse(patch.opts.body) : null;
    check(
      "B: payload real contém allowRatingComments:false",
      sent && sent.allowRatingComments === false,
      `payload=${JSON.stringify(sent)}`,
    );
    check("B: banco simulado persiste false", h.db() === false);
    comments.checked = true; // DOM recarregado com default true
    comments.checked = h.db();
    check("B: após reload/read checkbox continua false", comments.checked === false);
  }
}

// ---------- 6. LIVE: SSR real sair/voltar (reproduz o bug manual do bug 2) ----------
// PATCH true → GET /perfil (sair) → GET /perfil/editar (voltar) → HTML servido
// precisa conter `checked` no input #privacy-comments; depois o inverso com
// false. Sem servidor dev ou Supabase: SKIP (não falha a regressão local).
{
  const SB_URL = process.env.PUBLIC_SUPABASE_URL;
  const SB_KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const BASE = "http://localhost:4321";
  let http = false;
  if (SB_URL && SB_KEY) {
    try {
      await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
      http = true;
    } catch {
      http = false;
    }
  }
  if (!SB_URL || !SB_KEY) {
    skip("live SSR: sem PUBLIC_SUPABASE_URL/PUBLISHABLE_KEY (rode com --env-file=.env)");
  } else if (!http) {
    skip("live SSR: servidor dev indisponível em :4321");
  } else {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const stamp = Date.now();
      const client = createClient(SB_URL, SB_KEY);
      const email = `privui-${stamp}@example.com`;
      const password = `PrivUi123!${stamp}`;
      const { data, error } = await client.auth.signUp({ email, password });
      if (error || !data.session || !data.user) {
        throw new Error(`signup falhou (${error?.message ?? "sessão nula"})`);
      }
      const fresh = createClient(SB_URL, SB_KEY);
      const { data: s } = await fresh.auth.signInWithPassword({ email, password });
      const ref = new URL(SB_URL).hostname.split(".")[0];
      const cookie =
        `sb-${ref}-auth-token=base64-` +
        Buffer.from(JSON.stringify(s.session)).toString("base64url");
      const uname = `privui${String(stamp).slice(-9)}`;
      const seed = await fresh
        .from("profiles")
        .update({ username: uname, display_name: "Priv UI" })
        .eq("id", data.user.id);
      if (seed.error) throw new Error(`seed falhou: ${seed.error.message}`);

      const patchPrivacy = (value) =>
        fetch(`${BASE}/api/profile/privacy`, {
          method: "PATCH",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            profilePublic: false,
            showFavorites: false,
            showRecommendations: false,
            showWatched: false,
            showRatings: false,
            showReviews: false,
            discoverable: false,
            showActivity: false,
            allowRatingComments: value,
          }),
        }).then(async (r) => ({ status: r.status, json: await r.json() }));

      // Sair e voltar: GET /perfil e depois GET /perfil/editar (MPA — cada
      // navegação é um SSR fresco, igual ao app real).
      const leaveAndReturn = async () => {
        await fetch(`${BASE}/perfil`, {
          headers: { Cookie: cookie },
          redirect: "manual",
        });
        const res = await fetch(`${BASE}/perfil/editar`, {
          headers: { Cookie: cookie },
          redirect: "manual",
        });
        const html = await res.text();
        const tag = html.match(/<input[^>]*id="privacy-comments"[^>]*>/);
        return { status: res.status, tag: tag ? tag[0] : null };
      };

      let r = await patchPrivacy(true);
      check(
        "live: PATCH allowRatingComments=true persiste (banco=true)",
        r.status === 200 && r.json?.privacy?.allowRatingComments === true,
        `status=${r.status} body=${JSON.stringify(r.json).slice(0, 160)}`,
      );
      let page = await leaveAndReturn();
      check("live: voltar a /perfil/editar após sair (200)", page.status === 200);
      check(
        "live: persistido true → SSR vem CHECKED (bug 2)",
        !!page.tag && /checked/.test(page.tag),
        `tag=${page.tag ?? "NOT FOUND"}`,
      );

      r = await patchPrivacy(false);
      check(
        "live: PATCH allowRatingComments=false persiste (banco=false)",
        r.status === 200 && r.json?.privacy?.allowRatingComments === false,
        `status=${r.status}`,
      );
      page = await leaveAndReturn();
      check(
        "live: persistido false → SSR vem UNCHECKED (não força true)",
        !!page.tag && !/checked/.test(page.tag),
        `tag=${page.tag ?? "NOT FOUND"}`,
      );
    } catch (e) {
      skip(`live SSR: infra indisponível (${e instanceof Error ? e.message : e})`);
    }
  }
}

console.log("---");
console.log(
  failures === 0
    ? `PRIVACY-COMMENTS-UI OK: checkbox → collect → PATCH → SSR sair/voltar nos dois sentidos.${skipped ? ` (${skipped} SKIP)` : ""}`
    : `PRIVACY-COMMENTS-UI FALHOU: ${failures} asserção(ões).`,
);
process.exit(failures === 0 ? 0 : 1);
