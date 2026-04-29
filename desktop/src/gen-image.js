const fs = require("fs");
const path = require("path");
const { API_URL, IMAGE_DIR, BATCH_SIZE } = require("./config");
const { delay } = require("./utils");

async function batchGenerate(page, prompts, accIdx, startIdx, statsigId) {
  const label = `Acc${accIdx + 1}`;
  const N = prompts.length;
  const CONCURRENCY = BATCH_SIZE;

  console.log(`[${label}] 🔄 ${N} prompts | ${CONCURRENCY} concurrent workers`);

  // Init tracker + worker pool in browser
  await page.evaluate(
    (n, apiUrl, promptList, concurrency, statsigIdParam) => {
      window.__imgs = Array.from({ length: n }, () => ({
        started: false,
        done: false,
        error: null,
        errorDetail: null,
        status: 0,
        title: "",
        imageUrls: [],
      }));

      let nextIdx = 0;

      async function genOne(idx) {
        const s = window.__imgs[idx];
        s.started = true;
        const msg = promptList[idx];
        const MAX_RETRIES = 3;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
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
                temporary: false,
                modelName: "grok-3",
                message: msg,
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
              }),
            });

            // Retry on 429
            if (res.status === 429 && attempt < MAX_RETRIES) {
              const wait = 10000 + Math.random() * 5000; // 10-15s
              s.error = `429 retry ${attempt + 1}/${MAX_RETRIES}`;
              await new Promise((r) => setTimeout(r, wait));
              continue;
            }

            s.status = res.status;
            const text = await res.text();
            const lines = text.split("\n").filter((l) => l.trim());

            // Collect error messages from the response
            const errorMessages = [];

            for (const line of lines) {
              try {
                const j = JSON.parse(line);
                if (j.result?.title?.newTitle)
                  s.title = j.result.title.newTitle;

                // Capture API-level error messages
                if (j.error) {
                  errorMessages.push(
                    typeof j.error === "string"
                      ? j.error
                      : j.error.message || JSON.stringify(j.error),
                  );
                }
                if (j.result?.error) {
                  errorMessages.push(
                    typeof j.result.error === "string"
                      ? j.result.error
                      : j.result.error.message || JSON.stringify(j.result.error),
                  );
                }

                // Capture model response errors (content policy, etc.)
                const mr = j.result?.response?.modelResponse;
                if (mr?.error) {
                  errorMessages.push(
                    typeof mr.error === "string"
                      ? mr.error
                      : mr.error.message || JSON.stringify(mr.error),
                  );
                }
                if (false && (mr?.isSoftBlock || mr?.isDisallowed)) {
                  errorMessages.push(
                    `Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`,
                  );
                }

                const ir = j.result?.response?.streamingImageGenerationResponse;
                if (ir && ir.progress === 100 && ir.imageUrl)
                  s.imageUrls.push({
                    imageUrl: ir.imageUrl,
                    imageIndex: ir.imageIndex,
                  });
                if (
                  mr?.generatedImageUrls?.length > 0 &&
                  s.imageUrls.length === 0
                )
                  mr.generatedImageUrls.forEach((u, i) =>
                    s.imageUrls.push({ imageUrl: u, imageIndex: i }),
                  );
              } catch (parseErr) {
                // Not valid JSON - capture raw line if it looks like an error
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
            if (s.imageUrls.length === 0) {
              if (res.status !== 200) {
                s.error = `HTTP ${res.status}`;
              } else if (errorMessages.length > 0) {
                s.error = errorMessages.join(" | ");
              } else {
                s.error = "no images returned";
              }
              // Save first 500 chars of raw response for debugging
              s.errorDetail = text.substring(0, 500);
            } else {
              s.error = null; // clear retry errors on success
            }
            s.done = true;
            return;
          } catch (err) {
            if (attempt < MAX_RETRIES) {
              s.error = `err retry ${attempt + 1}/${MAX_RETRIES}`;
              await new Promise((r) => setTimeout(r, 10000));
              continue;
            }
            s.error = err.message;
            s.done = true;
            return;
          }
        }
        s.done = true;
      }

      async function worker() {
        while (nextIdx < n) {
          const myIdx = nextIdx++;
          await genOne(myIdx);
          // 75ms between each request in this worker
          await new Promise((r) => setTimeout(r, 75));
        }
      }

      // Stagger worker starts by 75ms each
      for (let i = 0; i < Math.min(concurrency, n); i++) {
        setTimeout(() => worker(), i * 75);
      }
    },
    N,
    API_URL,
    prompts,
    CONCURRENCY,
    statsigId || "",
  );

  // Poll + download completed ones individually from Node
  const results = [];
  const processed = new Set();
  const MAX_WAIT = 10 * 60 * 1000;
  const start = Date.now();

  while (processed.size < N && Date.now() - start < MAX_WAIT) {
    await delay(2000);

    const states = await page.evaluate(() =>
      window.__imgs.map((s) => ({
        started: s.started,
        done: s.done,
        error: s.error,
        errorDetail: s.errorDetail,
        status: s.status,
        title: s.title,
        imageUrls: s.imageUrls,
      })),
    );

    for (let i = 0; i < N; i++) {
      if (processed.has(i)) continue;
      if (!states[i].done) continue;

      const globalIdx = startIdx + i;
      const r = states[i];
      const savedFiles = [];

      if (r.imageUrls.length > 0) {
        for (const img of r.imageUrls) {
          try {
            const dlResult = await page.evaluate(async (imageUrl) => {
              for (const base of [
                "https://assets.grok.com/",
                "https://grok.com/rest/app-chat/asset/",
              ]) {
                try {
                  const r = await fetch(base + imageUrl, {
                    credentials: "include",
                  });
                  if (r.ok) {
                    const buf = await (await r.blob()).arrayBuffer();
                    return {
                      data: Array.from(new Uint8Array(buf)),
                      size: buf.byteLength,
                      ct: r.headers.get("content-type"),
                    };
                  }
                } catch (_) { }
              }
              return null;
            }, img.imageUrl);

            if (dlResult) {
              const ext = dlResult.ct?.includes("png") ? "png" : "jpg";
              const filename = `a${accIdx + 1}_${globalIdx + 1}_i${img.imageIndex || 0}.${ext}`;
              const fp = path.join(IMAGE_DIR, filename);
              fs.writeFileSync(fp, Buffer.from(dlResult.data));
              savedFiles.push({ path: fp, size: dlResult.size });
            }
          } catch (e) { }
        }
      }

      const icon = savedFiles.length > 0 ? "✅" : "❌";
      const files =
        savedFiles.map((f) => `${(f.size / 1024).toFixed(0)}KB`).join("+") ||
        "-";
      if (savedFiles.length === 0 && r.error) {
        console.log(
          `[${label}] ❌ #${globalIdx + 1} | ${r.title || prompts[i].substring(0, 50)} | ${r.error.substring(0, 80)}`,
        );
      } else {
        console.log(
          `[${label}] ${icon} #${globalIdx + 1} | ${files} | ${r.title || prompts[i].substring(0, 50)}`,
        );
      }

      results.push({
        account: accIdx + 1,
        globalIndex: globalIdx + 1,
        prompt: prompts[i],
        title: r.title,
        savedFiles: savedFiles.map((f) => f.path),
        success: savedFiles.length > 0,
        error: r.error,
        errorDetail: r.errorDetail,
        httpStatus: r.status,
      });

      processed.add(i);
    }

    // Progress with correct counts
    const done = processed.size;
    const running = states.filter(
      (s, i) => s.started && !s.done && !processed.has(i),
    ).length;
    const queued = states.filter(
      (s, i) => !s.started && !processed.has(i),
    ).length;
    if (done < N) {
      console.log(
        `[${label}] ⏳ ${done}/${N} done | ${running} running | ${queued} queued`,
      );
    }
  }

  return results;
}

module.exports = { batchGenerate };
