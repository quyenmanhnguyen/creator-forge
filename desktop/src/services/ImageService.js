const axios = require('axios');
const crypto = require('crypto');
const { API_ENDPOINTS, MODEL_CONFIG, IMAGE_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');
const path = require('path');

class ImageService {
    constructor() {
        this.activeJobs = new Map();
        this._cancelled = false;
    }

    cancelAll() {
        this._cancelled = true;
        console.log('[ImageService] ⛔ Cancel requested');
    }

    resetCancel() {
        this._cancelled = false;
    }

    /**
     * Format cookies for headers
     * @param {Array} cookies - Cookie objects
     * @returns {string} Cookie string
     */
    formatCookies(cookies) {
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    /**
     * Build request headers
     * @param {Object} capturedHeaders - Headers from browser
     * @param {string} cookieStr - Cookie string
     * @returns {Object} Request headers
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
     * Build request body for image generation
     * @param {string} prompt - Text prompt
     * @returns {Object} Request body
     */
    buildBody(prompt, config = {}) {
        const aspectRatio = config.aspectRatio || '1:1';
        // Pro mode on Grok Imagine returns a single high-quality image and
        // suppresses `enable_side_by_side`. When the caller wants a batch
        // (>1) we must keep Pro off; when the caller explicitly asks for
        // Pro we force the count to 1 to match server behavior.
        const enablePro = config.enablePro === true;
        const requestedCount = config.imageGenerationCount || config.count || IMAGE_CONFIG.imageGenerationCount || 2;
        const imageCount = enablePro ? 1 : requestedCount;
        const enableNsfw = config.enableNsfw === false ? false : true;
        return {
            temporary: false,
            modelName: 'grok-3',
            // Pin photorealistic model for chat-stream fallback path too
            imageModelName: 'imagine-x-1',
            message: prompt.includes('--ar') ? prompt : `${prompt} --ar ${aspectRatio}`,
            fileAttachments: [],
            imageAttachments: [],
            disableSearch: false,
            enableImageGeneration: true,
            returnImageBytes: false,
            returnRawGrokInXaiRequest: false,
            enableImageStreaming: true,
            imageGenerationCount: imageCount,
            forceConcise: false,
            toolOverrides: {},
            enableSideBySide: true,
            enableNsfw,
            enablePro,
            sendFinalMetadata: true,
            isReasoning: false,
            disableTextFollowUps: false,
            responseMetadata: {
                requestModelDetails: { modelId: 'grok-3' },
            },
            disableMemory: false,
            forceSideBySide: false,
            modelMode: 'MODEL_MODE_EXPERT',
            isAsyncChat: false,
            disableSelfHarmShortCircuit: true,
            deviceEnvInfo: {
                darkModeEnabled: false,
                devicePixelRatio: 1.25,
                screenWidth: 1280,
                screenHeight: 800,
                viewportWidth: 799,
                viewportHeight: 735,
            },
        };
    }

    buildApiBody(prompt, config = {}) {
        const enablePro = config.enablePro === true;
        const requestedCount = config.imageGenerationCount || config.count || IMAGE_CONFIG.imageGenerationCount || 2;
        return {
            model: config.imageModel || process.env.XAI_IMAGE_MODEL || 'grok-imagine-image',
            prompt,
            n: enablePro ? 1 : requestedCount,
            response_format: 'b64_json',
            aspect_ratio: config.aspectRatio || '1:1',
        };
    }

    /**
     * Generate images via the Grok Imagine WebSocket (`wss://grok.com/ws/imagine/listen`).
     *
     * This is what grok.com web actually uses for image generation. Unlike
     * `POST /rest/app-chat/conversations/new`:
     *   - One round can produce multiple side-by-side images (`enable_side_by_side: true`),
     *     fixing the "imageGenerationCount has no effect" issue on the chat endpoint.
     *   - Image bytes arrive inline as base64 `blob` fields on the websocket itself,
     *     so they bypass the CDN moderation that turns final images into ~25KB
     *     blurred placeholders.
     *
     * Protocol (one round):
     *   Client → reset:    {type:"conversation.item.create", item:{...content:[{type:"reset"}]}}
     *   Client → request:  {type:"conversation.item.create", item:{...content:[{
     *                          requestId, text, type:"input_text",
     *                          properties:{section_count, is_kids_mode, enable_nsfw,
     *                                      skip_upsampler, enable_side_by_side,
     *                                      is_initial, aspect_ratio, enable_pro}}]}}
     *   Server → for each slot:
     *              {type:"json", current_status:"start_stage", image_id, order, width, height}
     *              N × {type:"image", url:"/images/<id>.jpg", blob:"<base64>", percentage_complete:N}
     *              {type:"json", current_status:"completed", image_id, moderated, r_rated}
     *
     * If a slot finishes with `moderated: true` the corresponding URL on the CDN
     * will be blurred — but the last `blob` we already buffered from the streaming
     * preview frames is full-res, so we keep that.
     */
    async generateViaWebSocket(prompt, session, config = {}) {
        if (!session._page) return null;
        const page = session._page;

        const aspectRatio = config.aspectRatio || '1:1';
        // Pro is opt-in. When enabled, server returns a single Pro image and
        // ignores `enable_side_by_side`, so we cap the requested count at 1
        // to keep round/maybeAdvance accounting honest.
        const enablePro = config.enablePro === true;
        const requestedCount = config.imageGenerationCount || config.count || IMAGE_CONFIG.imageGenerationCount || 2;
        const imageCount = enablePro ? 1 : requestedCount;
        const enableNsfw = config.enableNsfw === false ? false : true;

        try {
            // The websocket connects from the page origin, so we must be on grok.com.
            const currentUrl = page.url();
            if (!currentUrl.includes('grok.com')) {
                await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }

            console.log('[ImageService] 🔌 Imagine WS generation starting (n=' + imageCount + ', ar=' + aspectRatio + ')...');

            // Wrap page.evaluate with a hard 90s timeout to prevent infinite hangs
            const WS_HARD_TIMEOUT = 90000;
            const wsPromise = page.evaluate(async (prompt, aspectRatio, n, enableNsfw, enablePro) => {
                const WS_URL = 'wss://grok.com/ws/imagine/listen';
                const URL_PATTERN = /\/images\/([a-f0-9-]+)\.(png|jpe?g|webp)/i;
                const ROUND_TIMEOUT_MS = 120000;
                const STREAM_IDLE_MS = 30000;
                const INTER_ROUND_GRACE_MS = 2000;
                const MAX_ROUNDS = 4;
                // Smaller blobs are streaming preview frames or moderation
                // placeholders. Reject in both harvest paths so we never
                // surface a blurred/redacted image as a final.
                const MIN_BLOB_LEN = 50000;

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
                                    // model_name pins the photorealistic Imagine model. Without it,
                                    // the server falls back to a default that often produces
                                    // anime/illustration output. Discovered by capturing the WS
                                    // frame echo from grok.com/imagine.
                                    model_name: 'imagine-x-1',
                                    section_count: 0,
                                    is_kids_mode: false,
                                    enable_nsfw: enableNsfw,
                                    skip_upsampler: false,
                                    enable_side_by_side: true,
                                    is_initial: false,
                                    aspect_ratio: aspectRatio,
                                    enable_pro: enablePro,
                                },
                            }],
                        },
                    };
                }

                const debug = [];
                const errors = [];
                const finals = [];          // { blob, url, image_id, order, moderated, r_rated }
                const seenFinals = new Set();
                let ws;
                try {
                    ws = new WebSocket(WS_URL);
                } catch (e) {
                    return { finals, errors: [e.message || String(e)], debug };
                }

                let resolveOuter;
                const outer = new Promise(r => { resolveOuter = r; });

                let roundIdx = 0;
                let roundStartedAt = Date.now();
                let lastFrameAt = Date.now();
                let slots = new Map();   // image_id -> slot
                let roundIdleTimer = null;
                let overallTimer = null;
                let finished = false;

                function harvestPartialFinals() {
                    // Promote any slot with a buffered blob but no `completed` frame into
                    // a final image. Skip tiny blobs (< MIN_BLOB_LEN base64 chars ≈ 37KB
                    // decoded) which are just blurred preview frames, not real images.
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
                    // IMPORTANT: harvest synchronously before resolving — `ws.onclose` fires
                    // on a later event-loop turn and can't reach the caller after `page.evaluate`
                    // has already serialized the result.
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
                    if (finals.length >= n) {
                        finish('got_enough');
                        return;
                    }
                    if (slots.size > 0 && Array.from(slots.values()).every(s => s.done)) {
                        if (roundIdx >= MAX_ROUNDS) {
                            finish('max_rounds');
                            return;
                        }
                        // Wait briefly to let server close (single-round servers do).
                        setTimeout(() => {
                            if (finished || ws.readyState !== WebSocket.OPEN) return;
                            debug.push('all slots done, requesting another round');
                            startRound();
                        }, INTER_ROUND_GRACE_MS);
                    }
                }

                ws.onopen = () => {
                    debug.push('ws open');
                    startRound();
                };

                ws.onmessage = (event) => {
                    lastFrameAt = Date.now();
                    let msg;
                    try { msg = JSON.parse(event.data); }
                    catch (_) { return; }

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
                                last_blob: '',
                                last_url: '',
                                done: false,
                                moderated: false,
                                r_rated: false,
                            });
                            debug.push('start_stage order=' + (msg.order || 0) + ' id=' + imageId.slice(0, 8));
                        } else if (status === 'completed') {
                            const slot = slots.get(imageId);
                            if (!slot || slot.done) return;
                            slot.done = true;
                            slot.moderated = !!msg.moderated;
                            slot.r_rated = !!msg.r_rated;

                            const blobLen = (slot.last_blob || '').length;
                            // Reject blobs smaller than MIN_BLOB_LEN — those are streaming
                            // preview placeholders or moderation-redacted thumbnails. Letting
                            // them through caused PR-9 bug: "final image is blurred / tiny".
                            if (slot.last_blob && blobLen >= MIN_BLOB_LEN && !seenFinals.has(imageId)) {
                                seenFinals.add(imageId);
                                finals.push({
                                    blob: slot.last_blob,
                                    url: slot.last_url,
                                    image_id: imageId,
                                    order: slot.order,
                                    moderated: slot.moderated,
                                    r_rated: slot.r_rated,
                                });
                                debug.push('completed order=' + slot.order + ' blob_len=' + blobLen + ' mod=' + slot.moderated);
                            } else {
                                debug.push('completed order=' + slot.order + ' REJECTED blob_len=' + blobLen + ' mod=' + slot.moderated);
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
                            // Always replace with the latest (highest progress) blob.
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

                ws.onerror = () => {
                    debug.push('ws onerror');
                };

                ws.onclose = (event) => {
                    debug.push('ws closed code=' + event.code);
                    finish('ws_close');
                };

                // Idle watchdog: kill round if no frames for STREAM_IDLE_MS.
                roundIdleTimer = setInterval(() => {
                    if (Date.now() - lastFrameAt > STREAM_IDLE_MS) {
                        debug.push('stream idle timeout');
                        finish('stream_idle');
                    }
                    if (Date.now() - roundStartedAt > ROUND_TIMEOUT_MS) {
                        debug.push('round timeout');
                        finish('round_timeout');
                    }
                }, 2000);

                // Hard ceiling.
                overallTimer = setTimeout(() => {
                    debug.push('overall timeout');
                    finish('overall_timeout');
                }, ROUND_TIMEOUT_MS * MAX_ROUNDS);

                return outer;
            }, prompt, aspectRatio, imageCount, enableNsfw, enablePro);

            const wsTimeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('WS hard timeout after ' + WS_HARD_TIMEOUT + 'ms')), WS_HARD_TIMEOUT)
            );
            const wsResult = await Promise.race([wsPromise, wsTimeoutPromise]);

            if (wsResult.debug?.length > 0) {
                console.log('[ImageService] 🔌 WS debug:\n  ' + wsResult.debug.join('\n  '));
            }

            // WS debug summary (console only — no file writes in production)

            const finals = wsResult.finals || [];
            const moderatedCount = finals.filter(f => f.moderated).length;
            console.log('[ImageService] 🔌 WS finals: ' + finals.length + ' (moderated: ' + moderatedCount + ', errors: ' + (wsResult.errors || []).length + ')');

            if (finals.length === 0) {
                if ((wsResult.errors || []).length > 0) {
                    console.log('[ImageService] 🔌 WS errors: ' + wsResult.errors.join(' | '));
                }
                return null;
            }

            const result = {
                title: '',
                imageUrls: [],
                imageBase64: [],
                error: null,
                status: 200,
                moderatedCount,
            };

            // Sort by blob size descending — prioritize highest-quality images
            // so when we trim to imageCount, we keep the best ones.
            finals.sort((a, b) => (b.blob || '').length - (a.blob || '').length);

            // Trim to requested count — Grok WS may return more than requested
            const trimmedFinals = finals.slice(0, imageCount);
            // Re-sort trimmed by order for consistent file naming
            trimmedFinals.sort((a, b) => (a.order || 0) - (b.order || 0));
            console.log('[ImageService] 🔌 Trimmed to ' + trimmedFinals.length + ' of ' + finals.length + ' (requested ' + imageCount + ') | blob sizes: ' + trimmedFinals.map(f => (f.blob||'').length).join(','));

            for (let i = 0; i < trimmedFinals.length; i++) {
                const img = trimmedFinals[i];
                const raw = img.blob || '';
                const isDataUrl = raw ? raw.startsWith('data:') : false;
                // Best-guess mime from the URL extension; fall back to image/jpeg.
                let mime = 'image/jpeg';
                if (img.url) {
                    const ext = (img.url.match(/\.(png|jpg|jpeg|webp)(?:[?#]|$)/i) || [])[1];
                    if (ext) {
                        const lower = ext.toLowerCase();
                        mime = lower === 'png' ? 'image/png'
                            : lower === 'webp' ? 'image/webp'
                            : 'image/jpeg';
                    }
                }

                // Only include base64 if blob is large enough (not a blurred preview)
                if (raw && raw.length >= 50000) {
                    const dataUrl = isDataUrl ? raw : ('data:' + mime + ';base64,' + raw);
                    const base64Data = isDataUrl ? (raw.split(',')[1] || '') : raw;
                    const size = Math.floor(base64Data.length * 3 / 4);
                    result.imageBase64.push({
                        data: dataUrl,
                        imageIndex: img.order != null ? img.order : i,
                        size,
                    });
                }

                // Always include CDN URL for fallback download (browser can get full-res)
                if (img.url) {
                    result.imageUrls.push({
                        imageUrl: img.url,
                        imageIndex: img.order != null ? img.order : i,
                    });
                }
            }

            return result;
        } catch (err) {
            console.log('[ImageService] 🔌 WS exception: ' + err.message);
            return null;
        }
    }

    /**
     * Generate image via browser page (same context as grok.com)
     * Uses cardAttachment.jsonData.image_chunk for URLs (Grok's actual response format)
     * Race-downloads from multiple endpoints before moderation blur is applied
     */
    async generateViaBrowser(prompt, session, config = {}) {
        if (!session._page) return null;
        const page = session._page;

        try {
            // Navigate to grok.com first (ensures correct origin for cookies/CORS)
            const currentUrl = page.url();
            if (!currentUrl.includes('grok.com')) {
                await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }

            const body = this.buildBody(prompt, config);
            const apiUrl = API_ENDPOINTS.API_URL;
            const assetsBase = API_ENDPOINTS.ASSETS_BASE_URL;
            const restAssetBase = 'https://grok.com/rest/app-chat/asset/';

            console.log('[ImageService] 🌐 Browser-context generation starting...');

            // Execute fetch in browser context (has real cookies, origin, full auth)
            const browserResult = await page.evaluate(async (apiUrl, body, assetsBase, restAssetBase) => {
                const results = { imageUrls: [], imageData: [], errors: [], debug: [] };

                // Helper: fetch image from URL, return { dataUrl, size, type, sourceUrl, imageIndex } or null
                async function fetchImageData(url, imageIndex, tag) {
                    try {
                        const r = await fetch(url, { credentials: 'include' });
                        if (!r.ok) { results.debug.push(tag + ': HTTP ' + r.status); return null; }
                        const blob = await r.blob();
                        if (blob.size < 500) { results.debug.push(tag + ': too small ' + blob.size); return null; }
                        return new Promise(resolve => {
                            const fr = new FileReader();
                            fr.onload = () => resolve({
                                dataUrl: fr.result,
                                size: blob.size,
                                type: blob.type,
                                sourceUrl: url,
                                imageIndex,
                                tag,
                            });
                            fr.onerror = () => resolve(null);
                            fr.readAsDataURL(blob);
                        });
                    } catch (e) {
                        results.debug.push(tag + ': ' + e.message);
                        return null;
                    }
                }

                // Helper: build all URL variants for an image path
                function buildUrlVariants(imgUrl) {
                    const urls = [];
                    const relPath = imgUrl.replace(/^\/+/, '');
                    // Variant 1: assets.grok.com CDN (part-0)
                    urls.push(assetsBase + relPath);
                    // Variant 2: REST asset endpoint (part-0)
                    urls.push(restAssetBase + relPath);
                    // Variant 3: Final URL without -part-N (assets CDN)
                    const stripped = relPath.replace(/-part-\d+\//, '/');
                    if (stripped !== relPath) {
                        urls.push(assetsBase + stripped);
                        urls.push(restAssetBase + stripped);
                    }
                    return urls;
                }

                try {
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        credentials: 'include',
                    });

                    if (!resp.ok) {
                        results.errors.push('HTTP ' + resp.status);
                        return results;
                    }

                    const reader = resp.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    const seenUrls = new Set();
                    const fetchPromises = [];
                    // Track per-imageIndex: { uuid, urls, moderated }
                    const imageTracker = new Map();

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const j = JSON.parse(line);

                                // *** PRIMARY: Parse cardAttachment.jsonData.image_chunk ***
                                // This is the ACTUAL format Grok uses for image generation
                                const cardJson = j.result?.response?.cardAttachment?.jsonData;
                                if (cardJson) {
                                    try {
                                        const card = JSON.parse(cardJson);
                                        const chunk = card?.image_chunk;
                                        if (chunk?.imageUuid) {
                                            const idx = chunk.imageIndex || 0;
                                            const existing = imageTracker.get(chunk.imageUuid) || { urls: [] };
                                            if (chunk.progress != null) existing.progress = Math.max(existing.progress || 0, chunk.progress);
                                            if (chunk.imageIndex != null) existing.imageIndex = chunk.imageIndex;
                                            if (chunk.moderated) existing.moderated = true;
                                            if (chunk.rRated) existing.rRated = true;
                                            imageTracker.set(chunk.imageUuid, existing);

                                            // RACE: When imageUrl appears, immediately fire downloads from ALL endpoints
                                            if (chunk.imageUrl && !seenUrls.has(chunk.imageUrl)) {
                                                seenUrls.add(chunk.imageUrl);
                                                existing.urls.push(chunk.imageUrl);
                                                results.imageUrls.push({
                                                    url: chunk.imageUrl,
                                                    progress: chunk.progress || 0,
                                                    moderated: chunk.moderated || false,
                                                    imageIndex: idx,
                                                });
                                                results.debug.push('URL spotted at progress=' + chunk.progress + ': ' + chunk.imageUrl.substring(chunk.imageUrl.indexOf('generated')));

                                                // Fire downloads from ALL URL variants simultaneously
                                                const variants = buildUrlVariants(chunk.imageUrl);
                                                for (let vi = 0; vi < variants.length; vi++) {
                                                    fetchPromises.push(fetchImageData(variants[vi], idx, 'race_p' + chunk.progress + '_v' + vi));
                                                }
                                            }
                                        }
                                    } catch (_) {}
                                }

                                // FALLBACK: Also check streamingImageGenerationResponse (older format)
                                const ir = j.result?.response?.streamingImageGenerationResponse;
                                if (ir?.imageUrl && !seenUrls.has(ir.imageUrl)) {
                                    seenUrls.add(ir.imageUrl);
                                    results.imageUrls.push({
                                        url: ir.imageUrl,
                                        progress: ir.progress,
                                        moderated: ir.moderated || false,
                                        imageIndex: ir.imageIndex || 0,
                                    });
                                    const variants = buildUrlVariants(ir.imageUrl);
                                    for (let vi = 0; vi < variants.length; vi++) {
                                        fetchPromises.push(fetchImageData(variants[vi], ir.imageIndex || 0, 'ir_v' + vi));
                                    }
                                }

                                // Collect title
                                if (j.result?.title?.newTitle) {
                                    results.title = j.result.title.newTitle;
                                }
                            } catch (_) {}
                        }
                    }

                    // Stream ended — RETRY: try final URLs again with aggressive timing
                    // The server may briefly serve the full-res image before moderation kicks in
                    const retryDelays = [0, 100, 300, 750, 1500, 3000];
                    for (const [uuid, info] of imageTracker) {
                        if (info.urls.length > 0) {
                            for (const imgUrl of info.urls) {
                                const stripped = imgUrl.replace(/-part-\d+\//, '/');
                                const relStripped = stripped.replace(/^\/+/, '');
                                const relPart = imgUrl.replace(/^\/+/, '');
                                for (let ri = 0; ri < retryDelays.length; ri++) {
                                    const delay = retryDelays[ri];
                                    const tag = 'retry_' + delay + 'ms';
                                    if (delay === 0) {
                                        fetchPromises.push(fetchImageData(assetsBase + relStripped, info.imageIndex || 0, tag + '_cdn'));
                                        fetchPromises.push(fetchImageData(restAssetBase + relStripped, info.imageIndex || 0, tag + '_rest'));
                                        fetchPromises.push(fetchImageData(assetsBase + relPart, info.imageIndex || 0, tag + '_part'));
                                    } else {
                                        fetchPromises.push(
                                            new Promise(r => setTimeout(r, delay))
                                                .then(() => fetchImageData(assetsBase + relStripped, info.imageIndex || 0, tag + '_cdn'))
                                        );
                                        fetchPromises.push(
                                            new Promise(r => setTimeout(r, delay))
                                                .then(() => fetchImageData(restAssetBase + relStripped, info.imageIndex || 0, tag + '_rest'))
                                        );
                                    }
                                }
                            }
                        }
                    }

                    // Wait for ALL download attempts
                    const allResults = await Promise.all(fetchPromises);

                    // Group by imageIndex, keep the LARGEST image per index (largest = unblurred)
                    const bestByIndex = new Map();
                    for (const fr of allResults) {
                        if (!fr || !fr.dataUrl) continue;
                        const idx = fr.imageIndex || 0;
                        const existing = bestByIndex.get(idx);
                        results.debug.push(fr.tag + ': ' + fr.size + ' bytes (idx=' + idx + ')');
                        if (!existing || fr.size > existing.size) {
                            bestByIndex.set(idx, fr);
                        }
                    }

                    for (const [, best] of bestByIndex) {
                        results.imageData.push(best);
                        results.debug.push('BEST idx=' + best.imageIndex + ': ' + best.size + ' bytes from ' + best.tag);
                    }

                } catch (e) {
                    results.errors.push(e.message);
                }

                return results;
            }, apiUrl, body, assetsBase, restAssetBase);

            // Debug logging
            if (browserResult.debug?.length > 0) {
                console.log('[ImageService] 🌐 Browser debug:\n  ' + browserResult.debug.join('\n  '));
            }
            console.log(`[ImageService] 🌐 Browser result: ${browserResult.imageData.length} images fetched (best-of-race), ${browserResult.imageUrls.length} URLs seen, ${browserResult.errors.length} errors`);

            // Convert browser results to standard format
            const result = {
                title: browserResult.title || '',
                imageUrls: [],
                imageBase64: [],
                error: null,
                status: 200,
            };

            // Convert fetched image data to base64
            for (const img of browserResult.imageData) {
                result.imageBase64.push({
                    data: img.dataUrl,
                    imageIndex: img.imageIndex,
                    size: img.size,
                });
            }

            // Also keep URLs as fallback
            for (const u of browserResult.imageUrls) {
                result.imageUrls.push({ imageUrl: u.url, imageIndex: u.imageIndex });
            }

            if (result.imageBase64.length === 0 && result.imageUrls.length === 0) {
                result.error = browserResult.errors.length > 0 ? browserResult.errors.join(' | ') : 'no images returned';
            }

            return result;
        } catch (err) {
            console.log('[ImageService] 🌐 Browser generation error: ' + err.message);
            return null;
        }
    }

    async generateViaOfficialApi(prompt, config = {}) {
        const apiKey = config.xaiApiKey || process.env.XAI_API_KEY;
        if (!apiKey) return null;

        const res = await axios.post(
            'https://api.x.ai/v1/images/generations',
            this.buildApiBody(prompt, config),
            {
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                validateStatus: () => true,
                timeout: 120000,
            }
        );

        const result = this.parseOfficialApiResponse(res.data, res.status);
        if (result.imageUrls.length > 0 || result.imageBase64.length > 0 || result.error) {
            return result;
        }
        return null;
    }

    /**
     * Generate single image
     * @param {string} prompt - Text prompt
     * @param {Object} session - Session data with headers and cookies
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} Result with image URLs
     */
    async generateOne(prompt, session, config = {}, onProgress = null) {
        const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;
        const useWebSocket = config.useImagineWebSocket !== false;

        // PRIMARY: Imagine WebSocket — multi-image + base64 blobs that bypass CDN moderation.
        if (useWebSocket && session._page) {
            try {
                console.log('[ImageService] Imagine WS generation (multi-image, anti-blur)...');
                const wsResult = await this.generateViaWebSocket(prompt, session, config);
                if (wsResult && (wsResult.imageBase64.length > 0 || wsResult.imageUrls.length > 0)) {
                    console.log('[ImageService] WS gen SUCCESS: ' + wsResult.imageBase64.length + ' base64 + ' + wsResult.imageUrls.length + ' URLs');
                    if (onProgress) onProgress({ progress: 100, status: 'completed' });
                    return wsResult;
                }
                console.log('[ImageService] WS gen no images, falling back to chat-stream browser path...');
            } catch (wsErr) {
                console.log('[ImageService] WS gen error: ' + wsErr.message + ', falling back...');
            }
        }

        // SECONDARY: Browser-context conversations/new (parses cardAttachment.image_chunk).
        if (session._page) {
            try {
                console.log('[ImageService] Browser-context generation (anti-blur)...');
                const browserResult = await this.generateViaBrowser(prompt, session, config);
                if (browserResult && (browserResult.imageBase64.length > 0 || browserResult.imageUrls.length > 0)) {
                    console.log('[ImageService] Browser gen SUCCESS: ' + browserResult.imageBase64.length + ' base64 + ' + browserResult.imageUrls.length + ' URLs');
                    if (onProgress) onProgress({ progress: 100, status: 'completed' });
                    return browserResult;
                }
                console.log('[ImageService] Browser gen no images, falling back to axios...');
            } catch (browserErr) {
                console.log('[ImageService] Browser gen error: ' + browserErr.message + ', fallback to axios...');
            }
        }
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Recalculate cookieStr each attempt (may change after re-login)
                const cookieStr = this.formatCookies(session.cookies);

                const res = await axios.post(
                    API_ENDPOINTS.API_URL,
                    this.buildBody(prompt, config),
                    {
                        headers: this.buildHeaders(session.capturedHeaders, cookieStr),
                        responseType: 'text',
                        validateStatus: () => true,
                        timeout: 120000,
                    }
                );

                // Handle 429 rate limit
                if (res.status === 429 && attempt < MAX_RETRIES) {
                    const wait = PROCESSING_CONFIG.RETRY_DELAY + Math.random() * 5000;
                    console.log(`[ImageService] Rate limited, retrying in ${(wait / 1000).toFixed(1)}s...`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }

                // Handle 403 â€” session expired, re-login this account only
                if (res.status === 403 && attempt < MAX_RETRIES) {
                    console.warn(`[ImageService] âš ï¸ 403 Forbidden for ${session.email} â€” attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        // Update session in-place so all concurrent workers use new credentials
                        Object.assign(session, newSession);
                        console.log(`[ImageService] âœ… Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { imageUrls: [], imageBase64: [], error: `403 Forbidden â€” re-login failed or limit exceeded for ${session.email}`, status: 403 };
                    }
                }

                const rawText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                const allLines = rawText.split('\n').filter(l => l.trim());
                console.log('[ImageService] Axios fallback: HTTP ' + res.status + ' | ' + rawText.length + ' bytes | ' + allLines.length + ' lines');

                // Parse response
                const result = this.parseResponse(res.data, res.status);

                if (result.imageUrls.length > 0 && onProgress) {
                    onProgress({ progress: 100, status: 'completed' });
                }

                if (result.error === 'no images returned') {
                    const apiResult = await this.generateViaOfficialApi(prompt, config);
                    if (apiResult) {
                        if ((apiResult.imageUrls.length > 0 || apiResult.imageBase64.length > 0) && onProgress) {
                            onProgress({ progress: 100, status: 'completed' });
                        }
                        return apiResult;
                    }
                }

                return result;
            } catch (error) {
                if (attempt < MAX_RETRIES) {
                    console.error(`[ImageService] Error, retrying (${attempt + 1}/${MAX_RETRIES}):`, error.message);
                    await new Promise(resolve => setTimeout(resolve, PROCESSING_CONFIG.RETRY_DELAY));
                    continue;
                }
                return { imageUrls: [], imageBase64: [], error: error.message, status: 0 };
            }
        }
    }

    pushUniqueImageUrl(result, imageUrl, imageIndex = null) {
        if (!imageUrl || typeof imageUrl !== 'string') return;
        // Allow all image URLs including -part- paths (grok uses these for final images too)
        if (!/(^https?:\/\/|^users\/|^generated\/|^\/)/.test(imageUrl)) return;
        if (result.imageUrls.some(img => img.imageUrl === imageUrl)) return;
        // Dedup: if a partial (-part-0) URL exists and we now have the final, replace it
        const baseUrl = imageUrl.replace(/-part-\d+\//, "/");
        const existingIdx = result.imageUrls.findIndex(img => img.imageUrl.replace(/-part-\d+\//, "/") === baseUrl);
        if (existingIdx >= 0) {
            result.imageUrls[existingIdx] = { imageUrl, imageIndex: imageIndex ?? result.imageUrls[existingIdx].imageIndex };
            return;
        }
        result.imageUrls.push({ imageUrl, imageIndex: imageIndex ?? result.imageUrls.length });
    }

    pushUniqueBase64(result, data, imageIndex = null) {
        if (!data || typeof data !== 'string') return;
        const value = data.startsWith('data:image/')
            ? data
            : /^[A-Za-z0-9+/=]{1000,}$/.test(data)
                ? data
                : null;
        if (!value) return;
        if (result.imageBase64.some(img => img.data === value)) return;
        result.imageBase64.push({ data: value, imageIndex: imageIndex ?? result.imageBase64.length });
    }

    collectImagesDeep(node, result, imageIndex = null, skipCardAttachment = false) {
        if (!node) return;
        // Skip partial/preview images (progress < 100) — only collect final images
        if (typeof node === 'object' && !Array.isArray(node) && node.progress != null && node.progress < 100) return;
        if (typeof node === 'string') {
            // Skip cardAttachment jsonData strings — they contain partial -part-0 URLs
            // that bypass the progress filter. The explicit card parser handles these.
            if (skipCardAttachment && node.includes('image_chunk')) return;
            const dataUriMatches = node.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
            if (dataUriMatches) {
                for (const m of dataUriMatches) this.pushUniqueBase64(result, m, imageIndex);
            }
            // Only match full https URLs (not relative 'users/' paths from card JSON)
            const grokUrlMatches = node.match(/https?:\/\/assets\.grok\.com\/[^\s"'<>\\]+/g);
            if (grokUrlMatches) {
                for (const m of grokUrlMatches) this.pushUniqueImageUrl(result, m.trim().replace(/^["']/, ''), imageIndex);
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item, i) => this.collectImagesDeep(item, result, imageIndex ?? i, skipCardAttachment));
            return;
        }
        if (typeof node !== 'object') return;

        // Skip the cardAttachment object itself — handled by explicit parser
        if (skipCardAttachment && node.jsonData && typeof node.jsonData === 'string' && node.jsonData.includes('image_chunk')) return;

        const idx = node.imageIndex ?? node.index ?? imageIndex;
        for (const [key, value] of Object.entries(node)) {
            const lowerKey = key.toLowerCase();
            if (typeof value === 'string') {
                if (['imageurl', 'url', 'uri', 'fileuri', 'asseturl'].includes(lowerKey) || lowerKey.includes('imageurl')) {
                    // Skip if this looks like a partial -part- URL from card data
                    if (skipCardAttachment && value.includes('-part-')) continue;
                    this.pushUniqueImageUrl(result, value, idx);
                    continue;
                }
                if (['imagebytes', 'b64_json', 'base64'].includes(lowerKey) || lowerKey.includes('base64')) {
                    this.pushUniqueBase64(result, value, idx);
                    continue;
                }
            }
            this.collectImagesDeep(value, result, idx, skipCardAttachment);
        }
    }

    parseOfficialApiResponse(data, status) {
        const result = {
            title: '',
            imageUrls: [],
            imageBase64: [],
            error: null,
            errorDetail: null,
            status,
        };

        let payload;
        try {
            payload = typeof data === 'string' ? JSON.parse(data) : data;
        } catch (_) {
            payload = { raw: String(data || '') };
        }
        if (Array.isArray(payload?.data)) {
            payload.data.forEach((item, i) => {
                this.pushUniqueImageUrl(result, item.url, i);
                this.pushUniqueBase64(result, item.b64_json, i);
                if (!result.title && item.revised_prompt) result.title = item.revised_prompt;
            });
        }
        this.collectImagesDeep(payload, result);

        if (result.imageUrls.length + result.imageBase64.length === 0) {
            result.error = status !== 200 ? `xAI Images API HTTP ${status}` : payload?.error?.message || payload?.message || null;
            result.errorDetail = JSON.stringify(payload).substring(0, 500);
        }
        return result;
    }

    /**
     * Parse NDJSON response
     * @param {string} text - Response text
     * @param {number} status - HTTP status
     * @returns {Object} Parsed result
     */
    parseResponse(text, status) {
        const result = {
            title: '',
            imageUrls: [],
            imageBase64: [],
            error: null,
            errorDetail: null,
            status: status,
        };

        const lines = text.split('\n').filter(l => l.trim());
        const errorMessages = [];

        // Track ALL image chunks by UUID across the stream
        // This maps imageUuid -> { imageUrl (from partial), progress, imageIndex, moderated }
        const imageChunkMap = new Map();

        console.log('[ImageService] parseResponse called, lines:', lines.length, 'status:', status);

        for (const line of lines) {
            try {
                const j = JSON.parse(line);
                if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

                // Extract images from cardAttachment — track ALL chunks by UUID
                const cardJson = j.result?.response?.cardAttachment?.jsonData;
                if (cardJson) {
                    try {
                        const card = JSON.parse(cardJson);
                        const chunk = card?.image_chunk;
                        if (chunk?.imageUuid) {
                            const existing = imageChunkMap.get(chunk.imageUuid) || {};
                            // Capture imageUrl (typically from progress=50 partial preview)
                            if (chunk.imageUrl) existing.imageUrl = chunk.imageUrl;
                            // Track highest progress
                            if (chunk.progress != null && (existing.progress == null || chunk.progress > existing.progress)) {
                                existing.progress = chunk.progress;
                            }
                            if (chunk.imageIndex != null) existing.imageIndex = chunk.imageIndex;
                            if (chunk.moderated) existing.moderated = true;
                            imageChunkMap.set(chunk.imageUuid, existing);
                        }
                    } catch (_cardErr) {}
                }

                // collectImagesDeep — but skip cardAttachment jsonData strings
                // (they contain partial -part-0 URLs that bypass progress filter)
                this.collectImagesDeep(j, result, null, true);

                // Collect errors
                if (j.error) {
                    errorMessages.push(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
                }
                if (j.result?.error) {
                    errorMessages.push(typeof j.result.error === 'string' ? j.result.error : j.result.error.message || JSON.stringify(j.result.error));
                }

                const mr = j.result?.response?.modelResponse;
                if (mr?.error) {
                    errorMessages.push(typeof mr.error === 'string' ? mr.error : mr.error.message || JSON.stringify(mr.error));
                }
                if (false && (mr?.isSoftBlock || mr?.isDisallowed)) {
                    errorMessages.push(`Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`);
                }

                // Collect image URLs from older streaming response
                const ir = j.result?.response?.streamingImageGenerationResponse;
                if (ir && ir.progress === 100 && ir.imageUrl) {
                    this.pushUniqueImageUrl(result, ir.imageUrl, ir.imageIndex);
                }
                // Collect base64 from streamingImageGenerationResponse
                if (ir && ir.imageBytes) {
                    this.pushUniqueBase64(result, ir.imageBytes, ir.imageIndex || result.imageBase64.length);
                }

                // Fallback: collect from modelResponse
                if (mr?.generatedImageUrls?.length > 0 && result.imageUrls.length === 0) {
                    mr.generatedImageUrls.forEach((u, i) =>
                        this.pushUniqueImageUrl(result, u, i)
                    );
                }

                // Collect base64 data URIs from tokens
                const token = j.result?.response?.token;
                if (typeof token === 'string' && token.includes('data:image/')) {
                    const matches = token.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
                    if (matches) {
                        for (const m of matches) {
                            this.pushUniqueBase64(result, m, result.imageBase64.length);
                        }
                    }
                }
            } catch (_) {
                // Also check non-JSON lines for data URIs
                if (line.includes('data:image/')) {
                    const matches = line.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
                    if (matches) {
                        for (const m of matches) {
                            this.pushUniqueBase64(result, m, result.imageBase64.length);
                        }
                    }
                }
            }
        }

        // *** CRITICAL: Resolve final image URLs from tracked UUID chunks ***
        // On grok.com, the web client constructs final URLs from imageUuid.
        // When moderated=true at progress=100, server omits imageUrl.
        // We use the partial URL (from progress=50) and strip -part-N to get final.
        for (const [uuid, info] of imageChunkMap) {
            if (info.progress >= 100 && info.imageUrl) {
                if (info.moderated) {
                    // Moderated: server DELETES final image. Use part-0 URL with session cookies
                    console.log('[ImageService] UUID ' + uuid.substring(0,8) + ': moderated, using part-0 URL');
                    this.pushUniqueImageUrl(result, info.imageUrl, info.imageIndex != null ? info.imageIndex : null);
                } else {
                    // Not moderated: strip -part-N to get final full-resolution URL
                    const finalUrl = info.imageUrl.replace(/-part-\d+\//, '/');
                    this.pushUniqueImageUrl(result, finalUrl, info.imageIndex != null ? info.imageIndex : null);
                }
            } else if (info.progress >= 100 && !info.imageUrl) {
                console.warn('[ImageService] UUID ' + uuid.substring(0,8) + ': progress=100 but no URL');
            }
        }

        // parseResponse summary
        console.log(`[ImageService] parseResponse: ${result.imageUrls.length} URLs, ${result.imageBase64.length} base64, chunkMap=${imageChunkMap.size}`);

        const totalImages = result.imageUrls.length + result.imageBase64.length;
        if (totalImages === 0) {
            result.error = status !== 200 ? `HTTP ${status}` : errorMessages.length > 0 ? errorMessages.join(' | ') : 'no images returned';
            result.errorDetail = text.substring(0, 500);
        }

        if (result.imageBase64.length > 0) {
            console.log(`[ImageService] 🖼️ Found ${result.imageBase64.length} base64 images`);
        }
        if (result.imageUrls.length > 0) {
            console.log(`[ImageService] 🖼️ Found ${result.imageUrls.length} image URLs: ${result.imageUrls.map(u => u.imageUrl.substring(u.imageUrl.lastIndexOf('/') - 20)).join(', ')}`);
        }

        return result;
    }

    /**
     * Download image
     * @param {string} imageUrl - Image URL path
     * @param {Object} session - Session data
     * @returns {Promise<Object>} Image data {data, size, contentType}
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

        // Build ALL URL variants to try in parallel
        const urlsToTry = [];
        const relPath = imageUrl.startsWith('http')
            ? imageUrl.replace(base, '').replace(restBase, '')
            : imageUrl.replace(/^\/+/, '');

        // CDN + REST for original path
        urlsToTry.push(base + relPath);
        urlsToTry.push(restBase + relPath);
        // Also try with/without -part-N
        if (relPath.includes('-part-')) {
            const stripped = relPath.replace(/-part-\d+\//, '/');
            urlsToTry.push(base + stripped);
            urlsToTry.push(restBase + stripped);
        } else {
            const partUrl = relPath.replace(/\/image\.jpg/, '-part-0/image.jpg');
            if (partUrl !== relPath) {
                urlsToTry.push(base + partUrl);
                urlsToTry.push(restBase + partUrl);
            }
        }

        // Download ALL variants in parallel, keep the LARGEST result
        const downloadPromises = urlsToTry.map(async (url, i) => {
            try {
                const res = await axios.get(url, {
                    headers: dlHeaders,
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    validateStatus: () => true,
                });
                if (res.status === 200 && res.data.byteLength > 500) {
                    console.log(`[ImageService] DL variant ${i}: ${res.data.byteLength} bytes - ${url.substring(url.lastIndexOf('/') - 30)}`);
                    return {
                        data: Buffer.from(res.data),
                        size: res.data.byteLength,
                        contentType: res.headers['content-type'],
                        url,
                    };
                } else {
                    console.log(`[ImageService] DL variant ${i}: HTTP ${res.status}, ${res.data.byteLength}b - ${url.substring(url.lastIndexOf('/') - 30)}`);
                    return null;
                }
            } catch (err) {
                console.log(`[ImageService] DL variant ${i} failed: ${err.message}`);
                return null;
            }
        });

        const results = await Promise.all(downloadPromises);

        // Pick the LARGEST successful download (largest = unblurred full-res)
        let best = null;
        for (const r of results) {
            if (r && (!best || r.size > best.size)) {
                best = r;
            }
        }

        if (best) {
            console.log(`[ImageService] Best download: ${best.size} bytes from ${best.url.substring(best.url.lastIndexOf('/') - 30)}`);
            return { data: best.data, size: best.size, contentType: best.contentType };
        }
        return null;
    }


    /**
     * Download image via Puppeteer browser page (bypasses server-side moderation blur)
     * This uses the same browser session as grok.com web, so images are served unblurred
     */
    async downloadViaBrowser(imageUrl, session) {
        if (!session._page) {
            console.log('[ImageService] No browser page available for browser download');
            return null;
        }

        const base = API_ENDPOINTS.ASSETS_BASE_URL;
        const fullUrl = imageUrl.startsWith('http') ? imageUrl : base + imageUrl.replace(/^\/+/, '');

        try {
            console.log('[ImageService] Attempting browser download: ' + fullUrl.substring(fullUrl.indexOf('generated')));
            
            // Use the live browser page to fetch the image (has full session context)
            const result = await session._page.evaluate(async (url) => {
                try {
                    const resp = await fetch(url, { credentials: 'include' });
                    if (!resp.ok) return { error: 'HTTP ' + resp.status, status: resp.status };
                    const blob = await resp.blob();
                    const reader = new FileReader();
                    return new Promise((resolve) => {
                        reader.onload = () => resolve({ 
                            dataUrl: reader.result, 
                            size: blob.size, 
                            type: blob.type 
                        });
                        reader.onerror = () => resolve({ error: 'FileReader error' });
                        reader.readAsDataURL(blob);
                    });
                } catch (e) {
                    return { error: e.message };
                }
            }, fullUrl);

            if (result.error) {
                console.log('[ImageService] Browser download error: ' + result.error);
                return null;
            }

            if (result.dataUrl && result.size > 1000) {
                // Extract base64 data from data URL
                const base64Match = result.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (base64Match) {
                    const buffer = Buffer.from(base64Match[2], 'base64');
                    console.log('[ImageService] Browser download OK: ' + buffer.length + ' bytes (' + result.type + ')');
                    return {
                        data: buffer,
                        size: buffer.length,
                        contentType: result.type || 'image/jpeg',
                    };
                }
            }

            console.log('[ImageService] Browser download: insufficient data (' + (result.size || 0) + ' bytes)');
            return null;
        } catch (err) {
            console.log('[ImageService] Browser download exception: ' + err.message);
            return null;
        }
    }

    /**
     * Process a single prompt — generate the image via Grok, persist
     * any base64 / URL outputs to ``outputFolder``, and return a
     * ``jobResult`` with the same shape ``generateBatch`` produces.
     *
     * Extracted from the inner worker function of ``generateBatch``
     * (PR-47) so the cross-session work-stealing fan-out scheduler in
     * ``electron/main.js`` can dispatch single items directly to a
     * pool of sessions without going through ``generateBatch``'s
     * static-slice contract.
     *
     * The behaviour, file-naming convention, base64-vs-URL precedence,
     * and progress reporting are unchanged from the previous worker;
     * any deviation is a regression.
     *
     * @param {string} prompt
     * @param {object} session
     * @param {object} [config={}]
     * @param {Function|null} [onProgress=null] - (prompt, progress, result|null, localIdx) => void
     * @param {number} myIdx - 0-based per-session index reported back via onProgress.
     * @param {number} globalNum - 1-based global shot number used for ``shot####`` naming.
     * @param {number} totalForLog - "N" used in the "#i/N" log decoration.
     * @param {string} [outputFolder] - Where to write images. Defaults to ``config.outputFolder`` / ``PATHS.IMAGE_DIR``.
     * @returns {Promise<object>} jobResult: { prompt, localIdx, title, savedFiles, outputPath, success, error }
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
        const folder = outputFolder || config.outputFolder || PATHS.IMAGE_DIR;
        const label = `Acc${session.accIdx + 1}`;

        console.log(`[ImageService] [${label}] 🖼️ #${myIdx + 1}/${totalForLog} (shot${String(globalNum).padStart(4, '0')}) starting: ${prompt.substring(0, 50)}...`);

        const result = await this.generateOne(prompt, session, config, (prog) => {
            if (onProgress) onProgress(prompt, prog.progress, null, myIdx);
        });

        const savedFiles = [];
        const shotNum = String(globalNum).padStart(4, '0');
        const batchTs = Date.now().toString(36);
        const titleSlug = (result.title || '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);

        if ((result.imageBase64 || []).length > 0) {
            // Track used filenames within this shot to avoid collisions
            // when multiple images share the same order/imageIndex.
            const usedNames = new Set();
            for (let imgIdx = 0; imgIdx < result.imageBase64.length; imgIdx++) {
                const img = result.imageBase64[imgIdx];
                try {
                    let base64Data = img.data;
                    let ext = 'png';
                    if (base64Data.startsWith('data:image/')) {
                        const match = base64Data.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
                        if (match) {
                            ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                            base64Data = base64Data.substring(match[0].length);
                        }
                    }
                    const buffer = Buffer.from(base64Data, 'base64');
                    // Use sequential imgIdx as fallback to guarantee unique names
                    const imgNum = img.imageIndex != null ? img.imageIndex : imgIdx;
                    let filename = titleSlug
                        ? `shot${shotNum}_${batchTs}_${titleSlug}_i${imgNum}.${ext}`
                        : `shot${shotNum}_${batchTs}_i${imgNum}.${ext}`;
                    // If this name was already used (duplicate order), append loop index
                    if (usedNames.has(filename)) {
                        filename = titleSlug
                            ? `shot${shotNum}_${batchTs}_${titleSlug}_i${imgIdx}.${ext}`
                            : `shot${shotNum}_${batchTs}_i${imgIdx}.${ext}`;
                    }
                    usedNames.add(filename);
                    const filePath = FileService.saveFile(buffer, filename, folder);
                    savedFiles.push(filePath);
                    img.size = buffer.length;
                    console.log(`[ImageService] [${label}] 💾 Saved base64 image: ${filename} (${buffer.length} bytes)`);
                } catch (error) {
                    console.error(`[ImageService] [${label}] Base64 save error:`, error.message);
                }
            }
        }

        const bestBase64Size = savedFiles.length > 0 ? Math.max(...(result.imageBase64 || []).map(i => i.size || 0), 0) : 0;
        if ((result.imageUrls || []).length > 0 && bestBase64Size < 50000) {
            for (const img of result.imageUrls) {
                try {
                    let dl = await this.downloadImage(img.imageUrl, session);
                    if (dl && dl.size < 50000 && session._page) {
                        console.log('[ImageService] Image too small (' + dl.size + 'b), trying browser download...');
                        const browserDl = await this.downloadViaBrowser(img.imageUrl, session);
                        if (browserDl && browserDl.size > dl.size) {
                            console.log('[ImageService] Browser download better: ' + browserDl.size + 'b vs ' + dl.size + 'b');
                            dl = browserDl;
                        }
                    }
                    if (!dl && session._page) {
                        dl = await this.downloadViaBrowser(img.imageUrl, session);
                    }
                    if (dl && dl.size > bestBase64Size) {
                        const ext = dl.contentType?.includes('png') ? 'png' : 'jpg';
                        const cdnIdx = img.imageIndex || 0;
                        const filename = titleSlug ? `shot${shotNum}_${batchTs}_${titleSlug}_cdn_i${cdnIdx}.${ext}` : `shot${shotNum}_${batchTs}_cdn_i${cdnIdx}.${ext}`;
                        const filePath = FileService.saveFile(dl.data, filename, folder);
                        savedFiles.push(filePath);
                        console.log(`[ImageService] [${label}] 💾 Saved URL image: ${filename} (${dl.size} bytes)`);
                    } else if (dl) {
                        console.log(`[ImageService] [${label}] Skipping URL image (${dl.size}b <= base64 ${bestBase64Size}b)`);
                    }
                } catch (error) {
                    console.error(`[ImageService] [${label}] Download error:`, error.message);
                }
            }
        } else if (bestBase64Size >= 50000) {
            console.log(`[ImageService] [${label}] Skipping URL downloads — already have good base64 (${bestBase64Size}b)`);
        }

        const jobResult = {
            prompt,
            localIdx: myIdx,
            title: result.title,
            savedFiles,
            outputPath: savedFiles.length > 0 ? savedFiles[0] : null,
            success: savedFiles.length > 0,
            error: result.error,
        };

        if (onProgress) {
            onProgress(prompt, 100, jobResult, myIdx);
        }

        console.log(`[ImageService] [${label}] #${myIdx + 1}/${totalForLog} ${savedFiles.length > 0 ? '✅' : '❌'} ${result.title || prompt.substring(0, 50)}`);

        return jobResult;
    }

    /**
     * Generate images for multiple prompts on a SINGLE session via a
     * per-session worker pool. Kept for back-compat — the cross-
     * session fan-out scheduler in ``electron/main.js`` calls
     * ``_processOneBatchItem`` directly so the body here is just a
     * thin wrapper that drives the same per-item processor in a
     * static-slice context.
     *
     * @param {Array<string>} prompts - Array of prompts
     * @param {Object} session - Session data
     * @param {Object} config - Config with batchSize
     * @param {Function} onProgress - Progress callback (prompt, progress, result)
     * @param {number} [startIdx=0] - Global offset for ``shot####`` naming.
     * @returns {Promise<Array<Object>>} Results array (jobResults).
     */
    async generateBatch(prompts, session, config = {}, onProgress = null, startIdx = 0) {
        const N = prompts.length;
        const CONCURRENCY = config.batchSize || PROCESSING_CONFIG.BATCH_SIZE || 30;
        const outputFolder = config.outputFolder || PATHS.IMAGE_DIR;
        const label = `Acc${session.accIdx + 1}`;

        console.log(`[ImageService] [${label}] ${N} images | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

        const results = [];
        let nextIdx = 0;
        const self = this;

        async function worker() {
            while (nextIdx < N) {
                if (self._cancelled) {
                    console.log(`[ImageService] [${label}] ⛔ Cancelled, stopping worker`);
                    break;
                }
                const myIdx = nextIdx++;
                const prompt = prompts[myIdx];
                const globalNum = startIdx + myIdx + 1;
                const jobResult = await self._processOneBatchItem(
                    prompt,
                    session,
                    config,
                    onProgress,
                    myIdx,
                    globalNum,
                    N,
                    outputFolder,
                );
                results.push(jobResult);
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
            workers.push(
                new Promise((resolve) => setTimeout(() => resolve(worker()), i * 75))
            );
        }
        await Promise.all(workers);

        console.log(`[ImageService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
        return results;
    }
}

// Export singleton instance
module.exports = new ImageService();
