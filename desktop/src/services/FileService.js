const { PATHS, FILE_CONFIG } = require('../config/app.config');
const fs = require('fs');
const path = require('path');

class FileService {
    /**
     * Ensure directory exists
     * @param {string} dirPath - Directory path
     */
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`[FileService] Created directory: ${dirPath}`);
        }
    }

    /**
     * Initialize all output directories
     */
    initializeDirectories() {
        this.ensureDir(PATHS.IMAGE_DIR);
        this.ensureDir(PATHS.VIDEO_DIR);
        this.ensureDir(PATHS.I2V_DIR);
        this.ensureDir(PATHS.I2V_INPUT_DIR);
        this.ensureDir(PATHS.SESSIONS_DIR);
        this.ensureDir(PATHS.LOG_DIR);
        console.log('[FileService] All directories initialized');
    }

    /**
     * Load image files from I2V input directory
     * @returns {Array<Object>} Array of {imagePath, filename}
     */
    loadI2VInputImages() {
        this.ensureDir(PATHS.I2V_INPUT_DIR);

        const files = fs.readdirSync(PATHS.I2V_INPUT_DIR);
        const imageFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return FILE_CONFIG.SUPPORTED_IMAGE_TYPES.includes(ext);
        });

        const images = imageFiles.map(filename => ({
            imagePath: path.join(PATHS.I2V_INPUT_DIR, filename),
            filename: filename,
        }));

        console.log(`[FileService] Loaded ${images.length} images from i2v-input`);
        return images;
    }

    /**
     * Load custom prompts for I2V images
     * @returns {Object} Map of filename to prompt
     */
    loadI2VPrompts() {
        const promptsFile = path.join(PATHS.I2V_INPUT_DIR, 'prompts.json');

        if (!fs.existsSync(promptsFile)) {
            console.log('[FileService] No prompts.json found');
            return {};
        }

        try {
            const data = fs.readFileSync(promptsFile, 'utf-8');
            const prompts = JSON.parse(data);
            console.log(`[FileService] Loaded ${Object.keys(prompts).length} custom prompts`);
            return prompts;
        } catch (error) {
            console.error('[FileService] Error loading prompts.json:', error.message);
            return {};
        }
    }

    /**
     * Validate image file
     * @param {string} filePath - Path to image file
     * @returns {Object} {valid: boolean, error?: string}
     */
    validateImageFile(filePath) {
        if (!fs.existsSync(filePath)) {
            return { valid: false, error: 'File does not exist' };
        }

        const stats = fs.statSync(filePath);
        if (stats.size > FILE_CONFIG.MAX_FILE_SIZE) {
            return { valid: false, error: `File too large (max ${FILE_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)` };
        }

        const ext = path.extname(filePath).toLowerCase();
        if (!FILE_CONFIG.SUPPORTED_IMAGE_TYPES.includes(ext)) {
            return { valid: false, error: 'Unsupported file type' };
        }

        return { valid: true };
    }

    /**
     * Save file to directory
     * @param {Buffer} data - File data
     * @param {string} filename - Output filename
     * @param {string} directory - Target directory
     * @returns {string} Full path to saved file
     */
    saveFile(data, filename, directory) {
        this.ensureDir(directory);
        const filePath = path.join(directory, filename);
        fs.writeFileSync(filePath, data);
        console.log(`[FileService] Saved file: ${filePath}`);
        return filePath;
    }

    /**
     * Read file as buffer
     * @param {string} filePath - Path to file
     * @returns {Buffer} File data
     */
    readFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        return fs.readFileSync(filePath);
    }

    /**
     * Delete file
     * @param {string} filePath - Path to file
     */
    deleteFile(filePath) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[FileService] Deleted file: ${filePath}`);
        }
    }

    /**
     * List files in directory
     * @param {string} directory - Directory path
     * @param {string} extension - Optional file extension filter
     * @returns {Array<string>} Array of file paths
     */
    listFiles(directory, extension = null) {
        if (!fs.existsSync(directory)) {
            return [];
        }

        let files = fs.readdirSync(directory);

        if (extension) {
            files = files.filter(file => path.extname(file).toLowerCase() === extension.toLowerCase());
        }

        return files.map(file => path.join(directory, file));
    }

    /**
     * Get file stats
     * @param {string} filePath - Path to file
     * @returns {Object} File stats {size, created, modified}
     */
    getFileStats(filePath) {
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const stats = fs.statSync(filePath);
        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
        };
    }
}

// Export singleton instance
module.exports = new FileService();
