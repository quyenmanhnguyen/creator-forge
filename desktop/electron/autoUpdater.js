const { autoUpdater } = require('electron-updater');
const { BrowserWindow, dialog } = require('electron');
const log = require('electron-log');

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;

class AutoUpdaterService {
    constructor() {
        this.mainWindow = null;
        this.updateDownloaded = false;
        this.authValidationCallback = null;
        this.setupAutoUpdater();
    }

    setMainWindow(window) {
        this.mainWindow = window;
    }

    /**
     * Set callback to validate user authentication before allowing updates
     */
    setAuthValidationCallback(callback) {
        this.authValidationCallback = callback;
    }

    /**
     * Validate user auth status before update operations
     */
    async validateAuth() {
        if (!this.authValidationCallback) {
            log.warn('⚠️ No auth validation callback set, allowing update');
            return { canCheckUpdate: true, canDownload: true };
        }

        try {
            const authStatus = await this.authValidationCallback();

            if (!authStatus.isAuthenticated) {
                log.info('🔒 User not authenticated, blocking update check');
                return {
                    canCheckUpdate: false,
                    canDownload: false,
                    reason: 'Vui lòng đăng nhập để kiểm tra cập nhật'
                };
            }

            if (!authStatus.isActive) {
                log.info('🔒 User account not active, blocking download');
                return {
                    canCheckUpdate: true,
                    canDownload: false,
                    reason: 'Tài khoản đã bị khóa hoặc hết hạn. Vui lòng liên hệ hỗ trợ để tiếp tục sử dụng.'
                };
            }

            log.info('✅ Auth validated, allowing update');
            return { canCheckUpdate: true, canDownload: true };
        } catch (error) {
            log.error('❌ Auth validation error:', error);
            return {
                canCheckUpdate: false,
                canDownload: false,
                reason: 'Không thể xác thực tài khoản'
            };
        }
    }

    setupAutoUpdater() {
        // Configure auto updater
        autoUpdater.autoDownload = false; // Don't auto download, ask user first
        autoUpdater.autoInstallOnAppQuit = true;

        // Check for updates on app start (after 5 seconds delay to allow auth to initialize)
        setTimeout(async () => {
            await this.checkForUpdates();
        }, 5000);

        // Auto updater events
        autoUpdater.on('checking-for-update', () => {
            log.info('🔍 Checking for update...');
            this.sendToRenderer('update-checking');
        });

        autoUpdater.on('update-available', (info) => {
            log.info('✅ Update available:', info.version);
            this.sendToRenderer('update-available', {
                version: info.version,
                releaseNotes: info.releaseNotes,
                releaseDate: info.releaseDate
            });
            this.showUpdateDialog(info);
        });

        autoUpdater.on('update-not-available', (info) => {
            log.info('ℹ️ Update not available. Current version:', info.version);
            this.sendToRenderer('update-not-available');
        });

        autoUpdater.on('error', (err) => {
            log.error('❌ Update error:', err);
            this.sendToRenderer('update-error', err.message);
        });

        autoUpdater.on('download-progress', (progressObj) => {
            const message = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
            log.info('⏳ Download progress:', message);
            this.sendToRenderer('update-download-progress', {
                percent: Math.round(progressObj.percent),
                transferred: progressObj.transferred,
                total: progressObj.total,
                bytesPerSecond: progressObj.bytesPerSecond
            });
        });

        autoUpdater.on('update-downloaded', (info) => {
            log.info('✅ Update downloaded:', info.version);
            this.updateDownloaded = true;
            this.sendToRenderer('update-downloaded', {
                version: info.version
            });
            this.showRestartDialog(info);
        });
    }

    sendToRenderer(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('auto-updater', { type: channel, data });
        }
    }

    async showUpdateDialog(info) {
        if (!this.mainWindow) return;

        // Validate auth before showing download dialog
        const authStatus = await this.validateAuth();

        if (!authStatus.canDownload) {
            await dialog.showMessageBox(this.mainWindow, {
                type: 'warning',
                title: 'Không thể tải cập nhật',
                message: `Phiên bản ${info.version} đã có sẵn nhưng bạn không thể tải xuống.`,
                detail: authStatus.reason || 'Tài khoản không hợp lệ',
                buttons: ['Đóng'],
            });
            this.sendToRenderer('update-blocked', {
                version: info.version,
                reason: authStatus.reason
            });
            return;
        }

        const result = await dialog.showMessageBox(this.mainWindow, {
            type: 'info',
            title: 'Cập nhật mới có sẵn',
            message: `Phiên bản ${info.version} đã có sẵn. Bạn có muốn tải xuống không?`,
            detail: 'Ứng dụng sẽ tự động cài đặt sau khi tải xuống xong.',
            buttons: ['Tải xuống', 'Để sau'],
            defaultId: 0,
            cancelId: 1
        });

        if (result.response === 0) {
            this.downloadUpdate();
        }
    }

    async showRestartDialog(info) {
        if (!this.mainWindow) return;

        const result = await dialog.showMessageBox(this.mainWindow, {
            type: 'info',
            title: 'Cập nhật đã sẵn sàng',
            message: `Phiên bản ${info.version} đã được tải xuống. Khởi động lại để cài đặt?`,
            detail: 'Ứng dụng sẽ tự động cài đặt phiên bản mới khi khởi động lại.',
            buttons: ['Khởi động lại ngay', 'Khởi động lại sau'],
            defaultId: 0,
            cancelId: 1
        });

        if (result.response === 0) {
            this.quitAndInstall();
        }
    }

    async checkForUpdates() {
        const isDev = process.env.NODE_ENV === 'development' || !require('electron').app.isPackaged;
        if (isDev) {
            log.info('⚠️ Auto updater disabled in development mode');
            return { success: false, error: 'Disabled in development mode' };
        }

        // Validate auth before checking for updates
        const authStatus = await this.validateAuth();
        if (!authStatus.canCheckUpdate) {
            log.info('🔒 Update check blocked:', authStatus.reason);
            this.sendToRenderer('update-auth-required', { reason: authStatus.reason });
            return { success: false, error: authStatus.reason };
        }

        log.info('🔍 Manually checking for updates...');
        autoUpdater.checkForUpdatesAndNotify();
        return { success: true };
    }

    async downloadUpdate() {
        // Validate auth before downloading
        const authStatus = await this.validateAuth();
        if (!authStatus.canDownload) {
            log.info('🔒 Download blocked:', authStatus.reason);
            this.sendToRenderer('update-blocked', { reason: authStatus.reason });

            if (this.mainWindow) {
                await dialog.showMessageBox(this.mainWindow, {
                    type: 'warning',
                    title: 'Không thể tải cập nhật',
                    message: 'Bạn không thể tải cập nhật.',
                    detail: authStatus.reason || 'Tài khoản không hợp lệ',
                    buttons: ['Đóng'],
                });
            }
            return { success: false, error: authStatus.reason };
        }

        log.info('⏬ Starting update download...');
        autoUpdater.downloadUpdate();
        return { success: true };
    }

    async quitAndInstall() {
        if (!this.updateDownloaded) {
            return { success: false, error: 'No update downloaded' };
        }

        // Validate auth before installing
        const authStatus = await this.validateAuth();
        if (!authStatus.canDownload) {
            log.info('🔒 Install blocked:', authStatus.reason);

            if (this.mainWindow) {
                await dialog.showMessageBox(this.mainWindow, {
                    type: 'warning',
                    title: 'Không thể cài đặt cập nhật',
                    message: 'Bạn không thể cài đặt cập nhật.',
                    detail: authStatus.reason || 'Tài khoản không hợp lệ',
                    buttons: ['Đóng'],
                });
            }
            return { success: false, error: authStatus.reason };
        }

        log.info('🔄 Quitting and installing update...');
        autoUpdater.quitAndInstall();
        return { success: true };
    }

    getUpdateStatus() {
        return {
            updateDownloaded: this.updateDownloaded,
            isCheckingForUpdate: false
        };
    }
}

module.exports = AutoUpdaterService;
