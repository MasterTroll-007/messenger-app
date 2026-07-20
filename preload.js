const { ipcRenderer } = require('electron');

const sendBadge = (dataUrl) => ipcRenderer.send('set-badge', dataUrl);
const sendTrayBadge = (dataUrl) => ipcRenderer.send('set-tray-badge', dataUrl);
const selectNotificationSound = () => ipcRenderer.send('select-notification-sound');

let isMuted = ipcRenderer.sendSync('get-mute-state');
let notificationAudio = null;
let notificationAudioVersion = 0;
let lastUnreadCount = null;
let unreadBaselineReady = false;
let unreadBaselineTimer = null;

const UNREAD_BASELINE_SETTLE_MS = 5000;

function getNotificationAudio() {
  if (!notificationAudio) {
    notificationAudio = new Audio(`messenger-asset://notification/sound?v=${notificationAudioVersion}`);
    notificationAudio.preload = 'auto';
  }
  return notificationAudio;
}

function reloadNotificationAudio() {
  if (!notificationAudio) return;

  notificationAudio.pause();
  notificationAudioVersion += 1;
  notificationAudio.src = `messenger-asset://notification/sound?v=${notificationAudioVersion}`;
  notificationAudio.load();
}

function playNotificationSound() {
  if (isMuted) return;

  const audio = getNotificationAudio();
  audio.currentTime = 0;
  void audio.play().catch(() => {
    // A failed custom sound must not affect Messenger itself.
  });
}

function createBadgeDataUrl(count, size = 48) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#cc0000';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.stroke();

  const text = count > 99 ? '99+' : String(count);
  ctx.fillStyle = 'white';
  ctx.font = `bold ${text.length > 2 ? 16 : text.length > 1 ? 22 : 28}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 1);

  return canvas.toDataURL('image/png');
}

ipcRenderer.on('mute-state-changed', (event, muted) => {
  isMuted = muted;
  if (isMuted && notificationAudio) {
    notificationAudio.pause();
    notificationAudio.currentTime = 0;
  }
});

ipcRenderer.on('open-sound-picker', () => {
  selectNotificationSound();
});

ipcRenderer.on('notification-sound-updated', () => {
  reloadNotificationAudio();
});

ipcRenderer.on('unread-count-changed', (event, rawCount) => {
  const count = Number.isInteger(rawCount) && rawCount > 0 ? rawCount : 0;
  if (count === lastUnreadCount) return;

  if (unreadBaselineReady && lastUnreadCount !== null && count > lastUnreadCount) {
    playNotificationSound();
  }

  if (count > 0) {
    const badge = createBadgeDataUrl(count);
    if (badge) {
      sendBadge(badge);
      sendTrayBadge(badge);
    }
  } else {
    sendBadge(null);
    sendTrayBadge(null);
  }

  lastUnreadCount = count;

  if (!unreadBaselineReady && unreadBaselineTimer === null) {
    unreadBaselineTimer = setTimeout(() => {
      unreadBaselineReady = true;
      unreadBaselineTimer = null;
    }, UNREAD_BASELINE_SETTLE_MS);
  }
});

window.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEY = 'messenger-layout';
  const NAV_SELECTOR = [
    '[aria-label="Seznam konverzací"]',
    '[aria-label="Conversation list"]',
    '[aria-label="Chat list"]',
  ].join(', ');
  const NAV_SEARCH_DEBOUNCE_MS = 250;

  const loadState = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  };

  const saveState = (updates) => {
    const state = { ...loadState(), ...updates };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const clampWidth = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const width = Number(value);
    return Number.isFinite(width) ? Math.max(0, Math.min(600, width)) : fallback;
  };

  const style = document.createElement('style');
  style.id = 'custom-messenger-styles';
  style.textContent = `
    [data-testid="cookie-policy-manage-dialog"],
    [role="banner"] {
      display: none !important;
    }

    ::-webkit-scrollbar {
      width: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.4);
    }

    [data-messenger-app-nav][data-custom-width] {
      width: var(--messenger-nav-width) !important;
      min-width: var(--messenger-nav-width) !important;
      max-width: var(--messenger-nav-width) !important;
    }
    [data-messenger-app-nav][data-nav-collapsed] {
      overflow: hidden !important;
    }

    /* Reclaim the space reserved for Facebook's hidden global header.
       Leave a tiny allowance for Meta's rounded/padded shell to avoid page overflow. */
    [data-messenger-app-content-layer] {
      height: calc(100vh - 5px) !important;
      min-height: calc(100vh - 5px) !important;
    }
    [data-messenger-app-content-offset] {
      top: 0 !important;
      bottom: 0 !important;
    }
    [data-messenger-app-thread-region] {
      height: 100% !important;
      max-height: none !important;
    }
    [data-messenger-app-thread-limit] {
      max-height: none !important;
    }

    body.messenger-compact [data-messenger-app-nav] {
      width: var(--messenger-nav-width) !important;
      min-width: var(--messenger-nav-width) !important;
      max-width: var(--messenger-nav-width) !important;
      overflow-x: hidden !important;
    }
    body.messenger-compact [data-messenger-app-nav] [role="search"],
    body.messenger-compact [data-messenger-app-nav] input,
    body.messenger-compact [data-messenger-app-nav] h1,
    body.messenger-compact [data-messenger-app-nav] [aria-label="Facebook"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Nová zpráva"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="New message"] {
      display: none !important;
    }
    body.messenger-compact [data-messenger-app-nav] span:not([data-visualcompletion]):not([role]) {
      font-size: 0 !important;
      line-height: 0 !important;
      height: 0 !important;
      overflow: hidden !important;
    }
    body.messenger-compact [data-messenger-app-nav] img {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    body.messenger-compact [data-messenger-app-nav] [role="button"] {
      display: none !important;
    }
    body.messenger-compact [data-messenger-app-nav] > div > [role="button"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Chaty"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Chats"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Lidé"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="People"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Marketplace"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Žádosti o zprávy"],
    body.messenger-compact [data-messenger-app-nav] [aria-label="Message requests"] {
      display: flex !important;
    }

    body.messenger-menu-hidden [aria-label="Přepínač Doručených zpráv"],
    body.messenger-menu-hidden [aria-label="Inbox switcher"] {
      width: 0 !important;
      min-width: 0 !important;
      max-width: 0 !important;
      overflow: hidden !important;
      padding: 0 !important;
      opacity: 0 !important;
    }

    .resize-handle {
      position: fixed;
      top: 0;
      width: 8px;
      height: 100vh;
      cursor: col-resize;
      z-index: 99999;
      background: transparent;
      transition: background 0.2s;
      touch-action: none;
    }
    .resize-handle:hover,
    .resize-handle.active {
      background: rgba(0, 149, 246, 0.4);
    }
    body.resizing {
      cursor: col-resize !important;
      user-select: none !important;
    }
    body.resizing * {
      cursor: col-resize !important;
    }

    body.messenger-compact .has-unread {
      position: relative !important;
    }
    body.messenger-compact .has-unread::after {
      content: '';
      position: absolute;
      top: 4px;
      right: 4px;
      width: 12px;
      height: 12px;
      background: #ff3b30;
      border-radius: 50%;
      border: 2px solid #242526;
      z-index: 10;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  function findConversationList() {
    const labelled = document.querySelector(NAV_SELECTOR);
    if (labelled) return labelled;

    return Array.from(document.querySelectorAll('[role="navigation"]')).find((candidate) => (
      candidate.querySelector('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')
    )) || null;
  }

  function setupFullHeightLayout(nav) {
    const main = document.querySelector('[role="main"]');
    if (!main) return () => {};

    const mainAncestors = new Set();
    for (let node = main; node; node = node.parentElement) mainAncestors.add(node);

    let common = nav;
    while (common && !mainAncestors.has(common)) common = common.parentElement;
    if (!common) return () => {};

    const layers = [];
    for (let node = common; node && node !== document.body; node = node.parentElement) {
      node.setAttribute('data-messenger-app-content-layer', '');
      const top = Number.parseFloat(getComputedStyle(node).top);
      if (Number.isFinite(top) && top > 0) {
        node.setAttribute('data-messenger-app-content-offset', '');
      }
      layers.push(node);
    }

    const threadNodes = new Set();
    let threadObserver = null;
    let threadFrameId = null;

    const applyThreadHeight = () => {
      threadFrameId = null;
      const editor = Array.from(main.querySelectorAll('[role="textbox"][contenteditable="true"]'))
        .find((node) => node.getBoundingClientRect().width > 100);
      if (!editor) return false;

      let threadRegion = null;
      for (let node = editor; node && node !== main.parentElement; node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        if (
          node.getAttribute('role') === 'region'
          && rect.height > window.innerHeight / 2
          && getComputedStyle(node).maxHeight !== 'none'
        ) {
          threadRegion = node;
        }
      }
      if (!threadRegion) return false;

      for (let node = editor; node; node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        if (rect.height > window.innerHeight / 2 && getComputedStyle(node).maxHeight !== 'none') {
          node.setAttribute('data-messenger-app-thread-limit', '');
          threadNodes.add(node);
        }
        if (node === threadRegion) break;
      }

      threadRegion.setAttribute('data-messenger-app-thread-region', '');
      threadNodes.add(threadRegion);
      if (threadObserver) threadObserver.disconnect();
      return true;
    };

    const scheduleThreadHeight = () => {
      if (threadFrameId === null) threadFrameId = requestAnimationFrame(applyThreadHeight);
    };

    if (!applyThreadHeight()) {
      threadObserver = new MutationObserver(scheduleThreadHeight);
      threadObserver.observe(main, { childList: true, subtree: true });
    }

    return () => {
      if (threadObserver) threadObserver.disconnect();
      if (threadFrameId !== null) cancelAnimationFrame(threadFrameId);
      threadNodes.forEach((node) => {
        node.removeAttribute('data-messenger-app-thread-region');
        node.removeAttribute('data-messenger-app-thread-limit');
      });
      layers.forEach((node) => {
        node.removeAttribute('data-messenger-app-content-layer');
        node.removeAttribute('data-messenger-app-content-offset');
      });
    };
  }

  function setupUnreadDots(nav, initiallyCompact) {
    let isCompact = initiallyCompact;
    let frameId = null;
    const pendingLinks = new Set();
    const observer = new MutationObserver((mutations) => {
      if (!isCompact) return;

      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target === nav && mutation.attributeName === 'style') {
          continue;
        }

        collectLinks(mutation.target);
        for (const node of mutation.addedNodes) collectLinks(node, true);
      }
      scheduleFlush();
    });

    const collectLinks = (node, includeDescendants = false) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element) return;

      const closestLink = element.closest('a');
      if (closestLink && nav.contains(closestLink)) pendingLinks.add(closestLink);
      if (includeDescendants && element.querySelectorAll) {
        element.querySelectorAll('a').forEach((link) => {
          if (nav.contains(link)) pendingLinks.add(link);
        });
      }
    };

    const updateLink = (link) => {
      if (!link.isConnected) return;

      let hasUnread = false;
      for (const span of link.querySelectorAll('span[dir="auto"]')) {
        const fontWeight = Number.parseInt(getComputedStyle(span).fontWeight, 10);
        if (fontWeight >= 600) {
          hasUnread = true;
          break;
        }
      }
      link.classList.toggle('has-unread', hasUnread);
    };

    const flush = () => {
      frameId = null;
      if (!isCompact) {
        pendingLinks.clear();
        return;
      }

      const links = Array.from(pendingLinks);
      pendingLinks.clear();
      links.forEach(updateLink);
    };

    const scheduleFlush = () => {
      if (frameId === null && pendingLinks.size > 0) {
        frameId = requestAnimationFrame(flush);
      }
    };

    const start = () => {
      observer.observe(nav, {
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-label'],
        childList: true,
        characterData: true,
        subtree: true,
      });
      nav.querySelectorAll('a').forEach((link) => pendingLinks.add(link));
      scheduleFlush();
    };

    const stop = () => {
      observer.disconnect();
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      pendingLinks.clear();
      nav.querySelectorAll('.has-unread').forEach((link) => link.classList.remove('has-unread'));
    };

    if (isCompact) start();

    return {
      setCompact(compact) {
        if (compact === isCompact) return;
        isCompact = compact;
        if (isCompact) start();
        else stop();
      },
      cleanup() {
        stop();
      },
    };
  }

  function setupNavResize(nav, saved, onCompactChange) {
    nav.setAttribute('data-messenger-app-nav', '');

    let isCompact = !!saved.isCompact;
    let compactWidth = clampWidth(saved.compactWidth, 108);
    let normalWidth = clampWidth(saved.navWidth);
    let pendingWidth = null;
    let resizeFrameId = null;
    let positionFrameId = null;
    let startX = 0;
    let startWidth = 0;
    let isDragging = false;
    let activePointerId = null;

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    document.body.appendChild(handle);

    const applyWidth = (width) => {
      if (width === null) {
        nav.style.removeProperty('--messenger-nav-width');
        nav.removeAttribute('data-custom-width');
        nav.removeAttribute('data-nav-collapsed');
        return;
      }

      nav.style.setProperty('--messenger-nav-width', `${width}px`);
      nav.setAttribute('data-custom-width', '');
      nav.toggleAttribute('data-nav-collapsed', width < 10);
    };

    const applyCurrentMode = () => {
      document.body.classList.toggle('messenger-compact', isCompact);
      applyWidth(isCompact ? compactWidth : normalWidth);
    };

    const updateHandlePosition = () => {
      positionFrameId = null;
      if (!nav.isConnected) {
        handle.hidden = true;
        return;
      }

      handle.hidden = false;
      const rect = nav.getBoundingClientRect();
      handle.style.left = `${rect.right - 4}px`;
    };

    const scheduleHandlePosition = () => {
      if (positionFrameId === null) {
        positionFrameId = requestAnimationFrame(updateHandlePosition);
      }
    };

    const flushResize = () => {
      resizeFrameId = null;
      if (pendingWidth === null) return;
      applyWidth(pendingWidth);
      pendingWidth = null;
    };

    const scheduleResize = () => {
      if (resizeFrameId === null) resizeFrameId = requestAnimationFrame(flushResize);
    };

    const onPointerMove = (event) => {
      if (event.pointerId !== activePointerId) return;
      pendingWidth = clampWidth(startWidth + event.clientX - startX, startWidth);
      scheduleResize();
    };

    const finishResize = (event) => {
      if (!isDragging) return;
      if (event?.pointerId !== undefined && event.pointerId !== activePointerId) return;
      isDragging = false;

      if (resizeFrameId !== null) cancelAnimationFrame(resizeFrameId);
      resizeFrameId = null;
      if (pendingWidth !== null) flushResize();

      const finalWidth = clampWidth(
        Number.parseFloat(nav.style.getPropertyValue('--messenger-nav-width')),
        startWidth,
      );
      if (isCompact) compactWidth = finalWidth;
      else normalWidth = finalWidth;

      saveState(isCompact ? { compactWidth } : { navWidth: normalWidth });
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', finishResize);
      handle.removeEventListener('pointercancel', finishResize);
      handle.removeEventListener('lostpointercapture', finishResize);
      window.removeEventListener('blur', finishResize);
      if (activePointerId !== null && handle.hasPointerCapture(activePointerId)) {
        handle.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
      scheduleHandlePosition();
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      startX = event.clientX;
      startWidth = nav.getBoundingClientRect().width;
      pendingWidth = startWidth;
      isDragging = true;
      activePointerId = event.pointerId;
      handle.classList.add('active');
      document.body.classList.add('resizing');
      handle.setPointerCapture(activePointerId);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', finishResize);
      handle.addEventListener('pointercancel', finishResize);
      handle.addEventListener('lostpointercapture', finishResize);
      window.addEventListener('blur', finishResize);
    };

    const setCompact = (compact) => {
      if (compact === isCompact) return;
      isCompact = compact;
      saveState({ isCompact });
      applyCurrentMode();
      onCompactChange(isCompact);
      scheduleHandlePosition();
    };

    const onKeyDown = (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setCompact(!isCompact);
      }
    };

    const resizeObserver = new ResizeObserver(scheduleHandlePosition);
    resizeObserver.observe(nav);
    handle.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', scheduleHandlePosition, { passive: true });
    applyCurrentMode();
    scheduleHandlePosition();

    return {
      refreshHandlePosition: scheduleHandlePosition,
      cleanup() {
        if (isDragging) finishResize();
        resizeObserver.disconnect();
        if (resizeFrameId !== null) cancelAnimationFrame(resizeFrameId);
        if (positionFrameId !== null) cancelAnimationFrame(positionFrameId);
        handle.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', scheduleHandlePosition);
        handle.remove();
        nav.removeAttribute('data-messenger-app-nav');
        document.body.classList.remove('resizing');
      },
    };
  }

  function setupMenuToggle(saved, onLayoutChange) {
    let menuHidden = !!saved.menuHidden;
    document.body.classList.toggle('messenger-menu-hidden', menuHidden);

    const onKeyDown = (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        menuHidden = !menuHidden;
        saveState({ menuHidden });
        document.body.classList.toggle('messenger-menu-hidden', menuHidden);
        onLayoutChange();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }

  let activeNav = null;
  let cleanupActiveNav = null;
  let navSearchObserver = null;
  let navSearchTimer = null;

  const stopNavSearch = () => {
    if (navSearchObserver) navSearchObserver.disconnect();
    if (navSearchTimer !== null) clearTimeout(navSearchTimer);
    navSearchObserver = null;
    navSearchTimer = null;
  };

  const mountNav = (nav) => {
    stopNavSearch();
    if (cleanupActiveNav) cleanupActiveNav();

    activeNav = nav;
    const saved = loadState();
    const cleanupFullHeightLayout = setupFullHeightLayout(nav);
    const unreadDots = setupUnreadDots(nav, !!saved.isCompact);
    const resize = setupNavResize(nav, saved, (compact) => unreadDots.setCompact(compact));
    const cleanupMenuToggle = setupMenuToggle(saved, resize.refreshHandlePosition);

    const replacementObservers = [];
    const checkForReplacement = () => {
      if (activeNav === nav && !nav.isConnected) {
        cleanupActiveNav();
        cleanupActiveNav = null;
        activeNav = null;
        waitForNav();
      }
    };

    let ancestor = nav.parentNode;
    while (ancestor && ancestor !== document) {
      const observer = new MutationObserver(checkForReplacement);
      observer.observe(ancestor, { childList: true });
      replacementObservers.push(observer);
      ancestor = ancestor.parentNode;
    }

    cleanupActiveNav = () => {
      replacementObservers.forEach((observer) => observer.disconnect());
      cleanupFullHeightLayout();
      unreadDots.cleanup();
      resize.cleanup();
      cleanupMenuToggle();
    };
  };

  const tryMountNav = () => {
    navSearchTimer = null;
    const nav = findConversationList();
    if (nav) mountNav(nav);
  };

  const scheduleNavSearch = () => {
    if (navSearchTimer === null) {
      navSearchTimer = setTimeout(tryMountNav, NAV_SEARCH_DEBOUNCE_MS);
    }
  };

  function waitForNav() {
    stopNavSearch();

    const nav = findConversationList();
    if (nav) {
      mountNav(nav);
      return;
    }

    navSearchObserver = new MutationObserver(scheduleNavSearch);
    navSearchObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  waitForNav();
});
