const { ipcRenderer } = require('electron');

// Direct IPC function (usable within preload context)
const sendBadge = (dataUrl) => ipcRenderer.send('set-badge', dataUrl);

// Inject custom CSS, sidebar toggle, and resizable panels
window.addEventListener('DOMContentLoaded', () => {
  // --- Layout state persistence ---
  const STORAGE_KEY = 'messenger-layout';
  const loadState = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch { return {}; }
  };
  const saveState = (updates) => {
    const state = { ...loadState(), ...updates };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const style = document.createElement('style');
  style.id = 'custom-messenger-styles';
  style.textContent = `
    /* Hide unnecessary FB banners/prompts */
    [data-testid="cookie-policy-manage-dialog"],
    [role="banner"] > div:has(a[href*="download"]) {
      display: none !important;
    }

    /* Force chat messages to align to bottom */
    [role="main"] > div > div > div {
      display: flex !important;
      flex-direction: column !important;
      justify-content: flex-end !important;
    }

    /* Custom scrollbar */
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


    /* Resize handles */
    .resize-handle {
      position: fixed;
      top: 0;
      width: 8px;
      height: 100vh;
      cursor: col-resize;
      z-index: 99999;
      background: transparent;
      transition: background 0.2s;
    }
    .resize-handle:hover,
    .resize-handle.active {
      background: rgba(0, 149, 246, 0.4);
    }

    /* During resize, prevent text selection and pointer events on iframes */
    body.resizing {
      cursor: col-resize !important;
      user-select: none !important;
    }
    body.resizing * {
      cursor: col-resize !important;
    }
  `;
  document.head.appendChild(style);

  // --- Compact sidebar ---
  let compactStyle = null;

  // Current nav width for compact mode
  let compactWidth = 108;
  let isCompact = false;

  function getCompactCSS(width) {
    return `
      [aria-label="Seznam konverzací"] {
        width: ${width}px !important;
        min-width: ${width}px !important;
        max-width: ${width}px !important;
        overflow-x: hidden !important;
      }
      [aria-label="Seznam konverzací"] [role="search"],
      [aria-label="Seznam konverzací"] input,
      [aria-label="Seznam konverzací"] h1,
      [aria-label="Seznam konverzací"] [aria-label="Facebook"],
      [aria-label="Seznam konverzací"] [aria-label="Nová zpráva"],
      [aria-label="Seznam konverzací"] [aria-label="New message"] {
        display: none !important;
      }
      [aria-label="Seznam konverzací"] span:not([data-visualcompletion]):not([role]) {
        font-size: 0 !important;
        line-height: 0 !important;
        height: 0 !important;
        overflow: hidden !important;
      }
      [aria-label="Seznam konverzací"] img {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      [aria-label="Seznam konverzací"] [role="button"] {
        display: none !important;
      }
      [aria-label="Seznam konverzací"] > div > [role="button"],
      [aria-label="Seznam konverzací"] [aria-label="Chaty"],
      [aria-label="Seznam konverzací"] [aria-label="Lidé"],
      [aria-label="Seznam konverzací"] [aria-label="Marketplace"],
      [aria-label="Seznam konverzací"] [aria-label="Žádosti o zprávy"] {
        display: flex !important;
      }
    `;
  }

  function enableCompact() {
    if (compactStyle) return;
    compactStyle = document.createElement('style');
    compactStyle.id = 'compact-sidebar-style';
    compactStyle.textContent = getCompactCSS(compactWidth);
    document.head.appendChild(compactStyle);
  }

  function updateCompactWidth(w) {
    compactWidth = w;
    saveState({ compactWidth: w });
    if (compactStyle) {
      compactStyle.textContent = getCompactCSS(w);
    }
  }

  function disableCompact() {
    if (compactStyle) {
      compactStyle.remove();
      compactStyle = null;
    }
  }

  // --- Resizable panel (nav only) ---
  function setupNavResize(nav) {
    if (nav.dataset.resizable) return;
    nav.dataset.resizable = 'true';

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    document.body.appendChild(handle);

    const updateHandlePos = () => {
      const rect = nav.getBoundingClientRect();
      handle.style.left = (rect.right - 4) + 'px';
    };
    updateHandlePos();
    setInterval(updateHandlePos, 500);

    let startX, startWidth;

    // Style tag for normal (non-compact) resize
    const normalResizeStyle = document.createElement('style');
    normalResizeStyle.id = 'nav-resize-normal';
    document.head.appendChild(normalResizeStyle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startWidth = nav.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('resizing');

      const onMouseMove = (e) => {
        const delta = e.clientX - startX;
        const newWidth = Math.max(0, Math.min(600, startWidth + delta));

        if (isCompact) {
          // Update compact style directly
          updateCompactWidth(newWidth);
        } else {
          // Use separate style for normal mode
          normalResizeStyle.textContent = `
            [aria-label="Seznam konverzací"] {
              width: ${newWidth}px !important;
              min-width: ${newWidth}px !important;
              max-width: ${newWidth}px !important;
              ${newWidth < 10 ? 'overflow: hidden !important;' : ''}
            }
          `;
        }
        updateHandlePos();
      };

      const onMouseUp = () => {
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        updateHandlePos();
        // Save current width
        const finalWidth = nav.getBoundingClientRect().width;
        if (isCompact) {
          saveState({ compactWidth: finalWidth });
        } else {
          saveState({ navWidth: finalWidth });
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    return normalResizeStyle;
  }

  // --- Init ---
  const waitForLoad = setInterval(() => {
    const nav = document.querySelector('[aria-label="Seznam konverzací"]');
    if (!nav) return;

    clearInterval(waitForLoad);

    // Restore saved layout state
    const saved = loadState();
    if (saved.compactWidth) compactWidth = saved.compactWidth;

    // Add resize handle to conversation list panel
    const normalResizeStyle = setupNavResize(nav);

    // Apply saved nav width (normal mode)
    if (saved.navWidth && !saved.isCompact) {
      normalResizeStyle.textContent = `
        [aria-label="Seznam konverzací"] {
          width: ${saved.navWidth}px !important;
          min-width: ${saved.navWidth}px !important;
          max-width: ${saved.navWidth}px !important;
        }
      `;
    }

    // Compact toggle via Ctrl+B only
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        isCompact = !isCompact;
        saveState({ isCompact });
        if (isCompact) {
          normalResizeStyle.textContent = '';
          enableCompact();
        } else {
          disableCompact();
        }
      }
    });

    // --- Left icon menu toggle (Ctrl+M) ---
    let menuHidden = false;
    let menuStyle = null;

    const toggleMenu = () => {
      menuHidden = !menuHidden;
      saveState({ menuHidden });
      if (menuHidden) {
        menuStyle = document.createElement('style');
        menuStyle.id = 'hide-menu-bar';
        menuStyle.textContent = `
          [aria-label="Přepínač Doručených zpráv"] {
            width: 0 !important;
            min-width: 0 !important;
            max-width: 0 !important;
            overflow: hidden !important;
            padding: 0 !important;
            opacity: 0 !important;
          }
        `;
        document.head.appendChild(menuStyle);
      } else {
        if (menuStyle) {
          menuStyle.remove();
          menuStyle = null;
        }
      }
    };

    // Restore saved compact and menu state
    if (saved.isCompact) {
      isCompact = true;
      normalResizeStyle.textContent = '';
      enableCompact();
    }
    if (saved.menuHidden) {
      toggleMenu();
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'm') {
        e.preventDefault();
        toggleMenu();
      }
    });

    // --- Unread indicator dots in compact mode ---
    // --- Unread indicator dots in compact mode ---
    const unreadStyle = document.createElement('style');
    unreadStyle.id = 'unread-dots';
    unreadStyle.textContent = `
      .has-unread {
        position: relative !important;
      }
      .has-unread::after {
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
    document.head.appendChild(unreadStyle);

    // Generate badge PNG data URL using canvas
    const createBadgeDataUrl = (count, size = 48) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      // Dark red circle with border
      ctx.fillStyle = '#cc0000';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();

      // White border
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
      ctx.stroke();

      // Bold white text
      const text = count > 99 ? '99+' : String(count);
      ctx.fillStyle = 'white';
      ctx.font = `bold ${text.length > 2 ? 16 : text.length > 1 ? 22 : 28}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, size / 2, size / 2 + 1);

      return canvas.toDataURL('image/png');
    };

    let lastBadgeCount = -1;

    const updateUnreadDots = () => {
      const convList = document.querySelector('[aria-label="Seznam konverzací"]');
      if (!convList) return;

      let unreadCount = 0;

      // Find all conversation links
      const links = convList.querySelectorAll('a');
      links.forEach(link => {
        const spans = link.querySelectorAll('span[dir="auto"]');
        let hasUnread = false;
        for (const span of spans) {
          const fw = parseInt(getComputedStyle(span).fontWeight);
          if (fw >= 600) {
            hasUnread = true;
            break;
          }
        }

        if (hasUnread) {
          unreadCount++;
          if (isCompact) link.classList.add('has-unread');
        } else {
          link.classList.remove('has-unread');
        }
      });

      if (!isCompact) {
        document.querySelectorAll('.has-unread').forEach(el => el.classList.remove('has-unread'));
      }

      // Update taskbar badge
      if (unreadCount !== lastBadgeCount) {
        lastBadgeCount = unreadCount;
        // Stop previous pulse
        if (pulseInterval) {
          clearInterval(pulseInterval);
          pulseInterval = null;
        }
        if (unreadCount > 0) {
          // Start pulsing - show/hide
          let pulseVisible = true;
          sendBadge(createBadgeDataUrl(unreadCount));
          pulseInterval = setInterval(() => {
            pulseVisible = !pulseVisible;
            sendBadge(pulseVisible ? createBadgeDataUrl(unreadCount) : null);
          }, 800);
        } else {
          sendBadge(null);
        }
      }
    };

    let pulseInterval = null;
    setInterval(updateUnreadDots, 2000);

  }, 1000);
});
