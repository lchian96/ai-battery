const STORAGE_KEY = "codexQuotaWidget.accounts.v4";
const PREFERENCES_KEY = "codexQuotaWidget.preferences.v1";
const LEGACY_STORAGE_KEYS = ["codexQuotaWidget.accounts.v3", "codexQuotaWidget.accounts.v2", "codexQuotaWidget.sample.v1"];
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const CLOCK_REFRESH_MS = 60 * 1000;
const EXPAND_ANIMATION_MS = 350;
const COLORS = ["#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#f43f5e"];
const SAMPLE_ACCOUNT_SEEDS = [
  { name: "Account 1", used: 0, limit: 1000, resetOffsetDays: 30 },
  { name: "Account 2", used: 0, limit: 1000, resetOffsetDays: 30 },
  { name: "Account 3", used: 0, limit: 1000, resetOffsetDays: 30 }
];

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
let isExpanded = false;
let isSettingsMode = false;
let expandedSettingId = null;
let statusMessage = "Waiting for connected Codex accounts.";
let statusTone = "neutral";
let dragState = null;
let windowResizeFrameId = 0;
let panelPhase = "collapsed";
let panelTransitionTimerId = 0;
let lastWindowSyncSignature = "";
let draggedSettingId = null;
let dropTargetSettingId = null;

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
  accounts = loadStoredAccounts(defaultAccounts);
  saveAccounts();
  await applyAlwaysOnTopPreference();
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
}

function render(options = {}) {
  const shouldAnimateResize = Boolean(options.animateResize);
  const panelIsOpen = panelPhase === "expanding" || panelPhase === "expanded";
  const panelShouldRender = panelPhase !== "collapsed";
  widgetRootEl.classList.toggle("is-expanded", isExpanded);
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

  queueWindowResize(shouldAnimateResize ? EXPAND_ANIMATION_MS : 0);
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

  void window.windowApi?.setPosition?.({
    x: dragState.windowStartX + deltaX,
    y: dragState.windowStartY + deltaY
  });
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
  dragState = null;
  widgetRootEl.classList.remove("is-dragging");
  window.removeEventListener("pointermove", handleWidgetPointerMove);
  window.removeEventListener("pointerup", handleWidgetPointerUp);
  window.removeEventListener("pointercancel", handleWidgetPointerCancel);
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
    isSettingsMode = true;
    render();
  });
}

function syncAccountIdentity(accountId, profileEmail) {
  if (typeof profileEmail !== "string" || !profileEmail.trim()) {
    return;
  }

  const nextName = profileEmail.trim();
  const current = accounts.find((item) => item.id === accountId);
  if (!current || current.name === nextName) {
    return;
  }

  updateAccount(accountId, {
    name: nextName
  });
}

function renderSettingsView() {
  if (!expandedSettingId && accounts[0]?.id) {
    expandedSettingId = accounts[0].id;
  }

  settingsViewEl.innerHTML = `
    <div class="settings-scroll settings-scroll-full">
      <div class="panel-header settings-view-header">
        <span class="panel-title">Settings</span>
        <button id="closeSettingsBtn" type="button" class="text-btn">Done</button>
      </div>
      <div class="settings-global-card">
        <div class="settings-global-copy">
          <span class="setting-name">Always On Top</span>
          <span class="setting-meta">Keep the widget above other windows.</span>
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
          <span class="setting-meta">Retry live sync for every configured account.</span>
        </div>
        <button id="resyncAllBtn" type="button" class="secondary-btn secondary-btn-compact">Resync All</button>
      </div>
      <div class="settings-list">
        ${buildSettingsMarkup()}
      </div>
      <button id="addAccountBtn" type="button" class="add-btn">
        ${getPlusIcon()}
        Add Account
      </button>
      ${buildStatusNoteMarkup()}
    </div>
  `;

  document.getElementById("closeSettingsBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    isSettingsMode = false;
    render();
  });

  document.getElementById("addAccountBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    addAccount();
  });

  document.getElementById("alwaysOnTopToggle")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await toggleAlwaysOnTop();
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
  document.querySelectorAll(".setting-row-draggable").forEach((rowEl) => {
    rowEl.addEventListener("dragstart", handleSettingDragStart);
    rowEl.addEventListener("dragover", handleSettingDragOver);
    rowEl.addEventListener("drop", handleSettingDrop);
    rowEl.addEventListener("dragend", handleSettingDragEnd);
  });

  accounts.forEach((account, index) => {
    document.getElementById(`toggle-${account.id}`)?.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedSettingId = account.id;
      render();
    });

    document.getElementById(`remove-${account.id}`)?.addEventListener("click", (event) => {
      event.stopPropagation();
      removeAccount(account.id);
    });

    const nameInput = document.getElementById(`name-${account.id}`);
    nameInput?.addEventListener("input", (event) => {
      updateAccount(account.id, {
        name: event.target.value
      });
    });

    const codexHomeInput = document.getElementById(`path-${account.id}`);
    codexHomeInput?.addEventListener("input", (event) => {
      const nextCodexHome = event.target.value;
      updateAccount(account.id, {
        codexHome: nextCodexHome,
        liveEnabled: false
      });
      clearAccountRuntimeState(account.id);
    });

    document.getElementById(`default-${account.id}`)?.addEventListener("click", (event) => {
      event.stopPropagation();
      const suggestedPath = suggestCodexHome(index);
      updateAccount(account.id, { codexHome: suggestedPath, liveEnabled: account.id === accounts[0]?.id });
      clearAccountRuntimeState(account.id);
      setStatus("Default CODEX_HOME restored.", "ok");
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

function handleSettingDragStart(event) {
  const accountId = event.currentTarget?.dataset?.accountId;
  if (!accountId) {
    return;
  }

  draggedSettingId = accountId;
  dropTargetSettingId = accountId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", accountId);
  }
  render();
}

function handleSettingDragOver(event) {
  event.preventDefault();
  const accountId = event.currentTarget?.dataset?.accountId;
  if (!accountId) {
    return;
  }

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }

  if (dropTargetSettingId !== accountId) {
    dropTargetSettingId = accountId;
    render();
  }
}

function handleSettingDrop(event) {
  event.preventDefault();
  const targetAccountId = event.currentTarget?.dataset?.accountId;
  if (!draggedSettingId || !targetAccountId || draggedSettingId === targetAccountId) {
    draggedSettingId = null;
    dropTargetSettingId = null;
    render();
    return;
  }

  reorderAccounts(draggedSettingId, targetAccountId);
  draggedSettingId = null;
  dropTargetSettingId = null;
  setStatus("Account order updated.", "ok");
  render();
}

function handleSettingDragEnd() {
  draggedSettingId = null;
  dropTargetSettingId = null;
  render();
}

function reorderAccounts(sourceId, targetId) {
  const sourceIndex = accounts.findIndex((account) => account.id === sourceId);
  const targetIndex = accounts.findIndex((account) => account.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return;
  }

  const nextAccounts = [...accounts];
  const [movedAccount] = nextAccounts.splice(sourceIndex, 1);
  nextAccounts.splice(targetIndex, 0, movedAccount);
  accounts = nextAccounts;
  saveAccounts();
}

function buildOverallBarMarkup() {
  if (accounts.length === 0) {
    return `
      <span class="overall-segment" style="width:100%;">
        <span class="overall-segment-fill" style="width:0%;background:${COLORS[0]};"></span>
      </span>
    `;
  }

  const totalWeight = accounts.reduce((sum, account) => sum + getAccountWeight(account), 0) || accounts.length;

  return accounts
    .map((account, index) => {
      const percentage = getRemainingPercentForAccount(account) ?? 0;
      const width = (getAccountWeight(account) / totalWeight) * 100;
      const color = COLORS[index % COLORS.length];

      return `
        <span class="overall-segment" style="width:${width}%;">
          <span class="overall-segment-fill" style="width:${Math.min(percentage, 100)}%;background:${color};"></span>
        </span>
      `;
    })
    .join("");
}

function buildAccountsMarkup() {
  if (accounts.length === 0) {
    return `<div class="panel-empty">No accounts configured.</div>`;
  }

  return `
    <div class="accounts-list">
      ${accounts
        .map((account, index) => {
          const remainingPercentage = getRemainingPercentForAccount(account);
          const percentage = remainingPercentage ?? 0;
          const color = COLORS[index % COLORS.length];
          const valueLabel = getAccountValueLabel(account, remainingPercentage);

          return `
            <div class="account-item">
              <div class="account-row">
                <span class="account-name">${escapeHtml(account.name)}</span>
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

      return `
        <div
          class="setting-card ${isOpen ? "is-open" : ""} ${dropTargetSettingId === account.id ? "is-drop-target" : ""}"
          data-account-id="${escapeHtmlAttribute(account.id)}"
        >
          <div
            class="setting-row setting-row-draggable"
            data-account-id="${escapeHtmlAttribute(account.id)}"
            draggable="true"
            aria-label="Drag to reorder ${escapeHtmlAttribute(account.name)}"
          >
            <div class="setting-copy">
              <span class="setting-name">${escapeHtml(account.name)}</span>
              <span class="setting-meta">${escapeHtml(statusSummary)}</span>
            </div>
            <div class="setting-actions">
              <button
                id="toggle-${account.id}"
                type="button"
                class="list-action-btn"
                aria-label="${isOpen ? "Collapse" : "Expand"} ${escapeHtml(account.name)}"
              >
                ${isOpen ? getChevronUpIcon() : getChevronDownIcon()}
              </button>
              <button
                id="remove-${account.id}"
                type="button"
                class="list-action-btn is-danger"
                aria-label="Remove ${escapeHtml(account.name)}"
              >
                ${getTrashIcon()}
              </button>
            </div>
          </div>
          ${isOpen ? buildSettingsDetailMarkup(account, index, status) : ""}
        </div>
      `;
    })
    .join("");
}

function buildSettingsDetailMarkup(account, index, status) {
  const steps = getSetupSteps(account, status);
  const isChecking = Boolean(status?.isChecking);
  const isSyncing = Boolean(latestResults[account.id]?.isLoading);
  const canOpenLogin = Boolean(account.codexHome.trim() && status?.cliInstalled);
  const canSync = Boolean(account.codexHome.trim());

  return `
    <div class="setting-detail">
      <div class="field-group">
        <label class="field-label" for="name-${account.id}">Display Name</label>
        <input id="name-${account.id}" class="field-input" type="text" value="${escapeHtmlAttribute(account.name)}" />
      </div>
      <div class="field-group">
        <div class="field-label-row">
          <label class="field-label" for="path-${account.id}">CODEX_HOME</label>
          <button id="default-${account.id}" type="button" class="inline-link-btn">Default path</button>
        </div>
        <input id="path-${account.id}" class="field-input field-input-mono" type="text" value="${escapeHtmlAttribute(account.codexHome)}" />
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
          Open Login
        </button>
        <button id="sync-${account.id}" type="button" class="primary-btn" ${canSync && !isSyncing ? "" : "disabled"}>
          ${isSyncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>
      <div class="helper-note">
        ${escapeHtml(getHelperText(account, status, index))}
      </div>
    </div>
  `;
}

function getSetupSteps(account, status) {
  const profileStatus = status || {};

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
      text: account.codexHome.trim()
        ? profileStatus.authExists
          ? `Logged in at ${account.codexHome.trim()}.`
          : "Use Open Login to run codex login with this CODEX_HOME."
        : "Set a CODEX_HOME path for this account first.",
      stateClass: profileStatus.authExists ? "is-complete" : account.codexHome.trim() ? "is-warning" : "is-idle"
    },
    {
      title: "Sync live quota",
      text: latestResults[account.id]?.ok
        ? "Live quota synced. The widget is using Codex data now."
        : latestResults[account.id]?.isLoading
          ? "Sync in progress."
          : account.liveEnabled
            ? "This account will auto-refresh live quota."
            : "This account will sync automatically when the widget opens.",
      stateClass: latestResults[account.id]?.ok ? "is-complete" : latestResults[account.id]?.isLoading ? "is-warning" : "is-idle"
    }
  ];
}

function getHelperText(account, status, index) {
  if (!account.codexHome.trim()) {
    return `Suggested path: ${suggestCodexHome(index) || "Set a profile path manually."}`;
  }

  if (status?.ready) {
    return account.liveEnabled
      ? "This profile is connected. Sync now to refresh live quota immediately."
      : "This profile is ready. It will sync automatically when the widget opens.";
  }

  if (!status?.cliInstalled) {
    return "Codex CLI is missing. Install it globally before continuing.";
  }

  if (!status?.authExists) {
    return "Open Login starts a terminal window with CODEX_HOME set for this account.";
  }

  return status?.message || "Use Check Setup to refresh this account state.";
}

function normalizeDefaultAccounts(rawAccounts) {
  const base = Array.isArray(rawAccounts) && rawAccounts.length > 0 ? rawAccounts : [];
  const length = Math.max(base.length, SAMPLE_ACCOUNT_SEEDS.length, 3);

  return Array.from({ length }, (_, index) => ({
    name: base[index]?.name || `Account ${index + 1}`,
    codexHome: typeof base[index]?.codexHome === "string" ? base[index].codexHome.trim() : ""
  }));
}

function buildInitialAccounts(fallbackDefaults) {
  return Array.from({ length: Math.max(SAMPLE_ACCOUNT_SEEDS.length, fallbackDefaults.length, 3) }, (_, index) => {
    const sampleSeed = SAMPLE_ACCOUNT_SEEDS[index] || makeSampleSeed(index);
    const defaultAccount = fallbackDefaults[index] || { codexHome: "" };
    const resolvedCodexHome = defaultAccount.codexHome || "";

    return {
      id: createId(index),
      name: `Account ${index + 1}`,
      codexHome: resolvedCodexHome,
      liveEnabled: Boolean(resolvedCodexHome),
      sampleUsed: 0,
      sampleLimit: 1000,
      sampleResetDate: createResetDate(30)
    };
  });
}

function loadStoredAccounts(fallbackDefaults) {
  try {
    const { raw, isLegacy } = readStoredAccounts();
    if (!raw) {
      return hydrateDynamicDefaults(buildInitialAccounts(fallbackDefaults), fallbackDefaults);
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return hydrateDynamicDefaults(buildInitialAccounts(fallbackDefaults), fallbackDefaults);
    }

    const sanitized = parsed
      .map((account, index) =>
        sanitizeAccount(account, index, fallbackDefaults[index], {
          isLegacy
        })
      )
      .filter(Boolean);

    return sanitized.length > 0
      ? hydrateDynamicDefaults(sanitized, fallbackDefaults)
      : hydrateDynamicDefaults(buildInitialAccounts(fallbackDefaults), fallbackDefaults);
  } catch {
    return hydrateDynamicDefaults(buildInitialAccounts(fallbackDefaults), fallbackDefaults);
  }
}

function readStoredAccounts() {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current) {
    return { raw: current, isLegacy: false };
  }

  for (const key of LEGACY_STORAGE_KEYS) {
    const legacy = localStorage.getItem(key);
    if (legacy) {
      return { raw: legacy, isLegacy: true };
    }
  }

  return { raw: null, isLegacy: false };
}

function sanitizeAccount(account, index, fallbackDefault, options = {}) {
  if (!account || typeof account !== "object") {
    return null;
  }

  const seed = SAMPLE_ACCOUNT_SEEDS[index] || makeSampleSeed(index);
  const sampleUsed = Number(account.sampleUsed ?? account.used);
  const sampleLimit = Number(account.sampleLimit ?? account.limit);
  const sampleResetDate =
    typeof account.sampleResetDate === "string"
      ? account.sampleResetDate
      : typeof account.resetDate === "string"
        ? account.resetDate
        : createResetDate(seed.resetOffsetDays);

  const sanitized = {
    id: typeof account.id === "string" && account.id.trim() ? account.id.trim() : createId(index),
    name:
      typeof account.name === "string" && account.name.trim()
        ? account.name.trim()
        : seed.name || `Account ${index + 1}`,
    codexHome:
      typeof account.codexHome === "string" && account.codexHome.trim()
        ? account.codexHome.trim()
        : fallbackDefault?.codexHome || "",
    liveEnabled: typeof account.liveEnabled === "boolean" ? account.liveEnabled : index === 0,
    sampleUsed: Number.isFinite(sampleUsed) && sampleUsed >= 0 ? sampleUsed : seed.used,
    sampleLimit: Number.isFinite(sampleLimit) && sampleLimit > 0 ? sampleLimit : seed.limit,
    sampleResetDate
  };

  if (options.isLegacy && index > 0) {
    return {
      ...sanitized,
      name: `Account ${index + 1}`,
      codexHome: "",
      liveEnabled: false,
      sampleUsed: 0,
      sampleLimit: 1000,
      sampleResetDate: createResetDate(30)
    };
  }

  return sanitized;
}

function hydrateDynamicDefaults(accountList, fallbackDefaults) {
  return accountList.map((account, index) => {
    const suggestedCodexHome =
      typeof account.codexHome === "string" && account.codexHome.trim()
        ? account.codexHome.trim()
        : fallbackDefaults[index]?.codexHome || suggestCodexHome(index);

    return {
      ...account,
      codexHome: suggestedCodexHome,
      liveEnabled: suggestedCodexHome ? true : Boolean(account.liveEnabled)
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
  saveAccounts();
}

function clearAccountRuntimeState(accountId) {
  latestResults[accountId] = null;
  profileStatuses[accountId] = null;
}

function saveAccounts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) {
      return {
        alwaysOnTop: false,
        glassOpacity: 100
      };
    }

    const parsed = JSON.parse(raw);
    return {
      alwaysOnTop: Boolean(parsed?.alwaysOnTop),
      glassOpacity: clampGlassOpacity(parsed?.glassOpacity)
    };
  } catch {
    return {
      alwaysOnTop: false,
      glassOpacity: 100
    };
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

function applyMaterialPreferences() {
  const normalizedOpacity = (preferences.glassOpacity || 100) / 100;
  const highlightOpacity = Math.max(0.68, Math.min(1.02, 1.02 - (normalizedOpacity - 1) * 0.55));
  document.documentElement.style.setProperty("--glass-base-opacity", String(normalizedOpacity));
  document.documentElement.style.setProperty("--glass-highlight-opacity", String(highlightOpacity));
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

function addAccount() {
  const nextIndex = accounts.length;
  const seed = SAMPLE_ACCOUNT_SEEDS[nextIndex] || makeSampleSeed(nextIndex);
  const account = {
    id: createId(nextIndex),
    name: `Account ${nextIndex + 1}`,
    codexHome: suggestCodexHome(nextIndex),
    liveEnabled: false,
    sampleUsed: seed.used,
    sampleLimit: seed.limit,
    sampleResetDate: createResetDate(seed.resetOffsetDays)
  };

  accounts = [...accounts, account];
  latestResults = ensureMapForAccounts(accounts, latestResults);
  profileStatuses = ensureMapForAccounts(accounts, profileStatuses);
  expandedSettingId = account.id;
  saveAccounts();
  setStatus("Sample account added. Configure CODEX_HOME to connect live quota.", "ok");
  render();
}

function removeAccount(accountId) {
  accounts = accounts.filter((account) => account.id !== accountId);
  delete latestResults[accountId];
  delete profileStatuses[accountId];
  if (expandedSettingId === accountId) {
    expandedSettingId = accounts[0]?.id || null;
  }
  saveAccounts();
  setStatus("Account removed.", "ok");
  render();
}

async function refreshProfileStates(options = {}) {
  await Promise.all(accounts.map((account) => checkProfileStatus(account.id, { syncIfReady: options.syncReadyAccounts })));
  updateGlobalStatus();
  render();
}

async function refreshReadyAccounts() {
  await Promise.all(
    accounts.map(async (account) => {
      const status = profileStatuses[account.id];
      if (!status?.ready || !account.liveEnabled) {
        return;
      }

      await refreshAccount(account.id);
    })
  );

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
    profileStatuses[accountId] = {
      ...response,
      isChecking: false,
      checkedAtMs: Date.now()
    };
    syncAccountIdentity(accountId, response?.profileEmail);

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
    if (!response?.ok) {
      latestResults[accountId] = {
        ok: false,
        error: response?.error || "Unable to fetch rate limits.",
        isLoading: false,
        updatedAtMs: Date.now()
      };
      setStatus(`Live sync failed for ${account.name}. This account stays empty until sync succeeds.`, "error");
      return;
    }

    latestResults[accountId] = {
      ok: true,
      rateLimits: response.rateLimits,
      profileEmail: response?.profileEmail || null,
      isLoading: false,
      updatedAtMs: Date.now()
    };
    syncAccountIdentity(accountId, response?.profileEmail);
    updateAccount(accountId, { liveEnabled: true });
    setStatus(`Live quota synced for ${account.name}.`, "ok");
  } catch (error) {
    latestResults[accountId] = {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected error while fetching rate limits.",
      isLoading: false,
      updatedAtMs: Date.now()
    };
    setStatus(`Live sync failed for ${account.name}. This account stays empty until sync succeeds.`, "error");
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
    setStatus("Enter a CODEX_HOME path before opening login.", "error");
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

    setStatus(`Opened Codex login terminal for ${account.name}. Finish login, then click Check Setup.`, "ok");
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

function getAccountWeight(account) {
  const liveEntry = latestResults[account.id];
  if (liveEntry?.ok) {
    return 1;
  }

  return 1;
}

function getLegacyAccountFooterText(account) {
  const liveEntry = latestResults[account.id];
  if (liveEntry?.isLoading) {
    return "Syncing live quota...";
  }

  if (liveEntry?.ok) {
    const resetSeconds = liveEntry.rateLimits?.secondary?.resetsAt;
    if (typeof resetSeconds === "number") {
      const resetDate = new Date(resetSeconds * 1000);
      if (!Number.isNaN(resetDate.getTime())) {
        return `Live data · Resets ${resetDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
        return `Live data - Resets ${resetDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      }
    }

    return "Live data";
  }

  if (liveEntry?.error) {
    if (shouldUseSampleFallback(account)) {
      return "Sample data fallback";
    }

    return "Not connected";
  }

  if (shouldUseSampleFallback(account)) {
    return `Sample data - Resets ${formatSampleReset(account.sampleResetDate)}`;
  }

  return "Not connected";
}

function getSettingsSummary(account, status) {
  if (latestResults[account.id]?.ok) {
    return "Connected - Live quota synced";
  }

  if (latestResults[account.id]?.error) {
    return "Sync failed";
  }

  if (status?.isChecking) {
    return "Checking setup...";
  }

  if (!account.codexHome.trim()) {
    return "Not connected - Add a CODEX_HOME path";
  }

  if (status?.ready) {
    return account.liveEnabled ? "Connected - Awaiting refresh" : "Ready - Auto-syncs on open";
  }

  if (status?.authExists) {
    return "Logged in - Run sync";
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

function formatSampleReset(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function updateGlobalStatus() {
  const liveCount = accounts.filter((account) => latestResults[account.id]?.ok).length;
  const readyCount = accounts.filter((account) => profileStatuses[account.id]?.ready).length;
  const failedCount = accounts.filter((account) => latestResults[account.id]?.error).length;

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

function suggestCodexHome(index) {
  const fallback = defaultAccounts[index];
  if (fallback?.codexHome) {
    return fallback.codexHome;
  }

  const firstPath = defaultAccounts[0]?.codexHome || "";
  const match = firstPath.match(/^(.*[\\/])\.codex(?:-\d+)?$/i);
  if (!match) {
    return "";
  }

  return `${match[1]}.codex-${index + 1}`;
}

function makeSampleSeed(index) {
  return {
    name: `Account ${index + 1}`,
    used: 0,
    limit: 1000,
    resetOffsetDays: 30
  };
}

function createResetDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString();
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

function createId(seed) {
  return globalThis.crypto?.randomUUID?.() || `account-${Date.now()}-${seed}-${Math.random().toString(16).slice(2, 8)}`;
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

function getTrashIcon() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path
        d="M9 3a1 1 0 0 0-.9.55L7.38 5H4a1 1 0 1 0 0 2h1l1 12a2 2 0 0 0 2 1.83h8a2 2 0 0 0 2-1.83L19 7h1a1 1 0 1 0 0-2h-3.38l-.72-1.45A1 1 0 0 0 15 3H9Zm-.99 4h7.98l-.92 11H8.93L8.01 7Zm2.99 2a1 1 0 0 0-1 1v5a1 1 0 1 0 2 0v-5a1 1 0 0 0-1-1Zm4 0a1 1 0 0 0-1 1v5a1 1 0 1 0 2 0v-5a1 1 0 0 0-1-1Z"
        fill="currentColor"
      />
    </svg>
  `;
}

function getPlusIcon() {
  return `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path
        d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5Z"
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
