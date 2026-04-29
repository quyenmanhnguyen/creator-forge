const path = require("path");

// In production (asar), __dirname is inside read-only archive
// Use app.getPath('userData') for writable directories
let BASE_DIR;
try {
  const isAsar = __dirname.includes('app.asar');
  if (isAsar) {
    // Electron packaged — use %APPDATA%/autogrok
    const { app } = require('electron');
    BASE_DIR = app.getPath('userData');
  } else if (process.env.AUTOGROK_USER_DATA_DIR) {
    BASE_DIR = process.env.AUTOGROK_USER_DATA_DIR;
  } else {
    BASE_DIR = path.join(__dirname, "..");
  }
} catch (e) {
  BASE_DIR = process.env.AUTOGROK_USER_DATA_DIR || path.join(__dirname, "..");
}

const LOGIN_URL = "https://accounts.x.ai/sign-in?redirect=grok-com&email=true";
const API_URL = "https://grok.com/rest/app-chat/conversations/new";
const POST_CREATE_URL = "https://grok.com/rest/media/post/create";
const UPLOAD_URL = "https://grok.com/rest/app-chat/upload-file";
const IMAGE_DIR = path.join(BASE_DIR, "images");
const VIDEO_DIR = path.join(BASE_DIR, "videos");
const I2V_DIR = path.join(BASE_DIR, "i2v-videos");
const SESSIONS_DIR = path.join(BASE_DIR, "sessions");
const LOG_DIR = path.join(BASE_DIR, "logs");
const BATCH_SIZE = 30;

const MODE = process.argv.includes("--i2v")
  ? "i2v"
  : process.argv.includes("--video")
    ? "video"
    : "image";
const COUNT = (() => {
  const a = process.argv.find((x) => x.startsWith("--count="));
  return a ? parseInt(a.split("=")[1]) : 0;
})();

const VIDEO_CONFIG = {
  aspectRatio: "16:9",
  videoLength: 10,
  isVideoEdit: false,
  resolutionName: "720p",
};

const I2V_CONFIG = {
  aspectRatio: "2:3",
  videoLength: 6,
  isVideoEdit: false,
  resolutionName: "480p",
};

module.exports = {
  LOGIN_URL,
  API_URL,
  POST_CREATE_URL,
  UPLOAD_URL,
  IMAGE_DIR,
  VIDEO_DIR,
  I2V_DIR,
  SESSIONS_DIR,
  LOG_DIR,
  BATCH_SIZE,
  MODE,
  COUNT,
  VIDEO_CONFIG,
  I2V_CONFIG,
};
