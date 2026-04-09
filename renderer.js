const OBSOLETE_ACCOUNT_STORAGE_KEYS = [
  "codexQuotaWidget.accounts.v4",
  "codexQuotaWidget.accounts.v3",
  "codexQuotaWidget.accounts.v2",
  "codexQuotaWidget.sample.v1"
];
const PREFERENCES_KEY = "codexQuotaWidget.preferences.v1";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const CLOCK_REFRESH_MS = 60 * 1000;
const EXPAND_ANIMATION_MS = 350;
const FIXED_ACCOUNT_COUNT = 3;
const THEMES = {
  cool: {
    label: "Cool",
    accentRgb: "96, 165, 250",
    accentSoftRgb: "132, 196, 255",
    accentHoverRgb: "147, 197, 253",
    barColors: ["#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#f43f5e"]
  },
  ember: {
    label: "Ember",
    accentRgb: "249, 115, 22",
    accentSoftRgb: "251, 191, 36",
    accentHoverRgb: "252, 211, 77",
    barColors: ["#ef4444", "#f97316", "#f59e0b", "#fbbf24", "#fde047"]
  },
  forest: {
    label: "Forest",
    accentRgb: "34, 197, 94",
    accentSoftRgb: "74, 222, 128",
    accentHoverRgb: "134, 239, 172",
    barColors: ["#16a34a", "#22c55e", "#4ade80", "#84cc16", "#bef264"]
  }
};
const widgetRootEl = document.getElementById("widgetRoot");
const summarySurfaceEl = document.getElementById("summarySurface");
const summaryChevronEl = document.getElementById("summaryChevron");
const nextResetLabelEl = document.getElementById("nextResetLabel");
const overallBarEl = document.getElementById("overallBar");
const expandedPanelEl = document.getElementById("expandedPanel");
const accountsViewEl = document.getElementById("accountsView");
const settingsViewEl = document.getElementById("settingsView");

let defaultAccounts = [];
let accounts = [];
let latestResults = {};
let profileStatuses = {};
let preferences = loadPreferences();
let launchOnStartupSupported = true;
let isExpanded = false;
let isSettingsMode = false;
let expandedSettingId = null;
let statusMessage = "Waiting for connected Codex accounts.";
let statusTone = "neutral";
let dragState = null;
let dragMoveFrameId = 0;
let windowResizeFrameId = 0;
let panelPhase = "collapsed";
let panelTransitionTimerId = 0;
let lastWindowSyncSignature = "";

init().catch((error) => {
  setStatus(error instanceof Error ? error.message : "Failed to initialize widget.", "error");
  render();
});

async function init() {
  if (!window.quotaApi || !window.windowApi) {
    throw new Error("Secure bridge is unavailable. Restart the app.");
  }

  const defaultsResponse = await window.quotaApi.getDefaults();
  defaultAccounts = normalizeDefaultAccounts(defaultsResponse?.accounts);
  clearObsoleteAccountStorage();
  accounts = buildInitialAccounts(defaultAccounts);
  await applyAlwaysOnTopPreference();
  await syncLaunchOnStartupPreference();
  applyMaterialPreferences();
  latestResults = ensureMapForAccounts(accounts, latestResults);
  profileStatuses = ensureMapForAccounts(accounts, profileStatuses);
  expandedSettingId = accounts[0]?.id || null;

  bindEvents();
  render();

  await refreshProfileStates({ syncReadyAccounts: true });
  window.setInterval(() => {
    refreshReadyAccounts().catch(() => {
      // Errors are surfaced through per-account state and status text.
    });
  }, AUTO_REFRESH_MS);
  window.setInterval(() => {
    render();
  }, CLOCK_REFRESH_MS);
}

function bindEvents() {
  summarySurfaceEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    toggleExpanded();
  });

  widgetRootEl.addEventListener("pointerdown", handleWidgetPointerDown);
  widgetRootEl.addEventListener("contextmenu", handleWidgetContextMenu);
  window.addEventListener("blur", handleWindowBlur);
}

function render(options = {}) {
  const shouldAnimateResize = Boolean(options.animateResize);
  const panelIsOpen = panelPhase === "expanding" || panelPhase === "expanded";
  const panelShouldRender = panelPhase !== "collapsed";
  widgetRootEl.classList.toggle("is-expanded", isExpanded);
  widgetRootEl.classList.toggle("is-settings-mode", isSettingsMode);
  summarySurfaceEl.setAttribute("aria-expanded", String(isExpanded));
  summarySurfaceEl.setAttribute("aria-label", isExpanded ? "Collapse quota widget" : "Expand quota widget");
  summaryChevronEl.setAttribute("data-state", isExpanded ? "expanded" : "collapsed");
  nextResetLabelEl.textContent = getNextResetText();
  overallBarEl.innerHTML = buildOverallBarMarkup();
  expandedPanelEl.classList.toggle("is-open", panelIsOpen);
  expandedPanelEl.setAttribute("aria-hidden", String(!panelShouldRender));
  accountsViewEl.hidden = !panelShouldRender || isSettingsMode;
  settingsViewEl.hidden = !panelShouldRender || !isSettingsMode;

  if (isSettingsMode) {
    renderSettingsView();
  } else if (panelShouldRender) {
    renderAccountsView();
  }

  syncExpandedPanelHeight(panelShouldRender);
  queueWindowResize(shouldAnimateResize ? EXPAND_ANIMATION_MS : 0);
}

function syncExpandedPanelHeight(panelShouldRender) {
  const panelHeight = panelShouldRender ? expandedPanelEl.scrollHeight : 0;
  expandedPanelEl.style.setProperty("--expanded-panel-height", `${panelHeight}px`);
}

function toggleExpanded() {
  if (isSettingsMode) {
    isSettingsMode = false;
    render();
    return;
  }

  window.clearTimeout(panelTransitionTimerId);

  if (isExpanded) {
    isExpanded = false;
    panelPhase = "collapsing";
    render({ animateResize: true });
    panelTransitionTimerId = window.setTimeout(() => {
      panelPhase = "collapsed";
      render();
    }, EXPAND_ANIMATION_MS);
    return;
  }

  isExpanded = true;
  panelPhase = "expanding";
  render({ animateResize: true });
  panelTransitionTimerId = window.setTimeout(() => {
    panelPhase = "expanded";
  }, EXPAND_ANIMATION_MS);
}

function openSettingsView(options = {}) {
  const shouldAnimate = options.animate !== false;
  window.clearTimeout(panelTransitionTimerId);
  isExpanded = true;
  isSettingsMode = true;

  if (!shouldAnimate) {
    panelPhase = "expanded";
    render();
    return;
  }

  panelPhase = "expanding";
  render({ animateResize: true });
  panelTransitionTimerId = window.setTimeout(() => {
    panelPhase = "expanded";
  }, EXPAND_ANIMATION_MS);
}

function collapseToCompact(options = {}) {
  const shouldAnimate = options.animate !== false;
  if (!isExpanded && panelPhase === "collapsed" && !isSettingsMode) {
    return;
  }

  window.clearTimeout(panelTransitionTimerId);
  isSettingsMode = false;
  isExpanded = false;

  if (!shouldAnimate) {
    panelPhase = "collapsed";
    render();
    return;
  }

  panelPhase = "collapsing";
  render({ animateResize: shouldAnimate });
  panelTransitionTimerId = window.setTimeout(() => {
    panelPhase = "collapsed";
    render();
  }, shouldAnimate ? EXPAND_ANIMATION_MS : 0);
}

function handleWindowBlur() {
  collapseToCompact({ animate: false });
}

async function handleWidgetContextMenu(event) {
  event.preventDefault();

  try {
    const action = await window.windowApi?.showWidgetContextMenu?.();
    if (action === "settings") {
      openSettingsView({ animate: false });
    }
  } catch {
    // Ignore context-menu bridge failures and keep the widget usable.
  }
}

async function handleWidgetPointerDown(event) {
  if (event.button !== 0 || !event.isPrimary) {
    return;
  }

  if (isInteractiveTarget(event.target)) {
    return;
  }

  const position = await window.windowApi?.getPosition?.();
  if (!position) {
    return;
  }

  dragState = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    windowStartX: position.x,
    windowStartY: position.y,
    didDrag: false,
    targetInSummary: isWithinSummary(event.target)
  };

  window.addEventListener("pointermove", handleWidgetPointerMove);
  window.addEventListener("pointerup", handleWidgetPointerUp);
  window.addEventListener("pointercancel", handleWidgetPointerCancel);
}

function handleWidgetPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const deltaX = event.screenX - dragState.startScreenX;
  const deltaY = event.screenY - dragState.startScreenY;
  if (!dragState.didDrag && Math.hypot(deltaX, deltaY) >= 4) {
    dragState.didDrag = true;
    widgetRootEl.classList.add("is-dragging");
  }

  if (!dragState.didDrag) {
    return;
  }

  dragState.pendingX = dragState.windowStartX + deltaX;
  dragState.pendingY = dragState.windowStartY + deltaY;
  if (!dragMoveFrameId) {
    dragMoveFrameId = window.requestAnimationFrame(flushDragMove);
  }
}

function handleWidgetPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const wasTap = !dragState.didDrag;
  const startedInSummary = dragState.targetInSummary;
  const endedInSummary = isWithinSummary(event.target);
  cleanupDragState();

  if (wasTap && startedInSummary && endedInSummary && !isInteractiveTarget(event.target)) {
    toggleExpanded();
  }
}

function handleWidgetPointerCancel(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  cleanupDragState();
}

function cleanupDragState() {
  if (dragMoveFrameId) {
    window.cancelAnimationFrame(dragMoveFrameId);
    dragMoveFrameId = 0;
  }

  dragState = null;
  widgetRootEl.classList.remove("is-dragging");
  window.removeEventListener("pointermove", handleWidgetPointerMove);
  window.removeEventListener("pointerup", handleWidgetPointerUp);
  window.removeEventListener("pointercancel", handleWidgetPointerCancel);
}

function flushDragMove() {
  dragMoveFrameId = 0;
  if (!dragState || !dragState.didDrag) {
    return;
  }

  void window.windowApi?.setPosition?.({
    x: dragState.pendingX,
    y: dragState.pendingY
  });
}

function isInteractiveTarget(target) {
  return Boolean(target instanceof Element && target.closest("button,input,textarea,select,a,label,.settings-scroll"));
}

function isWithinSummary(target) {
  return Boolean(target instanceof Element && target.closest("#summarySurface"));
}

function renderAccountsView() {
  accountsViewEl.innerHTML = `
    <div class="panel-header accounts-view-header">
      <span class="panel-title">Active Accounts</span>
      <button id="openSettingsBtn" type="button" class="icon-btn icon-btn-settings" aria-label="Open settings">
        ${getSettingsIcon()}
      </button>
    </div>
    ${buildAccountsMarkup()}
    ${buildStatusNoteMarkup()}
  `;

  document.getElementById("openSettingsBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSettingsView({ animate: false });
  });
}

function normalizeCodexHomeForComparison(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizeProfileEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getKnownProfileEmail(accountId) {
  return normalizeProfileEmail(latestResults[accountId]?.profileEmail || profileStatuses[accountId]?.profileEmail);
}

function getAssociatedProfileEmail(accountId) {
  const latestEmail = latestResults[accountId]?.profileEmail;
  if (typeof latestEmail === "string" && latestEmail.trim()) {
    return latestEmail.trim();
  }

  const statusEmail = profileStatuses[accountId]?.profileEmail;
  if (typeof statusEmail === "string" && statusEmail.trim()) {
    return statusEmail.trim();
  }

  return "";
}

function getAccountDisplayName(account) {
  const associatedEmail = getAssociatedProfileEmail(account.id);
  if (associatedEmail) {
    return associatedEmail;
  }

  return account.name;
}

function findDuplicateProfileConflict(accountId, options = {}) {
  const currentIndex = accounts.findIndex((account) => account.id === accountId);
  if (currentIndex === -1) {
    return null;
  }

  const normalizedCodexHome = normalizeCodexHomeForComparison(options.codexHome ?? accounts[currentIndex]?.codexHome);
  const normalizedProfileEmail = normalizeProfileEmail(options.profileEmail || getKnownProfileEmail(accountId));

  for (let index = 0; index < currentIndex; index += 1) {
    const otherAccount = accounts[index];
    const otherCodexHome = normalizeCodexHomeForComparison(otherAccount.codexHome);
    if (normalizedCodexHome && otherCodexHome && normalizedCodexHome === otherCodexHome) {
      return {
        otherAccount,
        reason: "path",
        message: `This profile folder is already assigned to ${getAccountDisplayName(otherAccount)}.`
      };
    }

    const otherProfileEmail = getKnownProfileEmail(otherAccount.id);
    if (normalizedProfileEmail && otherProfileEmail && normalizedProfileEmail === otherProfileEmail) {
      return {
        otherAccount,
        reason: "account",
        message: `This Codex account is already connected in ${getAccountDisplayName(otherAccount)}.`
      };
    }
  }

  return null;
}

function applyDuplicateProfileConflict(accountId, response, conflict) {
  profileStatuses[accountId] = {
    ...(response || {}),
    ok: true,
    ready: false,
    isChecking: false,
    checkedAtMs: Date.now(),
    duplicateOfAccountId: conflict.otherAccount.id,
    duplicateReason: conflict.reason,
    message: conflict.message
  };
  latestResults[accountId] = null;
  updateAccount(accountId, { liveEnabled: false });
}

function getActiveTheme() {
  return THEMES[preferences.themeColor] || THEMES.cool;
}

function getThemeColors() {
  return getActiveTheme().barColors;
}

function renderSettingsView() {
  settingsViewEl.innerHTML = `
    <div class="settings-scroll settings-scroll-full">
      <div class="panel-header settings-view-header">
        <span class="panel-title">Settings</span>
        <button id="closeSettingsBtn" type="button" class="text-btn">Done</button>
      </div>
      <div class="settings-global-card">
        <div class="settings-global-copy">
          <span class="setting-name">Always On Top</span>
        </div>
        <button
          id="alwaysOnTopToggle"
          type="button"
          class="toggle-btn ${preferences.alwaysOnTop ? "is-on" : ""}"
          role="switch"
          aria-checked="${preferences.alwaysOnTop ? "true" : "false"}"
          aria-label="Toggle always on top"
        >
          <span class="toggle-btn-thumb" aria-hidden="true"></span>
        </button>
      </div>
      ${
        launchOnStartupSupported
          ? `
      <div class="settings-global-card">
        <div class="settings-global-copy">
          <span class="setting-name">Launch On Startup</span>
        </div>
        <button
          id="launchOnStartupToggle"
          type="button"
          class="toggle-btn ${preferences.launchOnStartup ? "is-on" : ""}"
          role="switch"
          aria-checked="${preferences.launchOnStartup ? "true" : "false"}"
          aria-label="Toggle launch on startup"
        >
          <span class="toggle-btn-thumb" aria-hidden="true"></span>
        </button>
      </div>
      `
          : ""
      }
      <div class="settings-global-card">
        <div class="settings-global-copy">
          <span class="setting-name">Opacity</span>
        </div>
        <div class="slider-wrap">
          <input
            id="glassOpacitySlider"
            class="slider-input"
            type="range"
            min="70"
            max="130"
            step="1"
            value="${escapeHtmlAttribute(String(preferences.glassOpacity))}"
          />
          <span id="glassOpacityValue" class="slider-value">${escapeHtml(`${preferences.glassOpacity}%`)}</span>
        </div>
      </div>
      <div class="settings-global-card settings-global-card-actions">
        <div class="settings-global-copy">
          <span class="setting-name">Quota Refresh</span>
        </div>
        <button id="resyncAllBtn" type="button" class="secondary-btn secondary-btn-compact">Resync All</button>
      </div>
      <div class="settings-list">
        ${buildSettingsMarkup()}
      </div>
      ${buildStatusNoteMarkup()}
    </div>
  `;

  document.getElementById("closeSettingsBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    isSettingsMode = false;
    render();
  });

  document.getElementById("alwaysOnTopToggle")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await toggleAlwaysOnTop();
  });

  document.getElementById("launchOnStartupToggle")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await toggleLaunchOnStartup();
  });

  document.getElementById("resyncAllBtn")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await resyncAllAccountsFromSettings();
  });

  document.getElementById("glassOpacitySlider")?.addEventListener("input", (event) => {
    const nextValue = Number(event.target.value);
    updateGlassOpacity(nextValue);
  });

  bindSettingsEvents();
}

function bindSettingsEvents() {
  accounts.forEach((account) => {
    document.getElementById(`toggle-${account.id}`)?.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedSettingId = expandedSettingId === account.id ? null : account.id;
      render();
    });

    document.getElementById(`check-${account.id}`)?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await checkProfileStatus(account.id, { syncIfReady: false });
    });

    document.getElementById(`login-${account.id}`)?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await openLoginForAccount(account.id);
    });

    document.getElementById(`sync-${account.id}`)?.addEventListener("click", async (event) => {
      event.stopPropagation();
      await syncAccountFromSettings(account.id);
    });
  });
}

function buildOverallBarMarkup() {
  const displayAccounts = accounts;
  const themeColors = getThemeColors();
  if (displayAccounts.length === 0) {
    return `
      <span class="overall-segment" style="width:100%;">
        <span class="overall-segment-fill" style="width:0%;background:${themeColors[0]};"></span>
      </span>
    `;
  }

  return displayAccounts
    .map((account, index) => {
      const percentage = getRemainingPercentForAccount(account) ?? 0;
      const width = 100 / displayAccounts.length;
      const color = themeColors[index % themeColors.length];

      return `
        <span class="overall-segment" style="width:${width}%;">
          <span class="overall-segment-fill" style="width:${Math.min(percentage, 100)}%;background:${color};"></span>
        </span>
      `;
    })
    .join("");
}

function buildAccountsMarkup() {
  const displayAccounts = accounts;
  const themeColors = getThemeColors();
  if (displayAccounts.length === 0) {
    return `<div class="panel-empty">No accounts configured.</div>`;
  }

  return `
    <div class="accounts-list">
      ${displayAccounts
        .map((account, index) => {
          const remainingPercentage = getRemainingPercentForAccount(account);
          const percentage = remainingPercentage ?? 0;
          const color = themeColors[index % themeColors.length];
          const valueLabel = getAccountValueLabel(account, remainingPercentage);
          const displayName = getAccountDisplayName(account);

          return `
            <div class="account-item">
              <div class="account-row">
                <span class="account-name">${escapeHtml(displayName)}</span>
                <span class="account-value">
                  ${escapeHtml(valueLabel)}
                </span>
              </div>
              <div class="account-bar">
                <div class="account-bar-fill" style="--bar-fill:${Math.min(percentage, 100)}%;--bar-color:${color};"></div>
              </div>
              <div class="account-reset">${escapeHtml(getAccountFooterText(account))}</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function buildSettingsMarkup() {
  if (accounts.length === 0) {
    return `<div class="panel-empty">No accounts configured.</div>`;
  }

  return accounts
    .map((account, index) => {
      const isOpen = expandedSettingId === account.id;
      const status = profileStatuses[account.id];
      const statusSummary = getSettingsSummary(account, status);
      const displayName = getAccountDisplayName(account);

      return `
        <div
          class="setting-card ${isOpen ? "is-open" : ""}"
          data-account-id="${escapeHtmlAttribute(account.id)}"
        >
          <div class="setting-row" data-account-id="${escapeHtmlAttribute(account.id)}">
            <div class="setting-copy">
              <span class="setting-name">${escapeHtml(displayName)}</span>
              <span class="setting-meta">${escapeHtml(statusSummary)}</span>
            </div>
            <div class="setting-actions">
              <button
                id="toggle-${account.id}"
                type="button"
                class="list-action-btn"
                aria-label="${isOpen ? "Collapse" : "Expand"} ${escapeHtml(displayName)}"
              >
                ${isOpen ? getChevronUpIcon() : getChevronDownIcon()}
              </button>
            </div>
          </div>
          ${isOpen ? buildSettingsDetailMarkup(account, status) : ""}
        </div>
      `;
    })
    .join("");
}

function buildSettingsDetailMarkup(account, status) {
  const steps = getSetupSteps(account, status);
  const isChecking = Boolean(status?.isChecking);
  const isSyncing = Boolean(latestResults[account.id]?.isLoading);
  const canOpenLogin = Boolean(account.codexHome.trim() && status?.cliInstalled);
  const canSync = Boolean(account.codexHome.trim());
  const associatedEmail = getAssociatedProfileEmail(account.id);
  const loginButtonLabel = status?.duplicateOfAccountId ? "Relogin" : "Open Login";

  return `
    <div class="setting-detail">
      <div class="field-group">
        <span class="field-label">Profile Folder</span>
        <div class="field-input field-input-mono field-input-readonly">${escapeHtml(account.codexHome)}</div>
      </div>
      <div class="field-group">
        <span class="field-label">Signed-in Email</span>
        <div class="field-input field-input-readonly">${escapeHtml(associatedEmail || "--")}</div>
      </div>
      <div class="setup-list">
        ${steps
          .map(
            (step, stepIndex) => `
              <div class="setup-step ${step.stateClass}">
                <span class="setup-step-index">${stepIndex + 1}</span>
                <div class="setup-step-copy">
                  <span class="setup-step-title">${escapeHtml(step.title)}</span>
                  <span class="setup-step-text">${escapeHtml(step.text)}</span>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
      <div class="action-row">
        <button id="check-${account.id}" type="button" class="secondary-btn" ${isChecking ? "disabled" : ""}>
          ${isChecking ? "Checking..." : "Check Setup"}
        </button>
        <button id="login-${account.id}" type="button" class="secondary-btn" ${canOpenLogin ? "" : "disabled"}>
          ${loginButtonLabel}
        </button>
        <button id="sync-${account.id}" type="button" class="primary-btn" ${canSync && !isSyncing ? "" : "disabled"}>
          ${isSyncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>
      <div class="helper-note">
        ${escapeHtml(getHelperText(account, status))}
      </div>
    </div>
  `;
}

function getSetupSteps(account, status) {
  const profileStatus = status || {};
  const duplicateMessage = profileStatus.duplicateOfAccountId ? profileStatus.message : "";
  const associatedEmail = getAssociatedProfileEmail(account.id);
  const signInText = account.codexHome.trim()
    ? profileStatus.authExists
      ? associatedEmail
        ? `Logged in as ${associatedEmail} at ${account.codexHome.trim()}.`
        : `Logged in at ${account.codexHome.trim()}.`
      : "Use Open Login to run codex login for this fixed profile folder."
    : "Profile folder is unavailable.";

  return [
    {
      title: "Install Codex CLI",
      text: profileStatus.cliInstalled
        ? "Detected in your user npm installation."
        : "Run npm install -g @openai/codex once on this machine.",
      stateClass: profileStatus.cliInstalled ? "is-complete" : "is-warning"
    },
    {
      title: "Sign into this profile",
      text: signInText,
      stateClass: profileStatus.authExists ? "is-complete" : account.codexHome.trim() ? "is-warning" : "is-idle"
    },
    {
      title: "Sync live quota",
      text: duplicateMessage
        ? `${duplicateMessage} Use Relogin to switch this folder to a different account.`
        : latestResults[account.id]?.ok
          ? "Live quota synced. The widget is using Codex data now."
          : latestResults[account.id]?.isLoading
            ? "Sync in progress."
            : account.liveEnabled
              ? "This account will auto-refresh live quota."
              : "This account will sync automatically when the widget opens.",
      stateClass: duplicateMessage
        ? "is-warning"
        : latestResults[account.id]?.ok
          ? "is-complete"
          : latestResults[account.id]?.isLoading
            ? "is-warning"
            : "is-idle"
    }
  ];
}

function getHelperText(account, status) {
  if (status?.ready) {
    return account.liveEnabled
      ? "This profile is connected. Sync now to refresh live quota immediately."
      : "This profile is ready. It will sync automatically when the widget opens.";
  }

  if (status?.duplicateOfAccountId) {
    return `${status.message || "This Codex profile is already assigned to another account slot."} Use Relogin to sign this folder into a different account.`;
  }

  if (!status?.cliInstalled) {
    return "Codex CLI is missing. Install it globally before continuing.";
  }

  if (!status?.authExists) {
    return `Open Login starts Codex login for ${account.codexHome}.`;
  }

  return status?.message || "Use Check Setup to refresh this account state.";
}

function normalizeDefaultAccounts(rawAccounts) {
  const base = Array.isArray(rawAccounts) && rawAccounts.length > 0 ? rawAccounts : [];
  const length = FIXED_ACCOUNT_COUNT;

  return Array.from({ length }, (_, index) => ({
    name: base[index]?.name || `Profile ${index + 1}`,
    codexHome: typeof base[index]?.codexHome === "string" ? base[index].codexHome.trim() : ""
  }));
}

function clearObsoleteAccountStorage() {
  OBSOLETE_ACCOUNT_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
}

function buildInitialAccounts(fallbackDefaults) {
  return Array.from({ length: FIXED_ACCOUNT_COUNT }, (_, index) => {
    const defaultAccount = fallbackDefaults[index] || { codexHome: "" };
    const resolvedCodexHome = defaultAccount.codexHome || "";

    return {
      id: createAccountId(index),
      name: defaultAccount.name || `Profile ${index + 1}`,
      codexHome: resolvedCodexHome,
      liveEnabled: Boolean(resolvedCodexHome)
    };
  });
}

function ensureMapForAccounts(accountList, currentMap) {
  const nextMap = {};
  accountList.forEach((account) => {
    nextMap[account.id] = currentMap[account.id] ?? null;
  });
  return nextMap;
}

function updateAccount(accountId, patch) {
  accounts = accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account));
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return {
        alwaysOnTop: false,
        launchOnStartup: false,
        glassOpacity: 100,
        themeColor: "cool"
      };
    }

    const parsed = JSON.parse(raw);
    return {
      alwaysOnTop: Boolean(parsed?.alwaysOnTop),
      launchOnStartup: Boolean(parsed?.launchOnStartup),
      glassOpacity: clampGlassOpacity(parsed?.glassOpacity),
      themeColor: clampThemeColor(parsed?.themeColor)
    };
  } catch {
    return {
      alwaysOnTop: false,
      launchOnStartup: false,
      glassOpacity: 100,
      themeColor: "cool"
    };
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

function applyMaterialPreferences() {
  const normalizedOpacity = (preferences.glassOpacity || 100) / 100;
  const highlightOpacity = Math.max(0.68, Math.min(1.02, 1.02 - (normalizedOpacity - 1) * 0.55));
  const theme = getActiveTheme();
  document.documentElement.style.setProperty("--glass-base-opacity", String(normalizedOpacity));
  document.documentElement.style.setProperty("--glass-highlight-opacity", String(highlightOpacity));
  document.documentElement.style.setProperty("--accent-rgb", theme.accentRgb);
  document.documentElement.style.setProperty("--accent-soft-rgb", theme.accentSoftRgb);
  document.documentElement.style.setProperty("--accent-hover-rgb", theme.accentHoverRgb);
  const valueEl = document.getElementById("glassOpacityValue");
  if (valueEl) {
    valueEl.textContent = `${preferences.glassOpacity}%`;
  }
}

async function applyAlwaysOnTopPreference() {
  try {
    await window.windowApi?.setAlwaysOnTop?.({
      enabled: preferences.alwaysOnTop
    });
  } catch {
    // Keep the widget usable even if the window bridge fails here.
  }
}

async function toggleAlwaysOnTop() {
  const nextEnabled = !preferences.alwaysOnTop;

  try {
    const response = await window.windowApi?.setAlwaysOnTop?.({
      enabled: nextEnabled
    });
    preferences = {
      ...preferences,
      alwaysOnTop: Boolean(response?.enabled ?? nextEnabled)
    };
    savePreferences();
    setStatus(preferences.alwaysOnTop ? "Always-on-top enabled." : "Always-on-top disabled.", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to update always-on-top.", "error");
  }

  render();
}

async function syncLaunchOnStartupPreference() {
  try {
    const response = await window.windowApi?.getLaunchOnStartup?.();
    if (!response?.ok) {
      launchOnStartupSupported = Boolean(response?.supported);
      return;
    }

    launchOnStartupSupported = response.supported !== false;
    preferences = {
      ...preferences,
      launchOnStartup: Boolean(response.enabled)
    };
    savePreferences();
  } catch {
    // Ignore startup registration read failures and keep the widget usable.
  }
}

async function toggleLaunchOnStartup() {
  const nextEnabled = !preferences.launchOnStartup;

  try {
    const response = await window.windowApi?.setLaunchOnStartup?.({
      enabled: nextEnabled
    });
    if (!response?.ok) {
      throw new Error(response?.message || "Unable to update launch-on-startup.");
    }

    preferences = {
      ...preferences,
      launchOnStartup: Boolean(response.enabled)
    };
    savePreferences();
    setStatus(
      response?.message || (preferences.launchOnStartup ? "Launch on startup enabled." : "Launch on startup disabled."),
      "ok"
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to update launch-on-startup.", "error");
  }

  render();
}

function updateGlassOpacity(nextValue) {
  preferences = {
    ...preferences,
    glassOpacity: clampGlassOpacity(nextValue)
  };
  savePreferences();
  applyMaterialPreferences();
}

function clampGlassOpacity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 100;
  }

  return Math.min(130, Math.max(70, Math.round(numeric)));
}

function clampThemeColor(value) {
  return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : "cool";
}

async function refreshProfileStates(options = {}) {
  for (const account of accounts) {
    await checkProfileStatus(account.id, { syncIfReady: options.syncReadyAccounts });
  }
  updateGlobalStatus();
  render();
}

async function refreshReadyAccounts() {
  for (const account of accounts) {
    const status = profileStatuses[account.id];
    if (!status?.ready || !account.liveEnabled) {
      continue;
    }

    await refreshAccount(account.id);
  }

  updateGlobalStatus();
  render();
}

async function checkProfileStatus(accountId, options = {}) {
  const account = accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }

  profileStatuses[accountId] = {
    ...(profileStatuses[accountId] || {}),
    isChecking: true
  };
  render();

  try {
    const response = await window.quotaApi.getProfileStatus({ codexHome: account.codexHome });
    const duplicateConflict = findDuplicateProfileConflict(accountId, {
      codexHome: response?.codexHome || account.codexHome,
      profileEmail: response?.profileEmail
    });
    if (duplicateConflict) {
      applyDuplicateProfileConflict(accountId, response, duplicateConflict);
      setStatus(duplicateConflict.message, "error");
      return;
    }

    profileStatuses[accountId] = {
      ...response,
      isChecking: false,
      checkedAtMs: Date.now()
    };
    if (response?.ready && options.syncIfReady) {
      await refreshAccount(accountId);
    } else if (!response?.ready) {
      latestResults[accountId] = latestResults[accountId]?.ok ? latestResults[accountId] : null;
    }
  } catch (error) {
    profileStatuses[accountId] = {
      ok: false,
      isChecking: false,
      message: error instanceof Error ? error.message : "Unable to inspect profile state."
    };
  }

  updateGlobalStatus();
  render();
}

async function syncAccountFromSettings(accountId) {
  await checkProfileStatus(accountId, { syncIfReady: false });
  const status = profileStatuses[accountId];
  if (!status?.ready) {
    setStatus(status?.message || "Finish account setup before syncing live quota.", "error");
    render();
    return;
  }

  await refreshAccount(accountId);
  updateGlobalStatus();
  render();
}

async function resyncAllAccountsFromSettings() {
  setStatus("Resyncing all configured accounts...", "neutral");
  render();
  await refreshProfileStates({ syncReadyAccounts: true });
}

async function refreshAccount(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  if (!account || !account.codexHome.trim()) {
    return;
  }
  const displayName = getAccountDisplayName(account);
  const liveEntry = latestResults[accountId];
  if (liveEntry?.isLoading) {
    return;
  }

  latestResults[accountId] = {
    ...(liveEntry || {}),
    isLoading: true,
    updatedAtMs: Date.now()
  };
  render();

  try {
    const response = await window.quotaApi.fetchRateLimits({ codexHome: account.codexHome });
    const duplicateConflict = findDuplicateProfileConflict(accountId, {
      codexHome: account.codexHome,
      profileEmail: response?.profileEmail
    });
    if (duplicateConflict) {
      applyDuplicateProfileConflict(accountId, {
        ...(profileStatuses[accountId] || {}),
        profileEmail: response?.profileEmail || null
      }, duplicateConflict);
      setStatus(duplicateConflict.message, "error");
      return;
    }

    if (!response?.ok) {
      latestResults[accountId] = {
        ok: false,
        error: response?.error || "Unable to fetch rate limits.",
        isLoading: false,
        updatedAtMs: Date.now()
      };
      setStatus(`Live sync failed for ${displayName}. This account stays empty until sync succeeds.`, "error");
      return;
    }

    latestResults[accountId] = {
      ok: true,
      rateLimits: response.rateLimits,
      profileEmail: response?.profileEmail || null,
      isLoading: false,
      updatedAtMs: Date.now()
    };
    updateAccount(accountId, { liveEnabled: true });
    setStatus(`Live quota synced for ${getAccountDisplayName(account)}.`, "ok");
  } catch (error) {
    latestResults[accountId] = {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected error while fetching rate limits.",
      isLoading: false,
      updatedAtMs: Date.now()
    };
    setStatus(`Live sync failed for ${displayName}. This account stays empty until sync succeeds.`, "error");
  }
}

async function openLoginForAccount(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }

  await checkProfileStatus(accountId, { syncIfReady: false });
  const status = profileStatuses[accountId];
  if (!account.codexHome.trim()) {
    setStatus("Profile folder is unavailable.", "error");
    render();
    return;
  }

  if (!status?.cliInstalled) {
    setStatus("Install the Codex CLI first: npm install -g @openai/codex", "error");
    render();
    return;
  }

  try {
    const response = await window.quotaApi.openLogin({ codexHome: account.codexHome });
    if (!response?.ok) {
      setStatus(response?.error || "Unable to open login terminal.", "error");
      render();
      return;
    }

    setStatus(`Opened Codex login terminal for ${getAccountDisplayName(account)}. Finish login, then click Check Setup.`, "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to open login terminal.", "error");
  }

  render();
}

function getUsagePercentForAccount(account) {
  const livePercent = latestResults[account.id]?.ok ? latestResults[account.id]?.rateLimits?.secondary?.usedPercent : null;
  if (typeof livePercent === "number") {
    return clampPercent(livePercent);
  }

  return 0;
}

function getRemainingPercentForAccount(account) {
  const liveEntry = latestResults[account.id];
  if (!liveEntry?.ok) {
    return null;
  }

  const usedPercent = getUsagePercentForAccount(account);
  return clampPercent(100 - usedPercent);
}

function getSettingsSummary(account, status) {
  const associatedEmail = getAssociatedProfileEmail(account.id);
  if (status?.duplicateOfAccountId) {
    return associatedEmail ? `Duplicate account - ${associatedEmail}` : "Duplicate account - Relogin required";
  }

  if (latestResults[account.id]?.ok) {
    return associatedEmail ? `Connected - ${associatedEmail}` : "Connected - Live quota synced";
  }

  if (latestResults[account.id]?.error) {
    return "Sync failed";
  }

  if (status?.isChecking) {
    return "Checking setup...";
  }

  if (!account.codexHome.trim()) {
    return "Profile folder unavailable";
  }

  if (status?.ready) {
    return associatedEmail
      ? `Ready - ${associatedEmail}`
      : account.liveEnabled
        ? "Connected - Awaiting refresh"
        : "Ready - Auto-syncs on open";
  }

  if (status?.authExists) {
    return associatedEmail ? `Logged in - ${associatedEmail}` : "Logged in - Run sync";
  }

  if (status?.cliInstalled) {
    return "Needs login";
  }

  return "Not connected - Codex CLI not found";
}

function getNextResetText() {
  const nextReset = getNextResetDate();
  if (!nextReset) {
    return "Next: --";
  }

  const resetCountdown = getResetCountdownText(nextReset);
  if (resetCountdown) {
    return resetCountdown;
  }

  return `Next: ${getDaysUntil(nextReset)}`;
}

function getNextResetDate() {
  const dates = accounts
    .map((account) => {
      const liveReset = latestResults[account.id]?.ok ? latestResults[account.id]?.rateLimits?.secondary?.resetsAt : null;
      if (typeof liveReset === "number") {
        return new Date(liveReset * 1000);
      }

      return null;
    })
    .filter((date) => date && !Number.isNaN(date.getTime()));

  if (dates.length === 0) {
    return null;
  }

  return dates.reduce((closest, current) => (current < closest ? current : closest), dates[0]);
}

function getDaysUntil(date) {
  const diffTime = date.getTime() - Date.now();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return "Today";
  }

  if (diffDays === 1) {
    return "Tomorrow";
  }

  return `${diffDays}d`;
}

function getResetCountdownText(date) {
  const diffTime = date.getTime() - Date.now();
  if (diffTime <= 0 || diffTime >= 24 * 60 * 60 * 1000) {
    return null;
  }

  const totalMinutes = Math.max(0, Math.floor(diffTime / (1000 * 60)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `Resets ${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function updateGlobalStatus() {
  const liveCount = accounts.filter((account) => latestResults[account.id]?.ok).length;
  const readyCount = accounts.filter((account) => profileStatuses[account.id]?.ready).length;
  const failedCount = accounts.filter((account) => latestResults[account.id]?.error).length;
  const duplicateCount = accounts.filter((account) => profileStatuses[account.id]?.duplicateOfAccountId).length;

  if (duplicateCount > 0) {
    setStatus(`Duplicate Codex profile detected for ${duplicateCount}/${accounts.length} account${accounts.length === 1 ? "" : "s"}.`, "error");
    return;
  }

  if (liveCount > 0) {
    setStatus("", "neutral");
    return;
  }

  if (failedCount > 0) {
    setStatus(`Sync failed for ${failedCount}/${accounts.length} account${accounts.length === 1 ? "" : "s"}.`, "error");
    return;
  }

  if (readyCount > 0) {
    setStatus(`Setup ready for ${readyCount}/${accounts.length} account${accounts.length === 1 ? "" : "s"}. Sync to load live quota.`, "neutral");
    return;
  }

  setStatus("Waiting for connected Codex accounts.", "neutral");
}

function setStatus(message, tone) {
  statusMessage = message;
  statusTone = tone;
}

function statusToneClass(tone) {
  if (tone === "ok") {
    return "is-ok";
  }

  if (tone === "error") {
    return "is-error";
  }

  return "";
}

function buildStatusNoteMarkup() {
  if (!statusMessage) {
    return "";
  }

  return `<div class="status-note ${statusToneClass(statusTone)}">${escapeHtml(statusMessage)}</div>`;
}

function queueWindowResize(durationMs = 0) {
  window.cancelAnimationFrame(windowResizeFrameId);

  const syncWindowSize = () => {
    const rect = widgetRootEl.getBoundingClientRect();
    const payload = {
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
      panelPhase
    };
    const signature = `${payload.width}x${payload.height}:${payload.panelPhase}`;
    if (!durationMs && signature === lastWindowSyncSignature) {
      return;
    }

    lastWindowSyncSignature = signature;
    void window.windowApi.syncSize(payload);
  };

  if (!durationMs) {
    windowResizeFrameId = window.requestAnimationFrame(syncWindowSize);
    return;
  }

  const startedAt = performance.now();
  const tick = () => {
    syncWindowSize();
    if (performance.now() - startedAt < durationMs + 34) {
      windowResizeFrameId = window.requestAnimationFrame(tick);
    }
  };

  windowResizeFrameId = window.requestAnimationFrame(tick);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 100) {
    return 100;
  }

  return value;
}

function createAccountId(index) {
  return `profile-${index + 1}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function getSettingsIcon() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path
        d="M19.14 12.94a7.96 7.96 0 0 0 .06-.94c0-.32-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.32 7.32 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
        fill="currentColor"
      />
    </svg>
  `;
}

function getChevronDownIcon() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path
        d="M6.7 9.3a1 1 0 0 1 1.4 0L12 13.2l3.9-3.9a1 1 0 1 1 1.4 1.4l-4.6 4.6a1 1 0 0 1-1.4 0L6.7 10.7a1 1 0 0 1 0-1.4Z"
        fill="currentColor"
      />
    </svg>
  `;
}

function getChevronUpIcon() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path
        d="M17.3 14.7a1 1 0 0 1-1.4 0L12 10.8l-3.9 3.9a1 1 0 1 1-1.4-1.4l4.6-4.6a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4Z"
        fill="currentColor"
      />
    </svg>
  `;
}

function getAccountValueLabel(account, remainingPercentage) {
  const liveEntry = latestResults[account.id];
  if (liveEntry?.ok) {
    return `${Math.round(remainingPercentage)}%`;
  }

  return "--";
}

function getAccountFooterText(account) {
  const liveEntry = latestResults[account.id];
  if (liveEntry?.isLoading) {
    return "Syncing live quota...";
  }

  if (liveEntry?.ok) {
    const resetSeconds = liveEntry.rateLimits?.secondary?.resetsAt;
    if (typeof resetSeconds === "number") {
      const resetDate = new Date(resetSeconds * 1000);
      if (!Number.isNaN(resetDate.getTime())) {
        return `Live data - Resets ${resetDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      }
    }

    return "Live data";
  }

  if (liveEntry?.error) {
    return "Sync failed";
  }

  const status = profileStatuses[account.id];
  if (status?.ready && !account.liveEnabled) {
    return "Ready to connect";
  }

  return "Not connected";
}
