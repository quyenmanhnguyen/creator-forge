const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHEET_ID = '1P6vOZyNJRhQyLD_0XZ7k9oC_43MKf63BaeOGO_yxQtI';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;

class LicenseService {
    constructor(userDataPath) {
        this.userDataPath = userDataPath;
        this.licenseFile = path.join(userDataPath, 'license.json');
        this.cachedLicense = null;
    }

    getMachineId() {
        const interfaces = os.networkInterfaces();
        let mac = '';
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                    mac = iface.mac;
                    break;
                }
            }
            if (mac) break;
        }
        const raw = `${os.hostname()}-${mac || 'no-mac'}-${os.platform()}-${os.arch()}`;
        return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16).toUpperCase();
    }

    async fetchSheetKeys() {
        const axios = require('axios');
        try {
            const res = await axios.get(SHEET_URL, { timeout: 15000 });
            const csv = res.data;
            const lines = csv.split('\n').filter(l => l.trim());
            const keys = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = this._parseCSVLine(lines[i]);
                if (cols.length >= 1) {
                    const key = (cols[0] || '').replace(/"/g, '').trim();
                    const timeStr = (cols[1] || '').replace(/"/g, '').trim();
                    if (key) {
                        keys.push({ key, expiry: this._parseDate(timeStr) });
                    }
                }
            }
            return keys;
        } catch (err) {
            console.error('[License] Failed to fetch sheet:', err.message);
            return null;
        }
    }

    _parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }

    _parseDate(str) {
        if (!str) return null;
        const parts = str.split('/');
        if (parts.length === 3) {
            const day = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1;
            const year = parseInt(parts[2], 10);
            return new Date(year, month, day);
        }
        const d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    async validateKey(inputKey) {
        const keys = await this.fetchSheetKeys();
        if (!keys) {
            const saved = this._loadSavedLicense();
            if (saved && saved.key === inputKey) {
                return { valid: true, offline: true, expiry: saved.expiry, machineId: this.getMachineId() };
            }
            return { valid: false, error: 'Không thể kết nối server. Vui lòng kiểm tra internet.' };
        }

        const found = keys.find(k => k.key === inputKey);
        if (!found) {
            return { valid: false, error: 'Key không hợp lệ.' };
        }

        if (found.expiry && found.expiry < new Date()) {
            return { valid: false, error: 'Key đã hết hạn.' };
        }

        const machineId = this.getMachineId();
        const license = {
            key: inputKey,
            machineId,
            expiry: found.expiry ? found.expiry.toISOString() : null,
            activatedAt: new Date().toISOString()
        };
        this._saveLicense(license);
        this.cachedLicense = license;

        return { valid: true, machineId, expiry: found.expiry ? found.expiry.toISOString() : null };
    }

    async checkLicense() {
        const saved = this._loadSavedLicense();
        if (!saved || !saved.key) {
            return { valid: false, needsKey: true };
        }

        if (saved.machineId !== this.getMachineId()) {
            return { valid: false, error: 'Key đã được kích hoạt trên máy khác.', needsKey: true };
        }

        if (saved.expiry && new Date(saved.expiry) < new Date()) {
            return { valid: false, error: 'Key đã hết hạn.', needsKey: true };
        }

        try {
            const keys = await this.fetchSheetKeys();
            if (keys) {
                const found = keys.find(k => k.key === saved.key);
                if (!found) {
                    this._removeLicense();
                    return { valid: false, error: 'Key đã bị xóa khỏi hệ thống.', needsKey: true };
                }
                if (found.expiry && found.expiry < new Date()) {
                    return { valid: false, error: 'Key đã hết hạn.', needsKey: true };
                }
            }
        } catch (e) {
            console.log('[License] Offline check, using cached license');
        }

        this.cachedLicense = saved;
        return { valid: true, key: saved.key, machineId: saved.machineId, expiry: saved.expiry };
    }

    _loadSavedLicense() {
        try {
            if (fs.existsSync(this.licenseFile)) {
                return JSON.parse(fs.readFileSync(this.licenseFile, 'utf8'));
            }
        } catch (e) {
            console.error('[License] Error loading license:', e.message);
        }
        return null;
    }

    _saveLicense(data) {
        try {
            fs.writeFileSync(this.licenseFile, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.error('[License] Error saving license:', e.message);
        }
    }

    _removeLicense() {
        try {
            if (fs.existsSync(this.licenseFile)) {
                fs.unlinkSync(this.licenseFile);
            }
            this.cachedLicense = null;
        } catch (e) {
            console.error('[License] Error removing license:', e.message);
        }
    }

    deactivate() {
        this._removeLicense();
        return { success: true };
    }
}

module.exports = LicenseService;
