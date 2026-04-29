const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { API_URL, POST_CREATE_URL, VIDEO_DIR, VIDEO_CONFIG, BATCH_SIZE } = require("./config");
const { delay } = require("./utils");

function formatCookies(cookies) {
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function buildHeaders(capturedHeaders, cookieStr) {
    const headers = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k.startsWith(":")) headers[k] = v;
    }
    headers["content-type"] = "application/json";
    headers["x-xai-request-id"] = crypto.randomUUID();
    headers["cookie"] = cookieStr;
    delete headers["host"];
    delete headers["content-length"];
    return headers;
}

async function createPost(prompt, capturedHeaders, cookieStr) {
    const res = await axios.post(
        POST_CREATE_URL,
        { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt },
        {
            headers: buildHeaders(capturedHeaders, cookieStr),
            validateStatus: () => true,
            timeout: 30000,
        }
    );
    if (res.status !== 200) {
        return { error: `createPost HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
    }
    const postId = res.data?.post?.id;
    if (!postId) {
        return { error: "no postId" };
    }
    return { postId };
}

function buildVideoBody(prompt, parentPostId) {
    return {
        temporary: true,
        modelName: "grok-3",
        message: prompt + " --mode=custom",
        toolOverrides: { videoGen: true },
        enableSideBySide: true,
        responseMetadata: {
            experiments: [],
            modelConfigOverride: {
                modelMap: {
                    videoGenModelConfig: {
                        parentPostId,
                        aspectRatio: VIDEO_CONFIG.aspectRatio,
                        videoLength: VIDEO_CONFIG.videoLength,
                        isVideoEdit: VIDEO_CONFIG.isVideoEdit,
                        resolutionName: VIDEO_CONFIG.resolutionName,
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
        console.log(`[genVideoAxios] Using videoId as download key: ${result.videoId}`);
    }

    if (!result.videoUrl && !result.error) {
        result.error = `Video gen stopped at ${result.progress}% - no video URL returned`;
    }
    return result;
}

async function downloadVideo(videoUrl, capturedHeaders, cookieStr) {
    const bases = [
        "https://assets.grok.com/",
        "https://grok.com/rest/app-chat/asset/",
    ];
    // Build download headers from captured (has sec-*, user-agent etc.)
    const dlHeaders = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k.startsWith(":")) dlHeaders[k] = v;
    }
    dlHeaders["cookie"] = cookieStr;
    delete dlHeaders["host"];
    delete dlHeaders["content-length"];
    delete dlHeaders["content-type"];

    for (const base of bases) {
        try {
            const res = await axios.get(base + videoUrl, {
                headers: dlHeaders,
                responseType: "arraybuffer",
                timeout: 120000,
                validateStatus: () => true,
            });
            if (res.status === 200) {
                return { data: Buffer.from(res.data), size: res.data.byteLength };
            }
            console.log(`    ⚠️ Download ${base} → HTTP ${res.status}`);
        } catch (e) {
            console.log(`    ⚠️ Download ${base} → ${e.message.substring(0, 60)}`);
        }
    }
    return null;
}

async function genOneVideo(prompt, globalIdx, capturedHeaders, cookieStr, label) {
    // Step 1: createPost
    const post = await createPost(prompt, capturedHeaders, cookieStr);
    if (post.error) {
        return { ...post, title: "", videoUrl: null, videoId: null, progress: 0, status: 0 };
    }

    // Step 2: video gen stream
    try {
        const res = await axios.post(API_URL, buildVideoBody(prompt, post.postId), {
            headers: buildHeaders(capturedHeaders, cookieStr),
            responseType: "text",
            validateStatus: () => true,
            timeout: 300000, // 5 min for video gen
        });

        if (res.status !== 200) {
            return {
                title: "",
                videoUrl: null,
                videoId: null,
                progress: 0,
                error: `HTTP ${res.status}`,
                errorDetail: (typeof res.data === "string" ? res.data : JSON.stringify(res.data)).substring(0, 500),
                status: res.status,
            };
        }

        const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        const parsed = parseStreamResponse(text);
        parsed.status = res.status;
        parsed.postId = post.postId;
        if (!parsed.videoUrl && !parsed.errorDetail) {
            parsed.errorDetail = text.length > 1000 ? "..." + text.substring(text.length - 1000) : text;
        }
        return parsed;
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

async function batchGenVideosAxios(prompts, accIdx, startIdx, capturedHeaders, cookies) {
    const label = `Acc${accIdx + 1}`;
    const N = prompts.length;
    const CONCURRENCY = BATCH_SIZE;
    const cookieStr = formatCookies(cookies);

    console.log(`[${label}] 🎬 ${N} video prompts | ${CONCURRENCY} concurrent (axios)`);

    const results = [];
    let nextIdx = 0;

    async function worker() {
        while (nextIdx < N) {
            const myIdx = nextIdx++;
            const globalIdx = startIdx + myIdx;
            const prompt = prompts[myIdx];

            console.log(`[${label}]   🎬 #${globalIdx + 1} starting...`);
            const r = await genOneVideo(prompt, globalIdx, capturedHeaders, cookieStr, label);

            // Download video
            let savedFile = null;
            if (r.videoUrl) {
                console.log(`[${label}]   📥 Downloading #${globalIdx + 1}... (url: ${r.videoUrl.substring(0, 40)})`);
                try {
                    const dl = await downloadVideo(r.videoUrl, capturedHeaders, cookieStr);
                    if (dl) {
                        const filename = `a${accIdx + 1}_${globalIdx + 1}.mp4`;
                        const fp = path.join(VIDEO_DIR, filename);
                        fs.writeFileSync(fp, dl.data);
                        savedFile = { path: fp, size: dl.size };
                    }
                } catch (e) {
                    console.log(`[${label}]   ⚠️ Download failed #${globalIdx + 1}: ${e.message.substring(0, 80)}`);
                }
            }

            const isOk = r.videoUrl && savedFile;
            if (isOk) {
                const sizeStr = `${(savedFile.size / 1024 / 1024).toFixed(1)}MB`;
                console.log(
                    `[${label}] ✅ #${globalIdx + 1} | ${sizeStr} | ${r.title || prompt.substring(0, 50)}`
                );
            } else {
                const errMsg = r.error || (r.videoUrl ? "download failed" : "unknown");
                console.log(
                    `[${label}] ❌ #${globalIdx + 1} | ${r.progress}% | ${r.title || prompt.substring(0, 50)} | ${(r.error || "unknown").substring(0, 80)}`
                );
            }

            results.push({
                account: accIdx + 1,
                globalIndex: globalIdx + 1,
                prompt,
                title: r.title,
                videoId: r.videoId,
                savedFile: savedFile?.path || null,
                success: !!isOk,
                error: r.error || null,
                errorDetail: r.errorDetail || null,
                httpStatus: r.status,
            });

            await delay(75);
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
        workers.push(
            new Promise((resolve) => setTimeout(() => resolve(worker()), i * 75))
        );
    }
    await Promise.all(workers);

    return results;
}

module.exports = { batchGenVideosAxios };
