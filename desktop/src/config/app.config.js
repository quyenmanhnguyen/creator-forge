const path = require("path");

// API Endpoints
const API_ENDPOINTS = {
    LOGIN_URL: "https://accounts.x.ai/sign-in?redirect=grok-com&email=true",
    API_URL: "https://grok.com/rest/app-chat/conversations/new",
    POST_CREATE_URL: "https://grok.com/rest/media/post/create",
    POST_FOLDERS_URL: "https://grok.com/rest/media/post/folders",
    UPLOAD_URL: "https://grok.com/rest/app-chat/upload-file",
    ASSETS_BASE_URL: "https://assets.grok.com/",
};

// Model Configuration
const MODEL_CONFIG = {
    IMAGE_MODEL: "grok-3",
    VIDEO_MODEL: "grok-3",
    I2V_MODEL: "grok-3",
    REF_IMAGE_MODEL: "imagine-image-edit",
};

// Video Generation Config
const VIDEO_CONFIG = {
    aspectRatio: "16:9",
    videoLength: 10,
    isVideoEdit: false,
    resolutionName: "720p",
    resolutionOptions: ["480p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3"],
    lengthOptions: [5, 10, 15, 20],
};

// Image-to-Video Config
const I2V_CONFIG = {
    aspectRatio: "2:3",
    videoLength: 6,
    isVideoEdit: false,
    resolutionName: "480p",
    resolutionOptions: ["480p", "720p"],
    aspectRatioOptions: ["2:3", "3:2", "16:9", "9:16", "1:1"],
    lengthOptions: [3, 6, 9, 12],
};

// Image Generation Config
const IMAGE_CONFIG = {
    imageGenerationCount: 4,
    countOptions: [1, 2, 4],
    enableImageStreaming: true,
    returnImageBytes: false,
};

// Processing Config
const PROCESSING_CONFIG = {
    BATCH_SIZE: 10,
    CONCURRENCY: {
        IMAGE: 30,
        VIDEO: 30,
        I2V: 10,
    },
    MAX_RETRIES: 3,
    RETRY_DELAY: 10000, // 10 seconds
};

// Directory Paths — use writable location in production (asar is read-only)
let APP_BASE_DIR;
try {
    const isAsar = __dirname.includes('app.asar');
    if (isAsar) {
        const { app } = require('electron');
        APP_BASE_DIR = app.getPath('userData');
    } else if (process.env.AUTOGROK_USER_DATA_DIR) {
        APP_BASE_DIR = process.env.AUTOGROK_USER_DATA_DIR;
    } else {
        APP_BASE_DIR = path.join(__dirname, "..", "..");
    }
} catch (e) {
    APP_BASE_DIR = process.env.AUTOGROK_USER_DATA_DIR || path.join(__dirname, "..", "..");
}

const PATHS = {
    IMAGE_DIR: path.join(APP_BASE_DIR, "images"),
    VIDEO_DIR: path.join(APP_BASE_DIR, "videos"),
    I2V_DIR: path.join(APP_BASE_DIR, "i2v-videos"),
    I2V_INPUT_DIR: path.join(APP_BASE_DIR, "i2v-input"),
    SESSIONS_DIR: path.join(APP_BASE_DIR, "sessions"),
    LOG_DIR: path.join(APP_BASE_DIR, "logs"),
    ACCOUNTS_FILE: path.join(APP_BASE_DIR, "accounts.json"),
};

// File Upload Config
const FILE_CONFIG = {
    SUPPORTED_IMAGE_TYPES: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
    FILE_SOURCE: "IMAGINE_SELF_UPLOAD_FILE_SOURCE",
};

// Request Headers Template
const HEADER_CONFIG = {
    CONTENT_TYPE: "application/json",
    REFERER_I2V: "https://grok.com/imagine",
    REFERER_DEFAULT: "https://grok.com/",
};

// UI Configuration
const UI_CONFIG = {
    THEME: {
        DEFAULT: "dark",
        OPTIONS: ["light", "dark"],
    },
    TABLE: {
        ROWS_PER_PAGE: 50,
        VIRTUAL_SCROLL_THRESHOLD: 100,
    },
    THUMBNAIL: {
        MAX_DISPLAY: 5,
        SIZE: 120,
    },
};

module.exports = {
    API_ENDPOINTS,
    MODEL_CONFIG,
    VIDEO_CONFIG,
    I2V_CONFIG,
    IMAGE_CONFIG,
    PROCESSING_CONFIG,
    PATHS,
    FILE_CONFIG,
    HEADER_CONFIG,
    UI_CONFIG,
};
