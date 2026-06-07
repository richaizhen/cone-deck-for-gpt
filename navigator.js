(() => {
  const app = window.ConeDeckApp;
  if (!app) return;

  app.registerModule({
    name: 'navigator',
    init(appInstance) {
      let observer = null;
      let scrollSpyTimer = null;
      let isCollapsed = false;
      let activeIndex = -1;
      let messageCache = [];
      let messageRegistry = new Map(); // id -> {id,text,el,turn,sub}; accumulates across scans within a route (ChatGPT virtualizes long chats); cleared on route change
      let searchQuery = '';
      let boundScrollTarget = null;
      let unlistenRoute = null;
      let healthTimer = null;
      let latestRouteKey = appInstance.getCurrentRouteKey();
      let waitRenderToken = 0;
      let isSettling = false;
      const pendingWaitTimers = new Set();

      const { debounce, truncate, cleanText, createEl } = appInstance.utils;
      const debouncedRefresh = debounce(() => {
        if (isSettling) return;
        refreshNavigator({ preserveActive: true });
      }, 250);

      // ChatGPT user-message selector — exact match only, to avoid grabbing UI elements
      function getMessageElements() {
        const selectors = [
          '[data-message-author-role="user"]',
          '[data-testid^="conversation-turn-"][data-message-author-role="user"]'
        ];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel)).filter((el) => el instanceof HTMLElement);
          if (els.length) return els;
        }
        return [];
      }

      // Extract the message's actual text
      function extractMessageText(el) {
        // Prefer a specific child element (verified against ChatGPT)
        const contentSelectors = [
          '.markdown',
          '[class*="markdown"]',
          '.text-token-text-primary',
          'p'
        ];
        for (const sel of contentSelectors) {
          const child = el.querySelector(sel);
          if (child) {
            const text = cleanText(child.innerText || child.textContent || '');
            if (text) return text;
          }
        }
        // Fallback: take the whole element's text
        const full = cleanText(el.innerText || el.textContent || '');
        return full;
      }

      function getSnippetForQuery(text, query, max = 36) {
        const clean = cleanText(text);
        if (!query) return truncate(clean, max);
        const lower = clean.toLowerCase();
        const q = cleanText(query).toLowerCase();
        if (!q) return truncate(clean, max);
        const index = lower.indexOf(q);
        if (index === -1) return truncate(clean, max);
        const start = Math.max(0, index - Math.floor((max - q.length) / 2));
        const end = Math.min(clean.length, start + max);
        const slice = clean.slice(start, end);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < clean.length ? '…' : '';
        return `${prefix}${slice}${suffix}`;
      }

      function highlight(text, query) {
        const snippet = getSnippetForQuery(text, query, 36);
        if (!query) return document.createTextNode(snippet);
        const lower = snippet.toLowerCase();
        const q = cleanText(query).toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) return document.createTextNode(snippet);
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(snippet.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'cn-match';
        mark.textContent = snippet.slice(idx, idx + q.length);
        frag.appendChild(mark);
        frag.appendChild(document.createTextNode(snippet.slice(idx + q.length)));
        return frag;
      }

      function getScrollContainer() {
        const messageEls = getMessageElements();
        if (!messageEls.length) return document.scrollingElement || document.documentElement;

        const counts = new Map();
        messageEls.slice(0, 6).forEach((msg) => {
          let current = msg.parentElement;
          let depth = 0;
          while (current && current !== document.body && depth < 12) {
            const style = window.getComputedStyle(current);
            const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && current.clientHeight > 0;
            if (isScrollable) {
              counts.set(current, (counts.get(current) || 0) + 1);
            }
            current = current.parentElement;
            depth += 1;
          }
        });

        const best = Array.from(counts.entries())
          .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return (b[0].clientHeight || 0) - (a[0].clientHeight || 0);
          })[0]?.[0];

        return best || document.scrollingElement || document.documentElement;
      }

      // Collect navigator entries: the user's text messages + attachment groups (images / videos / other files), in DOM order.
      // On ChatGPT a user turn ([data-message-author-role="user"]) holds the typed text in .whitespace-pre-wrap,
      // uploaded images as <img alt="name.ext"> (wrapper marked group/message-image), and other uploads (video / pdf /
      // doc …) as file tiles marked group/file-tile. Detected separately, then grouped by "consecutive same kind" into
      // one Image upload ×N / Video upload ×N / Attachment ×N, so mixed kinds aren't merged and mislabeled.
      function collectEntries() {
        const IMG_EXT = /^(png|jpe?g|webp|gif|svg|bmp|heic|heif|avif)$/i;
        const VID_EXT = /^(mp4|mov|webm|m4v|avi|mkv|ogv)$/i;
        const extOfName = (name) => {
          const m = cleanText(name || '').match(/\.([a-z0-9]+)$/i);
          return m ? m[1].toLowerCase() : '';
        };
        const usable = (el) => el && !el.closest('#cn-panel') && !el.closest('#cd-organizer-root');

        const markers = [];
        getMessageElements().forEach((turn) => {
          if (!usable(turn)) return;
          // the typed text only (excludes attachment tiles / image alts)
          const textEl = turn.querySelector('.whitespace-pre-wrap');
          if (textEl && usable(textEl)) {
            markers.push({ el: textEl, type: 'text' });
          } else if (!turn.querySelector('img') && !turn.querySelector('[class~="group/file-tile"]')) {
            // text turn whose text isn't in .whitespace-pre-wrap (and has no attachments): fall back to the turn
            markers.push({ el: turn, type: 'text' });
          }
          // uploaded images: <img> with an image-extension filename alt
          turn.querySelectorAll('img').forEach((img) => {
            if (!usable(img)) return;
            const ext = extOfName(img.getAttribute('alt') || '');
            if (ext && IMG_EXT.test(ext)) markers.push({ el: img, type: 'attach', kind: 'image' });
          });
          // other uploads (video / pdf / doc …): file tiles
          turn.querySelectorAll('[class~="group/file-tile"]').forEach((tile) => {
            if (!usable(tile)) return;
            const nameEl = tile.querySelector('.truncate.font-semibold') || tile;
            const ext = extOfName(nameEl.textContent || '');
            const kind = VID_EXT.test(ext) ? 'video' : IMG_EXT.test(ext) ? 'image' : 'file';
            markers.push({ el: tile, type: 'attach', kind });
          });
        });

        markers.sort((a, b) =>
          (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

        const entries = [];
        let i = 0;
        while (i < markers.length) {
          const marker = markers[i];
          if (marker.type === 'text') {
            const text = extractMessageText(marker.el);
            if (text) entries.push({ el: marker.el, text });
            i += 1;
            continue;
          }
          const kind = marker.kind;
          let count = 0;
          while (i < markers.length && markers[i].type === 'attach' && markers[i].kind === kind) {
            count += 1;
            i += 1;
          }
          const base = kind === 'image' ? 'Image upload' : kind === 'video' ? 'Video upload' : 'Attachment';
          entries.push({ el: marker.el, text: count > 1 ? `${base} ×${count}` : base });
        }

        // Tag each entry with its conversation turn number (stable + unique per conversation) and its order
        // within that turn, so the accumulated list stays correctly ordered as ChatGPT virtualizes messages
        // in and out of the DOM on scroll.
        const subByTurn = {};
        entries.forEach((entry) => {
          const turnEl = entry.el.closest && entry.el.closest('[data-testid^="conversation-turn-"]');
          const m = turnEl && (turnEl.getAttribute('data-testid') || '').match(/conversation-turn-(\d+)/);
          entry.turn = m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
          subByTurn[entry.turn] = subByTurn[entry.turn] || 0;
          entry.sub = subByTurn[entry.turn]++;
        });
        return entries;
      }

      function scanMessages() {
        // Accumulate: merge whatever is currently rendered into a persistent registry keyed by a stable
        // per-conversation id (turn number + intra-turn index). ChatGPT renders only a window of messages
        // and only on real scroll, so as the user scrolls through the chat the registry fills up and never
        // loses entries; the displayed list is the registry sorted into conversation order.
        let changed = false;
        collectEntries().forEach((entry) => {
          if (!entry.text) return;
          const id = `t${entry.turn}_${entry.sub}`;
          if (entry.el) entry.el.dataset.cnMsgId = id;
          const existing = messageRegistry.get(id);
          if (!existing) {
            messageRegistry.set(id, { id, text: entry.text, el: entry.el, turn: entry.turn, sub: entry.sub });
            changed = true;
          } else {
            existing.el = entry.el || existing.el;
            if (existing.text !== entry.text) { existing.text = entry.text; changed = true; }
          }
        });

        const sorted = Array.from(messageRegistry.values()).sort((a, b) => (a.turn - b.turn) || (a.sub - b.sub));
        if (sorted.length !== messageCache.length) changed = true;
        messageCache = sorted;
        return changed;
      }

      function buildPanel() {
        let panel = document.getElementById('cn-panel');
        if (panel) return panel;

        panel = createEl('div', { id: 'cn-panel' });
        panel.innerHTML = `
          <div id="cn-expanded">
            <div id="cn-header">
              <div id="cn-search-wrap">
                <span id="cn-search-icon">🔍</span>
                <input id="cn-search" type="text" placeholder="Search messages…" autocomplete="off" spellcheck="false">
                <button id="cn-search-clear" title="Clear">✕</button>
              </div>
              <div id="cn-header-right">
                <div id="cn-theme-picker">
                  <button class="cn-theme-btn" data-theme="light" title="Light">☀</button>
                  <button class="cn-theme-btn" data-theme="system" title="System">◑</button>
                  <button class="cn-theme-btn" data-theme="dark" title="Dark">☾</button>
                </div>
                <button id="cn-toggle" title="Collapse">«</button>
              </div>
            </div>
            <div id="cn-list"></div>
            <div id="cn-footer"><a id="cn-brand" href="https://conelab.ai" target="_blank" rel="noopener noreferrer">Made by conelab.ai</a></div>
          </div>
          <div id="cn-collapsed">
            <button id="cn-expand" title="Expand">»</button>
            <div id="cn-dots-wrap"><div id="cn-dots"></div></div>
          </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('cn-toggle')?.addEventListener('click', () => setCollapsed(true));
        document.getElementById('cn-expand')?.addEventListener('click', () => setCollapsed(false));
        document.getElementById('cn-brand')?.addEventListener('click', (event) => event.stopPropagation());

        const searchInput = document.getElementById('cn-search');
        const searchClear = document.getElementById('cn-search-clear');
        if (searchInput && searchClear) {
          searchInput.value = searchQuery;
          searchClear.style.display = searchQuery ? 'flex' : 'none';
          searchInput.addEventListener('input', () => {
            searchQuery = cleanText(searchInput.value);
            searchClear.style.display = searchQuery ? 'flex' : 'none';
            rebuildList();
            renderDots();
          });
          searchInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            searchInput.value = '';
            searchQuery = '';
            searchClear.style.display = 'none';
            rebuildList();
            renderDots();
          });
          searchClear.addEventListener('click', () => {
            searchInput.value = '';
            searchQuery = '';
            searchClear.style.display = 'none';
            rebuildList();
            renderDots();
            searchInput.focus();
          });
        }

        panel.querySelectorAll('.cn-theme-btn').forEach((btn) => {
          btn.addEventListener('click', (event) => {
            event.stopPropagation();
            appInstance.applyTheme(btn.dataset.theme);
          });
        });

        panel.classList.toggle('cn-is-collapsed', isCollapsed);
        return panel;
      }

      function persistCollapsedState() {
        appInstance.storage.set({ [appInstance.storageKeys.navCollapsed]: isCollapsed });
      }

      function setCollapsed(value, options = {}) {
        isCollapsed = Boolean(value);
        const panel = buildPanel();
        panel.classList.toggle('cn-is-collapsed', isCollapsed);
        renderDots();
        if (!options.skipPersist) persistCollapsedState();
      }

      function getFilteredMessages() {
        if (!searchQuery) return messageCache;
        const q = searchQuery.toLowerCase();
        return messageCache.filter((message) => message.text.toLowerCase().includes(q));
      }

      function setActiveItem(index, scrollNav = true) {
        activeIndex = index;
        const list = document.getElementById('cn-list');
        if (list) {
          list.querySelectorAll('.cn-item').forEach((el) => {
            el.classList.toggle('cn-active', Number(el.dataset.index) === index);
          });
          if (scrollNav) {
            const activeEl = list.querySelector(`.cn-item[data-index="${index}"]`);
            activeEl?.scrollIntoView({ block: 'nearest' });
          }
        }
        const dots = document.getElementById('cn-dots');
        if (dots) {
          dots.querySelectorAll('.cn-dot').forEach((dot) => {
            dot.classList.toggle('cn-dot-active', Number(dot.dataset.index) === index);
          });
        }
      }

      function rebuildList() {
        const panel = buildPanel();
        const list = panel.querySelector('#cn-list');
        if (!list) return;
        list.innerHTML = '';

        const filtered = getFilteredMessages();
        if (!filtered.length) {
          list.innerHTML = `<div class="cn-empty">${searchQuery ? 'No matches' : 'No messages yet'}</div>`;
          return;
        }

        filtered.forEach((record) => {
          const index = messageCache.findIndex((item) => item.id === record.id);
          if (index === -1) return;
          const item = createEl('div', {
            class: `cn-item${index === activeIndex ? ' cn-active' : ''}`,
            dataset: { index: String(index) }
          });
          const idx = createEl('span', { class: 'cn-index', text: String(index + 1) });
          const txt = createEl('span', { class: 'cn-text' });
          txt.appendChild(highlight(record.text, searchQuery));
          item.append(idx, txt);
          item.addEventListener('click', () => {
            setActiveItem(index);
            scrollToMessage(index);
          });
          list.appendChild(item);
        });
      }

      function renderDots() {
        const panel = buildPanel();
        const dots = panel.querySelector('#cn-dots');
        if (!dots) return;

        const existing = dots.querySelectorAll('.cn-dot');

        // Same message count: only toggle the active class instead of rebuilding the DOM, to avoid flicker
        if (existing.length === messageCache.length) {
          existing.forEach((dot) => {
            dot.classList.toggle('cn-dot-active', Number(dot.dataset.index) === activeIndex);
            // Sync the title (message text may have changed)
            const idx = Number(dot.dataset.index);
            if (messageCache[idx]) dot.title = truncate(messageCache[idx].text, 28);
          });
          return;
        }

        // Rebuild only when the message count changes
        dots.innerHTML = '';
        messageCache.forEach((message, index) => {
          const dot = createEl('div', {
            class: `cn-dot${index === activeIndex ? ' cn-dot-active' : ''}`,
            dataset: { index: String(index) }
          });
          dot.title = truncate(message.text, 28);
          dot.addEventListener('click', () => {
            setActiveItem(index);
            scrollToMessage(index);
          });
          dots.appendChild(dot);
        });
      }

      function updateScrollBinding() {
        const scrollTarget = getScrollContainer();
        const nextTarget = scrollTarget === document.documentElement ? window : scrollTarget;
        if (boundScrollTarget === nextTarget) return;

        const onScroll = handleScroll;
        if (boundScrollTarget) {
          boundScrollTarget.removeEventListener('scroll', onScroll);
        }
        boundScrollTarget = nextTarget;
        boundScrollTarget.addEventListener('scroll', onScroll, { passive: true });
      }

      function detectActiveIndex() {
        const candidates = messageCache.filter((message) => message.el && document.contains(message.el));
        if (!candidates.length) return -1;

        const scrollContainer = getScrollContainer();
        const containerRect = scrollContainer === document.documentElement || scrollContainer === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight, height: window.innerHeight }
          : scrollContainer.getBoundingClientRect();

        let bestIndex = -1;
        let bestScore = Number.POSITIVE_INFINITY;
        candidates.forEach((message) => {
          const rect = message.el.getBoundingClientRect();
          const visibleTop = Math.max(rect.top, containerRect.top);
          const visibleBottom = Math.min(rect.bottom, containerRect.bottom);
          const visibleHeight = Math.max(0, visibleBottom - visibleTop);
          if (visibleHeight <= 0) return;
          const distance = Math.abs(rect.top - containerRect.top);
          const coveragePenalty = 1 / visibleHeight;
          const score = distance + coveragePenalty;
          const index = messageCache.findIndex((item) => item.id === message.id);
          if (index !== -1 && score < bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        });

        return bestIndex;
      }

      function handleScroll() {
        scanMessages();
        clearTimeout(scrollSpyTimer);
        scrollSpyTimer = setTimeout(() => {
          updateScrollBinding();
          refreshNavigator({ preserveActive: true });
        }, 120);
      }

      function tryResolveElementById(recordId) {
        if (!recordId) return null;
        const direct = document.querySelector(`[data-cn-msg-id="${CSS.escape(recordId)}"]`);
        return direct instanceof HTMLElement ? direct : null;
      }

      function scrollToMessage(index) {
        scanMessages();
        const target = messageCache[index];
        if (!target) return;

        const flash = (el) => {
          let cancelled = false;
          const stop = () => { cancelled = true; };
          const teardown = () => ['wheel', 'touchstart', 'keydown'].forEach((ev) => window.removeEventListener(ev, stop));
          // as soon as the user actively scrolls or presses a key, stop auto-centering so we don't yank them back
          ['wheel', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, stop, { once: true, passive: true }));
          // find the target's scroll viewport, used to tell whether it's centered
          let viewport = el.parentElement;
          while (viewport && viewport !== document.body) {
            const st = getComputedStyle(viewport);
            if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && viewport.clientHeight > 0) break;
            viewport = viewport.parentElement;
          }
          const viewportCenter = () => (viewport && viewport !== document.body)
            ? (viewport.getBoundingClientRect().top + viewport.clientHeight / 2)
            : (window.innerHeight / 2);
          try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
          el.classList.add('cn-highlight');
          setTimeout(() => el.classList.remove('cn-highlight'), 1400);
          // in long chats, lazy-loading/virtualization keeps changing the heights above after the jump, making the target drift.
          // each frame, check whether the target is off the viewport center and re-center if so; stop after ~15 stable frames, a ~4s cap, or a user scroll.
          let stable = 0;
          let frames = 0;
          const tick = () => {
            if (cancelled) { teardown(); return; }
            const r = el.getBoundingClientRect();
            if (Math.abs((r.top + r.height / 2) - viewportCenter()) > 2) {
              try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
              stable = 0;
            } else {
              stable += 1;
            }
            frames += 1;
            if (stable >= 15 || frames >= 240) { teardown(); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          const img = el.tagName === 'IMG' ? el : (el.querySelector && el.querySelector('img'));
          if (img && !img.complete) img.addEventListener('load', () => { stable = 0; }, { once: true });
        };

        const directEl = (target.el && document.contains(target.el)) ? target.el : tryResolveElementById(target.id);
        if (directEl) {
          target.el = directEl;
          flash(directEl);
          return;
        }

        // Not currently rendered (ChatGPT virtualizes long chats). The conversation-turn wrapper still exists
        // even when the message content is virtualized out, so scroll to it; the content renders as it enters view.
        const turnWrapper = target.turn ? document.querySelector(`[data-testid="conversation-turn-${target.turn}"]`) : null;
        if (turnWrapper) {
          try { turnWrapper.scrollIntoView({ block: 'center' }); } catch (e) {}
        } else {
          const scrollEl = getScrollContainer();
          const ratio = messageCache.length > 1 ? index / (messageCache.length - 1) : 0;
          if (scrollEl === document.documentElement || scrollEl === document.scrollingElement) {
            window.scrollTo({
              top: ratio * ((document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight),
              behavior: 'smooth'
            });
          } else {
            scrollEl.scrollTo({
              top: ratio * Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight),
              behavior: 'smooth'
            });
          }
        }

        let attempts = 0;
        const tryJump = () => {
          scanMessages();
          const refreshed = messageCache.find((item) => item.id === target.id) || messageCache[index];
          if (refreshed?.el && document.contains(refreshed.el)) {
            flash(refreshed.el);
          } else if (attempts++ < 6) {
            setTimeout(tryJump, 320);
          }
        };
        setTimeout(tryJump, 400);
      }

      function refreshNavigator({ preserveActive = false } = {}) {
        buildPanel();
        const changed = scanMessages();
        updateScrollBinding();
        rebuildList();
        renderDots();

        if (!messageCache.length) {
          activeIndex = -1;
          return;
        }

        if (!preserveActive || activeIndex < 0 || activeIndex >= messageCache.length || changed) {
          const nextActive = detectActiveIndex();
          setActiveItem(nextActive !== -1 ? nextActive : 0, false);
        } else {
          setActiveItem(activeIndex, false);
        }
      }

      function resetSearchState() {
        searchQuery = '';
        const searchInput = document.getElementById('cn-search');
        const searchClear = document.getElementById('cn-search-clear');
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.style.display = 'none';
      }

      function clearPendingWaitTimers() {
        pendingWaitTimers.forEach((timerId) => window.clearTimeout(timerId));
        pendingWaitTimers.clear();
      }

      function scheduleWaitTimer(callback, delay) {
        const timerId = window.setTimeout(() => {
          pendingWaitTimers.delete(timerId);
          callback();
        }, delay);
        pendingWaitTimers.add(timerId);
        return timerId;
      }

      function waitAndRender({ preserveActive = false, maxAttempts = 15, initialDelay = 300, retryDelay = 400 } = {}) {
        const token = ++waitRenderToken;
        let attempts = 0;
        let lastCount = -1;
        clearPendingWaitTimers();

        const tryRender = () => {
          if (token !== waitRenderToken) return;
          const count = getMessageElements().length;
          const stable = count > 0 && count === lastCount;
          lastCount = count;
          if (stable || attempts >= maxAttempts) {
            isSettling = false;
            refreshNavigator({ preserveActive });
            return;
          }
          attempts += 1;
          scheduleWaitTimer(tryRender, retryDelay);
        };

        scheduleWaitTimer(tryRender, initialDelay);
      }

      function resetForRoute() {
        latestRouteKey = appInstance.getCurrentRouteKey();
        messageCache = [];
        messageRegistry = new Map();
        activeIndex = -1;
        isSettling = true;
        resetSearchState();
        const list = document.getElementById('cn-list');
        if (list) list.innerHTML = '<div class="cn-empty">Loading…</div>';
        const dots = document.getElementById('cn-dots');
        if (dots) dots.innerHTML = '';
        waitAndRender({ preserveActive: false });
      }

      function startObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
          const relevant = mutations.some((mutation) => {
            if (mutation.type === 'characterData') return true;
            if (mutation.type === 'attributes') {
              return mutation.target instanceof HTMLElement
                && (mutation.target.matches('[data-message-author-role="user"], [data-testid^="conversation-turn-"]')
                    || mutation.target.closest?.('[data-message-author-role="user"], [data-testid^="conversation-turn-"]'));
            }
            const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
            return changedNodes.some((node) => {
              if (!(node instanceof HTMLElement)) return false;
              return node.matches?.('[data-message-author-role="user"], [data-testid^="conversation-turn-"]')
                || node.querySelector?.('[data-message-author-role="user"], [data-testid^="conversation-turn-"]');
            });
          });
          if (relevant) debouncedRefresh();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'data-message-author-role']
        });
      }

      function startHealthCheck() {
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = setInterval(() => {
          if (!document.getElementById('cn-panel')) {
            buildPanel();
            setCollapsed(isCollapsed, { skipPersist: true });
            refreshNavigator({ preserveActive: true });
            return;
          }
          const currentRouteKey = appInstance.getCurrentRouteKey();
          if (currentRouteKey !== latestRouteKey) {
            resetForRoute();
            return;
          }
          updateScrollBinding();
        }, 1200);
      }

      (async () => {
        try {
          const stored = await appInstance.storage.get(appInstance.storageKeys.navCollapsed);
          isCollapsed = Boolean(stored?.[appInstance.storageKeys.navCollapsed]);
        } catch (error) {
          console.warn('[Cone Deck] load nav collapsed failed:', error);
        }

        buildPanel();
        setCollapsed(isCollapsed, { skipPersist: true });
        appInstance.applyTheme(appInstance.currentTheme || 'system');
        startObserver();
        updateScrollBinding();
        isSettling = true;
        waitAndRender({ preserveActive: false });
        startHealthCheck();
        unlistenRoute = appInstance.onRouteChange(() => resetForRoute());
      })();

      window.addEventListener('beforeunload', () => {
        observer?.disconnect();
        clearPendingWaitTimers();
        waitRenderToken += 1;
        if (boundScrollTarget) boundScrollTarget.removeEventListener('scroll', handleScroll);
        if (healthTimer) clearInterval(healthTimer);
        if (typeof unlistenRoute === 'function') unlistenRoute();
      }, { once: true });
    }
  });
})();