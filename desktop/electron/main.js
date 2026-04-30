const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const AutoUpdaterService = require('./autoUpdater');

// creator-forge: Python research sidecar (FastAPI). Optional — desktop
// keeps working without it; only the Research/Studio/Producer tabs go dark.
const researchSidecar = require('./researchSidecar');
const researchIPC = require('./researchIPC');

const runtimeLogDir = (() => {
    try {
        return app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
    } catch (_) {
        return path.join(__dirname, '..');
    }
})();
try {
    fs.mkdirSync(runtimeLogDir, { recursive: true });
} catch (_) {}
const runtimeLogPath = path.join(runtimeLogDir, 'electron-runtime.log');
function writeRuntimeLog(level, ...args) {
    try {
        const line = `[${new Date().toISOString()}] [${level}] ${args.map(arg => {
            if (typeof arg === 'string') return arg;
            try { return JSON.stringify(arg); } catch (_) { return String(arg); }
        }).join(' ')}\n`;
        fs.appendFileSync(runtimeLogPath, line, 'utf8');
    } catch (_) {
        // Logging must never crash the app.
    }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
console.log = (...args) => {
    writeRuntimeLog('info', ...args);
    originalConsoleLog(...args);
};
console.error = (...args) => {
    writeRuntimeLog('error', ...args);
    originalConsoleError(...args);
};

// Windows/Electron GPU compositor can leave the window as a black surface after
// heavy video work. Force software rendering so renderer crashes do not become
// a persistent black window.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

process.stdout?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
});
process.stderr?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
});

let mainWindow;
let autoUpdaterService = null;

const PROMPT_ASSISTANT_URLS = new Set([
    'https://gemini.google.com/gem/11278ee360a5?usp=sharing',
    'https://gemini.google.com/gem/9eddfc6fe402',
    'https://chatgpt.com/g/g-69dcdbc2417c81919148122cd11755bb-tong-cong-trinh-su-prompt-quan-su',
    'https://gemini.google.com/gem/b50fa6b364ee',
    'https://gemini.google.com/gem/71b4d1a5c43f',
]);

function findSystemChromePath() {
    const candidates = [];
    if (process.platform === 'win32') {
        const prefixes = [
            process.env.PROGRAMFILES,
            process.env['PROGRAMFILES(X86)'],
            process.env.LOCALAPPDATA,
        ].filter(Boolean);
        for (const prefix of prefixes) {
            candidates.push(
                path.join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(prefix, 'Chromium', 'Application', 'chrome.exe'),
            );
        }
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
    }
    return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function openUrlInChrome(url) {
    return new Promise((resolve) => {
        const chromePath = findSystemChromePath();
        if (!chromePath) {
            shell.openExternal(url)
                .then(() => resolve({ success: true, browser: 'default' }))
                .catch(error => resolve({ success: false, error: error.message }));
            return;
        }
        let settled = false;
        const child = spawn(chromePath, [url], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
        });
        child.once('spawn', () => {
            settled = true;
            child.unref();
            resolve({ success: true, browser: 'chrome' });
        });
        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            shell.openExternal(url)
                .then(() => resolve({ success: true, browser: 'default', warning: error.message }))
                .catch(fallbackError => resolve({ success: false, error: fallbackError.message || error.message }));
        });
    });
}

function createWindow() {
    console.log('[Electron] Creating window...');
    console.log('[Electron] isDev:', isDev);
    console.log('[Electron] Preload path:', path.join(__dirname, 'preload.js'));

    // Remove menu bar completely
    Menu.setApplicationMenu(null);

    // creator-forge: which renderer page to load.
    //   default                  -> creator-forge.html (Research/Studio/Storyboard).
    //   CREATOR_FORGE_UI=autogrok -> dist/index.html (legacy AutoGrok UI; PR-9 fixes).
    const uiMode = (process.env.CREATOR_FORGE_UI || 'forge').toLowerCase();
    const useForgeUI = uiMode !== 'autogrok';
    const rendererFile = useForgeUI ? 'creator-forge.html' : 'index.html';
    const windowTitle = useForgeUI ? 'creator-forge' : 'AutoGrok ::: Hiếu Nghĩa MMO';

    mainWindow = new BrowserWindow({
        title: windowTitle,
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 700,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: isDev,
            backgroundThrottling: false,
        },
        backgroundColor: '#0a0a1a',
        show: true,
    });

    // Log page events
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('[Electron] Failed to load:', errorCode, errorDescription);
    });

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[Electron] Page loaded successfully');
        // creator-forge UI is self-contained — skip the AutoGrok DOM patches.
        if (useForgeUI) return;
        // Inject UI patches — delete is handled in renderer.js via __autogrokSetJobs
        mainWindow.webContents.executeJavaScript(`
            (function() {
                console.log('[Patch] Injecting UI fixes v2...');

                // 1. Ctrl+Shift+C emergency cancel
                document.addEventListener('keydown', (e) => {
                    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
                        e.preventDefault();
                        console.log('[Patch] Emergency cancel (Ctrl+Shift+C)');
                        if (window.electronAPI?.image?.cancel) {
                            window.electronAPI.image.cancel();
                        }
                    }
                });

                // 2. Make Stop button call backend cancel
                document.addEventListener('click', (e) => {
                    const btn = e.target.closest('button');
                    if (!btn) return;
                    const text = btn.textContent || '';
                    if (text.includes('Stop') || text.includes('stop')) {
                        console.log('[Patch] Stop button → calling image:cancel');
                        if (window.electronAPI?.image?.cancel) {
                            window.electronAPI.image.cancel();
                        }
                    }
                    if (text.includes('Clear') || text.includes('clear')) {
                        console.log('[Patch] Clear button → cancelling backend');
                        if (window.electronAPI?.image?.cancel) {
                            window.electronAPI.image.cancel();
                        }
                    }
                }, true);

                console.log('[Patch] UI fixes v2 injected successfully');
            })();
        `).catch((err) => console.error('[Electron] Patch injection error:', err));
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('[Electron] Renderer process gone:', details);
        if (mainWindow && !mainWindow.isDestroyed()) {
            setTimeout(() => {
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        console.log('[Electron] Reloading renderer after crash...');
                        mainWindow.loadFile(path.join(__dirname, '../dist/' + rendererFile));
                    }
                } catch (error) {
                    console.error('[Electron] Failed to reload renderer:', error.message);
                }
            }, 1000);
        }
    });

    mainWindow.on('unresponsive', () => {
        console.error('[Electron] Window became unresponsive');
        try {
            mainWindow.webContents.forcefullyCrashRenderer();
            mainWindow.webContents.reload();
        } catch (error) {
            console.error('[Electron] Failed to recover unresponsive renderer:', error.message);
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        try {
            console.log(`[Renderer] ${message}`);
        } catch (_) {
            // Ignore broken stdout pipes when Electron is launched detached.
        }
    });

    // Load the app - always load from dist
    const htmlPath = path.join(__dirname, '../dist/' + rendererFile);
    console.log('[Electron] Loading file:', htmlPath, '(uiMode=' + uiMode + ')');
    mainWindow.loadFile(htmlPath).catch(err => {
        console.error('[Electron] Failed to load file:', err);
    });

    mainWindow.on('closed', () => {
        console.log('[Electron] Window closed');
        mainWindow = null;
    });
}

// App lifecycle
app.whenReady().then(async () => {
    createWindow();

    // creator-forge: spawn the Python research sidecar in the background. Failure
    // is non-fatal — log it and let the user retry from the UI.
    //
    // Register IPC handlers BEFORE start() so that the renderer's first-load poll
    // (refreshSidecarStatus → producer:listVoices) hits a registered channel that
    // returns a friendly "sidecar is not running" error instead of Electron's
    // "No handler registered" log noise. Once the sidecar is healthy, getPort()
    // starts returning a port and the same handlers proxy through normally.
    researchSidecar.setLogSink((level, ...args) => writeRuntimeLog(level || 'info', '[research]', ...args));
    researchIPC.register({ ipcMain, sidecar: researchSidecar });
    researchSidecar
        .start()
        .then(({ port }) => {
            console.log(`[research] sidecar ready on :${port}`);
        })
        .catch((err) => {
            console.error('[research] sidecar failed to start:', err && err.message ? err.message : err);
        });

    // Initialize Auto Updater
    autoUpdaterService = new AutoUpdaterService();

    if (mainWindow && autoUpdaterService) {
        autoUpdaterService.setMainWindow(mainWindow);

        // Set auth validation callback for auto updater
        autoUpdaterService.setAuthValidationCallback(async () => {
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    const authStatus = await mainWindow.webContents.executeJavaScript(`
                        (function() {
                            try {
                                const token = localStorage.getItem('authToken');
                                const userDataStr = localStorage.getItem('userData');
                                if (!token || !userDataStr) {
                                    return { isAuthenticated: false, isActive: false };
                                }
                                const userData = JSON.parse(userDataStr);
                                return {
                                    isAuthenticated: true,
                                    isActive: userData?.role?.isActive === true
                                };
                            } catch (e) {
                                return { isAuthenticated: false, isActive: false };
                            }
                        })()
                    `);
                    console.log('[AutoUpdater] Auth status:', authStatus);
                    return authStatus;
                }
                return { isAuthenticated: false, isActive: false };
            } catch (error) {
                console.error('[AutoUpdater] Failed to get auth status:', error);
                return { isAuthenticated: false, isActive: false };
            }
        });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    if (researchSidecar.getPort()) {
        event.preventDefault();
        try { await researchSidecar.stop(); } catch (_) {}
        app.exit(0);
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Import services
const AuthService = require('../src/services/AuthService');
const AccountService = require('../src/services/AccountService');
const FileService = require('../src/services/FileService');
const ImageService = require('../src/services/ImageService');
const VideoService = require('../src/services/VideoService');
const I2VService = require('../src/services/I2VService');
const RefImageService = require('../src/services/RefImageService');
const LicenseService = require('../src/services/LicenseService');
const { openManualLogin: browserOpenManualLogin } = require('../src/browser');
const { SESSIONS_DIR: GROK_SESSIONS_DIR } = require('../src/config');

let licenseService = null;
function getLicenseService() {
    console.log('[BYPASS] LicenseService called - returning VALID');
    return {
        checkLicense: async () => ({ valid: true, message: 'Bypassed license' }),
        validateKey: async () => ({ valid: true, message: 'License activated (bypassed)' }),
        deactivate: () => {},
        getMachineId: () => 'bypassed-0000-0000-0000-unlimited'
    };
}

// IPC Handlers - File operations
ipcMain.handle('file:selectFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('file:selectFiles', async (_, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: options?.filters || []
    });
    return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('file:getImagesFromFolder', async (_, folderPath) => {
    const fs = require('fs');
    const path = require('path');

    try {
        const files = fs.readdirSync(folderPath);
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

        const imageFiles = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return imageExtensions.includes(ext);
            })
            .map(file => {
                const filePath = path.join(folderPath, file);
                const fileBuffer = fs.readFileSync(filePath);
                const base64Data = fileBuffer.toString('base64');
                const ext = path.extname(file).toLowerCase();
                const mimeType = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.bmp': 'image/bmp'
                }[ext] || 'image/jpeg';

                return {
                    name: file,
                    data: base64Data,
                    type: mimeType
                };
            });

        return imageFiles;
    } catch (error) {
        console.error('Error reading folder:', error);
        return [];
    }
});

ipcMain.handle('file:initDirectories', async () => {
    FileService.initializeDirectories();
    return { success: true };
});

// Read local file as base64 for renderer preview (file:// is blocked by Electron security)
ipcMain.handle('file:readFile', async (_, filePath) => {
    const fs = require('fs');
    try {
        const stats = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp'
        };
        if (mimeTypes[ext]?.startsWith('video/') && stats.size > 25 * 1024 * 1024) {
            return {
                tooLarge: true,
                size: stats.size,
                mimeType: mimeTypes[ext],
                fileUrl: pathToFileURL(filePath).href
            };
        }
        const buffer = fs.readFileSync(filePath);
        return {
            data: buffer.toString('base64'),
            mimeType: mimeTypes[ext] || 'application/octet-stream'
        };
    } catch (error) {
        console.error('[Main] Error reading file:', error.message);
        return null;
    }
});

ipcMain.handle('file:openFolder', async (_, folderPath) => {
    try {
        const target = folderPath || path.join(process.cwd(), 'images');
        await shell.openPath(target);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('file:showItemInFolder', async (_, filePath) => {
    try {
        shell.showItemInFolder(filePath);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('file:getFileUrl', async (_, filePath) => {
    try {
        const fs = require('fs');
        if (!filePath || !fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }
        return { success: true, url: pathToFileURL(filePath).href };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('file:openPath', async (_, filePath) => {
    try {
        const error = await shell.openPath(filePath);
        return error ? { success: false, error } : { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('assistant:open', async (_, assistantUrl) => {
    try {
        const url = String(assistantUrl || '').trim();
        if (!PROMPT_ASSISTANT_URLS.has(url)) {
            return { success: false, error: 'Link trợ lý không hợp lệ.' };
        }
        return await openUrlInChrome(url);
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('file:deleteFile', async (_, filePath) => {
    try {
        const fs = require('fs');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Lightweight size probe — used by renderer-side flows that only need to
// know whether a file passes the ≥50KB blur-rejection threshold (PR-9). We
// reply with `{ exists, size }` so a missing file is a soft signal rather
// than an exception that has to be caught in the renderer.
ipcMain.handle('file:statBytes', async (_, filePath) => {
    try {
        const fs = require('fs');
        if (!filePath) return { exists: false, size: 0 };
        const stats = fs.statSync(filePath);
        return { exists: true, size: Number(stats.size) || 0 };
    } catch (error) {
        return { exists: false, size: 0 };
    }
});

ipcMain.handle('account:importTxt', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Import accounts from TXT',
            filters: [{ name: 'Text Files', extensions: ['txt'] }],
            properties: ['openFile']
        });
        if (result.canceled || !result.filePaths.length) return { success: false, accounts: [] };
        const fs = require('fs');
        const content = fs.readFileSync(result.filePaths[0], 'utf8');
        const accounts = content.split('\n').map(l => l.trim()).filter(l => l && l.includes('|')).map(l => {
            const [email, password] = l.split('|');
            return { email: email.trim(), password: password.trim() };
        });
        return { success: true, accounts };
    } catch (error) {
        return { success: false, error: error.message, accounts: [] };
    }
});

// License Key IPC Handlers
ipcMain.handle('license:check', async () => {
    console.log('[BYPASS] license:check -> VALID');
    return { 
        valid: true, 
        message: 'License bypassed - unlimited access ✅',
        needsKey: false,
        expiry: null,
        features: ['all']
    };
});

ipcMain.handle('license:validate', async (_, key) => {
    console.log('[BYPASS] license:validate', key ? key.substring(0, 8) + '...' : 'empty');
    sendLog('success', 'License key đã được kích hoạt! (BYPASSED)');
    return { 
        valid: true, 
        message: 'License activated successfully - UNLIMITED',
        expiry: null 
    };
});

ipcMain.handle('license:deactivate', async () => {
    console.log('[BYPASS] license:deactivate');
    return { success: true, message: 'Deactivated (bypass active)' };
});

ipcMain.handle('license:getMachineId', async () => {
    return { machineId: 'BYPASSED-UNLIMITED-2026' };
});


// IPC Handlers - Account management
ipcMain.handle('account:load', async () => {
    try {
        const accounts = AccountService.loadAccounts();
        return { success: true, accounts };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('account:add', async (_, account) => {
    try {
        AccountService.addAccount(account);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('account:remove', async (_, email) => {
    try {
        AccountService.removeAccount(email);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('auth:getAccounts', async () => {
    const fs = require('fs');

    try {
        const userDataPath = path.join(app.getPath('userData'), 'accounts.json');

        // If accounts.json exists in userData, use it
        if (fs.existsSync(userDataPath)) {
            const data = fs.readFileSync(userDataPath, 'utf8');
            return JSON.parse(data);
        }

        // Migration: try to copy from bundled location (first run after update)
        const bundledPath = path.join(__dirname, '..', 'accounts.json');
        if (fs.existsSync(bundledPath)) {
            const data = fs.readFileSync(bundledPath, 'utf8');
            fs.writeFileSync(userDataPath, data, 'utf8');
            console.log('[Auth] Migrated accounts.json to userData');
            return JSON.parse(data);
        }

        return [];
    } catch (error) {
        console.error('Error loading accounts:', error);
        return [];
    }
});

ipcMain.handle('auth:saveAccounts', async (_, accounts) => {
    const fs = require('fs');

    try {
        const userDataPath = path.join(app.getPath('userData'), 'accounts.json');
        fs.writeFileSync(userDataPath, JSON.stringify(accounts, null, 4), 'utf8');
        console.log('[Auth] Saved accounts to:', userDataPath);
        return { success: true };
    } catch (error) {
        console.error('Error saving accounts:', error);
        throw error;
    }
});

// IPC Handlers - Authentication
ipcMain.handle('auth:setupAccounts', async (_, accounts) => {
    try {
        sendLog('info', `Setting up ${accounts.length} accounts (sequential)...`);
        const sessions = await AuthService.setupAccounts(accounts, (accNum, email, success, error) => {
            if (success) {
                sendLog('success', `Account ${accNum}/${accounts.length} ready: ${email}`);
            } else {
                sendLog('error', `Account ${accNum}/${accounts.length} failed: ${email} — ${error || 'Unknown error'}`);
            }
        });
        sendLog('success', `${sessions.length}/${accounts.length} accounts ready`);
        if (sessions.length === 0) {
            sendLog('error', 'All accounts failed to setup. Please check that Google Chrome or Microsoft Edge is installed.');
        }
        return { success: sessions.length > 0, sessions: sessions.length };
    } catch (error) {
        const msg = error?.message || String(error) || 'Unknown error';
        sendLog('error', `Setup failed: ${msg}`);
        return { success: false, error: msg };
    }
});

ipcMain.handle('auth:getSessions', async () => {
    const sessions = AuthService.getAllSessions();
    return { success: true, count: sessions.length };
});

ipcMain.handle('auth:clearSessions', async () => {
    AuthService.clearAllSessions();
    return { success: true };
});

// Open a headful Puppeteer window pointed at the Grok login page using a
// persistent userDataDir. The user logs in by hand; cookies/session are
// written to the profile dir and reused by ImageService/RefImageService etc.
// on the next launch. Defaults to GROK_SESSIONS_DIR/manual (which honors the
// GROK_PROFILE_DIR env override). Caller may pass `profileDir` to override.
ipcMain.handle('auth:openManualLogin', async (_, payload = {}) => {
    try {
        // GROK_SESSIONS_DIR already incorporates the GROK_PROFILE_DIR env
        // override (see desktop/src/config.js), so a separate env fallback
        // here would skip the `/manual` subdir and collide with the
        // per-email profile directories that setupAccount writes under
        // SESSIONS_DIR (e.g. saved_sessions.json + Default/).
        const profileDir = payload.profileDir
            || path.join(GROK_SESSIONS_DIR, 'manual');
        sendLog('info', `Opening manual Grok login (profile: ${profileDir})...`);
        const result = await browserOpenManualLogin({
            profileDir,
            label: 'GrokLogin',
            timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined,
        });
        if (result.ok) {
            sendLog('success', `Grok login complete — profile saved at ${result.profileDir}`);
        } else {
            sendLog('error', `Grok login failed: ${result.error || 'unknown error'}`);
        }
        return result;
    } catch (error) {
        const msg = error?.message || String(error) || 'Unknown error';
        sendLog('error', `auth:openManualLogin failed: ${msg}`);
        return { ok: false, profileDir: '', error: msg };
    }
});

// IPC Handlers - Image generation (parallel multi-account)
ipcMain.handle('image:generate', async (_, params) => {
    try {
        const { prompts, config, startIdx: baseIdx = 0 } = params;
        ImageService.resetCancel();
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        const perAcc = Math.ceil(prompts.length / sessions.length);
        sendLog('info', `Generating ${prompts.length} images across ${sessions.length} account(s) (${perAcc} per acc)...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const allResults = await Promise.all(
            sessions.map(async (session, ai) => {
                const sliceStart = ai * perAcc;
                const sliceEnd = Math.min((ai + 1) * perAcc, prompts.length);
                const myPrompts = prompts.slice(sliceStart, sliceEnd);
                if (myPrompts.length === 0) return [];
                const nameStart = baseIdx + sliceStart;
                sendLog('info', `[Acc${session.accIdx + 1}] 📋 Assigned prompts #${nameStart + 1}→#${nameStart + myPrompts.length} (${myPrompts.length} items)`);
                console.log(`[Main] [Acc${session.accIdx + 1}] Processing ${myPrompts.length} images...`);
                return ImageService.generateBatch(myPrompts, session, config || {}, (prompt, progress, result, localIdx) => {
                    const globalIdx = nameStart + (localIdx != null ? localIdx : 0);
                    sendProgress('image', { prompt, progress, result, globalIdx });
                    if (result) {
                        const status = result.success ? 'success' : 'error';
                        const label = result.title || prompt.substring(0, 50);
                        const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                        sendLog(status, `[Acc${session.accIdx + 1}] Image ${result.success ? '✅' : '❌'}: ${label}${errorMsg}`);
                    }
                }, nameStart).then(batchResults => batchResults.map(r => ({ ...r, globalIdx: nameStart + (r.localIdx != null ? r.localIdx : 0) })));
            })
        );

        const results = allResults.flat();
        const successCount = results.filter(r => r.success).length;
        sendLog('info', `Image generation complete: ${successCount}/${results.length} successful`);

        return { success: true, results };
    } catch (error) {
        sendLog('error', `Image generation error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// IPC Handler - Cancel image generation
ipcMain.handle('image:cancel', async () => {
    ImageService.cancelAll();
    sendLog('info', 'Image generation cancelled by user');
    return { success: true };
});

// IPC Handlers - Video generation (parallel multi-account)
ipcMain.handle('video:generate', async (_, params) => {
    try {
        const { prompts, config, startIdx: baseIdx = 0 } = params;
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        console.log('[Main] Video config received:', JSON.stringify(config, null, 2));
        const perAcc = Math.ceil(prompts.length / sessions.length);
        sendLog('info', `Generating ${prompts.length} videos across ${sessions.length} account(s) (${perAcc} per acc)...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const allResults = await Promise.all(
            sessions.map(async (session, ai) => {
                const sliceStart = ai * perAcc;
                const sliceEnd = Math.min((ai + 1) * perAcc, prompts.length);
                const myPrompts = prompts.slice(sliceStart, sliceEnd);
                if (myPrompts.length === 0) return [];
                const nameStart = baseIdx + sliceStart;
                sendLog('info', `[Acc${session.accIdx + 1}] 📋 Assigned prompts #${nameStart + 1}→#${nameStart + myPrompts.length} (${myPrompts.length} items)`);
                console.log(`[Main] [Acc${session.accIdx + 1}] Processing ${myPrompts.length} videos...`);
                return VideoService.generateBatch(myPrompts, session, config, (prompt, progress, result, localIdx) => {
                    const globalIdx = nameStart + (localIdx != null ? localIdx : 0);
                    sendProgress('video', { prompt, progress, result, globalIdx });
                    if (result) {
                        const status = result.success ? 'success' : 'error';
                        const label = result.title || prompt.substring(0, 50);
                        const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                        sendLog(status, `[Acc${session.accIdx + 1}] Video ${result.success ? '✅' : '❌'}: ${label}${errorMsg}`);
                    }
                }, nameStart).then(batchResults => batchResults.map(r => ({ ...r, globalIdx: nameStart + (r.localIdx != null ? r.localIdx : 0) })));
            })
        );

        const results = allResults.flat();
        const successCount = results.filter(r => r.success).length;
        sendLog('info', `Video generation complete: ${successCount}/${results.length} successful`);

        return { success: true, results };
    } catch (error) {
        sendLog('error', `Video generation error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

function getFfmpegPath() {
    const candidates = [
        process.env.FFMPEG_PATH,
        path.join(process.cwd(), 'bin', 'ffmpeg.exe'),
        path.join(process.cwd(), 'ffmpeg.exe'),
        path.join(process.cwd(), 'ffmpeg', 'ffmpeg.exe'),
        path.join(process.cwd(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
        path.join(__dirname, 'ffmpeg.exe'),
        path.join(__dirname, '..', 'ffmpeg', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe') : null,
        'ffmpeg',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate === 'ffmpeg' || fs.existsSync(candidate)) return candidate;
    }
    try {
        const localFfmpegDir = path.join(process.cwd(), 'ffmpeg');
        if (fs.existsSync(localFfmpegDir)) {
            const found = [];
            const walk = (dir, depth = 0) => {
                if (depth > 4 || found.length) return;
                for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, item.name);
                    if (item.isFile() && item.name.toLowerCase() === 'ffmpeg.exe') {
                        found.push(fullPath);
                        return;
                    }
                    if (item.isDirectory()) walk(fullPath, depth + 1);
                }
            };
            walk(localFfmpegDir);
            if (found[0]) return found[0];
        }
    } catch (_) {}
    return 'ffmpeg';
}

function runFfmpeg(args) {
    return new Promise((resolve) => {
        const ffmpegPath = getFfmpegPath();
        const child = spawn(ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (error) => {
            resolve({ code: -1, stdout, stderr, error });
        });
        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

function concatListLine(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${normalized}'`;
}

ipcMain.handle('video:merge', async (_, params) => {
    try {
        const inputFiles = Array.isArray(params?.files) ? params.files : [];
        const files = inputFiles
            .map(file => (typeof file === 'object' ? file?.path : file))
            .filter(Boolean)
            .map(file => path.resolve(String(file)));

        const uniqueFiles = [...new Set(files)];
        if (uniqueFiles.length < 2) {
            return { success: false, error: 'Vui lòng tích chọn ít nhất 2 video để ghép.' };
        }

        const videoExts = new Set(['.mp4', '.mov', '.m4v', '.webm']);
        for (const file of uniqueFiles) {
            if (!fs.existsSync(file)) {
                return { success: false, error: `Không tìm thấy video: ${file}` };
            }
            if (!videoExts.has(path.extname(file).toLowerCase())) {
                return { success: false, error: `File không phải video được hỗ trợ: ${file}` };
            }
        }

        const outputDir = params?.outputFolder
            ? path.resolve(String(params.outputFolder))
            : path.dirname(uniqueFiles[0]);
        fs.mkdirSync(outputDir, { recursive: true });

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = path.join(outputDir, `merged_${stamp}.mp4`);
        const listPath = path.join(os.tmpdir(), `autogrok_concat_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
        fs.writeFileSync(listPath, uniqueFiles.map(concatListLine).join('\n'), 'utf8');

        sendLog('info', `FFmpeg: đang ghép ${uniqueFiles.length} video...`);
        // Always re-encode. Stream-copy concat can create MP4 files that have audio
        // but render black in common Windows players when timestamps/codecs differ.
        const mergeArgs = [
            '-y',
            '-fflags', '+genpts',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-map', '0:v:0',
            '-map', '0:a?',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-ac', '2',
            '-movflags', '+faststart',
            '-avoid_negative_ts', 'make_zero',
            outputPath,
        ];
        const result = await runFfmpeg(mergeArgs);

        try { fs.unlinkSync(listPath); } catch (_) {}

        if (result.error?.code === 'ENOENT') {
            return {
                success: false,
                error: 'Không tìm thấy FFmpeg. Hãy đặt ffmpeg.exe tại ffmpeg/bin/ffmpeg.exe, app/bin/ffmpeg.exe, hoặc thêm FFmpeg vào PATH.',
            };
        }
        if (result.code !== 0 || !fs.existsSync(outputPath)) {
            return {
                success: false,
                error: (result.stderr || result.error?.message || 'FFmpeg ghép video thất bại').slice(-2000),
            };
        }

        sendLog('success', `Đã ghép video: ${outputPath}`);
        shell.showItemInFolder(outputPath);
        return { success: true, outputPath, count: uniqueFiles.length };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// IPC Handlers - I2V generation (parallel multi-account)
ipcMain.handle('i2v:generate', async (_, params) => {
    try {
        const { items, config, startIdx: baseIdx = 0 } = params;
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        const perAcc = Math.ceil(items.length / sessions.length);
        sendLog('info', `Generating ${items.length} I2V videos across ${sessions.length} account(s) (${perAcc} per acc)...`);
        const perAccountConcurrency = Math.max(1, Math.min(Number(config?.batchSize || 10), 30));
        sendLog('info', `I2V concurrency: ${sessions.length} account(s) x up to ${perAccountConcurrency}/account = up to ${sessions.length * perAccountConcurrency} parallel job(s)`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const allResults = await Promise.all(
            sessions.map(async (session, ai) => {
                const sliceStart = ai * perAcc;
                const sliceEnd = Math.min((ai + 1) * perAcc, items.length);
                const myItems = items.slice(sliceStart, sliceEnd);
                if (myItems.length === 0) return [];
                const nameStart = baseIdx + sliceStart;
                const imgNames = myItems.map(it => path.basename(it.imagePath)).join(', ');
                sendLog('info', `[Acc${session.accIdx + 1}] 📋 Assigned items #${nameStart + 1}→#${nameStart + myItems.length} (${myItems.length} items): ${imgNames}`);
                console.log(`[Main] [Acc${session.accIdx + 1}] Processing ${myItems.length} I2V items...`);
                return I2VService.generateBatch(myItems, session, config, (item, progress, result, localIdx) => {
                    const globalIdx = nameStart + (localIdx != null ? localIdx : 0);
                    sendProgress('i2v', { item, progress, result, globalIdx });
                    if (result) {
                        const status = result.success ? 'success' : 'error';
                        const imgName = item.imagePath ? path.basename(item.imagePath) : '';
                        const label = result.title || item.prompt.substring(0, 50);
                        const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                        sendLog(status, `[Acc${session.accIdx + 1}] I2V ${result.success ? '✅' : '❌'}: ${label} [${imgName}]${errorMsg}`);
                    }
                }, nameStart).then(batchResults => batchResults.map(r => ({ ...r, globalIdx: nameStart + (r.localIdx != null ? r.localIdx : 0) })));
            })
        );

        const results = allResults.flat();
        const successCount = results.filter(r => r.success).length;
        sendLog('info', `I2V generation complete: ${successCount}/${results.length} successful`);

        return { success: true, results };
    } catch (error) {
        sendLog('error', `I2V generation error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// IPC Handlers - Ref Image generation (parallel multi-account)
ipcMain.handle('refimg:generate', async (_, params) => {
    try {
        const { items, config, startIdx: baseIdx = 0 } = params;
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        const perAcc = Math.ceil(items.length / sessions.length);
        sendLog('info', `Generating ${items.length} ref-image items across ${sessions.length} account(s) (${perAcc} per acc)...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const allResults = await Promise.all(
            sessions.map(async (session, ai) => {
                const sliceStart = ai * perAcc;
                const sliceEnd = Math.min((ai + 1) * perAcc, items.length);
                const myItems = items.slice(sliceStart, sliceEnd);
                if (myItems.length === 0) return [];
                const nameStart = baseIdx + sliceStart;
                sendLog('info', `[Acc${session.accIdx + 1}] 📋 Assigned ref-image items #${nameStart + 1}→#${nameStart + myItems.length} (${myItems.length} items)`);
                console.log(`[Main] [Acc${session.accIdx + 1}] Processing ${myItems.length} ref-image items...`);
                return RefImageService.generateBatch(myItems, session, config || {}, (prompt, progress, result, localIdx) => {
                    const globalIdx = nameStart + (localIdx != null ? localIdx : 0);
                    sendProgress('refimg', { prompt, progress, result, globalIdx });
                    if (result) {
                        const status = result.success ? 'success' : 'error';
                        const label = result.title || prompt.substring(0, 50);
                        const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                        sendLog(status, `[Acc${session.accIdx + 1}] RefImage ${result.success ? '✅' : '❌'}: ${label}${errorMsg}`);
                    }
                }, nameStart).then(batchResults => batchResults.map(r => ({ ...r, globalIdx: nameStart + (r.localIdx != null ? r.localIdx : 0) })));
            })
        );

        const results = allResults.flat();
        const successCount = results.filter(r => r.success).length;
        sendLog('info', `Ref-image generation complete: ${successCount}/${results.length} successful`);

        return { success: true, results };
    } catch (error) {
        sendLog('error', `Ref-image generation error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// IPC Handlers - I2V helper
ipcMain.handle('i2v:loadImages', async () => {
    try {
        const images = FileService.loadI2VInputImages();
        const prompts = FileService.loadI2VPrompts();
        return { success: true, images, prompts };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ========================================================================
// Backend Auth Service (from veovip: https://back.sharefilecorel.com)
// ========================================================================
const BACKEND_URL = 'https://back.sharefilecorel.com';

function getMachineId() {
    try {
        const os = require('os');
        const crypto = require('crypto');
        const hardwareInfo = [
            os.hostname(),
            os.platform(),
            os.arch(),
            os.cpus()[0]?.model || 'unknown',
            os.totalmem().toString(),
        ];
        const hash = crypto.createHash('md5').update(hardwareInfo.join('|')).digest('hex');
        return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20)}`;
    } catch (e) {
        return require('crypto').randomUUID();
    }
}

ipcMain.handle('api:backendLogin', async (_, params) => {
    return { success: true, data: { success: true, data: { token: 'license-mode', user: { username: 'user', role: { isActive: true } } } } };
});

ipcMain.handle('api:backendVerifyToken', async () => {
    return { success: true, data: { success: true } };
});

ipcMain.handle('api:backendGetProfile', async () => {
    return { success: true, data: { success: true, data: { username: 'user', role: { isActive: true } } } };
});

ipcMain.handle('api:backendLogout', async () => {
    return { success: true };
});

// Progress events (services will call these)
const progressThrottle = new Map();
function sendProgress(jobId, progress) {
    if (mainWindow) {
        const value = Number(
            typeof progress === 'object' ? progress?.progress : progress
        );
        const key = [
            jobId,
            typeof progress === 'object' ? (progress?.globalIdx ?? progress?.prompt ?? progress?.item?.imagePath ?? '') : ''
        ].join(':');
        const hasResult = !!(typeof progress === 'object' && progress?.result);
        const last = progressThrottle.get(key);
        const now = Date.now();
        if (!hasResult && Number.isFinite(value) && value < 100 && last) {
            const smallChange = Math.abs(value - last.value) < 5;
            const tooSoon = now - last.time < 800;
            if (smallChange || tooSoon) return;
        }
        if (Number.isFinite(value)) {
            progressThrottle.set(key, { value, time: now });
            if (value >= 100 || hasResult) progressThrottle.delete(key);
        }
        mainWindow.webContents.send('job:progress', { jobId, progress });
    }
}

function sendLog(level, message) {
    if (mainWindow) {
        mainWindow.webContents.send('log', { level, message, timestamp: new Date().toISOString() });
    }
}

// Auto Updater IPC Handlers
ipcMain.handle('updater:checkForUpdates', async () => {
    if (autoUpdaterService) {
        const result = await autoUpdaterService.checkForUpdates();
        return result;
    }
    return { success: false, error: 'Auto updater not initialized' };
});

ipcMain.handle('updater:downloadUpdate', async () => {
    if (autoUpdaterService) {
        const result = await autoUpdaterService.downloadUpdate();
        return result;
    }
    return { success: false, error: 'Auto updater not initialized' };
});

ipcMain.handle('updater:quitAndInstall', async () => {
    if (autoUpdaterService) {
        const result = await autoUpdaterService.quitAndInstall();
        return result;
    }
    return { success: false, error: 'Auto updater not initialized' };
});

ipcMain.handle('updater:getStatus', async () => {
    if (autoUpdaterService) {
        return { success: true, data: autoUpdaterService.getUpdateStatus() };
    }
    return { success: false, error: 'Auto updater not initialized' };
});

// Export for services to use
module.exports = { sendProgress, sendLog };

