/**
 * Delegation compartilhada de curtidas em avaliações (Etapa 18).
 * UM listener no documento trata [data-rating-like] em qualquer página
 * (feed SSR, cards client-side, perfil público, Carregar mais).
 *
 * Fluxo: optimistic paint + count → POST/DELETE → estado do servidor
 * (fonte final) → sync de TODOS os controles da mesma rating no DOM.
 * Falha → rollback. Sem request duplo (trava por rating). 401 →
 * redirect para login com next. Sem HTML cru, sem UUID.
 */
(function () {
  "use strict";

  function identityOf(el) {
    var username = el.getAttribute("data-rating-owner-username") || "";
    var mediaType = el.getAttribute("data-rating-media-type") || "";
    var tmdbId = Number(el.getAttribute("data-rating-tmdb-id") || "0");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return null;
    if (mediaType !== "movie" && mediaType !== "tv") return null;
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) return null;
    return { username: username, mediaType: mediaType, tmdbId: tmdbId };
  }

  function keyOf(identity) {
    return identity.username + ":" + identity.mediaType + ":" + identity.tmdbId;
  }

  function controlsFor(identity) {
    var key = keyOf(identity);
    var all = document.querySelectorAll("[data-rating-like]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var id = identityOf(el);
      if (id && keyOf(id) === key) out.push(el);
    }
    return out;
  }

  function paint(control, liked, count) {
    control.setAttribute("data-liked", liked ? "true" : "false");
    control.setAttribute("aria-pressed", liked ? "true" : "false");
    control.setAttribute(
      "aria-label",
      liked ? "Remover curtida da avaliação" : "Curtir avaliação",
    );
    var glyph = control.querySelector('[data-role="like-glyph"]');
    if (glyph) {
      glyph.textContent = liked ? "♥" : "♡";
      glyph.classList.toggle("text-primary", liked);
      glyph.classList.toggle("text-base-content/60", !liked);
    }
    var countEl = control.querySelector('[data-role="like-count"]');
    if (countEl) countEl.textContent = String(Math.max(0, count | 0));
  }

  /** Pinta todos os controles da mesma rating (sincronia entre cards). */
  function syncAll(identity, liked, count) {
    var controls = controlsFor(identity);
    for (var i = 0; i < controls.length; i++) {
      paint(controls[i], liked, count);
    }
  }

  /**
   * Constrói um controle de like via DOM (sem HTML cru) para os cards
   * renderizados client-side. Mesmo markup do RatingLikeControl SSR.
   * target: { username, mediaType, tmdbId, likeCount, likedByViewer,
   *   interactive }. Sem likeCount numérico → null (pré-migration).
   */
  function buildControl(target) {
    if (!target || typeof target !== "object") return null;
    if (typeof target.likeCount !== "number" || !Number.isSafeInteger(target.likeCount)) {
      return null;
    }
    var identity = identityOf({
      getAttribute: function (name) {
        if (name === "data-rating-owner-username") return target.username;
        if (name === "data-rating-media-type") return target.mediaType;
        if (name === "data-rating-tmdb-id") return String(target.tmdbId);
        return null;
      },
    });
    if (!identity) return null;
    var liked = target.likedByViewer === true;
    var count = Math.max(0, target.likeCount);
    var root;
    if (target.interactive === false) {
      root = document.createElement("span");
      root.setAttribute("data-rating-like-static", "");
      root.setAttribute(
        "aria-label",
        count + " " + (count === 1 ? "curtida" : "curtidas"),
      );
    } else {
      root = document.createElement("button");
      root.setAttribute("type", "button");
      root.setAttribute("data-rating-like", "");
      root.setAttribute("data-liked", liked ? "true" : "false");
      root.setAttribute("aria-pressed", liked ? "true" : "false");
      root.setAttribute(
        "aria-label",
        liked ? "Remover curtida da avaliação" : "Curtir avaliação",
      );
    }
    root.setAttribute("data-rating-owner-username", identity.username);
    root.setAttribute("data-rating-media-type", identity.mediaType);
    root.setAttribute("data-rating-tmdb-id", String(identity.tmdbId));
    root.className =
      "inline-flex min-h-12 min-w-12 items-center gap-1.5 rounded-full px-3 text-sm transition-opacity hover:bg-base-200";
    var glyph = document.createElement("span");
    glyph.setAttribute("data-role", "like-glyph");
    glyph.setAttribute("aria-hidden", "true");
    glyph.className = "text-base " + (liked ? "text-primary" : "text-base-content/60");
    glyph.textContent = liked && root.tagName === "BUTTON" ? "♥" : "♡";
    var countEl = document.createElement("span");
    countEl.setAttribute("data-role", "like-count");
    countEl.className = "font-semibold tabular-nums text-base-content/80";
    countEl.textContent = String(count);
    root.appendChild(glyph);
    root.appendChild(countEl);
    return root;
  }

  function setBusy(control, on) {
    if (on) control.setAttribute("data-busy", "");
    else control.removeAttribute("data-busy");
    if (control instanceof HTMLButtonElement) control.disabled = on;
  }

  /** Trava por rating (não só por controle): 2 controles da mesma rating
   *  não disparam request duplo. */
  var busyByKey = {};

  function setBusyKey(identity, on) {
    var key = keyOf(identity);
    if (on) {
      busyByKey[key] = true;
      var controls = controlsFor(identity);
      for (var i = 0; i < controls.length; i++) setBusy(controls[i], true);
    } else {
      delete busyByKey[key];
      var done = controlsFor(identity);
      for (var j = 0; j < done.length; j++) setBusy(done[j], false);
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var control = target.closest("[data-rating-like]");
    if (!(control instanceof HTMLButtonElement)) return;
    if (control.hasAttribute("data-busy")) return;
    var identity = identityOf(control);
    if (!identity) return;
    if (busyByKey[keyOf(identity)]) return;

    var wasLiked = control.getAttribute("data-liked") === "true";
    var countEl = control.querySelector('[data-role="like-count"]');
    var prevCount = countEl ? Number(countEl.textContent) || 0 : 0;

    // Optimistic em TODOS os controles da rating (sem stale entre cards).
    syncAll(identity, !wasLiked, prevCount + (wasLiked ? -1 : 1));
    setBusyKey(identity, true);

    fetch("/api/ratings/likes", {
      method: wasLiked ? "DELETE" : "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity),
    })
      .then(function (response) {
        if (response.status === 401) {
          var next = window.location.pathname + window.location.search;
          window.location.href = "/entrar?next=" + encodeURIComponent(next);
          throw new Error("login");
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        // Servidor é a fonte final: estado + contador reais.
        var liked = data && data.liked === true;
        var count = data && Number.isSafeInteger(data.likeCount) ? data.likeCount : prevCount;
        syncAll(identity, liked, count);
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        // Rollback: volta ao estado anterior.
        syncAll(identity, wasLiked, prevCount);
      })
      .then(function () {
        setBusyKey(identity, false);
      });
  });

  window.CineVeeRatingLikes = {
    paint: paint,
    syncAll: syncAll,
    buildControl: buildControl,
  };
})();
