const { PATHS } = require('../config/app.config');
const fs = require('fs');
const path = require('path');

class AccountService {
    /**
     * Load accounts from JSON file
     * @returns {Array<Object>} Array of account objects
     */
    loadAccounts() {
        try {
            if (!fs.existsSync(PATHS.ACCOUNTS_FILE)) {
                console.warn('[AccountService] accounts.json not found');
                return [];
            }

            const data = fs.readFileSync(PATHS.ACCOUNTS_FILE, 'utf-8');
            const accounts = JSON.parse(data);

            console.log(`[AccountService] Loaded ${accounts.length} accounts`);
            return accounts;
        } catch (error) {
            console.error('[AccountService] Error loading accounts:', error.message);
            return [];
        }
    }

    /**
     * Save accounts to JSON file
     * @param {Array<Object>} accounts - Array of account objects
     */
    saveAccounts(accounts) {
        try {
            const data = JSON.stringify(accounts, null, 2);
            fs.writeFileSync(PATHS.ACCOUNTS_FILE, data, 'utf-8');
            console.log(`[AccountService] Saved ${accounts.length} accounts`);
        } catch (error) {
            console.error('[AccountService] Error saving accounts:', error.message);
            throw error;
        }
    }

    /**
     * Add a new account
     * @param {Object} account - Account object {email, password}
     */
    addAccount(account) {
        const accounts = this.loadAccounts();

        // Check if account already exists
        const exists = accounts.some(acc => acc.email === account.email);
        if (exists) {
            throw new Error(`Account ${account.email} already exists`);
        }

        accounts.push(account);
        this.saveAccounts(accounts);
        console.log(`[AccountService] Added account: ${account.email}`);
    }

    /**
     * Remove an account by email
     * @param {string} email - Account email
     */
    removeAccount(email) {
        const accounts = this.loadAccounts();
        const filtered = accounts.filter(acc => acc.email !== email);

        if (filtered.length === accounts.length) {
            throw new Error(`Account ${email} not found`);
        }

        this.saveAccounts(filtered);
        console.log(`[AccountService] Removed account: ${email}`);
    }

    /**
     * Update an account
     * @param {string} email - Account email
     * @param {Object} updates - Fields to update
     */
    updateAccount(email, updates) {
        const accounts = this.loadAccounts();
        const index = accounts.findIndex(acc => acc.email === email);

        if (index === -1) {
            throw new Error(`Account ${email} not found`);
        }

        accounts[index] = { ...accounts[index], ...updates };
        this.saveAccounts(accounts);
        console.log(`[AccountService] Updated account: ${email}`);
    }

    /**
     * Validate account credentials
     * @param {Object} account - Account object
     * @returns {boolean} True if valid
     */
    validateAccount(account) {
        if (!account.email || !account.password) {
            return false;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(account.email)) {
            return false;
        }

        return true;
    }
}

// Export singleton instance
module.exports = new AccountService();
