const axios = require('axios');
const crypto = require('crypto');
const { API_ENDPOINTS, MODEL_CONFIG, IMAGE_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');
const path = require('path');

/**
 * RefImageService — Generate images using reference images (imagine-image-edit model)
 * Flow: upload ref images → post/create → post/folders → conversations/new
 * 
 * Robust version: ports imageChunkMap UUID tracking, multi-variant parallel download,
 * browser-context fallback, and collision-safe file naming from ImageService.
 */
class RefImageService {
    constructor() {
        this.activeJobs = new Map();
    }

    formatCookies(cookies) {
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

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

    static parseRefImageName(filePath) {
        const basename = path.basename(filePath, path.extname(filePath));
        return basename.replace(/_/g, ' ').toLowerCase().trim();
    }

    static matchRefImages(prompt, refImages) {
        const promptLower = prompt.toLowerCase();
        const matched = refImages.filter(ref => promptLower.includes(ref.name));
        return matched.slice(0, 3);
    }

    async uploadFile(imagePath, session) {
        try {
            const fileBuffer = FileService.readFile(imagePath);
            const base64Content = fileBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase().replace('.', '');
            const mimeMap = {
                jpg: 'image/jpeg', jpeg: 'image/jpeg',
                png: 'image/png', webp: 'image/webp', gif: 'image/gif',
            };
            const fileMimeType = mimeMap[ext] || 'image/jpeg';
            const fileName = `${crypto.randomUUID()}.${ext === 'jpg' ? 'jpeg' : ext}`;
            const cookieStr = this.formatCookies(session.cookies);
            const res = await axios.post(
                API_ENDPOINTS.UPLOAD_URL,
                { fileName, fileMimeType, content: base64Content, fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE' },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true, timeout: 60000,
                }
            );
            if (res.status !== 200) {
                return { error: `upload HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
            }
            const fileMetadataId = res.data?.fileMetadataId;
            const fileUri = res.data?.fileUri;
            if (!fileMetadataId) {
                return { error: 'no fileMetadataId', errorDetail: JSON.stringify(res.data).substring(0, 500) };
            }
            console.log(`[RefImageService] ✅ Upload OK: ${fileMetadataId}`);
            return { fileMetadataId, fileUri, uploadResponse: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    async createMediaPost(imageUrl, session) {
        const cookieStr = this.formatCookies(session.cookies);
        try {
            const res = await axios.post(
                API_ENDPOINTS.POST_CREATE_URL,
                { mediaType: 'MEDIA_POST_TYPE_IMAGE', mediaUrl: imageUrl },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true, timeout: 30000,
                }
            );
            if (res.status !== 200) {
                return { error: `post/create HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
            }
            const postId = res.data?.post?.id;
            console.log(`[RefImageService] ✅ post/create OK: postId=${postId}`);
            return { postId, postData: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    async createPostFolder(postId, session) {
        const cookieStr = this.formatCookies(session.cookies);
        try {
            const res = await axios.post(
                API_ENDPOINTS.POST_FOLDERS_URL,
                { postId },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true, timeout: 30000,
                }
            );
            if (res.status !== 200) {
                console.log(`[RefImageService] ⚠️ post/folders HTTP ${res.status} (non-critical)`);
            } else {
                console.log(`[RefImageService] ✅ post/folders OK`);
            }
            return { success: res.status === 200, data: res.data };
        } catch (error) {
            console.log(`[RefImageService] ⚠️ post/folders error: ${error.message} (non-critical)`);
            return { success: false, error: error.message };
        }
    }

    async uploadRefImages(imagePaths, session) {
        const imageUrls = [];
        let lastPostId = null;
        for (let i = 0; i < imagePaths.length; i++) {
            const imgPath = imagePaths[i];
            console.log(`[RefImageService] 📤 Uploading ref ${i + 1}/${imagePaths.length}: ${path.basename(imgPath)}`);
            const upload = await this.uploadFile(imgPath, session);
            if (upload.error) return { error: `Upload ref ${i + 1} failed: ${upload.error}` };
            const imageUrl = upload.fileUri ? `${API_ENDPOINTS.ASSETS_BASE_URL}${upload.fileUri}` : null;
            if (!imageUrl) return { error: `No fileUri for ref ${i + 1}` };
            const post = await this.createMediaPost(imageUrl, session);
            if (post.error) return { error: `Post/create ref ${i + 1} failed: ${post.error}` };
            imageUrls.push(imageUrl);
            lastPostId = post.postId;
        }
        if (lastPostId) await this.createPostFolder(lastPostId, session);
        return { imageUrls, parentPostId: lastPostId };
    }

    /**
     * Build request body for ref image generation (imagine-image-edit model)
     * Now includes enableNsfw, enablePro, and correct imageGenerationCount
     */
    buildRefImageBody(prompt, imageUrls, parentPostId, config = {}) {
        const imageCount = config.imageGenerationCount || config.count || IMAGE_CONFIG.imageGenerationCount || 4;
        const enableNsfw = config.enableNsfw === false ? false : true;
        const enablePro = config.enablePro !== false ? true : false;
        return {
            temporary: true,
            modelName: MODEL_CONFIG.REF_IMAGE_MODEL,
            message: prompt,
            enableImageGeneration: true,
            returnImageBytes: false,
            returnRawGrokInXaiRequest: false,
            enableImageStreaming: true,
            imageGenerationCount: imageCount,
            forceConcise: false,
            toolOverrides: { imageGen: true },
            enableSideBySide: true,
            enableNsfw,
            enablePro,
            sendFinalMetadata: true,
            isReasoning: false,
            disableTextFollowUps: true,
            responseMetadata: {
                modelConfigOverride: {
                    modelMap: {
                        imageEditModelConfig: {
                            imageReferences: imageUrls,
                            parentPostId: parentPostId,
                        },
                        imageEditModel: 'imagine',
                    },
                },
            },
            disableMemory: false,
            forceSideBySide: false,
        };
    }

    /* ── Dedup helpers (ported from ImageService) ── */
    pushUniqueImageUrl(result, imageUrl, imageIndex) {
        if (!imageUrl || typeof imageUrl !== 'string') return;
        if (result.imageUrls.some(img => img.imageUrl === imageUrl)) return;
        const baseUrl = imageUrl.replace(/-part-\d+\//, '/');
        const ei = result.imageUrls.findIndex(img => img.imageUrl.replace(/-part-\d+\//, '/') === baseUrl);
        if (ei >= 0) {
            result.imageUrls[ei] = { imageUrl, imageIndex: imageIndex ?? result.imageUrls[ei].imageIndex };
            return;
        }
        result.imageUrls.push({ imageUrl, imageIndex: imageIndex ?? result.imageUrls.length });
    }

    pushUniqueBase64(result, data, imageIndex) {
        if (!data || typeof data !== 'string') return;
        const v = data.startsWith('data:image/') ? data : /^[A-Za-z0-9+/=]{1000,}$/.test(data) ? data : null;
        if (!v || result.imageBase64.some(img => img.data === v)) return;
        result.imageBase64.push({ data: v, imageIndex: imageIndex ?? result.imageBase64.length });
    }

    /**
     * Parse NDJSON response — robust version with imageChunkMap UUID tracking
     * (ported from ImageService to handle moderated images)
     */
    parseResponse(text, status) {
        const result = { title: '', imageUrls: [], imageBase64: [], error: null, errorDetail: null, status };
        const lines = text.split('\n').filter(l => l.trim());
        const errorMessages = [];
        const imageChunkMap = new Map();

        for (const line of lines) {
            try {
                const j = JSON.parse(line);
                if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

                // cardAttachment.jsonData.image_chunk — primary tracking source
                const cardJson = j.result?.response?.cardAttachment?.jsonData;
                if (cardJson) {
                    try {
                        const card = JSON.parse(cardJson);
                        const chunk = card?.image_chunk;
                        if (chunk?.imageUuid) {
                            const ex = imageChunkMap.get(chunk.imageUuid) || {};
                            if (chunk.imageUrl) ex.imageUrl = chunk.imageUrl;
                            if (chunk.progress != null && (ex.progress == null || chunk.progress > ex.progress)) ex.progress = chunk.progress;
                            if (chunk.imageIndex != null) ex.imageIndex = chunk.imageIndex;
                            if (chunk.moderated) ex.moderated = true;
                            imageChunkMap.set(chunk.imageUuid, ex);
                        }
                    } catch (_) {}
                }

                if (j.error) errorMessages.push(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
                if (j.result?.error) errorMessages.push(typeof j.result.error === 'string' ? j.result.error : j.result.error.message || JSON.stringify(j.result.error));
                const mr = j.result?.response?.modelResponse;
                if (mr?.error) errorMessages.push(typeof mr.error === 'string' ? mr.error : mr.error.message || JSON.stringify(mr.error));

                // Track streamingImageGenerationResponse by imageId (like imageChunkMap)
                // URL arrives at progress=50 but gets blanked at progress=100 when moderated
                const ir = j.result?.response?.streamingImageGenerationResponse;
                if (ir && ir.imageId) {
                    const ex = imageChunkMap.get(ir.imageId) || {};
                    if (ir.imageUrl) ex.imageUrl = ir.imageUrl;
                    if (ir.progress != null && (ex.progress == null || ir.progress > ex.progress)) ex.progress = ir.progress;
                    if (ir.imageIndex != null) ex.imageIndex = ir.imageIndex;
                    if (ir.moderated) ex.moderated = true;
                    imageChunkMap.set(ir.imageId, ex);
                }
                if (ir && ir.imageBytes) this.pushUniqueBase64(result, ir.imageBytes, ir.imageIndex || result.imageBase64.length);

                if (mr?.generatedImageUrls?.length > 0 && result.imageUrls.length === 0) {
                    mr.generatedImageUrls.forEach((u, i) => this.pushUniqueImageUrl(result, u, i));
                }

                const token = j.result?.response?.token;
                if (typeof token === 'string' && token.includes('data:image/')) {
                    const m2 = token.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
                    if (m2) for (const m of m2) this.pushUniqueBase64(result, m, result.imageBase64.length);
                }
            } catch (_) {
                if (line.includes('data:image/')) {
                    const m2 = line.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
                    if (m2) for (const m of m2) this.pushUniqueBase64(result, m, result.imageBase64.length);
                }
            }
        }

        // CRITICAL: Resolve final URLs from tracked UUID chunks (handles moderated images)
        // Lower threshold to progress >= 50 because moderation blanks URLs at progress=100
        for (const [uuid, info] of imageChunkMap) {
            if (info.imageUrl && (info.progress >= 50 || info.progress == null)) {
                if (info.moderated || info.progress < 100) {
                    console.log(`[RefImageService] UUID ${uuid.substring(0,8)}: progress=${info.progress}, moderated=${!!info.moderated}, using raw URL`);
                    this.pushUniqueImageUrl(result, info.imageUrl, info.imageIndex ?? null);
                } else {
                    this.pushUniqueImageUrl(result, info.imageUrl.replace(/-part-\d+\//, '/'), info.imageIndex ?? null);
                }
            }
        }

        console.log(`[RefImageService] parseResponse: ${result.imageUrls.length} URLs, ${result.imageBase64.length} base64, chunkMap=${imageChunkMap.size}`);
        if (result.imageUrls.length + result.imageBase64.length === 0) {
            result.error = status !== 200 ? `HTTP ${status}` : errorMessages.length > 0 ? errorMessages.join(' | ') : 'no images returned';
            result.errorDetail = text.substring(0, 500);
        }
        return result;
    }

    /**
     * Download image — multi-variant parallel download with best-of-race (ported from ImageService)
     */
    async downloadImage(imageUrl, session) {
        const cookieStr = this.formatCookies(session.cookies);
        const base = API_ENDPOINTS.ASSETS_BASE_URL;
        const restBase = 'https://grok.com/rest/app-chat/asset/';
        const dlHeaders = {};
        for (const [k, v] of Object.entries(session.capturedHeaders)) {
            if (!k.startsWith(':')) dlHeaders[k] = v;
        }
        dlHeaders['cookie'] = cookieStr;
        delete dlHeaders['host'];
        delete dlHeaders['content-length'];
        delete dlHeaders['content-type'];

        const relPath = imageUrl.startsWith('http')
            ? imageUrl.replace(base, '').replace(restBase, '')
            : imageUrl.replace(/^\/+/, '');
        const urlsToTry = [base + relPath, restBase + relPath];
        if (relPath.includes('-part-')) {
            const stripped = relPath.replace(/-part-\d+\//, '/');
            urlsToTry.push(base + stripped, restBase + stripped);
        } else {
            const partUrl = relPath.replace(/\/image\.jpg/, '-part-0/image.jpg');
            if (partUrl !== relPath) urlsToTry.push(base + partUrl, restBase + partUrl);
        }

        const results = await Promise.all(urlsToTry.map(async (url) => {
            try {
                const res = await axios.get(url, {
                    headers: dlHeaders, responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true,
                });
                if (res.status === 200 && res.data.byteLength > 500) {
                    return { data: Buffer.from(res.data), size: res.data.byteLength, contentType: res.headers['content-type'] };
                }
            } catch (_) {}
            return null;
        }));

        let best = null;
        for (const r of results) if (r && (!best || r.size > best.size)) best = r;
        return best;
    }

    /**
     * Download via browser page context (bypasses moderation blur)
     */
    async downloadViaBrowser(imageUrl, session) {
        if (!session._page) return null;
        const base = API_ENDPOINTS.ASSETS_BASE_URL;
        const fullUrl = imageUrl.startsWith('http') ? imageUrl : base + imageUrl.replace(/^\/+/, '');
        try {
            const result = await session._page.evaluate(async (url) => {
                try {
                    const resp = await fetch(url, { credentials: 'include' });
                    if (!resp.ok) return { error: 'HTTP ' + resp.status };
                    const blob = await resp.blob();
                    const reader = new FileReader();
                    return new Promise((resolve) => {
                        reader.onload = () => resolve({ dataUrl: reader.result, size: blob.size, type: blob.type });
                        reader.onerror = () => resolve({ error: 'FileReader error' });
                        reader.readAsDataURL(blob);
                    });
                } catch (e) { return { error: e.message }; }
            }, fullUrl);
            if (result.error || !result.dataUrl || result.size < 1000) return null;
            const base64Match = result.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
                const buffer = Buffer.from(base64Match[2], 'base64');
                return { data: buffer, size: buffer.length, contentType: result.type || 'image/jpeg' };
            }
        } catch (_) {}
        return null;
    }

    /**
     * Generate ref images via the Grok Imagine WebSocket (bypass CDN moderation).
     * Same protocol as ImageService but includes image_references in properties.
     * Ref images must be uploaded first via REST, then referenced by URL.
     */
    async generateViaWebSocket(prompt, refImageUrls, parentPostId, session, config = {}) {
        if (!session._page) return null;
        const page = session._page;

        const aspectRatio = config.aspectRatio || '1:1';
        const imageCount = config.imageGenerationCount || config.count || IMAGE_CONFIG.imageGenerationCount || 4;
        const enableNsfw = config.enableNsfw === false ? false : true;
        const enablePro = config.enablePro !== false ? true : false;

        try {
            const currentUrl = page.url();
            if (!currentUrl.includes('grok.com')) {
                await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }

            console.log(`[RefImageService] 🔌 WS generation (refs=${refImageUrls.length}, n=${imageCount}, ar=${aspectRatio})...`);

            const WS_HARD_TIMEOUT = 90000;
            const wsPromise = page.evaluate(async (prompt, aspectRatio, n, enableNsfw, enablePro, refImageUrls, parentPostId) => {
                const WS_URL = 'wss://grok.com/ws/imagine/listen';
                const URL_PATTERN = /\/images\/([a-f0-9-]+)\.(png|jpe?g|webp)/i;
                const ROUND_TIMEOUT_MS = 120000;
                const STREAM_IDLE_MS = 30000;
                const INTER_ROUND_GRACE_MS = 2000;
                const MAX_ROUNDS = 4;

                function buildReset() {
                    return {
                        type: 'conversation.item.create',
                        timestamp: Date.now(),
                        item: { type: 'message', content: [{ type: 'reset' }] },
                    };
                }
                function buildRequest(requestId) {
                    return {
                        type: 'conversation.item.create',
                        timestamp: Date.now(),
                        item: {
                            type: 'message',
                            content: [{
                                requestId,
                                text: prompt,
                                type: 'input_text',
                                properties: {
                                    model_name: 'imagine-image-edit',
                                    section_count: 0,
                                    is_kids_mode: false,
                                    enable_nsfw: enableNsfw,
                                    skip_upsampler: false,
                                    enable_side_by_side: true,
                                    is_initial: false,
                                    aspect_ratio: aspectRatio,
                                    enable_pro: enablePro,
                                    // Ref image references for the edit model
                                    image_references: refImageUrls,
                                    parent_post_id: parentPostId,
                                },
                            }],
                        },
                    };
                }

                const debug = [];
                const errors = [];
                const finals = [];
                const seenFinals = new Set();
                let ws;
                try { ws = new WebSocket(WS_URL); }
                catch (e) { return { finals, errors: [e.message || String(e)], debug }; }

                let resolveOuter;
                const outer = new Promise(r => { resolveOuter = r; });

                let roundIdx = 0;
                let roundStartedAt = Date.now();
                let lastFrameAt = Date.now();
                let slots = new Map();
                let roundIdleTimer = null;
                let overallTimer = null;
                let finished = false;

                function harvestPartialFinals() {
                    const MIN_BLOB_LEN = 50000;
                    for (const slot of slots.values()) {
                        if (!slot.done && slot.last_blob && slot.last_blob.length >= MIN_BLOB_LEN && !seenFinals.has(slot.image_id)) {
                            seenFinals.add(slot.image_id);
                            finals.push({
                                blob: slot.last_blob,
                                url: slot.last_url,
                                image_id: slot.image_id,
                                order: slot.order,
                                moderated: false,
                                r_rated: false,
                            });
                        }
                    }
                }

                function finish(reason) {
                    if (finished) return;
                    finished = true;
                    harvestPartialFinals();
                    debug.push('finish: ' + reason + ' | finals=' + finals.length);
                    try { ws.close(); } catch (_) {}
                    if (roundIdleTimer) clearInterval(roundIdleTimer);
                    if (overallTimer) clearTimeout(overallTimer);
                    resolveOuter({ finals, errors, debug });
                }

                function startRound() {
                    if (finished) return;
                    roundIdx++;
                    roundStartedAt = Date.now();
                    lastFrameAt = Date.now();
                    slots = new Map();
                    debug.push('round ' + roundIdx + ' starting');
                    try {
                        ws.send(JSON.stringify(buildReset()));
                        const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                            ? crypto.randomUUID()
                            : ('req-' + Math.random().toString(36).slice(2));
                        ws.send(JSON.stringify(buildRequest(requestId)));
                    } catch (e) {
                        errors.push('send_failed: ' + (e.message || String(e)));
                        finish('send_failed');
                    }
                }

                function maybeAdvance() {
                    if (finished) return;
                    if (finals.length >= n) { finish('got_enough'); return; }
                    if (slots.size > 0 && Array.from(slots.values()).every(s => s.done)) {
                        if (roundIdx >= MAX_ROUNDS) { finish('max_rounds'); return; }
                        setTimeout(() => {
                            if (finished || ws.readyState !== WebSocket.OPEN) return;
                            debug.push('all slots done, requesting another round');
                            startRound();
                        }, INTER_ROUND_GRACE_MS);
                    }
                }

                ws.onopen = () => { debug.push('ws open'); startRound(); };

                ws.onmessage = (event) => {
                    lastFrameAt = Date.now();
                    let msg;
                    try { msg = JSON.parse(event.data); } catch (_) { return; }

                    const msgType = msg.type;
                    if (msgType === 'json') {
                        const status = msg.current_status;
                        const imageId = String(msg.image_id || msg.job_id || '');
                        if (!imageId) return;

                        if (status === 'start_stage') {
                            slots.set(imageId, {
                                image_id: imageId,
                                order: parseInt(msg.order || 0, 10),
                                width: parseInt(msg.width || 0, 10),
                                height: parseInt(msg.height || 0, 10),
                                last_blob: '', last_url: '',
                                done: false, moderated: false, r_rated: false,
                            });
                            debug.push('start_stage order=' + (msg.order || 0) + ' id=' + imageId.slice(0, 8));
                        } else if (status === 'completed') {
                            const slot = slots.get(imageId);
                            if (!slot || slot.done) return;
                            slot.done = true;
                            slot.moderated = !!msg.moderated;
                            slot.r_rated = !!msg.r_rated;
                            if (slot.last_blob && !seenFinals.has(imageId)) {
                                seenFinals.add(imageId);
                                finals.push({
                                    blob: slot.last_blob, url: slot.last_url,
                                    image_id: imageId, order: slot.order,
                                    moderated: slot.moderated, r_rated: slot.r_rated,
                                });
                                debug.push('completed order=' + slot.order + ' blob_len=' + slot.last_blob.length + ' mod=' + slot.moderated);
                            } else {
                                debug.push('completed order=' + slot.order + ' NO_BLOB mod=' + slot.moderated);
                            }
                            maybeAdvance();
                        }
                    } else if (msgType === 'image') {
                        const url = msg.url || '';
                        const blob = msg.blob || '';
                        const m = URL_PATTERN.exec(url);
                        if (!m) return;
                        const imageId = m[1];
                        const slot = slots.get(imageId);
                        if (slot && !slot.done && blob) {
                            slot.last_blob = blob;
                            slot.last_url = url;
                        }
                    } else if (msgType === 'error') {
                        const code = msg.err_code || 'upstream_error';
                        const message = msg.err_msg || JSON.stringify(msg);
                        errors.push(code + ': ' + message);
                        debug.push('server error: ' + code);
                        finish('server_error');
                    }
                };

                ws.onerror = () => { debug.push('ws onerror'); };
                ws.onclose = (event) => { debug.push('ws closed code=' + event.code); finish('ws_close'); };

                roundIdleTimer = setInterval(() => {
                    if (Date.now() - lastFrameAt > STREAM_IDLE_MS) { debug.push('stream idle timeout'); finish('stream_idle'); }
                    if (Date.now() - roundStartedAt > ROUND_TIMEOUT_MS) { debug.push('round timeout'); finish('round_timeout'); }
                }, 2000);
                overallTimer = setTimeout(() => { debug.push('overall timeout'); finish('overall_timeout'); }, ROUND_TIMEOUT_MS * MAX_ROUNDS);

                return outer;
            }, prompt, aspectRatio, imageCount, enableNsfw, enablePro, refImageUrls, parentPostId);

            const wsTimeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('WS hard timeout')), WS_HARD_TIMEOUT)
            );
            const wsResult = await Promise.race([wsPromise, wsTimeoutPromise]);

            if (wsResult.debug?.length > 0) {
                console.log('[RefImageService] 🔌 WS debug:\n  ' + wsResult.debug.join('\n  '));
            }

            const finals = wsResult.finals || [];
            console.log(`[RefImageService] 🔌 WS finals: ${finals.length} (errors: ${(wsResult.errors || []).length})`);

            if (finals.length === 0) {
                if ((wsResult.errors || []).length > 0) {
                    console.log('[RefImageService] 🔌 WS errors: ' + wsResult.errors.join(' | '));
                }
                return null;
            }

            const result = { title: '', imageUrls: [], imageBase64: [], error: null, status: 200 };

            finals.sort((a, b) => (b.blob || '').length - (a.blob || '').length);
            const trimmedFinals = finals.slice(0, imageCount);
            trimmedFinals.sort((a, b) => (a.order || 0) - (b.order || 0));
            console.log(`[RefImageService] 🔌 Trimmed to ${trimmedFinals.length} of ${finals.length} | blob sizes: ${trimmedFinals.map(f => (f.blob||'').length).join(',')}`);

            for (let i = 0; i < trimmedFinals.length; i++) {
                const img = trimmedFinals[i];
                const raw = img.blob || '';
                const isDataUrl = raw.startsWith('data:');
                let mime = 'image/jpeg';
                if (img.url) {
                    const ext = (img.url.match(/\.(png|jpg|jpeg|webp)(?:[?#]|$)/i) || [])[1];
                    if (ext === 'png') mime = 'image/png';
                    else if (ext === 'webp') mime = 'image/webp';
                }
                const dataUri = isDataUrl ? raw : `data:${mime};base64,${raw}`;
                result.imageBase64.push({ data: dataUri, imageIndex: i });
            }
            return result;
        } catch (err) {
            console.error('[RefImageService] 🔌 WS error:', err.message);
            return null;
        }
    }

    /**
     * Generate one image with ref images
     * PRIMARY: WebSocket (bypass blur) → FALLBACK: REST API
     */
    async generateOne(item, session, config = {}, onProgress = null) {
        const { prompt, refImagePaths } = item;
        const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[RefImageService] 📤 Uploading ${refImagePaths.length} ref image(s)...${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);
                const uploadResult = await this.uploadRefImages(refImagePaths, session);

                if (uploadResult.error && uploadResult.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
                    console.warn(`[RefImageService] ⚠️ 403 during upload for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) { Object.assign(session, newSession); continue; }
                    return { imageUrls: [], imageBase64: [], error: `403 — re-login failed for ${session.email}`, status: 403 };
                }
                if (uploadResult.error) return { imageUrls: [], imageBase64: [], error: uploadResult.error, status: 0 };

                // PRIMARY: WebSocket generation (bypass CDN moderation blur)
                if (session._page) {
                    try {
                        console.log(`[RefImageService] 🔌 Trying WS generation (anti-blur)...`);
                        const wsResult = await this.generateViaWebSocket(
                            prompt, uploadResult.imageUrls, uploadResult.parentPostId, session, config
                        );
                        if (wsResult && (wsResult.imageBase64.length > 0 || wsResult.imageUrls.length > 0)) {
                            console.log(`[RefImageService] 🔌 WS SUCCESS: ${wsResult.imageBase64.length} base64 + ${wsResult.imageUrls.length} URLs`);
                            if (onProgress) onProgress({ progress: 100, status: 'completed' });
                            return wsResult;
                        }
                        console.log('[RefImageService] 🔌 WS no images, falling back to REST...');
                    } catch (wsErr) {
                        console.log(`[RefImageService] 🔌 WS error: ${wsErr.message}, falling back to REST...`);
                    }
                }

                // FALLBACK: REST API
                console.log(`[RefImageService] 🎨 REST generating with ${uploadResult.imageUrls.length} ref(s): ${prompt.substring(0, 50)}...`);
                const cookieStr = this.formatCookies(session.cookies);
                const body = this.buildRefImageBody(prompt, uploadResult.imageUrls, uploadResult.parentPostId, config);

                const res = await axios.post(API_ENDPOINTS.API_URL, body, {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    responseType: 'text', validateStatus: () => true, timeout: 120000,
                });

                if (res.status === 429 && attempt < MAX_RETRIES) {
                    const wait = PROCESSING_CONFIG.RETRY_DELAY + Math.random() * 5000;
                    console.log(`[RefImageService] ⚠️ Rate limited (429), retrying in ${(wait / 1000).toFixed(1)}s...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                if (res.status === 403 && attempt < MAX_RETRIES) {
                    console.warn(`[RefImageService] ⚠️ 403 Forbidden for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) { Object.assign(session, newSession); continue; }
                    return { imageUrls: [], imageBase64: [], error: `403 — re-login failed for ${session.email}`, status: 403 };
                }

                const result = this.parseResponse(res.data, res.status);

                if ((result.imageUrls.length > 0 || result.imageBase64.length > 0) && onProgress) {
                    onProgress({ progress: 100, status: 'completed' });
                }
                return result;
            } catch (error) {
                if (attempt < MAX_RETRIES) {
                    console.error(`[RefImageService] Error, retrying (${attempt + 1}/${MAX_RETRIES}):`, error.message);
                    await new Promise(r => setTimeout(r, PROCESSING_CONFIG.RETRY_DELAY));
                    continue;
                }
                return { imageUrls: [], imageBase64: [], error: error.message, status: 0 };
            }
        }
    }

    /**
     * Generate batch — collision-safe file naming + smart download (ported from ImageService)
     */
    async generateBatch(items, session, config = {}, onProgress = null, startIdx = 0) {
        const N = items.length;
        const CONCURRENCY = Math.min(config.batchSize || PROCESSING_CONFIG.CONCURRENCY.I2V || 5, N);
        const outputFolder = config.outputFolder || PATHS.IMAGE_DIR;
        const label = `Acc${session.accIdx + 1}`;

        console.log(`[RefImageService] [${label}] ${N} ref-image items | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

        const results = [];
        let nextIdx = 0;
        const self = this;

        async function worker() {
            while (nextIdx < N) {
                const myIdx = nextIdx++;
                const item = items[myIdx];
                const globalNum = startIdx + myIdx + 1;

                console.log(`[RefImageService] [${label}] 🖼️✨ #${myIdx + 1}/${N} (shot${String(globalNum).padStart(4, '0')}) refs=${item.refImagePaths.length} | ${item.prompt.substring(0, 50)}...`);

                const result = await self.generateOne(item, session, config, (prog) => {
                    if (onProgress) onProgress(item.prompt, prog.progress, null, myIdx);
                });

                const savedFiles = [];
                const shotNum = String(globalNum).padStart(4, '0');
                const batchTs = Date.now().toString(36);
                const titleSlug = (result.title || '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);

                // Save base64 images (collision-safe)
                if (result.imageBase64 && result.imageBase64.length > 0) {
                    const usedNames = new Set();
                    for (let imgIdx = 0; imgIdx < result.imageBase64.length; imgIdx++) {
                        const img = result.imageBase64[imgIdx];
                        try {
                            let base64Data = img.data;
                            let ext = 'png';
                            if (base64Data.startsWith('data:image/')) {
                                const match = base64Data.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
                                if (match) { ext = match[1] === 'jpeg' ? 'jpg' : match[1]; base64Data = base64Data.substring(match[0].length); }
                            }
                            const buffer = Buffer.from(base64Data, 'base64');
                            const imgNum = img.imageIndex != null ? img.imageIndex : imgIdx;
                            let filename = titleSlug
                                ? `ref_shot${shotNum}_${batchTs}_${titleSlug}_i${imgNum}.${ext}`
                                : `ref_shot${shotNum}_${batchTs}_i${imgNum}.${ext}`;
                            if (usedNames.has(filename)) {
                                filename = titleSlug
                                    ? `ref_shot${shotNum}_${batchTs}_${titleSlug}_i${imgIdx}.${ext}`
                                    : `ref_shot${shotNum}_${batchTs}_i${imgIdx}.${ext}`;
                            }
                            usedNames.add(filename);
                            const filePath = FileService.saveFile(buffer, filename, outputFolder);
                            savedFiles.push(filePath);
                            img.size = buffer.length;
                            console.log(`[RefImageService] [${label}] 💾 Saved: ${filename} (${buffer.length} bytes)`);
                        } catch (error) {
                            console.error(`[RefImageService] [${label}] Base64 save error:`, error.message);
                        }
                    }
                }

                // Download URLs — only if base64 quality is insufficient
                const bestBase64Size = savedFiles.length > 0 ? Math.max(...(result.imageBase64 || []).map(i => i.size || 0), 0) : 0;
                if ((result.imageUrls || []).length > 0 && bestBase64Size < 50000) {
                    for (const img of result.imageUrls) {
                        try {
                            let dl = await self.downloadImage(img.imageUrl, session);
                            // Browser fallback for small/blurred downloads
                            if (dl && dl.size < 50000 && session._page) {
                                const browserDl = await self.downloadViaBrowser(img.imageUrl, session);
                                if (browserDl && browserDl.size > dl.size) dl = browserDl;
                            }
                            if (!dl && session._page) dl = await self.downloadViaBrowser(img.imageUrl, session);
                            if (dl && dl.size > bestBase64Size) {
                                const ext = dl.contentType?.includes('png') ? 'png' : 'jpg';
                                const cdnIdx = img.imageIndex || 0;
                                const filename = titleSlug
                                    ? `ref_shot${shotNum}_${batchTs}_${titleSlug}_cdn_i${cdnIdx}.${ext}`
                                    : `ref_shot${shotNum}_${batchTs}_cdn_i${cdnIdx}.${ext}`;
                                const filePath = FileService.saveFile(dl.data, filename, outputFolder);
                                savedFiles.push(filePath);
                                console.log(`[RefImageService] [${label}] 💾 Saved URL: ${filename} (${dl.size} bytes)`);
                            }
                        } catch (error) {
                            console.error(`[RefImageService] [${label}] Download error:`, error.message);
                        }
                    }
                } else if (bestBase64Size >= 50000) {
                    console.log(`[RefImageService] [${label}] Skipping URL downloads — good base64 (${bestBase64Size}b)`);
                }

                const jobResult = {
                    prompt: item.prompt,
                    localIdx: myIdx,
                    title: result.title,
                    savedFiles,
                    outputPath: savedFiles.length > 0 ? savedFiles[0] : null,
                    success: savedFiles.length > 0,
                    error: result.error,
                };
                results.push(jobResult);
                if (onProgress) onProgress(item.prompt, 100, jobResult, myIdx);
                console.log(`[RefImageService] [${label}] #${myIdx + 1}/${N} ${savedFiles.length > 0 ? '✅' : '❌'} ${result.title || item.prompt.substring(0, 50)}`);
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
            workers.push(new Promise((resolve) => setTimeout(() => resolve(worker()), i * 200)));
        }
        await Promise.all(workers);

        console.log(`[RefImageService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
        return results;
    }
}

module.exports = new RefImageService();
