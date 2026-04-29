const fs = require("fs");
const path = require("path");
const {
  API_URL,
  POST_CREATE_URL,
  VIDEO_DIR,
  VIDEO_CONFIG,
} = require("./config");
const { delay } = require("./utils");

async function batchGenVideos(page, prompts, accIdx, startIdx, statsigId) {
  const label = `Acc${accIdx + 1}`;
  const N = prompts.length;

  // Init array tracker
  await page.evaluate((n) => {
    window.__vps = Array.from({ length: n }, () => ({
      progress: 0,
      done: false,
      error: null,
      errorDetail: null,
      status: 0,
      title: "",
      videoUrl: null,
      videoId: null,
      videoData: null,
      postId: null,
    }));
  }, N);

  // Fire all: createPost + stream fetch in browser context
  await page.evaluate(
    (postUrl, apiUrl, promptList, videoConfig, statsigIdParam) => {
      const items = window.__vps;
      promptList.forEach((promptText, idx) => {
        const s = items[idx];
        (async () => {
          try {
            // Step 1: createPost
            const postRes = await fetch(postUrl, {
              method: "POST",
              credentials: "include",
              headers: { accept: "*/*", "content-type": "application/json" },
              body: JSON.stringify({
                mediaType: "MEDIA_POST_TYPE_VIDEO",
                prompt: promptText,
              }),
            });
            if (!postRes.ok) {
              const errBody = await postRes.text().catch(() => "");
              s.error = `createPost HTTP ${postRes.status}`;
              s.errorDetail = errBody.substring(0, 500);
              s.done = true;
              return;
            }
            const postData = await postRes.json();
            const parentPostId = postData.post?.id;
            if (!parentPostId) {
              s.error = "no postId";
              s.done = true;
              return;
            }
            s.postId = parentPostId;

            // Step 2: video gen stream
            const res = await fetch(apiUrl, {
              method: "POST",
              credentials: "include",
              headers: {
                accept: "*/*",
                "content-type": "application/json",
                "x-xai-request-id": crypto.randomUUID(),
                "x-statsig-id": statsigIdParam,
              },
              body: JSON.stringify({
                temporary: true,
                modelName: "grok-3",
                message: promptText + " --mode=custom",
                toolOverrides: { videoGen: true },
                enableSideBySide: true,
                responseMetadata: {
                  experiments: [],
                  modelConfigOverride: {
                    modelMap: {
                      videoGenModelConfig: {
                        parentPostId,
                        aspectRatio: videoConfig.aspectRatio,
                        videoLength: videoConfig.videoLength,
                        isVideoEdit: videoConfig.isVideoEdit,
                        resolutionName: videoConfig.resolutionName,
                      },
                    },
                  },
                },
              }),
            });
            s.status = res.status;
            if (!res.ok) {
              const errBody = await res.text().catch(() => "");
              s.error = `HTTP ${res.status}`;
              s.errorDetail = errBody.substring(0, 500);
              // Try to extract specific error message
              try {
                const errJson = JSON.parse(errBody);
                if (errJson.error?.message) s.error = `HTTP ${res.status}: ${errJson.error.message}`;
              } catch (_) { }
              s.done = true;
              return;
            }
            // Read stream
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            s._rawStream = ""; // capture on tracker so catch can access
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              buf += chunk;
              s._rawStream += chunk;
              const lines = buf.split("\n");
              buf = lines.pop();
              for (const l of lines) {
                if (!l.trim()) continue;
                try {
                  const j = JSON.parse(l);
                  if (j.result?.title?.newTitle)
                    s.title = j.result.title.newTitle;

                  // Capture API errors
                  if (j.error) {
                    const msg = typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error);
                    if (!s.error) s.error = msg;
                    s.errorDetail = (s.errorDetail || "") + msg + " | ";
                  }
                  if (j.result?.error) {
                    const msg = typeof j.result.error === "string" ? j.result.error : j.result.error.message || JSON.stringify(j.result.error);
                    if (!s.error) s.error = msg;
                    s.errorDetail = (s.errorDetail || "") + msg + " | ";
                  }

                  // Capture model response errors
                  const mr = j.result?.response?.modelResponse;
                  if (mr?.error) {
                    const msg = typeof mr.error === "string" ? mr.error : mr.error.message || JSON.stringify(mr.error);
                    if (!s.error) s.error = msg;
                    s.errorDetail = (s.errorDetail || "") + msg + " | ";
                  }
                  if (mr?.isSoftBlock || mr?.isDisallowed) {
                    const msg = `Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`;
                    if (!s.error) s.error = msg;
                    s.errorDetail = (s.errorDetail || "") + msg + " | ";
                  }

                  const vr =
                    j.result?.response?.streamingVideoGenerationResponse;
                  if (vr) {
                    s.progress = vr.progress || s.progress;
                    // Capture videoId/assetId whenever available
                    if (vr.videoId) s.videoId = vr.videoId;
                    if (vr.assetId) s.videoId = s.videoId || vr.assetId;
                    // Capture videoUrl whenever available (not just at progress=100)
                    if (vr.videoUrl) {
                      s.videoUrl = vr.videoUrl;
                    }
                    // Capture video gen specific errors
                    if (vr.error) {
                      const msg = typeof vr.error === "string" ? vr.error : vr.error.message || JSON.stringify(vr.error);
                      if (!s.error) s.error = msg;
                      s.errorDetail = (s.errorDetail || "") + msg + " | ";
                    }
                  }
                } catch (parseErr) {
                  if (
                    l.toLowerCase().includes("error") ||
                    l.toLowerCase().includes("block") ||
                    l.toLowerCase().includes("denied") ||
                    l.toLowerCase().includes("limit")
                  ) {
                    s.errorDetail = (s.errorDetail || "") + `[RAW] ${l.substring(0, 200)} | `;
                  }
                }
              }
            }
            if (buf.trim()) {
              try {
                const j = JSON.parse(buf);
                if (j.result?.title?.newTitle)
                  s.title = j.result.title.newTitle;
                const vr = j.result?.response?.streamingVideoGenerationResponse;
                if (vr) {
                  s.progress = vr.progress || s.progress;
                  if (vr.videoId) s.videoId = vr.videoId;
                  if (vr.assetId) s.videoId = s.videoId || vr.assetId;
                  if (vr.videoUrl) s.videoUrl = vr.videoUrl;
                }
              } catch (_) { }
            }
            // Fallback: use videoId as download key
            if (!s.videoUrl && s.videoId) {
              s.videoUrl = s.videoId;
            }
            // Mark no-video error if stream ended without video
            if (!s.videoUrl && !s.error) {
              s.error = `Video gen stopped at ${s.progress}% - no video URL returned`;
            }
            // Save raw stream for failed videos
            if (!s.videoUrl && !s.errorDetail) {
              s.errorDetail = s._rawStream.length > 1000
                ? "..." + s._rawStream.substring(s._rawStream.length - 1000)
                : s._rawStream;
            }
            s.done = true;
          } catch (e) {
            s.error = e.message;
            // Include partial raw stream in error detail
            const partial = s._rawStream
              ? `\n--- Partial stream (${s._rawStream.length} chars) ---\n` +
              (s._rawStream.length > 1000
                ? "..." + s._rawStream.substring(s._rawStream.length - 1000)
                : s._rawStream)
              : "";
            s.errorDetail = (e.stack || e.message) + partial;
            s.done = true;
          }
        })();
      });
    },
    POST_CREATE_URL,
    API_URL,
    prompts,
    VIDEO_CONFIG,
    statsigId || "",
  );

  // Poll all N items every 5s, max 5 min
  const MAX_WAIT = 5 * 60 * 1000;
  const start = Date.now();
  const lastProgs = new Array(N).fill(-1);

  while (Date.now() - start < MAX_WAIT) {
    await delay(5000);
    const states = await page.evaluate(() =>
      window.__vps.map((s) => ({
        p: s.progress,
        d: s.done,
        e: s.error,
        ed: s.errorDetail,
        t: s.title,
      })),
    );
    let allDone = true;
    for (let i = 0; i < N; i++) {
      if (states[i].p !== lastProgs[i]) {
        console.log(
          `[${label}]   #${startIdx + i + 1} ⏳ ${states[i].p}%${states[i].t ? ` | ${states[i].t.substring(0, 30)}` : ""}`,
        );
        lastProgs[i] = states[i].p;
      }
      if (!states[i].d) allDone = false;
    }
    if (allDone) break;
  }

  // Collect results (URLs only, no video data)
  const finalStates = await page.evaluate(() =>
    window.__vps.map((s) => ({
      status: s.status,
      title: s.title,
      videoId: s.videoId,
      videoUrl: s.videoUrl,
      lastProgress: s.progress,
      error: s.error,
      errorDetail: s.errorDetail,
      postId: s.postId,
      success: s.progress === 100 && !!s.videoUrl,
    })),
  );

  // Download each video individually from Node side
  const results = [];
  for (let i = 0; i < N; i++) {
    const r = finalStates[i];
    const globalIdx = startIdx + i;
    let savedFile = null;

    if (r.videoUrl) {
      console.log(`[${label}]   📥 Downloading #${globalIdx + 1}...`);
      try {
        const dlResult = await page.evaluate(async (videoUrl) => {
          for (const base of [
            "https://assets.grok.com/",
            "https://grok.com/rest/app-chat/asset/",
          ]) {
            try {
              const r = await fetch(base + videoUrl, {
                credentials: "include",
              });
              if (r.ok) {
                const ab = await (await r.blob()).arrayBuffer();
                return {
                  data: Array.from(new Uint8Array(ab)),
                  size: ab.byteLength,
                };
              }
            } catch (_) { }
          }
          return null;
        }, r.videoUrl);

        if (dlResult) {
          const filename = `a${accIdx + 1}_${globalIdx + 1}.mp4`;
          const fp = path.join(VIDEO_DIR, filename);
          fs.writeFileSync(fp, Buffer.from(dlResult.data));
          savedFile = { path: fp, size: dlResult.size };
        }
      } catch (e) {
        console.log(
          `[${label}]   ⚠️ Download failed #${globalIdx + 1}: ${e.message.substring(0, 80)}`,
        );
      }
    }

    const isOk = r.success && savedFile;
    if (isOk) {
      const sizeStr = `${(savedFile.size / 1024 / 1024).toFixed(1)}MB`;
      console.log(
        `[${label}] ✅ #${globalIdx + 1} | ${sizeStr} | ${r.lastProgress}% | ${r.title || prompts[i].substring(0, 50)}`,
      );
    } else {
      console.log(
        `[${label}] ❌ #${globalIdx + 1} | ${r.lastProgress}% | ${r.title || prompts[i].substring(0, 50)} | ${(r.error || "unknown").substring(0, 80)}`,
      );
    }

    results.push({
      account: accIdx + 1,
      globalIndex: globalIdx + 1,
      prompt: prompts[i],
      title: r.title,
      videoId: r.videoId,
      savedFile: savedFile?.path || null,
      success: !!isOk,
      error: r.error || null,
      errorDetail: r.errorDetail || null,
      httpStatus: r.status,
    });
  }
  return results;
}

module.exports = { batchGenVideos };
