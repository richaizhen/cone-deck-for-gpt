(() => {
  const app = window.ConeDeckApp;
  if (!app) return;

  app.registerModule({
    name: 'organizer',
    init(appInstance) {
      const STORAGE_KEY = appInstance.storageKeys.organizer;
      const BUILTIN_ARCHIVE_ID = '__archive__';
      const ORGANIZER_ID = 'cd-organizer-root';
      const MENU_ID = 'cd-context-menu';

      let state = {
        folders: [],
        assignments: {},
        archiveCollapsed: true,
        conversations: {}
      };

      let sidebarMount = null;
      let bodyObserver = null;
      let renderScheduled = false;
      let isDragging = false;
      let currentConversationId = '';
      let currentSidebarSignature = '';
      let healthTimer = null;
      let unlistenRoute = null;
      let sidebarDropBinding = null;
      let menuAnchorX = 0;
      let menuAnchorY = 0;
      let uiState = {
        newFolderOpen: false,
        newFolderConversationId: '',
        newFolderDraft: '',
        editingFolderId: '',
        editingFolderDraft: '',
        pendingFocusKey: ''
      };

      const {
        createEl,
        cleanText,
        truncate,
        uid,
        getConversationIdFromHref,
        isChatGPTConversationHref,
        debounce
      } = appInstance.utils;
      const debouncedRefresh = debounce(() => {
        // While an inline folder input is open, don't let host (ChatGPT) DOM churn
        // trigger a re-render: rebuilding the organizer would destroy and then re-focus
        // the input a frame later, and in that gap ChatGPT steals focus to its composer.
        if (uiState.newFolderOpen || uiState.editingFolderId) return;
        scheduleRender();
      }, 180);
      const debouncedPassivePersist = debounce(() => persistState(), 500);

      function getDefaultState() {
        return {
          folders: [],
          assignments: {},
          archiveCollapsed: true,
          organizerCollapsed: false,
          conversations: {}
        };
      }

      function cloneState(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function sanitizeFolder(folder) {
        const name = cleanText(folder?.name || '');
        if (!name) return null;
        return {
          id: folder?.id || uid('folder'),
          name,
          collapsed: Boolean(folder?.collapsed)
        };
      }

      function sanitizeConversationMeta(conversationId, meta) {
        const id = cleanText(conversationId || meta?.id || '');
        if (!id) return null;
        const title = cleanText(meta?.title || '');
        const href = cleanHref(meta?.href || `/c/${id}`);
        return {
          id,
          title: title || id,
          href: href || `/c/${id}`,
          lastSeenAt: Number(meta?.lastSeenAt) || Date.now()
        };
      }

      function cleanHref(href) {
        if (!href) return '';
        try {
          const url = new URL(href, location.origin);
          return `${url.pathname}${url.search}${url.hash}`;
        } catch {
          return href;
        }
      }

      async function loadState() {
        const result = await appInstance.storage.get(STORAGE_KEY);
        state = Object.assign(getDefaultState(), cloneState(result[STORAGE_KEY] || {}));

        if (!Array.isArray(state.folders)) state.folders = [];
        state.folders = state.folders.map(sanitizeFolder).filter(Boolean);

        if (!state.assignments || typeof state.assignments !== 'object') state.assignments = {};
        state.assignments = Object.fromEntries(
          Object.entries(state.assignments)
            .map(([conversationId, folderId]) => [cleanText(conversationId), cleanText(folderId)])
            .filter(([conversationId, folderId]) => conversationId && folderId)
        );

        if (typeof state.archiveCollapsed !== 'boolean') state.archiveCollapsed = true;
        if (typeof state.organizerCollapsed !== 'boolean') state.organizerCollapsed = false;

        if (!state.conversations || typeof state.conversations !== 'object') state.conversations = {};
        state.conversations = Object.fromEntries(
          Object.entries(state.conversations)
            .map(([conversationId, meta]) => [conversationId, sanitizeConversationMeta(conversationId, meta)])
            .filter(([, meta]) => Boolean(meta))
        );
      }

      async function persistState() {
        const payload = {
          folders: state.folders.map(sanitizeFolder).filter(Boolean),
          assignments: Object.fromEntries(
            Object.entries(state.assignments)
              .map(([conversationId, folderId]) => [cleanText(conversationId), cleanText(folderId)])
              .filter(([conversationId, folderId]) => conversationId && folderId)
          ),
          archiveCollapsed: Boolean(state.archiveCollapsed),
          organizerCollapsed: Boolean(state.organizerCollapsed),
          conversations: Object.fromEntries(
            Object.entries(state.conversations)
              .map(([conversationId, meta]) => [conversationId, sanitizeConversationMeta(conversationId, meta)])
              .filter(([, meta]) => Boolean(meta))
          )
        };

        state = cloneState(payload);
        await appInstance.storage.set({ [STORAGE_KEY]: payload });
      }

      function getFolderById(folderId) {
        return state.folders.find((folder) => folder.id === folderId) || null;
      }

      function getFolderName(folderId) {
        if (folderId === BUILTIN_ARCHIVE_ID) return 'Archive';
        return getFolderById(folderId)?.name || 'Untitled folder';
      }

      function getIconMarkup(name) {
        const icons = {
          folder: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4.75A1.75 1.75 0 0 1 3.5 3h2.15c.53 0 1.03.24 1.36.65l.49.6c.14.18.35.28.58.28h4.42a1.75 1.75 0 0 1 1.75 1.75v5.97A1.75 1.75 0 0 1 12.5 14H3.5a1.75 1.75 0 0 1-1.75-1.75V4.75Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          'folder-plus': '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4.75A1.75 1.75 0 0 1 3.5 3h2.15c.53 0 1.03.24 1.36.65l.49.6c.14.18.35.28.58.28h4.42a1.75 1.75 0 0 1 1.75 1.75v5.97A1.75 1.75 0 0 1 12.5 14H3.5a1.75 1.75 0 0 1-1.75-1.75V4.75Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.2 7.55v3.1M9.65 9.1h3.1" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
          'folder-minus': '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4.75A1.75 1.75 0 0 1 3.5 3h2.15c.53 0 1.03.24 1.36.65l.49.6c.14.18.35.28.58.28h4.42a1.75 1.75 0 0 1 1.75 1.75v5.97A1.75 1.75 0 0 1 12.5 14H3.5a1.75 1.75 0 0 1-1.75-1.75V4.75Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.65 9.1h3.1" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
          archive: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.25" y="3" width="11.5" height="3.15" rx="1.2" stroke="currentColor" stroke-width="1.45"/><path d="M3.2 6.15h9.6v5.1A1.75 1.75 0 0 1 11.05 13H4.95A1.75 1.75 0 0 1 3.2 11.25v-5.1Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M6 8.7h4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
          unarchive: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.25" y="3" width="11.5" height="3.15" rx="1.2" stroke="currentColor" stroke-width="1.45"/><path d="M3.2 6.15h9.6v5.1A1.75 1.75 0 0 1 11.05 13H4.95A1.75 1.75 0 0 1 3.2 11.25v-5.1Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M8 11.1V7.95M8 7.95l-1.6 1.55M8 7.95 9.6 9.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          pencil: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10.95 2.6 2.45 2.45M3.15 12.85l2.08-.34a1.6 1.6 0 0 0 .8-.42l6.12-6.12a1.4 1.4 0 0 0 0-1.98l-.14-.14a1.4 1.4 0 0 0-1.98 0L3.9 9.97a1.6 1.6 0 0 0-.42.8l-.33 2.08Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          trash: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.9 4.35h10.2M6.2 2.85h3.6M5 4.35v7.1m3-7.1v7.1m3-7.1v7.1M4.3 4.35h7.4v7.4A1.25 1.25 0 0 1 10.45 13H5.55A1.25 1.25 0 0 1 4.3 11.75v-7.4Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          check: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.6 8.25 6.55 11.2 12.4 5.35" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        };
        return icons[name] || '';
      }

      function createIcon(name, className = 'cd-icon') {
        return createEl('span', {
          class: className,
          html: getIconMarkup(name),
          'aria-hidden': 'true'
        });
      }

      function ensureMenu() {
        let menu = document.getElementById(MENU_ID);
        if (menu) return menu;
        menu = createEl('div', { id: MENU_ID, class: 'cd-context-menu' });
        document.body.appendChild(menu);
        document.addEventListener('click', (event) => {
          if (!menu.contains(event.target)) hideMenu();
        }, true);
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') hideMenu();
        }, true);
        window.addEventListener('resize', hideMenu);
        window.addEventListener('scroll', hideMenu, true);
        return menu;
      }

      function hideMenu() {
        const menu = document.getElementById(MENU_ID);
        if (menu) {
          menu.classList.remove('is-visible');
          menu.innerHTML = '';
        }
      }

      function showMenu(x, y, payload) {
        const menu = ensureMenu();
        menu.innerHTML = '';

        const title = createEl('div', {
          class: 'cd-context-title',
          text: truncate(payload.title || '', 30) || 'Untitled chat'
        });
        menu.appendChild(title);

        if (payload.type === 'conversation') {
          const assignedFolderId = state.assignments[payload.conversationId] || '';
          const isArchived = assignedFolderId === BUILTIN_ARCHIVE_ID;
          const currentFolder = !isArchived && assignedFolderId ? getFolderById(assignedFolderId) : null;

          if (isArchived) {
            menu.appendChild(createMenuButton('Unarchive', async () => {
              delete state.assignments[payload.conversationId];
              await persistState();
              scheduleRender();
            }, false, { icon: 'unarchive' }));
          } else {
            if (state.folders.length > 0) {
              const shouldExpandFolders = state.folders.length <= 5;
              const folderGroup = createEl('div', {
                class: `cd-context-folder-group${shouldExpandFolders ? ' is-open' : ''}`
              });
              const folderToggleBtn = createMenuToggleButton('Move to folder', 'folder', shouldExpandFolders, () => {
                folderGroup.classList.toggle('is-open');
                const isOpen = folderGroup.classList.contains('is-open');
                folderToggleBtn.classList.toggle('is-open', isOpen);
                syncMenuToggleArrow(folderToggleBtn, isOpen);
                positionMenu();
              });
              menu.appendChild(folderToggleBtn);
              state.folders.forEach((folder) => {
                const isCurrent = currentFolder?.id === folder.id;
                const btn = createMenuButton(truncate(folder.name, 22), async () => {
                  await assignConversation(payload.conversationId, folder.id);
                }, false, { icon: 'folder', trailingIcon: isCurrent ? 'check' : '', trailingAccent: isCurrent });
                btn.classList.add('cd-ctx-indent');
                if (isCurrent) btn.classList.add('cd-ctx-current');
                folderGroup.appendChild(btn);
              });
              if (currentFolder) {
                folderGroup.appendChild(createDivider());
                folderGroup.appendChild(createMenuButton('Remove from folder', async () => {
                  delete state.assignments[payload.conversationId];
                  await persistState();
                  scheduleRender();
                }, false, { icon: 'folder-minus' }));
              }
              menu.appendChild(folderGroup);
              menu.appendChild(createDivider());
            }
            menu.appendChild(createMenuButton('Move to new folder', async () => {
              hideMenu();
              showInlineNewFolder(payload.conversationId);
            }, false, { icon: 'folder-plus' }));
            menu.appendChild(createDivider());
            menu.appendChild(createMenuButton('Archive chat', async () => {
              state.assignments[payload.conversationId] = BUILTIN_ARCHIVE_ID;
              await persistState();
              scheduleRender();
            }, false, { icon: 'archive' }));
          }
        }

        if (payload.type === 'folder') {
          const folder = getFolderById(payload.folderId);
          if (!folder) return;
          menu.appendChild(createMenuButton('Rename folder', () => renameFolder(folder.id), false, { icon: 'pencil' }));
          menu.appendChild(createMenuButton('Delete folder', () => removeFolder(folder.id), false, { icon: 'trash', danger: true }));
        }

        if (payload.type === 'archive-folder') {
          menu.appendChild(createMenuButton(state.archiveCollapsed ? 'Expand archive' : 'Collapse archive', async () => {
            state.archiveCollapsed = !state.archiveCollapsed;
            await persistState();
            scheduleRender();
          }, false, { icon: 'archive' }));
        }

        menu.classList.add('is-visible');
        menuAnchorX = x;
        menuAnchorY = y;
        positionMenu();
      }

      // Position the context menu inside the viewport. Re-runnable: the folder
      // sub-list expands/collapses after the menu is shown, changing its height,
      // so this is called again on toggle. When the menu is taller than the
      // viewport it pins to the top margin and scrolls internally (overflow-y in
      // CSS); otherwise it shifts up so the whole menu stays on screen.
      function positionMenu() {
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        const margin = 12;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        menu.style.maxHeight = '';
        const rect = menu.getBoundingClientRect();
        const left = Math.min(Math.max(margin, menuAnchorX), Math.max(margin, vw - rect.width - margin));
        let top;
        if (rect.height >= vh - margin * 2) {
          top = margin;
          menu.style.maxHeight = `${vh - margin * 2}px`;
        } else {
          top = Math.min(Math.max(margin, menuAnchorY), Math.max(margin, vh - rect.height - margin));
        }
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
      }

      function createDivider() {
        return createEl('div', { class: 'cd-context-divider' });
      }

      function syncMenuToggleArrow(button, isOpen) {
        const arrow = button?.querySelector('.cd-context-toggle-arrow');
        if (arrow) arrow.textContent = isOpen ? '▾' : '▸';
      }

      function createMenuToggleButton(label, iconName, isOpen, onToggle) {
        const button = createEl('button', {
          class: `cd-context-btn cd-context-btn--toggle${isOpen ? ' is-open' : ''}`,
          type: 'button'
        });
        if (iconName) button.appendChild(createIcon(iconName, 'cd-context-btn-icon'));
        button.appendChild(createEl('span', { class: 'cd-context-btn-text', text: label }));
        button.appendChild(createEl('span', {
          class: 'cd-context-toggle-arrow',
          text: isOpen ? '▾' : '▸'
        }));
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          onToggle?.();
        });
        return button;
      }

      function createMenuButton(label, onClick, disabled = false, options = {}) {
        const button = createEl('button', {
          class: `cd-context-btn${disabled ? ' is-disabled' : ''}${options.danger ? ' is-danger' : ''}`,
          type: 'button'
        });
        if (options.icon) button.appendChild(createIcon(options.icon, 'cd-context-btn-icon'));
        button.appendChild(createEl('span', { class: 'cd-context-btn-text', text: label }));
        if (options.trailingIcon) {
          button.appendChild(createIcon(options.trailingIcon, `cd-context-btn-trailing${options.trailingAccent ? ' is-accent' : ''}`));
        }
        if (!disabled) {
          button.addEventListener('click', async (event) => {
            event.stopPropagation();
            hideMenu();
            await onClick();
          });
        }
        return button;
      }

      function readConversationDataset(target) {
        const dataset = target?.dataset || {};
        return {
          conversationId: dataset.cdConvId || dataset.convId || '',
          title: dataset.cdConvTitle || dataset.convTitle || '',
          href: dataset.cdConvHref || dataset.convHref || ''
        };
      }

      function writeConversationDataset(target, record) {
        if (!target || !record?.id) return;
        target.dataset.cdConvId = record.id;
        target.dataset.cdConvTitle = record.title || '';
        target.dataset.cdConvHref = record.href || '';
      }

      function getConversationAnchors() {
        const selectors = [
          '[data-testid*="history"] a[href]',
          '[data-testid*="conversation"] a[href]',
          '[data-testid*="sidebar"] a[href]',
          '[aria-label*="history" i] a[href]',
          'aside a[href]',
          'nav a[href]',
          // ChatGPT-specific selectors
          '[class*="conversation"] a[href^="/c/"]',
          '[class*="history"] a[href^="/c/"]'
        ];

        const collected = new Map();
        selectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((anchor) => {
            if (!(anchor instanceof HTMLAnchorElement)) return;
            if (anchor.closest(`#${ORGANIZER_ID}`) || anchor.closest(`#${MENU_ID}`) || anchor.closest('#cn-panel')) return;
            // Never latch onto anchors inside a modal dialog (e.g. ChatGPT's "Delete chat?" confirm). Its
            // conversation links match the early [class*="conversation"] / [data-testid*="conversation"] selectors
            // and would win first place, dragging the whole Folders module's mount point into the dialog.
            if (anchor.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return;
            const href = anchor.getAttribute('href') || anchor.href;
            if (!isChatGPTConversationHref(href)) return;
            const title = getAnchorTitle(anchor);
            if (!title) return;
            const id = getConversationIdFromHref(href);
            if (!id) return;
            if (!collected.has(id)) collected.set(id, anchor);
          });
        });

        return Array.from(collected.values());
      }

      function getAnchorTitle(anchor) {
        const aria = cleanText(anchor.getAttribute('aria-label') || '');
        if (aria) return aria;
        const labelled = anchor.getAttribute('title');
        if (labelled) return cleanText(labelled);
        return cleanText(anchor.textContent || anchor.innerText || '');
      }

      function findSidebarRootFromAnchors(anchors) {
        if (!anchors.length) return null;
        const scored = new Map();

        anchors.forEach((anchor) => {
          let depth = 0;
          let node = anchor;
          while (node && node !== document.body && depth < 10) {
            const parent = node.parentElement;
            if (!parent) break;
            const current = scored.get(parent) || { count: 0, depthSum: 0, semanticScore: 0 };
            current.count += 1;
            current.depthSum += depth;
            if (parent.matches?.('aside, nav, [data-testid*="sidebar"], [data-testid*="history"], [role="navigation"]')) {
              current.semanticScore += 3;
            }
            if (parent.querySelectorAll?.('a[href^="/c/"]').length >= 3) {
              current.semanticScore += 1;
            }
            scored.set(parent, current);
            node = parent;
            depth += 1;
          }
        });

        const sorted = Array.from(scored.entries())
          .map(([node, value]) => ({
            node,
            count: value.count,
            avgDepth: value.depthSum / Math.max(1, value.count),
            semanticScore: value.semanticScore,
            area: node.getBoundingClientRect ? node.getBoundingClientRect().width * node.getBoundingClientRect().height : 0
          }))
          .filter((entry) => entry.count >= Math.min(anchors.length, 3))
          .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            if (b.semanticScore !== a.semanticScore) return b.semanticScore - a.semanticScore;
            if (a.avgDepth !== b.avgDepth) return a.avgDepth - b.avgDepth;
            return b.area - a.area;
          });

        return sorted[0]?.node || anchors[0].closest('aside, nav') || anchors[0].parentElement;
      }

      function getListRoot(sidebarRoot, anchors) {
        if (!sidebarRoot) return null;
        const semantic = anchors[0]?.closest?.('[role="list"], ul, ol, [data-testid*="history"], [data-testid*="conversation"]');
        if (semantic && sidebarRoot.contains(semantic)) return semantic;
        const sharedParent = findSharedListParent(anchors, sidebarRoot);
        if (sharedParent) return sharedParent;
        const scrollable = findScrollableAncestor(anchors[0], sidebarRoot);
        return scrollable || sidebarRoot;
      }

      function findSharedListParent(anchors, sidebarRoot) {
        const counts = new Map();
        anchors.forEach((anchor) => {
          let node = anchor.parentElement;
          let depth = 0;
          while (node && node !== sidebarRoot && depth < 6) {
            counts.set(node, (counts.get(node) || 0) + 1);
            node = node.parentElement;
            depth += 1;
          }
        });

        const sorted = Array.from(counts.entries())
          .filter(([, count]) => count >= Math.min(anchors.length, 3))
          .sort((a, b) => b[1] - a[1]);

        return sorted[0]?.[0] || null;
      }

      function findScrollableAncestor(node, stopAt) {
        let current = node?.parentElement;
        while (current && current !== document.body && current !== stopAt) {
          const style = window.getComputedStyle(current);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && current.clientHeight > 0) {
            return current;
          }
          current = current.parentElement;
        }
        return stopAt || null;
      }

      function getConversationRecord(anchor) {
        const href = cleanHref(anchor.getAttribute('href') || anchor.href);
        const conversationId = getConversationIdFromHref(href);
        const title = getAnchorTitle(anchor);
        return {
          id: conversationId,
          href,
          title,
          anchor,
          rowEl: getConversationRow(anchor),
          source: 'live',
          lastSeenAt: Date.now()
        };
      }

      function getConversationRow(anchor) {
        const semantic = anchor.closest('li, [role="listitem"], [data-testid*="conversation"]');
        if (semantic && semantic !== anchor) return semantic;
        let current = anchor;
        const maxDepth = 5;
        let depth = 0;
        while (current.parentElement && depth < maxDepth) {
          const parent = current.parentElement;
          const chatLinkCount = parent.querySelectorAll('a[href^="/c/"]').length;
          if (chatLinkCount > 1) return current;
          current = parent;
          depth += 1;
        }
        return anchor;
      }

      async function assignConversation(conversationId, folderId) {
        if (!conversationId || !folderId) return;
        if (folderId !== BUILTIN_ARCHIVE_ID && !getFolderById(folderId)) return;
        state.assignments[conversationId] = folderId;
        await persistState();
        scheduleRender();
      }

      async function createFolder(folderName) {
        const safeName = cleanText(folderName);
        if (!safeName) return null;
        const exists = state.folders.find((folder) => folder.name.toLowerCase() === safeName.toLowerCase());
        if (exists) return exists;
        const folder = {
          id: uid('folder'),
          name: safeName,
          collapsed: false
        };
        state.folders.push(folder);
        await persistState();
        scheduleRender();
        return folder;
      }

      function resetNewFolderUi() {
        uiState.newFolderOpen = false;
        uiState.newFolderConversationId = '';
        uiState.newFolderDraft = '';
        if (uiState.pendingFocusKey === 'new-folder') uiState.pendingFocusKey = '';
      }

      function resetRenameUi(folderId = '') {
        if (!folderId || uiState.editingFolderId === folderId) {
          uiState.editingFolderId = '';
          uiState.editingFolderDraft = '';
          if (!folderId || uiState.pendingFocusKey === `rename:${folderId}`) uiState.pendingFocusKey = '';
        }
      }

      function requestFocus(key) {
        uiState.pendingFocusKey = key;
      }

      function applyPendingFocus(root) {
        const key = uiState.pendingFocusKey;
        if (!key || !root?.isConnected) return;
        requestAnimationFrame(() => {
          const selector = `[data-cd-focus-key="${CSS.escape(key)}"]`;
          const input = root.querySelector(selector);
          if (!(input instanceof HTMLInputElement)) return;
          uiState.pendingFocusKey = '';
          input.focus();
          input.select?.();
        });
      }

      function showInlineNewFolder(conversationId) {
        if (state.organizerCollapsed) {
          state.organizerCollapsed = false;
          persistState().then(() => {
            uiState.newFolderOpen = true;
            uiState.newFolderConversationId = conversationId || '';
            uiState.newFolderDraft = '';
            requestFocus('new-folder');
            scheduleRender();
          });
          return;
        }
        uiState.newFolderOpen = true;
        uiState.newFolderConversationId = conversationId || '';
        uiState.newFolderDraft = '';
        requestFocus('new-folder');
        scheduleRender();
      }

      async function commitInlineNewFolder(rawName) {
        const safeName = cleanText(rawName || uiState.newFolderDraft || '');
        const conversationId = uiState.newFolderConversationId;
        resetNewFolderUi();
        if (!safeName) {
          scheduleRender();
          return;
        }
        const folder = await createFolder(safeName);
        if (folder && conversationId) {
          await assignConversation(conversationId, folder.id);
        }
      }

      function cancelInlineNewFolder() {
        resetNewFolderUi();
        scheduleRender();
      }

      async function renameFolder(folderId) {
        const folder = getFolderById(folderId);
        if (!folder) return;
        resetNewFolderUi();
        uiState.editingFolderId = folderId;
        uiState.editingFolderDraft = folder.name;
        requestFocus(`rename:${folderId}`);
        scheduleRender();
      }

      async function commitRenameFolder(folderId, rawName) {
        const folder = getFolderById(folderId);
        resetRenameUi(folderId);
        if (!folder) {
          scheduleRender();
          return;
        }
        const safeName = cleanText(rawName || '');
        if (!safeName || safeName === folder.name) {
          scheduleRender();
          return;
        }
        const duplicate = state.folders.find((item) => item.id !== folderId && item.name.toLowerCase() === safeName.toLowerCase());
        if (duplicate) {
          alert('A folder with this name already exists. Please choose another name.');
          scheduleRender();
          return;
        }
        folder.name = safeName;
        await persistState();
        scheduleRender();
      }

      function cancelRenameFolder(folderId = '') {
        resetRenameUi(folderId);
        scheduleRender();
      }

      function renderInlineNewFolder() {
        const wrap = createEl('div', { id: 'cd-new-folder-wrap' });
        const input = createEl('input', {
          id: 'cd-new-folder-input',
          type: 'text',
          placeholder: 'Folder name…',
          dataset: { cdFocusKey: 'new-folder' }
        });
        input.value = uiState.newFolderDraft || '';
        const btns = createEl('div', { id: 'cd-new-folder-btns' });
        const okBtn = createEl('button', { id: 'cd-nf-ok', type: 'button', text: '✓' });
        const cancelBtn = createEl('button', { id: 'cd-nf-cancel', type: 'button', text: '✕' });
        const commit = async () => {
          uiState.newFolderDraft = input.value;
          await commitInlineNewFolder(input.value);
        };
        const cancel = () => cancelInlineNewFolder();
        const stopPointer = (event) => event.stopPropagation();
        [input, okBtn, cancelBtn].forEach((el) => {
          el.addEventListener('mousedown', stopPointer);
          el.addEventListener('click', stopPointer);
          el.addEventListener('dblclick', stopPointer);
        });
        input.addEventListener('input', () => {
          uiState.newFolderDraft = input.value;
        });
        input.addEventListener('keydown', (event) => {
          event.stopPropagation();
          // while the IME is composing, Enter/Esc confirm or cancel the candidate and must not trigger submit or cancel
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        });
        input.addEventListener('focusout', () => {
          requestAnimationFrame(() => {
            if (!input.isConnected) return;
            if (!uiState.newFolderOpen) return;
            if (!wrap.contains(document.activeElement)) {
              if (cleanText(input.value || '')) commit();
              else cancel();
            }
          });
        });
        okBtn.addEventListener('mousedown', (event) => event.preventDefault());
        cancelBtn.addEventListener('mousedown', (event) => event.preventDefault());
        okBtn.addEventListener('click', commit);
        cancelBtn.addEventListener('click', cancel);
        btns.append(okBtn, cancelBtn);
        wrap.append(input, btns);
        return wrap;
      }

      function createFolderNameNode(folderId, folderName) {
        if (uiState.editingFolderId !== folderId) {
          return createEl('span', { class: 'cd-folder-name', text: folderName });
        }
        const input = createEl('input', {
          class: 'cd-fname-edit',
          type: 'text',
          dataset: { cdFocusKey: `rename:${folderId}` }
        });
        input.value = uiState.editingFolderDraft || folderName;
        const stopPointer = (event) => event.stopPropagation();
        ['mousedown', 'click', 'dblclick'].forEach((type) => input.addEventListener(type, stopPointer));
        input.addEventListener('input', () => {
          uiState.editingFolderDraft = input.value;
        });
        input.addEventListener('keydown', (event) => {
          event.stopPropagation();
          // while the IME is composing, Enter/Esc confirm or cancel the candidate and must not trigger submit or cancel
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRenameFolder(folderId, input.value);
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelRenameFolder(folderId);
          }
        });
        input.addEventListener('focusout', () => {
          requestAnimationFrame(() => {
            if (!input.isConnected) return;
            if (uiState.editingFolderId !== folderId) return;
            if (document.activeElement !== input) commitRenameFolder(folderId, input.value);
          });
        });
        return input;
      }

      async function removeFolder(folderId) {
        const folder = getFolderById(folderId);
        if (!folder) return;
        const ok = confirm(`Delete folder "${folder.name}"? Its chats will move back to the ungrouped list.`);
        if (!ok) return;
        state.folders = state.folders.filter((item) => item.id !== folderId);
        Object.entries(state.assignments).forEach(([conversationId, assignedFolderId]) => {
          if (assignedFolderId === folderId) delete state.assignments[conversationId];
        });
        await persistState();
        scheduleRender();
      }

      async function toggleFolder(folderId) {
        if (folderId === BUILTIN_ARCHIVE_ID) {
          state.archiveCollapsed = !state.archiveCollapsed;
        } else {
          const folder = getFolderById(folderId);
          if (!folder) return;
          folder.collapsed = !folder.collapsed;
        }
        await persistState();
        scheduleRender();
      }

      function scheduleRender() {
        if (renderScheduled || isDragging) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
          renderScheduled = false;
          renderOrganizer();
        });
      }

      function buildSidebarSignature(mount) {
        if (!mount?.anchors?.length) return '';
        const first = getConversationIdFromHref(mount.anchors[0]?.href || '') || 'none';
        return [
          first,
          mount.anchors.length,
          mount.sidebarRoot?.tagName || '',
          mount.listRoot?.tagName || ''
        ].join('|');
      }

      function findInsertionChild(parent, node) {
        if (!parent || !node || !parent.contains(node)) return null;
        let current = node;
        while (current && current.parentElement && current.parentElement !== parent) {
          current = current.parentElement;
        }
        return current && current.parentElement === parent ? current : null;
      }

      function resolveSidebarMount() {
        const anchors = getConversationAnchors();
        if (!anchors.length) {
          sidebarMount = null;
          cleanupNativeHiding();
          removeOrganizerRoot();
          return null;
        }

        const sidebarRoot = findSidebarRootFromAnchors(anchors);
        if (!sidebarRoot) {
          sidebarMount = null;
          return null;
        }

        const listRoot = getListRoot(sidebarRoot, anchors);
        const firstRow = getConversationRow(anchors[0]) || anchors[0];
        const preferredParent = listRoot && sidebarRoot.contains(listRoot) ? listRoot : null;
        const mountParent = preferredParent
          || (firstRow?.parentElement && sidebarRoot.contains(firstRow.parentElement) ? firstRow.parentElement : sidebarRoot);
        // Mount in the sidebar's scroll container, right before the section that holds the first chat
        // (the "Recents" group) — so Folders sits directly above Recents and below all native features,
        // and scrolls together with the rest of the sidebar.
        const scrollContainer = findScrollableAncestor(anchors[0], sidebarRoot) || listRoot || sidebarRoot;
        const insertionPoint = findInsertionChild(scrollContainer, firstRow)
          || findInsertionChild(mountParent, firstRow)
          || scrollContainer.firstElementChild
          || null;

        sidebarMount = { sidebarRoot, listRoot, anchors, mountParent, scrollContainer, insertionPoint };
        const nextSignature = buildSidebarSignature(sidebarMount);
        if (currentSidebarSignature && nextSignature !== currentSidebarSignature) {
          removeOrganizerRoot();
        }
        currentSidebarSignature = nextSignature;
        return sidebarMount;
      }

      function cleanupNativeHiding() {
        document.querySelectorAll('.cd-hidden-native').forEach((el) => el.classList.remove('cd-hidden-native'));
      }

      function clearDropTargets() {
        document.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        sidebarDropBinding?.target?.classList?.remove('cd-native-recents-drop-target');
      }

      function teardownSidebarDropBinding() {
        if (!sidebarDropBinding?.target) return;
        const { target, onDragOver, onDragLeave, onDrop } = sidebarDropBinding;
        target.removeEventListener('dragover', onDragOver);
        target.removeEventListener('dragleave', onDragLeave);
        target.removeEventListener('drop', onDrop);
        target.classList.remove('cd-native-recents-drop-target');
        sidebarDropBinding = null;
      }

      function syncSidebarDropBinding(mount) {
        const target = mount?.listRoot || mount?.mountParent || mount?.sidebarRoot;
        if (!target) {
          teardownSidebarDropBinding();
          return;
        }
        if (sidebarDropBinding?.target === target) return;
        teardownSidebarDropBinding();

        const onDragOver = (event) => {
          const isConeDeckDrag = event.dataTransfer?.types?.includes?.('application/x-cone-deck-conversation');
          if (!isConeDeckDrag) return;
          if (event.target instanceof HTMLElement && event.target.closest(`#${ORGANIZER_ID}`)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          target.classList.add('cd-native-recents-drop-target');
        };

        const onDragLeave = (event) => {
          if (target.contains(event.relatedTarget)) return;
          target.classList.remove('cd-native-recents-drop-target');
        };

        const onDrop = async (event) => {
          const convId = getDraggedConversationId(event.dataTransfer);
          if (!convId) return;
          if (event.target instanceof HTMLElement && event.target.closest(`#${ORGANIZER_ID}`)) return;
          event.preventDefault();
          event.stopPropagation();
          target.classList.remove('cd-native-recents-drop-target');
          const hadAssignment = Boolean(state.assignments[convId]);
          delete state.assignments[convId];
          if (hadAssignment) await persistState();
          scheduleRender();
        };

        target.addEventListener('dragover', onDragOver);
        target.addEventListener('dragleave', onDragLeave);
        target.addEventListener('drop', onDrop);
        sidebarDropBinding = { target, onDragOver, onDragLeave, onDrop };
      }

      function getOrganizerRoot() {
        return document.getElementById(ORGANIZER_ID);
      }

      function removeOrganizerRoot() {
        getOrganizerRoot()?.remove();
      }

      function ensureOrganizerRoot() {
        const mount = sidebarMount || resolveSidebarMount();
        if (!mount?.sidebarRoot) return null;

        const parent = mount.scrollContainer || mount.mountParent || mount.listRoot || mount.sidebarRoot;
        // Safety net: never mount/move the module into a modal dialog or overlay.
        if (parent && parent.closest && parent.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
          return getOrganizerRoot();
        }
        const insertionPoint = (mount.insertionPoint && parent.contains(mount.insertionPoint))
          ? mount.insertionPoint
          : (parent.firstElementChild || null);

        let organizer = getOrganizerRoot();
        if (!organizer) {
          organizer = createEl('section', { id: ORGANIZER_ID, class: 'cd-organizer-root' });
        }

        if (!parent.contains(organizer) || organizer.parentElement !== parent) {
          parent.insertBefore(organizer, insertionPoint);
        } else if (insertionPoint && organizer.nextElementSibling !== insertionPoint) {
          parent.insertBefore(organizer, insertionPoint);
        } else if (!insertionPoint && parent.firstElementChild !== organizer) {
          parent.insertBefore(organizer, parent.firstChild);
        }

        if (!organizer.dataset.cdDelegatedBound) {
          organizer.dataset.cdDelegatedBound = '1';
          organizer.addEventListener('contextmenu', onOrganizerDelegatedContextMenu, true);
          organizer.addEventListener('dragstart', onOrganizerDelegatedDragStart, true);
          organizer.addEventListener('dragend', onConversationDragEnd, true);
        }

        return organizer;
      }

      function bindConversationSource(record) {
        const target = record.rowEl || record.anchor;
        if (!target) return;
        writeConversationDataset(target, record);
        target.draggable = true;
        if (target.dataset.cdBound === '1') return;
        target.dataset.cdBound = '1';
        target.addEventListener('dragstart', onConversationDragStart);
        target.addEventListener('dragend', onConversationDragEnd);
        target.addEventListener('contextmenu', onConversationContextMenu);
      }

      function handleConversationDragStartFor(target, event) {
        const payload = readConversationDataset(target);
        const convId = payload.conversationId;
        if (!convId || !event?.dataTransfer) return;
        hideMenu();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', convId);
        event.dataTransfer.setData('application/x-cone-deck-conversation', convId);
      }

      function onConversationDragStart(event) {
        isDragging = true;
        handleConversationDragStartFor(event.currentTarget, event);
      }

      function onConversationDragEnd() {
        isDragging = false;
        clearDropTargets();
        scheduleRender();
      }

      function getDraggedConversationId(dataTransfer) {
        if (!dataTransfer) return '';
        return dataTransfer.getData('application/x-cone-deck-conversation') || dataTransfer.getData('text/plain') || '';
      }

      function handleConversationContextMenuFor(target, event) {
        const payload = readConversationDataset(target);
        const convId = payload.conversationId;
        if (!convId) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        showMenu(event.clientX, event.clientY, {
          type: 'conversation',
          conversationId: convId,
          title: payload.title || state.conversations[convId]?.title || ''
        });
      }

      function onConversationContextMenu(event) {
        handleConversationContextMenuFor(event.currentTarget, event);
      }

      function onOrganizerDelegatedDragStart(event) {
        const proxy = event.target instanceof HTMLElement ? event.target.closest('.cd-conversation-proxy') : null;
        if (!proxy) return;
        isDragging = true;
        handleConversationDragStartFor(proxy, event);
      }

      function onOrganizerDelegatedContextMenu(event) {
        const proxy = event.target instanceof HTMLElement ? event.target.closest('.cd-conversation-proxy') : null;
        if (!proxy) return;
        handleConversationContextMenuFor(proxy, event);
      }

      function onFolderContextMenu(event) {
        const folderId = event.currentTarget?.dataset?.folderId;
        if (!folderId) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu(event.clientX, event.clientY, {
          type: folderId === BUILTIN_ARCHIVE_ID ? 'archive-folder' : 'folder',
          folderId,
          title: getFolderName(folderId)
        });
      }

      async function onFolderDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        const folderId = event.currentTarget?.dataset?.folderId;
        const convId = getDraggedConversationId(event.dataTransfer);
        event.currentTarget.classList.remove('is-drop-target');
        if (!folderId || !convId) return;
        if (state.assignments[convId] === folderId) return;
        state.assignments[convId] = folderId;
        await persistState();
        scheduleRender();
      }

      function onFolderDragOver(event) {
        const isConeDeckDrag = event.dataTransfer?.types?.includes?.('application/x-cone-deck-conversation');
        if (!isConeDeckDrag) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        event.currentTarget.classList.add('is-drop-target');
      }

      function onFolderDragLeave(event) {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        event.currentTarget.classList.remove('is-drop-target');
      }

      function upsertConversationMeta(record) {
        if (!record?.id) return false;
        const normalized = sanitizeConversationMeta(record.id, record);
        if (!normalized) return false;
        const existing = state.conversations[record.id];
        const changed = !existing
          || existing.title !== normalized.title
          || existing.href !== normalized.href;
        state.conversations[record.id] = {
          ...existing,
          ...normalized,
          lastSeenAt: Math.max(normalized.lastSeenAt, existing?.lastSeenAt || 0)
        };
        return changed;
      }

      function maybeCaptureCurrentConversationFallback() {
        const conversationId = getConversationIdFromHref(location.href || location.pathname || '');
        if (!conversationId) return false;

        const titleCandidates = [
          document.querySelector('[data-conversation-title]')?.textContent,
          document.querySelector('h1')?.textContent,
          document.title?.replace(/\s*[\-–|]\s*ChatGPT\s*$/i, '')
        ];
        const title = cleanText(titleCandidates.find(Boolean) || '');
        const href = cleanHref(`/c/${conversationId}`);
        if (!title) return false;
        return upsertConversationMeta({ id: conversationId, title, href, lastSeenAt: Date.now() });
      }

      function collectConversationMap() {
        const map = new Map();
        let catalogChanged = false;
        getConversationAnchors().forEach((anchor) => {
          const record = getConversationRecord(anchor);
          if (!record.id || !record.title) return;
          map.set(record.id, record);
          bindConversationSource(record);
          if (upsertConversationMeta(record)) catalogChanged = true;
        });
        if (maybeCaptureCurrentConversationFallback()) catalogChanged = true;
        if (catalogChanged) debouncedPassivePersist();
        return map;
      }

      function getStoredConversationRecord(conversationId) {
        const meta = sanitizeConversationMeta(conversationId, state.conversations[conversationId]);
        if (!meta) return null;
        return {
          id: meta.id,
          href: meta.href,
          title: meta.title,
          anchor: null,
          rowEl: null,
          source: 'stored',
          lastSeenAt: meta.lastSeenAt || 0
        };
      }

      function getOrderedRecordsForFolder(folderId, liveMap, liveOrderMap) {
        const ids = Object.keys(state.assignments).filter((conversationId) => state.assignments[conversationId] === folderId);
        return ids
          .map((conversationId) => liveMap.get(conversationId) || getStoredConversationRecord(conversationId))
          .filter(Boolean)
          .sort((a, b) => {
            const aLive = liveOrderMap.has(a.id);
            const bLive = liveOrderMap.has(b.id);
            if (aLive && bLive) return liveOrderMap.get(a.id) - liveOrderMap.get(b.id);
            if (aLive !== bLive) return aLive ? -1 : 1;
            return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
          });
      }

      function isMenuVisible() {
        const menu = document.getElementById(MENU_ID);
        return menu && menu.classList.contains('is-visible');
      }

      function renderOrganizer() {
        const mount = resolveSidebarMount();
        if (!mount) return;

        const organizer = ensureOrganizerRoot();
        if (!organizer) return;

        if (isLikelySidebarCollapsed(mount)) {
          organizer.style.display = 'none';
          if (!isMenuVisible()) hideMenu();
          return;
        }

        organizer.style.display = '';
        organizer.innerHTML = '';

        const liveMap = collectConversationMap();
        const conversations = Array.from(liveMap.values());
        const liveOrderMap = new Map(conversations.map((record, index) => [record.id, index]));
        currentConversationId = getConversationIdFromHref(location.pathname || '');

        cleanupOrphanAssignments();
        if (!isMenuVisible()) hideMenu();
        clearDropTargets();
        syncSidebarDropBinding(mount);

        const header = createEl('div', { class: 'cd-org-header' });
        const toggleIcon = createEl('span', {
          class: 'cd-org-toggle-icon',
          text: state.organizerCollapsed ? '▸' : '▾'
        });
        const title = createEl('span', { class: 'cd-org-title', text: 'Folders' });
        const addBtn = createEl('button', {
          class: 'cd-org-add',
          type: 'button',
          text: '+',
          title: 'New folder'
        });
        addBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          showInlineNewFolder(null);
        });
        header.append(toggleIcon, title, addBtn);
        header.addEventListener('click', async () => {
          if (uiState.editingFolderId) return;
          state.organizerCollapsed = !state.organizerCollapsed;
          await persistState();
          scheduleRender();
        });
        organizer.appendChild(header);

        if (!state.organizerCollapsed) {
          const foldersWrap = createEl('div', { class: 'cd-folders-wrap' });
          organizer.appendChild(foldersWrap);

          if (uiState.newFolderOpen) {
            foldersWrap.appendChild(renderInlineNewFolder());
          }

          state.folders.forEach((folder) => {
            foldersWrap.appendChild(renderFolderSection(folder, liveMap, liveOrderMap));
          });
          foldersWrap.appendChild(renderArchiveSection(liveMap, liveOrderMap));
        }

        applyVisibilityToNativeRows(conversations);
        applyPendingFocus(organizer);
      }

      function cleanupOrphanAssignments() {
        let changed = false;
        Object.keys(state.assignments).forEach((conversationId) => {
          const folderId = state.assignments[conversationId];
          if (folderId !== BUILTIN_ARCHIVE_ID && !getFolderById(folderId)) {
            delete state.assignments[conversationId];
            changed = true;
          }
        });
        if (changed) persistState();
      }

      function applyVisibilityToNativeRows(conversations) {
        cleanupNativeHiding();
        const assigned = state.assignments;
        conversations.forEach((record) => {
          const target = record.rowEl || record.anchor;
          if (!target) return;
          writeConversationDataset(target, record);
          const destination = assigned[record.id] || '';
          target.classList.toggle('cd-hidden-native', Boolean(destination));
        });
      }

      function renderFolderSection(folder, liveMap, liveOrderMap) {
        const items = getOrderedRecordsForFolder(folder.id, liveMap, liveOrderMap);
        return createFolderSection({
          folderId: folder.id,
          name: folder.name,
          count: items.length,
          collapsed: Boolean(folder.collapsed),
          records: items,
          isArchive: false
        });
      }

      function renderArchiveSection(liveMap, liveOrderMap) {
        const items = getOrderedRecordsForFolder(BUILTIN_ARCHIVE_ID, liveMap, liveOrderMap);
        return createFolderSection({
          folderId: BUILTIN_ARCHIVE_ID,
          name: 'Archive',
          count: items.length,
          collapsed: state.archiveCollapsed,
          records: items,
          isArchive: true
        });
      }

      function isLikelySidebarCollapsed(mount) {
        const widths = [
          mount?.mountParent?.getBoundingClientRect?.().width || 0,
          mount?.listRoot?.getBoundingClientRect?.().width || 0,
          mount?.sidebarRoot?.getBoundingClientRect?.().width || 0
        ].filter(Boolean);
        if (!widths.length) return false;
        return Math.min(...widths) < 150;
      }

      function createFolderSection({ folderId, name, count, collapsed, records, isArchive }) {
        const section = createEl('div', {
          class: `cd-folder-section${isArchive ? ' is-archive' : ''}`,
          dataset: { folderId }
        });

        const header = createEl('div', {
          class: 'cd-folder-header',
          dataset: { folderId }
        });
        header.addEventListener('contextmenu', onFolderContextMenu);
        header.addEventListener('dragover', onFolderDragOver);
        header.addEventListener('dragleave', onFolderDragLeave);
        header.addEventListener('drop', onFolderDrop);

        const toggle = createEl('button', {
          class: 'cd-folder-toggle',
          type: 'button',
          text: collapsed ? '▸' : '▾'
        });
        toggle.addEventListener('click', async (event) => {
          event.stopPropagation();
          await toggleFolder(folderId);
        });

        const icon = createIcon(isArchive ? 'archive' : 'folder', 'cd-folder-icon');

        const nameNode = createFolderNameNode(folderId, name);
        const countEl = createEl('span', { class: 'cd-folder-count', text: String(count) });

        const tools = createEl('div', { class: 'cd-folder-tools' });
        if (!isArchive) {
          const renameBtn = createEl('button', { class: 'cd-folder-tool', type: 'button', title: 'Rename' }, createIcon('pencil', 'cd-folder-tool-icon'));
          renameBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            await renameFolder(folderId);
          });
          const deleteBtn = createEl('button', { class: 'cd-folder-tool', type: 'button', title: 'Delete' }, createIcon('trash', 'cd-folder-tool-icon'));
          deleteBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            await removeFolder(folderId);
          });
          tools.append(renameBtn, deleteBtn);
        } else {
          const menuBtn = createEl('button', { class: 'cd-folder-tool', type: 'button', text: '⋯', title: 'More' });
          menuBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const rect = menuBtn.getBoundingClientRect();
            showMenu(rect.left, rect.bottom + 6, {
              type: 'archive-folder',
              folderId,
              title: 'Archive'
            });
          });
          tools.appendChild(menuBtn);
        }

        header.append(toggle, icon, nameNode, countEl, tools);
        header.addEventListener('click', async () => {
          if (uiState.editingFolderId === folderId) return;
          await toggleFolder(folderId);
        });
        section.appendChild(header);

        const list = createEl('div', {
          class: `cd-folder-list${collapsed ? ' is-collapsed' : ''}`,
          dataset: { folderId }
        });
        list.addEventListener('dragover', onFolderDragOver);
        list.addEventListener('dragleave', onFolderDragLeave);
        list.addEventListener('drop', onFolderDrop);

        if (!records.length) {
          list.appendChild(createEl('div', {
            class: 'cd-folder-empty',
            text: isArchive ? 'No archived chats' : 'Drop chats here'
          }));
        } else {
          records.forEach((record) => list.appendChild(createProxyItem(record, isArchive)));
        }

        section.appendChild(list);
        return section;
      }

      function createProxyItem(record, isArchive) {
        const href = record.href || `/c/${record.id}`;
        const item = createEl('div', {
          class: `cd-conversation-proxy${record.id === currentConversationId ? ' is-current' : ''}${record.source === 'stored' ? ' is-stored' : ''}`,
          dataset: {
            cdConvId: record.id,
            cdConvTitle: record.title,
            cdConvHref: href
          }
        });
        item.draggable = true;

        const dot = createEl('span', { class: 'cd-conv-dot', text: '·' });
        const label = createEl('div', {
          class: 'cd-conversation-label',
          text: truncate(record.title, 36)
        });

        const removeBtn = createEl('button', {
          class: 'cd-conv-remove',
          type: 'button',
          text: '✕',
          title: isArchive ? 'Unarchive' : 'Remove from folder'
        });
        removeBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          delete state.assignments[record.id];
          await persistState();
          scheduleRender();
        });

        item.append(dot, label, removeBtn);

        item.addEventListener('click', () => {
          if (record.anchor?.isConnected) {
            record.anchor.click?.();
            return;
          }
          location.href = href;
        });
        return item;
      }

      function mutationTouchesSidebar(mutations) {
        return mutations.some((mutation) => {
          if (mutation.target instanceof HTMLElement) {
            if (mutation.target.id === MENU_ID || mutation.target.closest?.(`#${MENU_ID}`)) return false;
            if (mutation.target.id === ORGANIZER_ID || mutation.target.closest?.(`#${ORGANIZER_ID}`)) return false;
          }

          if (mutation.type === 'characterData') {
            const textParent = mutation.target?.parentElement;
            if (textParent?.closest?.(`#${MENU_ID}`)) return false;
            if (textParent?.closest?.(`#${ORGANIZER_ID}`)) return false;
            return Boolean(textParent?.closest?.('aside, nav, [data-testid*="sidebar"], [data-testid*="history"], [data-testid*="conversation"]'));
          }
          const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
          if (mutation.target instanceof HTMLElement) {
            changedNodes.push(mutation.target);
          }
          return changedNodes.some((node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (node.id === MENU_ID || node.closest?.(`#${MENU_ID}`)) return false;
            if (node.id === ORGANIZER_ID || node.closest?.(`#${ORGANIZER_ID}`)) return false;
            return node.matches?.('aside, nav, [data-testid*="sidebar"], [data-testid*="history"], [data-testid*="conversation"]')
              || node.querySelector?.('a[href^="/c/"]');
          });
        });
      }

      function startObservers() {
        if (bodyObserver) bodyObserver.disconnect();
        bodyObserver = new MutationObserver((mutations) => {
          if (mutationTouchesSidebar(mutations)) debouncedRefresh();
        });
        bodyObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['data-testid', 'href', 'aria-label', 'title']
        });
      }

      function startHealthCheck() {
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = setInterval(() => {
          const organizer = getOrganizerRoot();
          if (organizer && !document.body.contains(organizer)) {
            sidebarMount = null;
            currentSidebarSignature = '';
            scheduleRender();
          }
          if (!getConversationAnchors().length) return;
          if (!organizer) scheduleRender();
        }, 1200);
      }

      loadState().then(() => {
        ensureMenu();
        startObservers();
        startHealthCheck();
        unlistenRoute = appInstance.onRouteChange(() => {
          currentConversationId = getConversationIdFromHref(location.pathname || '');
          scheduleRender();
        });
        window.addEventListener('beforeunload', () => {
          bodyObserver?.disconnect();
          teardownSidebarDropBinding();
          if (healthTimer) clearInterval(healthTimer);
          if (typeof unlistenRoute === 'function') unlistenRoute();
        }, { once: true });
        scheduleRender();
      });
    }
  });
})();
