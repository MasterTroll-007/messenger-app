'use strict';

const { ipcRenderer } = require('electron');

const SOUND_URL = 'messenger-asset://notification/sound';
const AUDIO_COALESCE_MS = 300;
const TITLE_BASELINE_CAPTURE_MS = 1500;
let notificationAudio = null;
let notificationAudioVersion = 0;
let playScheduled = false;
let lastAudioStart = -Infinity;
let audioActionGeneration = 0;

function getNotificationAudio() {
  if (!notificationAudio) {
    notificationAudio = new Audio(`${SOUND_URL}?v=${notificationAudioVersion}`);
    notificationAudio.preload = 'auto';
  }
  return notificationAudio;
}

function scheduleNotificationSound() {
  if (playScheduled || performance.now() - lastAudioStart < AUDIO_COALESCE_MS) return;
  playScheduled = true;
  const generation = audioActionGeneration;
  queueMicrotask(() => {
    if (generation !== audioActionGeneration) return;
    playScheduled = false;
    lastAudioStart = performance.now();
    const audio = getNotificationAudio();
    audio.currentTime = 0;
    void audio.play().catch(() => {
      // A missing/unsupported custom sound must never affect Messenger itself.
    });
  });
}

function stopNotificationSound() {
  audioActionGeneration += 1;
  playScheduled = false;
  if (!notificationAudio) return;
  notificationAudio.pause();
  notificationAudio.currentTime = 0;
}

function reloadNotificationAudio() {
  stopNotificationSound();
  if (notificationAudio) {
    notificationAudio.removeAttribute('src');
    notificationAudio.load();
    notificationAudio = null;
  }
  notificationAudioVersion += 1;
}

ipcRenderer.on('play-notification-sound', scheduleNotificationSound);
ipcRenderer.on('stop-notification-sound', stopNotificationSound);
ipcRenderer.on('notification-sound-updated', reloadNotificationAudio);

let latestTitleHint = { available: false, count: 0 };
let titleBaselineReady = false;
let titleBaselineTimer = null;
let notificationBaselineReady = false;
let notificationBaselineTimer = null;
let handleTitleHint = null;

function startNotificationBaselineCapture() {
  if (notificationBaselineReady || notificationBaselineTimer !== null) return;
  notificationBaselineTimer = setTimeout(() => {
    notificationBaselineTimer = null;
    notificationBaselineReady = true;
  }, TITLE_BASELINE_CAPTURE_MS);
}

ipcRenderer.on('title-unread-hint', (_event, rawHint) => {
  const available = rawHint?.available === true;
  const count = available
    && Number.isSafeInteger(rawHint.count)
    && rawHint.count >= 0
    && rawHint.count <= 9999
    ? rawHint.count
    : 0;
  const nextHint = { available, count };
  const previousCount = latestTitleHint.available ? latestTitleHint.count : 0;
  const notify = titleBaselineReady
    && available
    && count > previousCount;

  latestTitleHint = nextHint;
  if (!titleBaselineReady && titleBaselineTimer === null) {
    startNotificationBaselineCapture();
    // Capture startup hydration in one window anchored to the first value. Do
    // not restart this timer on every title change.
    titleBaselineTimer = setTimeout(() => {
      titleBaselineTimer = null;
      titleBaselineReady = true;
    }, TITLE_BASELINE_CAPTURE_MS);
  }
  if (handleTitleHint) handleTitleHint(notify);
});

window.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEY = 'messenger-layout';
  const VIEWPORT_INSET_PX = 5;
  const MIN_CHAT_WIDTH_PX = 280;
  const MAX_NAV_WIDTH_PX = 600;
  const MAX_TRACKED_THREADS = 500;
  const CROSS_SOURCE_NOTIFY_WINDOW_MS = 1000;
  const THREAD_LINK_SELECTOR = 'a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]';
  const EDITOR_SELECTOR = '[role="textbox"][contenteditable="true"]';
  const COMPACT_CONTROL_SELECTOR = [
    '[role="search"]',
    'input',
    'h1',
    '[aria-label="Facebook"]',
    '[aria-label="Nová zpráva"]',
    '[aria-label="New message"]',
  ].join(', ');
  const MENU_CONTROL_SELECTOR = [
    '[aria-label="Přepínač Doručených zpráv"]',
    '[aria-label="Inbox switcher"]',
  ].join(', ');
  const SCOPED_CONTROL_SELECTOR = `${COMPACT_CONTROL_SELECTOR}, ${MENU_CONTROL_SELECTOR}`;
  const MANAGED_STRUCTURE_ATTRIBUTES = new Set([
    'data-messenger-app-custom-width',
    'data-messenger-app-fill',
    'data-messenger-app-global-banner',
    'data-messenger-app-nav',
    'data-messenger-app-nav-collapsed',
    'data-messenger-app-relative-root',
    'data-messenger-app-thread-fill',
    'data-messenger-app-viewport-root',
  ]);
  const NAV_LABELS = new Set([
    'conversation list',
    'chat list',
    'seznam konverzací',
    'seznam konverzaci',
  ]);

  const loadState = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const saveState = (updates) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadState(), ...updates }));
    } catch {
      // Storage can be unavailable on login/checkpoint pages.
    }
  };

  const finiteWidth = (value, fallback) => {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.max(0, Math.min(MAX_NAV_WIDTH_PX, width))
      : fallback;
  };

  const viewportWidth = () => Math.max(0, window.visualViewport?.width || window.innerWidth || 0);
  const viewportHeight = () => Math.max(0, window.visualViewport?.height || window.innerHeight || 0);

  const style = document.createElement('style');
  style.id = 'messenger-app-styles';
  style.textContent = `
    [data-testid="cookie-policy-manage-dialog"],
    [data-messenger-app-global-banner] {
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

    [data-messenger-app-viewport-root] {
      box-sizing: border-box !important;
      top: var(--messenger-app-root-top, 0px) !important;
      bottom: auto !important;
      height: var(--messenger-app-viewport-height) !important;
      min-height: 0 !important;
      max-height: var(--messenger-app-viewport-height) !important;
      overflow: hidden !important;
    }
    [data-messenger-app-viewport-root][data-messenger-app-relative-root] {
      position: relative !important;
    }
    html.messenger-app-mounted,
    body.messenger-app-mounted {
      height: 100% !important;
      min-height: 0 !important;
      max-height: 100% !important;
      overflow: clip !important;
    }
    [data-messenger-app-fill] {
      box-sizing: border-box !important;
      height: 100% !important;
      min-height: 0 !important;
    }
    [data-messenger-app-thread-fill] {
      box-sizing: border-box !important;
      height: 100% !important;
      min-height: 0 !important;
      max-height: none !important;
    }

    [data-messenger-app-nav][data-messenger-app-custom-width] {
      width: var(--messenger-app-nav-width) !important;
      min-width: var(--messenger-app-nav-width) !important;
      max-width: var(--messenger-app-nav-width) !important;
    }
    [data-messenger-app-nav][data-messenger-app-nav-collapsed] {
      overflow: hidden !important;
    }

    [data-messenger-app-resize-handle] {
      position: fixed;
      top: 0;
      width: 8px;
      height: var(--messenger-app-viewport-height, 100vh);
      cursor: col-resize;
      z-index: 2147483646;
      background: transparent;
      transition: background 0.15s;
      touch-action: none;
    }
    [data-messenger-app-resize-handle]:hover,
    [data-messenger-app-resize-handle][data-active] {
      background: rgba(0, 149, 246, 0.4);
    }
    body.messenger-app-resizing,
    body.messenger-app-resizing * {
      cursor: col-resize !important;
      user-select: none !important;
    }

    body.messenger-app-compact [data-messenger-app-nav] {
      overflow-x: hidden !important;
    }
    body.messenger-app-compact [data-messenger-app-compact-hide],
    body.messenger-app-menu-hidden [data-messenger-app-menu] {
      display: none !important;
    }
    body.messenger-app-compact [data-messenger-app-compact-text] {
      font-size: 0 !important;
      line-height: 0 !important;
      max-width: 0 !important;
      overflow: hidden !important;
    }
    body.messenger-app-compact [data-messenger-app-unread] {
      position: relative !important;
    }
    body.messenger-app-compact [data-messenger-app-unread]::after {
      content: '';
      position: absolute;
      top: 4px;
      right: 4px;
      width: 12px;
      height: 12px;
      background: #ff3b30;
      border: 2px solid #242526;
      border-radius: 50%;
      pointer-events: none;
      z-index: 10;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const normalizeText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const isElementStructurallyShown = (element) => {
    if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
      return false;
    }
    for (let node = element; node; node = node.parentElement) {
      const computed = getComputedStyle(node);
      if (computed.display === 'none'
        || computed.visibility === 'hidden'
        || computed.visibility === 'collapse') {
        return false;
      }
      if (node === document.body) break;
    }
    return true;
  };

  const isElementVisible = (element, { allowZeroWidth = false } = {}) => {
    if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if ((!allowZeroWidth && rect.width <= 1) || rect.height <= 1) return false;
    const width = viewportWidth();
    const height = viewportHeight();
    if (rect.bottom <= 0 || rect.top >= height) return false;
    if (allowZeroWidth ? rect.right < 0 || rect.left > width : rect.right <= 0 || rect.left >= width) {
      return false;
    }
    const computed = getComputedStyle(element);
    return computed.display !== 'none'
      && computed.visibility !== 'hidden'
      && computed.visibility !== 'collapse';
  };

  const threadIdentity = (link) => {
    const href = link?.getAttribute('href');
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      const match = /^\/messages\/(?:e2ee\/)?t\/([^/?#]+)/.exec(url.pathname);
      return match ? decodeURIComponent(match[1]).slice(0, 256) : null;
    } catch {
      return null;
    }
  };

  function findVisibleConversationList() {
    const candidates = new Set();
    document.querySelectorAll('[aria-label], [role="navigation"]').forEach((candidate) => {
      const label = normalizeText(candidate.getAttribute('aria-label'));
      if (NAV_LABELS.has(label) || candidate.querySelector(THREAD_LINK_SELECTOR)) {
        candidates.add(candidate);
      }
    });

    let best = null;
    let bestScore = -Infinity;
    candidates.forEach((candidate) => {
      const allowCollapsedActive = candidate === activeNav
        && candidate.hasAttribute('data-messenger-app-nav-collapsed');
      if (!isElementVisible(candidate, { allowZeroWidth: allowCollapsedActive })) return;
      const rect = candidate.getBoundingClientRect();
      const linkCount = candidate.querySelectorAll(THREAD_LINK_SELECTOR).length;
      const labelled = NAV_LABELS.has(normalizeText(candidate.getAttribute('aria-label')));
      const roleNavigation = candidate.getAttribute('role') === 'navigation';
      const score = (labelled ? 100000 : 0)
        + (roleNavigation ? 10000 : 0)
        + Math.min(linkCount, 100) * 100
        + Math.min(rect.width * rect.height, 1000000) / 1000;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    return best;
  }

  function findVisibleMain(nav) {
    let best = null;
    let bestScore = -Infinity;
    document.querySelectorAll('[role="main"]').forEach((candidate) => {
      if (!isElementVisible(candidate) || candidate.contains(nav)) return;
      const rect = candidate.getBoundingClientRect();
      const editors = Array.from(candidate.querySelectorAll(EDITOR_SELECTOR))
        .filter(isElementVisible).length;
      const score = editors * 1000000
        + Math.min(rect.width * rect.height, 4000000) / 1000
        + (rect.left >= nav.getBoundingClientRect().left ? 1000 : 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    return best;
  }

  function lowestCommonAncestor(first, second) {
    const ancestors = new Set();
    for (let node = first; node; node = node.parentElement) ancestors.add(node);
    for (let node = second; node; node = node.parentElement) {
      if (ancestors.has(node)) return node;
    }
    return document.body;
  }

  const managedLayout = {
    viewportRoot: null,
    viewportRootNeedsRelativeOffset: false,
    fillNodes: new Set(),
    threadNodes: new Set(),
    banners: new Set(),
  };
  const pageConstraintBackups = new Map();
  const PAGE_CONSTRAINTS = new Map([
    ['height', '100%'],
    ['min-height', '0'],
    ['max-height', '100%'],
    ['overflow-x', 'clip'],
    ['overflow-y', 'clip'],
  ]);

  const applyPageConstraints = () => {
    for (const node of [document.documentElement, document.body]) {
      if (!pageConstraintBackups.has(node)) {
        const backup = new Map();
        PAGE_CONSTRAINTS.forEach((_value, property) => {
          backup.set(property, {
            value: node.style.getPropertyValue(property),
            priority: node.style.getPropertyPriority(property),
          });
        });
        pageConstraintBackups.set(node, backup);
      }
      PAGE_CONSTRAINTS.forEach((value, property) => {
        if (node.style.getPropertyValue(property) !== value
          || node.style.getPropertyPriority(property) !== 'important') {
          node.style.setProperty(property, value, 'important');
        }
      });
      if (node.scrollTop !== 0) node.scrollTop = 0;
      if (node.scrollLeft !== 0) node.scrollLeft = 0;
    }
    const scrollingElement = document.scrollingElement;
    if (scrollingElement?.scrollTop) scrollingElement.scrollTop = 0;
    if (scrollingElement?.scrollLeft) scrollingElement.scrollLeft = 0;
  };

  const clearPageConstraints = () => {
    pageConstraintBackups.forEach((backup, node) => {
      backup.forEach(({ value, priority }, property) => {
        if (value) node.style.setProperty(property, value, priority);
        else node.style.removeProperty(property);
      });
    });
    pageConstraintBackups.clear();
  };

  const replaceManagedSet = (current, next, attribute) => {
    current.forEach((node) => {
      if (!next.has(node)) node.removeAttribute(attribute);
    });
    next.forEach((node) => node.setAttribute(attribute, ''));
    current.clear();
    next.forEach((node) => current.add(node));
  };

  const clearManagedLayout = () => {
    if (managedLayout.viewportRoot) {
      managedLayout.viewportRoot.removeAttribute('data-messenger-app-viewport-root');
      managedLayout.viewportRoot.removeAttribute('data-messenger-app-relative-root');
      managedLayout.viewportRoot.style.removeProperty('--messenger-app-viewport-height');
      managedLayout.viewportRoot.style.removeProperty('--messenger-app-root-top');
    }
    managedLayout.viewportRoot = null;
    managedLayout.viewportRootNeedsRelativeOffset = false;
    replaceManagedSet(managedLayout.fillNodes, new Set(), 'data-messenger-app-fill');
    replaceManagedSet(managedLayout.threadNodes, new Set(), 'data-messenger-app-thread-fill');
    replaceManagedSet(managedLayout.banners, new Set(), 'data-messenger-app-global-banner');
  };

  function findGlobalBanners(nav, main) {
    const next = new Set();
    managedLayout.banners.forEach((banner) => {
      if (banner.isConnected && !banner.contains(nav) && !banner.contains(main)) next.add(banner);
    });

    const facebookNavigation = Array.from(document.querySelectorAll('[role="navigation"][aria-label]'))
      .find((candidate) => (
        normalizeText(candidate.getAttribute('aria-label')) === 'facebook'
        && !candidate.contains(nav)
        && !candidate.contains(main)
        && !nav.contains(candidate)
        && !main.contains(candidate)
      ));
    if (facebookNavigation) {
      next.add(facebookNavigation.closest('[role="banner"]') || facebookNavigation);
    }

    document.querySelectorAll('[role="banner"]').forEach((banner) => {
      if (banner.contains(nav) || banner.contains(main) || nav.contains(banner) || main.contains(banner)) return;
      const rect = banner.getBoundingClientRect();
      if (isElementVisible(banner)
        && rect.top <= 12
        && rect.height >= 24
        && rect.height <= 160
        && rect.width >= viewportWidth() * 0.45) {
        next.add(banner);
      }
    });
    return next;
  }

  function findVisibleEditor(main) {
    let best = null;
    let bestScore = -Infinity;
    main.querySelectorAll(EDITOR_SELECTOR).forEach((editor) => {
      if (!isElementVisible(editor)) return;
      const rect = editor.getBoundingClientRect();
      const score = rect.width * 10 + rect.bottom;
      if (rect.width > 100 && score > bestScore) {
        best = editor;
        bestScore = score;
      }
    });
    return best;
  }

  function findThreadFillNodes(main) {
    const editor = findVisibleEditor(main);
    if (!editor) return new Set();

    const minimumHeight = viewportHeight() * 0.35;
    let region = null;
    let regionArea = -1;
    main.querySelectorAll('[role="region"]').forEach((candidate) => {
      if (!candidate.contains(editor) || !isElementVisible(candidate)) return;
      const rect = candidate.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.height >= minimumHeight && area > regionArea) {
        region = candidate;
        regionArea = area;
      }
    });

    const boundary = region || main;
    const next = new Set();
    for (let node = editor.parentElement; node && main.contains(node); node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (node === boundary || rect.height >= minimumHeight) next.add(node);
      if (node === boundary || node === main) break;
    }
    if (region) next.add(region);
    return next;
  }

  function applyManagedLayout(nav, main) {
    const root = lowestCommonAncestor(nav, main) || document.body;
    const height = Math.max(0, viewportHeight() - VIEWPORT_INSET_PX);

    if (managedLayout.viewportRoot && managedLayout.viewportRoot !== root) {
      managedLayout.viewportRoot.removeAttribute('data-messenger-app-viewport-root');
      managedLayout.viewportRoot.removeAttribute('data-messenger-app-relative-root');
      managedLayout.viewportRoot.style.removeProperty('--messenger-app-viewport-height');
      managedLayout.viewportRoot.style.removeProperty('--messenger-app-root-top');
    }
    managedLayout.viewportRoot = root;

    // Temporarily expose the host page's native positioning, then apply a
    // stable offset. This handles both absolute shells with top:56px and
    // relatively positioned Meta shells whose normal flow shifts after the
    // global header is hidden.
    root.removeAttribute('data-messenger-app-viewport-root');
    root.removeAttribute('data-messenger-app-relative-root');
    const nativePosition = getComputedStyle(root).position;
    const nativeTop = root.getBoundingClientRect().top;
    root.setAttribute('data-messenger-app-viewport-root', '');
    const needsRelativeOffset = nativePosition === 'static' || nativePosition === 'relative';
    managedLayout.viewportRootNeedsRelativeOffset = needsRelativeOffset;
    root.toggleAttribute('data-messenger-app-relative-root', needsRelativeOffset);
    const rootTopValue = needsRelativeOffset ? `${-nativeTop}px` : '0px';
    if (root.style.getPropertyValue('--messenger-app-root-top') !== rootTopValue) {
      root.style.setProperty('--messenger-app-root-top', rootTopValue);
    }
    const heightValue = `${height}px`;
    if (root.style.getPropertyValue('--messenger-app-viewport-height') !== heightValue) {
      root.style.setProperty('--messenger-app-viewport-height', heightValue);
    }

    const fillNodes = new Set();
    for (const endpoint of [nav, main]) {
      for (let node = endpoint; node && node !== root; node = node.parentElement) {
        fillNodes.add(node);
      }
    }
    replaceManagedSet(managedLayout.fillNodes, fillNodes, 'data-messenger-app-fill');
    // Measure native Meta geometry, not the geometry produced by our previous
    // height override. Attribute removal/reapply occurs in one task, before paint.
    managedLayout.threadNodes.forEach((node) => {
      node.removeAttribute('data-messenger-app-thread-fill');
    });
    replaceManagedSet(managedLayout.threadNodes, findThreadFillNodes(main), 'data-messenger-app-thread-fill');
    replaceManagedSet(
      managedLayout.banners,
      findGlobalBanners(nav, main),
      'data-messenger-app-global-banner',
    );
  }

  function rowHasUnread(link) {
    const candidates = [link, ...link.querySelectorAll('[aria-label], [data-testid], [data-unread]')];
    for (const candidate of candidates.slice(0, 96)) {
      if (candidate.getAttribute('data-unread') === 'true') return true;
      const testId = normalizeText(candidate.getAttribute('data-testid')).replace(/[-_]+/g, ' ');
      const label = normalizeText(candidate.getAttribute('aria-label'));
      const semantics = `${testId} ${label}`.trim();
      if (semantics.includes('mark unread')
        || semantics.includes('mark as unread')
        || semantics.includes('oznacit jako neprectene')) {
        continue;
      }
      if (/(^| )unread($| )/.test(testId)) return true;
      if (!label) continue;
      if (label.includes('mark as read')
        || label.includes('oznacit jako prectene')
        || /(^|\b)unread(?: message)?(\b|$)/.test(label)
        || label.includes('neprectena zprava')
        || label.includes('neprectene zpravy')) {
        return true;
      }
    }
    return false;
  }

  const isVolatileRowText = (text) => {
    const normalized = normalizeText(text);
    return !normalized
      || /^(?:now|ted|today|dnes|yesterday|vcera)$/.test(normalized)
      || /^(?:\d{1,2}:\d{2}|(?:pred\s+)?\d+\s*(?:s|sec|m|min|h|hr|d|day|days|w|week|weeks|tyd|hod)(?:\s+(?:ago|zpet))?)$/.test(normalized)
      || /^(?:active|aktivni|aktivni pred)\b/.test(normalized)
      || /^(?:.{1,80}\s+)?(?:(?:is|are)\s+typing|typing|pise|pisou)(?:\s*(?:\.{3}|…))?$/.test(normalized)
      || /^(?:sent|seen|delivered|odeslano|zobrazeno|doruceno)$/.test(normalized)
      || /^(?:mark|oznacit)\b.*(?:read|precten)/.test(normalized);
  };

  function rowSignature(link) {
    const parts = [];
    link.querySelectorAll('[dir="auto"]').forEach((node) => {
      if (node.querySelector('[dir="auto"]')) return;
      const text = normalizeText(node.textContent);
      if (text && !isVolatileRowText(text)) parts.push(text);
    });

    if (parts.length === 0) {
      const linkLabel = link.getAttribute('aria-label');
      const text = normalizeText(linkLabel || link.innerText || link.textContent);
      if (text) parts.push(text);
    }
    return parts.join('\u001f').slice(0, 1024);
  }

  function markCompactRow(link) {
    link.querySelectorAll('[dir="auto"]').forEach((node) => {
      if (!node.querySelector('img, svg')) node.setAttribute('data-messenger-app-compact-text', '');
    });
  }

  function setupUnreadTracker(nav, onSnapshot) {
    const threadState = new Map();
    const linkIdentity = new WeakMap();
    const dirtyIds = new Set();
    const notificationEligibleIds = new Set();
    const pendingNotifications = new Map();
    const identityRefreshState = new WeakMap();
    const identityRefreshStates = new Set();
    const SIGNATURE_STABILITY_MS = 180;
    const IDENTITY_REFRESH_QUIET_MS = 750;
    let flushScheduled = false;
    let disposed = false;
    let lastReportedCount = null;

    const currentCount = () => {
      let count = 0;
      threadState.forEach((state) => {
        if (state.unread) count += 1;
      });
      return Math.min(count, 9999);
    };

    const touchState = (id, value) => {
      threadState.delete(id);
      threadState.set(id, value);
      while (threadState.size > MAX_TRACKED_THREADS) {
        const evictedId = threadState.keys().next().value;
        const pending = pendingNotifications.get(evictedId);
        if (pending) clearTimeout(pending.timer);
        pendingNotifications.delete(evictedId);
        threadState.delete(evictedId);
      }
    };

    const cancelPendingNotification = (id) => {
      const pending = pendingNotifications.get(id);
      if (pending) clearTimeout(pending.timer);
      pendingNotifications.delete(id);
    };

    const signatureIsSubstantive = (signature) => signature.includes('\u001f');

    const scheduleStableNotification = (id, signature) => {
      cancelPendingNotification(id);
      const timer = setTimeout(() => {
        pendingNotifications.delete(id);
        const current = threadState.get(id);
        if (!current?.unread || current.signature !== signature) return;
        onSnapshot({ count: currentCount(), notify: true });
      }, SIGNATURE_STABILITY_MS);
      pendingNotifications.set(id, { signature, timer });
    };

    const markDirty = (id, { notificationEligible = false } = {}) => {
      if (!id) return;
      dirtyIds.add(id);
      if (notificationEligible) notificationEligibleIds.add(id);
    };

    const rememberLink = (link, reasons) => {
      if (!(link instanceof Element) || !link.matches(THREAD_LINK_SELECTOR)) return;
      const previousId = linkIdentity.get(link);
      const nextId = threadIdentity(link);
      if (previousId) markDirty(previousId, reasons);
      if (nextId) {
        markDirty(nextId, reasons);
        linkIdentity.set(link, nextId);
      } else {
        linkIdentity.delete(link);
      }
    };

    const collectLinks = (node, includeDescendants, reasons) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!element) return;
      const closest = element.closest?.(THREAD_LINK_SELECTOR);
      if (closest && nav.contains(closest)) rememberLink(closest, reasons);
      if (includeDescendants && element.querySelectorAll) {
        if (element.matches?.(THREAD_LINK_SELECTOR)) rememberLink(element, reasons);
        element.querySelectorAll(THREAD_LINK_SELECTOR).forEach((link) => rememberLink(link, reasons));
      }
    };

    const markRemovedLinks = (node) => {
      if (node?.nodeType !== Node.ELEMENT_NODE) return;
      const links = [];
      if (node.matches?.(THREAD_LINK_SELECTOR)) links.push(node);
      node.querySelectorAll?.(THREAD_LINK_SELECTOR).forEach((link) => links.push(link));
      links.forEach((link) => {
        const id = linkIdentity.get(link) || threadIdentity(link);
        if (id) markDirty(id);
      });
    };

    const flush = () => {
      flushScheduled = false;
      if (disposed) return;
      const groups = new Map();
      nav.querySelectorAll(THREAD_LINK_SELECTOR).forEach((link) => {
        const id = threadIdentity(link);
        if (!id) return;
        linkIdentity.set(link, id);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(link);
      });

      for (const id of dirtyIds) {
        const allLinks = groups.get(id);
        if (!allLinks?.length) {
          cancelPendingNotification(id);
          continue;
        }
        const visibleLinks = allLinks.filter(isElementVisible);
        const links = visibleLinks.length > 0 ? visibleLinks : allLinks;
        const unreadLinks = links.filter(rowHasUnread);
        allLinks.forEach((link) => {
          const unread = rowHasUnread(link);
          link.toggleAttribute('data-messenger-app-unread', unread);
          markCompactRow(link);
        });

        const unread = unreadLinks.length > 0;
        const signature = unread
          ? [...new Set(unreadLinks.map(rowSignature).filter(Boolean))].sort().join('\u001e').slice(0, 2048)
          : '';
        const previous = threadState.get(id);
        const notificationEligible = notificationEligibleIds.has(id);
        const substantiveSignature = unread && signatureIsSubstantive(signature);
        let stable = !unread || substantiveSignature;
        let pendingUnreadTransition = false;
        if (previous) {
          if (!unread) {
            cancelPendingNotification(id);
          } else if (!previous.unread && notificationEligible) {
            pendingUnreadTransition = true;
            if (substantiveSignature) {
              scheduleStableNotification(id, signature);
              pendingUnreadTransition = false;
            }
          } else if (previous.unread && unread) {
            pendingUnreadTransition = previous.pendingUnreadTransition === true;
            const changedSignature = previous.signature
              && signature
              && previous.signature !== signature;
            if (!previous.stable) {
              if (substantiveSignature) {
                // The first complete preview after an initial skeleton is part
                // of baseline hydration. Only a prior read->unread transition
                // may turn it into a notification.
                if (pendingUnreadTransition) scheduleStableNotification(id, signature);
                pendingUnreadTransition = false;
              } else {
                cancelPendingNotification(id);
              }
            } else if (changedSignature && notificationEligible && substantiveSignature) {
              scheduleStableNotification(id, signature);
            } else if (changedSignature && !substantiveSignature) {
              // Ignore temporary name-only/empty hydration states and wait for
              // the final preview before deciding.
              cancelPendingNotification(id);
            }
            stable = previous.stable || substantiveSignature;
          }
        }
        touchState(id, {
          unread,
          signature,
          stable,
          pendingUnreadTransition,
        });
      }
      dirtyIds.clear();
      notificationEligibleIds.clear();

      const count = currentCount();
      if (count !== lastReportedCount) {
        lastReportedCount = count;
        onSnapshot({ count, notify: false });
      }
    };

    const scheduleFlush = () => {
      if (flushScheduled || dirtyIds.size === 0) return;
      flushScheduled = true;
      queueMicrotask(flush);
    };

    const refreshIdentityHydration = (link) => {
      let state = identityRefreshState.get(link);
      if (!state) {
        state = { active: true, timer: null };
        identityRefreshState.set(link, state);
        identityRefreshStates.add(state);
      }
      state.active = true;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.active = false;
        state.timer = null;
        identityRefreshStates.delete(state);
        identityRefreshState.delete(link);
      }, IDENTITY_REFRESH_QUIET_MS);
    };

    const closestTrackedAnchor = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const anchor = element?.tagName === 'A' ? element : element?.closest?.('a');
      return anchor && nav.contains(anchor) ? anchor : null;
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'href') continue;
        const link = closestTrackedAnchor(mutation.target);
        if (!link) continue;
        const previousId = linkIdentity.get(link);
        const nextId = threadIdentity(link);
        if (!previousId && !nextId) continue;
        refreshIdentityHydration(link);
        if (previousId) {
          cancelPendingNotification(previousId);
          markDirty(previousId);
        }
        if (nextId) {
          cancelPendingNotification(nextId);
          markDirty(nextId);
        } else {
          linkIdentity.delete(link);
        }
      }

      const isIdentityRefreshMutation = (mutation) => {
        const link = closestTrackedAnchor(mutation.target);
        const state = link ? identityRefreshState.get(link) : null;
        if (!state?.active) return false;
        refreshIdentityHydration(link);
        return true;
      };

      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const visibilityOnly = ['aria-hidden', 'class', 'hidden', 'style'].includes(mutation.attributeName);
          collectLinks(
            mutation.target,
            visibilityOnly && mutation.target !== nav,
            { notificationEligible: !visibilityOnly && !isIdentityRefreshMutation(mutation) },
          );
        } else if (mutation.type === 'characterData') {
          collectLinks(mutation.target, false, {
            notificationEligible: !isIdentityRefreshMutation(mutation),
          });
        } else if (mutation.type === 'childList') {
          collectLinks(mutation.target, false, {
            notificationEligible: !isIdentityRefreshMutation(mutation),
          });
          mutation.addedNodes.forEach((node) => {
            collectLinks(node, true, { notificationEligible: false });
          });
          mutation.removedNodes.forEach(markRemovedLinks);
        }
      }
      scheduleFlush();
    });

    observer.observe(nav, {
      attributes: true,
      attributeFilter: [
        'aria-hidden',
        'aria-label',
        'class',
        'data-testid',
        'data-unread',
        'hidden',
        'href',
        'style',
      ],
      childList: true,
      characterData: true,
      subtree: true,
    });

    nav.querySelectorAll(THREAD_LINK_SELECTOR).forEach((link) => rememberLink(link));
    flush();

    return {
      cleanup() {
        disposed = true;
        observer.disconnect();
        nav.querySelectorAll('[data-messenger-app-unread]').forEach((node) => {
          node.removeAttribute('data-messenger-app-unread');
        });
        nav.querySelectorAll('[data-messenger-app-compact-text]').forEach((node) => {
          node.removeAttribute('data-messenger-app-compact-text');
        });
        dirtyIds.clear();
        notificationEligibleIds.clear();
        pendingNotifications.forEach(({ timer }) => clearTimeout(timer));
        pendingNotifications.clear();
        identityRefreshStates.forEach(({ timer }) => {
          if (timer !== null) clearTimeout(timer);
        });
        identityRefreshStates.clear();
        threadState.clear();
      },
    };
  }

  function markScopedNavControls(nav) {
    const syncAttribute = (selector, attribute) => {
      const desired = new Set(nav.querySelectorAll(selector));
      nav.querySelectorAll(`[${attribute}]`).forEach((node) => {
        if (!desired.has(node)) node.removeAttribute(attribute);
      });
      desired.forEach((node) => {
        if (!node.hasAttribute(attribute)) node.setAttribute(attribute, '');
      });
    };
    syncAttribute(COMPACT_CONTROL_SELECTOR, 'data-messenger-app-compact-hide');
    syncAttribute(MENU_CONTROL_SELECTOR, 'data-messenger-app-menu');
  }

  function setupNavControls(nav, saved, onLayoutChange) {
    nav.setAttribute('data-messenger-app-nav', '');
    markScopedNavControls(nav);

    const measuredWidth = Math.max(0, nav.getBoundingClientRect().width);
    let isCompact = saved.isCompact === true;
    let menuHidden = saved.menuHidden === true;
    let normalPreferred = finiteWidth(
      saved.navWidth,
      measuredWidth >= 48 ? finiteWidth(measuredWidth, 320) : 320,
    );
    let compactPreferred = finiteWidth(saved.compactWidth, 108);
    let activePointerId = null;
    let isDragging = false;
    let startX = 0;
    let startPreferred = 0;
    let startAppliedWidth = 0;
    let pendingPreferred = null;
    let dragChanged = false;
    let resizeFrameId = null;
    let positionFrameId = null;

    const handle = document.createElement('div');
    handle.setAttribute('data-messenger-app-resize-handle', '');
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Změnit šířku seznamu konverzací');
    document.body.appendChild(handle);

    const maxAllowedWidth = () => Math.max(
      0,
      Math.min(MAX_NAV_WIDTH_PX, viewportWidth() - MIN_CHAT_WIDTH_PX),
    );

    const currentPreferred = () => (isCompact ? compactPreferred : normalPreferred);

    const applyPreferredWidth = (preferred = currentPreferred()) => {
      const actual = Math.max(0, Math.min(maxAllowedWidth(), preferred));
      const widthValue = `${actual}px`;
      if (nav.style.getPropertyValue('--messenger-app-nav-width') !== widthValue) {
        nav.style.setProperty('--messenger-app-nav-width', widthValue);
      }
      nav.setAttribute('data-messenger-app-custom-width', '');
      nav.toggleAttribute('data-messenger-app-nav-collapsed', actual < 10);
      return actual;
    };

    const updateHandlePosition = () => {
      positionFrameId = null;
      if (!nav.isConnected || !isElementVisible(nav, { allowZeroWidth: true })) {
        handle.hidden = true;
        return;
      }
      handle.hidden = false;
      const rect = nav.getBoundingClientRect();
      const left = Math.max(0, Math.min(viewportWidth() - 8, rect.right - 4));
      handle.style.left = `${left}px`;
      handle.style.setProperty('--messenger-app-viewport-height', `${Math.max(0, viewportHeight() - VIEWPORT_INSET_PX)}px`);
    };

    const scheduleHandlePosition = () => {
      if (positionFrameId === null) positionFrameId = requestAnimationFrame(updateHandlePosition);
    };

    const applyMode = () => {
      document.body.classList.toggle('messenger-app-compact', isCompact);
      document.body.classList.toggle('messenger-app-menu-hidden', menuHidden);
      applyPreferredWidth();
      scheduleHandlePosition();
    };

    const flushResize = () => {
      resizeFrameId = null;
      if (pendingPreferred === null) return;
      applyPreferredWidth(pendingPreferred);
      pendingPreferred = null;
      scheduleHandlePosition();
    };

    const onPointerMove = (event) => {
      if (!isDragging || event.pointerId !== activePointerId) return;
      dragChanged = true;
      pendingPreferred = finiteWidth(startPreferred + event.clientX - startX, startPreferred);
      if (resizeFrameId === null) resizeFrameId = requestAnimationFrame(flushResize);
    };

    const finishResize = (event) => {
      if (!isDragging) return;
      if (event?.pointerId !== undefined && event.pointerId !== activePointerId) return;
      if (resizeFrameId !== null) cancelAnimationFrame(resizeFrameId);
      resizeFrameId = null;
      if (pendingPreferred !== null) flushResize();

      if (dragChanged) {
        const applied = finiteWidth(
          Number.parseFloat(nav.style.getPropertyValue('--messenger-app-nav-width')),
          currentPreferred(),
        );
        if (Math.abs(applied - startAppliedWidth) > 0.5) {
          if (isCompact) compactPreferred = applied;
          else normalPreferred = applied;
          saveState(isCompact ? { compactWidth: compactPreferred } : { navWidth: normalPreferred });
        } else {
          applyPreferredWidth();
        }
      }

      isDragging = false;
      handle.removeAttribute('data-active');
      document.body.classList.remove('messenger-app-resizing');
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
      startAppliedWidth = nav.getBoundingClientRect().width;
      startPreferred = startAppliedWidth;
      pendingPreferred = null;
      dragChanged = false;
      isDragging = true;
      activePointerId = event.pointerId;
      handle.setAttribute('data-active', '');
      document.body.classList.add('messenger-app-resizing');
      handle.setPointerCapture(activePointerId);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', finishResize);
      handle.addEventListener('pointercancel', finishResize);
      handle.addEventListener('lostpointercapture', finishResize);
      window.addEventListener('blur', finishResize);
    };

    const onKeyDown = (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        isCompact = !isCompact;
        saveState({ isCompact });
        applyMode();
        onLayoutChange();
      } else if (key === 'm' && !event.shiftKey) {
        event.preventDefault();
        menuHidden = !menuHidden;
        saveState({ menuHidden });
        applyMode();
        onLayoutChange();
      }
    };

    const resizeObserver = new ResizeObserver(scheduleHandlePosition);
    const controlObserver = new MutationObserver((mutations) => {
      const containsControlCandidate = (node) => node?.nodeType === Node.ELEMENT_NODE
        && (node.matches(SCOPED_CONTROL_SELECTOR)
          || node.querySelector?.(SCOPED_CONTROL_SELECTOR));
      let needsRefresh = false;
      for (const mutation of mutations) {
        const target = mutation.target.nodeType === Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target.parentElement;
        if (mutation.type === 'attributes') {
          if (mutation.attributeName === 'data-messenger-app-compact-hide') {
            if (target.matches(COMPACT_CONTROL_SELECTOR)
              && !target.hasAttribute('data-messenger-app-compact-hide')) {
              needsRefresh = true;
              break;
            }
            continue;
          }
          if (mutation.attributeName === 'data-messenger-app-menu') {
            if (target.matches(MENU_CONTROL_SELECTOR)
              && !target.hasAttribute('data-messenger-app-menu')) {
              needsRefresh = true;
              break;
            }
            continue;
          }
          if (target.matches(SCOPED_CONTROL_SELECTOR)
            || target.hasAttribute('data-messenger-app-compact-hide')
            || target.hasAttribute('data-messenger-app-menu')) {
            needsRefresh = true;
            break;
          }
        } else if (target?.matches?.(SCOPED_CONTROL_SELECTOR)
          || [...mutation.addedNodes, ...mutation.removedNodes].some(containsControlCandidate)) {
          needsRefresh = true;
          break;
        }
      }
      if (needsRefresh) markScopedNavControls(nav);
    });
    resizeObserver.observe(nav);
    controlObserver.observe(nav, {
      attributes: true,
      attributeFilter: [
        'aria-label',
        'data-messenger-app-compact-hide',
        'data-messenger-app-menu',
        'role',
      ],
      childList: true,
      subtree: true,
    });
    handle.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    applyMode();

    return {
      refresh() {
        if (!nav.hasAttribute('data-messenger-app-nav')) {
          nav.setAttribute('data-messenger-app-nav', '');
        }
        markScopedNavControls(nav);
        applyPreferredWidth();
        scheduleHandlePosition();
      },
      cleanup() {
        if (isDragging) finishResize();
        resizeObserver.disconnect();
        controlObserver.disconnect();
        if (resizeFrameId !== null) cancelAnimationFrame(resizeFrameId);
        if (positionFrameId !== null) cancelAnimationFrame(positionFrameId);
        handle.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
        handle.remove();
        nav.style.removeProperty('--messenger-app-nav-width');
        nav.removeAttribute('data-messenger-app-nav');
        nav.removeAttribute('data-messenger-app-custom-width');
        nav.removeAttribute('data-messenger-app-nav-collapsed');
        nav.querySelectorAll('[data-messenger-app-compact-hide], [data-messenger-app-menu]').forEach((node) => {
          node.removeAttribute('data-messenger-app-compact-hide');
          node.removeAttribute('data-messenger-app-menu');
        });
        document.body.classList.remove('messenger-app-resizing');
      },
    };
  }

  let domSnapshot = null;
  let lastPublishedCount = null;
  let lastBadgeCount = null;
  let lastBadgeDataUrl = null;
  let lastNotifyAt = 0;
  let lastNotifySource = null;

  function createBadgeDataUrl(count) {
    if (count === lastBadgeCount) return lastBadgeDataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.fillStyle = '#cc0000';
    context.beginPath();
    context.arc(24, 24, 24, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(24, 24, 23, 0, Math.PI * 2);
    context.stroke();
    const text = count > 99 ? '99+' : String(count);
    context.fillStyle = '#ffffff';
    context.font = `bold ${text.length > 2 ? 16 : text.length > 1 ? 22 : 28}px Arial`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 24, 25);

    lastBadgeCount = count;
    lastBadgeDataUrl = canvas.toDataURL('image/png');
    return lastBadgeDataUrl;
  }

  function publishCanonicalState(notify = false, source = 'structure') {
    const count = latestTitleHint.available
      ? latestTitleHint.count
      : (domSnapshot?.count || 0);
    const now = performance.now();
    if (notify && !notificationBaselineReady) notify = false;
    if (notify
      && lastNotifySource
      && lastNotifySource !== source
      && now - lastNotifyAt < CROSS_SOURCE_NOTIFY_WINDOW_MS) {
      notify = false;
    }

    if (!notify && count === lastPublishedCount) return;
    const badgeDataUrl = count > 0 ? createBadgeDataUrl(count) : null;
    ipcRenderer.send('publish-unread-state', { count, notify, badgeDataUrl });
    lastPublishedCount = count;
    if (notify) {
      lastNotifyAt = now;
      lastNotifySource = source;
    }
  }

  handleTitleHint = (notify) => publishCanonicalState(notify, 'title');

  let activeNav = null;
  let activeMain = null;
  let unreadTracker = null;
  let navControls = null;
  let structureTimerId = null;

  const unmountNav = (publishFallback = true) => {
    unreadTracker?.cleanup();
    navControls?.cleanup();
    unreadTracker = null;
    navControls = null;
    activeNav = null;
    domSnapshot = null;
    if (publishFallback) publishCanonicalState(false, 'structure');
  };

  const scheduleStructure = () => {
    if (structureTimerId !== null) return;
    structureTimerId = setTimeout(() => {
      structureTimerId = null;
      reconcileStructureWithoutFeedback();
    }, 0);
  };

  const mountNav = (nav) => {
    activeNav = nav;
    const saved = loadState();
    navControls = setupNavControls(nav, saved, scheduleStructure);
    unreadTracker = setupUnreadTracker(nav, (snapshot) => {
      startNotificationBaselineCapture();
      domSnapshot = snapshot;
      publishCanonicalState(snapshot.notify, 'dom');
    });
  };

  function reconcileStructure() {
    let nextNav = findVisibleConversationList();
    if (!nextNav && isElementStructurallyShown(activeNav)) nextNav = activeNav;
    let nextMain = nextNav ? findVisibleMain(nextNav) : null;
    if (!nextMain && nextNav === activeNav && isElementStructurallyShown(activeMain)) {
      nextMain = activeMain;
    }

    if (!nextNav || !nextMain) {
      if (activeNav) unmountNav();
      activeMain = null;
      clearManagedLayout();
      document.documentElement.classList.remove('messenger-app-mounted');
      document.body.classList.remove(
        'messenger-app-compact',
        'messenger-app-menu-hidden',
        'messenger-app-mounted',
      );
      clearPageConstraints();
      return;
    }

    if (activeNav !== nextNav) {
      if (activeNav) unmountNav(false);
      mountNav(nextNav);
    }
    activeMain = nextMain;
    document.documentElement.classList.add('messenger-app-mounted');
    document.body.classList.add('messenger-app-mounted');
    applyPageConstraints();
    applyManagedLayout(nextNav, nextMain);
    navControls?.refresh();
  }

  const nodeContainsStructuralCandidate = (node) => {
    if (node?.nodeType !== Node.ELEMENT_NODE) return false;
      if (node.matches('[role="main"], [role="navigation"], [role="banner"], [aria-label], ' + EDITOR_SELECTOR)) {
      const label = normalizeText(node.getAttribute('aria-label'));
      if (node.matches('[role="main"], [role="banner"], ' + EDITOR_SELECTOR)
        || NAV_LABELS.has(label)
        || node.matches('[role="navigation"]') && label === 'facebook'
        || node.matches('[role="navigation"]') && node.querySelector(THREAD_LINK_SELECTOR)) {
        return true;
      }
    }
    return Boolean(node.querySelector('[role="main"], [role="banner"], ' + EDITOR_SELECTOR))
      || Array.from(node.querySelectorAll('[aria-label], [role="navigation"]')).some((candidate) => (
        NAV_LABELS.has(normalizeText(candidate.getAttribute('aria-label')))
        || candidate.matches('[role="navigation"]')
          && normalizeText(candidate.getAttribute('aria-label')) === 'facebook'
        || candidate.matches('[role="navigation"]') && candidate.querySelector(THREAD_LINK_SELECTOR)
      ));
  };

  const isManagedStructureAttributeExpected = (node, attribute) => {
    if (!(node instanceof Element)) return false;
    switch (attribute) {
      case 'data-messenger-app-nav':
      case 'data-messenger-app-custom-width':
        return node === activeNav && navControls !== null;
      case 'data-messenger-app-nav-collapsed':
        return node === activeNav
          && navControls !== null
          && Number.parseFloat(node.style.getPropertyValue('--messenger-app-nav-width')) < 10;
      case 'data-messenger-app-viewport-root':
        return node === managedLayout.viewportRoot;
      case 'data-messenger-app-relative-root':
        return node === managedLayout.viewportRoot
          && managedLayout.viewportRootNeedsRelativeOffset;
      case 'data-messenger-app-fill':
        return managedLayout.fillNodes.has(node);
      case 'data-messenger-app-thread-fill':
        return managedLayout.threadNodes.has(node);
      case 'data-messenger-app-global-banner':
        return managedLayout.banners.has(node);
      default:
        return false;
    }
  };

  // MutationObserver already batches a DOM commit. Reconcile that batch
  // directly so a tray-hidden/occluded window never depends on throttled
  // timers or a suspended animation frame to remount its unread observer.
  const reconcileObservedStructure = () => {
    if (structureTimerId !== null) {
      clearTimeout(structureTimerId);
      structureTimerId = null;
    }
    reconcileStructureWithoutFeedback();
  };

  const structureObserver = new MutationObserver((mutations) => {
    if (activeNav && (!activeNav.isConnected || !activeMain?.isConnected)) {
      reconcileObservedStructure();
      return;
    }

    if (!activeNav) {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const target = mutation.target.nodeType === Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target.parentElement;
          if (nodeContainsStructuralCandidate(target)) {
            reconcileObservedStructure();
            return;
          }
        } else {
          const target = mutation.target.nodeType === Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target.parentElement;
          const navigationAncestor = target?.closest?.('[role="navigation"]');
          let labelledAncestor = target;
          while (labelledAncestor && labelledAncestor !== document.body) {
            if (NAV_LABELS.has(normalizeText(labelledAncestor.getAttribute?.('aria-label')))) break;
            labelledAncestor = labelledAncestor.parentElement;
          }
          if (nodeContainsStructuralCandidate(navigationAncestor)
            || nodeContainsStructuralCandidate(labelledAncestor)
            || [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsStructuralCandidate)) {
            reconcileObservedStructure();
            return;
          }
        }
      }
      return;
    }

    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target.parentElement;
      if (mutation.type === 'attributes') {
        if (MANAGED_STRUCTURE_ATTRIBUTES.has(mutation.attributeName)) {
          if (isManagedStructureAttributeExpected(target, mutation.attributeName)
            && !target.hasAttribute(mutation.attributeName)) {
            reconcileObservedStructure();
            return;
          }
          continue;
        }
        if (mutation.attributeName === 'style'
          && target === activeNav
          && target.hasAttribute('data-messenger-app-nav')
          && target.hasAttribute('data-messenger-app-custom-width')
          && target.style.getPropertyValue('--messenger-app-nav-width')
          && isElementVisible(activeNav, { allowZeroWidth: true })) {
          // Our drag writes only the managed width variable. Its current value
          // is authoritative until pointerup persists the new preference.
          continue;
        }
        if (target === activeNav
          || target === activeMain
          || target?.contains(activeNav)
          || target?.contains(activeMain)
          || nodeContainsStructuralCandidate(target)) {
          reconcileObservedStructure();
          return;
        }
      } else if (target === document.body
        || target === document.documentElement
        || target === activeNav?.parentElement
        || target === activeMain?.parentElement
        || [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsStructuralCandidate)) {
        reconcileObservedStructure();
        return;
      }
    }
  });

  const reconcileStructureWithoutFeedback = () => {
    reconcileStructure();
    // Every managed write is synchronous. Drop just those records before the
    // next observer delivery so integrity repair cannot recursively trigger
    // itself, while later host-page mutations remain observable.
    structureObserver.takeRecords();
  };

  structureObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'aria-hidden',
      'aria-label',
      'class',
      'data-messenger-app-custom-width',
      'data-messenger-app-fill',
      'data-messenger-app-global-banner',
      'data-messenger-app-nav',
      'data-messenger-app-nav-collapsed',
      'data-messenger-app-relative-root',
      'data-messenger-app-thread-fill',
      'data-messenger-app-viewport-root',
      'hidden',
      'role',
      'style',
    ],
    childList: true,
    subtree: true,
  });

  const onViewportChange = () => {
    navControls?.refresh();
    scheduleStructure();
  };
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('scroll', onViewportChange, { passive: true });

  reconcileStructureWithoutFeedback();
  publishCanonicalState(false, 'structure');
}, { once: true });
