const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { API_ENDPOINTS, MODEL_CONFIG, I2V_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');
const path = require('path');
const { validateVideoOutput, MIN_USABLE_VIDEO_BYTES } = require('../../dist/video_validation_helpers');

class I2VService {
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
     * Build request headers with optional referer
     */
    buildHeaders(capturedHeaders, cookieStr, referer = null) {
        const headers = {};
        for (const [k, v] of Object.entries(capturedHeaders)) {
            if (!k.startsWith(':')) headers[k] = v;
        }
        headers['content-type'] = 'application/json';
        headers['x-xai-request-id'] = crypto.randomUUID();
        headers['cookie'] = cookieStr;
        if (referer) headers['referer'] = referer;
        delete headers['host'];
        delete headers['content-length'];
        return headers;
    }

    /**
     * Upload image file
     * @param {string} imagePath - Path to image file
     * @param {Object} session - Session data
     * @returns {Promise<Object>} {fileMetadataId, fileUri} or {error}
     */
    async uploadFile(imagePath, session) {
        try {
            const fileBuffer = FileService.readFile(imagePath);
            const base64Content = fileBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase().replace('.', '');
            const mimeMap = {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                webp: 'image/webp',
                gif: 'image/gif',
            };
            const fileMimeType = mimeMap[ext] || 'image/jpeg';
            const fileName = `${crypto.randomUUID()}.${ext === 'jpg' ? 'jpeg' : ext}`;

            const cookieStr = this.formatCookies(session.cookies);

            const res = await axios.post(
                API_ENDPOINTS.UPLOAD_URL,
                {
                    fileName,
                    fileMimeType,
                    content: base64Content,
                    fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE',
                },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 60000,
                }
            );

            if (res.status !== 200) {
                return {
                    error: `upload HTTP ${res.status}`,
                    errorDetail: JSON.stringify(res.data).substring(0, 500),
                };
            }

            const fileMetadataId = res.data?.fileMetadataId;
            const fileUri = res.data?.fileUri;

            if (!fileMetadataId) {
                return {
                    error: 'no fileMetadataId',
                    errorDetail: JSON.stringify(res.data).substring(0, 500),
                };
            }

            console.log(`[I2VService] ✅ Upload OK: ${fileMetadataId}`);
            return { fileMetadataId, fileUri, uploadResponse: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Create media post (CRITICAL step for I2V)
     * @param {string} imageUrl - Full image URL
     * @param {Object} session - Session data
     * @returns {Promise<Object>} {postId} or {error}
     */
    async createMediaPost(imageUrl, session) {
        const cookieStr = this.formatCookies(session.cookies);

        try {
            const res = await axios.post(
                API_ENDPOINTS.POST_CREATE_URL,
                {
                    mediaType: 'MEDIA_POST_TYPE_IMAGE',
                    mediaUrl: imageUrl,
                },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 30000,
                }
            );

            if (res.status !== 200) {
                return {
                    error: `post/create HTTP ${res.status}`,
                    errorDetail: JSON.stringify(res.data).substring(0, 500),
                };
            }

            const postId = res.data?.post?.id;
            console.log(`[I2VService] ✅ post/create OK: postId=${postId}`);
            return { postId, postData: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Build I2V generation request body
     * @param {string} prompt - Video prompt
     * @param {string} fileMetadataId - File metadata ID from upload
     * @param {string} imageUrl - Full image URL
     * @param {Object} config - I2V configuration (from UI or I2V_CONFIG)
     * @returns {Object} Request body
     */
    buildI2VBody(prompt, fileMetadataId, imageUrl, config = {}) {
        // Merge UI config with I2V_CONFIG defaults, map field names
        const mergedConfig = {
            aspectRatio: config.aspectRatio || I2V_CONFIG.aspectRatio,
            videoLength: config.videoLength || I2V_CONFIG.videoLength,
            isVideoEdit: config.isVideoEdit !== undefined ? config.isVideoEdit : I2V_CONFIG.isVideoEdit,
            resolutionName: config.resolutionName || config.resolution || I2V_CONFIG.resolutionName,
        };

        console.log(`[I2VService] buildI2VBody config: aspectRatio=${mergedConfig.aspectRatio}, videoLength=${mergedConfig.videoLength}, resolution=${mergedConfig.resolutionName}`);

        const fileMetadataIds = Array.isArray(fileMetadataId) ? fileMetadataId.filter(Boolean) : [fileMetadataId].filter(Boolean);
        const imageUrls = Array.isArray(imageUrl) ? imageUrl.filter(Boolean) : [imageUrl].filter(Boolean);
        const imagePrefix = imageUrls.length ? `${imageUrls.join('  ')}  ` : '';
        const message = `${imagePrefix}${prompt} --mode=custom`;

        return {
            temporary: true,
            modelName: MODEL_CONFIG.I2V_MODEL,
            message,
            fileAttachments: fileMetadataIds,
            toolOverrides: { videoGen: true },
            enableSideBySide: true,
            responseMetadata: {
                experiments: [],
                modelConfigOverride: {
                    modelMap: {
                        videoGenModelConfig: {
                            parentPostId: fileMetadataIds[0],
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
     * Parse streaming I2V response
     * @param {AsyncIterable} stream - Response stream
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} Parsed result
     */
    async parseStreamResponse(stream, onProgress = null) {
        const result = {
            title: '',
            videoUrl: null,
            videoId: null,
            userId: null,
            progress: 0,
            error: null,
        };

        let buffer = '';
        let lastLog = 0;

        for await (const chunk of stream) {
            const chunkStr = chunk.toString();
            buffer += chunkStr;

            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line

            for (const line of lines) {
                if (!line.trim()) continue;

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
                        if (vr.videoId) result.videoId = vr.videoId;
                        if (vr.assetId) result.videoId = result.videoId || vr.assetId;

                        // Extract userId from imageReference
                        if (vr.imageReference && !result.userId) {
                            const m = vr.imageReference.match(/\/users\/([^/]+)\//);
                            if (m) result.userId = m[1];
                        }

                        const newProgress = vr.progress || result.progress;
                        if (newProgress > result.progress) {
                            result.progress = newProgress;
                            // Log every 20%
                            if (result.progress - lastLog >= 20) {
                                console.log(`[I2VService] Progress: ${result.progress}%`);
                                lastLog = result.progress;
                                if (onProgress) onProgress({ progress: result.progress });
                            }
                        }

                        if (vr.videoUrl) {
                            result.videoUrl = vr.videoUrl;
                            console.log(`[I2VService] 🎉 Video ready! url=${result.videoUrl.substring(0, 50)}`);
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
        }

        // Process remaining buffer
        if (buffer.trim()) {
            try {
                const j = JSON.parse(buffer);
                const vr = j.result?.response?.streamingVideoGenerationResponse;
                if (vr) {
                    result.progress = vr.progress || result.progress;
                    if (vr.videoUrl) {
                        result.videoUrl = vr.videoUrl;
                        result.videoId = vr.videoId || vr.assetId || result.videoId;
                    }
                }
            } catch (_) { }
        }

        // Fallback: use videoId as download key
        if (!result.videoUrl && result.videoId) {
            result.videoUrl = result.videoId;
            console.log(`[I2VService] Using videoId as download key: ${result.videoId}`);
        }

        if (!result.videoUrl && !result.error) {
            result.error = `Video generation stopped at ${result.progress}% - no video URL or ID returned`;
        }

        return result;
    }

    /**
     * Download video by URL
     * @param {string} url - Full or partial video URL
     * @param {Object} session - Session data
     * @returns {Promise<Object>} Video data {data, size}
     */
    async downloadVideoByUrl(url, session) {
        const cookieStr = this.formatCookies(session.cookies);
        const dlHeaders = {};
        for (const [k, v] of Object.entries(session.capturedHeaders)) {
            if (!k.startsWith(':')) dlHeaders[k] = v;
        }
        dlHeaders['cookie'] = cookieStr;
        dlHeaders['referer'] = 'https://grok.com/';
        dlHeaders['origin'] = 'https://grok.com';
        dlHeaders['accept'] = '*/*';
        delete dlHeaders['host'];
        delete dlHeaders['content-length'];
        delete dlHeaders['content-type'];

        const fullUrl = url.startsWith('http') ? url : `${API_ENDPOINTS.ASSETS_BASE_URL}${url}`;

        const MAX_RETRIES = 5;
        const RETRY_DELAY = 3000;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const res = await axios.get(fullUrl, {
                    headers: dlHeaders,
                    responseType: 'arraybuffer',
                    timeout: 120000,
                    validateStatus: () => true,
                });

                if (res.status === 200 && res.data.byteLength > 1000) {
                    return { data: Buffer.from(res.data), size: res.data.byteLength };
                }

                if (res.status === 404 || res.status === 403) {
                    if (attempt < MAX_RETRIES - 1) {
                        console.log(`[I2VService] Video not ready (${res.status}), retry ${attempt + 1}/${MAX_RETRIES}...`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                        continue;
                    }
                }

                console.log(`[I2VService] Download → HTTP ${res.status}`);
            } catch (error) {
                console.log(`[I2VService] Download error:`, error.message.substring(0, 60));
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
            }
        }

        return null;
    }

    /**
     * Download video directly to disk to avoid holding MP4 buffers in memory.
     */
    async downloadVideoByUrlToFile(url, session, filePath) {
        const cookieStr = this.formatCookies(session.cookies);
        const dlHeaders = {};
        for (const [k, v] of Object.entries(session.capturedHeaders)) {
            if (!k.startsWith(':')) dlHeaders[k] = v;
        }
        dlHeaders['cookie'] = cookieStr;
        dlHeaders['referer'] = 'https://grok.com/';
        dlHeaders['origin'] = 'https://grok.com';
        dlHeaders['accept'] = '*/*';
        delete dlHeaders['host'];
        delete dlHeaders['content-length'];
        delete dlHeaders['content-type'];

        const fullUrl = url.startsWith('http') ? url : `${API_ENDPOINTS.ASSETS_BASE_URL}${url}`;
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 3000;
        const tmpPath = `${filePath}.download`;
        FileService.ensureDir(path.dirname(filePath));

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                const res = await axios.get(fullUrl, {
                    headers: dlHeaders,
                    responseType: 'stream',
                    timeout: 120000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    validateStatus: () => true,
                });

                if (res.status === 200) {
                    await new Promise((resolve, reject) => {
                        const writer = fs.createWriteStream(tmpPath);
                        res.data.on('error', reject);
                        writer.on('error', reject);
                        writer.on('finish', resolve);
                        res.data.pipe(writer);
                    });

                    const size = fs.statSync(tmpPath).size;
                    if (size > 1000) {
                        // Probe the temp file before promoting it to the final
                        // path. ffprobe catches a chunked-truncated mp4 (one
                        // where the moov atom never landed) that the byte
                        // floor of 1KB would otherwise let through. When
                        // ffprobe isn't installed the helper degrades to
                        // exists+size and we keep the legacy contract.
                        const check = await validateVideoOutput(tmpPath, { minBytes: MIN_USABLE_VIDEO_BYTES });
                        if (!check.ok) {
                            try { fs.unlinkSync(tmpPath); } catch (_) {}
                            console.log(`[I2VService] Download rejected by validator: ${check.reason}`);
                            return null;
                        }
                        if (!check.ffprobeAvailable) {
                            console.log('[I2VService] ffprobe unavailable — accepted on size-only fallback.');
                        }
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                        fs.renameSync(tmpPath, filePath);
                        console.log(`[I2VService] Saved stream: ${filePath}`);
                        return { path: filePath, size, validation: check };
                    }
                    fs.unlinkSync(tmpPath);
                }

                if (res.status === 404 || res.status === 403) {
                    if (attempt < MAX_RETRIES - 1) {
                        console.log(`[I2VService] Video not ready (${res.status}), retry ${attempt + 1}/${MAX_RETRIES}...`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                        continue;
                    }
                }

                console.log(`[I2VService] Download → HTTP ${res.status}`);
            } catch (error) {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
                console.log(`[I2VService] Download error:`, error.message.substring(0, 80));
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
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
     * Generate single I2V video (with retry for network errors)
     * @param {Object} item - {imagePath, prompt}
     * @param {Object} session - Session data
     * @param {Object} config - I2V configuration
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} Result with video URL
     */
    async generateOne(item, session, config = I2V_CONFIG, onProgress = null) {
        const { imagePath, prompt } = item;
        const imagePaths = (Array.isArray(item.refImagePaths) && item.refImagePaths.length > 0)
            ? item.refImagePaths.filter(Boolean)
            : [imagePath].filter(Boolean);
        const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;
        const BASE_DELAY = PROCESSING_CONFIG.RETRY_DELAY;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Step 1: Upload image
                console.log(`[I2VService] 📤 Uploading ${imagePaths.length} ref image(s): ${imagePaths.map(p => path.basename(p)).join(', ')}...${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);
                const uploads = [];
                for (const refPath of imagePaths) {
                    const uploaded = await this.uploadFile(refPath, session);
                    uploads.push(uploaded);
                    if (uploaded.error) break;
                }
                const upload = uploads.find(u => u.error) || uploads[0];

                // Handle 403 from upload — re-login and retry
                if (upload.error && upload.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
                    console.warn(`[I2VService] ⚠️ 403 from upload for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[I2VService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
                    }
                }

                if (upload.error) {
                    return { ...upload, videoUrl: null, progress: 0 };
                }

                const fileMetadataIds = uploads.map(u => u.fileMetadataId).filter(Boolean);
                const imageUrls = uploads.map(u => u.fileUri ? `${API_ENDPOINTS.ASSETS_BASE_URL}${u.fileUri}` : null).filter(Boolean);
                const imageUrl = imageUrls[0] || null;

                // Step 2: Create media post (CRITICAL!)
                console.log(`[I2VService] 📝 Creating media post...`);
                const post = await this.createMediaPost(imageUrl, session);

                // Handle 403 from createMediaPost — re-login and retry
                if (post.error && post.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
                    console.warn(`[I2VService] ⚠️ 403 from createMediaPost for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[I2VService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
                    }
                }

                if (post.error) {
                    return { ...post, videoUrl: null, progress: 0 };
                }

                // Step 3: Generate video
                console.log(`[I2VService] 🎬 Generating video (stream)...`);
                const cookieStr = this.formatCookies(session.cookies);

                const res = await axios.post(
                    API_ENDPOINTS.API_URL,
                    this.buildI2VBody(prompt, fileMetadataIds, imageUrls, config),
                    {
                        headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                        responseType: 'stream',
                        validateStatus: () => true,
                        timeout: 300000,
                    }
                );

                // Handle 429 rate limit - retry
                if (res.status === 429 && attempt < MAX_RETRIES) {
                    const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
                    console.log(`[I2VService] ⚠️ Rate limited (429), retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }

                // Handle 403 — session expired, re-login this account only
                if (res.status === 403 && attempt < MAX_RETRIES) {
                    console.warn(`[I2VService] ⚠️ 403 Forbidden for ${session.email} — attempting re-login...`);
                    // Drain stream to avoid memory leak
                    for await (const chunk of res.data) { /* discard */ }
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[I2VService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
                    }
                }

                if (res.status !== 200) {
                    let errBody = '';
                    for await (const chunk of res.data) errBody += chunk.toString();
                    return {
                        videoUrl: null,
                        progress: 0,
                        error: `HTTP ${res.status}`,
                        errorDetail: errBody.substring(0, 500),
                    };
                }

                const result = await this.parseStreamResponse(res.data, onProgress);
                result.fileMetadataId = fileMetadataIds[0];
                result.fileMetadataIds = fileMetadataIds;

                return result;
            } catch (error) {
                if (attempt < MAX_RETRIES && this._isRetryableError(error)) {
                    const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
                    console.log(`[I2VService] ⚠️ ${error.message}, retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }
                return {
                    videoUrl: null,
                    progress: 0,
                    error: error.message,
                };
            }
        }
    }

    /**
     * Generate I2V videos with multiple images (concurrent worker pool)
     * @param {Array<Object>} items - Array of {imagePath, prompt}
     * @param {Object} session - Session data
     * @param {Object} config - I2V configuration
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Array<Object>>} Results array
     */
    async generateBatch(items, session, config = I2V_CONFIG, onProgress = null, startIdx = 0) {
        const N = items.length;
        const requestedConcurrency = Number(config.batchSize || PROCESSING_CONFIG.CONCURRENCY.I2V || PROCESSING_CONFIG.BATCH_SIZE || 10);
        const CONCURRENCY = Math.max(1, Math.min(requestedConcurrency, 5));
        const outputFolder = config.outputFolder || PATHS.I2V_DIR;
        const label = `Acc${session.accIdx + 1}`;

        console.log(`[I2VService] [${label}] ${N} I2V items | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

        const results = [];
        let nextIdx = 0;
        const self = this;

        async function worker() {
            while (nextIdx < N) {
                const myIdx = nextIdx++;
                const item = items[myIdx];
                const globalNum = startIdx + myIdx + 1; // 1-based global number

                console.log(`[I2VService] [${label}] 🎬📸 #${myIdx + 1}/${N} (shot${String(globalNum).padStart(4, '0')}) processing: ${path.basename(item.imagePath)}`);

                const result = await self.generateOne(item, session, config, (prog) => {
                    if (onProgress) onProgress(item, prog.progress, null, myIdx);
                });

                // Download video
                let savedFile = null;
                if (result.videoUrl) {
                    console.log(`[I2VService] [${label}] 📥 #${myIdx + 1} downloading...`);
                    try {
                        const shotNum = String(globalNum).padStart(4, '0');
                        const titleSlug = (result.title || '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);
                        const filename = titleSlug ? `shot${shotNum}_${titleSlug}.mp4` : `shot${shotNum}.mp4`;
                        const filePath = path.join(outputFolder, filename);
                        const dl = await self.downloadVideoByUrlToFile(result.videoUrl, session, filePath);
                        if (dl) {
                            savedFile = dl.path;
                        }
                    } catch (error) {
                        console.error(`[I2VService] [${label}] Download error:`, error.message);
                    }
                }

                const jobResult = {
                    imagePath: item.imagePath,
                    prompt: item.prompt,
                    localIdx: myIdx,
                    title: result.title,
                    videoId: result.videoId,
                    savedFile,
                    outputPath: savedFile || null,
                    success: !!savedFile,
                    error: result.error,
                };

                results.push(jobResult);

                if (onProgress) {
                    onProgress(item, 100, jobResult, myIdx);
                }

                console.log(`[I2VService] [${label}] #${myIdx + 1}/${N} ${savedFile ? '✅' : '❌'} ${result.title || item.prompt.substring(0, 50)}`);
            }
        }

        // Launch concurrent workers with staggered starts
        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
            workers.push(
                new Promise((resolve) => setTimeout(() => resolve(worker()), i * 200))
            );
        }
        await Promise.all(workers);

        console.log(`[I2VService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
        return results;
    }
}

// Export singleton instance
module.exports = new I2VService();
