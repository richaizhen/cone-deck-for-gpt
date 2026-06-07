(() => {
  if (window.ConeDeckApp?.booted) return;

  const STORAGE_KEYS = {
    theme: 'cnTheme',
    organizer: 'cdOrganizerState',
    navCollapsed: 'cdNavCollapsed'
  };

  // ChatGPT's official accent: green palette
  const THEMES = {
    dark: {
      '--cn-bg': '#202123',
      '--cn-header-bg': '#2d2d2f',
      '--cn-border': 'rgba(255,255,255,0.08)',
      '--cn-shadow': '0 4px 24px rgba(0,0,0,0.60)',
      '--cn-text': '#ececf1',
      '--cn-text-muted': '#8e8ea0',
      '--cn-text-dim': '#565869',
      '--cn-item-hover': 'rgba(255,255,255,0.05)',
      '--cn-item-active-bg': 'rgba(25,195,125,0.12)',
      '--cn-item-active-border': '#19c37d',
      '--cn-scrollbar': 'rgba(255,255,255,0.12)',
      '--cn-dot-bg': 'rgba(255,255,255,0.18)',
      '--cn-dot-active': '#19c37d',
      '--cn-brand-color': '#8e8ea0',
      '--cn-btn-hover': 'rgba(255,255,255,0.07)',
      '--cn-accent': '#19c37d',
      '--cn-accent-hover': '#0dab6c',
      '--cn-search-bg': 'rgba(255,255,255,0.06)',
      '--cn-search-border': 'rgba(255,255,255,0.10)',
      '--cn-search-text': '#ececf1',
      '--cn-match-bg': 'rgba(25,195,125,0.22)',
      '--cd-folder-item-bg': 'rgba(255,255,255,0.03)',
      '--cd-folder-hover': 'rgba(255,255,255,0.05)',
      '--cd-archive-dim': '#8e8ea0',
      '--cd-danger': '#ef4146',
      '--cd-input-bg': 'rgba(255,255,255,0.08)',
      '--cd-drop-outline': 'rgba(25,195,125,0.60)'
    },
    light: {
      '--cn-bg': '#ffffff',
      '--cn-header-bg': '#f7f7f8',
      '--cn-border': 'rgba(0,0,0,0.08)',
      '--cn-shadow': '0 4px 20px rgba(0,0,0,0.12)',
      '--cn-text': '#343541',
      '--cn-text-muted': '#6e6e80',
      '--cn-text-dim': '#acacbe',
      '--cn-item-hover': 'rgba(0,0,0,0.04)',
      '--cn-item-active-bg': 'rgba(25,195,125,0.10)',
      '--cn-item-active-border': '#19c37d',
      '--cn-scrollbar': 'rgba(0,0,0,0.12)',
      '--cn-dot-bg': 'rgba(0,0,0,0.14)',
      '--cn-dot-active': '#19c37d',
      '--cn-brand-color': '#6e6e80',
      '--cn-btn-hover': 'rgba(0,0,0,0.05)',
      '--cn-accent': '#19c37d',
      '--cn-accent-hover': '#0dab6c',
      '--cn-search-bg': 'rgba(0,0,0,0.04)',
      '--cn-search-border': 'rgba(0,0,0,0.10)',
      '--cn-search-text': '#343541',
      '--cn-match-bg': 'rgba(25,195,125,0.14)',
      '--cd-folder-item-bg': 'rgba(0,0,0,0.02)',
      '--cd-folder-hover': 'rgba(0,0,0,0.04)',
      '--cd-archive-dim': '#8e8ea0',
      '--cd-danger': '#ef4146',
      '--cd-input-bg': 'rgba(0,0,0,0.06)',
      '--cd-drop-outline': 'rgba(25,195,125,0.50)'
    }
  };

  function promisifyChromeStorage(method, payload) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local[method](payload, (result) => resolve(result || {}));
      } catch (error) {
        console.warn('[Cone Deck] storage error:', error);
        resolve({});
      }
    });
  }

  function createRouteBus() {
    let currentRouteKey = `${location.pathname}${location.search}${location.hash}`;
    let intervalId = null;
    let patched = false;
    let originals = null;
    const listeners = new Set();

    function getRouteKey() {
      return `${location.pathname}${location.search}${location.hash}`;
    }

    function emitIfChanged(force = false) {
      const nextRouteKey = getRouteKey();
      if (!force && nextRouteKey === currentRouteKey) return;
      const previousRouteKey = currentRouteKey;
      currentRouteKey = nextRouteKey;
      const payload = {
        previous: previousRouteKey,
        current: nextRouteKey,
        pathname: location.pathname,
        search: location.search,
        hash: location.hash
      };
      listeners.forEach((listener) => {
        try {
          listener(payload);
        } catch (error) {
          console.warn('[Cone Deck] route listener error:', error);
        }
      });
    }

    function patchHistory() {
      if (patched) return;
      patched = true;
      const onHistoryChange = () => queueMicrotask(() => emitIfChanged(false));
      const onPopState = () => emitIfChanged(false);
      const onHashChange = () => emitIfChanged(false);
      originals = {
        pushState: history.pushState,
        replaceState: history.replaceState,
        onPopState,
        onHashChange
      };

      ['pushState', 'replaceState'].forEach((method) => {
        const original = history[method];
        if (typeof original !== 'function') return;
        history[method] = function(...args) {
          const result = original.apply(this, args);
          onHistoryChange();
          return result;
        };
      });
      window.addEventListener('popstate', onPopState);
      window.addEventListener('hashchange', onHashChange);
      intervalId = window.setInterval(() => emitIfChanged(false), 800);
    }

    patchHistory();

    return {
      getCurrentRouteKey: () => currentRouteKey,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emitNow() {
        emitIfChanged(true);
      },
      destroy() {
        listeners.clear();
        if (intervalId) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
        if (patched && originals) {
          if (history.pushState !== originals.pushState) history.pushState = originals.pushState;
          if (history.replaceState !== originals.replaceState) history.replaceState = originals.replaceState;
          window.removeEventListener('popstate', originals.onPopState);
          window.removeEventListener('hashchange', originals.onHashChange);
        }
        patched = false;
        originals = null;
      }
    };
  }

  const app = {
    booted: true,
    started: false,
    modules: [],
    currentTheme: 'system',
    storageKeys: STORAGE_KEYS,
    routeBus: createRouteBus(),
    registerModule(module) {
      this.modules.push(module);
      if (this.started && typeof module.init === 'function') {
        module.init(this);
      }
    },
    utils: {
      debounce(fn, delay = 200) {
        let timer = null;
        return (...args) => {
          clearTimeout(timer);
          timer = setTimeout(() => fn(...args), delay);
        };
      },
      truncate(text, max) {
        const clean = (text || '').replace(/\s+/g, ' ').trim();
        return clean.length > max ? clean.slice(0, max) + '…' : clean;
      },
      cleanText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
      },
      createEl(tag, attrs = {}, children = []) {
        const el = document.createElement(tag);
        Object.entries(attrs).forEach(([key, value]) => {
          if (value === undefined || value === null) return;
          if (key === 'class') el.className = value;
          else if (key === 'dataset') {
            Object.entries(value).forEach(([dataKey, dataValue]) => {
              el.dataset[dataKey] = dataValue;
            });
          } else if (key === 'text') {
            el.textContent = value;
          } else if (key === 'html') {
            el.innerHTML = value;
          } else {
            el.setAttribute(key, value);
          }
        });
        [].concat(children).filter(Boolean).forEach((child) => el.appendChild(child));
        return el;
      },
      uid(prefix = 'cd') {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      },
      getEffectiveTheme(theme) {
        return theme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : theme;
      },
      // ChatGPT URL parsing
      getConversationIdFromHref(href) {
        if (!href) return '';
        try {
          const url = new URL(href, location.origin);
          const path = url.pathname.replace(/\/$/, '');
          // ChatGPT format: /c/xxx or /share/xxx
          const parts = path.split('/').filter(Boolean);
          if (!parts.length) return '';
          // Find the conversation ID
          if (parts[0] === 'c' && parts[1]) return parts[1];
          if (parts[0] === 'share' && parts[1]) return parts[1];
          return parts.join('/');
        } catch {
          return href;
        }
      },
      isChatGPTConversationHref(href) {
        if (!href) return false;
        try {
          const url = new URL(href, location.origin);
          const path = url.pathname.replace(/\/$/, '');
          // ChatGPT conversation URL format
          return /^\/(c|share)\/[A-Za-z0-9_-]+/.test(path);
        } catch {
          return false;
        }
      }
    },
    storage: {
      async get(keys) {
        return promisifyChromeStorage('get', keys);
      },
      async set(payload) {
        return promisifyChromeStorage('set', payload);
      }
    },
    onRouteChange(listener) {
      return this.routeBus.subscribe(listener);
    },
    getCurrentRouteKey() {
      return this.routeBus.getCurrentRouteKey();
    },
    async applyTheme(theme) {
      this.currentTheme = theme;
      const vars = THEMES[this.utils.getEffectiveTheme(theme)];
      Object.entries(vars).forEach(([key, value]) => {
        document.documentElement.style.setProperty(key, value);
      });
      document.documentElement.dataset.cnTheme = theme;
      document.querySelectorAll('.cn-theme-btn').forEach((btn) => {
        btn.classList.toggle('cn-active', btn.dataset.theme === theme);
      });
      await this.storage.set({ [STORAGE_KEYS.theme]: theme });
    },
    async initTheme() {
      const result = await this.storage.get(STORAGE_KEYS.theme);
      await this.applyTheme(result[STORAGE_KEYS.theme] || 'system');
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.currentTheme === 'system') this.applyTheme('system');
      });
    },
    async start() {
      if (this.started) return;
      this.started = true;
      document.documentElement.classList.add('cone-deck-ready');
      await this.initTheme();
      this.modules.forEach((module) => {
        if (typeof module.init === 'function') module.init(this);
      });
      this.routeBus.emitNow();
    }
  };

  window.ConeDeckApp = app;
  setTimeout(() => app.start(), 0);
})();