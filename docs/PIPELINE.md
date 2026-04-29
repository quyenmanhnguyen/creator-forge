# Pipeline: research → finished video

This is the **happy path** the tool is designed around. Everything else (single-shot image generation, ad-hoc keyword lookup, etc.) is just an entry point into one of the stages below.

## Stage 0 — Pick a niche

You start with a **seed string**. It can be:

- a topic ("sleep stories for adults")
- a vibe ("cozy autumn aesthetic")
- a competitor's channel name
- a single existing YouTube URL you want to clone

## Stage 1 — Research (sidecar)

| Tool | Route | Backed by |
| --- | --- | --- |
| Niche Finder | `POST /research/niche` | `core.trends`, `core.youtube.search_top_channels`, `core.outliers.find_breakouts`, `core.llm.niche_verdict` |
| Keyword Finder | `POST /research/keywords` | `core.autocomplete`, `core.keywords.score`, `core.youtube.vph_for_results` |
| Outlier Finder | `POST /research/outlier` | `core.outliers` |
| Video Cloner | `POST /research/cloner` | `core.transcript`, `core.transcript_ytdlp`, `core.lang_detect`, `core.llm.clone_kit` |

**Output that flows downstream**: a `topic` string + an optional `clone_kit` (hook, structure, title clones) that can prefill Studio.

## Stage 2 — Studio: topic → script (sidecar)

5-step LLM chain on DeepSeek (mirrors `pages/04_Studio.py`):

| Step | Route | What you get |
| --- | --- | --- |
| ① Topics | `POST /studio/topics` | 20 topic ideas |
| ② Titles | `POST /studio/titles` | 10 titles, top 3 marked as high-CTR |
| ③ Outline | `POST /studio/outline` | 8-part outline: Hook · Empathy · Problem 1 · Small Change · Story · Problems 2&3 · Reflection · CTA |
| ④ Script | `POST /studio/script` | full long-form script, chunked, up to ~24,000 chars |
| ⑤ Humanize | `POST /studio/humanize` | rewrite the script in a warmer / more conversational tone |

State is held in the renderer between steps; each call is stateless.

## Stage 3 — Storyboard (sidecar)

```
                          script.md (Stage 2 output)
                                  │
                                  ▼
                  POST /producer/scene_breakdown
              (core.pixelle.scene_breakdown.generate_scene_breakdown)
                                  │
                                  ▼
            ┌─────────────────────────────────────────┐
            │  scenes: [                              │
            │    {                                    │
            │      scene_id: "s01",                   │
            │      duration_s: 6,                     │
            │      image_prompt: "ultra-detailed …",  │
            │      negative_prompt: "blurry, …",      │
            │      video_prompt: "slow dolly forward, …",│
            │      style: { preset: "negative_film" } │
            │    },                                   │
            │    ...                                  │
            │  ]                                      │
            └─────────────────────────────────────────┘
```

The sidecar also exposes `POST /producer/thumbnail_prompt` to generate a single thumbnail prompt for the same script.

## Stage 4 — Generation (desktop)

`StoryboardBridge` takes the scene list and pipes it into the **existing autogrok-veo3 services** running in the Electron main process. We do **not** call Grok from the sidecar — the Electron services already have:

- Puppeteer-based auth + session
- Account rotation (`AccountService`)
- Batch + concurrency control (`PROCESSING_CONFIG.CONCURRENCY`)
- Retries with backoff
- Local file save under `{userData}/output/...`

| Per-scene step | Service | Channel |
| --- | --- | --- |
| Generate hero image (×4 by default) | `ImageService.generateBatch` | `image:generate` |
| Generate ref/style image | `RefImageService.generate` | `refimg:generate` |
| Animate hero image into 5–20 s clip | `I2VService.generate` | `i2v:generate` |
| Long-form Veo 3 generation | `VideoService.generate` | `video:generate` |

After this stage each scene gains a `hero_image_path` and (optionally) a `clip_path`.

## Stage 5 — Producer: compose final video (sidecar)

```
        scenes (with hero_image_path + clip_path)        script.md
                          │                                   │
                          └────────────┬──────────────────────┘
                                       │
                                       ▼
                          POST /producer/short
                       (core.pixelle.composer.make_short)
                                       │
       ┌───────────────────────────────┼────────────────────────────────┐
       ▼                               ▼                                ▼
  EdgeTTSAdapter                 subtitles.py                    moviepy / ffmpeg
  (narration)                    (word-boundary captions)         (composite mp4)
       │                               │                                │
       └───────────────────────────────┴────────────────────────────────┘
                                       │
                                       ▼
                              final.mp4 (9:16 or 16:9)
```

Long-form mode (45 s short → 10–30 min long video) is the same wiring with different scene counts and a different template, both already supported by `core.pixelle.scene_breakdown` (PR-A4.1 in the original tube-atlas).

## Stage 6 — Publish (out of scope)

Upload to YouTube is **not** part of v0.1. The final mp4 plus the script / title / thumbnail prompt are written to `{userData}/output/{slug}/` for the user to upload manually.

## End-to-end example call sequence

```
01. POST /research/niche               { seed }                       → topic, channels, outliers
02. POST /research/keywords            { seed }                        → longtail, KGR
03. POST /studio/topics                { seed }                        → 20 topics
04. POST /studio/titles                { topic }                       → 10 titles
05. POST /studio/outline               { title }                       → 8 sections
06. POST /studio/script                { title, outline }              → script.md
07. POST /studio/humanize              { script }                      → script_final.md
08. POST /producer/scene_breakdown     { script, count: 12 }           → scenes[]
09. POST /producer/thumbnail_prompt    { title, style }                → thumb_prompt
10. ipc  image:generate                { prompts: scenes }             → hero_image_path[] (Grok)
11. ipc  i2v:generate                  { jobs: scenes }                → clip_path[]      (Grok)
12. POST /producer/short               { script, scenes, voice }       → final.mp4
```

Steps 10–11 happen entirely inside the Electron desktop services; everything else is a sidecar HTTP call.
