const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { API_URL, UPLOAD_URL, POST_CREATE_URL, I2V_DIR, I2V_CONFIG, BATCH_SIZE, LOG_DIR } = require("./config");
const { delay } = require("./utils");

function formatCookies(cookies) {
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function buildHeaders(capturedHeaders, cookieStr, referer) {
    const headers = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k.startsWith(":")) headers[k] = v;
    }
    headers["content-type"] = "application/json";
    headers["x-xai-request-id"] = crypto.randomUUID();
    headers["cookie"] = cookieStr;
    if (referer) headers["referer"] = referer;
    delete headers["host"];
    delete headers["content-length"];
    return headers;
}

/**
 * Upload an image file to Grok and get fileMetadataId
 * @param {string} imagePath - path to the image file
 */
async function uploadFile(imagePath, capturedHeaders, cookieStr) {
    const fileBuffer = fs.readFileSync(imagePath);
    const base64Content = fileBuffer.toString("base64");
    const ext = path.extname(imagePath).toLowerCase().replace(".", "");
    const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    const fileMimeType = mimeMap[ext] || "image/jpeg";
    const fileName = `${crypto.randomUUID()}.${ext === "jpg" ? "jpeg" : ext}`;

    const res = await axios.post(
        UPLOAD_URL,
        {
            fileName,
            fileMimeType,
            content: base64Content,
            fileSource: "IMAGINE_SELF_UPLOAD_FILE_SOURCE",
        },
        {
            headers: buildHeaders(capturedHeaders, cookieStr, "https://grok.com/imagine"),
            validateStatus: () => true,
            timeout: 60000,
        }
    );

    if (res.status !== 200) {
        console.log(`    ❌ Upload failed: HTTP ${res.status}`);
        console.log(`    📋 Upload response: ${JSON.stringify(res.data).substring(0, 1000)}`);
        return { error: `upload HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
    }

    // Log upload result
    console.log(`    ✅ Upload OK`);

    const fileMetadataId = res.data?.fileMetadataId;
    const fileUri = res.data?.fileUri;
    if (!fileMetadataId) {
        return { error: "no fileMetadataId", errorDetail: JSON.stringify(res.data).substring(0, 500) };
    }

    return { fileMetadataId, fileUri, uploadResponse: res.data };
}

/**
 * Create media post (required step after upload, before video gen)
 * Browser calls POST /rest/media/post/create with mediaType=IMAGE and mediaUrl
 */
async function createMediaPost(imageUrl, capturedHeaders, cookieStr) {
    const res = await axios.post(
        POST_CREATE_URL,
        {
            mediaType: "MEDIA_POST_TYPE_IMAGE",
            mediaUrl: imageUrl,
        },
        {
            headers: buildHeaders(capturedHeaders, cookieStr, "https://grok.com/imagine"),
            validateStatus: () => true,
            timeout: 30000,
        }
    );
    if (res.status !== 200) {
        console.log(`    ❌ post/create failed: HTTP ${res.status}`);
        console.log(`    📋 Response: ${JSON.stringify(res.data).substring(0, 500)}`);
        return { error: `post/create HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
    }
    const postId = res.data?.post?.id;
    console.log(`    ✅ post/create OK: postId=${postId}`);
    return { postId, postData: res.data };
}

function buildI2VBody(prompt, fileMetadataId, imageUrl) {
    // message format: "<imageUrl> <prompt> --mode=custom"
    const message = imageUrl
        ? `${imageUrl}  ${prompt} --mode=custom`
        : `${prompt} --mode=custom`;

    return {
        temporary: true,
        modelName: "grok-3",
        message,
        fileAttachments: [fileMetadataId],
        toolOverrides: { videoGen: true },
        enableSideBySide: true,
        responseMetadata: {
            experiments: [],
            modelConfigOverride: {
                modelMap: {
                    videoGenModelConfig: {
                        parentPostId: fileMetadataId,
                        aspectRatio: I2V_CONFIG.aspectRatio,
                        videoLength: I2V_CONFIG.videoLength,
                        isVideoEdit: I2V_CONFIG.isVideoEdit,
                        resolutionName: I2V_CONFIG.resolutionName,
                    },
                },
            },
        },
    };
}

function parseStreamResponse(text) {
    const result = {
        title: "",
        videoUrl: null,
        videoId: null,
        progress: 0,
        error: null,
        errorDetail: null,
    };
    const lines = text.split("\n").filter((l) => l.trim());

    for (const line of lines) {
        try {
            const j = JSON.parse(line);
            if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

            if (j.error) {
                const msg = typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error);
                if (!result.error) result.error = msg;
            }
            if (j.result?.error) {
                const msg = typeof j.result.error === "string" ? j.result.error : j.result.error.message || JSON.stringify(j.result.error);
                if (!result.error) result.error = msg;
            }

            const mr = j.result?.response?.modelResponse;
            if (mr?.error) {
                const msg = typeof mr.error === "string" ? mr.error : mr.error.message || JSON.stringify(mr.error);
                if (!result.error) result.error = msg;
            }
            if (mr?.isSoftBlock || mr?.isDisallowed) {
                if (!result.error) result.error = `Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`;
            }

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
                    const msg = typeof vr.error === "string" ? vr.error : vr.error.message || JSON.stringify(vr.error);
                    if (!result.error) result.error = msg;
                }
            }
        } catch (_) { }
    }

    // Fallback: use videoId as download key
    if (!result.videoUrl && result.videoId) {
        result.videoUrl = result.videoId;
        console.log(`[genI2VAxios] Using videoId as download key: ${result.videoId}`);
    }

    if (!result.videoUrl && !result.error) {
        result.error = `Video gen stopped at ${result.progress}% - no video URL returned`;
    }
    return result;
}

async function downloadVideoByUrl(url, capturedHeaders, cookieStr) {
    const dlHeaders = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k.startsWith(":")) dlHeaders[k] = v;
    }
    dlHeaders["cookie"] = cookieStr;
    dlHeaders["referer"] = "https://grok.com/";
    dlHeaders["origin"] = "https://grok.com";
    dlHeaders["accept"] = "*/*";
    delete dlHeaders["host"];
    delete dlHeaders["content-length"];
    delete dlHeaders["content-type"];

    const MAX_RETRIES = 5;
    const RETRY_DELAY = 3000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const res = await axios.get(url, {
                headers: dlHeaders,
                responseType: "arraybuffer",
                timeout: 120000,
                validateStatus: () => true,
            });
            if (res.status === 200 && res.data.byteLength > 1000) {
                return { data: Buffer.from(res.data), size: res.data.byteLength };
            }
            if (res.status === 404 || res.status === 403) {
                if (attempt < MAX_RETRIES - 1) {
                    console.log(`    ⏳ Video not ready (${res.status}), retry ${attempt + 1}/${MAX_RETRIES}...`);
                    await delay(RETRY_DELAY);
                    continue;
                }
            }
            console.log(`    ⚠️ Download → HTTP ${res.status} (${res.data.byteLength} bytes)`);
        } catch (e) {
            console.log(`    ⚠️ Download error: ${e.message.substring(0, 60)}`);
            if (attempt < MAX_RETRIES - 1) { await delay(RETRY_DELAY); continue; }
        }
    }
    return null;
}

async function downloadVideo(videoId, userId, capturedHeaders, cookieStr) {
    const dlHeaders = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k.startsWith(":")) dlHeaders[k] = v;
    }
    dlHeaders["cookie"] = cookieStr;
    dlHeaders["referer"] = "https://grok.com/";
    dlHeaders["origin"] = "https://grok.com";
    dlHeaders["accept"] = "*/*";
    delete dlHeaders["host"];
    delete dlHeaders["content-length"];
    delete dlHeaders["content-type"];

    const url = `https://assets.grok.com/users/${userId}/generated/${videoId}/generated_video.mp4?cache=1&dl=1`;
    console.log(`    🔗 Download URL: ${url}`);

    // Video may not be ready yet (stream ends at ~95%), so poll with retries
    const MAX_RETRIES = 15;
    const RETRY_DELAY = 5000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const res = await axios.get(url, {
                headers: dlHeaders,
                responseType: "arraybuffer",
                timeout: 120000,
                validateStatus: () => true,
            });
            if (res.status === 200 && res.data.byteLength > 1000) {
                return { data: Buffer.from(res.data), size: res.data.byteLength, url };
            }
            if (res.status === 404 || res.status === 403) {
                if (attempt < MAX_RETRIES - 1) {
                    console.log(`    ⏳ Video not ready yet (${res.status}), retry ${attempt + 1}/${MAX_RETRIES}...`);
                    await delay(RETRY_DELAY);
                    continue;
                }
            }
            console.log(`    ⚠️ Download → HTTP ${res.status} (${res.data.byteLength} bytes)`);
        } catch (e) {
            console.log(`    ⚠️ Download error: ${e.message.substring(0, 60)}`);
            if (attempt < MAX_RETRIES - 1) {
                await delay(RETRY_DELAY);
                continue;
            }
        }
    }
    return null;
}

function getUserIdFromCookies(cookieStr) {
    const match = cookieStr.match(/x-userid=([^;]+)/);
    return match ? match[1] : null;
}

/**
 * Generate one image-to-video
 * @param {object} item - { imagePath, prompt }
 */
async function genOneI2V(item, globalIdx, capturedHeaders, cookieStr, label) {
    const { imagePath, prompt } = item;

    // Step 1: upload image
    console.log(`[${label}]   📤 #${globalIdx + 1} uploading ${path.basename(imagePath)}...`);
    const upload = await uploadFile(imagePath, capturedHeaders, cookieStr);
    if (upload.error) {
        return { ...upload, title: "", videoUrl: null, videoId: null, progress: 0, status: 0 };
    }

    const imageUrl = upload.fileUri ? `https://assets.grok.com/${upload.fileUri}` : null;

    console.log(`[${label}]   📋 Upload: fileMetadataId=${upload.fileMetadataId}`);

    // Step 2: create media post (required for video gen to complete)
    console.log(`[${label}]   📝 #${globalIdx + 1} creating media post...`);
    const post = await createMediaPost(imageUrl, capturedHeaders, cookieStr);
    if (post.error) {
        return { ...post, title: "", videoUrl: null, videoId: null, progress: 0, status: 0 };
    }

    // Step 3: video gen stream
    const body = buildI2VBody(prompt, upload.fileMetadataId, imageUrl);
    try {
        console.log(`[${label}]   🎬 #${globalIdx + 1} generating video (stream)...`);
        const res = await axios.post(API_URL, body, {
            headers: buildHeaders(capturedHeaders, cookieStr, "https://grok.com/imagine"),
            responseType: "stream",
            validateStatus: () => true,
            timeout: 300000,
        });

        if (res.status !== 200) {
            // Read error body
            let errBody = "";
            for await (const chunk of res.data) errBody += chunk.toString();
            return {
                title: "",
                videoUrl: null,
                videoId: null,
                progress: 0,
                error: `HTTP ${res.status}`,
                errorDetail: errBody.substring(0, 500),
                status: res.status,
            };
        }

        // Read stream chunk by chunk
        const result = {
            title: "",
            videoUrl: null,
            videoId: null,
            userId: null,
            progress: 0,
            error: null,
            errorDetail: null,
            status: res.status,
            fileMetadataId: upload.fileMetadataId,
        };
        let buffer = "";
        let lastLog = 0;
        let rawLog = ""; // accumulate full raw response for debug

        for await (const chunk of res.data) {
            const chunkStr = chunk.toString();
            buffer += chunkStr;
            rawLog += chunkStr;

            // Process complete lines
            const lines = buffer.split("\n");
            buffer = lines.pop(); // keep incomplete last line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const j = JSON.parse(line);
                    if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

                    // Errors
                    if (j.error) {
                        const msg = typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error);
                        if (!result.error) result.error = msg;
                    }
                    if (j.result?.error) {
                        const msg = typeof j.result.error === "string" ? j.result.error : j.result.error.message || JSON.stringify(j.result.error);
                        if (!result.error) result.error = msg;
                    }

                    const mr = j.result?.response?.modelResponse;
                    if (mr?.error) {
                        const msg = typeof mr.error === "string" ? mr.error : mr.error.message || JSON.stringify(mr.error);
                        if (!result.error) result.error = msg;
                    }
                    if (mr?.isSoftBlock || mr?.isDisallowed) {
                        if (!result.error) result.error = `Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`;
                    }

                    // Video progress
                    const vr = j.result?.response?.streamingVideoGenerationResponse;
                    if (vr) {
                        // Always capture videoId (it's present from the first progress update)
                        if (vr.videoId) result.videoId = vr.videoId;
                        if (vr.assetId) result.videoId = result.videoId || vr.assetId;

                        // Extract userId from imageReference URL
                        if (vr.imageReference && !result.userId) {
                            const m = vr.imageReference.match(/\/users\/([^/]+)\//);
                            if (m) result.userId = m[1];
                        }

                        const newProgress = vr.progress || result.progress;
                        if (newProgress > result.progress) {
                            result.progress = newProgress;
                            // Log progress every 20%
                            if (result.progress - lastLog >= 20) {
                                console.log(`[${label}]   ⏳ #${globalIdx + 1} progress: ${result.progress}%`);
                                lastLog = result.progress;
                            }
                        }
                        if (vr.videoUrl) {
                            result.videoUrl = vr.videoUrl;
                            console.log(`[${label}]   🎉 #${globalIdx + 1} video ready! url=${result.videoUrl.substring(0, 50)}`);
                        }
                        if (vr.error) {
                            const msg = typeof vr.error === "string" ? vr.error : vr.error.message || JSON.stringify(vr.error);
                            if (!result.error) result.error = msg;
                        }
                    }
                } catch (_) { }
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
                if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;
            } catch (_) { }
        }

        // If no videoUrl but we have videoId, use videoId as download key
        if (!result.videoUrl && result.videoId) {
            result.videoUrl = result.videoId;
            console.log(`[${label}]   🔑 #${globalIdx + 1} using videoId as download key: ${result.videoId}`);
        }

        if (!result.videoUrl && !result.error) {
            result.error = `Video gen stopped at ${result.progress}% - no video URL or ID returned`;
            result.errorDetail = buffer.substring(0, 500);
        }
        return result;
    } catch (err) {
        return {
            title: "",
            videoUrl: null,
            videoId: null,
            progress: 0,
            error: err.message,
            errorDetail: null,
            status: 0,
        };
    }
}

/**
 * Batch image-to-video generation
 * @param {Array<{imagePath: string, prompt: string}>} items
 */
async function batchGenI2VAxios(items, accIdx, startIdx, capturedHeaders, cookies) {
    const label = `Acc${accIdx + 1}`;
    const N = items.length;
    const CONCURRENCY = Math.min(BATCH_SIZE, 5); // Lower concurrency for i2v (upload + gen)
    const cookieStr = formatCookies(cookies);

    console.log(`[${label}] 🎬📸 ${N} image-to-video items | ${CONCURRENCY} concurrent (axios)`);

    const results = [];
    let nextIdx = 0;

    async function worker() {
        while (nextIdx < N) {
            const myIdx = nextIdx++;
            const globalIdx = startIdx + myIdx;
            const item = items[myIdx];

            const r = await genOneI2V(item, globalIdx, capturedHeaders, cookieStr, label);

            // Download video
            let savedFile = null;
            if (r.videoUrl) {
                // videoUrl from progress=100 is like "users/.../generated_video.mp4"
                const dlUrl = r.videoUrl.startsWith("http") ? r.videoUrl : `https://assets.grok.com/${r.videoUrl}`;
                console.log(`[${label}]   📥 Downloading #${globalIdx + 1}...`);
                console.log(`    🔗 ${dlUrl}`);
                try {
                    const dl = await downloadVideoByUrl(dlUrl, capturedHeaders, cookieStr);
                    if (dl) {
                        const filename = `a${accIdx + 1}_${globalIdx + 1}.mp4`;
                        const fp = path.join(I2V_DIR, filename);
                        fs.writeFileSync(fp, dl.data);
                        savedFile = { path: fp, size: dl.size };
                    }
                } catch (e) {
                    console.log(`[${label}]   ⚠️ Download failed #${globalIdx + 1}: ${e.message.substring(0, 80)}`);
                }
            } else if (r.videoId) {
                // Fallback: construct URL from videoId + userId
                const userId = r.userId || getUserIdFromCookies(cookieStr);
                if (userId) {
                    console.log(`[${label}]   📥 Downloading #${globalIdx + 1} (fallback)...`);
                    try {
                        const dl = await downloadVideo(r.videoId, userId, capturedHeaders, cookieStr);
                        if (dl) {
                            const filename = `a${accIdx + 1}_${globalIdx + 1}.mp4`;
                            const fp = path.join(I2V_DIR, filename);
                            fs.writeFileSync(fp, dl.data);
                            savedFile = { path: fp, size: dl.size };
                        }
                    } catch (e) {
                        console.log(`[${label}]   ⚠️ Download failed #${globalIdx + 1}: ${e.message.substring(0, 80)}`);
                    }
                }
            }

            const isOk = (r.videoUrl || r.videoId) && savedFile;
            if (isOk) {
                const sizeStr = `${(savedFile.size / 1024 / 1024).toFixed(1)}MB`;
                console.log(
                    `[${label}] ✅ #${globalIdx + 1} | ${sizeStr} | ${r.title || item.prompt.substring(0, 50)}`
                );
            } else {
                console.log(
                    `[${label}] ❌ #${globalIdx + 1} | ${r.progress}% | ${r.title || item.prompt.substring(0, 50)} | ${(r.error || "unknown").substring(0, 80)}`
                );
            }

            results.push({
                account: accIdx + 1,
                globalIndex: globalIdx + 1,
                imagePath: item.imagePath,
                prompt: item.prompt,
                title: r.title,
                videoId: r.videoId,
                savedFile: savedFile?.path || null,
                success: !!isOk,
                error: r.error || null,
                errorDetail: r.errorDetail || null,
                httpStatus: r.status,
            });

            await delay(200);
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
        workers.push(
            new Promise((resolve) => setTimeout(() => resolve(worker()), i * 200))
        );
    }
    await Promise.all(workers);

    return results;
}

module.exports = { batchGenI2VAxios, uploadFile };
