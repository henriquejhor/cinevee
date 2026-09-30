/**
 * Delegation compartilhada de comentários em avaliações (Etapa 19).
 * UM listener no documento trata [data-rating-comments] em qualquer
 * página (feed SSR, cards client-side, perfil público, Carregar mais).
 *
 * Fluxo: toggle expande → GET thread (lazy, 5 + sonda) → monta via DOM
 * (createElement/textContent — sem HTML cru, sem UUID) → composer
 * (POST), edição inline (PATCH), remoção com confirmação (DELETE).
 * Contador do servidor é a fonte final; sync entre controles da mesma
 * rating (chave username:media:tmdbId). Falha preserva o texto digitado.
 * 401 → redirect para login com next. Comentário nunca é evento de feed.
 */
(function () {
  "use strict";

  var PAGE_SIZE = 5;
  var MAX_LENGTH = 500;

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
    var all = document.querySelectorAll("[data-rating-comments]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var id = identityOf(all[i]);
      if (id && keyOf(id) === key) out.push(all[i]);
    }
    return out;
  }

  function toggleLabel(count) {
    var n = Math.max(0, count | 0);
    return n === 0 ? "Comentar" : "Ver " + n + " " + (n === 1 ? "comentário" : "comentários");
  }

  function paintToggle(control, count) {
    var n = Math.max(0, Number(count) || 0);
    control.setAttribute("data-count", String(n));
    var label = toggleLabel(n);
    var countEl = control.querySelector('[data-role="comments-count"]');
    if (countEl) countEl.textContent = String(n);
    var labelEl = control.querySelector('[data-role="comments-label"]');
    if (labelEl) labelEl.textContent = label;
    var toggle = control.querySelector('[data-role="comments-toggle"]');
    if (toggle) toggle.setAttribute("aria-label", label);
  }

  function paintEnabled(control, enabled) {
    control.setAttribute("data-enabled", enabled ? "true" : "false");
  }

  /** Atualiza count (+enabled) em TODOS os controles da mesma rating. */
  function syncCounts(identity, count, enabled) {
    var controls = controlsFor(identity);
    for (var i = 0; i < controls.length; i++) {
      paintToggle(controls[i], count);
      if (typeof enabled === "boolean") {
        paintEnabled(controls[i], enabled);
        var notice = controls[i].querySelector('[data-role="comments-disabled"]');
        if (notice) notice.hidden = enabled;
      }
    }
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

  function initialsFor(value) {
    var parts = String(value || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    var first = parts[0].charAt(0) || "";
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) || "" : "";
    return (first + last).toUpperCase() || "?";
  }

  function threadUrl(identity, page) {
    return (
      "/api/ratings/comments?username=" + encodeURIComponent(identity.username) +
      "&tmdbId=" + encodeURIComponent(String(identity.tmdbId)) +
      "&mediaType=" + encodeURIComponent(identity.mediaType) +
      "&page=" + encodeURIComponent(String(page)) +
      "&limit=" + encodeURIComponent(String(PAGE_SIZE))
    );
  }

  function redirectLogin() {
    var next = window.location.pathname + window.location.search;
    window.location.href = "/entrar?next=" + encodeURIComponent(next);
  }

  function setStatus(panel, message) {
    var status = ensureStatus(panel);
    if (status) status.textContent = message || "";
  }

  /** Linha de status/erro da thread (role=status). Criada sob demanda. */
  function ensureStatus(panel) {
    var status = panel.querySelector('[data-role="comments-status"]');
    if (status instanceof HTMLElement) return status;
    var node = document.createElement("p");
    node.setAttribute("data-role", "comments-status");
    node.setAttribute("role", "status");
    node.className = "py-1 text-sm text-base-content/60";
    panel.appendChild(node);
    return node;
  }

  /** Esqueleto discreto da primeira abertura (visual; o texto vai ao status). */
  function showSkeleton(panel) {
    hideSkeleton(panel);
    var wrap = document.createElement("div");
    wrap.setAttribute("data-role", "comments-skeleton");
    wrap.setAttribute("aria-hidden", "true");
    wrap.className = "mt-2 flex flex-col gap-2";
    for (var i = 0; i < 3; i++) {
      var row = document.createElement("div");
      row.className = "skeleton h-12 w-full";
      wrap.appendChild(row);
    }
    panel.appendChild(wrap);
    panel.setAttribute("aria-busy", "true");
  }

  function hideSkeleton(panel) {
    var wrap = panel.querySelector('[data-role="comments-skeleton"]');
    if (wrap) wrap.remove();
    panel.removeAttribute("aria-busy");
  }

  /** Botão de retry após falha no primeiro carregamento. */
  function showRetry(panel, control, identity) {
    hideRetry(panel);
    var retry = document.createElement("button");
    retry.setAttribute("type", "button");
    retry.setAttribute("data-role", "comments-retry");
    retry.className = "btn btn-outline mt-1 min-h-12 rounded-full px-6 text-sm";
    retry.textContent = "Tentar novamente";
    retry.addEventListener("click", function () {
      hideRetry(panel);
      loadPage(control, panel, identity, 1);
    });
    panel.appendChild(retry);
  }

  function hideRetry(panel) {
    var retry = panel.querySelector('[data-role="comments-retry"]');
    if (retry) retry.remove();
  }

  /** Devolve o foco ao botão de edição do item (após salvar/cancelar). */
  function focusEditButton(itemLi) {
    var edit = itemLi.querySelector('[data-role="comment-edit"]');
    if (edit instanceof HTMLElement) edit.focus();
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function validComment(item) {
    return (
      item && typeof item === "object" &&
      Number.isSafeInteger(item.commentId) && item.commentId >= 1 &&
      typeof item.text === "string" &&
      typeof item.createdAt === "string" &&
      typeof item.updatedAt === "string" &&
      item.author && typeof item.author === "object"
    );
  }

  function buildAuthorHeader(item) {
    var wrap = el("div", "flex min-w-0 flex-wrap items-baseline gap-x-2 break-words");
    var author = item.author;
    var name = null;
    if (author.isPrivate === true) {
      name = el("span", "text-sm font-semibold text-base-content/70", "Usuário privado");
    } else if (typeof author.username === "string" && author.username.length > 0) {
      var shown = author.displayName && author.displayName.trim()
        ? author.displayName.trim()
        : "@" + author.username;
      var link = document.createElement("a");
      link.className = "text-sm font-semibold hover:text-primary";
      link.textContent = shown;
      link.href = "/u/" + author.username;
      link.setAttribute("aria-label", "Ver perfil de " + shown.replace(/<[^>]*>/g, "").trim());
      name = link;
      var handle = el("span", "text-xs text-base-content/50", "@" + author.username);
      wrap.appendChild(name);
      wrap.appendChild(handle);
      var time = document.createElement("time");
      time.className = "text-xs text-base-content/50";
      time.setAttribute("datetime", item.createdAt);
      time.textContent = relativeTime(item.createdAt);
      wrap.appendChild(time);
      return wrap;
    } else {
      name = el("span", "text-sm font-semibold text-base-content/70", "Usuário privado");
    }
    wrap.appendChild(name);
    var timeEl = document.createElement("time");
    timeEl.className = "text-xs text-base-content/50";
    timeEl.setAttribute("datetime", item.createdAt);
    timeEl.textContent = relativeTime(item.createdAt);
    wrap.appendChild(timeEl);
    return wrap;
  }

  function buildAvatar(item) {
    var box = el("span", "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-violet-700 via-indigo-700 to-blue-800 text-xs font-extrabold text-white");
    box.setAttribute("aria-hidden", "true");
    var author = item.author;
    if (author.isPrivate !== true && typeof author.avatarUrl === "string" && author.avatarUrl.length > 0) {
      var img = document.createElement("img");
      img.className = "h-full w-full object-cover";
      img.src = author.avatarUrl;
      img.alt = "";
      img.loading = "lazy";
      img.width = 64;
      img.height = 64;
      box.appendChild(img);
    } else {
      var shown = author.isPrivate === true
        ? "?"
        : initialsFor(author.displayName || author.username || "?");
      box.textContent = shown;
    }
    return box;
  }

  function buildActions(item) {
    var row = el("div", "mt-1 flex flex-wrap items-center gap-1");
    if (item.canEdit === true) {
      var edit = document.createElement("button");
      edit.setAttribute("type", "button");
      edit.setAttribute("data-role", "comment-edit");
      edit.setAttribute("aria-label", "Editar comentário");
      edit.className = "inline-flex min-h-12 items-center rounded-lg px-2 text-xs text-base-content/60 underline-offset-4 hover:text-primary hover:underline";
      edit.textContent = "Editar";
      row.appendChild(edit);
    }
    if (item.canDelete === true) {
      var del = document.createElement("button");
      del.setAttribute("type", "button");
      del.setAttribute("data-role", "comment-delete");
      var ownerModeration = item.canEdit !== true;
      del.setAttribute("aria-label", ownerModeration ? "Remover comentário" : "Excluir comentário");
      del.className = "inline-flex min-h-12 items-center rounded-lg px-2 text-xs text-error/80 underline-offset-4 hover:text-error hover:underline";
      del.textContent = ownerModeration ? "Remover" : "Excluir";
      row.appendChild(del);
    }
    return row;
  }

  function buildItem(item, replyCtx) {
    var li = document.createElement("li");
    li.setAttribute("data-comment-id", String(item.commentId));
    li.className = "flex gap-2.5 py-3";
    li.appendChild(buildAvatar(item));
    var body = el("div", "min-w-0 flex-1");
    body.appendChild(buildAuthorHeader(item));
    var text = el("p", "mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-base-content/85");
    text.setAttribute("data-role", "comment-text");
    text.textContent = item.text;
    body.appendChild(text);
    if (item.edited === true) {
      var editedMarker = el("p", "mt-0.5 text-xs text-base-content/45", "editado");
      editedMarker.setAttribute("data-role", "comment-edited");
      body.appendChild(editedMarker);
    }
    body.appendChild(buildActions(item));
    var editZone = el("div", "mt-2");
    editZone.setAttribute("data-role", "comment-edit-zone");
    editZone.hidden = true;
    body.appendChild(editZone);
    body.appendChild(buildRepliesSection(item, replyCtx));
    li.appendChild(body);
    return li;
  }

  function knownIds(list) {
    var ids = {};
    var items = list.querySelectorAll("[data-comment-id]");
    for (var i = 0; i < items.length; i++) {
      ids[items[i].getAttribute("data-comment-id")] = true;
    }
    return ids;
  }

  function appendItems(panel, items, replyCtx) {
    var list = panel.querySelector('[data-role="comments-list"]');
    if (!(list instanceof HTMLElement)) return 0;
    var known = knownIds(list);
    var added = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!validComment(item)) continue;
      if (known[String(item.commentId)]) continue;
      known[String(item.commentId)] = true;
      list.appendChild(buildItem(item, replyCtx));
      added += 1;
    }
    return added;
  }

  function buildComposer(identity, canComment, commentsEnabled, isOwner) {
    var box = el("div", "mt-2");
    box.setAttribute("data-role", "comments-composer");
    if (canComment === true) {
      var label = document.createElement("label");
      label.className = "text-xs font-semibold text-base-content/70";
      label.textContent = "Seu comentário será público.";
      var areaId = "rc-text-" + identity.username + "-" + identity.mediaType + "-" + identity.tmdbId;
      label.setAttribute("for", areaId);
      box.appendChild(label);
      var area = document.createElement("textarea");
      area.id = areaId;
      area.setAttribute("data-role", "composer-text");
      area.setAttribute("rows", "2");
      area.setAttribute("maxlength", String(MAX_LENGTH));
      area.setAttribute("placeholder", "Escreva um comentário…");
      area.className = "textarea textarea-bordered mt-1 min-h-12 w-full text-sm leading-6";
      box.appendChild(area);
      var row = el("div", "mt-1 flex min-h-12 items-center justify-between gap-3");
      var counter = el("p", "text-xs tabular-nums text-base-content/50", "0 / " + MAX_LENGTH);
      counter.setAttribute("data-role", "composer-counter");
      counter.setAttribute("aria-live", "off");
      row.appendChild(counter);
      var send = document.createElement("button");
      send.setAttribute("type", "button");
      send.setAttribute("data-role", "composer-send");
      send.setAttribute("aria-label", "Comentar");
      // Começa desabilitado (textarea vazia); o input reabilita.
      send.setAttribute("disabled", "");
      send.className = "btn btn-primary min-h-12 rounded-full px-6 text-sm font-semibold";
      send.textContent = "Comentar";
      row.appendChild(send);
      box.appendChild(row);
    } else if (commentsEnabled !== true) {
      var notice = el("p", "py-2 text-sm text-base-content/60", "Novos comentários estão desativados.");
      notice.setAttribute("data-role", "comments-disabled");
      box.appendChild(notice);
    } else if (isOwner !== true) {
      var login = document.createElement("a");
      var next = window.location.pathname + window.location.search;
      login.href = "/entrar?next=" + encodeURIComponent(next);
      login.className = "btn btn-outline min-h-12 rounded-full px-6 text-sm";
      login.textContent = "Entre para comentar";
      box.appendChild(login);
    }
    return box;
  }

  function buildMoreButton() {
    var more = document.createElement("button");
    more.setAttribute("type", "button");
    more.setAttribute("data-role", "comments-more");
    more.setAttribute("aria-label", "Carregar mais comentários");
    more.className = "btn btn-ghost mt-1 min-h-12 rounded-full px-6 text-sm";
    more.textContent = "Carregar mais";
    return more;
  }

  function controlBusy(control, on) {
    if (on) control.setAttribute("data-loading", "");
    else control.removeAttribute("data-loading");
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(function (response) {
      if (response.status === 401) {
        redirectLogin();
        throw new Error("login");
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function loadPage(control, panel, identity, page) {
    controlBusy(control, true);
    if (page === 1) {
      hideRetry(panel);
      showSkeleton(panel);
    }
    setStatus(panel, page === 1 ? "Carregando comentários…" : "Carregando…");
    return fetchJson(threadUrl(identity, page), { credentials: "same-origin" })
      .then(function (data) {
        var items = data && Array.isArray(data.items) ? data.items : [];
        if (page === 1) {
          hideSkeleton(panel);
          hideRetry(panel);
          paintToggle(control, data && typeof data.commentCount === "number" ? data.commentCount : 0);
          paintEnabled(control, data && data.commentsEnabled === true);
          var old = panel.querySelector('[data-role="comments-body"]');
          if (old) old.remove();
          var body = el("div", "rounded-2xl border border-base-300/60 bg-base-200/40 px-3 py-1");
          body.setAttribute("data-role", "comments-body");
          body.appendChild(buildComposer(
            identity,
            data && data.canComment === true,
            data && data.commentsEnabled === true,
            data && data.isOwner === true,
          ));
          var list = document.createElement("ul");
          list.setAttribute("data-role", "comments-list");
          list.setAttribute("aria-label", "Comentários");
          body.appendChild(list);
          if (items.length === 0) {
            body.appendChild(el("p", "py-2 text-sm text-base-content/60", "Ainda não há comentários."));
          }
          panel.appendChild(body);
          control.setAttribute("data-loaded", "true");
          control.setAttribute("data-page", "1");
          syncCounts(identity, data && typeof data.commentCount === "number" ? data.commentCount : 0,
            data && data.commentsEnabled === true);
        }
        var replyCtx = {
          identity: identity,
          commentsEnabled: data && data.commentsEnabled === true,
        };
        var added = appendItems(panel, items, replyCtx);
        var more = panel.querySelector('[data-role="comments-more"]');
        if (data && data.hasMore === true) {
          if (!more) {
            var bodyEl = panel.querySelector('[data-role="comments-body"]');
            if (bodyEl) bodyEl.appendChild(buildMoreButton());
          }
          control.setAttribute("data-page", String(page));
        } else if (more) {
          more.remove();
        }
        setStatus(panel, "");
        return added;
      })
      .catch(function (error) {
        if (error && error.message === "login") return 0;
        if (page === 1) {
          hideSkeleton(panel);
          showRetry(panel, control, identity);
        }
        setStatus(panel, "Não foi possível carregar os comentários. Tente de novo.");
        return 0;
      })
      .then(function (added) {
        controlBusy(control, false);
        return added;
      });
  }

  function setToggle(control, open) {
    var toggle = control.querySelector('[data-role="comments-toggle"]');
    var panel = control.querySelector('[data-role="comments-panel"]');
    if (!(toggle instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    panel.hidden = !open;
  }

  function submitComposer(control, panel, identity, sendButton) {
    if (sendButton.hasAttribute("data-busy")) return;
    var area = panel.querySelector('[data-role="composer-text"]');
    if (!(area instanceof HTMLTextAreaElement)) return;
    var text = area.value.trim();
    if (text.length === 0 || text.length > MAX_LENGTH) {
      setStatus(panel, text.length === 0 ? "Escreva seu comentário antes de enviar." : "Seu comentário deve ter no máximo " + MAX_LENGTH + " caracteres.");
      return;
    }
    sendButton.setAttribute("data-busy", "");
    sendButton.setAttribute("disabled", "");
    var original = sendButton.textContent;
    sendButton.textContent = "Enviando…";
    setStatus(panel, "");
    fetchJson("/api/ratings/comments", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: identity.username,
        tmdbId: identity.tmdbId,
        mediaType: identity.mediaType,
        text: text,
      }),
    })
      .then(function (data) {
        if (!validComment(data && data.comment)) throw new Error("bad-comment");
        var list = panel.querySelector('[data-role="comments-list"]');
        if (list instanceof HTMLElement) {
          var empty = null;
          // Remove o "Ainda não há comentários." ao chegar o primeiro.
          var paras = panel.querySelectorAll('[data-role="comments-body"] > p');
          for (var i = 0; i < paras.length; i++) {
            if (/Ainda não há comentários/.test(paras[i].textContent || "")) {
              empty = paras[i];
              break;
            }
          }
          if (empty) empty.remove();
          if (!list.querySelector('[data-comment-id="' + data.comment.commentId + '"]')) {
            var replyCtx = {
              identity: identity,
              commentsEnabled: control.getAttribute("data-enabled") === "true",
            };
            var node = buildItem(data.comment, replyCtx);
            if (list.firstChild) list.insertBefore(node, list.firstChild);
            else list.appendChild(node);
          }
        }
        area.value = "";
        var counter = panel.querySelector('[data-role="composer-counter"]');
        if (counter) counter.textContent = "0 / " + MAX_LENGTH;
        var count = data && Number.isSafeInteger(data.commentCount) ? data.commentCount : null;
        if (count !== null) syncCounts(identity, count);
        setStatus(panel, "Comentário publicado.");
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        // Texto preservado: nada é apagado em caso de falha.
        setStatus(panel, "Não foi possível publicar seu comentário. Tente de novo.");
      })
      .then(function () {
        sendButton.removeAttribute("data-busy");
        sendButton.removeAttribute("disabled");
        sendButton.textContent = original;
      });
  }

  function openEditZone(itemLi, item) {
    var zone = itemLi.querySelector('[data-role="comment-edit-zone"]');
    if (!(zone instanceof HTMLElement) || !zone.hidden) return;
    zone.hidden = false;
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    var area = document.createElement("textarea");
    area.setAttribute("data-role", "comment-edit-text");
    area.setAttribute("rows", "3");
    area.setAttribute("maxlength", String(MAX_LENGTH));
    area.setAttribute("aria-label", "Editar comentário");
    area.className = "textarea textarea-bordered min-h-12 w-full text-sm leading-6";
    var current = itemLi.querySelector('[data-role="comment-text"]');
    area.value = current ? current.textContent || "" : item.text;
    zone.appendChild(area);
    var editCounter = el("p", "mt-1 text-xs tabular-nums text-base-content/50",
      String(area.value.trim().length) + " / " + MAX_LENGTH);
    editCounter.setAttribute("data-role", "comment-edit-counter");
    editCounter.setAttribute("aria-live", "off");
    zone.appendChild(editCounter);
    var row = el("div", "mt-1 flex flex-wrap items-center gap-2");
    var save = document.createElement("button");
    save.setAttribute("type", "button");
    save.setAttribute("data-role", "comment-edit-save");
    save.setAttribute("aria-label", "Salvar comentário");
    save.className = "btn btn-primary min-h-12 rounded-full px-6 text-sm font-semibold";
    save.textContent = "Salvar";
    var cancel = document.createElement("button");
    cancel.setAttribute("type", "button");
    cancel.setAttribute("data-role", "comment-edit-cancel");
    cancel.setAttribute("aria-label", "Cancelar edição");
    cancel.className = "btn btn-ghost min-h-12 rounded-full px-6 text-sm";
    cancel.textContent = "Cancelar";
    row.appendChild(save);
    row.appendChild(cancel);
    zone.appendChild(row);
    area.focus();
  }

  function saveEdit(control, panel, identity, itemLi, commentId) {
    var zone = itemLi.querySelector('[data-role="comment-edit-zone"]');
    var area = itemLi.querySelector('[data-role="comment-edit-text"]');
    var save = itemLi.querySelector('[data-role="comment-edit-save"]');
    if (!(area instanceof HTMLTextAreaElement) || !(save instanceof HTMLElement)) return;
    if (save.hasAttribute("data-busy")) return;
    var text = area.value.trim();
    if (text.length === 0 || text.length > MAX_LENGTH) {
      setStatus(panel, text.length === 0 ? "Escreva seu comentário antes de enviar." : "Seu comentário deve ter no máximo " + MAX_LENGTH + " caracteres.");
      return;
    }
    save.setAttribute("data-busy", "");
    save.setAttribute("disabled", "");
    fetchJson("/api/ratings/comments", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId: commentId, text: text }),
    })
      .then(function (data) {
        if (!validComment(data)) throw new Error("bad-comment");
        var textEl = itemLi.querySelector('[data-role="comment-text"]');
        if (textEl) textEl.textContent = data.text;
        // Marca "editado" sem reordenar.
        var edited = itemLi.querySelector('[data-role="comment-edited"]');
        if (!edited && data.edited === true) {
          var marker = el("p", "mt-0.5 text-xs text-base-content/45", "editado");
          marker.setAttribute("data-role", "comment-edited");
          textEl && textEl.after(marker);
        }
        if (zone instanceof HTMLElement) {
          zone.hidden = true;
          while (zone.firstChild) zone.removeChild(zone.firstChild);
        }
        setStatus(panel, "Comentário atualizado.");
        focusEditButton(itemLi);
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        // Texto digitado preservado: a zona de edição continua aberta.
        setStatus(panel, "Não foi possível salvar seu comentário. Tente de novo.");
      })
      .then(function () {
        save.removeAttribute("data-busy");
        save.removeAttribute("disabled");
      });
  }

  function removeItem(control, panel, identity, itemLi, commentId, ownerModeration) {
    var ok = window.confirm(
      ownerModeration
        ? "Remover este comentário?"
        : "Excluir seu comentário?",
    );
    if (!ok) return;
    fetchJson("/api/ratings/comments", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId: commentId }),
    })
      .then(function (data) {
        if (!data || data.removed !== true) throw new Error("bad-delete");
        itemLi.remove();
        var count = data && Number.isSafeInteger(data.commentCount) ? data.commentCount : null;
        if (count !== null) syncCounts(identity, Math.max(0, count));
        var list = panel.querySelector('[data-role="comments-list"]');
        if (list instanceof HTMLElement && list.children.length === 0) {
          var bodyEl = panel.querySelector('[data-role="comments-body"]');
          if (bodyEl) bodyEl.appendChild(el("p", "py-2 text-sm text-base-content/60", "Ainda não há comentários."));
        }
        setStatus(panel, "Comentário removido.");
        var toggle = control.querySelector('[data-role="comments-toggle"]');
        if (toggle instanceof HTMLElement) toggle.focus();
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        // Sem remoção otimista: o item continua no DOM em caso de falha.
        setStatus(panel, "Não foi possível remover este comentário. Tente de novo.");
      });
  }

  // ---------------------------------------------------------------
  // Respostas (Etapa 22, 1 nível): thread raiz + replies lazy.
  // Sem nesting (replies nunca têm Responder). Contadores por comentário;
  // o commentCount global NÃO muda (feed/perfil intactos).
  // ---------------------------------------------------------------

  var REPLY_PAGE_SIZE = 10;
  var replySeq = 0;

  function validReply(item) {
    return (
      item && typeof item === "object" &&
      Number.isSafeInteger(item.replyId) && item.replyId >= 1 &&
      typeof item.text === "string" &&
      typeof item.createdAt === "string" &&
      typeof item.updatedAt === "string" &&
      item.author && typeof item.author === "object"
    );
  }

  function replyCountLabel(n) {
    var count = Math.max(0, n | 0);
    return "Ver " + count + (count === 1 ? " resposta" : " respostas");
  }

  function replyCountOf(item) {
    var n = Number(item && item.replyCount);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function panelOf(node) {
    var control = node.closest ? node.closest("[data-rating-comments]") : null;
    if (!(control instanceof HTMLElement)) return null;
    var panel = control.querySelector('[data-role="comments-panel"]');
    return panel instanceof HTMLElement ? panel : null;
  }

  /** Seção de replies sob o comentário raiz (indentação discreta). */
  function buildRepliesSection(item, replyCtx) {
    var wrap = el("div", "mt-1 border-l-2 border-base-300/60 pl-2 sm:pl-3");
    wrap.setAttribute("data-role", "replies-wrap");
    var count = replyCountOf(item);
    var listId = "rr-" + item.commentId + "-" + (++replySeq);

    if (count > 0) {
      var toggle = document.createElement("button");
      toggle.setAttribute("type", "button");
      toggle.setAttribute("data-role", "replies-toggle");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", listId);
      toggle.setAttribute("aria-label", replyCountLabel(count));
      toggle.className = "inline-flex min-h-12 items-center rounded-lg px-2 text-xs font-semibold text-primary underline-offset-4 hover:underline";
      toggle.textContent = replyCountLabel(count);
      wrap.appendChild(toggle);
    }

    var canReply = !!replyCtx && replyCtx.commentsEnabled === true && item.canEdit !== true;
    if (canReply) {
      var answer = document.createElement("button");
      answer.setAttribute("type", "button");
      answer.setAttribute("data-role", "comment-reply-toggle");
      answer.setAttribute("aria-label", "Responder comentário");
      answer.className = "inline-flex min-h-12 items-center rounded-lg px-2 text-xs text-base-content/60 underline-offset-4 hover:text-primary hover:underline";
      answer.textContent = "Responder";
      wrap.appendChild(answer);
    }

    var status = el("p", "py-1 text-xs text-base-content/60");
    status.setAttribute("data-role", "replies-status");
    status.setAttribute("role", "status");
    wrap.appendChild(status);

    var composer = el("div", "mt-1");
    composer.setAttribute("data-role", "reply-composer-zone");
    composer.hidden = true;
    wrap.appendChild(composer);

    var list = document.createElement("ul");
    list.setAttribute("data-role", "replies-list");
    list.setAttribute("aria-label", "Respostas");
    list.id = listId;
    list.hidden = true;
    wrap.appendChild(list);
    return wrap;
  }

  /** Atualiza o toggle "Ver N respostas" em TODAS as instâncias do comentário. */
  function syncReplyCount(commentId, n) {
    var key = String(commentId);
    var nodes = document.querySelectorAll('[data-comment-id="' + key + '"]');
    for (var i = 0; i < nodes.length; i++) {
      paintReplyCount(nodes[i], n);
    }
  }

  function paintReplyCount(itemLi, n) {
    if (!(itemLi instanceof HTMLElement)) return;
    var count = Math.max(0, Number(n) || 0);
    itemLi.setAttribute("data-reply-count", String(count));
    var toggle = itemLi.querySelector('[data-role="replies-toggle"]');
    if (count <= 0) {
      if (toggle) toggle.remove();
      return;
    }
    if (toggle instanceof HTMLElement) {
      toggle.textContent = replyCountLabel(count);
      toggle.setAttribute("aria-label", replyCountLabel(count));
    }
  }

  function replyCountIn(itemLi) {
    var current = Number(itemLi.getAttribute("data-reply-count") || "0");
    return Number.isSafeInteger(current) && current > 0 ? current : 0;
  }

  function buildReplyItem(reply) {
    var li = document.createElement("li");
    li.setAttribute("data-reply-id", String(reply.replyId));
    li.className = "flex gap-2 py-2";
    li.appendChild(buildAvatar({ author: reply.author }));
    var body = el("div", "min-w-0 flex-1");
    body.appendChild(buildAuthorHeader({
      author: reply.author,
      createdAt: reply.createdAt,
      text: reply.text,
    }));
    var text = el("p", "mt-0.5 whitespace-pre-wrap break-words text-sm leading-6 text-base-content/85");
    text.setAttribute("data-role", "reply-text");
    text.textContent = reply.text;
    body.appendChild(text);
    if (reply.edited === true) {
      var editedMarker = el("p", "mt-0.5 text-xs text-base-content/45", "editado");
      editedMarker.setAttribute("data-role", "reply-edited");
      body.appendChild(editedMarker);
    }
    var row = el("div", "mt-1 flex flex-wrap items-center gap-1");
    if (reply.canEdit === true) {
      var edit = document.createElement("button");
      edit.setAttribute("type", "button");
      edit.setAttribute("data-role", "reply-edit");
      edit.setAttribute("aria-label", "Editar resposta");
      edit.className = "inline-flex min-h-12 items-center rounded-lg px-2 text-xs text-base-content/60 underline-offset-4 hover:text-primary hover:underline";
      edit.textContent = "Editar";
      row.appendChild(edit);
    }
    if (reply.canDelete === true) {
      var del = document.createElement("button");
      del.setAttribute("type", "button");
      del.setAttribute("data-role", "reply-delete");
      var ownerModeration = reply.canEdit !== true;
      del.setAttribute("aria-label", ownerModeration ? "Remover resposta" : "Excluir resposta");
      del.className = "inline-flex min-h-12 items-center rounded-lg px-2 text-xs text-error/80 underline-offset-4 hover:text-error hover:underline";
      del.textContent = ownerModeration ? "Remover" : "Excluir";
      row.appendChild(del);
    }
    body.appendChild(row);
    var editZone = el("div", "mt-2");
    editZone.setAttribute("data-role", "reply-edit-zone");
    editZone.hidden = true;
    body.appendChild(editZone);
    li.appendChild(body);
    return li;
  }

  function setRepliesStatus(itemLi, message) {
    var status = itemLi.querySelector('[data-role="replies-status"]');
    if (status) status.textContent = message || "";
  }

  function repliesUrl(commentId, page) {
    return (
      "/api/ratings/comments/replies?commentId=" + encodeURIComponent(String(commentId)) +
      "&page=" + encodeURIComponent(String(page)) +
      "&limit=" + encodeURIComponent(String(REPLY_PAGE_SIZE))
    );
  }

  function showRepliesSkeleton(itemLi) {
    hideRepliesSkeleton(itemLi);
    var list = itemLi.querySelector('[data-role="replies-list"]');
    if (!(list instanceof HTMLElement)) return;
    var wrap = document.createElement("div");
    wrap.setAttribute("data-role", "replies-skeleton");
    wrap.setAttribute("aria-hidden", "true");
    wrap.className = "flex flex-col gap-2 py-1";
    for (var i = 0; i < 2; i++) {
      var row = document.createElement("div");
      row.className = "skeleton h-10 w-full";
      wrap.appendChild(row);
    }
    list.before(wrap);
    list.setAttribute("aria-busy", "true");
  }

  function hideRepliesSkeleton(itemLi) {
    var wrap = itemLi.querySelector('[data-role="replies-skeleton"]');
    if (wrap) wrap.remove();
    var list = itemLi.querySelector('[data-role="replies-list"]');
    if (list) list.removeAttribute("aria-busy");
  }

  function appendReplies(itemLi, replies) {
    var list = itemLi.querySelector('[data-role="replies-list"]');
    if (!(list instanceof HTMLElement)) return 0;
    var known = {};
    var existing = list.querySelectorAll("[data-reply-id]");
    for (var i = 0; i < existing.length; i++) {
      known[existing[i].getAttribute("data-reply-id")] = true;
    }
    var added = 0;
    for (var j = 0; j < replies.length; j++) {
      var reply = replies[j];
      if (!validReply(reply)) continue;
      if (known[String(reply.replyId)]) continue;
      known[String(reply.replyId)] = true;
      list.appendChild(buildReplyItem(reply));
      added += 1;
    }
    return added;
  }

  function loadReplies(itemLi, commentId, page) {
    if (itemLi.hasAttribute("data-replies-loading")) return;
    itemLi.setAttribute("data-replies-loading", "");
    if (page === 1) showRepliesSkeleton(itemLi);
    setRepliesStatus(itemLi, page === 1 ? "Carregando respostas…" : "Carregando…");
    hideRepliesRetry(itemLi);
    return fetchJson(repliesUrl(commentId, page), { credentials: "same-origin" })
      .then(function (data) {
        var items = data && Array.isArray(data.items) ? data.items : [];
        var list = itemLi.querySelector('[data-role="replies-list"]');
        if (list instanceof HTMLElement && page === 1) {
          while (list.firstChild) list.removeChild(list.firstChild);
        }
        appendReplies(itemLi, items);
        var more = itemLi.querySelector('[data-role="replies-more"]');
        if (data && data.hasMore === true) {
          if (!more) {
            var btn = document.createElement("button");
            btn.setAttribute("type", "button");
            btn.setAttribute("data-role", "replies-more");
            btn.setAttribute("aria-label", "Carregar mais respostas");
            btn.className = "btn btn-ghost mt-1 min-h-12 rounded-full px-6 text-xs";
            btn.textContent = "Carregar mais respostas";
            btn.setAttribute("data-next-page", String(page + 1));
            var anchor = itemLi.querySelector('[data-role="replies-list"]');
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
          } else {
            more.setAttribute("data-next-page", String(page + 1));
          }
          itemLi.setAttribute("data-replies-page", String(page));
        } else if (more) {
          more.remove();
        }
        if (page === 1) {
          hideRepliesSkeleton(itemLi);
          hideRepliesRetry(itemLi);
        }
        setRepliesStatus(itemLi, "");
        return items.length;
      })
      .catch(function (error) {
        if (error && error.message === "login") return 0;
        if (page === 1) showRepliesRetry(itemLi, commentId);
        setRepliesStatus(itemLi, "Não foi possível carregar as respostas. Tente de novo.");
        return 0;
      })
      .then(function (n) {
        hideRepliesSkeleton(itemLi);
        itemLi.removeAttribute("data-replies-loading");
        return n;
      });
  }

  function showRepliesRetry(itemLi, commentId) {
    hideRepliesRetry(itemLi);
    var retry = document.createElement("button");
    retry.setAttribute("type", "button");
    retry.setAttribute("data-role", "replies-retry");
    retry.className = "btn btn-outline mt-1 min-h-12 rounded-full px-6 text-xs";
    retry.textContent = "Tentar novamente";
    retry.addEventListener("click", function () {
      hideRepliesRetry(itemLi);
      var list = itemLi.querySelector('[data-role="replies-list"]');
      var open = list instanceof HTMLElement && !list.hidden;
      if (open) loadReplies(itemLi, commentId, 1);
    });
    var anchor = itemLi.querySelector('[data-role="replies-list"]');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(retry, anchor);
    else itemLi.appendChild(retry);
  }

  function hideRepliesRetry(itemLi) {
    var retry = itemLi.querySelector('[data-role="replies-retry"]');
    if (retry) retry.remove();
  }

  function focusReplyResponder(itemLi) {
    var btn = itemLi.querySelector('[data-role="comment-reply-toggle"]');
    if (btn instanceof HTMLElement) {
      btn.focus();
      return;
    }
    var toggle = itemLi.querySelector('[data-role="replies-toggle"]');
    if (toggle instanceof HTMLElement) toggle.focus();
  }

  function openReplyComposer(itemLi, commentId) {
    var zone = itemLi.querySelector('[data-role="reply-composer-zone"]');
    if (!(zone instanceof HTMLElement) || !zone.hidden) return;
    zone.hidden = false;
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    var label = document.createElement("label");
    label.className = "text-xs font-semibold text-base-content/70";
    label.textContent = "Sua resposta será pública.";
    var areaId = "rr-text-" + commentId + "-" + (++replySeq);
    label.setAttribute("for", areaId);
    zone.appendChild(label);
    var area = document.createElement("textarea");
    area.id = areaId;
    area.setAttribute("data-role", "reply-composer-text");
    area.setAttribute("rows", "2");
    area.setAttribute("maxlength", String(MAX_LENGTH));
    area.setAttribute("placeholder", "Escreva uma resposta…");
    area.className = "textarea textarea-bordered mt-1 min-h-12 w-full text-sm leading-6";
    zone.appendChild(area);
    var row = el("div", "mt-1 flex min-h-12 flex-wrap items-center justify-between gap-2");
    var counter = el("p", "text-xs tabular-nums text-base-content/50", "0 / " + MAX_LENGTH);
    counter.setAttribute("data-role", "reply-composer-counter");
    counter.setAttribute("aria-live", "off");
    row.appendChild(counter);
    var actions = el("div", "flex flex-wrap items-center gap-2");
    var cancel = document.createElement("button");
    cancel.setAttribute("type", "button");
    cancel.setAttribute("data-role", "reply-composer-cancel");
    cancel.setAttribute("aria-label", "Cancelar resposta");
    cancel.className = "btn btn-ghost min-h-12 rounded-full px-6 text-sm";
    cancel.textContent = "Cancelar";
    var send = document.createElement("button");
    send.setAttribute("type", "button");
    send.setAttribute("data-role", "reply-composer-send");
    send.setAttribute("aria-label", "Responder");
    send.setAttribute("disabled", "");
    send.className = "btn btn-primary min-h-12 rounded-full px-6 text-sm font-semibold";
    send.textContent = "Responder";
    actions.appendChild(cancel);
    actions.appendChild(send);
    row.appendChild(actions);
    zone.appendChild(row);
    area.focus();
  }

  function submitReply(itemLi, commentId, sendButton) {
    if (sendButton.hasAttribute("data-busy")) return;
    var zone = itemLi.querySelector('[data-role="reply-composer-zone"]');
    var area = itemLi.querySelector('[data-role="reply-composer-text"]');
    if (!(area instanceof HTMLTextAreaElement)) return;
    var text = area.value.trim();
    if (text.length === 0 || text.length > MAX_LENGTH) {
      setRepliesStatus(itemLi, text.length === 0 ? "Escreva sua resposta antes de enviar." : "Sua resposta deve ter no máximo " + MAX_LENGTH + " caracteres.");
      return;
    }
    sendButton.setAttribute("data-busy", "");
    sendButton.setAttribute("disabled", "");
    var original = sendButton.textContent;
    sendButton.textContent = "Enviando…";
    setRepliesStatus(itemLi, "");
    fetchJson("/api/ratings/comments/replies", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId: commentId, text: text }),
    })
      .then(function (data) {
        if (!validReply(data && data.reply)) throw new Error("bad-reply");
        var list = itemLi.querySelector('[data-role="replies-list"]');
        if (list instanceof HTMLElement) {
          list.hidden = false;
          var toggle = itemLi.querySelector('[data-role="replies-toggle"]');
          if (toggle instanceof HTMLElement) toggle.setAttribute("aria-expanded", "true");
          if (!list.querySelector('[data-reply-id="' + data.reply.replyId + '"]')) {
            list.appendChild(buildReplyItem(data.reply));
          }
        }
        if (zone instanceof HTMLElement) {
          zone.hidden = true;
          while (zone.firstChild) zone.removeChild(zone.firstChild);
        }
        var count = data && Number.isSafeInteger(data.replyCount) ? data.replyCount : replyCountIn(itemLi) + 1;
        syncReplyCount(commentId, Math.max(0, count));
        setRepliesStatus(itemLi, "Resposta publicada.");
        var panel = panelOf(itemLi);
        if (panel) setStatus(panel, "Resposta publicada.");
        focusReplyResponder(itemLi);
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        setRepliesStatus(itemLi, "Não foi possível publicar sua resposta. Tente de novo.");
      })
      .then(function () {
        sendButton.removeAttribute("data-busy");
        var current = area instanceof HTMLTextAreaElement ? area.value.trim().length : 0;
        if (current === 0) sendButton.setAttribute("disabled", "");
        else sendButton.removeAttribute("disabled");
        sendButton.textContent = original;
      });
  }

  function openReplyEditZone(itemLi, replyLi) {
    var zone = replyLi.querySelector('[data-role="reply-edit-zone"]');
    if (!(zone instanceof HTMLElement) || !zone.hidden) return;
    zone.hidden = false;
    while (zone.firstChild) zone.removeChild(zone.firstChild);
    var area = document.createElement("textarea");
    area.setAttribute("data-role", "reply-edit-text");
    area.setAttribute("rows", "3");
    area.setAttribute("maxlength", String(MAX_LENGTH));
    area.setAttribute("aria-label", "Editar resposta");
    area.className = "textarea textarea-bordered min-h-12 w-full text-sm leading-6";
    var current = replyLi.querySelector('[data-role="reply-text"]');
    area.value = current ? current.textContent || "" : "";
    zone.appendChild(area);
    var counter = el("p", "mt-1 text-xs tabular-nums text-base-content/50",
      String(area.value.trim().length) + " / " + MAX_LENGTH);
    counter.setAttribute("data-role", "reply-edit-counter");
    counter.setAttribute("aria-live", "off");
    zone.appendChild(counter);
    var row = el("div", "mt-1 flex flex-wrap items-center gap-2");
    var save = document.createElement("button");
    save.setAttribute("type", "button");
    save.setAttribute("data-role", "reply-edit-save");
    save.setAttribute("aria-label", "Salvar resposta");
    save.className = "btn btn-primary min-h-12 rounded-full px-6 text-sm font-semibold";
    save.textContent = "Salvar";
    var cancel = document.createElement("button");
    cancel.setAttribute("type", "button");
    cancel.setAttribute("data-role", "reply-edit-cancel");
    cancel.setAttribute("aria-label", "Cancelar edição");
    cancel.className = "btn btn-ghost min-h-12 rounded-full px-6 text-sm";
    cancel.textContent = "Cancelar";
    row.appendChild(save);
    row.appendChild(cancel);
    zone.appendChild(row);
    area.focus();
  }

  function focusReplyEditButton(replyLi) {
    var edit = replyLi.querySelector('[data-role="reply-edit"]');
    if (edit instanceof HTMLElement) edit.focus();
  }

  function saveReplyEdit(itemLi, commentId, replyLi, replyId) {
    var zone = replyLi.querySelector('[data-role="reply-edit-zone"]');
    var area = replyLi.querySelector('[data-role="reply-edit-text"]');
    var save = replyLi.querySelector('[data-role="reply-edit-save"]');
    if (!(area instanceof HTMLTextAreaElement) || !(save instanceof HTMLElement)) return;
    if (save.hasAttribute("data-busy")) return;
    var text = area.value.trim();
    if (text.length === 0 || text.length > MAX_LENGTH) {
      setRepliesStatus(itemLi, text.length === 0 ? "Escreva sua resposta antes de enviar." : "Sua resposta deve ter no máximo " + MAX_LENGTH + " caracteres.");
      return;
    }
    save.setAttribute("data-busy", "");
    save.setAttribute("disabled", "");
    fetchJson("/api/ratings/comments/replies", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyId: replyId, text: text }),
    })
      .then(function (data) {
        if (!validReply(data)) throw new Error("bad-reply");
        var textEl = replyLi.querySelector('[data-role="reply-text"]');
        if (textEl) textEl.textContent = data.text;
        var edited = replyLi.querySelector('[data-role="reply-edited"]');
        if (!edited && data.edited === true) {
          var marker = el("p", "mt-0.5 text-xs text-base-content/45", "editado");
          marker.setAttribute("data-role", "reply-edited");
          textEl && textEl.after(marker);
        }
        if (zone instanceof HTMLElement) {
          zone.hidden = true;
          while (zone.firstChild) zone.removeChild(zone.firstChild);
        }
        setRepliesStatus(itemLi, "Resposta atualizada.");
        focusReplyEditButton(replyLi);
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        setRepliesStatus(itemLi, "Não foi possível salvar sua resposta. Tente de novo.");
      })
      .then(function () {
        save.removeAttribute("data-busy");
        save.removeAttribute("disabled");
      });
  }

  function removeReply(itemLi, commentId, replyLi, replyId, ownerModeration) {
    var ok = window.confirm(
      ownerModeration ? "Remover esta resposta?" : "Excluir sua resposta?",
    );
    if (!ok) return;
    fetchJson("/api/ratings/comments/replies", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyId: replyId }),
    })
      .then(function (data) {
        if (!data || data.removed !== true) throw new Error("bad-delete");
        replyLi.remove();
        var count = data && Number.isSafeInteger(data.replyCount) ? data.replyCount : Math.max(0, replyCountIn(itemLi) - 1);
        syncReplyCount(commentId, Math.max(0, count));
        var list = itemLi.querySelector('[data-role="replies-list"]');
        if (list instanceof HTMLElement && list.children.length === 0) {
          list.hidden = true;
          var toggle = itemLi.querySelector('[data-role="replies-toggle"]');
          if (toggle instanceof HTMLElement) toggle.setAttribute("aria-expanded", "false");
        }
        setRepliesStatus(itemLi, "Resposta removida.");
        focusReplyResponder(itemLi);
      })
      .catch(function (error) {
        if (error && error.message === "login") return;
        setRepliesStatus(itemLi, "Não foi possível remover esta resposta. Tente de novo.");
      });
  }

  /**
   * Constrói um controle via DOM (sem HTML cru) para os cards
   * renderizados client-side. Mesmo markup do RatingCommentsControl SSR.
   * target: { username, mediaType, tmdbId, commentCount, commentsEnabled }.
   * Sem commentCount numérico → null (pré-migration).
   */
  function buildControl(target) {
    if (!target || typeof target !== "object") return null;
    if (typeof target.commentCount !== "number" || !Number.isSafeInteger(target.commentCount)) {
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
    var count = Math.max(0, target.commentCount);
    var enabled = target.commentsEnabled === true;
    var root = document.createElement("div");
    root.setAttribute("data-rating-comments", "");
    root.setAttribute("data-rating-owner-username", identity.username);
    root.setAttribute("data-rating-media-type", identity.mediaType);
    root.setAttribute("data-rating-tmdb-id", String(identity.tmdbId));
    root.setAttribute("data-count", String(count));
    root.setAttribute("data-enabled", enabled ? "true" : "false");

    var toggle = document.createElement("button");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("data-role", "comments-toggle");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "rc-" + identity.username + "-" + identity.mediaType + "-" + identity.tmdbId);
    toggle.setAttribute("aria-label", toggleLabel(count));
    toggle.className = "inline-flex min-h-12 min-w-12 items-center gap-1.5 rounded-full px-3 text-sm transition-opacity hover:bg-base-200";
    var glyph = document.createElement("span");
    glyph.setAttribute("data-role", "comments-glyph");
    glyph.setAttribute("aria-hidden", "true");
    glyph.className = "text-base text-base-content/60";
    glyph.textContent = "💬";
    var countEl = document.createElement("span");
    countEl.setAttribute("data-role", "comments-count");
    countEl.className = "font-semibold tabular-nums text-base-content/80";
    countEl.textContent = String(count);
    var label = document.createElement("span");
    label.setAttribute("data-role", "comments-label");
    label.className = "text-base-content/60";
    label.textContent = toggleLabel(count);
    toggle.appendChild(glyph);
    toggle.appendChild(countEl);
    toggle.appendChild(label);
    root.appendChild(toggle);

    var panel = document.createElement("div");
    panel.setAttribute("data-role", "comments-panel");
    panel.id = "rc-" + identity.username + "-" + identity.mediaType + "-" + identity.tmdbId;
    panel.className = "mt-1";
    panel.hidden = true;
    root.appendChild(panel);
    return root;
  }

  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    var role = target.getAttribute("data-role");
    var control = target.closest("[data-rating-comments]");
    if (!(control instanceof HTMLElement)) return;
    // Contador reflete a validação (trim): whitespace-only não envia.
    var trimmed = String(target.value).trim().length;
    if (role === "composer-text") {
      var counter = control.querySelector('[data-role="composer-counter"]');
      if (counter) counter.textContent = String(trimmed) + " / " + MAX_LENGTH;
      var send = control.querySelector('[data-role="composer-send"]');
      if (send instanceof HTMLButtonElement) {
        if (trimmed === 0) send.setAttribute("disabled", "");
        else send.removeAttribute("disabled");
      }
      return;
    }
    if (role === "comment-edit-text") {
      var zone = target.closest('[data-role="comment-edit-zone"]');
      var editCounter = zone ? zone.querySelector('[data-role="comment-edit-counter"]') : null;
      if (editCounter) editCounter.textContent = String(trimmed) + " / " + MAX_LENGTH;
      return;
    }
    if (role === "reply-composer-text") {
      var replyZone = target.closest('[data-role="reply-composer-zone"]');
      var replyCounter = replyZone ? replyZone.querySelector('[data-role="reply-composer-counter"]') : null;
      if (replyCounter) replyCounter.textContent = String(trimmed) + " / " + MAX_LENGTH;
      var replySend = replyZone ? replyZone.querySelector('[data-role="reply-composer-send"]') : null;
      if (replySend instanceof HTMLButtonElement) {
        if (trimmed === 0) replySend.setAttribute("disabled", "");
        else replySend.removeAttribute("disabled");
      }
      return;
    }
    if (role === "reply-edit-text") {
      var replyEditZone = target.closest('[data-role="reply-edit-zone"]');
      var replyEditCounter = replyEditZone ? replyEditZone.querySelector('[data-role="reply-edit-counter"]') : null;
      if (replyEditCounter) replyEditCounter.textContent = String(trimmed) + " / " + MAX_LENGTH;
    }
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var control = target.closest("[data-rating-comments]");
    if (!(control instanceof HTMLElement)) return;
    var identity = identityOf(control);
    if (!identity) return;
    var panel = control.querySelector('[data-role="comments-panel"]');
    if (!(panel instanceof HTMLElement)) return;

    var toggle = target.closest('[data-role="comments-toggle"]');
    if (toggle) {
      var open = panel.hidden;
      setToggle(control, open);
      if (open && control.getAttribute("data-loaded") !== "true" && !control.hasAttribute("data-loading")) {
        loadPage(control, panel, identity, 1);
      }
      return;
    }

    var more = target.closest('[data-role="comments-more"]');
    if (more instanceof HTMLElement) {
      if (control.hasAttribute("data-loading")) return;
      var next = Number(control.getAttribute("data-page") || "1") + 1;
      loadPage(control, panel, identity, next);
      return;
    }

    var send = target.closest('[data-role="composer-send"]');
    if (send instanceof HTMLElement) {
      submitComposer(control, panel, identity, send);
      return;
    }

    var editBtn = target.closest('[data-role="comment-edit"]');
    if (editBtn instanceof HTMLElement) {
      var itemLi = editBtn.closest("[data-comment-id]");
      if (itemLi instanceof HTMLElement) openEditZone(itemLi, {});
      return;
    }

    var cancelBtn = target.closest('[data-role="comment-edit-cancel"]');
    if (cancelBtn instanceof HTMLElement) {
      var editItemLi = cancelBtn.closest("[data-comment-id]");
      var zone = cancelBtn.closest('[data-role="comment-edit-zone"]');
      if (zone instanceof HTMLElement) {
        zone.hidden = true;
        while (zone.firstChild) zone.removeChild(zone.firstChild);
      }
      if (editItemLi instanceof HTMLElement) focusEditButton(editItemLi);
      return;
    }

    var saveBtn = target.closest('[data-role="comment-edit-save"]');
    if (saveBtn instanceof HTMLElement) {
      var editLi = saveBtn.closest("[data-comment-id]");
      if (editLi instanceof HTMLElement) {
        var editId = Number(editLi.getAttribute("data-comment-id"));
        if (Number.isSafeInteger(editId) && editId >= 1) saveEdit(control, panel, identity, editLi, editId);
      }
      return;
    }

    var delBtn = target.closest('[data-role="comment-delete"]');
    if (delBtn instanceof HTMLElement) {
      var delLi = delBtn.closest("[data-comment-id]");
      if (delLi instanceof HTMLElement) {
        var delId = Number(delLi.getAttribute("data-comment-id"));
        if (Number.isSafeInteger(delId) && delId >= 1) {
          removeItem(control, panel, identity, delLi, delId, delBtn.textContent === "Remover");
        }
      }
      return;
    }

    // ---- Replies (1 nível; replies nunca têm Responder) ----
    function replyItemLi(node) {
      var li = node.closest("[data-comment-id]");
      return li instanceof HTMLElement ? li : null;
    }

    function replyIdOf(node) {
      var li = node.closest("[data-reply-id]");
      if (!(li instanceof HTMLElement)) return null;
      var id = Number(li.getAttribute("data-reply-id"));
      return Number.isSafeInteger(id) && id >= 1 ? { li: li, id: id } : null;
    }

    var repliesToggle = target.closest('[data-role="replies-toggle"]');
    if (repliesToggle instanceof HTMLElement) {
      var toggleLi = replyItemLi(repliesToggle);
      var repliesList = toggleLi ? toggleLi.querySelector('[data-role="replies-list"]') : null;
      if (toggleLi instanceof HTMLElement && repliesList instanceof HTMLElement) {
        var open = repliesList.hidden;
        repliesList.hidden = !open;
        repliesToggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          var cid = Number(toggleLi.getAttribute("data-comment-id"));
          var loaded = toggleLi.getAttribute("data-replies-loaded") === "true";
          if (!loaded && Number.isSafeInteger(cid) && cid >= 1) {
            toggleLi.setAttribute("data-replies-loaded", "true");
            loadReplies(toggleLi, cid, 1);
          }
        }
      }
      return;
    }

    var responder = target.closest('[data-role="comment-reply-toggle"]');
    if (responder instanceof HTMLElement) {
      var composerLi = replyItemLi(responder);
      if (composerLi instanceof HTMLElement) {
        var composerCid = Number(composerLi.getAttribute("data-comment-id"));
        if (Number.isSafeInteger(composerCid) && composerCid >= 1) {
          openReplyComposer(composerLi, composerCid);
        }
      }
      return;
    }

    var repliesMore = target.closest('[data-role="replies-more"]');
    if (repliesMore instanceof HTMLElement) {
      var moreLi = replyItemLi(repliesMore);
      if (moreLi instanceof HTMLElement && !moreLi.hasAttribute("data-replies-loading")) {
        var moreCid = Number(moreLi.getAttribute("data-comment-id"));
        var nextPage = Number(repliesMore.getAttribute("data-next-page") || "2");
        if (Number.isSafeInteger(moreCid) && moreCid >= 1 && Number.isSafeInteger(nextPage) && nextPage >= 1) {
          loadReplies(moreLi, moreCid, nextPage);
        }
      }
      return;
    }

    var replyCancelComposer = target.closest('[data-role="reply-composer-cancel"]');
    if (replyCancelComposer instanceof HTMLElement) {
      var cancelLi = replyItemLi(replyCancelComposer);
      if (cancelLi instanceof HTMLElement) {
        var composerZone = cancelLi.querySelector('[data-role="reply-composer-zone"]');
        if (composerZone instanceof HTMLElement) {
          composerZone.hidden = true;
          while (composerZone.firstChild) composerZone.removeChild(composerZone.firstChild);
        }
        focusReplyResponder(cancelLi);
      }
      return;
    }

    var replySend = target.closest('[data-role="reply-composer-send"]');
    if (replySend instanceof HTMLElement) {
      var sendLi = replyItemLi(replySend);
      if (sendLi instanceof HTMLElement) {
        var sendCid = Number(sendLi.getAttribute("data-comment-id"));
        if (Number.isSafeInteger(sendCid) && sendCid >= 1) submitReply(sendLi, sendCid, replySend);
      }
      return;
    }

    var replyEditBtn = target.closest('[data-role="reply-edit"]');
    if (replyEditBtn instanceof HTMLElement) {
      var found = replyIdOf(replyEditBtn);
      var editLi = replyItemLi(replyEditBtn);
      if (found && editLi instanceof HTMLElement) openReplyEditZone(editLi, found.li);
      return;
    }

    var replyEditCancel = target.closest('[data-role="reply-edit-cancel"]');
    if (replyEditCancel instanceof HTMLElement) {
      var cancelEdit = replyIdOf(replyEditCancel);
      var cancelZone = replyEditCancel.closest('[data-role="reply-edit-zone"]');
      if (cancelZone instanceof HTMLElement) {
        cancelZone.hidden = true;
        while (cancelZone.firstChild) cancelZone.removeChild(cancelZone.firstChild);
      }
      if (cancelEdit) focusReplyEditButton(cancelEdit.li);
      return;
    }

    var replySaveBtn = target.closest('[data-role="reply-edit-save"]');
    if (replySaveBtn instanceof HTMLElement) {
      var saveRef = replyIdOf(replySaveBtn);
      var saveLi = replyItemLi(replySaveBtn);
      if (saveRef && saveLi instanceof HTMLElement) {
        var saveCid = Number(saveLi.getAttribute("data-comment-id"));
        if (Number.isSafeInteger(saveCid) && saveCid >= 1) {
          saveReplyEdit(saveLi, saveCid, saveRef.li, saveRef.id);
        }
      }
      return;
    }

    var replyDelBtn = target.closest('[data-role="reply-delete"]');
    if (replyDelBtn instanceof HTMLElement) {
      var delRef = replyIdOf(replyDelBtn);
      var delReplyLi = replyItemLi(replyDelBtn);
      if (delRef && delReplyLi instanceof HTMLElement) {
        var delCid = Number(delReplyLi.getAttribute("data-comment-id"));
        if (Number.isSafeInteger(delCid) && delCid >= 1) {
          removeReply(delReplyLi, delCid, delRef.li, delRef.id, replyDelBtn.textContent === "Remover");
        }
      }
    }
  });

  window.CineVeeRatingComments = {
    buildControl: buildControl,
    syncCounts: syncCounts,
  };
})();
