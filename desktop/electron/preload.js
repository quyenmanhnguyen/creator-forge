const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getPathForFile: (file) => webUtils.getPathForFile(file),
    selectFolder: () => ipcRenderer.invoke('file:selectFolder'),
    selectFiles: (options) => ipcRenderer.invoke('file:selectFiles', options),
    getImagesFromFolder: (folderPath) => ipcRenderer.invoke('file:getImagesFromFolder', folderPath),
    readFile: (filePath) => ipcRenderer.invoke('file:readFile', filePath),
    getFileUrl: (filePath) => ipcRenderer.invoke('file:getFileUrl', filePath),
    openFolder: (folderPath) => ipcRenderer.invoke('file:openFolder', folderPath),
    openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
    showItemInFolder: (filePath) => ipcRenderer.invoke('file:showItemInFolder', filePath),
    deleteFile: (filePath) => ipcRenderer.invoke('file:deleteFile', filePath),
    // Size-only stat for use cases where readFile would be wasteful
    // (e.g. PR-9 ≥50KB blur threshold filtering after image:generate).
    statBytes: (filePath) => ipcRenderer.invoke('file:statBytes', filePath),

    auth: {
        login: (credentials) => ipcRenderer.invoke('auth:login', credentials),
        getAccounts: () => ipcRenderer.invoke('auth:getAccounts'),
        // PR-20E: structured session snapshot — accounts.json + live
        // session map combined into { status, accounts, counts } with
        // no cookies/headers/tokens crossing the boundary.
        getSessionStatus: (params) => ipcRenderer.invoke('auth:getSessionStatus', params),
        saveAccounts: (accounts) => ipcRenderer.invoke('auth:saveAccounts', accounts),
        setupAccounts: (accounts) => ipcRenderer.invoke('auth:setupAccounts', accounts),
        importTxt: () => ipcRenderer.invoke('account:importTxt'),
        // Open a headful Puppeteer browser at the Grok login page using a
        // persistent userDataDir. Useful when the user wants to log in by
        // hand instead of storing credentials in `accounts.json`.
        openManualLogin: (params) => ipcRenderer.invoke('auth:openManualLogin', params),
    },

    license: {
        check: () => ipcRenderer.invoke('license:check'),
        validate: (key) => ipcRenderer.invoke('license:validate', key),
        deactivate: () => ipcRenderer.invoke('license:deactivate'),
        getMachineId: () => ipcRenderer.invoke('license:getMachineId'),
    },

    api: {
        backendLogin: (params) => ipcRenderer.invoke('api:backendLogin', params),
        backendVerifyToken: (params) => ipcRenderer.invoke('api:backendVerifyToken', params),
        backendGetProfile: (params) => ipcRenderer.invoke('api:backendGetProfile', params),
        backendLogout: (params) => ipcRenderer.invoke('api:backendLogout', params),
    },

    assistant: {
        open: (url) => ipcRenderer.invoke('assistant:open', url),
    },

    image: {
        generate: (params) => ipcRenderer.invoke('image:generate', params),
        cancel: () => ipcRenderer.invoke('image:cancel'),
    },

    video: {
        generate: (params) => ipcRenderer.invoke('video:generate', params),
        merge: (params) => ipcRenderer.invoke('video:merge', params),
        // PR-20E: ffprobe-backed validation. Pass a string path or
        // { filePath, minBytes?, minDurationSec? }. Always resolves;
        // failure modes come back as { ok: false, reason }.
        validateOutput: (params) => ipcRenderer.invoke('video:validateOutput', params),
    },

    i2v: {
        generate: (params) => ipcRenderer.invoke('i2v:generate', params),
    },

    refimg: {
        generate: (params) => ipcRenderer.invoke('refimg:generate', params),
    },

    // PR-24: native folder picker for output-dir inputs. Returns
    // ``{ canceled, path }`` so the renderer can drop the path into
    // an <input> without parsing dialog internals.
    dialog: {
        chooseOutputDir: (opts) => ipcRenderer.invoke('dialog:chooseOutputDir', opts),
    },

    onProgress: (callback) => {
        ipcRenderer.on('job:progress', (_, data) => callback(data));
    },

    onLog: (callback) => {
        ipcRenderer.on('log', (_, data) => callback(data));
    },

    removeProgressListener: () => {
        ipcRenderer.removeAllListeners('job:progress');
    },

    removeLogListener: () => {
        ipcRenderer.removeAllListeners('log');
    },

    // creator-forge: research / studio / storyboard / producer namespaces.
    // Each method maps 1:1 to an IPC channel registered by researchIPC.js.
    research: {
        searchNiche: (params) => ipcRenderer.invoke('research:searchNiche', params),
        keywordIdeas: (params) => ipcRenderer.invoke('research:keywordIdeas', params),
        outlierFinder: (params) => ipcRenderer.invoke('research:outlierFinder', params),
        videoCloner: (params) => ipcRenderer.invoke('research:videoCloner', params),
    },

    studio: {
        topics: (params) => ipcRenderer.invoke('studio:topics', params),
        titles: (params) => ipcRenderer.invoke('studio:titles', params),
        outline: (params) => ipcRenderer.invoke('studio:outline', params),
        script: (params) => ipcRenderer.invoke('studio:script', params),
        humanize: (params) => ipcRenderer.invoke('studio:humanize', params),
    },

    storyboard: {
        fromScript: (params) => ipcRenderer.invoke('storyboard:fromScript', params),
        thumbnail: (params) => ipcRenderer.invoke('storyboard:thumbnail', params),
    },

    producer: {
        composeShort: (params) => ipcRenderer.invoke('producer:composeShort', params),
        listVoices: () => ipcRenderer.invoke('producer:listVoices'),
        listProviders: () => ipcRenderer.invoke('producer:listProviders'),
    },

    updater: {
        checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
        downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
        quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
        getStatus: () => ipcRenderer.invoke('updater:getStatus'),
        onUpdateEvent: (callback) => {
            const subscription = (_event, data) => callback(data);
            ipcRenderer.on('auto-updater', subscription);
            return subscription;
        },
        removeUpdateListener: (callback) => {
            ipcRenderer.removeListener('auto-updater', callback);
        }
    },
});
