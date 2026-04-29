const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { API_URL, IMAGE_DIR, BATCH_SIZE } = require("./config");
const { delay } = require("./utils");

function formatCookies(cookies) {
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function buildHeaders(capturedHeaders, cookieStr) {
    // Start with all headers captured from browser (sec-*, accept-language, etc.)
    // Filter out HTTP/2 pseudo-headers (e.g. :authority, :method, :path, :scheme)
    const headers = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k.startsWith(":")) headers[k] = v;
    }

    // Override per-request fields
    headers["content-type"] = "application/json";
    headers["x-xai-request-id"] = crypto.randomUUID();
    headers["cookie"] = cookieStr;

    // Remove headers that shouldn't be forwarded
    delete headers["host"];
    delete headers["content-length"];

    return headers;
}

function buildBody(prompt) {
    return {
        temporary: false,
        modelName: "grok-3",
        message: prompt,
        fileAttachments: [],
        imageAttachments: [],
        disableSearch: false,
        enableImageGeneration: true,
        returnImageBytes: false,
        returnRawGrokInXaiRequest: false,
        enableImageStreaming: true,
        imageGenerationCount: 2,
        forceConcise: false,
        toolOverrides: {},
        enableSideBySide: true,
        sendFinalMetadata: true,
        isReasoning: false,
        disableTextFollowUps: false,
        responseMetadata: {
            requestModelDetails: { modelId: "grok-3" },
        },
        disableMemory: false,
        forceSideBySide: false,
        modelMode: "MODEL_MODE_EXPERT",
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

async function genOne(prompt, idx, capturedHeaders, cookieStr, label) {
    const MAX_RETRIES = 3;
    const result = {
        title: "",
        imageUrls: [],
        error: null,
        errorDetail: null,
        status: 0,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await axios.post(API_URL, buildBody(prompt), {
                headers: buildHeaders(capturedHeaders, cookieStr),
                responseType: "text",
                validateStatus: () => true, // don't throw on non-2xx
                timeout: 120000,
            });

            // Retry on 429
            if (res.status === 429 && attempt < MAX_RETRIES) {
                const wait = 10000 + Math.random() * 5000;
                console.log(`[${label}]   ⏳ #${idx + 1} 429 retry ${attempt + 1}/${MAX_RETRIES}`);
                await delay(wait);
                continue;
            }

            result.status = res.status;
            const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
            const lines = text.split("\n").filter((l) => l.trim());
            const errorMessages = [];

            for (const line of lines) {
                try {
                    const j = JSON.parse(line);
                    if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

                    // Capture errors
                    if (j.error) {
                        errorMessages.push(
                            typeof j.error === "string"
                                ? j.error
                                : j.error.message || JSON.stringify(j.error)
                        );
                    }
                    if (j.result?.error) {
                        errorMessages.push(
                            typeof j.result.error === "string"
                                ? j.result.error
                                : j.result.error.message || JSON.stringify(j.result.error)
                        );
                    }

                    const mr = j.result?.response?.modelResponse;
                    if (mr?.error) {
                        errorMessages.push(
                            typeof mr.error === "string"
                                ? mr.error
                                : mr.error.message || JSON.stringify(mr.error)
                        );
                    }
                    if (false && (mr?.isSoftBlock || mr?.isDisallowed)) {
                        errorMessages.push(
                            `Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`
                        );
                    }

                    // Collect image URLs
                    const ir = j.result?.response?.streamingImageGenerationResponse;
                    if (ir && ir.progress === 100 && ir.imageUrl) {
                        result.imageUrls.push({ imageUrl: ir.imageUrl, imageIndex: ir.imageIndex });
                    }
                    if (mr?.generatedImageUrls?.length > 0 && result.imageUrls.length === 0) {
                        mr.generatedImageUrls.forEach((u, i) =>
                            result.imageUrls.push({ imageUrl: u, imageIndex: i })
                        );
                    }
                } catch (parseErr) {
                    if (
                        line.toLowerCase().includes("error") ||
                        line.toLowerCase().includes("block") ||
                        line.toLowerCase().includes("denied") ||
                        line.toLowerCase().includes("limit")
                    ) {
                        errorMessages.push(`[RAW] ${line.substring(0, 200)}`);
                    }
                }
            }

            if (result.imageUrls.length === 0) {
                if (res.status !== 200) {
                    result.error = `HTTP ${res.status}`;
                } else if (errorMessages.length > 0) {
                    result.error = errorMessages.join(" | ");
                } else {
                    result.error = "no images returned";
                }
                result.errorDetail = text.substring(0, 500);
            }
            return result;
        } catch (err) {
            if (attempt < MAX_RETRIES) {
                console.log(`[${label}]   ⏳ #${idx + 1} err retry ${attempt + 1}/${MAX_RETRIES}`);
                await delay(10000);
                continue;
            }
            result.error = err.message;
            return result;
        }
    }
    return result;
}

async function downloadImage(imageUrl, capturedHeaders, cookieStr) {
    const bases = [
        "https://assets.grok.com/",
        "https://grok.com/rest/app-chat/asset/",
    ];
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
            const res = await axios.get(base + imageUrl, {
                headers: dlHeaders,
                responseType: "arraybuffer",
                timeout: 30000,
                validateStatus: () => true,
            });
            if (res.status === 200) {
                return {
                    data: Buffer.from(res.data),
                    size: res.data.byteLength,
                    ct: res.headers["content-type"],
                };
            }
        } catch (_) { }
    }
    return null;
}

async function batchGenerateAxios(prompts, accIdx, startIdx, capturedHeaders, cookies) {
    const label = `Acc${accIdx + 1}`;
    const N = prompts.length;
    const CONCURRENCY = BATCH_SIZE;
    const cookieStr = formatCookies(cookies);

    console.log(`[${label}] 🔄 ${N} prompts | ${CONCURRENCY} concurrent (axios)`);

    const results = [];
    let nextIdx = 0;

    async function worker() {
        while (nextIdx < N) {
            const myIdx = nextIdx++;
            const globalIdx = startIdx + myIdx;
            const prompt = prompts[myIdx];

            const r = await genOne(prompt, globalIdx, capturedHeaders, cookieStr, label);

            // Download images
            const savedFiles = [];
            if (r.imageUrls.length > 0) {
                for (const img of r.imageUrls) {
                    try {
                        const dl = await downloadImage(img.imageUrl, capturedHeaders, cookieStr);
                        if (dl) {
                            const ext = dl.ct?.includes("png") ? "png" : "jpg";
                            const filename = `a${accIdx + 1}_${globalIdx + 1}_i${img.imageIndex || 0}.${ext}`;
                            const fp = path.join(IMAGE_DIR, filename);
                            fs.writeFileSync(fp, dl.data);
                            savedFiles.push({ path: fp, size: dl.size });
                        }
                    } catch (_) { }
                }
            }

            const icon = savedFiles.length > 0 ? "✅" : "❌";
            const files =
                savedFiles.map((f) => `${(f.size / 1024).toFixed(0)}KB`).join("+") || "-";
            if (savedFiles.length === 0 && r.error) {
                console.log(
                    `[${label}] ❌ #${globalIdx + 1} | ${r.title || prompt.substring(0, 50)} | ${r.error.substring(0, 80)}`
                );
            } else {
                console.log(
                    `[${label}] ${icon} #${globalIdx + 1} | ${files} | ${r.title || prompt.substring(0, 50)}`
                );
            }

            results.push({
                account: accIdx + 1,
                globalIndex: globalIdx + 1,
                prompt,
                title: r.title,
                savedFiles: savedFiles.map((f) => f.path),
                success: savedFiles.length > 0,
                error: r.error,
                errorDetail: r.errorDetail,
                httpStatus: r.status,
            });

            // Small delay between requests in this worker
            await delay(75);
        }
    }

    // Launch workers with staggered starts
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
        workers.push(
            new Promise((resolve) => setTimeout(() => resolve(worker()), i * 75))
        );
    }
    await Promise.all(workers);

    return results;
}

module.exports = { batchGenerateAxios };
