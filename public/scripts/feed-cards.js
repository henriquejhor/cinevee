/**
 * Builder client-side de cards do feed "Seguindo" (Etapa 17).
 * Compartilhado pela Home (prévia) e por /seguindo (Carregar mais).
 *
 * Texto via textContent/setAttribute (sem HTML cru). Nenhum id interno.
 * Rótulos acessíveis usam texto sem tags (hardening Etapa 16).
 * Espera um <template> com os slots data-role usados abaixo.
 */
(function () {
  "use strict";

  function initialsFor(value) {
    var parts = String(value || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    var first = parts[0].charAt(0) || "";
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) || "" : "";
    return (first + last).toUpperCase() || "?";
  }

  /** "há 2 h" / "há 1 d" — sem biblioteca de datas. */
  function relativeTime(iso) {
    var then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    var diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (diff < 60) return "agora mesmo";
    var minutes = Math.floor(diff / 60);
    if (minutes < 60) return "há " + minutes + " min";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return "há " + hours + " h";
    var days = Math.floor(hours / 24);
    if (days === 1) return "há 1 dia";
    if (days < 7) return "há " + days + " dias";
    var weeks = Math.floor(days / 7);
    if (weeks === 1) return "há 1 sem";
    if (weeks < 5) return "há " + weeks + " sem";
    var months = Math.floor(days / 30);
    if (months === 1) return "há 1 mês";
    if (months < 12) return "há " + months + " meses";
    var years = Math.floor(days / 365);
    return years === 1 ? "há 1 ano" : "há " + years + " anos";
  }

  /** Item válido da API (só os 3 tipos, sem internals). */
  function validItem(item) {
    if (!item || typeof item !== "object") return false;
    if (item.type !== "rating" && item.type !== "favorite" && item.type !== "recommendation") {
      return false;
    }
    if (!item.actor || typeof item.actor.username !== "string" || item.actor.username.length === 0) {
      return false;
    }
    if (!item.title || typeof item.title.title !== "string" || item.title.title.length === 0) {
      return false;
    }
    if (item.title.mediaType !== "movie" && item.title.mediaType !== "tv") return false;
    if (!Number.isSafeInteger(item.title.tmdbId)) return false;
    if (typeof item.eventKey !== "string" || item.eventKey.length === 0) return false;
    if (typeof item.activityAt !== "string" || Number.isNaN(Date.parse(item.activityAt))) return false;
    return true;
  }

  function setText(node, role, value) {
    var el = node.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = value;
    return el;
  }

  /**
   * Clona o <template> preenchido a partir do item. Retorna o DocumentFragment
   * ou null (template ausente/item inválido). A classe de clamp do texto vem
   * do próprio template (compact na Home, full em /seguindo).
   */
  function buildCard(template, item) {
    if (!(template instanceof HTMLTemplateElement)) return null;
    if (!validItem(item)) return null;
    var node = template.content.cloneNode(true);
    var card = node.querySelector("[data-feed-card]");
    if (!(card instanceof HTMLElement)) return null;
    card.setAttribute("data-key", item.eventKey);

    var name =
      item.actor.displayName && item.actor.displayName.trim()
        ? item.actor.displayName.trim()
        : "@" + item.actor.username;
    var action =
      item.type === "rating" ? "avaliou" : item.type === "recommendation" ? "recomenda" : "adicionou";
    var actionSuffix = item.type === "favorite" ? " aos favoritos" : "";
    var titleHref = "/titulo/" + item.title.mediaType + "/" + item.title.tmdbId;

    var actorLink = node.querySelector('[data-role="actor-link"]');
    if (actorLink instanceof HTMLAnchorElement) {
      actorLink.href = "/u/" + item.actor.username;
      var plainName = name.replace(/<[^>]*>/g, "").trim() || "@" + item.actor.username;
      actorLink.setAttribute("aria-label", "Ver perfil de " + plainName);
    }
    if (typeof item.actor.avatarUrl === "string" && item.actor.avatarUrl.length > 0) {
      var avatar = node.querySelector('[data-role="avatar"]');
      if (avatar instanceof HTMLImageElement) {
        avatar.src = item.actor.avatarUrl;
        avatar.removeAttribute("hidden");
      }
      var initials = node.querySelector('[data-role="initials"]');
      if (initials) initials.setAttribute("hidden", "");
    } else {
      var fallback = node.querySelector('[data-role="initials"]');
      if (fallback) fallback.textContent = initialsFor(name);
    }
    var nameEl = node.querySelector('[data-role="name"]');
    if (nameEl instanceof HTMLAnchorElement) {
      nameEl.textContent = name;
      nameEl.href = "/u/" + item.actor.username;
    }
    setText(node, "action", " " + action + " ");
    var titleEl = node.querySelector('[data-role="title-link"]');
    if (titleEl instanceof HTMLAnchorElement) {
      titleEl.textContent = item.title.title;
      titleEl.href = titleHref;
    }
    setText(node, "action-suffix", actionSuffix);
    setText(node, "username", "@" + item.actor.username);
    var timeEl = node.querySelector('[data-role="time"]');
    if (timeEl instanceof HTMLTimeElement) {
      timeEl.textContent = relativeTime(item.activityAt);
      timeEl.setAttribute("datetime", item.activityAt);
    }
    var posterLink = node.querySelector('[data-role="poster-link"]');
    if (posterLink instanceof HTMLAnchorElement) posterLink.href = titleHref;
    if (typeof item.title.posterUrl === "string" && item.title.posterUrl.length > 0) {
      var poster = node.querySelector('[data-role="poster"]');
      if (poster instanceof HTMLImageElement) {
        poster.src = item.title.posterUrl;
        poster.removeAttribute("hidden");
      }
    } else {
      var posterFallback = node.querySelector('[data-role="poster-fallback"]');
      if (posterFallback instanceof HTMLElement) {
        posterFallback.textContent = initialsFor(item.title.title);
        posterFallback.removeAttribute("hidden");
      }
    }
    if (item.type === "rating" && Number.isInteger(item.rating) && item.rating >= 1 && item.rating <= 5) {
      var stars = node.querySelector('[data-role="stars"]');
      if (stars instanceof HTMLElement) {
        stars.removeAttribute("hidden");
        var glyph = node.querySelector('[data-role="stars-glyph"]');
        if (glyph) glyph.textContent = "★★★★★".slice(0, item.rating) + "★★★★★".slice(0, 5 - item.rating);
        var label = node.querySelector('[data-role="stars-label"]');
        if (label) label.textContent = "Nota " + item.rating + " de 5";
      }
    }
    if (typeof item.text === "string" && item.text.trim().length > 0) {
      var text = node.querySelector('[data-role="text"]');
      if (text instanceof HTMLElement) {
        text.textContent = item.text.trim();
        text.removeAttribute("hidden");
      }
    }
    // Curtida (Etapa 18): só rating events com likeCount numérico.
    // Favorite/recommendation nunca recebem botão. Construção via
    // builder compartilhado (sem HTML cru); estado via delegation.
    if (item.type === "rating") {
      var slot = node.querySelector('[data-role="like-slot"]');
      var likes = window.CineVeeRatingLikes;
      if (slot instanceof HTMLElement && likes && typeof likes.buildControl === "function") {
        var control = likes.buildControl({
          username: item.actor.username,
          mediaType: item.title.mediaType,
          tmdbId: item.title.tmdbId,
          likeCount: item.likeCount,
          likedByViewer: item.likedByViewer === true,
          interactive: true,
        });
        if (control) slot.appendChild(control);
      }
    }
    // Comentários (Etapa 19): só rating events com commentCount
    // numérico. Favorite/recommendation nunca recebem. Construção via
    // builder compartilhado (sem HTML cru); thread carrega lazy.
    if (item.type === "rating") {
      var commentsSlot = node.querySelector('[data-role="comments-slot"]');
      var comments = window.CineVeeRatingComments;
      if (
        commentsSlot instanceof HTMLElement && comments &&
        typeof comments.buildControl === "function" &&
        typeof item.commentCount === "number"
      ) {
        var commentsControl = comments.buildControl({
          username: item.actor.username,
          mediaType: item.title.mediaType,
          tmdbId: item.title.tmdbId,
          commentCount: item.commentCount,
          commentsEnabled: item.commentsEnabled === true,
        });
        if (commentsControl) commentsSlot.appendChild(commentsControl);
      }
    }
    return node;
  }

  window.CineVeeFeedCards = {
    validItem: validItem,
    buildCard: buildCard,
    relativeTime: relativeTime,
  };
})();
