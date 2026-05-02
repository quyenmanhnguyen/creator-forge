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
const VideoValidation = require('../dist/video_validation_helpers');
const { runFanOut } = require('../src/orchestration/multi_account_fan_out');
const { PROCESSING_CONFIG } = require('../src/config/app.config');
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

// PR-20E: ffprobe-backed validation for I2V/T2V/composer mp4 outputs.
// Renderer-side helpers (Compose with AutoGrok / Batch Image+Video)
// hand the path here and trust `{ ok, reason, ... }` to decide whether
// a row should be marked `generated` or `fallback`. Failure modes
// (missing ffprobe, missing file, truncated mp4) come back as a clean
// `{ ok: false }` — we never throw.
ipcMain.handle('video:validateOutput', async (_, params) => {
    try {
        const filePath = (params && typeof params === 'object') ? params.filePath : params;
        if (!filePath) {
            return { ok: false, exists: false, size: 0, ffprobeAvailable: false, reason: 'empty filePath' };
        }
        const opts = {};
        if (params && typeof params === 'object') {
            if (typeof params.minBytes === 'number') opts.minBytes = params.minBytes;
            if (typeof params.minDurationSec === 'number') opts.minDurationSec = params.minDurationSec;
        }
        return await VideoValidation.validateVideoOutput(filePath, opts);
    } catch (error) {
        return {
            ok: false,
            exists: false,
            size: 0,
            ffprobeAvailable: false,
            reason: `validateVideoOutput threw: ${(error && error.message) || error}`,
        };
    }
});

// PR-24: open a native folder picker for the Batch / Compose-short
// output-dir input. Renderer calls ``api.dialog.chooseOutputDir()``
// which returns ``{ canceled, path }`` — the renderer is responsible
// for stuffing the returned path into the matching <input>.
ipcMain.handle('dialog:chooseOutputDir', async (_, opts) => {
    try {
        const title = (opts && typeof opts.title === 'string') ? opts.title : 'Choose output folder';
        const defaultPath = (opts && typeof opts.defaultPath === 'string' && opts.defaultPath) ? opts.defaultPath : undefined;
        const result = await dialog.showOpenDialog(mainWindow, {
            title,
            defaultPath,
            properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths.length) {
            return { canceled: true, path: '' };
        }
        return { canceled: false, path: result.filePaths[0] };
    } catch (error) {
        return { canceled: true, path: '', error: (error && error.message) || String(error) };
    }
});

// PR-31: native single-file picker for the Video Assembly panel
// (narration audio + captions.srt). ``opts.filters`` follows
// Electron's ``Filters[]`` shape; passing nothing shows all files.
// Renderer is responsible for stuffing the returned path into the
// matching <input>.
ipcMain.handle('dialog:chooseInputFile', async (_, opts) => {
    try {
        const title = (opts && typeof opts.title === 'string') ? opts.title : 'Choose file';
        const defaultPath = (opts && typeof opts.defaultPath === 'string' && opts.defaultPath) ? opts.defaultPath : undefined;
        const filters = (opts && Array.isArray(opts.filters)) ? opts.filters : undefined;
        const result = await dialog.showOpenDialog(mainWindow, {
            title,
            defaultPath,
            filters,
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) {
            return { canceled: true, path: '' };
        }
        return { canceled: false, path: result.filePaths[0] };
    } catch (error) {
        return { canceled: true, path: '', error: (error && error.message) || String(error) };
    }
});

// PR-31: walk ~/.creator-forge/output/ to find the most recent
// audio-<ts>/voice.{mp3,wav} written by /producer/audio. The Video
// Assembly panel's "Use latest /producer/audio" button calls this so
// the user doesn't have to browse manually after each Compose-audio
// run. Returns ``{ path, srtPath, dir }`` (any of which may be empty
// when nothing's been rendered yet).
ipcMain.handle('producer:latestAudioOutput', async () => {
    try {
        const baseDir = path.join(os.homedir(), '.creator-forge', 'output');
        if (!fs.existsSync(baseDir)) {
            return { path: '', srtPath: '', dir: '' };
        }
        const entries = fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && e.name.startsWith('audio-'))
            .map(e => {
                const full = path.join(baseDir, e.name);
                let mtime = 0;
                try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
                return { name: e.name, full, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
        for (const entry of entries) {
            for (const ext of ['mp3', 'wav']) {
                const candidate = path.join(entry.full, `voice.${ext}`);
                if (fs.existsSync(candidate)) {
                    const srt = path.join(entry.full, 'captions.srt');
                    return {
                        path: candidate,
                        srtPath: fs.existsSync(srt) ? srt : '',
                        dir: entry.full,
                    };
                }
            }
        }
        return { path: '', srtPath: '', dir: '' };
    } catch (error) {
        return { path: '', srtPath: '', dir: '', error: (error && error.message) || String(error) };
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

// PR-20E: structured session-state snapshot. The legacy banner only
// knew "accounts.json non-empty?" — this IPC also folds in the live
// session map so the renderer can distinguish no_accounts / stale /
// ready / unknown without leaking cookies or headers across the
// boundary (see AuthService.getSessionStatus for the safe-shape
// contract).
ipcMain.handle('auth:getSessionStatus', async (_, params) => {
    try {
        const opts = (params && typeof params === 'object') ? {} : {};
        if (params && typeof params === 'object' && typeof params.maxAgeMs === 'number') {
            opts.maxAgeMs = params.maxAgeMs;
        }
        // PR-24/PR-25: unify the accounts.json source-of-truth with
        // ``auth:saveAccounts`` / ``auth:getAccounts``. Path
        // resolution now lives inside ``AccountService.loadAccounts``
        // (which prefers ``app.getPath('userData')/accounts.json``
        // when running inside Electron); we keep the explicit
        // ``accountsLoader`` injection so a future refactor of
        // AccountService can't silently regress the banner-sync fix
        // again.
        opts.accountsLoader = () => {
            try {
                const accounts = AccountService.loadAccounts();
                return Array.isArray(accounts) ? accounts : [];
            } catch (e) {
                console.warn('[auth:getSessionStatus] AccountService.loadAccounts failed:', e && e.message);
                return [];
            }
        };
        return AuthService.getSessionStatus(opts);
    } catch (error) {
        return {
            status: 'unknown',
            reason: `getSessionStatus threw: ${(error && error.message) || error}`,
            accounts: [],
            ready_count: 0,
            stale_count: 0,
            configured_count: 0,
            max_age_ms: 60 * 60 * 1000,
        };
    }
});

// PR-25: both IPC handlers delegate to AccountService so the path
// resolution + bundled→userData migration stay in one place.
// Previously this file inlined a near-duplicate copy that diverged
// from AccountService (different indent, different fallback chain),
// which is exactly how AuthService._doRelogin ended up reading from
// ``desktop/accounts.json`` while the renderer wrote to
// ``%APPDATA%/creator-forge/accounts.json``.
ipcMain.handle('auth:getAccounts', async () => {
    try {
        const accounts = AccountService.loadAccounts();
        return Array.isArray(accounts) ? accounts : [];
    } catch (error) {
        console.error('[auth:getAccounts] load failed:', error);
        return [];
    }
});

ipcMain.handle('auth:saveAccounts', async (_, accounts) => {
    try {
        AccountService.saveAccounts(Array.isArray(accounts) ? accounts : []);
        return { success: true };
    } catch (error) {
        console.error('[auth:saveAccounts] save failed:', error);
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

// IPC Handlers - Image generation (work-stealing multi-account fan-out)
//
// PR-47: replaces the old static-slice fan-out
// (``Math.ceil(N/M)`` items per session, dispatched via
// ``ImageService.generateBatch`` per session) with a shared work
// queue. Each session pulls the next prompt from the queue the
// moment it finishes its previous one, so a fast account does not
// idle while a slow / rate-limited account drains its slice. See
// ``desktop/src/orchestration/multi_account_fan_out.js`` for the
// scheduler internals.
ipcMain.handle('image:generate', async (_, params) => {
    try {
        const { prompts, config, startIdx: baseIdx = 0 } = params;
        ImageService.resetCancel();
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        const perSessionConcurrency = Math.max(1, Math.min(
            Number(config?.batchSize) || PROCESSING_CONFIG.BATCH_SIZE || 30,
            30,
        ));
        sendLog('info', `Generating ${prompts.length} images across ${sessions.length} account(s) — work-stealing queue, up to ${perSessionConcurrency}/account = up to ${sessions.length * perSessionConcurrency} parallel...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const fanOut = await runFanOut({
            sessions,
            items: prompts,
            perSessionConcurrency,
            workerStaggerMs: 75,
            isCancelled: () => ImageService._cancelled,
            onProgress: ({ idx, result, session }) => {
                if (!result) return;
                const globalIdx = baseIdx + idx;
                sendProgress('image', {
                    prompt: result.prompt,
                    progress: 100,
                    result,
                    globalIdx,
                });
                const status = result.success ? 'success' : 'error';
                const label = result.title || (result.prompt || '').substring(0, 50);
                const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                sendLog(status, `[Acc${session.accIdx + 1}] Image ${result.success ? '✅' : '❌'}: ${label}${errorMsg}`);
            },
            processOne: async (prompt, session, idx) => {
                const globalNum = baseIdx + idx + 1;
                const onItemProgress = (p, progress, result, _localIdx) => {
                    // Per-item live progress (0..99). Final 100% +
                    // result are emitted from the fan-out's onProgress
                    // hook above so we don't double-fire.
                    if (result) return;
                    sendProgress('image', {
                        prompt: p,
                        progress,
                        result: null,
                        globalIdx: baseIdx + idx,
                    });
                };
                return ImageService._processOneBatchItem(
                    prompt,
                    session,
                    config || {},
                    onItemProgress,
                    idx,
                    globalNum,
                    prompts.length,
                );
            },
        });

        const results = fanOut.results.map((r, idx) => {
            const globalIdx = baseIdx + idx;
            if (!r) {
                // Slot was never reached — every session quarantined or
                // batch was cancelled before this index was taken.
                return {
                    prompt: prompts[idx],
                    localIdx: idx,
                    globalIdx,
                    success: false,
                    error: ImageService._cancelled ? 'cancelled' : 'no session available',
                    savedFiles: [],
                    outputPath: null,
                };
            }
            return { ...r, globalIdx };
        });

        const successCount = results.filter(r => r.success).length;
        const perSessionLog = fanOut.stats.perSession
            .map(s => `Acc${(s.accIdx ?? -1) + 1}=${s.ok}/${s.taken}${s.quarantined ? '⛔' : ''}`)
            .join(' ');
        sendLog('info', `Image generation complete: ${successCount}/${results.length} successful | ${perSessionLog}`);

        // Surface per-session work-stealing stats to the renderer so
        // callers can render an account-health badge / debug panel
        // without re-deriving them from the per-row results array.
        return { success: true, results, stats: fanOut.stats };
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

// IPC Handlers - Video generation (work-stealing multi-account fan-out)
//
// Phase 2 of PR-47: extends the shared work queue from image
// generation to video generation. Replaces the old static-slice
// fan-out with the same scheduler image:generate already uses
// (``multi_account_fan_out.js``). See the image:generate handler
// above for the rationale; semantics here are identical.
ipcMain.handle('video:generate', async (_, params) => {
    try {
        const { prompts, config, startIdx: baseIdx = 0 } = params;
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        console.log('[Main] Video config received:', JSON.stringify(config, null, 2));
        const perSessionConcurrency = Math.max(1, Math.min(
            Number(config?.batchSize) || PROCESSING_CONFIG.BATCH_SIZE || 5,
            5,
        ));
        sendLog('info', `Generating ${prompts.length} videos across ${sessions.length} account(s) — work-stealing queue, up to ${perSessionConcurrency}/account = up to ${sessions.length * perSessionConcurrency} parallel...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const fanOut = await runFanOut({
            sessions,
            items: prompts,
            perSessionConcurrency,
            workerStaggerMs: 75,
            onProgress: ({ idx, result, session }) => {
                if (!result) return;
                const globalIdx = baseIdx + idx;
                sendProgress('video', {
                    prompt: result.prompt,
                    progress: 100,
                    result,
                    globalIdx,
                });
                const status = result.success ? 'success' : 'error';
                const label = result.title || (result.prompt || '').substring(0, 50);
                const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                sendLog(status, `[Acc${session.accIdx + 1}] Video ${result.success ? '✅' : '❌'}: ${label}${errorMsg}`);
            },
            processOne: async (prompt, session, idx) => {
                const globalNum = baseIdx + idx + 1;
                const onItemProgress = (p, progress, result, _localIdx) => {
                    // Per-item live progress (0..99). Final 100% +
                    // result are emitted from the fan-out's onProgress
                    // hook above so we don't double-fire.
                    if (result) return;
                    sendProgress('video', {
                        prompt: p,
                        progress,
                        result: null,
                        globalIdx: baseIdx + idx,
                    });
                };
                return VideoService._processOneBatchItem(
                    prompt,
                    session,
                    config || {},
                    onItemProgress,
                    idx,
                    globalNum,
                    prompts.length,
                );
            },
        });

        const results = fanOut.results.map((r, idx) => {
            const globalIdx = baseIdx + idx;
            if (!r) {
                return {
                    prompt: prompts[idx],
                    localIdx: idx,
                    globalIdx,
                    success: false,
                    error: 'no session available',
                    savedFile: null,
                    outputPath: null,
                };
            }
            return { ...r, globalIdx };
        });

        const successCount = results.filter(r => r.success).length;
        const perSessionLog = fanOut.stats.perSession
            .map(s => `Acc${(s.accIdx ?? -1) + 1}=${s.ok}/${s.taken}${s.quarantined ? '⛔' : ''}`)
            .join(' ');
        sendLog('info', `Video generation complete: ${successCount}/${results.length} successful | ${perSessionLog}`);

        return { success: true, results, stats: fanOut.stats };
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

// IPC Handlers - I2V generation (work-stealing multi-account fan-out)
//
// Phase 2 of PR-47: extends the shared work queue from image
// generation to image-to-video. Replaces the old static-slice
// fan-out with the same scheduler image:generate already uses
// (``multi_account_fan_out.js``). See the image:generate handler
// above for the rationale; semantics here are identical.
ipcMain.handle('i2v:generate', async (_, params) => {
    try {
        const { items, config, startIdx: baseIdx = 0 } = params;
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        const perSessionConcurrency = Math.max(1, Math.min(
            Number(config?.batchSize) || 5,
            5,
        ));
        sendLog('info', `Generating ${items.length} I2V videos across ${sessions.length} account(s) — work-stealing queue, up to ${perSessionConcurrency}/account = up to ${sessions.length * perSessionConcurrency} parallel...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const fanOut = await runFanOut({
            sessions,
            items,
            perSessionConcurrency,
            workerStaggerMs: 200,
            onProgress: ({ idx, result, session }) => {
                if (!result) return;
                const globalIdx = baseIdx + idx;
                sendProgress('i2v', {
                    item: items[idx],
                    progress: 100,
                    result,
                    globalIdx,
                });
                const status = result.success ? 'success' : 'error';
                const imgName = result.imagePath ? path.basename(result.imagePath) : '';
                const label = result.title || (result.prompt || '').substring(0, 50);
                const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                sendLog(status, `[Acc${session.accIdx + 1}] I2V ${result.success ? '✅' : '❌'}: ${label} [${imgName}]${errorMsg}`);
            },
            processOne: async (item, session, idx) => {
                const globalNum = baseIdx + idx + 1;
                const onItemProgress = (it, progress, result, _localIdx) => {
                    if (result) return;
                    sendProgress('i2v', {
                        item: it,
                        progress,
                        result: null,
                        globalIdx: baseIdx + idx,
                    });
                };
                return I2VService._processOneBatchItem(
                    item,
                    session,
                    config || {},
                    onItemProgress,
                    idx,
                    globalNum,
                    items.length,
                );
            },
        });

        const results = fanOut.results.map((r, idx) => {
            const globalIdx = baseIdx + idx;
            if (!r) {
                return {
                    imagePath: items[idx]?.imagePath,
                    prompt: items[idx]?.prompt,
                    localIdx: idx,
                    globalIdx,
                    success: false,
                    error: 'no session available',
                    savedFile: null,
                    outputPath: null,
                };
            }
            return { ...r, globalIdx };
        });

        const successCount = results.filter(r => r.success).length;
        const perSessionLog = fanOut.stats.perSession
            .map(s => `Acc${(s.accIdx ?? -1) + 1}=${s.ok}/${s.taken}${s.quarantined ? '⛔' : ''}`)
            .join(' ');
        sendLog('info', `I2V generation complete: ${successCount}/${results.length} successful | ${perSessionLog}`);

        return { success: true, results, stats: fanOut.stats };
    } catch (error) {
        sendLog('error', `I2V generation error: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// IPC Handlers - Ref Image generation (work-stealing multi-account fan-out)
//
// Phase 2 of PR-47: extends the shared work queue from image
// generation to ref-image generation. Replaces the old static-slice
// fan-out with the same scheduler image:generate already uses
// (``multi_account_fan_out.js``). See the image:generate handler
// above for the rationale; semantics here are identical.
ipcMain.handle('refimg:generate', async (_, params) => {
    try {
        const { items, config, startIdx: baseIdx = 0 } = params;
        const sessions = AuthService.getAllSessions();

        if (sessions.length === 0) {
            return { success: false, error: 'No active sessions. Please setup accounts first.' };
        }

        const perSessionConcurrency = Math.max(1, Math.min(
            Number(config?.batchSize) || 5,
            5,
        ));
        sendLog('info', `Generating ${items.length} ref-image items across ${sessions.length} account(s) — work-stealing queue, up to ${perSessionConcurrency}/account = up to ${sessions.length * perSessionConcurrency} parallel...`);

        // Refresh cookies from live browser sessions before generating
        await AuthService.refreshAllCookies();

        // Reset re-login counters for fresh batch
        AuthService.resetAllReloginCounts();

        const fanOut = await runFanOut({
            sessions,
            items,
            perSessionConcurrency,
            workerStaggerMs: 200,
            onProgress: ({ idx, result, session }) => {
                if (!result) return;
                const globalIdx = baseIdx + idx;
                sendProgress('refimg', {
                    prompt: result.prompt,
                    progress: 100,
                    result,
                    globalIdx,
                });
                const status = result.success ? 'success' : 'error';
                const label = result.title || (result.prompt || '').substring(0, 50);
                const errorMsg = result.error ? ` | Error: ${result.error}` : '';
                sendLog(status, `[Acc${session.accIdx + 1}] RefImage ${result.success ? '✅' : '❌'}: ${label}${errorMsg}`);
            },
            processOne: async (item, session, idx) => {
                const globalNum = baseIdx + idx + 1;
                const onItemProgress = (prompt, progress, result, _localIdx) => {
                    if (result) return;
                    sendProgress('refimg', {
                        prompt,
                        progress,
                        result: null,
                        globalIdx: baseIdx + idx,
                    });
                };
                return RefImageService._processOneBatchItem(
                    item,
                    session,
                    config || {},
                    onItemProgress,
                    idx,
                    globalNum,
                    items.length,
                );
            },
        });

        const results = fanOut.results.map((r, idx) => {
            const globalIdx = baseIdx + idx;
            if (!r) {
                return {
                    prompt: items[idx]?.prompt,
                    localIdx: idx,
                    globalIdx,
                    success: false,
                    error: 'no session available',
                    savedFiles: [],
                    outputPath: null,
                };
            }
            return { ...r, globalIdx };
        });

        const successCount = results.filter(r => r.success).length;
        const perSessionLog = fanOut.stats.perSession
            .map(s => `Acc${(s.accIdx ?? -1) + 1}=${s.ok}/${s.taken}${s.quarantined ? '⛔' : ''}`)
            .join(' ');
        sendLog('info', `Ref-image generation complete: ${successCount}/${results.length} successful | ${perSessionLog}`);

        return { success: true, results, stats: fanOut.stats };
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

// Mirror IPC log events to the main-process console so they show up
// in the terminal that launched Electron (and in CI/headless logs).
// Without this, only the renderer's "Logs" panel sees these messages,
// which makes debugging without the UI open painful — especially for
// background work-stealing fan-outs that print per-account stats.
function sendLog(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    if (level === 'error' || level === 'warn') {
        console.error(line);
    } else {
        console.log(line);
    }
    if (mainWindow) {
        mainWindow.webContents.send('log', { level, message, timestamp });
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

