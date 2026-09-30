/**
 * Verificação da Etapa 20: polimento UX + robustez + expiração da sessão.
 *
 * Não duplica as suítes existentes — cobre os contratos NOVOS da etapa:
 * - TTL de inatividade da sessão de /descobrir (puros + wiring);
 * - normalizadores de privacidade (9 campos, com toUserProfile);
 * - Home prerendered;
 * - guards de UX social (likes/comments/follow/feed);
 * - ausência do token "<script>" em comentários .astro (Vite scan).
 *
 * Uso: npm run verify:polish (sem servidor, sem Supabase).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { register } from "node:module";

register("./ts-ext-hook.mjs", import.meta.url);

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) {
    failures += 1;
    if (detail) console.log(`      ↳ ${String(detail).slice(0, 300)}`);
  }
}

function readFile(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/**
 * Código sem comentários (asserts de ausência testam o código, não a
 * prosa — aprendizado das Etapas 16/17).
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*--.*$/gm, "");
}

// ------------------------------------------------- A. TTL: contrato puro
const discoveryTypes = readFile("../src/types/discovery.ts");
check(
  "TTL centralizado: DISCOVERY_SESSION_TTL_MS = 20min (sem número mágico)",
  /DISCOVERY_SESSION_TTL_MS\s*=\s*20\s*\*\s*60\s*\*\s*1000/.test(discoveryTypes),
);
check("DiscoverySession possui lastActivityAt (epoch ms)", /lastActivityAt:\s*number/.test(discoveryTypes));

const state = await import("../src/lib/discovery/state.ts");
const { DISCOVERY_SESSION_TTL_MS } = await import("../src/types/discovery.ts");
const TTL = 20 * 60 * 1000;
check("TTL exportado vale 20min", DISCOVERY_SESSION_TTL_MS === TTL);

const { isDiscoverySessionExpired, parseSession, serializeSession, createInitialAnswers } = state;
const NOW = 1_800_000_000_000;
check("19m59s restaura", isDiscoverySessionExpired(NOW - (TTL - 1000), NOW) === false);
check("20m00s expira (fronteira inclusiva)", isDiscoverySessionExpired(NOW - TTL, NOW) === true);
check("20m01s expira", isDiscoverySessionExpired(NOW - (TTL + 1000), NOW) === true);
check("relógio futuro (diff negativa) não expira", isDiscoverySessionExpired(NOW + 5000, NOW) === false);
check("legacy sem timestamp expira", isDiscoverySessionExpired(undefined, NOW) === true);
check("zero expira", isDiscoverySessionExpired(0, NOW) === true);
check("negativo expira", isDiscoverySessionExpired(-10, NOW) === true);
check("string expira (null-safe)", isDiscoverySessionExpired("ontem", NOW) === true);
check("NaN expira", isDiscoverySessionExpired(Number.NaN, NOW) === true);

// Roundtrip: serialize → parse preserva o relógio (reload não renova).
{
  const answers = createInitialAnswers();
  answers.contentType = "movie";
  const clock = NOW - 60_000;
  const parsed = parseSession(JSON.parse(serializeSession(2, answers, clock)));
  check(
    "reload preserva lastActivityAt (não renova)",
    parsed !== null && parsed.lastActivityAt === clock && parsed.step === 2,
  );
  check(
    "ação relevante renova (touch = novo serialize com now)",
    (() => {
      const touched = parseSession(JSON.parse(serializeSession(2, answers, NOW)));
      return touched !== null && isDiscoverySessionExpired(touched.lastActivityAt, NOW) === false;
    })(),
  );
  // Storage legado (pré-Etapa 20): sem lastActivityAt → 0 → expirado.
  const legacy = parseSession({ step: 8, answers, updatedAt: new Date(NOW).toISOString() });
  check(
    "storage legado sem timestamp expira",
    legacy !== null && legacy.lastActivityAt === 0 && isDiscoverySessionExpired(legacy.lastActivityAt, NOW),
  );
  // Corrompido continua null (recomeçar).
  check("sessão corrompida → null", parseSession({ step: 99, answers: null }) === null);
}

// ------------------------------------------------- B. TTL: wiring no flow
const flow = codeOnly(readFile("../src/lib/discovery/flow.ts"));
check("flow importa isDiscoverySessionExpired", /isDiscoverySessionExpired/.test(flow));
check("flow tem touchSession (renova + persiste)", /function touchSession\(\)/.test(flow));
check(
  "responder/alterar renova (6 touch em onOptionClick)",
  (flow.match(/touchSession\(\);/g) || []).length >= 6,
  `ocorrências=${(flow.match(/touchSession\(\);/g) || []).length}`,
);
check("avançar (continue) renova", /touchSession\(\);\s*goTo\(3\)/.test(flow));
check("gerar (resumo) renova", /touchSession\(\);\s*goTo\(7\)/.test(flow));
check("restart limpa jornada independente do TTL", /removeItem\(storageKey\(\)\)/.test(flow));
check(
  "expiração apaga SÓ sessão+snapshot (preserva seen/categorias)",
  /removeItem\(RECOMMENDATIONS_STORAGE_KEY\)/.test(flow) &&
    !/removeItem\(seenStorageKey\(\)\)/.test(flow) &&
    !/removeItem\(categoryHistoryKey\(\)\)/.test(flow),
);
check(
  "restore verifica expiração antes de restaurar",
  /isDiscoverySessionExpired\(session\.lastActivityAt\)/.test(flow),
);
check(
  "render não renova (renderStep usa persist, não touch)",
  /step = target;\s*persist\(\);/.test(flow),
);

// ------------------------------------------------- C. privacidade: 9 campos
const service = codeOnly(readFile("../src/lib/profile/service.ts"));
const toUser = service.slice(service.indexOf("function toUserProfile"), service.indexOf("function toUserProfile") + 1600);
check(
  "toUserProfile inclui allowRatingComments (regressão bug SSR)",
  /allowRatingComments: row\.allow_rating_comments === true/.test(toUser),
);
const nine = [
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
for (const key of nine) {
  check(`toUserProfile mapeia ${key}`, new RegExp(`${key}: row\\.`).test(toUser));
}
const editar = codeOnly(readFile("../src/pages/perfil/editar.astro"));
for (const key of nine) {
  check(`collectPrivacy coleta ${key}`, new RegExp(`${key}:`).test(editar));
}
check("listener inclui privacyComments", /privacyComments,/.test(editar));
check("syncPrivacyUi hidrata allowRatingComments", /privacyComments\.checked = state\.allowRatingComments/.test(editar));
check("hidratação SSR camelCase", /checked=\{privacy\.allowRatingComments\}/.test(readFile("../src/pages/perfil/editar.astro")));
check("API doc diz 9 campos", /os 9 campos/.test(readFile("../src/pages/api/profile/privacy.ts")));

// ------------------------------------------------- D. Home prerendered
const home = codeOnly(readFile("../src/pages/index.astro"));
check("Home prerendered", /export const prerender = true/.test(home));
check("Home sem sessão server-side", !/getCurrentUser/.test(home));

// ------------------------------------------------- E. likes/comments/follow/feed
const likes = codeOnly(readFile("../public/scripts/rating-likes.js"));
check("likes: trava por rating (sem request duplo)", /busyByKey/.test(likes));
check("likes: optimistic sincroniza todos os controles", /syncAll\(identity, !wasLiked/.test(likes));
check("likes: rollback preservado", /syncAll\(identity, wasLiked, prevCount\)/.test(likes));

const comments = codeOnly(readFile("../public/scripts/rating-comments.js"));
check("comments: status role=status", /comments-status/.test(comments) && /role", "status"/.test(comments));
check("comments: skeleton na primeira abertura", /comments-skeleton/.test(comments));
check("comments: retry após falha", /comments-retry/.test(comments));
check("comments: foco volta ao editar após salvar/cancelar", /focusEditButton/.test(comments));
check("comments: foco volta ao toggle após remover", /comments-toggle[\s\S]{0,200}\.focus\(\)/.test(comments));
check("comments: contador na edição", /comment-edit-counter/.test(comments));
check("comments: send bloqueado quando vazio", /composer-send[\s\S]{0,400}disabled/.test(comments));
check("comments: sem innerHTML", !/innerHTML/.test(comments));

const control = readFile("../src/components/ratings/RatingCommentsControl.astro");
check("comments SSR: status role=status no painel", /data-role="comments-status"[^>]*role="status"|role="status"[^>]*data-role="comments-status"/.test(control));

const publicPage = codeOnly(readFile("../src/pages/u/[username].astro"));
check("follow: rótulo dedicado (sem childNodes frágil)", /data-followers-label/.test(publicPage));
check("follow: unfollow com loading (Removendo)", /Removendo/.test(publicPage));
check("perfil público: empty assistidos", /Ainda não há assistidos públicos/.test(publicPage));
check("perfil público: empty avaliações", /Ainda não há avaliações públicas/.test(publicPage));

const feedCard = readFile("../src/components/feed/FeedActivityCard.astro");
check("feed: avatar >=48px", /h-12 w-12/.test(feedCard));
check("feed: break-words no header/texto", /break-words/.test(feedCard));

// ------------------------------------------------- F. token <script> em comentários
function astroFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...astroFiles(full));
    else if (entry.endsWith(".astro")) out.push(full);
  }
  return out;
}
{
  const files = astroFiles(new URL("../src/", import.meta.url).pathname);
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // Comentários com o token literal quebram o Vite scan; tags reais ok.
    const stripped = text.replace(/<script(\s[^>]*)?>[\s\S]*?<\/script>/g, "");
    if (/<script/i.test(stripped)) offenders.push(f);
  }
  check("nenhum .astro com token <script> fora de tag real", offenders.length === 0, offenders.slice(0, 3).join(", "));
}

console.log("---");
console.log(
  failures === 0
    ? "POLISH OK: TTL + privacidade + home + social + scan íntegros."
    : `POLISH FALHOU: ${failures} asserção(ões).`,
);
process.exit(failures === 0 ? 0 : 1);
