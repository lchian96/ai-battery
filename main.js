const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ACCOUNT_COUNT = 3;
const APP_SERVER_TIMEOUT_MS = 12000;
const RATE_LIMIT_RETRY_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 700;
const WINDOW_SIZE = {
  width: 228,
  height: 59,
  minWidth: 228,
  minHeight: 59,
  maxWidth: 228,
  maxHeight: 680
};

let cachedCliRuntime = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let collapsedWindowAnchor = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="10" y="10" width="44" height="44" rx="14" fill="#60a5fa"/>
      <path d="M34.5 14 21 32h8l-1.5 18L43 28h-8l1.5-14Z" fill="#090909"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function showMainWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow) {
    return;
  }

  mainWindow.hide();
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip("AI Battery");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open",
        click: () => showMainWindow()
      },
      {
        label: "Hide",
        click: () => hideMainWindow()
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );

  tray.on("click", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isVisible()) {
      hideMainWindow();
    } else {
      showMainWindow();
    }
  });

  tray.on("double-click", () => {
    showMainWindow();
  });

  return tray;
}

function getCodexCliScriptPath() {
  const appData = process.env.APPDATA;
  if (!appData) {
    return null;
  }

  return path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
}

function getDefaultAccounts() {
  const home = os.homedir();
  return Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
    name: `Account ${index + 1}`,
    codexHome: index === 0 ? path.join(home, ".codex") : path.join(home, `.codex-${index + 1}`)
  }));
}

function decodeJwtPayload(token) {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function readProfileIdentity(codexHome) {
  const trimmedPath = typeof codexHome === "string" ? codexHome.trim() : "";
  if (!trimmedPath) {
    return null;
  }

  const authPath = path.join(trimmedPath, "auth.json");
  if (!fs.existsSync(authPath)) {
    return null;
  }

  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const payload = decodeJwtPayload(auth?.tokens?.id_token);
    const email = typeof payload?.email === "string" ? payload.email.trim() : "";
    const name = typeof payload?.name === "string" ? payload.name.trim() : "";
    if (!email && !name) {
      return null;
    }

    return {
      email: email || null,
      name: name || null
    };
  } catch {
    return null;
  }
}

function getProfileStatus(codexHome) {
  const trimmedPath = typeof codexHome === "string" ? codexHome.trim() : "";
  const codexCliScriptPath = getCodexCliScriptPath();
  const cliInstalled = Boolean(codexCliScriptPath && fs.existsSync(codexCliScriptPath));

  if (!trimmedPath) {
    return {
      ok: true,
      cliInstalled,
      codexCliScriptPath,
      codexHome: "",
      pathExists: false,
      authExists: false,
      ready: false,
      message: "Enter a CODEX_HOME path to configure this account."
    };
  }

  const pathExists = fs.existsSync(trimmedPath);
  const authExists = pathExists && fs.existsSync(path.join(trimmedPath, "auth.json"));
  const ready = cliInstalled && authExists;
  const profileIdentity = authExists ? readProfileIdentity(trimmedPath) : null;

  let message = "Profile ready to sync.";
  if (!cliInstalled) {
    message = "Install the Codex CLI first: npm install -g @openai/codex";
  } else if (!pathExists) {
    message = "Profile folder does not exist yet. Run login to create it.";
  } else if (!authExists) {
    message = "Profile exists, but this CODEX_HOME is not logged in yet.";
  }

  return {
    ok: true,
    cliInstalled,
    codexCliScriptPath,
    codexHome: trimmedPath,
    profileEmail: profileIdentity?.email || null,
    profileName: profileIdentity?.name || null,
    pathExists,
    authExists,
    ready,
    message
  };
}

function escapeCmdValue(value) {
  return String(value ?? "").replace(/"/g, '""');
}

function createLoginScript(codexHome, cliRuntime, codexCliScriptPath) {
  const scriptPath = path.join(os.tmpdir(), `ai-battery-login-${Date.now()}.cmd`);
  const lines = [
    "@echo off",
    "title Codex Login - AI Battery",
    `set "CODEX_HOME=${escapeCmdValue(codexHome)}"`,
    cliRuntime.forceElectronRunAsNode ? 'set "ELECTRON_RUN_AS_NODE=1"' : "",
    "echo Running Codex login for:",
    "echo   %CODEX_HOME%",
    "echo.",
    `"${cliRuntime.command}" "${codexCliScriptPath}" login`,
    "echo.",
    "echo Codex login finished with exit code %errorlevel%.",
    "echo Close this window and return to the widget.",
    "echo.",
    "pause"
  ].filter(Boolean);

  fs.writeFileSync(scriptPath, `${lines.join("\r\n")}\r\n`, "utf8");
  return scriptPath;
}

function openCodexLoginTerminal(codexHome) {
  const trimmedPath = typeof codexHome === "string" ? codexHome.trim() : "";
  if (!trimmedPath) {
    throw new Error("Enter a CODEX_HOME path before starting login.");
  }

  const codexCliScriptPath = getCodexCliScriptPath();
  if (!codexCliScriptPath || !fs.existsSync(codexCliScriptPath)) {
    throw new Error("User-level Codex CLI not found. Run: npm install -g @openai/codex");
  }

  fs.mkdirSync(trimmedPath, { recursive: true });

  const cliRuntime = getCliRuntime();
  const scriptPath = createLoginScript(trimmedPath, cliRuntime, codexCliScriptPath);
  const child = spawn("cmd.exe", ["/d", "/k", scriptPath], {
    windowsHide: false,
    detached: true,
    shell: false,
    cwd: trimmedPath
  });

  child.unref();
}

function getCliRuntime() {
  if (cachedCliRuntime) {
    return cachedCliRuntime;
  }

  const candidates = [
    process.env.NODE_BINARY,
    process.env.NODE,
    process.env.NODE_EXE,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs", "node.exe") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe") : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedCliRuntime = { command: candidate, forceElectronRunAsNode: false };
      return cachedCliRuntime;
    }
  }

  const lookup = spawnSync("where.exe", ["node"], {
    windowsHide: true,
    encoding: "utf8"
  });

  if (lookup.status === 0) {
    const discoveredPath = lookup.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line));

    if (discoveredPath) {
      cachedCliRuntime = { command: discoveredPath, forceElectronRunAsNode: false };
      return cachedCliRuntime;
    }
  }

  cachedCliRuntime = {
    command: process.execPath,
    forceElectronRunAsNode: Boolean(process.versions.electron)
  };
  return cachedCliRuntime;
}

function buildCodexEnv(codexHome, forceElectronRunAsNode = false) {
  const env = { ...process.env, NO_COLOR: "1" };
  if (codexHome) {
    env.CODEX_HOME = codexHome;
  }
  if (forceElectronRunAsNode) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function readRateLimitsFromAppServer(codexHome) {
  const codexCliScriptPath = getCodexCliScriptPath();

  return new Promise((resolve, reject) => {
    if (!codexCliScriptPath || !fs.existsSync(codexCliScriptPath)) {
      reject(new Error("User-level Codex CLI not found. Install with: npm install -g @openai/codex"));
      return;
    }

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const initializeRequestId = "init-1";
    const rateLimitRequestId = "limits-1";
    const cliRuntime = getCliRuntime();

    const child = spawn(cliRuntime.command, [codexCliScriptPath, "app-server", "--listen", "stdio://"], {
      env: buildCodexEnv(codexHome, cliRuntime.forceElectronRunAsNode),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const done = (error, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      child.kill();

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const timeoutHandle = setTimeout(() => {
      done(new Error("Timed out while reading rate limits from Codex app-server."));
    }, APP_SERVER_TIMEOUT_MS);

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        done(error);
      }
    };

    const handleMessage = (message) => {
      if (message.id === initializeRequestId && message.result) {
        send({ method: "initialized" });
        send({ id: rateLimitRequestId, method: "account/rateLimits/read" });
        return;
      }

      if (message.id === rateLimitRequestId) {
        if (message.result?.rateLimits) {
          done(null, message.result.rateLimits);
          return;
        }
        if (message.error) {
          done(new Error(message.error.message || "Failed to read rate limits."));
        }
      }

      if (message.method === "error" && message.params?.message) {
        done(new Error(message.params.message));
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;

      let lineBreakIndex = stdoutBuffer.indexOf("\n");
      while (lineBreakIndex !== -1) {
        const line = stdoutBuffer.slice(0, lineBreakIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);

        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {
            // Ignore non-JSON lines from stdout.
          }
        }

        lineBreakIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
    });

    child.on("error", (error) => {
      done(error);
    });

    child.on("close", (code) => {
      if (!settled) {
        done(new Error(stderrBuffer.trim() || `app-server exited with code ${String(code)}`));
      }
    });

    send({
      id: initializeRequestId,
      method: "initialize",
      params: {
        clientInfo: {
          name: "ai-battery",
          title: "AI Battery",
          version: "1.0.0"
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: []
        }
      }
    });
  });
}

async function readRateLimitsWithRetries(codexHome, attempts = RATE_LIMIT_RETRY_ATTEMPTS) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readRateLimitsFromAppServer(codexHome);
    } catch (error) {
      lastError = error;

      if (attempt >= attempts) {
        throw error;
      }

      await delay(RATE_LIMIT_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError || new Error("Unable to read rate limits.");
}

ipcMain.handle("quota:get-defaults", () => ({
  accounts: getDefaultAccounts(),
  codexCliScriptPath: getCodexCliScriptPath()
}));

ipcMain.handle("quota:profile-status", (_event, payload) => {
  try {
    return getProfileStatus(payload?.codexHome);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to inspect profile state."
    };
  }
});

ipcMain.handle("quota:open-login", (_event, payload) => {
  try {
    openCodexLoginTerminal(payload?.codexHome);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to open Codex login."
    };
  }
});

ipcMain.handle("quota:fetch", async (_event, payload) => {
  try {
    const codexHome = typeof payload?.codexHome === "string" ? payload.codexHome.trim() : "";
    if (!codexHome) {
      return { ok: false, error: "Missing CODEX_HOME path." };
    }

    if (!fs.existsSync(codexHome)) {
      return { ok: false, error: `CODEX_HOME path not found: ${codexHome}` };
    }

    if (!fs.existsSync(path.join(codexHome, "auth.json"))) {
      return {
        ok: false,
        error: "Not logged in for this account profile. Run `codex login` with this CODEX_HOME first."
      };
    }

    const codexCliScriptPath = getCodexCliScriptPath();
    if (!codexCliScriptPath || !fs.existsSync(codexCliScriptPath)) {
      return {
        ok: false,
        error: "User-level Codex CLI not found. Run: npm install -g @openai/codex"
      };
    }

    const rateLimits = await readRateLimitsWithRetries(codexHome);
    const profileIdentity = readProfileIdentity(codexHome);
    return {
      ok: true,
      rateLimits,
      profileEmail: profileIdentity?.email || null,
      profileName: profileIdentity?.name || null
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected error while fetching rate limits."
    };
  }
});

ipcMain.handle("window:sync-size", (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return null;
  }

  const requestedWidth = Number(payload?.width);
  const requestedHeight = Number(payload?.height);
  const width = Math.max(
    WINDOW_SIZE.minWidth,
    Math.min(WINDOW_SIZE.maxWidth, Number.isFinite(requestedWidth) ? Math.ceil(requestedWidth) : WINDOW_SIZE.width)
  );
  const height = Math.max(
    WINDOW_SIZE.minHeight,
    Math.min(WINDOW_SIZE.maxHeight, Number.isFinite(requestedHeight) ? Math.ceil(requestedHeight) : WINDOW_SIZE.height)
  );
  const panelPhase = typeof payload?.panelPhase === "string" ? payload.panelPhase : "collapsed";
  const [currentX, currentY] = window.getPosition();
  const currentBounds = window.getBounds();

  if (!collapsedWindowAnchor) {
    collapsedWindowAnchor = {
      x: currentX,
      y:
        panelPhase === "collapsed"
          ? currentY
          : Math.round(currentY + Math.max(0, currentBounds.height - WINDOW_SIZE.height) / 2)
    };
  }

  const nextX = collapsedWindowAnchor.x;
  const nextY =
    panelPhase === "collapsed" ? collapsedWindowAnchor.y : Math.round(collapsedWindowAnchor.y - (height - WINDOW_SIZE.height) / 2);

  const sizeChanged = currentBounds.width !== width || currentBounds.height !== height;
  const positionChanged = currentX !== nextX || currentY !== nextY;

  if (!sizeChanged && !positionChanged) {
    return { width, height };
  }

  if (sizeChanged) {
    window.setContentSize(width, height, true);
  }

  if (positionChanged) {
    window.setPosition(nextX, nextY, true);
  }

  return { width, height };
});

ipcMain.handle("window:get-position", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return null;
  }

  const [x, y] = window.getPosition();
  return { x, y };
});

ipcMain.handle("window:set-position", (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return null;
  }

  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const nextX = Math.round(x);
  const nextY = Math.round(y);
  const currentHeight = window.getBounds().height;
  collapsedWindowAnchor = {
    x: nextX,
    y: Math.round(nextY + Math.max(0, currentHeight - WINDOW_SIZE.height) / 2)
  };
  window.setPosition(nextX, nextY, true);
  return { x: nextX, y: nextY };
});

ipcMain.handle("window:set-always-on-top", (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return null;
  }

  const enabled = Boolean(payload?.enabled);
  window.setAlwaysOnTop(enabled, enabled ? "screen-saver" : "normal");
  return { enabled: window.isAlwaysOnTop() };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    minWidth: WINDOW_SIZE.minWidth,
    minHeight: WINDOW_SIZE.minHeight,
    maxWidth: WINDOW_SIZE.maxWidth,
    maxHeight: WINDOW_SIZE.maxHeight,
    useContentSize: true,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.loadFile("index.html");
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) {
      return;
    }

    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    hideMainWindow();
  });
}

app.whenReady().then(() => {
  createTray();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});
