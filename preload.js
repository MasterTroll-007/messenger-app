'use strict';

const { ipcRenderer } = require('electron');

const SOUND_URL = 'messenger-asset://notification/sound';
const AUDIO_COALESCE_MS = 300;
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
let handleTitleHint = null;
let lastObservedTitleCount = null;
let latestTitleIncrease = {
  at: -Infinity,
  from: null,
  generation: 0,
  to: null,
};
const claimedTitleIncreaseGenerations = new Set();
const pendingKnownTitleExpectations = [];
let retiredTitleIncreaseGeneration = 0;

function titleIncreaseIsUnavailable(generation) {
  return !Number.isSafeInteger(generation)
    || generation <= retiredTitleIncreaseGeneration
    || claimedTitleIncreaseGenerations.has(generation);
}

function claimTitleIncrease(generation) {
  if (titleIncreaseIsUnavailable(generation)) return false;
  claimedTitleIncreaseGenerations.add(generation);
  while (claimedTitleIncreaseGenerations.size > 128) {
    let smallest = Infinity;
    claimedTitleIncreaseGenerations.forEach((claimed) => {
      if (claimed < smallest) smallest = claimed;
    });
    claimedTitleIncreaseGenerations.delete(smallest);
    retiredTitleIncreaseGeneration = Math.max(retiredTitleIncreaseGeneration, smallest);
  }
  return true;
}

function retireTitleIncreasesThrough(generation) {
  if (!Number.isSafeInteger(generation)) return;
  retiredTitleIncreaseGeneration = Math.max(retiredTitleIncreaseGeneration, generation);
  claimedTitleIncreaseGenerations.forEach((claimed) => {
    if (claimed <= retiredTitleIncreaseGeneration) claimedTitleIncreaseGenerations.delete(claimed);
  });
  pendingKnownTitleExpectations.length = 0;
}

ipcRenderer.on('title-unread-hint', (_event, rawHint) => {
  const now = performance.now();
  const available = rawHint?.available === true;
  const count = available
    && Number.isSafeInteger(rawHint.count)
    && rawHint.count >= 0
    && rawHint.count <= 9999
    ? rawHint.count
    : 0;
  if (available) {
    if (lastObservedTitleCount !== null && count > lastObservedTitleCount) {
      latestTitleIncrease = {
        at: now,
        from: lastObservedTitleCount,
        generation: latestTitleIncrease.generation + 1,
        to: count,
      };
    }
    lastObservedTitleCount = count;
  }
  latestTitleHint = { available, count };
  if (handleTitleHint) handleTitleHint();
});

window.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEY = 'messenger-layout';
  const VIEWPORT_INSET_PX = 5;
  const MIN_CHAT_WIDTH_PX = 280;
  const MAX_NAV_WIDTH_PX = 600;
  const MAX_TRACKED_THREADS = 500;
  const STRUCTURE_GAP_GRACE_MS = 1000;
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
  let foregroundEpoch = 0;
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

  const isCalendarRowText = (text) => {
    const normalized = normalizeText(text);
    return !normalized
      || /^(?:now|just now|ted|prave ted|today|dnes|yesterday|vcera)$/.test(normalized)
      || /^(?:(?:at|v)\s+)?\d{1,2}:\d{2}(?:\s*(?:am|pm))?$/.test(normalized)
      || /^(?:(?:pred\s+)?(?:\d+\s*)?(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years|hod|hodinou|hodinami|dnem|dny|dni|tyd|tydnem|tydny|tydnu|mesicem|mesici|mesicu|rokem|roky|lety)(?:\s+(?:ago|zpet))?)$/.test(normalized)
      || /^(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|po|pondeli|ut|utery|st|streda|ct|ctvrtek|pa|patek|so|sobota|ne|nedele)$/.test(normalized)
      || /^(?:\d{1,2}\s*[./-]\s*\d{1,2}(?:\s*[./-]\s*\d{2,4})?\s*\.?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+\d{4})?)$/.test(normalized);
  };

  const isStrongCalendarRowText = (text) => {
    const normalized = normalizeText(text);
    return /^(?:now|just now|ted|prave ted|today|dnes|yesterday|vcera)$/.test(normalized)
      || /^(?:(?:at|v)\s+)?\d{1,2}:\d{2}(?:\s*(?:am|pm))?$/.test(normalized)
      || /^pred\s+(?:\d+\s*)?(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years|hod|hodinou|hodinami|dnem|dny|dni|tyd|tydnem|tydny|tydnu|mesicem|mesici|mesicu|rokem|roky|lety)(?:\s+(?:ago|zpet))?$/.test(normalized)
      || /^\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years|hod|tyd)(?:\s+ago)?$/.test(normalized)
      || /^(?:\d{1,2}\s*[./-]\s*\d{1,2}(?:\s*[./-]\s*\d{2,4})?\s*\.?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+\d{4})?)$/.test(normalized);
  };

  const isReactionRowText = (text) => {
    const normalized = normalizeText(text);
    return /^(?:reacted\b.*\bto your message|.+\s+reacted\b.*\bto your message|(?:.+\s+)?dal(?:\(a\)|a)? vasi zprave\b.*|(?:.+\s+)?reagoval(?:\(a\)|a)? na vasi zpravu\b.*)$/.test(normalized);
  };

  const isReceiptRowText = (text) => {
    const normalized = normalizeText(text);
    const match = /^(?:sent|seen|delivered|odeslano|zobrazeno|doruceno)(?:\s*[·\-–—]?\s*(.+))?$/.exec(normalized);
    return Boolean(match) && (!match[1] || isCalendarRowText(match[1]));
  };

  const matchesRowText = (normalized, patterns) => (
    patterns.some((pattern) => pattern.test(normalized))
  );

  const SECURITY_AND_SYNC_ROW_PATTERNS = [
    /^(?:new(?::\s*|\s+))?messages and calls (?:are (?:secured|protected) with end-to-end encryption|are end-to-end encrypted)(?:[.!]?\s*only people in this chat can read,?\s*listen to,?\s*or share them(?:[.!]?\s*learn more)?)?[.!]?$/,
    /^only people in this chat can read,?\s*listen to,?\s*or share them(?:[.!]?\s*learn more)?[.!]?$/,
    /^(?:(?:nove|novinka)(?::\s*|\s+))?zpravy a hovory jsou (?:zabezpeceny|chraneny) koncovym sifrovanim(?:[.!]?\s*(?:jen|pouze) lide v tomto chatu (?:je )?(?:mohou|muzou) cist,?\s*poslouchat,?\s*nebo sdilet(?:[.!]?\s*(?:dalsi informace|zjistit vice))?)?[.!]?$/,
    /^(?:jen|pouze) lide v tomto chatu (?:je )?(?:mohou|muzou) cist,?\s*poslouchat,?\s*nebo sdilet(?:[.!]?\s*(?:dalsi informace|zjistit vice))?[.!]?$/,
    /^(?:learn more|dalsi informace|zjistit vice|precist si dalsi informace)[.!]?$/,
    /^(?:(?:some|your)\s+)?(?:messages|chat history) (?:are|is) missing(?:[.!]?\s*(?:sync|restore) now)?[.!]?$/,
    /^(?:chat history is missing[.!]?\s*)?enter your pin to (?:restore (?:your )?chat history|see messages that (?:are not|aren't) loaded on this device)[.!]?$/,
    /^(?:sync|restore) now[.!]?$/,
    /^(?:nektere\s+)?(?:zpravy|historie (?:chatu|konverzace)) (?:chybi|neni (?:uplna|kompletni|k dispozici))(?:[.!]?\s*(?:synchronizovat|obnovit)(?: ted| nyni)?)?[.!]?$/,
    /^(?:historie (?:chatu|konverzace) chybi[.!]?\s*)?zadejte (?:svuj )?pin (?:pro|k) obnoveni historie (?:chatu|konverzace)[.!]?$/,
    /^(?:synchronizovat|obnovit)(?: ted| nyni)?[.!]?$/,
  ];

  const CALL_ACTIVITY_ROW_PATTERNS = [
    /^(?:(?:you|.+?)\s+)?missed (?:(?:a|an|your)\s+)?(?:(?:voice|video|audio)\s+)?call[.!]?$/,
    /^(?:missed|incoming|outgoing) (?:(?:voice|video|audio)\s+)?call[.!]?$/,
    /^(?:the\s+)?(?:(?:voice|video|audio)\s+)?(?:call|chat) (?:has\s+)?(?:ended|failed|declined|cancelled|canceled)[.!]?$/,
    /^(?:(?:you|.+?)\s+)?(?:started|ended|joined|left|declined|cancelled|canceled) (?:(?:a|the|your)\s+)?(?:(?:voice|video|audio)\s+)?(?:call|chat)\b.*$/,
    /^(?:you|.+?)\s+called you[.!]?$/,
    /^(?:zmeskany|prichozi|odchozi) (?:(?:hlasovy|video)\s+)?(?:hovor|videohovor)[.!]?$/,
    /^(?:.+\s+)?zmeskal(?:\(a\)|a)?\s+(?:(?:vas|tvuj)\s+)?(?:(?:hlasovy|video)\s+)?(?:hovor|videohovor)[.!]?$/,
    /^(?:(?:hlasovy|video)\s+)?(?:hovor|videohovor) (?:skoncil|se nezdaril|byl odmitnut|byl zrusen)[.!]?$/,
    /^(?:.+\s+)?(?:zahajil|ukoncil|odmitl|zrusil)(?:\(a\)|a)?\s+(?:(?:hlasovy|video)\s+)?(?:hovor|videohovor)\b.*$/,
    /^.+\s+vam volal(?:\(a\)|a)?[.!]?$/,
  ];

  const CHAT_CUSTOMIZATION_ROW_PATTERNS = [
    /^(?:.+\s+)?changed (?:the )?(?:chat )?(?:theme|colou?r)\b.*$/,
    /^(?:.+\s+)?set (?:the )?(?:chat )?emoji\b.*$/,
    /^(?:.+\s+)?(?:set|changed|removed) (?:(?:your|the) nickname|the nickname for .+|.+['’]s nickname)\b.*$/,
    /^(?:.+\s+)?(?:zmenil|nastavil)(?:\(a\)|a)?\s+(?:motiv|tema|barvu)(?: chatu| konverzace)?\b.*$/,
    /^(?:.+\s+)?(?:nastavil|zmenil)(?:\(a\)|a)?\s+emoji\b.*$/,
    /^(?:.+\s+)?(?:nastavil|zmenil|odebral)(?:\(a\)|a)?\s+(?:(?:vasi|tvou|jeho|jeji)\s+)?prezdivku\b.*$/,
    /^(?:.+\s+)?(?:nastavil|zmenil)(?:\(a\)|a)?\s+prezdivku pro\b.*$/,
  ];

  const PIN_AND_RETENTION_ROW_PATTERNS = [
    /^(?:.+\s+)?(?:pinned|unpinned) (?:(?:a|the|your)\s+)?message\b.*$/,
    /^(?:.+\s+)?(?:pripnul|odepnul)(?:\(a\)|a)?\s+zpravu\b.*$/,
    /^(?:.+\s+)?zrusil(?:\(a\)|a)?\s+pripnuti zpravy\b.*$/,
    /^(?:.+\s+)?(?:turned|switched) (?:on|off) (?:the )?disappearing messages\b.*$/,
    /^(?:.+\s+)?(?:changed|set) (?:the )?disappearing message(?:s)? (?:timer|duration)\b.*$/,
    /^(?:disappearing messages (?:are )?(?:on|off)|messages will disappear\b.*)$/,
    /^(?:.+\s+)?(?:zapnul|vypnul|nastavil|zmenil)(?:\(a\)|a)?\s+(?:mizejici zpravy|automaticke (?:odstraneni|odstranovani|mazani) zprav)\b.*$/,
    /^(?:mizejici zpravy jsou (?:zapnute|vypnute)|zpravy (?:automaticky )?zmizi\b.*)$/,
  ];

  const GROUP_ACTIVITY_ROW_PATTERNS = [
    /^(?:.+\s+)?(?:named the group\b.*|changed (?:the )?group (?:name|photo)\b.*|left (?:the )?group\b.*|joined (?:(?:the )?group|using an invite link)\b.*|created (?:(?:the|this)\s+)?group\b.*|added .{1,100} to (?:the )?group\b.*|removed .{1,100} from (?:the )?group\b.*)$/,
    /^(?:.+\s+)?(?:pojmenoval(?:\(a\)|a)? skupinu\b.*|zmenil(?:\(a\)|a)? (?:nazev|fotku|fotografii) skupiny\b.*|opustil(?:\(a\)|a)? skupinu\b.*|(?:se )?pripojil(?:\(a\)|a)? (?:(?:se )?ke skupine|pomoci odkazu s pozvankou)\b.*|vytvoril(?:\(a\)|a)? (?:tuto )?skupinu\b.*|pridal(?:\(a\)|a)? .{1,100} do (?:skupiny|skupinoveho chatu)\b.*|odebral(?:\(a\)|a)? .{1,100} ze (?:skupiny|skupinoveho chatu)\b.*)$/,
  ];

  const CONNECTION_SUGGESTION_ROW_PATTERNS = [
    /^(?:(?:you are|you(?:'|’)?re) now|now you are) connected on messenger\b.*$/,
    /^you can now message(?: and call)? each other\b.*$/,
    /^say hi to your new (?:facebook )?friend\b.*$/,
    /^(?:nyni|ted) jste (?:propojeni|spojeni) (?:na|v) messengeru\b.*$/,
    /^(?:nyni|ted) si muzete (?:navzajem )?posilat zpravy(?: a volat si)?\b.*$/,
    /^pozdravte (?:sveho noveho pritele|svou novou pritelkyni)\b.*$/,
  ];

  const SEND_STATUS_ROW_PATTERNS = [
    /^(?:sending(?:\.{3}|…)?|failed to send|could(?: not|n't) send(?: message)?|unable to send(?: message)?|(?:this )?message (?:did(?: not|n't) send|failed to send))(?:[.!]?\s*(?:click to )?send again)?[.!]?$/,
    /^(?:click to )?send again[.!]?$/,
    /^(?:odesilani(?:\.{3}|…)?|odesila se(?:\.{3}|…)?|nepodarilo se odeslat|nelze odeslat(?: zpravu)?|(?:tuto )?zpravu se nepodarilo odeslat|odeslani se nezdarilo)(?:[.!]?\s*(?:kliknutim )?odeslete znovu)?[.!]?$/,
    /^(?:kliknutim )?odeslete znovu[.!]?$/,
  ];

  const isSystemActivityRowText = (normalized) => (
    matchesRowText(normalized, SECURITY_AND_SYNC_ROW_PATTERNS)
    || matchesRowText(normalized, CALL_ACTIVITY_ROW_PATTERNS)
    || matchesRowText(normalized, CHAT_CUSTOMIZATION_ROW_PATTERNS)
    || matchesRowText(normalized, PIN_AND_RETENTION_ROW_PATTERNS)
    || matchesRowText(normalized, GROUP_ACTIVITY_ROW_PATTERNS)
    || matchesRowText(normalized, CONNECTION_SUGGESTION_ROW_PATTERNS)
    || matchesRowText(normalized, SEND_STATUS_ROW_PATTERNS)
    || /^(?:this message was (?:removed|deleted)|tato zprava byla (?:odstranena|smazana)|(?:you|.+) unsent a message|zrusili jste odeslani zpravy|.+\s+zrusil(?:\(a\)|a)? odeslani zpravy)[.!]?$/.test(normalized)
  );

  const isNonMessageRowText = (text) => {
    const normalized = normalizeText(text);
    return !normalized
      || /^(?:active|aktivni|aktivni pred)\b/.test(normalized)
      || /^(?:.{1,80}\s+)?(?:(?:is|are)\s+typing|typing|pise|pisou)(?:\s*(?:\.{3}|…))?$/.test(normalized)
      || isReceiptRowText(text)
      || /^(?:read by\b.*|seen by\b.*|videl\(a\) to\b.*|videla to\b.*|videl to\b.*|precetl\(a\)\b.*|precetla\b.*|precetl\b.*)$/.test(normalized)
      || isReactionRowText(text)
      || isSystemActivityRowText(normalized)
      || /^(?:mark|oznacit)\b.*(?:read|precten)/.test(normalized);
  };

  const cleanDisplayText = (value) => String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const pushDisplayPart = (parts, seen, value, {
    dedupe = false,
    filterCalendar = false,
  } = {}) => {
    const text = cleanDisplayText(value);
    const key = normalizeText(text);
    if (!text
      || !key
      || (dedupe && seen.has(key))
      || isNonMessageRowText(text)
      || (filterCalendar && isCalendarRowText(text))) return;
    seen.add(key);
    parts.push(text);
  };

  const calendarFilterFlags = (textNodes, {
    allowStrongTrailingMessage = false,
  } = {}) => textNodes.map((node, index) => {
    const text = cleanDisplayText(node.textContent);
    if (!text || !isCalendarRowText(text) || index === 0) return false;

    const trailingNodesAreAuxiliary = textNodes.slice(index + 1).every((laterNode) => {
      const laterText = cleanDisplayText(laterNode.textContent);
      return !laterText || isNonMessageRowText(laterText);
    });
    if (!trailingNodesAreAuxiliary) return false;
    const priorParts = textNodes.slice(0, index)
      .map((priorNode) => cleanDisplayText(priorNode.textContent))
      .filter((priorText) => priorText && !isNonMessageRowText(priorText));
    if (isStrongCalendarRowText(text)) {
      return !(allowStrongTrailingMessage && index === 1 && priorParts.length === 1);
    }
    const senderSplit = priorParts.length >= 2 && /:\s*$/u.test(priorParts.at(-1));
    return index >= 2 && !senderSplit;
  });

  function rowDisplayState(link, { allowStrongTrailingMessage = false } = {}) {
    const parts = [];
    const seen = new Set();
    const textNodes = Array.from(link.querySelectorAll('[dir="auto"]'))
      .filter((node) => !node.querySelector('[dir="auto"]'));
    const calendarFlags = calendarFilterFlags(textNodes, { allowStrongTrailingMessage });
    textNodes.forEach((node, index) => {
      if (node.querySelector('[dir="auto"]')) return;
      pushDisplayPart(parts, seen, node.textContent, {
        filterCalendar: calendarFlags[index],
      });
    });

    // Emoji-only and sticker-only previews often have no text node at all.
    // Their accessible image description is message content, while empty or
    // profile-picture labels are presentation-only.
    link.querySelectorAll('img[alt], [role="img"][aria-label]').forEach((node) => {
      const label = node.getAttribute('alt') || node.getAttribute('aria-label');
      if (node.closest('button, [role="button"]')) return;
      if (/\b(?:profile (?:picture|photo)|profilov[áa] (?:fotka|fotografie)|avatar)\b/iu.test(label || '')) return;
      const semanticContainer = node.closest('[dir="auto"]');
      const semanticContainerText = cleanDisplayText(semanticContainer?.textContent);
      if (semanticContainerText && isNonMessageRowText(semanticContainerText)) return;
      if (/\p{Extended_Pictographic}/u.test(label || '')
        && textNodes.some((textNode) => isReactionRowText(textNode.textContent))) return;
      const canBeMessageContent = Boolean(semanticContainer)
        || /^(?:photo|video|gif|sticker|voice message|audio|file|fotka|fotografie|video|gif|samolepka|hlasová zpráva|zvuk|soubor)\b/iu.test(label || '');
      if (!canBeMessageContent) return;
      pushDisplayPart(parts, seen, label, { dedupe: true });
    });

    if (parts.length < 2) {
      const label = cleanDisplayText(link.getAttribute('aria-label'));
      const unreadLabel = label.match(/^(.*?)(?:\s*[·\-–—]\s*|\s+)?(?:unread message|nepřečtená zpráva)\s*:\s*(.+)$/iu);
      if (unreadLabel) {
        pushDisplayPart(parts, seen, unreadLabel[1], { dedupe: true });
        pushDisplayPart(parts, seen, unreadLabel[2], { dedupe: true });
      }
    }

    if (parts.length === 0) {
      pushDisplayPart(parts, seen, link.innerText || link.textContent, { dedupe: true });
    }
    return { calendarFlags, parts, textNodes };
  }

  const isIncomingMessageBody = (body) => {
    const normalized = normalizeText(body);
    if (!normalized || isNonMessageRowText(body)) return false;
    return !/^(?:(?:ja|you|vy)\s*:|you sent\b|odeslali jste\b|poslali jste\b|poslal\(a\) jste\b)/i.test(normalized);
  };

  function rowMessageState(link, threadId, { allowStrongTrailingMessage = false } = {}) {
    const { calendarFlags, parts, textNodes } = rowDisplayState(link, {
      allowStrongTrailingMessage,
    });
    const hasTransientSemanticText = textNodes.some((node, index) => (
      isNonMessageRowText(node.textContent)
      || calendarFlags[index]
    ));
    if (parts.length < 2) {
      const signature = parts.map(normalizeText).join('\u001f').slice(0, 1024);
      const incoming = !hasTransientSemanticText
        && Boolean(signature)
        && isIncomingMessageBody(parts[0]);
      return {
        fallbackOnly: true,
        incoming,
        message: incoming
          ? {
            threadId,
            encrypted: link.pathname.startsWith('/messages/e2ee/t/'),
            title: 'Messenger',
            body: 'Nová zpráva',
          }
          : null,
        signature,
        substantive: incoming,
      };
    }

    let encrypted = false;
    try {
      encrypted = new URL(link.getAttribute('href'), window.location.href)
        .pathname.startsWith('/messages/e2ee/t/');
    } catch {
      return {
        fallbackOnly: true,
        incoming: false,
        message: null,
        signature: parts.map(normalizeText).join('\u001f').slice(0, 1024),
        substantive: true,
      };
    }

    const title = parts[0];
    const bodyParts = [];
    const seenBodyParts = new Set();
    parts.slice(1).forEach((part) => {
      const key = normalizeText(part);
      if (!key || seenBodyParts.has(key)) return;
      seenBodyParts.add(key);
      bodyParts.push(part);
    });
    const body = bodyParts.join(' · ');
    const signature = [parts[0], ...bodyParts]
      .map(normalizeText)
      .join('\u001f')
      .slice(0, 1024);
    const onlySenderPrefixes = bodyParts.length > 0
      && bodyParts.every((part) => /:\s*$/u.test(part));
    const transientSenderOnly = hasTransientSemanticText && onlySenderPrefixes;
    const incoming = !transientSenderOnly && isIncomingMessageBody(body);

    return {
      fallbackOnly: false,
      incoming,
      message: incoming
        ? {
          threadId,
          encrypted,
          title: title || 'Messenger',
          body: body || 'Nová zpráva',
        }
        : null,
      signature,
      substantive: Boolean(body) && !transientSenderOnly,
    };
  }

  const compactTextNodes = (link) => Array.from(link.querySelectorAll('[dir="auto"]'))
    .filter((node) => !node.querySelector('img, svg'));

  function setupUnreadTracker(nav, onSnapshot, { handoffSnapshot = null } = {}) {
    const threadState = new Map();
    const linkIdentity = new WeakMap();
    const dirtyIds = new Set();
    const notificationEligibleIds = new Set();
    const pendingNotifications = new Map();
    const pendingReadNotifications = new Map();
    const identityRefreshState = new WeakMap();
    const identityRefreshStates = new Set();
    const identityCandidates = new Map();
    const identitySettledIds = new Set();
    const transferredStates = handoffSnapshot?.states instanceof Map
      ? new Map(handoffSnapshot.states)
      : new Map();
    const transferredPendingNotifications = handoffSnapshot?.pendingNotifications instanceof Map
      ? new Map(handoffSnapshot.pendingNotifications)
      : new Map();
    const transferredPendingReadNotifications = handoffSnapshot?.pendingReadNotifications instanceof Map
      ? new Map(handoffSnapshot.pendingReadNotifications)
      : new Map();
    const handoffForegroundEpoch = Number.isSafeInteger(handoffSnapshot?.foregroundEpoch)
      ? handoffSnapshot.foregroundEpoch
      : foregroundEpoch;
    const SIGNATURE_STABILITY_MS = 180;
    const IDENTITY_REFRESH_QUIET_MS = 750;
    const MISSING_COUNT_GRACE_MS = 1000;
    const READ_MARKER_LAG_MS = 1000;
    const UNKNOWN_THREAD_BASELINE_MS = 1500;
    const UNKNOWN_TITLE_CORROBORATION_MS = 2000;
    const UNKNOWN_IDENTITY_SETTLE_MS = UNKNOWN_TITLE_CORROBORATION_MS;
    const trackerStartedAt = performance.now();
    let flushScheduled = false;
    let missingExpiryTimer = null;
    let disposed = false;
    let lastReportedCount = null;
    let lastReportedPresentCount = null;

    const currentCount = () => {
      let count = 0;
      threadState.forEach((state) => {
        if (state.unread && state.counted !== false) count += 1;
      });
      return Math.min(count, 9999);
    };

    const currentPresentCount = () => {
      let count = 0;
      threadState.forEach((state) => {
        if (state.unread && state.present !== false && state.counted !== false) count += 1;
      });
      return Math.min(count, 9999);
    };

    const expireKnownTitleExpectations = (now = performance.now()) => {
      for (let index = pendingKnownTitleExpectations.length - 1; index >= 0; index -= 1) {
        const expectation = pendingKnownTitleExpectations[index];
        if (now - expectation.at <= UNKNOWN_TITLE_CORROBORATION_MS) continue;
        if (expectation.disputedGeneration) {
          // No later title increase arrived for the known DOM transition. The
          // disputed increase therefore belongs to that known message, not to
          // a provisional row which happened to hydrate at the same time.
          claimTitleIncrease(expectation.disputedGeneration);
        }
        pendingKnownTitleExpectations.splice(index, 1);
      }
    };

    const noteKnownDomMessage = () => {
      const now = performance.now();
      expireKnownTitleExpectations(now);
      const generation = latestTitleIncrease.generation;
      const supportedUnknownCandidates = [...identityCandidates.values()]
        .filter((candidate) => candidate.unknownCandidate
          && candidate.titleCorroborated
          && candidate.titleIncreaseGeneration === generation);
      if (supportedUnknownCandidates.length > 0
        && now - latestTitleIncrease.at <= UNKNOWN_TITLE_CORROBORATION_MS
        && !titleIncreaseIsUnavailable(generation)) {
        pendingKnownTitleExpectations.push({
          afterGeneration: generation,
          at: now,
          disputedGeneration: generation,
        });
        supportedUnknownCandidates.forEach((candidate) => candidate.wake?.());
        return;
      }
      if (supportedUnknownCandidates.length === 0
        && !titleIncreaseIsUnavailable(generation)
        && now - latestTitleIncrease.at <= UNKNOWN_TITLE_CORROBORATION_MS) {
        claimTitleIncrease(generation);
        return;
      }
      pendingKnownTitleExpectations.push({
        afterGeneration: generation,
        at: now,
      });
    };

    const publishCountIfChanged = () => {
      const count = currentCount();
      const presentCount = currentPresentCount();
      if (count === lastReportedCount && presentCount === lastReportedPresentCount) return;
      lastReportedCount = count;
      lastReportedPresentCount = presentCount;
      onSnapshot({ count, notify: false, presentCount });
    };

    function scheduleMissingExpiry() {
      if (missingExpiryTimer !== null) {
        clearTimeout(missingExpiryTimer);
        missingExpiryTimer = null;
      }
      if (disposed) return;

      const now = performance.now();
      let nextDeadline = Infinity;
      threadState.forEach((state) => {
        if (state.present === false
          && state.counted !== false
          && Number.isFinite(state.missingSince)) {
          nextDeadline = Math.min(nextDeadline, state.missingSince + MISSING_COUNT_GRACE_MS);
        }
      });
      if (!Number.isFinite(nextDeadline)) return;

      missingExpiryTimer = setTimeout(() => {
        missingExpiryTimer = null;
        if (disposed) return;

        const expiryNow = performance.now();
        const presentIds = new Set();
        nav.querySelectorAll(THREAD_LINK_SELECTOR).forEach((link) => {
          const id = threadIdentity(link);
          if (id) presentIds.add(id);
        });

        let recoveredPresentThread = false;
        threadState.forEach((state, id) => {
          if (state.present !== false
            || state.counted === false
            || !Number.isFinite(state.missingSince)
            || expiryNow - state.missingSince < MISSING_COUNT_GRACE_MS) return;

          if (presentIds.has(id)) {
            threadState.set(id, {
              ...state,
              present: true,
              counted: true,
              missingSince: null,
            });
            markDirty(id);
            recoveredPresentThread = true;
          } else {
            threadState.set(id, {
              ...state,
              present: false,
              counted: false,
              missingSince: null,
            });
          }
        });

        // Update the DOM snapshot even when an available title hint currently
        // masks it; a later title-format change must not revive stale unread.
        publishCountIfChanged();
        if (recoveredPresentThread) scheduleFlush();
        scheduleMissingExpiry();
      }, Math.max(1, Math.ceil(nextDeadline - now)));
    }

    const touchState = (id, value) => {
      threadState.delete(id);
      threadState.set(id, value);
    };

    const trimState = () => {
      while (threadState.size > MAX_TRACKED_THREADS) {
        let evictedId = null;
        for (const [candidate, state] of threadState) {
          if (state.present === false && state.counted === false) {
            evictedId = candidate;
            break;
          }
        }
        for (const candidate of threadState.keys()) {
          if (evictedId !== null) break;
          if (!dirtyIds.has(candidate) && !pendingNotifications.has(candidate)) {
            evictedId = candidate;
            break;
          }
        }
        if (evictedId === null) {
          for (const candidate of threadState.keys()) {
            if (!pendingNotifications.has(candidate)) {
              evictedId = candidate;
              break;
            }
          }
        }
        if (evictedId === null) {
          for (const candidate of threadState.keys()) {
            if (!dirtyIds.has(candidate)) {
              evictedId = candidate;
              break;
            }
          }
        }
        if (evictedId === null) evictedId = threadState.keys().next().value;
        const pending = pendingNotifications.get(evictedId);
        if (pending) clearTimeout(pending.timer);
        pendingNotifications.delete(evictedId);
        const pendingRead = pendingReadNotifications.get(evictedId);
        if (pendingRead) clearTimeout(pendingRead.timer);
        pendingReadNotifications.delete(evictedId);
        identityCandidates.delete(evictedId);
        identitySettledIds.delete(evictedId);
        threadState.delete(evictedId);
      }
    };

    const cancelPendingNotification = (id) => {
      const pending = pendingNotifications.get(id);
      if (pending) clearTimeout(pending.timer);
      pendingNotifications.delete(id);
    };

    const cancelPendingReadNotification = (id) => {
      const pending = pendingReadNotifications.get(id);
      if (pending) clearTimeout(pending.timer);
      pendingReadNotifications.delete(id);
    };

    const appIsBackgrounded = () => document.visibilityState === 'hidden'
      || !document.hasFocus();

    const scheduleReadCandidateExpiry = (id, signature, {
      deadline = performance.now() + READ_MARKER_LAG_MS,
      scheduledForegroundEpoch = foregroundEpoch,
    } = {}) => {
      cancelPendingReadNotification(id);
      if (scheduledForegroundEpoch !== foregroundEpoch || !appIsBackgrounded()) return;
      const timer = setTimeout(() => {
        pendingReadNotifications.delete(id);
      }, Math.max(0, Math.ceil(deadline - performance.now())));
      pendingReadNotifications.set(id, {
        deadline,
        foregroundEpoch: scheduledForegroundEpoch,
        signature,
        timer,
      });
    };

    const scheduleStableNotification = (id, signature, {
      deadline = performance.now() + SIGNATURE_STABILITY_MS,
      scheduledForegroundEpoch = foregroundEpoch,
    } = {}) => {
      cancelPendingNotification(id);
      if (scheduledForegroundEpoch !== foregroundEpoch || !appIsBackgrounded()) return;
      const pending = {
        deadline,
        foregroundEpoch: scheduledForegroundEpoch,
        signature,
        timer: null,
      };
      const check = () => {
        if (pendingNotifications.get(id) !== pending) return;
        const current = threadState.get(id);
        if (current?.present === false
          && current.counted !== false
          && Number.isFinite(current.missingSince)) {
          const remaining = MISSING_COUNT_GRACE_MS - (performance.now() - current.missingSince);
          if (remaining > 0) {
            pending.timer = setTimeout(check, Math.max(1, Math.ceil(remaining)));
            return;
          }
        }
        pendingNotifications.delete(id);
        if (scheduledForegroundEpoch !== foregroundEpoch
          || !appIsBackgrounded()
          || !current?.unread
          || current.present === false
          || current.counted === false
          || current.signature !== signature) return;
        onSnapshot({
          count: currentCount(),
          notify: true,
          message: current.message,
          presentCount: currentPresentCount(),
        });
      };
      pending.timer = setTimeout(check, Math.max(0, Math.ceil(deadline - performance.now())));
      pendingNotifications.set(id, pending);
    };

    const cancelPendingNotificationsForForeground = () => {
      pendingNotifications.forEach(({ timer }) => clearTimeout(timer));
      pendingNotifications.clear();
      pendingReadNotifications.forEach(({ timer }) => clearTimeout(timer));
      pendingReadNotifications.clear();
      threadState.forEach((state) => {
        state.pendingReadSignature = null;
        state.pendingReadUntil = -Infinity;
      });
    };

    const markDirty = (id, { notificationEligible = false } = {}) => {
      if (!id) return;
      dirtyIds.add(id);
      if (notificationEligible) notificationEligibleIds.add(id);
    };

    const ownsTitleIncrease = (id, candidate) => {
      expireKnownTitleExpectations();
      const generation = candidate?.titleIncreaseGeneration || 0;
      if (!candidate?.titleCorroborated
        || titleIncreaseIsUnavailable(generation)) return false;
      if (pendingKnownTitleExpectations.some((expectation) => (
        expectation.disputedGeneration === generation
      ))) return false;

      const contenders = [...identityCandidates.entries()]
        .filter(([, other]) => other.unknownCandidate
          && other.titleCorroborated
          && other.titleIncreaseGeneration === generation);
      const topId = threadIdentity(nav.querySelector(THREAD_LINK_SELECTOR));
      const topContender = contenders.find(([candidateId]) => candidateId === topId);
      if (topContender) return topContender[0] === id;
      const newest = contenders.reduce((best, entry) => (
        !best || entry[1].createdAt > best[1].createdAt ? entry : best
      ), null);
      return newest?.[0] === id;
    };

    const rememberLink = (link, reasons) => {
      if (!(link instanceof Element) || !link.matches(THREAD_LINK_SELECTOR)) return;
      const previousId = linkIdentity.get(link);
      const nextId = threadIdentity(link);
      if (previousId) markDirty(previousId, reasons);
      if (nextId) {
        let existingState = threadState.get(nextId);
        let importedHandoff = false;
        const handoffStillValid = performance.now()
          <= (handoffSnapshot?.capturedAt || -Infinity) + (STRUCTURE_GAP_GRACE_MS * 2);
        if (!existingState && handoffStillValid && transferredStates.has(nextId)) {
          const transferred = transferredStates.get(nextId);
          transferredStates.delete(nextId);
          existingState = {
            ...transferred,
            counted: true,
            missingSince: null,
            pendingReadSignature: null,
            pendingReadUntil: -Infinity,
            present: true,
          };
          touchState(nextId, existingState);
          importedHandoff = true;
        }
        const singleTopBackgroundCandidate = reasons?.allowUnknownCandidate === true
          && threadState.size > 0
          && performance.now() - trackerStartedAt >= UNKNOWN_THREAD_BASELINE_MS
          && nav.querySelector(THREAD_LINK_SELECTOR) === link
          && (document.visibilityState === 'hidden' || !document.hasFocus());
        const allowUnknownCandidate = !existingState && singleTopBackgroundCandidate;
        const allowReturningUnreadCandidate = existingState?.present === false
          && existingState.unread === true
          && existingState.stable === true
          && singleTopBackgroundCandidate;
        if (importedHandoff) {
          refreshIdentityHydration(link, {
            allowCandidate: true,
            handoffCandidate: true,
            settleDelayMs: IDENTITY_REFRESH_QUIET_MS,
          });
          const candidate = identityCandidates.get(nextId);
          if (candidate) {
            candidate.handoffForegroundEpoch = handoffForegroundEpoch;
            candidate.handoffPendingNotification = transferredPendingNotifications.get(nextId) || null;
            candidate.handoffPendingReadNotification = transferredPendingReadNotifications.get(nextId) || null;
          }
          transferredPendingNotifications.delete(nextId);
          transferredPendingReadNotifications.delete(nextId);
        } else if (existingState?.present === false
          || (reasons?.identityHydration === true
            && (Boolean(existingState) || allowUnknownCandidate))) {
          // A virtualized/tombstoned row can hydrate its preview in a later
          // mutation. The same applies when React replaces a known row within
          // one observer batch, before it can be marked missing. Treat both
          // sequences like identity reuse so they stay silent until settled.
          refreshIdentityHydration(link, {
            allowCandidate: Boolean(existingState)
              ? (existingState.present !== false
                || existingState.unread === false
                || allowReturningUnreadCandidate)
              : allowUnknownCandidate,
            unknownCandidate: allowUnknownCandidate,
            settleDelayMs: allowUnknownCandidate
              ? UNKNOWN_IDENTITY_SETTLE_MS
              : IDENTITY_REFRESH_QUIET_MS,
          });
        }
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

      const measuredGroups = new Map();
      for (const id of dirtyIds) {
        const allLinks = groups.get(id);
        if (!allLinks?.length) {
          identityCandidates.delete(id);
          identitySettledIds.delete(id);
          const previous = threadState.get(id);
          if (previous && previous.present !== false) {
            // Keep the last signature briefly so ordinary list virtualization
            // neither flickers the badge nor turns hydration into a message.
            // A permanently absent row stops contributing after the grace.
            threadState.set(id, {
              ...previous,
              present: false,
              missingSince: performance.now(),
            });
          }
          continue;
        }
        // Finish all style/layout reads before writing our row markers. A
        // single Messenger commit can dirty many rows, and interleaving these
        // phases would otherwise trigger repeated synchronous layout work.
        const measuredLinks = allLinks.map((link) => ({
          compactNodes: compactTextNodes(link),
          link,
          unread: rowHasUnread(link),
          visible: isElementVisible(link),
        }));
        const visibleLinks = measuredLinks.filter((entry) => entry.visible);
        const links = visibleLinks.length > 0 ? visibleLinks : measuredLinks;
        const unreadLinks = links.filter((entry) => entry.unread).map((entry) => entry.link);
        const unread = unreadLinks.length > 0;
        const contentLinks = unread
          ? unreadLinks
          : links.map((entry) => entry.link);
        const previousState = threadState.get(id);
        const allowStrongTrailingMessage = notificationEligibleIds.has(id)
          && previousState?.stable === true;
        const messageStates = contentLinks.map((link) => rowMessageState(link, id, {
          allowStrongTrailingMessage,
        }));
        const substantiveState = messageStates.find((state) => state.substantive) || null;
        const signature = [...new Set(messageStates.map((state) => state.signature).filter(Boolean))]
          .sort()
          .join('\u001e')
          .slice(0, 2048);
        measuredGroups.set(id, {
          fallbackOnly: substantiveState?.fallbackOnly === true,
          incoming: substantiveState?.incoming === true,
          measuredLinks,
          message: substantiveState?.message || null,
          signature,
          substantive: substantiveState !== null,
          unread,
        });

        const identityCandidate = identityCandidates.get(id);
        if (identityCandidate) {
          if (!identityCandidate.firstObserved) {
            identityCandidate.firstObserved = {
              confirmed: substantiveState !== null
                && substantiveState.fallbackOnly !== true,
              signature,
              substantive: substantiveState !== null,
              unread,
            };
          }
          identityCandidate.latest = {
            incoming: substantiveState?.incoming === true,
            signature,
            substantive: substantiveState !== null,
            unread,
          };
        }
      }

      measuredGroups.forEach(({ measuredLinks }) => {
        measuredLinks.forEach(({ compactNodes, link, unread }) => {
          link.toggleAttribute('data-messenger-app-unread', unread);
          compactNodes.forEach((node) => node.setAttribute('data-messenger-app-compact-text', ''));
        });
      });

      for (const [id, {
        fallbackOnly,
        incoming,
        message,
        signature,
        substantive,
        unread,
      }] of measuredGroups) {
        const previous = threadState.get(id);
        const notificationEligible = notificationEligibleIds.has(id);
        const identitySettled = identitySettledIds.delete(id);
        const identityCandidate = identityCandidates.get(id);
        const incompleteFallback = Boolean(previous?.stable
          && fallbackOnly
          && signature
          && (previous.signature === signature
            || previous.signature.startsWith(`${signature}\u001f`)));
        const observedSubstantive = substantive && !incompleteFallback;
        let nextIncoming = incoming;
        let nextMessage = message;
        let nextSignature = signature;
        let stable = observedSubstantive && !fallbackOnly;
        let pendingUnreadTransition = false;
        let pendingReadSignature = previous?.pendingReadUntil > performance.now()
          ? previous.pendingReadSignature
          : null;
        let pendingReadUntil = pendingReadSignature ? previous.pendingReadUntil : -Infinity;
        if (previous) {
          if (unread) cancelPendingReadNotification(id);
          if (!unread) {
            cancelPendingNotification(id);
            if (!observedSubstantive) {
              nextIncoming = previous.incoming;
              nextMessage = previous.message;
              nextSignature = previous.signature;
              stable = previous.stable;
            } else {
              // The first substantive preview after a startup skeleton is the
              // row's baseline, not a newly received message.
              const changedWhileRead = previous.stable === true
                && !previous.unread
                && Boolean(signature)
                && previous.signature !== signature;
              const handoffReadTransition = identitySettled
                && identityCandidate?.handoffCandidate
                && identityCandidate.baseline?.stable === true
                && identityCandidate.baseline.signature !== signature
                && incoming;
              const transferredReadIntent = identitySettled
                && identityCandidate?.handoffCandidate
                && identityCandidate.handoffPendingReadNotification?.signature === signature
                && incoming;
              if ((handoffReadTransition || transferredReadIntent) && appIsBackgrounded()) {
                const transferredIntent = identityCandidate.handoffPendingReadNotification;
                pendingReadSignature = signature;
                pendingReadUntil = performance.now() + READ_MARKER_LAG_MS;
                scheduleReadCandidateExpiry(id, signature, {
                  deadline: transferredReadIntent
                    ? transferredIntent.deadline
                    : pendingReadUntil,
                  scheduledForegroundEpoch: transferredReadIntent
                    ? transferredIntent.foregroundEpoch
                    : identityCandidate.handoffForegroundEpoch,
                });
              } else if (changedWhileRead
                && notificationEligible
                && incoming
                && appIsBackgrounded()) {
                pendingReadSignature = signature;
                pendingReadUntil = performance.now() + READ_MARKER_LAG_MS;
                scheduleReadCandidateExpiry(id, signature);
              } else if (previous.unread || changedWhileRead) {
                pendingReadSignature = null;
                pendingReadUntil = -Infinity;
                cancelPendingReadNotification(id);
              }
            }
          } else if (!observedSubstantive) {
            // Typing, timestamps, read receipts, reactions, and temporary
            // skeletons must not replace the last real preview. Keeping it also
            // lets an already-scheduled message survive a brief typing update.
            nextIncoming = previous.incoming;
            nextMessage = previous.message;
            nextSignature = previous.signature;
            stable = previous.stable;
            pendingUnreadTransition = previous.pendingUnreadTransition === true
              || (!previous.unread && notificationEligible);
          } else {
            const changedSignature = Boolean(signature) && previous.signature !== signature;
            const baselineHydration = previous.unread
              && !previous.stable
              && previous.pendingUnreadTransition !== true;
            const readPreviewLed = (!previous.unread
              || previous.pendingUnreadTransition === true)
              && previous.pendingReadSignature === signature
              && previous.pendingReadUntil >= performance.now();
            const shouldNotify = incoming
              && ((notificationEligible
                && changedSignature
                && !baselineHydration)
                || readPreviewLed);
            const identityBaselineChanged = identitySettled
              && identityCandidate
              && (identityCandidate.baseline
                ? identityCandidate.baseline.signature !== signature
                : (identityCandidate.unknownCandidate && Boolean(signature)));
            const handoffTransitionEligible = identityBaselineChanged
              && identityCandidate?.handoffCandidate
              && identityCandidate.baseline?.stable === true
              && incoming;
            const identityTransitionEligible = identityBaselineChanged
              && unread
              && incoming
              && (identityCandidate.baseline
                ? (identityCandidate.handoffCandidate
                  || identityCandidate.baseline.unread === false
                  || (identityCandidate.firstObserved?.confirmed === true
                    && identityCandidate.firstObserved.signature
                      !== identityCandidate.baseline.signature))
                : (identityCandidate.firstObserved?.confirmed === true
                  && ownsTitleIncrease(id, identityCandidate)));

            const transferredStableIntent = identitySettled
              && identityCandidate?.handoffCandidate
              && identityCandidate.handoffPendingNotification?.signature === signature
              && unread
              && incoming;

            if (shouldNotify || identityTransitionEligible || transferredStableIntent) {
              const knownUnreadCountIncrease = unread
                && ((shouldNotify && previous.unread === false)
                  || (identityTransitionEligible
                    && identityCandidate?.baseline?.unread === false));
              if (knownUnreadCountIncrease) noteKnownDomMessage();
              if (identityTransitionEligible
                && !identityCandidate.baseline
                && identityCandidate.titleIncreaseGeneration) {
                claimTitleIncrease(identityCandidate.titleIncreaseGeneration);
              }
              const transferredIntent = identityCandidate?.handoffPendingNotification;
              const candidateForegroundEpoch = identityCandidate?.handoffCandidate
                ? identityCandidate.handoffForegroundEpoch
                : identityCandidate?.createdForegroundEpoch;
              scheduleStableNotification(id, signature, (identityTransitionEligible
                || handoffTransitionEligible
                || transferredStableIntent) ? {
                  deadline: transferredStableIntent
                    ? transferredIntent.deadline
                    : performance.now() + SIGNATURE_STABILITY_MS,
                  scheduledForegroundEpoch: transferredStableIntent
                    ? transferredIntent.foregroundEpoch
                    : candidateForegroundEpoch,
                } : undefined);
            } else if (changedSignature) {
              // A stable outgoing/system preview supersedes any older pending
              // incoming candidate. The timer also rechecks the signature.
              cancelPendingNotification(id);
            }
            stable = true;
            pendingUnreadTransition = false;
            pendingReadSignature = null;
            pendingReadUntil = -Infinity;
          }
        }
        touchState(id, {
          incoming: nextIncoming,
          unread,
          signature: nextSignature,
          stable,
          pendingUnreadTransition,
          present: true,
          counted: true,
          missingSince: null,
          message: nextMessage,
          pendingReadSignature,
          pendingReadUntil,
        });
        if (identitySettled) identityCandidates.delete(id);
      }
      trimState();
      dirtyIds.clear();
      notificationEligibleIds.clear();
      scheduleMissingExpiry();
      publishCountIfChanged();
    };

    const scheduleFlush = () => {
      if (flushScheduled || dirtyIds.size === 0) return;
      flushScheduled = true;
      queueMicrotask(flush);
    };

    const refreshIdentityHydration = (link, {
      allowCandidate = false,
      handoffCandidate = false,
      suppressCandidate = false,
      unknownCandidate = false,
      settleDelayMs = IDENTITY_REFRESH_QUIET_MS,
    } = {}) => {
      const id = threadIdentity(link);
      if (suppressCandidate && id) identityCandidates.delete(id);
      if (allowCandidate && id && !identityCandidates.has(id)) {
        const baseline = threadState.get(id);
        const candidateCreatedAt = performance.now();
        const recentTitleIncrease = candidateCreatedAt - latestTitleIncrease.at
          <= UNKNOWN_TITLE_CORROBORATION_MS
          && !titleIncreaseIsUnavailable(latestTitleIncrease.generation);
        const titleIncreaseGeneration = unknownCandidate && recentTitleIncrease
          ? latestTitleIncrease.generation
          : 0;
        identityCandidates.set(id, {
          baseline: baseline
            ? {
              present: baseline.present,
              signature: baseline.signature,
              stable: baseline.stable,
              unread: baseline.unread,
            }
            : null,
          firstObserved: null,
          latest: null,
          unknownCandidate,
          createdAt: candidateCreatedAt,
          createdForegroundEpoch: foregroundEpoch,
          handoffCandidate,
          handoffForegroundEpoch: foregroundEpoch,
          handoffPendingNotification: null,
          handoffPendingReadNotification: null,
          settleNotBefore: candidateCreatedAt + settleDelayMs,
          titleCorroborated: titleIncreaseGeneration > 0,
          titleCorroboratedAt: titleIncreaseGeneration > 0
            ? latestTitleIncrease.at
            : -Infinity,
          titleIncreaseGeneration,
          wake: null,
        });
      }

      let state = identityRefreshState.get(link);
      if (!state) {
        state = {
          active: true,
          id,
          settleDelayMs,
          settleNotBefore: performance.now() + settleDelayMs,
          timer: null,
          wake: null,
        };
        identityRefreshState.set(link, state);
        identityRefreshStates.add(state);
      }
      state.id = id;
      state.active = true;
      state.settleDelayMs = Math.max(
        state.settleDelayMs || IDENTITY_REFRESH_QUIET_MS,
        settleDelayMs,
      );
      state.settleNotBefore = performance.now() + state.settleDelayMs;
      const settle = () => {
        state.timer = null;
        const now = performance.now();
        expireKnownTitleExpectations(now);
        const candidate = identityCandidates.get(state.id);
        const dispute = candidate?.titleIncreaseGeneration
          ? pendingKnownTitleExpectations.find((expectation) => (
            expectation.disputedGeneration === candidate.titleIncreaseGeneration
          ))
          : null;
        const titleDecisionDeadline = candidate?.titleCorroborated
          ? candidate.titleCorroboratedAt + UNKNOWN_TITLE_CORROBORATION_MS
          : -Infinity;
        const disputeDeadline = dispute
          ? dispute.at + UNKNOWN_TITLE_CORROBORATION_MS
          : -Infinity;
        const settleNotBefore = Math.max(
          state.settleNotBefore,
          candidate?.settleNotBefore || -Infinity,
          titleDecisionDeadline,
          disputeDeadline,
        );
        if (!disposed && now < settleNotBefore) {
          state.timer = setTimeout(settle, Math.max(1, Math.ceil(settleNotBefore - now)));
          return;
        }

        state.active = false;
        identityRefreshStates.delete(state);
        identityRefreshState.delete(link);
        const settledId = threadIdentity(link);
        if (!disposed
          && settledId
          && settledId === state.id
          && link.isConnected
          && nav.contains(link)
          && identityCandidates.has(settledId)) {
          identitySettledIds.add(settledId);
          markDirty(settledId);
          scheduleFlush();
        } else if (state.id) {
          identityCandidates.delete(state.id);
        }
      };
      state.wake = () => {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = setTimeout(settle, 0);
      };
      const candidate = identityCandidates.get(id);
      if (candidate) candidate.wake = state.wake;
      state.wake();
    };

    const closestTrackedAnchor = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const anchor = element?.tagName === 'A' ? element : element?.closest?.('a');
      return anchor && nav.contains(anchor) ? anchor : null;
    };

    const observer = new MutationObserver((mutations) => {
      const addedThreadLinks = new Set();
      mutations.forEach((mutation) => {
        if (mutation.type !== 'childList') return;
        mutation.addedNodes.forEach((node) => {
          if (node?.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches?.(THREAD_LINK_SELECTOR)) addedThreadLinks.add(node);
          node.querySelectorAll?.(THREAD_LINK_SELECTOR).forEach((link) => addedThreadLinks.add(link));
        });
      });
      const onlyAddedThreadLink = addedThreadLinks.size === 1
        ? addedThreadLinks.values().next().value
        : null;

      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'href') continue;
        const link = closestTrackedAnchor(mutation.target);
        if (!link) continue;
        const previousId = linkIdentity.get(link);
        const nextId = threadIdentity(link);
        if (!previousId && !nextId) continue;
        if (previousId) identityCandidates.delete(previousId);
        if (nextId) identityCandidates.delete(nextId);
        refreshIdentityHydration(link, { suppressCandidate: true });
        if (previousId) {
          cancelPendingNotification(previousId);
          cancelPendingReadNotification(previousId);
          markDirty(previousId);
        }
        if (nextId) {
          cancelPendingNotification(nextId);
          cancelPendingReadNotification(nextId);
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
            const addsThreadLink = node?.nodeType === Node.ELEMENT_NODE
              && (node.matches?.(THREAD_LINK_SELECTOR)
                || node.querySelector?.(THREAD_LINK_SELECTOR));
            collectLinks(node, true, {
              allowUnknownCandidate: node === onlyAddedThreadLink
                || node.contains?.(onlyAddedThreadLink),
              notificationEligible: false,
              identityHydration: Boolean(addsThreadLink),
            });
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
      noteTitleHint() {
        if (disposed) return;
        const now = performance.now();
        expireKnownTitleExpectations(now);
        const knownExpectationIndex = pendingKnownTitleExpectations.findIndex((expectation) => (
          latestTitleIncrease.at >= expectation.at
          && latestTitleIncrease.generation > expectation.afterGeneration
          && !titleIncreaseIsUnavailable(latestTitleIncrease.generation)
        ));
        if (knownExpectationIndex >= 0) {
          const resolvedExpectation = pendingKnownTitleExpectations[knownExpectationIndex];
          claimTitleIncrease(latestTitleIncrease.generation);
          pendingKnownTitleExpectations.splice(knownExpectationIndex, 1);
          identityCandidates.forEach((candidate) => {
            if (candidate.titleIncreaseGeneration === resolvedExpectation.disputedGeneration) {
              candidate.wake?.();
            }
          });
          return;
        }
        for (const candidate of identityCandidates.values()) {
          if (!candidate.unknownCandidate
            || candidate.titleCorroborated
            || now - candidate.createdAt > UNKNOWN_IDENTITY_SETTLE_MS
            || titleIncreaseIsUnavailable(latestTitleIncrease.generation)
            || latestTitleIncrease.generation <= candidate.titleIncreaseGeneration
            || now - latestTitleIncrease.at > UNKNOWN_TITLE_CORROBORATION_MS) continue;
          candidate.titleCorroborated = true;
          candidate.titleCorroboratedAt = latestTitleIncrease.at;
          candidate.titleIncreaseGeneration = latestTitleIncrease.generation;
          candidate.settleNotBefore = Math.max(
            candidate.settleNotBefore || -Infinity,
            latestTitleIncrease.at + UNKNOWN_TITLE_CORROBORATION_MS,
          );
          candidate.wake?.();
        }
      },
      cancelPendingNotificationsForForeground,
      snapshotState() {
        const cloneState = (state) => ({
          ...state,
          message: state.message ? { ...state.message } : null,
        });
        const clonePending = (pending) => ({
          deadline: pending.deadline,
          foregroundEpoch: pending.foregroundEpoch,
          signature: pending.signature,
        });
        const states = new Map(
          [...transferredStates].map(([id, state]) => [id, cloneState(state)]),
        );
        threadState.forEach((state, id) => states.set(id, cloneState(state)));
        const pendingNotificationSnapshot = new Map(transferredPendingNotifications);
        pendingNotifications.forEach((pending, id) => {
          pendingNotificationSnapshot.set(id, clonePending(pending));
        });
        const pendingReadNotificationSnapshot = new Map(transferredPendingReadNotifications);
        pendingReadNotifications.forEach((pending, id) => {
          pendingReadNotificationSnapshot.set(id, clonePending(pending));
        });
        return {
          capturedAt: transferredStates.size > 0
            ? handoffSnapshot.capturedAt
            : performance.now(),
          foregroundEpoch: transferredStates.size > 0
            ? handoffForegroundEpoch
            : foregroundEpoch,
          pendingNotifications: pendingNotificationSnapshot,
          pendingReadNotifications: pendingReadNotificationSnapshot,
          states,
        };
      },
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
        pendingReadNotifications.forEach(({ timer }) => clearTimeout(timer));
        pendingReadNotifications.clear();
        if (missingExpiryTimer !== null) clearTimeout(missingExpiryTimer);
        missingExpiryTimer = null;
        identityRefreshStates.forEach(({ timer }) => {
          if (timer !== null) clearTimeout(timer);
        });
        identityRefreshStates.clear();
        identityCandidates.clear();
        identitySettledIds.clear();
        transferredStates.clear();
        transferredPendingNotifications.clear();
        transferredPendingReadNotifications.clear();
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

  function publishCanonicalState(
    notify = false,
    source = 'structure',
    rawMessage = null,
  ) {
    const domCount = domSnapshot?.count || 0;
    const titleCount = latestTitleHint.available ? latestTitleHint.count : null;
    // A title prefix can lag behind a DOM message. For a notification event,
    // never let a stale title count of zero erase the only toast/sound signal.
    const count = notify && source === 'dom'
      ? Math.max(domCount, titleCount || 0)
      : (titleCount ?? domCount);
    const message = notify && source === 'dom' ? rawMessage : null;
    if (!notify && !message && count === lastPublishedCount) return;
    const badgeDataUrl = count > 0 ? createBadgeDataUrl(count) : null;
    ipcRenderer.send('publish-unread-state', {
      count,
      notify,
      badgeDataUrl,
      message,
    });
    lastPublishedCount = count;
  }

  // A title prefix has no sender or preview and can include non-message
  // Facebook activity. Use it only to improve the badge count; native toasts
  // and their sound require a DOM-confirmed conversation-row transition.
  handleTitleHint = () => {
    if (!latestTitleHint.available
      && (domSnapshot?.presentCount ?? domSnapshot?.count) === 0) {
      lastObservedTitleCount = 0;
      retireTitleIncreasesThrough(latestTitleIncrease.generation);
    }
    unreadTracker?.noteTitleHint();
    publishCanonicalState(false, 'title');
  };

  let activeNav = null;
  let activeMain = null;
  let unreadTracker = null;
  let navControls = null;
  let pendingHandoffSnapshot = null;
  let structureTimerId = null;
  let structureGapTimer = null;
  let structureGapDeadline = -Infinity;
  let structureGapGeneration = 0;
  let pendingDomSnapshot = null;
  const knownConversationNavs = new WeakSet(
    document.querySelectorAll('[role="navigation"]'),
  );

  const handleAppForegrounded = () => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    foregroundEpoch += 1;
    unreadTracker?.cancelPendingNotificationsForForeground();
  };
  window.addEventListener('focus', handleAppForegrounded);
  document.addEventListener('visibilitychange', handleAppForegrounded);

  const clearStructureGap = () => {
    structureGapGeneration += 1;
    if (structureGapTimer !== null) clearTimeout(structureGapTimer);
    structureGapTimer = null;
    structureGapDeadline = -Infinity;
    pendingDomSnapshot = null;
  };

  const beginStructureGap = () => {
    if (structureGapTimer !== null) return;
    const generation = structureGapGeneration + 1;
    structureGapGeneration = generation;
    structureGapDeadline = performance.now() + STRUCTURE_GAP_GRACE_MS;
    pendingDomSnapshot = null;
    structureGapTimer = setTimeout(() => {
      if (generation !== structureGapGeneration) return;
      structureGapTimer = null;
      structureGapDeadline = -Infinity;
      const pending = pendingDomSnapshot;
      pendingDomSnapshot = null;

      if (activeNav && activeMain) {
        if (pending) {
          domSnapshot = { ...pending, notify: false };
          publishCanonicalState(false, 'structure');
        }
        return;
      }

      domSnapshot = null;
      pendingHandoffSnapshot = null;
      publishCanonicalState(false, 'structure');
    }, STRUCTURE_GAP_GRACE_MS);
  };

  const acceptDomSnapshot = (snapshot) => {
    const gapActive = structureGapTimer !== null
      && performance.now() < structureGapDeadline;
    if (gapActive && (domSnapshot?.count || 0) > 0 && snapshot.count === 0) {
      pendingDomSnapshot = snapshot;
      return;
    }
    if (structureGapTimer !== null) clearStructureGap();
    domSnapshot = snapshot;
    if ((snapshot.presentCount ?? snapshot.count) === 0 && !latestTitleHint.available) {
      lastObservedTitleCount = 0;
      retireTitleIncreasesThrough(latestTitleIncrease.generation);
    }
    publishCanonicalState(
      snapshot.notify,
      'dom',
      snapshot.message,
    );
  };

  const unmountNav = (publishFallback = true, retainHandoff = false) => {
    pendingHandoffSnapshot = retainHandoff
      ? unreadTracker?.snapshotState() || null
      : null;
    unreadTracker?.cleanup();
    navControls?.cleanup();
    unreadTracker = null;
    navControls = null;
    activeNav = null;
    if (publishFallback) beginStructureGap();
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
    knownConversationNavs.add(nav);
    const saved = loadState();
    navControls = setupNavControls(nav, saved, scheduleStructure);
    unreadTracker = setupUnreadTracker(nav, (snapshot) => {
      acceptDomSnapshot(snapshot);
    }, { handoffSnapshot: pendingHandoffSnapshot });
    pendingHandoffSnapshot = null;
  };

  function reconcileStructure() {
    let nextNav = findVisibleConversationList();
    if (!nextNav && isElementStructurallyShown(activeNav)) nextNav = activeNav;
    let nextMain = nextNav ? findVisibleMain(nextNav) : null;
    if (!nextMain && nextNav === activeNav && isElementStructurallyShown(activeMain)) {
      nextMain = activeMain;
    }

    if (!nextNav || !nextMain) {
      const preserveConnectedTracker = Boolean(activeNav?.isConnected);
      if (activeNav && !preserveConnectedTracker) unmountNav(true, true);
      if (!activeNav || !activeMain?.isConnected) activeMain = null;
      clearManagedLayout();
      document.documentElement.classList.remove('messenger-app-mounted');
      document.body.classList.remove('messenger-app-mounted');
      if (!preserveConnectedTracker) {
        document.body.classList.remove(
          'messenger-app-compact',
          'messenger-app-menu-hidden',
        );
      }
      clearPageConstraints();
      return;
    }

    if (activeNav !== nextNav) {
      if (activeNav) {
        // A replacement can already contain thread anchors while React is
        // still hydrating their unread semantics. Any zero snapshot during a
        // handoff from a nonzero list therefore needs the same fixed grace as
        // a completely empty skeleton.
        const replacementNeedsGrace = (domSnapshot?.count || 0) > 0;
        const isNewReplacement = !knownConversationNavs.has(nextNav);
        const retainHandoff = !activeNav.isConnected || isNewReplacement;
        unmountNav(!activeNav.isConnected || replacementNeedsGrace, retainHandoff);
      }
      mountNav(nextNav);
    }
    activeMain = nextMain;
    document.documentElement.classList.add('messenger-app-mounted');
    document.body.classList.add('messenger-app-mounted');
    applyPageConstraints();
    applyManagedLayout(nextNav, nextMain);
    navControls?.refresh();
  }

  const isDirectStructuralCandidate = (node) => {
    if (node?.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches('[role="main"], [role="banner"], ' + EDITOR_SELECTOR)) return true;
    const label = normalizeText(node.getAttribute('aria-label'));
    if (NAV_LABELS.has(label)) return true;
    return node.matches('[role="navigation"]')
      && (label === 'facebook' || Boolean(node.querySelector(THREAD_LINK_SELECTOR)));
  };

  const nodeContainsStructuralCandidate = (node) => {
    if (node?.nodeType !== Node.ELEMENT_NODE) return false;
    if (isDirectStructuralCandidate(node)) return true;
    const candidates = node.querySelectorAll(
      '[role="main"], [role="banner"], [role="navigation"], ' + EDITOR_SELECTOR,
    );
    if (Array.from(candidates).some(isDirectStructuralCandidate)) return true;
    // Once mounted, ordinary message mutations are the hot path. A labelled
    // replacement list will still be caught when the old nav disconnects; the
    // broad aria-label scan is only needed while discovering the first nav.
    return !activeNav && Array.from(node.querySelectorAll('[aria-label]')).some((candidate) => (
      NAV_LABELS.has(normalizeText(candidate.getAttribute('aria-label')))
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
