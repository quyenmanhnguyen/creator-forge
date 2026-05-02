const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { API_ENDPOINTS, MODEL_CONFIG, VIDEO_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');
const { validateVideoOutput, MIN_USABLE_VIDEO_BYTES } = require('../../dist/video_validation_helpers');

class VideoService {
  constructor() {
    this.activeJobs = new Map();
  }

  /**
   * Format cookies for headers
   */
  formatCookies(cookies) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * Build request headers
   */
  buildHeaders(capturedHeaders, cookieStr) {
    const headers = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
      if (!k.startsWith(':')) headers[k] = v;
    }
    headers['content-type'] = 'application/json';
    headers['x-xai-request-id'] = crypto.randomUUID();
    headers['cookie'] = cookieStr;
    delete headers['host'];
    delete headers['content-length'];
    return headers;
  }

  /**
   * Create media post (required step before video generation)
   * @param {string} prompt - Video prompt
   * @param {Object} session - Session data
   * @returns {Promise<Object>} {postId} or {error}
   */
  async createPost(prompt, session) {
    const cookieStr = this.formatCookies(session.cookies);

    try {
      const res = await axios.post(
        API_ENDPOINTS.POST_CREATE_URL,
        {
          mediaType: 'MEDIA_POST_TYPE_VIDEO',
          prompt: prompt,
        },
        {
          headers: this.buildHeaders(session.capturedHeaders, cookieStr),
          validateStatus: () => true,
          timeout: 30000,
        }
      );

      if (res.status !== 200) {
        return {
          error: `createPost HTTP ${res.status}`,
          errorDetail: JSON.stringify(res.data).substring(0, 500),
        };
      }

      const postId = res.data?.post?.id;
      if (!postId) {
        return { error: 'no postId returned' };
      }

      return { postId };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Build video generation request body
   * @param {string} prompt - Video prompt
   * @param {string} parentPostId - Post ID from createPost
   * @param {Object} config - Video configuration
   * @returns {Object} Request body
   */
  buildVideoBody(prompt, parentPostId, config = {}) {
    // Merge UI config with VIDEO_CONFIG defaults, map field names
    const mergedConfig = {
      aspectRatio: config.aspectRatio || VIDEO_CONFIG.aspectRatio,
      videoLength: config.videoLength || VIDEO_CONFIG.videoLength,
      isVideoEdit: config.isVideoEdit !== undefined ? config.isVideoEdit : VIDEO_CONFIG.isVideoEdit,
      resolutionName: config.resolutionName || config.resolution || VIDEO_CONFIG.resolutionName,
    };

    console.log(`[VideoService] buildVideoBody config: aspectRatio=${mergedConfig.aspectRatio}, videoLength=${mergedConfig.videoLength}, resolution=${mergedConfig.resolutionName}`);

    return {
      temporary: true,
      modelName: MODEL_CONFIG.VIDEO_MODEL,
      message: prompt + ' --mode=custom',
      toolOverrides: { videoGen: true },
      enableSideBySide: true,
      responseMetadata: {
        experiments: [],
        modelConfigOverride: {
          modelMap: {
            videoGenModelConfig: {
              parentPostId,
              aspectRatio: mergedConfig.aspectRatio,
              videoLength: mergedConfig.videoLength,
              isVideoEdit: mergedConfig.isVideoEdit,
              resolutionName: mergedConfig.resolutionName,
            },
          },
        },
      },
    };
  }

  /**
   * Parse streaming NDJSON response
   * @param {string} text - Response text
   * @returns {Object} Parsed result
   */
  parseStreamResponse(text) {
    const result = {
      title: '',
      videoUrl: null,
      videoId: null,
      progress: 0,
      error: null,
      errorDetail: null,
    };

    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

        // Errors
        if (j.error) {
          const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
          if (!result.error) result.error = msg;
        }
        if (j.result?.error) {
          const msg = typeof j.result.error === 'string' ? j.result.error : j.result.error.message || JSON.stringify(j.result.error);
          if (!result.error) result.error = msg;
        }

        const mr = j.result?.response?.modelResponse;
        if (mr?.error) {
          const msg = typeof mr.error === 'string' ? mr.error : mr.error.message || JSON.stringify(mr.error);
          if (!result.error) result.error = msg;
        }
        if (mr?.isSoftBlock || mr?.isDisallowed) {
          if (!result.error) result.error = `Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`;
        }

        // Video progress
        const vr = j.result?.response?.streamingVideoGenerationResponse;
        if (vr) {
          result.progress = vr.progress || result.progress;
          // Capture videoId/assetId whenever available
          if (vr.videoId) result.videoId = vr.videoId;
          if (vr.assetId) result.videoId = result.videoId || vr.assetId;
          // Capture videoUrl whenever available (not just at progress=100)
          if (vr.videoUrl) {
            result.videoUrl = vr.videoUrl;
          }
          if (vr.error) {
            const msg = typeof vr.error === 'string' ? vr.error : vr.error.message || JSON.stringify(vr.error);
            if (!result.error) result.error = msg;
          }
        }
      } catch (_) {
        // Ignore parse errors
      }
    }

    // Fallback: use videoId as download key
    if (!result.videoUrl && result.videoId) {
      result.videoUrl = result.videoId;
      console.log(`[VideoService] Using videoId as download key: ${result.videoId}`);
    }

    if (!result.videoUrl && !result.error) {
      result.error = `Video generation stopped at ${result.progress}% - no video URL returned`;
    }

    return result;
  }

  /**
   * Download video
   * @param {string} videoUrl - Video URL path
   * @param {Object} session - Session data
   * @returns {Promise<Object>} Video data {data, size}
   */
  async downloadVideo(videoUrl, session) {
    const cookieStr = this.formatCookies(session.cookies);
    const bases = [API_ENDPOINTS.ASSETS_BASE_URL];

    const dlHeaders = {};
    for (const [k, v] of Object.entries(session.capturedHeaders)) {
      if (!k.startsWith(':')) dlHeaders[k] = v;
    }
    dlHeaders['cookie'] = cookieStr;
    delete dlHeaders['host'];
    delete dlHeaders['content-length'];
    delete dlHeaders['content-type'];

    for (const base of bases) {
      try {
        const res = await axios.get(base + videoUrl, {
          headers: dlHeaders,
          responseType: 'arraybuffer',
          timeout: 120000,
          validateStatus: () => true,
        });

        if (res.status === 200) {
          return {
            data: Buffer.from(res.data),
            size: res.data.byteLength,
          };
        }
        console.log(`[VideoService] Download ${base} → HTTP ${res.status}`);
      } catch (error) {
        console.log(`[VideoService] Download error:`, error.message.substring(0, 60));
      }
    }
    return null;
  }

  /**
   * Download video directly to disk to avoid holding MP4 buffers in memory.
   */
  async downloadVideoToFile(videoUrl, session, filePath) {
    const cookieStr = this.formatCookies(session.cookies);
    const bases = [API_ENDPOINTS.ASSETS_BASE_URL];

    const dlHeaders = {};
    for (const [k, v] of Object.entries(session.capturedHeaders)) {
      if (!k.startsWith(':')) dlHeaders[k] = v;
    }
    dlHeaders['cookie'] = cookieStr;
    delete dlHeaders['host'];
    delete dlHeaders['content-length'];
    delete dlHeaders['content-type'];

    FileService.ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.download`;

    for (const base of bases) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        const res = await axios.get(base + videoUrl, {
          headers: dlHeaders,
          responseType: 'stream',
          timeout: 120000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });

        if (res.status !== 200) {
          console.log(`[VideoService] Download ${base} → HTTP ${res.status}`);
          continue;
        }

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(tmpPath);
          res.data.on('error', reject);
          writer.on('error', reject);
          writer.on('finish', resolve);
          res.data.pipe(writer);
        });

        const size = fs.statSync(tmpPath).size;
        if (size <= 1000) {
          fs.unlinkSync(tmpPath);
          throw new Error(`Downloaded file too small (${size} bytes)`);
        }

        // Probe the temp file before promoting it. ffprobe catches a
        // chunked-truncated mp4 (no moov atom) that the legacy 1KB
        // floor would otherwise wave through; when ffprobe is missing
        // the helper falls back to exists+size and we keep behavior.
        const check = await validateVideoOutput(tmpPath, { minBytes: MIN_USABLE_VIDEO_BYTES });
        if (!check.ok) {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          throw new Error(`Downloaded file rejected by validator: ${check.reason}`);
        }
        if (!check.ffprobeAvailable) {
          console.log('[VideoService] ffprobe unavailable — accepted on size-only fallback.');
        }

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath);
        console.log(`[VideoService] Saved stream: ${filePath}`);
        return { path: filePath, size, validation: check };
      } catch (error) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        console.log(`[VideoService] Download error:`, error.message.substring(0, 80));
      }
    }
    return null;
  }

  /**
   * Check if an error is a retryable network error
   * @param {Error} error - Error object
   * @returns {boolean}
   */
  _isRetryableError(error) {
    const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'];
    if (error.code && retryableCodes.includes(error.code)) return true;
    if (error.message && retryableCodes.some(c => error.message.includes(c))) return true;
    return false;
  }

  /**
   * Generate single video (with retry for network errors)
   * @param {string} prompt - Video prompt
   * @param {Object} session - Session data
   * @param {Object} config - Video configuration
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<Object>} Result with video URL
   */
  async generateOne(prompt, session, config = VIDEO_CONFIG, onProgress = null) {
    const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;
    const BASE_DELAY = PROCESSING_CONFIG.RETRY_DELAY;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Step 1: Create post
        console.log(`[VideoService] Creating post for: ${prompt.substring(0, 50)}...${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);
        const post = await this.createPost(prompt, session);

        // Handle 403 from createPost — re-login and retry
        if (post.error && post.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
          console.warn(`[VideoService] ⚠️ 403 from createPost for ${session.email} — attempting re-login...`);
          const newSession = await AuthService.reloginAccount(session.email);
          if (newSession) {
            Object.assign(session, newSession);
            console.log(`[VideoService] ✅ Re-login OK for ${session.email}, retrying...`);
            continue;
          } else {
            return { title: '', videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
          }
        }

        if (post.error) {
          return { ...post, title: '', videoUrl: null, progress: 0 };
        }

        // Step 2: Generate video
        console.log(`[VideoService] Generating video (postId: ${post.postId})...`);
        const cookieStr = this.formatCookies(session.cookies);

        const res = await axios.post(
          API_ENDPOINTS.API_URL,
          this.buildVideoBody(prompt, post.postId, config),
          {
            headers: this.buildHeaders(session.capturedHeaders, cookieStr),
            responseType: 'text',
            validateStatus: () => true,
            timeout: 300000, // 5 min
          }
        );

        // Handle 429 rate limit - retry
        if (res.status === 429 && attempt < MAX_RETRIES) {
          const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
          console.log(`[VideoService] ⚠️ Rate limited (429), retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, wait));
          continue;
        }

        // Handle 403 — session expired, re-login this account only
        if (res.status === 403 && attempt < MAX_RETRIES) {
          console.warn(`[VideoService] ⚠️ 403 Forbidden for ${session.email} — attempting re-login...`);
          const newSession = await AuthService.reloginAccount(session.email);
          if (newSession) {
            Object.assign(session, newSession);
            console.log(`[VideoService] ✅ Re-login OK for ${session.email}, retrying...`);
            continue;
          } else {
            return { title: '', videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
          }
        }

        if (res.status !== 200) {
          return {
            title: '',
            videoUrl: null,
            progress: 0,
            error: `HTTP ${res.status}`,
            errorDetail: (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).substring(0, 500),
          };
        }

        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const parsed = this.parseStreamResponse(text);

        if (onProgress && parsed.progress === 100) {
          onProgress({ progress: 100, status: 'completed' });
        }

        return parsed;
      } catch (error) {
        if (attempt < MAX_RETRIES && this._isRetryableError(error)) {
          const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
          console.log(`[VideoService] ⚠️ ${error.message}, retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, wait));
          continue;
        }
        return {
          title: '',
          videoUrl: null,
          progress: 0,
          error: error.message,
        };
      }
    }
  }

  /**
   * Process a single prompt — generate the video via Grok, download
   * it to disk, and return a ``jobResult`` with the same shape
   * ``generateBatch`` produces.
   *
   * Extracted from the inner worker function of ``generateBatch`` so
   * the cross-session work-stealing fan-out scheduler in
   * ``electron/main.js`` (PR for video / i2v / refimg) can dispatch
   * single items directly to a pool of sessions without going
   * through ``generateBatch``'s static-slice contract.
   *
   * Behaviour, file-naming convention, and progress reporting are
   * unchanged from the previous worker; any deviation is a
   * regression.
   *
   * @param {string} prompt
   * @param {object} session
   * @param {object} [config={}]
   * @param {Function|null} [onProgress=null] - (prompt, progress, result|null, localIdx) => void
   * @param {number} myIdx - 0-based per-session index reported back via onProgress.
   * @param {number} globalNum - 1-based global shot number used for ``shot####`` naming.
   * @param {number} totalForLog - "N" used in the "#i/N" log decoration.
   * @param {string} [outputFolder] - Where to write videos. Defaults to ``config.outputFolder`` / ``PATHS.VIDEO_DIR``.
   * @returns {Promise<object>} jobResult: { prompt, localIdx, title, videoId, savedFile, outputPath, success, error }
   */
  async _processOneBatchItem(
    prompt,
    session,
    config = {},
    onProgress = null,
    myIdx = 0,
    globalNum = 1,
    totalForLog = 1,
    outputFolder = null,
  ) {
    const folder = outputFolder || config.outputFolder || PATHS.VIDEO_DIR;
    const label = `Acc${session.accIdx + 1}`;

    console.log(`[VideoService] [${label}] 🎬 #${myIdx + 1}/${totalForLog} (shot${String(globalNum).padStart(4, '0')}) starting: ${prompt.substring(0, 50)}...`);

    const result = await this.generateOne(prompt, session, config, (prog) => {
      if (onProgress) onProgress(prompt, prog.progress, null, myIdx);
    });

    let savedFile = null;
    if (result.videoUrl) {
      console.log(`[VideoService] [${label}] 📥 #${myIdx + 1} downloading...`);
      try {
        const shotNum = String(globalNum).padStart(4, '0');
        const titleSlug = (result.title || '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);
        const filename = titleSlug ? `shot${shotNum}_${titleSlug}.mp4` : `shot${shotNum}.mp4`;
        const filePath = path.join(folder, filename);
        const dl = await this.downloadVideoToFile(result.videoUrl, session, filePath);
        if (dl) {
          savedFile = dl.path;
        }
      } catch (error) {
        console.error(`[VideoService] [${label}] Download error:`, error.message);
      }
    }

    const jobResult = {
      prompt,
      localIdx: myIdx,
      title: result.title,
      videoId: result.videoId,
      savedFile,
      outputPath: savedFile || null,
      success: !!savedFile,
      error: result.error,
    };

    if (onProgress) {
      onProgress(prompt, 100, jobResult, myIdx);
    }

    console.log(`[VideoService] [${label}] #${myIdx + 1}/${totalForLog} ${savedFile ? '✅' : '❌'} ${result.title || prompt.substring(0, 50)}`);
    return jobResult;
  }

  async generateBatch(prompts, session, config = VIDEO_CONFIG, onProgress = null, startIdx = 0) {
    const N = prompts.length;
    const requestedConcurrency = Number(config.batchSize || PROCESSING_CONFIG.BATCH_SIZE || 10);
    const CONCURRENCY = Math.max(1, Math.min(requestedConcurrency, 5));
    const label = `Acc${session.accIdx + 1}`;

    console.log(`[VideoService] [${label}] ${N} videos | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

    const results = [];
    let nextIdx = 0;
    const self = this;

    async function worker() {
      while (nextIdx < N) {
        const myIdx = nextIdx++;
        const prompt = prompts[myIdx];
        const globalNum = startIdx + myIdx + 1; // 1-based global number
        const jobResult = await self._processOneBatchItem(
          prompt,
          session,
          config,
          onProgress,
          myIdx,
          globalNum,
          N,
        );
        results.push(jobResult);
      }
    }

    // Launch concurrent workers with staggered starts
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
      workers.push(
        new Promise((resolve) => setTimeout(() => resolve(worker()), i * 75))
      );
    }
    await Promise.all(workers);

    console.log(`[VideoService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }
}

// Export singleton instance
module.exports = new VideoService();

