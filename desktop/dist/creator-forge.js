/**
 * creator-forge.js — vanilla renderer logic for the Electron Creator Forge UI.
 *
 * Talks to the Python FastAPI sidecar via `window.electronAPI.{research,studio,
 * storyboard,producer}` (defined in desktop/electron/preload.js, dispatched in
 * desktop/electron/researchIPC.js). Each handler:
 *   1. reads form values
 *   2. shows a loading spinner
 *   3. invokes the IPC method
 *   4. renders results + warnings, or a friendly error if the sidecar is down
 *
 * State is kept in a single in-memory `state` object so the Studio wizard can
 * carry topic → title → outline → script → scene_breakdown forward without
 * round-tripping through the user.
 */

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const api = (window.electronAPI && window.electronAPI.research)
        ? window.electronAPI
        : null;

    /** In-memory wizard state (topics → titles → outline → script). */
    const state = {
        lastTopic: '',
        lastTitle: '',
        lastOutlineParts: null,   // array of {part, role, emotion, expansion}
        lastScript: '',
        // HF-16 — humanized output from /studio/humanize. Sent to the
        // Storyboard panel preferentially when "Send script → Storyboard"
        // fires, since the user humanizes specifically to remove
        // LLM-detection markers before breaking into scenes.
        lastHumanizedScript: '',
        // Latest scene_breakdown — captured so "Compose with AutoGrok"
        // (PR-16) can pick up scenes without re-running the LLM.
        lastScenes: [],
        lastSceneScript: '',
        // PR-27 — Visual DNA style anchor most recently returned by
        // /producer/scene_breakdown (or edited by the user). Re-roll
        // and the next scene_breakdown call both read from here so a
        // user override persists across runs without re-typing.
        lastVisualDna: '',
        // PR-27 — value of ``images_per_scene`` carried into the last
        // scene_breakdown / variantPrompts call. Tracked separately
        // from the DOM select so re-roll always agrees with the
        // current Batch panel setting (which the user may bump
        // mid-session).
        lastImagesPerScene: 4,
        // HF-12 — sum of per-scene ``duration_s`` from the last
        // scene_breakdown response. Compose audio + Refine script
        // fall back to this value when no Video batch rows have
        // settled yet, so the SRT can scale to the planned total
        // before the user burns Grok credits on Image / Video
        // batches. ``0`` means no scene_breakdown ran yet.
        lastScenesTotalDuration: 0,
    };

    // ─── Tabs ──────────────────────────────────────────────────────────────
    function setupTabs() {
        $$('nav.tabs button').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
                $$('.tab-content').forEach((c) => {
                    c.classList.toggle('active', c.id === `tab-${tab}`);
                });
            });
        });
    }

    // ─── Sidecar status indicator ──────────────────────────────────────────
    // Track whether the sidecar has ever been ready so we can distinguish
    // "still booting" (cold start, first ~5–30s) from "went down later".
    let sidecarHasBeenReady = false;

    // ─── API keys modal ────────────────────────────────────────────────
    // Persistent store at app.getPath('userData')/api-keys.json driven by
    // the keys:get / keys:save IPC channels (preload.js → main.js →
    // electron/keysStore.js). The renderer treats the stored values as
    // opaque — it never logs them and never echoes them back over IPC
    // unless the user explicitly hits Save.
    //
    // UX:
    //   - ⚙ button in the header opens the modal at any time.
    //   - Closing via × / backdrop / Cancel / Esc discards edits.
    //   - On first launch with no keys saved, the modal auto-opens so
    //     end-users running a packaged build don't need a .env file.
    //   - Save persists, kicks the sidecar, and refreshes the pill so
    //     the user sees `sidecar ready` come back within a few seconds.
    const KEY_INPUT_IDS = {
        DEEPSEEK_API_KEY: 'key-deepseek',
        YOUTUBE_API_KEY: 'key-youtube',
        GOOGLE_API_KEY: 'key-google',
        RUNNINGHUB_API_KEY: 'key-runninghub',
        ELEVENLABS_API_KEY: 'key-elevenlabs',
    };

    function setKeysStatus(text, level) {
        const el = $('cf-keys-status');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('ok', 'err');
        if (level) el.classList.add(level);
    }

    function openApiKeysModal() {
        const modal = $('api-keys-modal');
        if (!modal) return;
        modal.hidden = false;
        // Focus the first empty input so keyboard users can start typing
        // straight away (helpful on first launch when all fields blank).
        const firstEmpty = Object.values(KEY_INPUT_IDS)
            .map((id) => $(id))
            .find((el) => el && !el.value);
        if (firstEmpty && typeof firstEmpty.focus === 'function') {
            try { firstEmpty.focus(); } catch (_) { /* jsdom safety */ }
        }
    }

    function closeApiKeysModal() {
        const modal = $('api-keys-modal');
        if (modal) modal.hidden = true;
    }

    async function loadApiKeysIntoForm() {
        if (!api || !api.keys || typeof api.keys.get !== 'function') return { keys: {} };
        try {
            const resp = await api.keys.get();
            const keys = (resp && resp.keys && typeof resp.keys === 'object') ? resp.keys : {};
            for (const [envName, inputId] of Object.entries(KEY_INPUT_IDS)) {
                const el = $(inputId);
                if (!el) continue;
                el.value = typeof keys[envName] === 'string' ? keys[envName] : '';
            }
            return { keys };
        } catch (_) {
            return { keys: {} };
        }
    }

    async function saveApiKeysFromForm() {
        if (!api || !api.keys || typeof api.keys.save !== 'function') {
            setKeysStatus('electronAPI.keys not available', 'err');
            return;
        }
        const payload = {};
        for (const [envName, inputId] of Object.entries(KEY_INPUT_IDS)) {
            const el = $(inputId);
            if (!el) continue;
            const v = (el.value || '').trim();
            if (v) payload[envName] = v;
        }
        const saveBtn = $('cf-keys-save');
        if (saveBtn) saveBtn.disabled = true;
        setKeysStatus('Saving + restarting sidecar...');
        try {
            const resp = await api.keys.save(payload);
            if (!resp || resp.ok !== true) {
                setKeysStatus('Save failed: ' + ((resp && resp.error) || 'unknown'), 'err');
                return;
            }
            if (resp.restarted === false) {
                setKeysStatus(
                    'Keys saved, sidecar restart failed: ' + (resp.restartError || 'unknown'),
                    'err',
                );
            } else {
                setKeysStatus('Saved. Sidecar restarted.', 'ok');
            }
            // Bounce the pill so the user sees the "starting sidecar..."
            // → "sidecar ready" transition matching the actual restart.
            refreshSidecarStatus();
            // Auto-close after a short pause so users can read the status.
            setTimeout(() => {
                if ($('cf-keys-status')?.classList.contains('ok')) closeApiKeysModal();
            }, 900);
        } catch (err) {
            setKeysStatus('Save error: ' + (err && err.message ? err.message : String(err)), 'err');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function setupApiKeysModal() {
        const modal = $('api-keys-modal');
        if (!modal) return;
        const openBtn = $('api-keys-btn');
        if (openBtn) openBtn.addEventListener('click', openApiKeysModal);
        // Delegated close handlers — × button, backdrop, Cancel button.
        modal.addEventListener('click', (e) => {
            const target = e.target;
            if (target && target.dataset && target.dataset.closeModal === 'api-keys-modal') {
                closeApiKeysModal();
            }
        });
        // Esc key closes the modal when it's open.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.hidden) closeApiKeysModal();
        });
        const saveBtn = $('cf-keys-save');
        if (saveBtn) saveBtn.addEventListener('click', saveApiKeysFromForm);
    }

    async function refreshSidecarStatus() {
        const dot = $('sidecar-dot');
        const label = $('sidecar-label');
        if (!api) {
            dot.classList.remove('ok'); dot.classList.add('err');
            label.textContent = 'electronAPI not exposed (preload missing)';
            return;
        }
        // Use a known cheap endpoint. /producer/voices is GET and returns
        // immediately even when no key is configured. While the sidecar is
        // still booting, researchIPC.js returns { ready: false } as a soft
        // sentinel instead of throwing, so we don't pollute the main log.
        try {
            const resp = await api.producer.listVoices();
            if (resp && resp.ready === false) {
                dot.classList.remove('ok'); dot.classList.add('err');
                label.textContent = 'starting sidecar...';
                return;
            }
            sidecarHasBeenReady = true;
            dot.classList.remove('err'); dot.classList.add('ok');
            label.textContent = 'sidecar ready';
        } catch (err) {
            dot.classList.remove('ok'); dot.classList.add('err');
            label.textContent = sidecarHasBeenReady
                ? 'sidecar not reachable — check `npm run dev`'
                : 'starting sidecar...';
        }
    }

    // ─── Render helpers ────────────────────────────────────────────────────
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function showLoading(targetId, label = 'Working...') {
        const target = $(targetId);
        if (!target) return;
        target.innerHTML = `<div class="loading"><span class="spinner"></span>${escapeHtml(label)}</div>`;
        // PR-46 — scroll the just-painted result panel into view so
        // the user can see the spinner / output without manually
        // scrolling past the form they just submitted. Used by every
        // panel (Studio wizard steps, Research niche/keywords/outlier,
        // Cloner) since they all funnel through this helper. The
        // scroll is gated on ``scrollIntoView`` existing — jsdom and
        // very old WebViews lack it — and on the target not already
        // being visible, so it's a no-op for short forms whose
        // result is already in the viewport.
        scrollResultIntoView(target);
    }

    /**
     * PR-A — richer loading variant for long-running LLM endpoints.
     * Returns a controller with ``stop()`` so the caller can tear the
     * timer down once the IPC settles (success or error). The caller
     * is responsible for replacing the panel's innerHTML afterwards;
     * stopping just halts the interval.
     *
     *   const ctl = showProgress('sb-result', 'Breaking script...', PHASES,
     *                            { hint: 'usually 30-90s' });
     *   try { ... } finally { ctl.stop(); }
     *
     * If the progress helpers module isn't loaded (renderer running
     * outside the bundled HTML, e.g. a stripped-down test harness)
     * we transparently fall back to ``showLoading`` so callers don't
     * have to feature-detect.
     */
    function showProgress(targetId, label, phases, opts = {}) {
        const target = $(targetId);
        if (!target) return { stop: function () {} };
        const helpers = (typeof window !== 'undefined' && window.StoryboardProgressHelpers) || null;
        if (!helpers) {
            showLoading(targetId, label || 'Working...');
            return { stop: function () {} };
        }
        const phaseList = Array.isArray(phases) && phases.length
            ? phases
            : helpers.DEFAULT_SCENE_BREAKDOWN_PHASES;
        const startedAt = Date.now();
        const hint = (opts && typeof opts.hint === 'string') ? opts.hint : '';

        const repaint = () => {
            const elapsed = Date.now() - startedAt;
            target.innerHTML = helpers.buildProgressHtml({
                label: label || 'Working...',
                phaseText: helpers.selectPhaseLabel(phaseList, elapsed),
                elapsedText: helpers.formatElapsed(elapsed),
                // The hint only kicks in once the user has been
                // staring at the spinner for >3s — this avoids
                // flashing it on snappy responses (sub-second).
                hint: elapsed >= 3000 ? hint : '',
            });
        };

        repaint();
        scrollResultIntoView(target);
        const intervalId = setInterval(repaint, 1000);
        return {
            stop: function () {
                clearInterval(intervalId);
            },
        };
    }

    /**
     * PR-46 — scroll a freshly painted result panel into view if
     * it isn't already visible. Smooth-scrolls to the start of the
     * panel so the user sees the spinner / first lines of output
     * rather than the bottom edge. Defensive against missing DOM
     * APIs (jsdom) and against panels that are already in view
     * (no-op when the top edge is already on-screen).
     */
    function scrollResultIntoView(target) {
        if (!target || typeof target.getBoundingClientRect !== 'function') return;
        if (typeof target.scrollIntoView !== 'function') return;
        const rect = target.getBoundingClientRect();
        const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
        // Already fully visible (top in viewport, bottom not far off)
        // — skip the scroll so we don't fight the user's own scroll.
        if (rect.top >= 0 && rect.top < viewportH * 0.66) return;
        try {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (_) {
            // older WebViews: fallback to instant scroll.
            try { target.scrollIntoView(); } catch (__) { /* ignore */ }
        }
    }

    function showError(targetId, err) {
        const status = err && err.status ? err.status : '';
        const body = err && err.body ? err.body : null;
        let detail = err && err.message ? err.message : String(err);
        if (body && typeof body === 'object') {
            try { detail = JSON.stringify(body, null, 2); } catch (_) { /* ignore */ }
        }
        const friendly =
            !api
                ? 'electronAPI is not available. Are you running Electron (npm run dev) rather than opening the HTML file directly?'
                : status === 422
                    ? 'Bad request (422). Check that required fields are filled and not whitespace-only.'
                    : status === 500
                        ? 'Sidecar returned 500. Check sidecar logs (research/api).'
                        : 'Something went wrong. The sidecar may be down or missing API keys.';
        $(targetId).innerHTML = `
            <div class="error-box"><b>Error ${escapeHtml(status)}</b> — ${escapeHtml(friendly)}\n\n${escapeHtml(detail)}</div>
        `;
    }

    function renderWarnings(warnings) {
        if (!warnings || !warnings.length) return '';
        const items = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
        return `
            <div class="warning-list">
                <div class="warning-title">Warnings (${warnings.length})</div>
                <ul>${items}</ul>
            </div>
        `;
    }

    function renderRawJson(obj) {
        let text;
        try { text = JSON.stringify(obj, null, 2); } catch (_) { text = String(obj); }
        return `
            <details>
                <summary>Raw JSON</summary>
                <pre>${escapeHtml(text)}</pre>
            </details>
        `;
    }

    function renderEmpty(msg) {
        return `<div class="empty">${escapeHtml(msg)}</div>`;
    }

    // ─── Field readers ─────────────────────────────────────────────────────
    function asBool(v) { return v === 'true' || v === true; }
    function asInt(v, fallback) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : fallback;
    }
    function asFloat(v, fallback) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }
    function asNonEmpty(v) {
        const s = (v == null ? '' : String(v)).trim();
        return s.length ? s : null;
    }

    // ─── Research: niche ───────────────────────────────────────────────────
    async function runNiche() {
        const seed = asNonEmpty($('niche-seed').value);
        if (!seed) {
            showError('niche-result', { status: 422, message: 'Seed cannot be empty.' });
            return;
        }
        const params = {
            seed,
            region: asNonEmpty($('niche-region').value) || 'US',
            language: $('niche-language').value || 'en',
            include_trends: asBool($('niche-trends').value),
            include_verdict: asBool($('niche-verdict').value),
            max_top_videos: asInt($('niche-max-top').value, 25),
        };
        showLoading('niche-result', 'Researching niche (this can take 10-30s)...');
        try {
            const data = await api.research.searchNiche(params);
            renderNiche(data);
        } catch (err) {
            showError('niche-result', err);
        }
    }

    function renderNiche(data) {
        const v = data && data.verdict;
        const top = (data && data.top_videos) || [];
        const outliers = (data && data.outliers) || [];
        const opp = data && data.opportunity_score;

        let html = '';
        if (v) {
            html += `
                <div class="card">
                    <strong>DeepSeek verdict</strong>
                    <div>Score: <b>${escapeHtml(v.score)}</b> — Grade: <b>${escapeHtml(v.grade || '')}</b></div>
                    <div class="meta">${escapeHtml(v.summary || '')}</div>
                </div>
            `;
        }
        if (opp != null) {
            html += `<div class="stats-row"><span>Opportunity score<b>${escapeHtml(opp)}</b></span>`;
            if (data.top_video_views != null) html += `<span>Top video views<b>${escapeHtml(data.top_video_views)}</b></span>`;
            if (data.avg_views_top != null) html += `<span>Avg top views<b>${escapeHtml(Math.round(data.avg_views_top))}</b></span>`;
            html += `</div>`;
        }
        if (top.length) {
            html += `<h3 style="margin:14px 0 6px;font-size:13px;color:var(--text-dim)">Top videos (${top.length})</h3><div class="cards">`;
            html += top.slice(0, 12).map((t) => `
                <div class="card">
                    <strong>${escapeHtml(t.title || '(no title)')}</strong>
                    <div class="meta">
                        ${escapeHtml(t.channel_title || '')} · ${escapeHtml(t.views || 0)} views
                    </div>
                    ${t.url ? `<div class="meta"><a href="${escapeHtml(t.url)}" target="_blank">${escapeHtml(t.url)}</a></div>` : ''}
                </div>
            `).join('');
            html += `</div>`;
        }
        if (outliers.length) {
            html += `<h3 style="margin:14px 0 6px;font-size:13px;color:var(--text-dim)">Outliers (${outliers.length})</h3><div class="cards">`;
            html += outliers.slice(0, 12).map((o) => `
                <div class="card">
                    <strong>${escapeHtml(o.title || '(no title)')}</strong>
                    <div class="meta">
                        ${escapeHtml(o.channel_title || '')} · ${escapeHtml(o.views || 0)} views · subs ${escapeHtml(o.subs || 0)} · score ${escapeHtml((o.outlier_score || 0).toFixed ? o.outlier_score.toFixed(2) : o.outlier_score)}
                    </div>
                    ${o.url ? `<div class="meta"><a href="${escapeHtml(o.url)}" target="_blank">${escapeHtml(o.url)}</a></div>` : ''}
                </div>
            `).join('');
            html += `</div>`;
        }
        if (!html) html = renderEmpty('No data returned.');
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('niche-result').innerHTML = html;
    }

    // ─── Research: keywords ────────────────────────────────────────────────
    async function runKeywords() {
        const seed = asNonEmpty($('kw-seed').value);
        if (!seed) {
            showError('kw-result', { status: 422, message: 'Seed cannot be empty.' });
            return;
        }
        const params = {
            seed,
            region: asNonEmpty($('kw-region').value) || 'US',
            language: $('kw-language').value || 'en',
            compute_kgr: asBool($('kw-kgr').value),
            max_kgr_keywords: asInt($('kw-max-kgr').value, 25),
            include_questions: asBool($('kw-questions').value),
        };
        showLoading('kw-result', 'Expanding keywords...');
        try {
            const data = await api.research.keywordIdeas(params);
            renderKeywords(data);
        } catch (err) {
            showError('kw-result', err);
        }
    }

    function renderKeywords(data) {
        const sugg = (data && data.suggestions) || [];
        const vph = (data && data.vph_top) || [];
        const seedScore = data && data.seed_score;

        let html = '';
        if (seedScore) {
            html += `<div class="stats-row">
                <span>Volume<b>${escapeHtml(seedScore.volume)}</b></span>
                <span>Competition<b>${escapeHtml(seedScore.competition)}</b></span>
                <span>Composite<b>${escapeHtml(seedScore.keyword)}</b></span>
                <span>Grade<b>${escapeHtml(seedScore.grade)}</b></span>
            </div>`;
        }
        if (sugg.length) {
            html += `<h3 style="margin:6px 0;font-size:13px;color:var(--text-dim)">Suggestions (${sugg.length})</h3><div class="cards">`;
            html += sugg.slice(0, 30).map((k) => `
                <div class="card">
                    <strong>${escapeHtml(k.keyword || '')}</strong>
                    <div class="meta">
                        score ${escapeHtml(k.score != null ? k.score : '?')} · ${escapeHtml(k.grade || '')}
                        ${k.results != null ? ` · ${escapeHtml(k.results)} results` : ''}
                    </div>
                </div>
            `).join('');
            html += `</div>`;
        }
        if (vph.length) {
            html += `<h3 style="margin:14px 0 6px;font-size:13px;color:var(--text-dim)">VPH top videos</h3><div class="cards">`;
            html += vph.slice(0, 12).map((v) => `
                <div class="card">
                    <strong>${escapeHtml(v.title || '')}</strong>
                    <div class="meta">${escapeHtml(v.views || 0)} views · ${escapeHtml((v.vph || 0).toFixed ? v.vph.toFixed(1) : v.vph)} vph</div>
                    ${v.url ? `<div class="meta"><a href="${escapeHtml(v.url)}" target="_blank">${escapeHtml(v.url)}</a></div>` : ''}
                </div>
            `).join('');
            html += `</div>`;
        }
        if (!html) html = renderEmpty('No suggestions returned.');
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('kw-result').innerHTML = html;
    }

    // ─── Research: outlier ─────────────────────────────────────────────────
    async function runOutlier() {
        const seed = asNonEmpty($('ol-seed').value);
        if (!seed) {
            showError('ol-result', { status: 422, message: 'Seed cannot be empty.' });
            return;
        }
        const params = {
            seed,
            region: asNonEmpty($('ol-region').value) || 'US',
            window_days: asInt($('ol-window').value, 7),
            max_subs: asInt($('ol-max-subs').value, 100000),
            min_outlier: asFloat($('ol-min-outlier').value, 1.5),
            max_results: asInt($('ol-max-results').value, 50),
        };
        showLoading('ol-result', 'Searching outliers...');
        try {
            const data = await api.research.outlierFinder(params);
            renderOutliers(data);
        } catch (err) {
            showError('ol-result', err);
        }
    }

    function renderOutliers(data) {
        const rows = (data && data.rows) || [];
        const stats = data && data.stats;
        let html = '';
        if (stats) {
            html += `<div class="stats-row">
                <span>Count<b>${escapeHtml(stats.count)}</b></span>
                <span>Max VPH<b>${escapeHtml((stats.max_vph || 0).toFixed ? stats.max_vph.toFixed(1) : stats.max_vph)}</b></span>
                <span>Avg VPH<b>${escapeHtml((stats.avg_vph || 0).toFixed ? stats.avg_vph.toFixed(1) : stats.avg_vph)}</b></span>
                <span>Avg outlier score<b>${escapeHtml((stats.avg_outlier_score || 0).toFixed ? stats.avg_outlier_score.toFixed(2) : stats.avg_outlier_score)}</b></span>
            </div>`;
        }
        if (rows.length) {
            html += `<div class="cards">`;
            html += rows.slice(0, 30).map((r) => `
                <div class="card">
                    <strong>${escapeHtml(r.title || '')}</strong>
                    <div class="meta">
                        ${escapeHtml(r.channel_title || '')} · subs ${escapeHtml(r.subs || 0)} · ${escapeHtml(r.views || 0)} views
                    </div>
                    <div class="meta">
                        outlier <b style="color:var(--accent)">${escapeHtml((r.outlier_score || 0).toFixed ? r.outlier_score.toFixed(2) : r.outlier_score)}</b>
                        · vph ${escapeHtml((r.vph || 0).toFixed ? r.vph.toFixed(1) : r.vph)}
                    </div>
                    ${r.url ? `<div class="meta"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a></div>` : ''}
                </div>
            `).join('');
            html += `</div>`;
        } else {
            html += renderEmpty('No outliers matched the filters. Try widening max_subs or lowering min_outlier.');
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('ol-result').innerHTML = html;
    }

    // ─── Research: cloner ──────────────────────────────────────────────────
    async function runCloner() {
        const url = asNonEmpty($('cl-url').value);
        if (!url) {
            showError('cl-result', { status: 422, message: 'YouTube URL/ID is required.' });
            return;
        }
        const params = {
            url,
            new_topic: $('cl-new-topic').value || '',
            n_titles: asInt($('cl-n-titles').value, 10),
            language_override: $('cl-language').value || 'auto',
        };
        showLoading('cl-result', 'Cloning video (transcript + DeepSeek)...');
        try {
            const data = await api.research.videoCloner(params);
            renderCloner(data);
        } catch (err) {
            showError('cl-result', err);
        }
    }

    function renderCloner(data) {
        const kit = data && data.kit;
        const fp = data && data.fingerprint;
        let html = '';
        html += `<div class="stats-row">
            <span>Video ID<b>${escapeHtml(data.video_id || '')}</b></span>
            <span>Detected<b>${escapeHtml(data.detected_language || '')}</b></span>
            <span>Output<b>${escapeHtml(data.output_language || '')}</b></span>
            <span>Transcript segments<b>${escapeHtml(data.transcript_segments || 0)}</b></span>
        </div>`;
        if (fp) {
            html += `<div class="card">
                <strong>Fingerprint</strong>
                <div>${escapeHtml(fp.title || '')}</div>
                <div class="meta">${escapeHtml(fp.channel_title || '')}</div>
            </div>`;
        }
        if (kit && kit.title_clones && kit.title_clones.length) {
            html += `<h3 style="margin:14px 0 6px;font-size:13px;color:var(--text-dim)">Title clones (${kit.title_clones.length})</h3><div class="cards">`;
            html += kit.title_clones.map((t) => `<div class="card">${escapeHtml(typeof t === 'string' ? t : (t && t.title) || JSON.stringify(t))}</div>`).join('');
            html += `</div>`;
        } else {
            html += renderEmpty('No clone-kit returned (LLM may have failed — check warnings).');
        }
        if (kit && kit.hooks && kit.hooks.length) {
            html += `<details open><summary>Hooks (${kit.hooks.length})</summary><pre>${escapeHtml(JSON.stringify(kit.hooks, null, 2))}</pre></details>`;
        }
        if (kit && kit.outline && kit.outline.length) {
            html += `<details><summary>Outline (${kit.outline.length})</summary><pre>${escapeHtml(JSON.stringify(kit.outline, null, 2))}</pre></details>`;
        }
        if (data.transcript_excerpt) {
            html += `<details><summary>Transcript excerpt</summary><pre>${escapeHtml(data.transcript_excerpt)}</pre></details>`;
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('cl-result').innerHTML = html;
    }

    // ─── Studio: topics ────────────────────────────────────────────────────
    async function runTopics() {
        const seed = asNonEmpty($('st-topics-seed').value);
        if (!seed) {
            showError('st-topics-result', { status: 422, message: 'Seed cannot be empty.' });
            return;
        }
        const params = {
            seed,
            language: $('st-topics-language').value || 'en',
            n: asInt($('st-topics-n').value, 20),
        };
        showLoading('st-topics-result', 'Generating topics...');
        try {
            const data = await api.studio.topics(params);
            renderTopics(data);
        } catch (err) {
            showError('st-topics-result', err);
        }
    }

    function renderTopics(data) {
        const ideas = (data && data.ideas) || [];
        let html = '';
        if (ideas.length) {
            html += `<h3 style="margin:6px 0;font-size:13px;color:var(--text-dim)">Click a topic to send to step 2</h3><div class="cards">`;
            html += ideas.map((idea, idx) => `
                <div class="card" data-pick-topic="${idx}" style="cursor:pointer">
                    <strong>${escapeHtml(idea.topic || '')}</strong>
                    <div>${escapeHtml(idea.hook || '')}</div>
                    <div class="meta">emotion: ${escapeHtml(idea.emotion || '')}</div>
                </div>
            `).join('');
            html += `</div>`;
        } else {
            html += renderEmpty('No topics returned.');
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('st-topics-result').innerHTML = html;
        $$('[data-pick-topic]', $('st-topics-result')).forEach((el) => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.getAttribute('data-pick-topic'), 10);
                const idea = ideas[idx];
                if (idea && idea.topic) {
                    state.lastTopic = idea.topic;
                    $('st-titles-topic').value = idea.topic;
                    $('st-titles-topic').focus();
                }
            });
        });
    }

    // ─── Studio: titles ────────────────────────────────────────────────────
    async function runTitles() {
        const topic = asNonEmpty($('st-titles-topic').value);
        if (!topic) {
            showError('st-titles-result', { status: 422, message: 'Pick or enter a topic first.' });
            return;
        }
        const params = {
            topic,
            language: $('st-titles-language').value || 'en',
            n: asInt($('st-titles-n').value, 10),
            must_keywords: $('st-titles-must').value || '',
        };
        showLoading('st-titles-result', 'Generating titles...');
        try {
            const data = await api.studio.titles(params);
            renderTitles(data);
        } catch (err) {
            showError('st-titles-result', err);
        }
    }

    function renderTitles(data) {
        const titles = (data && data.titles) || [];
        const top3 = (data && data.top_3) || [];
        let html = '';
        if (titles.length) {
            html += `<h3 style="margin:6px 0;font-size:13px;color:var(--text-dim)">Click a title to send to step 3 ${top3.length ? '(top picks: ' + top3.join(', ') + ')' : ''}</h3><div class="cards">`;
            html += titles.map((t, idx) => `
                <div class="card" data-pick-title="${idx}" style="cursor:pointer">
                    <strong>${escapeHtml(t.title || '')}</strong>
                    <div class="meta">CTR rank: ${escapeHtml(t.ctr_rank ?? '?')} · ${escapeHtml(t.chars || 0)} chars</div>
                    <div>${escapeHtml(t.reason || '')}</div>
                </div>
            `).join('');
            html += `</div>`;
        } else {
            html += renderEmpty('No titles returned.');
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('st-titles-result').innerHTML = html;
        $$('[data-pick-title]', $('st-titles-result')).forEach((el) => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.getAttribute('data-pick-title'), 10);
                const title = titles[idx] && titles[idx].title;
                if (title) {
                    state.lastTitle = title;
                    $('st-outline-title').value = title;
                    $('st-script-title').value = title;
                    $('st-outline-title').focus();
                }
            });
        });
    }

    // ─── Studio: outline ───────────────────────────────────────────────────
    async function runOutline() {
        const title = asNonEmpty($('st-outline-title').value);
        if (!title) {
            showError('st-outline-result', { status: 422, message: 'Pick a title first.' });
            return;
        }
        const params = {
            title,
            language: $('st-outline-language').value || 'en',
        };
        showLoading('st-outline-result', 'Generating 8-part outline...');
        try {
            const data = await api.studio.outline(params);
            renderOutline(data);
        } catch (err) {
            showError('st-outline-result', err);
        }
    }

    function renderOutline(data) {
        const parts = (data && data.parts) || [];
        let html = '';
        if (parts.length) {
            state.lastOutlineParts = parts;
            $('st-script-title').value = data.title || $('st-outline-title').value;
            html += `<div class="cards">`;
            html += parts.map((p) => `
                <div class="card">
                    <strong>Part ${escapeHtml(p.part || '?')}: ${escapeHtml(p.role || '')}</strong>
                    <div class="meta">emotion: ${escapeHtml(p.emotion || '')}</div>
                    <div>${escapeHtml(p.expansion || '')}</div>
                </div>
            `).join('');
            html += `</div>`;
        } else {
            state.lastOutlineParts = null;
            html += renderEmpty('No outline parts returned.');
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('st-outline-result').innerHTML = html;
    }

    // ─── Studio: script ────────────────────────────────────────────────────
    async function runScript() {
        const title = asNonEmpty($('st-script-title').value);
        if (!title) {
            showError('st-script-result', { status: 422, message: 'Title is required.' });
            return;
        }
        const parts = state.lastOutlineParts;
        if (!parts || parts.length < 8) {
            showError('st-script-result', { status: 422, message: 'Generate an 8-part outline first (step 3).' });
            return;
        }
        const params = {
            title,
            parts,
            language: $('st-script-language').value || 'en',
            target_chars: asInt($('st-script-chars').value, 8000),
        };
        showLoading('st-script-result', 'Writing long-form script (~30s)...');
        try {
            const data = await api.studio.script(params);
            renderScript(data);
        } catch (err) {
            showError('st-script-result', err);
        }
    }

    function renderScript(data) {
        const script = (data && data.script) || '';
        state.lastScript = script;
        let html = '';
        html += `<div class="stats-row">
            <span>Chars<b>${escapeHtml(data.chars || script.length)}</b></span>
            <span>Language<b>${escapeHtml(data.language || '')}</b></span>
        </div>`;
        if (script) {
            html += `<details open><summary>Script (${script.length} chars)</summary><pre style="max-height:480px">${escapeHtml(script)}</pre></details>`;
            // Auto-fill humanize + storyboard inputs.
            $('st-humanize-script').value = script;
            $('sb-script').value = script;
        } else {
            html += renderEmpty('No script returned.');
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('st-script-result').innerHTML = html;
    }

    // ─── Studio: humanize ──────────────────────────────────────────────────
    async function runHumanize() {
        const script = asNonEmpty($('st-humanize-script').value);
        if (!script) {
            showError('st-humanize-result', { status: 422, message: 'Script is required.' });
            return;
        }
        const params = {
            script,
            language: $('st-humanize-language').value || 'en',
        };
        showLoading('st-humanize-result', 'Humanizing...');
        try {
            const data = await api.studio.humanize(params);
            renderHumanize(data);
        } catch (err) {
            showError('st-humanize-result', err);
        }
    }

    function renderHumanize(data) {
        const out = (data && data.script_final) || '';
        // HF-16 — cache the humanized output so "Send script → Storyboard"
        // can prefer it over the raw step-4 script. Without this cache
        // the user has to copy-paste the humanized text into the
        // Storyboard textarea by hand even though the workflow's whole
        // point is to humanize before breaking into scenes.
        state.lastHumanizedScript = out || '';
        let html = '';
        html += `<div class="stats-row">
            <span>Chars in<b>${escapeHtml(data.chars_in || 0)}</b></span>
            <span>Chars out<b>${escapeHtml(data.chars_out || out.length)}</b></span>
        </div>`;
        if (out) {
            html += `<details open><summary>Humanized script</summary><pre style="max-height:480px">${escapeHtml(out)}</pre></details>`;
            // HF-16 — also mirror the humanized output into the
            // Storyboard's script textarea so the user can run "Break
            // into scenes" without a manual paste. Mirrors the
            // identical behaviour `renderScript` performs for the raw
            // generated script (line 856).
            $('sb-script').value = out;
        } else {
            html += renderEmpty('No humanized script returned.');
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('st-humanize-result').innerHTML = html;
    }

    // ─── Storyboard: scene_breakdown ───────────────────────────────────────
    async function runSceneBreakdown() {
        const script = asNonEmpty($('sb-script').value);
        if (!script) {
            showError('sb-result', { status: 422, message: 'Paste or send a script first.' });
            return;
        }
        // HF-5 #7 — every fresh scene_breakdown wipes the batch tables so
        // stale image/video rows from a previous script never bleed into
        // the new run. Cheaper than relying on the user to click Clear,
        // and matches the mental model that breaking a script restarts
        // the storyboard from scratch.
        sbbClear();
        const nField = $('sb-n-scenes').value;
        // PR-27: pull the Batch panel's "Images per scene" select so
        // the LLM expands variants up front (constraint F1) and the
        // backend gets a chance to extract Visual DNA (F2). Falls
        // back to the legacy 1-prompt path when the field is missing.
        const imagesPerScene = sbbReadVariantCount('sbb-images-per-scene', 4);
        state.lastImagesPerScene = imagesPerScene;
        const dnaOverride = (($('sb-visual-dna') || {}).value || '').trim();
        const params = {
            script,
            template_key: $('sb-template').value || 'cinematic',
            words_per_minute: asInt($('sb-wpm').value, 150),
            language: $('sb-language').value || 'en',
            images_per_scene: imagesPerScene,
        };
        if (dnaOverride) params.visual_dna_override = dnaOverride;
        if (nField && nField.trim().length) {
            params.n_scenes = asInt(nField, 12);
        }
        // PR-A — long-running endpoint (30–120s typical), so use
        // the progress UI instead of the static loading spinner.
        // Phases are timed approximations of the backend's pipeline
        // (script split → Visual DNA → variant prompt fan-out); the
        // elapsed counter is the real signal that the call is alive.
        const progressCtl = showProgress(
            'sb-result',
            'Đang chia kịch bản thành scenes (DeepSeek)…',
            null,  // null → use DEFAULT_SCENE_BREAKDOWN_PHASES
            { hint: 'Thường mất 30–90s tuỳ độ dài script. Variants giờ chạy song song nên scripts dài cũng nhanh hơn rồi.' }
        );
        try {
            const data = await api.storyboard.fromScript(params);
            progressCtl.stop();
            renderSceneBreakdown(data);
        } catch (err) {
            progressCtl.stop();
            showError('sb-result', err);
        }
    }

    function renderSceneBreakdown(data) {
        const scenes = (data && data.scenes) || [];
        // Capture for the "Compose with AutoGrok" handoff (PR-16). The
        // panel reuses the same script that was just broken into scenes.
        state.lastScenes = scenes.slice();
        state.lastSceneScript = asNonEmpty($('sb-script').value) || '';
        // HF-12 — cache the sidecar's authoritative total estimate (or
        // sum the per-scene durations as a fallback). Compose audio
        // and Refine script use this for auto-fit when no Video
        // batch rows have settled yet, so the user can write
        // narration before burning Grok credits.
        const charHelpers = (typeof window !== 'undefined' && window.StoryboardCharacterAnchorHelpers) || null;
        const echoedTotal = Number(data && data.total_duration_s_estimate);
        if (Number.isFinite(echoedTotal) && echoedTotal > 0) {
            state.lastScenesTotalDuration = echoedTotal;
        } else if (charHelpers && typeof charHelpers.sumSceneDurations === 'function') {
            state.lastScenesTotalDuration = charHelpers.sumSceneDurations(scenes);
        }
        // PR-27: capture the Visual DNA the backend used (either
        // echoed from our override or auto-extracted from the script
        // when ``images_per_scene > 1``). Re-roll reads from this
        // exact value so the prompts the user sees in the Batch
        // panel always match the field above.
        const dna = data && typeof data.visual_dna === 'string' ? data.visual_dna : '';
        const dnaField = $('sb-visual-dna');
        if (dnaField) {
            // Only auto-fill when (a) there's something to fill, and
            // (b) the user hasn't already typed an override. The
            // override path lives in lastVisualDna, so a non-empty
            // user value is preserved verbatim.
            const userTyped = (dnaField.value || '').trim();
            if (dna && (!userTyped || userTyped === state.lastVisualDna)) {
                dnaField.value = dna;
            }
        }
        state.lastVisualDna = (dnaField && dnaField.value || dna || '').trim();
        // PR-27: when scenes carry image_prompts[] (from the variant
        // expansion above), refresh the Batch image rows in place so
        // the user sees the variants right away — without forcing
        // them to click "Auto-fill from scenes" first. Settled rows
        // in flight are NOT clobbered (initImageRowsFromScenes only
        // runs when the table is empty or the scene set changed).
        sbbSyncFromScenes(scenes);
        // HF-12 — repaint the Compose audio auto-fit summary now that
        // we have scene durations to fall back to. Without this the
        // user has to click "Refresh from Video batch" before they
        // see the new "scene_breakdown estimate" line.
        try { psRefreshReferenceVideos(); } catch (_) { /* renderer not ready yet */ }
        let html = '';
        html += `<div class="stats-row">
            <span>Template<b>${escapeHtml(data.template_label || data.template_key || '')}</b></span>
            <span>Language<b>${escapeHtml(data.language || '')}</b></span>
            <span>Words<b>${escapeHtml(data.words || 0)}</b></span>
            <span>Scenes returned<b>${escapeHtml(data.n_scenes_returned || scenes.length)}</b></span>
            <span>Estimated total<b>${escapeHtml((data.total_duration_s_estimate || 0).toFixed ? data.total_duration_s_estimate.toFixed(1) : data.total_duration_s_estimate)}s</b></span>
        </div>`;
        if (scenes.length) {
            html += scenes.map((s) => `
                <div class="scene-card">
                    <div class="scene-title">Scene ${escapeHtml(s.scene_id)}: ${escapeHtml(s.title || '')}</div>
                    <div class="scene-meta">duration: ${escapeHtml((s.duration_s || 0).toFixed ? s.duration_s.toFixed(1) : s.duration_s)}s</div>
                    <div class="scene-block">
                        <span class="scene-label">Narration</span>
                        ${escapeHtml(s.narration || '')}
                    </div>
                    <div class="scene-block">
                        <span class="scene-label">Image prompt</span>
                        ${escapeHtml(s.image_prompt || '')}
                    </div>
                    <div class="scene-block">
                        <span class="scene-label">Veo3 / video prompt</span>
                        ${escapeHtml(s.flow_video_prompt || '')}
                    </div>
                </div>
            `).join('');
        } else {
            html += renderEmpty('No scenes returned. Check warnings — DeepSeek key may be missing.');
        }
        if (data.md) {
            html += `<details><summary>Markdown export</summary><pre style="max-height:480px">${escapeHtml(data.md)}</pre></details>`;
        }
        html += renderWarnings(data && data.warnings);
        html += renderRawJson(data);
        $('sb-result').innerHTML = html;
    }

    // ─── Producer: compose short (TTS + captions + ffmpeg) ─────────────────
    // Voice picker state. Cached across polls so flipping the TTS provider
    // dropdown can re-filter without another /producer/voices round-trip.
    // The sidecar returns provider-tagged voices so a single GET feeds
    // both edge-tts + piper-tts segments of the dropdown.
    const psVoiceState = {
        // Full unfiltered list from /producer/voices (provider-tagged).
        allVoices: [],
        // Sidecar's preferred default (edge-tts default by design).
        sidecarDefault: '',
        // Set true once the first successful GET completes — until then
        // the picker keeps its static HTML placeholder option.
        loaded: false,
    };

    function _psVoicePickerHelpers() {
        return (typeof window !== 'undefined' && window.ComposeVoicePickerHelpers) || null;
    }

    function _psCurrentProvider() {
        const sel = $('ps-tts-provider');
        return (sel && sel.value) ? sel.value : 'edge-tts';
    }

    /**
     * Re-paint the voice <select> from the cache, filtered by the
     * currently-selected provider. Pure-DOM — no IPC. Called by the
     * 5-second poll, by the provider dropdown's ``change`` handler,
     * and once on cold start by ``populateVoicePicker``.
     */
    function _psRepaintVoiceOptions() {
        const sel = $('ps-voice');
        if (!sel) return;
        const helpers = _psVoicePickerHelpers();
        const provider = _psCurrentProvider();
        const all = psVoiceState.allVoices;
        const current = sel.value;
        const sidecarDefault = psVoiceState.sidecarDefault;
        let filtered;
        let selected;
        if (helpers) {
            const result = helpers.selectVoicesForProvider({
                allVoices: all,
                provider,
                current,
                sidecarDefault,
            });
            filtered = result.voices;
            selected = result.selected;
        } else {
            // Helpers script missing (test harness / stripped HTML) —
            // fall back to no-filter behaviour so the picker still works.
            filtered = Array.isArray(all) ? all : [];
            selected = current || sidecarDefault || (filtered[0] && filtered[0].short_name) || '';
        }
        if (!filtered.length) {
            // Empty list (unknown provider). Render a friendly placeholder
            // so the user sees why the dropdown is empty, instead of a
            // mysterious silent select.
            sel.innerHTML = `<option value="" disabled selected>no voices for ${escapeHtml(provider)}</option>`;
            return;
        }
        sel.innerHTML = filtered
            .map((v) => `<option value="${escapeHtml(v.short_name)}">${escapeHtml(v.label || v.short_name)}</option>`)
            .join('');
        if (selected) {
            const found = Array.from(sel.options).find((o) => o.value === selected);
            if (found) sel.value = selected;
        }
    }

    async function populateVoicePicker() {
        if (!api) return;
        const sel = $('ps-voice');
        if (!sel) return;
        try {
            const data = await api.producer.listVoices();
            if (!data || !Array.isArray(data.voices) || !data.voices.length) return;
            psVoiceState.allVoices = data.voices.slice();
            psVoiceState.sidecarDefault = data.default || '';
            psVoiceState.loaded = true;
            _psRepaintVoiceOptions();
        } catch (err) {
            // Sidecar not ready yet — listVoices returns the soft sentinel.
            // Leave the static placeholder option alone; refresh on next call.
        }
    }

    /**
     * Provider-change handler: repaint immediately from the cached voice
     * list so the dropdown flips with no perceptible delay, then kick a
     * fresh `/producer/voices` fetch in the background. The fetch is
     * what catches the case where the renderer's cache was populated
     * against an older sidecar (pre-HF-11) that didn't ship ElevenLabs
     * voices yet — without this re-fetch, switching to the elevenlabs
     * provider showed an empty "no voices for elevenlabs" state until
     * the user manually reloaded the renderer (Ctrl+R).
     *
     * The fetch only repaints if the new payload is strictly larger
     * than the cached one, so users who change the dropdown back and
     * forth don't see a visual flicker.
     */
    async function _psOnProviderChange() {
        _psRepaintVoiceOptions();
        if (!api) return;
        try {
            const data = await api.producer.listVoices();
            if (!data || !Array.isArray(data.voices) || !data.voices.length) return;
            if (data.voices.length > psVoiceState.allVoices.length) {
                psVoiceState.allVoices = data.voices.slice();
                psVoiceState.sidecarDefault = data.default || psVoiceState.sidecarDefault;
                _psRepaintVoiceOptions();
            }
        } catch (_) {
            // Sidecar transient — keep the cached state.
        }
    }

    // PR-A — Compose panel is /producer/audio only. The legacy
    // /producer/short flow (TTS + visuals + 9:16 mp4) was retired
    // because the I2V/Veo3 batch + Video Assembly panel now produce
    // real per-scene visuals; the route still lives in the sidecar for
    // back-compat and tests but is no longer reachable from the UI.

    /**
     * HF-12 — resolve the auto-fit target for Compose audio / Refine
     * script. Settled scene-video paths come first (sidecar ffprobes
     * the summed duration), then the cached scene_breakdown estimate
     * (sum of per-scene ``duration_s`` from words ÷ WPM), then a
     * "no auto-fit" fallback. Returns a structured payload so
     * callers can decide whether to forward ``scene_videos[]`` or
     * a plain ``target_duration_s`` to the sidecar.
     *
     * @returns {{source: string, sceneVideos: string[],
     *            targetDurationS: number, summaryText: string}}
     */
    function psResolveAutoFitTarget() {
        const helpers = paHelpers();
        let paths = [];
        if (helpers && typeof helpers.pullScenePathsFromBatch === 'function') {
            paths = helpers.pullScenePathsFromBatch(sbbState && sbbState.videoRows);
        }
        const charHelpers = (typeof window !== 'undefined' && window.StoryboardCharacterAnchorHelpers) || null;
        if (!charHelpers || typeof charHelpers.resolveAutoFitTarget !== 'function') {
            // Defensive: helper script failed to load — fall back to
            // the legacy "videos or none" behaviour without crashing.
            return {
                source: paths.length ? 'videos' : 'none',
                sceneVideos: paths,
                targetDurationS: 0,
                summaryText: paths.length
                    ? `${paths.length} scene video${paths.length === 1 ? '' : 's'} ready — captions will auto-fit their summed duration (override below).`
                    : 'no scene videos yet — generate the Video batch above to enable auto-fit',
            };
        }
        const targetRaw = ($('ps-target-duration') && $('ps-target-duration').value) || '';
        const override = parseFloat(targetRaw);
        return charHelpers.resolveAutoFitTarget({
            sceneVideoPaths: paths,
            scenes: Array.isArray(state.lastScenes) ? state.lastScenes : [],
            totalDurationEstimate: state.lastScenesTotalDuration || 0,
            targetOverrideS: Number.isFinite(override) ? override : 0,
        });
    }

    /**
     * Pull settled scene-video paths from ``sbbState.videoRows`` and
     * paint a short summary in the Compose panel's auto-fit field. The
     * path list is what ``runComposeShort`` will send to /producer/audio
     * as ``scene_videos[]`` so the SRT timing is auto-fit to the
     * assembled video. HF-12 — when no scene videos have settled yet,
     * the summary surfaces the scene_breakdown estimate so the user
     * can compose narration before burning Grok credits. Idempotent —
     * safe to call from anywhere sbbState.videoRows or
     * state.lastScenes mutates.
     */
    function psRefreshReferenceVideos() {
        const target = psResolveAutoFitTarget();
        const summary = $('ps-reference-summary');
        if (summary) {
            if (target.source === 'none') {
                summary.value = '';
                summary.placeholder = 'no scene videos and no scene_breakdown yet — run "Break into scenes" above to enable auto-fit';
            } else {
                summary.value = target.summaryText;
            }
        }
        return target.sceneVideos;
    }

    async function composeRefreshReference() {
        const target = psResolveAutoFitTarget();
        psRefreshReferenceVideos();
        const out = $('ps-result');
        if (out) {
            if (target.source === 'videos') {
                out.innerHTML = `<div class="info">Compose audio will scale captions to fit ${target.sceneVideos.length} scene video${target.sceneVideos.length === 1 ? '' : 's'} (ffprobe-summed). Override via the "Target duration" field above.</div>`;
            } else if (target.source === 'scene_breakdown') {
                out.innerHTML = `<div class="info">No scene videos yet — Compose audio will scale captions to the scene_breakdown estimate (${target.targetDurationS.toFixed(1)}s). Generate the Video batch above to switch to ffprobe-measured duration, or override via the "Target duration" field.</div>`;
            } else if (target.source === 'override') {
                out.innerHTML = `<div class="info">Manual target duration: ${target.targetDurationS.toFixed(1)}s.</div>`;
            } else {
                out.innerHTML = `<div class="info">No auto-fit source available. Run "Break into scenes" above first, or generate the Video batch, or type a target duration override.</div>`;
            }
        }
    }

    async function runComposeShort() {
        const script = asNonEmpty($('ps-script').value) || asNonEmpty($('sb-script').value);
        if (!script) {
            showError('ps-result', { status: 422, message: 'Paste a script (or copy from Storyboard above).' });
            return;
        }
        if (!api.producer || typeof api.producer.composeAudio !== 'function') {
            showError('ps-result', { status: 0, message: 'electronAPI.producer.composeAudio is unavailable — desktop shell needs PR-30 preload.' });
            return;
        }
        const params = {
            script,
            // PR-23: tts_provider lets the user pick Piper (offline) over
            // edge-tts (online). The route falls back to edge-tts when the
            // value is empty / unknown so a stale UI is never a 4xx.
            tts_provider: ($('ps-tts-provider') && $('ps-tts-provider').value) || 'edge-tts',
            voice: $('ps-voice').value || 'en-US-AriaNeural',
            write_srt: !!$('ps-write-srt').checked,
            // HF-10 — speech rate slider value. Edge-tts honours it
            // ("+0%" / "+20%" / "-30%"); Piper-tts ignores it. The
            // route's AudioOnlyRequest defaults to "+0%" so omitting
            // a stale slider is safe.
            rate: psReadRate(),
        };
        const outDir = asNonEmpty($('ps-output-dir').value);
        if (outDir) params.output_dir = outDir;
        // PR-A / HF-12 — auto-sync SRT. Priority: explicit override >
        // settled scene-video paths (sidecar ffprobes the sum) >
        // scene_breakdown estimate (sum of per-scene duration_s
        // from words ÷ WPM, so users can compose narration before
        // burning Grok credits on Image / Video batches) > none.
        const autoFit = psResolveAutoFitTarget();
        psRefreshReferenceVideos();
        if (autoFit.source === 'override') {
            params.target_duration_s = autoFit.targetDurationS;
        } else if (autoFit.source === 'videos') {
            params.scene_videos = autoFit.sceneVideos;
        } else if (autoFit.source === 'scene_breakdown') {
            params.target_duration_s = autoFit.targetDurationS;
        }
        // Per-scene narration: when the storyboard has been broken into
        // scenes, send each scene's narration as its own slot so the
        // sidecar TTS-renders one voice clip per scene (matching the
        // image / video phase) instead of dumping the whole script into
        // a single TTS pass. The i-th narration aligns with the i-th
        // scene_video so silence padding fits the assembled timeline.
        // When no scenes are in memory (or every narration is blank)
        // the sidecar falls back to the legacy single-pass path.
        const scenes = Array.isArray(state.lastScenes) ? state.lastScenes : [];
        if (scenes.length) {
            const sceneNarrations = scenes.map(s => {
                if (!s || typeof s !== 'object') return '';
                const n = (s.narration == null) ? '' : String(s.narration).trim();
                return n;
            });
            const anyNonBlank = sceneNarrations.some(n => n.length > 0);
            if (anyNonBlank) {
                params.scene_narrations = sceneNarrations;
                // Per-scene LLM humanise pass: pair the narrations with
                // each scene's image_prompt so the sidecar can rewrite
                // them to match the visual content + real video
                // duration (instead of just chunking the raw script).
                // The sidecar treats this as opt-in via
                // ``humanize_per_scene`` and falls back to the raw
                // narrations when DEEPSEEK_API_KEY is missing or the
                // LLM call errors, so toggling it on is always safe.
                const sceneImagePrompts = scenes.map(s => {
                    if (!s || typeof s !== 'object') return '';
                    const p = s.image_prompt != null ? String(s.image_prompt).trim() : '';
                    return p;
                });
                params.scene_image_prompts = sceneImagePrompts;
                params.humanize_per_scene = true;
            }
        }
        showLoading('ps-result', 'Rendering TTS audio (this usually takes a few seconds)...');
        try {
            const data = await api.producer.composeAudio(params);
            renderComposeAudio(data);
            // PR-A — auto-fill the Video Assembly panel below the moment
            // the audio + SRT exist on disk so the user can just press
            // "Assemble final MP4" without copy-pasting paths.
            paAutoFillFromAudioResult(data);
        } catch (err) {
            showError('ps-result', err);
        }
    }

    // PR-30 — render the /producer/audio response (no mp4 row, surfaces
    // the actual audio_format reported by the sidecar so a Piper run
    // shows ``voice.wav`` instead of ``voice.mp3``).
    function renderComposeAudio(data) {
        const d = data || {};
        const fmt = (d.audio_format === 'wav') ? 'wav' : 'mp3';
        let html = '';
        // PR-A — surface the auto-fit target so the user can confirm at
        // a glance whether the SRT was scaled to a scene-video duration
        // or left at native TTS timing.
        const targetSecs = Number(d.target_duration_s) || 0;
        const scaledLabel = d.captions_scaled
            ? `auto-fit · ${targetSecs.toFixed(2)}s`
            : 'native TTS timing';
        // Surface per-scene mode so the user can confirm narration was
        // synthesised one TTS pass per scene (matching the storyboard
        // beat-by-beat) instead of dumping the full script. Tag with
        // ``+ humanise`` when the sidecar successfully ran the LLM
        // rewrite pass over the per-scene narrations so it's obvious
        // which audio reflects DeepSeek-tuned narrations vs the raw
        // renderer-split chunks.
        const scenesRendered = Number(d.scenes_rendered) || 0;
        const humanizedPerScene = !!d.humanized_per_scene;
        const sceneModeLabel = scenesRendered > 0
            ? `per-scene · ${scenesRendered} scene${scenesRendered === 1 ? '' : 's'}${humanizedPerScene ? ' · humanised' : ''}`
            : 'single-pass';
        html += `<div class="stats-row">
            <span>Duration<b>${escapeHtml((d.duration_s || 0).toFixed(2))}s</b></span>
            <span>Voice<b>${escapeHtml(d.voice || '')}</b></span>
            <span>Engine<b>${escapeHtml(d.engine || '')}</b></span>
            <span>Format<b>${escapeHtml(fmt)}</b></span>
            <span>Captions<b>${escapeHtml(d.captions_count || 0)}</b></span>
            <span>Caption source<b>${escapeHtml(d.caption_source || 'none')}</b></span>
            <span>SRT timing<b>${escapeHtml(scaledLabel)}</b></span>
            <span>TTS mode<b>${escapeHtml(sceneModeLabel)}</b></span>
        </div>`;
        const paths = [
            [`voice.${fmt}`, d.audio_path],
            ['captions.srt', d.srt_path],
        ].filter(([, p]) => !!p);
        if (paths.length) {
            html += `<div class="scene-card"><div class="scene-title">Output files</div>`;
            paths.forEach(([label, p]) => {
                html += `<div class="scene-block"><span class="scene-label">${escapeHtml(label)}</span><code>${escapeHtml(p)}</code></div>`;
            });
            html += `<div class="scene-meta">Output dir: <code>${escapeHtml(d.output_dir || '')}</code></div></div>`;
        } else {
            html += renderEmpty('No audio produced. Check warnings — the TTS engine may be misconfigured.');
        }
        html += renderWarnings(d.warnings);
        html += renderRawJson(d);
        $('ps-result').innerHTML = html;
    }

    // ─── PR-31: Video Assembly handlers ─────────────────────────────────────

    // Helper handle to the pure-functions module loaded via <script>
    // tag (storyboard_assemble_helpers.js). Reading through window.*
    // at call time (not module load) lets the helpers be re-loaded in
    // dev without a full reload.
    function paHelpers() {
        return window.StoryboardAssembleHelpers;
    }

    // Read every form input into a single object so the helpers can
    // build the POST body (and the validator can mirror it).
    //
    // PR-A — the ``Audio mode`` / ``Trim to`` dropdowns were removed
    // from the UI: ``replace`` + ``video`` cover ~100% of the
    // supported workflow and are pinned here so the renderer always
    // sends the documented defaults. Power users can still hit
    // /producer/assemble directly with the other values via the wire
    // API.
    //
    // HF-10 — caption mode + burn styling are now user-controlled
    // again (the burn-styling row is conditionally shown only when
    // mode === 'burn'; see the change handler in DOMContentLoaded).
    function paReadForm() {
        const sceneText = ($('pa-scene-videos') && $('pa-scene-videos').value) || '';
        const helpers = paHelpers();
        const scenePaths = helpers
            ? helpers.parseSceneVideoPaths(sceneText)
            : sceneText.split('\n').map((l) => l.trim()).filter(Boolean);
        const modeEl = $('pa-caption-mode');
        const styleEl = $('pa-caption-style');
        const fontEl = $('pa-caption-font-size');
        const posEl = $('pa-caption-position');
        return {
            scenePaths,
            audioPath: ($('pa-audio-path') && $('pa-audio-path').value) || '',
            srtPath: ($('pa-srt-path') && $('pa-srt-path').value) || '',
            outputDir: ($('pa-output-dir') && $('pa-output-dir').value) || '',
            audioMode: 'replace',
            trimTo: 'video',
            captionMode: (modeEl && modeEl.value) || 'soft',
            captionStyle: (styleEl && styleEl.value) || 'modern',
            captionFontSize: (fontEl && fontEl.value) || '',
            captionPosition: (posEl && posEl.value) || '',
        };
    }

    /**
     * HF-10 — show / hide the burn-only styling row based on the
     * caption-mode dropdown. Soft / none modes don't use a force_style
     * preset (the player or the SRT pixels win), so collapsing the
     * row keeps the form clean. Idempotent — safe to call from cold
     * paint and from the change event listener.
     */
    function paUpdateBurnStyleVisibility() {
        const modeEl = $('pa-caption-mode');
        const row = $('pa-burn-style-row');
        if (!modeEl || !row) return;
        const isBurn = modeEl.value === 'burn';
        row.style.display = isBurn ? '' : 'none';
    }

    /**
     * HF-10 — sync the speech-rate label with the slider value so the
     * user sees "+0%" / "+20%" / "-30%" live as they drag. The label
     * uses ``+`` for non-negative values to match edge-tts's wire
     * format (the route accepts "+0%" but rejects "0%" / "-0%").
     */
    function psUpdateRateLabel() {
        const slider = $('ps-rate');
        const label = $('ps-rate-label');
        if (!slider || !label) return;
        const n = parseInt(slider.value, 10) || 0;
        label.textContent = (n >= 0 ? '+' : '') + n + '%';
    }

    /**
     * HF-10 — read the slider and return the edge-tts wire string
     * ("+0%" / "+20%" / "-30%"). Returns the default "+0%" when the
     * slider isn't on the page (e.g. older HTML cache during dev).
     */
    function psReadRate() {
        const slider = $('ps-rate');
        if (!slider) return '+0%';
        const n = parseInt(slider.value, 10) || 0;
        return (n >= 0 ? '+' : '') + n + '%';
    }

    // PR-A — track whether the user manually edited the scene-videos
    // textarea since the last auto-fill. We set it ``true`` on every
    // user-typed input so that subsequent video-batch settles do NOT
    // overwrite their hand-edits. ``Refresh from Video batch`` clears
    // the flag and re-pulls.
    let paScenesUserEdited = false;

    // PR-B — same idea for the Compose panel's narration script
    // textarea. The Storyboard's ``sb-script`` is the canonical source
    // (Studio's "Send script → Storyboard" lands there). We mirror it
    // into ``ps-script`` automatically until the user types into
    // ``ps-script`` themselves, at which point the mirror stops so we
    // never clobber a hand-edit. ``Copy script from above`` resets
    // the flag in ``copyScriptFromStoryboard``.
    let psScriptUserEdited = false;

    /**
     * Mirror ``#sb-script`` into ``#ps-script`` when the latter is
     * still in its default state (empty or never user-edited). No-op
     * when the user has typed into ``#ps-script`` so a hand-edit is
     * never overwritten. Call from cold paint and from the
     * ``#sb-script`` ``input`` event so the Compose panel always has
     * a script ready when the user clicks Compose audio.
     */
    function psSyncScriptFromStoryboard() {
        if (psScriptUserEdited) return;
        const sb = $('sb-script');
        const ps = $('ps-script');
        if (!sb || !ps) return;
        const next = (typeof sb.value === 'string') ? sb.value : '';
        if (ps.value !== next) ps.value = next;
    }

    /**
     * Repaint the scene-videos textarea from the current ``videoRows``
     * unless the user has hand-edited the box. Called from
     * ``sbbRepaintVideo`` so newly-settled rows show up immediately.
     */
    function paAutoFillScenesFromBatch() {
        if (paScenesUserEdited) return;
        const helpers = paHelpers();
        const ta = $('pa-scene-videos');
        if (!helpers || !ta) return;
        const paths = helpers.pullScenePathsFromBatch(
            sbbState && sbbState.videoRows,
        );
        const next = paths.join('\n');
        // Only mutate when something changes — avoids stomping on the
        // cursor / scroll position when the user is mid-paste.
        if (ta.value !== next) ta.value = next;
    }

    /**
     * PR-A — auto-populate the narration audio + SRT inputs from the
     * /producer/audio response so the user can press Assemble without
     * a copy-paste. Skips silently when the response carries no audio
     * (e.g. TTS failed; the warnings already surface that).
     */
    function paAutoFillFromAudioResult(data) {
        if (!data || typeof data !== 'object') return;
        const audioInput = $('pa-audio-path');
        if (audioInput && data.audio_path) audioInput.value = data.audio_path;
        const srtInput = $('pa-srt-path');
        if (srtInput && data.srt_path) srtInput.value = data.srt_path;
    }

    async function paPickAudioFile() {
        if (!api || !api.dialog || typeof api.dialog.chooseInputFile !== 'function') return;
        const res = await api.dialog.chooseInputFile({
            title: 'Choose narration audio',
            filters: [
                { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (res && !res.canceled && res.path && $('pa-audio-path')) {
            $('pa-audio-path').value = res.path;
        }
    }

    async function paPickSrtFile() {
        if (!api || !api.dialog || typeof api.dialog.chooseInputFile !== 'function') return;
        const res = await api.dialog.chooseInputFile({
            title: 'Choose captions.srt',
            filters: [
                { name: 'Subtitles', extensions: ['srt'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (res && !res.canceled && res.path && $('pa-srt-path')) {
            $('pa-srt-path').value = res.path;
        }
    }

    async function paPullFromBatch() {
        const helpers = paHelpers();
        const target = $('pa-result');
        if (!helpers) {
            if (target) showError('pa-result', { message: 'StoryboardAssembleHelpers not loaded.' });
            return;
        }
        const paths = helpers.pullScenePathsFromBatch(sbbState.videoRows);
        const ta = $('pa-scene-videos');
        if (ta) ta.value = paths.join('\n');
        // Manual refresh re-arms the auto-fill so subsequent batch settles
        // keep the textarea in lock-step until the user edits it again.
        paScenesUserEdited = false;
        if (target) {
            if (paths.length === 0) {
                target.innerHTML = `<div class="info">No settled video rows found. Generate the Video batch first, or check that rows have a saved file path.</div>`;
            } else {
                target.innerHTML = `<div class="info">Filled ${paths.length} scene path${paths.length === 1 ? '' : 's'} from the Video batch (in scene order). Edit the textarea to reorder or drop entries.</div>`;
            }
        }
    }

    async function paUseLatestAudio() {
        const target = $('pa-result');
        if (!api || !api.producer || typeof api.producer.latestAudioOutput !== 'function') {
            if (target) showError('pa-result', { message: 'electronAPI.producer.latestAudioOutput is unavailable — run via `npm start`.' });
            return;
        }
        try {
            const res = await api.producer.latestAudioOutput();
            if (!res || !res.path) {
                if (target) target.innerHTML = `<div class="info">No /producer/audio output found yet. Render audio in the Compose panel first (mode = Audio only).</div>`;
                return;
            }
            if ($('pa-audio-path')) $('pa-audio-path').value = res.path;
            if (res.srtPath && $('pa-srt-path')) $('pa-srt-path').value = res.srtPath;
            if (target) {
                target.innerHTML = `<div class="info">Using narration from <code>${escapeHtml(res.dir || '')}</code>. Reusing srt: ${res.srtPath ? '<code>' + escapeHtml(res.srtPath) + '</code>' : 'not found'}.</div>`;
            }
        } catch (err) {
            if (target) showError('pa-result', err);
        }
    }

    async function runAssemble() {
        const target = $('pa-result');
        const helpers = paHelpers();
        if (!helpers) {
            showError('pa-result', { message: 'StoryboardAssembleHelpers not loaded.' });
            return;
        }
        if (!api || !api.producer || typeof api.producer.assemble !== 'function') {
            showError('pa-result', { message: 'electronAPI.producer.assemble is unavailable — run via `npm start` and confirm the sidecar is up.' });
            return;
        }
        const form = paReadForm();
        const validation = helpers.validateAssembleForm(form);
        if (!validation.enabled) {
            showError('pa-result', { status: 0, message: validation.reason || 'Form invalid.' });
            return;
        }
        const payload = helpers.buildAssemblePayload(form);
        showLoading('pa-result', 'Assembling final.mp4 (ffmpeg concat + audio replace + soft subs)...');
        try {
            const data = await api.producer.assemble(payload);
            renderAssemble(data);
        } catch (err) {
            showError('pa-result', err);
        }
    }

    // PR-31 — render the /producer/assemble response. Mirrors
    // ``renderComposeAudio`` style so the panels feel consistent;
    // surfaces the booleans (audio_attached / captions_attached) so
    // the user can confirm at a glance whether ffmpeg actually
    // attached the inputs the form sent.
    function renderAssemble(data) {
        const d = data || {};
        let html = '';
        html += `<div class="stats-row">
            <span>Duration<b>${escapeHtml((d.duration_s || 0).toFixed(2))}s</b></span>
            <span>Scenes<b>${escapeHtml(d.scene_count || 0)}</b></span>
            <span>Audio<b>${d.audio_attached ? 'attached' : '—'}</b></span>
            <span>Captions<b>${d.captions_attached ? 'attached (soft)' : '—'}</b></span>
        </div>`;
        if (d.video_path) {
            // Action chips for the final mp4 + its containing folder.
            // ``data-swc-open`` / ``data-swc-show`` are the same delegated
            // click handlers the storyboard rows use, so the user gets
            // the same Open / Show in folder affordance as the per-scene
            // image / video tables instead of having to copy-paste paths.
            const finalActions = sbbRenderPathActions(d.video_path);
            const folderActions = d.output_dir ? sbbRenderPathActions(d.output_dir) : '';
            html += `<div class="scene-card"><div class="scene-title">Final video</div>`;
            html += `<div class="scene-block"><span class="scene-label">final.mp4</span><code>${escapeHtml(d.video_path)}</code> ${finalActions}</div>`;
            html += `<div class="scene-meta">Output dir: <code>${escapeHtml(d.output_dir || '')}</code> ${folderActions}</div></div>`;
        } else {
            html += renderEmpty('No final.mp4 produced. Check warnings below — ffmpeg likely failed or no scene videos resolved.');
        }
        html += renderWarnings(d.warnings);
        html += renderRawJson(d);
        $('pa-result').innerHTML = html;
    }

    // PR-A — ``renderComposeShort`` (mp4 short-mode renderer) was deleted
    // along with the Output mode selector. The /producer/short route is
    // still callable from the wire API + still tested in the sidecar
    // bucket, but the renderer never composes a 9:16 mp4 anymore — that
    // workflow is replaced by I2V/Veo3 batch + Video Assembly.

    // Delegate clicks on action chips so we don't have to attach
    // listeners to every row on every repaint.
    document.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.matches) return;
        if (t.matches('a[data-swc-open]')) {
            e.preventDefault();
            const p = t.getAttribute('data-swc-open');
            if (api && typeof api.openPath === 'function') api.openPath(p).catch(() => {});
        } else if (t.matches('a[data-swc-show]')) {
            e.preventDefault();
            const p = t.getAttribute('data-swc-show');
            if (api && typeof api.showItemInFolder === 'function') api.showItemInFolder(p).catch(() => {});
        } else if (t.matches('a[data-sbb-make-video]')) {
            e.preventDefault();
            const sid = t.getAttribute('data-sbb-make-video');
            const rid = t.getAttribute('data-sbb-make-video-row') || '';
            try { sbbBridgeImageToVideo(sid, rid); } catch (err) { console.warn('bridge image→video failed:', err); }
        } else if (t.matches('button[data-sbb-row-action]')) {
            // PR-27 — per-row Edit / Delete buttons.
            const action = t.getAttribute('data-sbb-row-action');
            const kind = t.getAttribute('data-sbb-kind');
            const rowId = t.getAttribute('data-sbb-row');
            if (action === 'edit') sbbBeginEdit(kind, rowId);
            else if (action === 'delete') sbbDeleteRow(kind, rowId);
            else if (action === 'refs') sbbAddRowRefs(rowId).catch((err) => console.warn('add row refs failed:', err));
            else if (action === 'clear-refs') sbbClearRowRefs(rowId);
            else if (action === 'retry') sbbRetryRow(kind, rowId).catch((err) => console.warn('retry failed:', err));
        } else if (t.matches('button[data-sbb-ref-remove]')) {
            // PR-28 — ✕ button on a global-ref list entry.
            sbbRemoveGlobalRef(t.getAttribute('data-sbb-ref-remove'));
        } else if (t.matches('button[data-sbb-edit-action]')) {
            // PR-27 — Save / Cancel buttons inside an inline-edit shell.
            const action = t.getAttribute('data-sbb-edit-action');
            const kind = t.getAttribute('data-sbb-kind');
            const rowId = t.getAttribute('data-sbb-row');
            if (action === 'save') sbbSaveEdit(kind, rowId);
            else if (action === 'cancel') sbbCancelEdit(kind);
        } else if (t.matches('button[data-sbb-bulk]')) {
            // PR-27 — bulk-action toolbar buttons.
            const action = t.getAttribute('data-sbb-bulk');
            const kind = t.getAttribute('data-sbb-kind');
            if (action === 'select-all') sbbToggleSelectAll(kind);
            else if (action === 'reroll') sbbRerollSelected(kind).catch((err) => console.warn('reroll failed:', err));
            else if (action === 'delete') sbbDeleteSelected(kind);
        } else {
            // PR-46 — click-to-expand on a clamped prompt cell.
            // Walks up so a click on the inner ``.prompt-cell-body``
            // or the hint span still hits the wrapper. Skips when
            // the user clicked an action button inside the same row
            // (Edit / Delete / Refs / Retry / Make video / a link)
            // — those bubble up too and we don't want a stray
            // toggle to fire alongside them.
            const toggle = t.closest && t.closest('[data-sbb-prompt-toggle]');
            if (toggle) {
                const inAction = t.closest('button, a, input, textarea, .sbb-edit-shell, .sbb-row-actions');
                if (!inAction) {
                    sbbTogglePromptExpansion(toggle.getAttribute('data-sbb-prompt-toggle'));
                }
            }
        }
    });

    // PR-27 — checkbox change events (header + per-row). Lives in a
    // separate listener because ``click`` on a checkbox fires before
    // ``checked`` flips, so we read the post-flip value from
    // ``change``.
    document.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || !t.matches) return;
        if (t.matches('input[type="checkbox"][data-sbb-row-select]')) {
            const kind = t.getAttribute('data-sbb-kind');
            const rowId = t.getAttribute('data-sbb-row-select');
            sbbToggleRow(kind, rowId);
        } else if (t.matches('input[type="checkbox"][data-sbb-bulk="header-select"]')) {
            const kind = t.getAttribute('data-sbb-kind');
            sbbToggleSelectAll(kind);
        } else if (t.id === 'sbb-video-mode') {
            // PR-B — toggling I2V ↔ T2V flips the image-prerequisite
            // gate on the Generate-videos button, so refresh the
            // button label/disabled state here. We don't repaint the
            // whole table because nothing else in the table depends
            // on the mode.
            sbbUpdateGenerateButton('video');
        }
    });

    // PR-27 — keyboard shortcuts inside the inline-edit textarea:
    // Enter = Save, Esc = Cancel. Shift+Enter still inserts a newline.
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (!t || !t.matches || !t.matches('textarea[data-sbb-edit-input]')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            const kind = (t.getAttribute('data-sbb-edit-input') || '').split(':')[0] || 'image';
            sbbCancelEdit(kind);
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const [kind, rowId] = (t.getAttribute('data-sbb-edit-input') || '').split(':');
            // Capture the textarea's current value into the draft so
            // sbbSaveEdit reads the latest text.
            sbbState.editingDraft = t.value;
            sbbSaveEdit(kind || 'image', rowId);
        }
    });

    // PR-27 — keep the editing draft in sync as the user types so
    // a re-render mid-edit doesn't lose their input.
    document.addEventListener('input', (e) => {
        const t = e.target;
        if (!t || !t.matches || !t.matches('textarea[data-sbb-edit-input]')) return;
        sbbState.editingDraft = t.value;
    });

    // ─── PR-20D — "Batch Image + Video" panel ────────────────────────
    // KCRACKER-style two-table flow that auto-fills image_prompt +
    // video_prompt from the scene_breakdown above. Each table is
    // batched independently; the video table can run in I2V mode
    // (uses each scene's settled image) or T2V mode (prompt-only).
    //
    // Persistent Grok session reuse comes from PR-11/12/13 — cookies
    // live in $GROK_PROFILE_DIR (default `~/.creator-forge/grok-profile/`)
    // and `AuthService.refreshAllCookies()` runs before every batch
    // IPC, so logging in once via the manual-login window keeps the
    // session valid across app restarts.
    const sbbState = {
        imageRows: [],
        videoRows: [],
        currentImageBatchSceneIds: [],
        currentImageBatchRowIds: [],
        currentVideoBatchSceneIds: [],
        currentVideoBatchRowIds: [],
        listenerInstalled: false,
        sessionKnown: false,
        // PR-27 — bulk-select state per kind (Set<row_id> as string).
        // Populated/mutated via toggleRowSelection / selectAllRowIds /
        // reconcileSelection from storyboard_batch_helpers.js.
        imageSelected: new Set(),
        videoSelected: new Set(),
        // PR-27 — which row is currently in inline-edit mode. Only one
        // row per kind can be in edit mode at a time so the renderer
        // doesn't fight itself when the user clicks Edit on a second
        // row mid-edit. Format: "image:1#0" / "video:2#1" / null.
        editingRowKey: null,
        editingDraft: '',
        // PR-28 — reference image upload. ``globalRefs`` is the
        // shared character / style anchor list applied to every row
        // unless that row has its own override in ``rowRefMap``.
        // ``rowRefMap`` is a plain object keyed by row_id whose value
        // is a string[] of absolute file paths returned by
        // ``electronAPI.selectFiles``. Empty arrays mean "user
        // explicitly cleared the override" (still falls back to the
        // global). Both kinds (image / video) share the same maps —
        // video rows pick up refs implicitly via the image→video
        // bridge and don't expose their own ref UI.
        globalRefs: [],
        rowRefMap: {},
        // PR-46 — Set<"image:row_id" | "video:row_id"> of prompt cells
        // the user has expanded. Persisted across re-renders so a
        // progress tick on a sibling row doesn't silently re-collapse
        // the one the user just opened. Cleared per-kind when the
        // table is rebuilt from a fresh scene_breakdown.
        promptExpanded: new Set(),
        // PR-48 — true once the user has explicitly changed the
        // ``Videos per scene`` select. Until then, videosPerScene
        // auto-syncs to imagesPerScene so each video variant pairs
        // 1:1 with its image variant (matches the new
        // flow_video_prompts continuity from /producer/scene_breakdown).
        userOverroteVideosPerScene: false,
        // PR-48 — Pro mode (Grok's Quality model). When true the
        // Storyboard sends ``enablePro: true`` to image:generate and
        // forces ``Images per scene`` to 1 (Pro returns 1 ảnh chất
        // lượng / variant, no side-by-side preview). Stored so the
        // checkbox state survives re-renders without re-reading the
        // DOM on every image dispatch.
        proMode: false,
    };

    /** Repaint both image and video tables. */
    function sbbRepaintAll() {
        sbbRepaintImage();
        sbbRepaintVideo();
    }

    /** Repaint just the image batch table. */
    function sbbRepaintImage() {
        const target = $('sbb-image-result');
        if (!target) return;
        if (!sbbState.imageRows.length) {
            target.innerHTML = '<div class="empty">No prompts loaded. Click "Auto-fill from scenes" after running "Break into scenes" above.</div>';
        } else {
            target.innerHTML = sbbRenderTable(sbbState.imageRows, 'image');
        }
        sbbUpdateGenerateButton('image');
        // HF-5 #10 — keep the section-header progress badge in lock-step
        // with row state. Cheap (linear over rows) and gives the user a
        // headline number without scrolling through a long table.
        sbbUpdateProgressBadge('image');
        // PR-B — the Video Generate button's gate depends on the
        // count of settled image rows, so refresh it whenever the
        // image table changes (rows added, deleted, status flipped,
        // or batch progress ticks). Cheaper than a full
        // ``sbbRepaintAll`` and keeps the button label in lock-step
        // with image state without repainting the (potentially
        // long) video table.
        sbbUpdateGenerateButton('video');
    }

    /** Repaint just the video batch table. */
    function sbbRepaintVideo() {
        const target = $('sbb-video-result');
        if (!target) return;
        if (!sbbState.videoRows.length) {
            target.innerHTML = '<div class="empty">No prompts loaded. Click "Auto-fill from scenes" after running "Break into scenes" above.</div>';
        } else {
            target.innerHTML = sbbRenderTable(sbbState.videoRows, 'video');
        }
        sbbUpdateGenerateButton('video');
        // HF-5 #10 — same headline counter as the image table.
        sbbUpdateProgressBadge('video');
        // PR-A — keep the Compose panel reference summary and the Video
        // Assembly scene-videos textarea in lock-step with the batch.
        // Both no-op when nothing has changed; both respect user edits.
        try { psRefreshReferenceVideos(); } catch (_e) { /* tolerant */ }
        try { paAutoFillScenesFromBatch(); } catch (_e) { /* tolerant */ }
    }

    /**
     * PR-29 / PR-46 — update the "Generate images / videos" primary
     * button to reflect the current selection state.
     *
     *   - 0 rows in the table → label "Generate images / videos",
     *     enabled. Cold-start affordance: clicking it just shows
     *     a friendly empty-state hint.
     *   - 0 selected, ≥1 row → label "Generate all (N)", enabled.
     *     Matches the user's stated requirement from the live-E2E
     *     backlog ("When nothing checked, show 'Generate all (60)'
     *     as fallback"). PR-29 originally disabled the button in
     *     this state, but that broke the natural flow where a user
     *     pairs one image and clicks Generate without first ticking
     *     a checkbox — the help-text below the panel even tells them
     *     to "Click Generate videos to start I2V", contradicting
     *     the disabled state.
     *   - ≥1 selected → label "Generate selected (M)", enabled.
     *     User explicitly opted into a subset, scope the run to
     *     that subset.
     *
     * The button never disables itself when rows are present — that
     * way the affordance stays consistent and the user never has to
     * hunt for why Generate is greyed out.
     */
    function sbbUpdateGenerateButton(kind) {
        const btn = document.querySelector(
            `button[data-run="storyboard-batch-${kind === 'video' ? 'video' : 'image'}"]`,
        );
        if (!btn) return;
        const rows = kind === 'video' ? sbbState.videoRows : sbbState.imageRows;
        const selected = kind === 'video' ? sbbState.videoSelected : sbbState.imageSelected;
        const noun = kind === 'video' ? 'videos' : 'images';
        const selSize = (selected && typeof selected.size === 'number') ? selected.size : 0;

        // PR-B — gate the Video Generate button when running in I2V
        // mode and zero image rows have settled with an ``image_path``
        // on disk. The user's natural flow is "generate images → see
        // them → generate videos that use those images as the hero
        // frame", and clicking Generate videos before any image
        // exists silently produces zero-byte / fallback videos. T2V
        // mode skips the gate since it doesn't need a hero image.
        // The image-side button is never gated this way — it has its
        // own pre-conditions (scenes parsed first, handled by the
        // empty-rows branch below).
        if (kind === 'video') {
            const helpers = window.StoryboardBatchHelpers;
            const settled = (helpers && typeof helpers.countSettledImageRows === 'function')
                ? helpers.countSettledImageRows(sbbState.imageRows)
                : 0;
            const modeEl = $('sbb-video-mode');
            const mode = (modeEl && modeEl.value) || 'i2v';
            if (mode === 'i2v' && settled === 0) {
                btn.textContent = 'Generate videos';
                btn.setAttribute('disabled', 'disabled');
                btn.title = 'Tạo ảnh trước — I2V cần ảnh đã sinh xong làm hero frame. (Hoặc chuyển sang T2V để bỏ qua bước này.)';
                return;
            }
        }

        if (!rows.length) {
            btn.textContent = `Generate ${noun}`;
            btn.removeAttribute('disabled');
            btn.title = `Auto-fill from scenes first to populate the table, then click Generate.`;
            return;
        }
        if (selSize === 0) {
            btn.textContent = `Generate all (${rows.length})`;
            btn.removeAttribute('disabled');
            btn.title = `Run ${noun} generation on all ${rows.length} row${rows.length === 1 ? '' : 's'}. Tick checkboxes above to scope a smaller run.`;
            return;
        }
        btn.textContent = `Generate selected (${selSize})`;
        btn.removeAttribute('disabled');
        btn.title = `Run ${noun} generation on the ${selSize} selected row${selSize === 1 ? '' : 's'}.`;
    }

    /**
     * Render a per-row table for either kind. Same column layout for
     * both so the panels are visually consistent:
     * select | # | scene | prompt | status | output | actions.
     *
     * PR-27: prepended checkbox column, prepended bulk-action toolbar,
     * promoted Edit / Delete to per-row buttons, and added an
     * inline-edit textarea state when the user clicks Edit. Settled
     * rows can't be edited (file already on disk) but can still be
     * deleted with a confirm prompt.
     */
    function sbbRenderTable(rows, kind) {
        const helpers = window.StoryboardBatchHelpers;
        const summary = helpers.summarizeRows(rows);
        const selected = sbbGetSelected(kind);
        const selSummary = (typeof helpers.summarizeSelection === 'function')
            ? helpers.summarizeSelection(rows, selected)
            : { total: 0, editable: 0, deletable: 0, inFlight: 0, scenes: new Set() };
        const summaryStr = `total ${summary.total}`
            + (summary.generated ? ` · ${summary.generated} done` : '')
            + (summary.generating ? ` · ${summary.generating} generating` : '')
            + (summary.fallback ? ` · ${summary.fallback} failed` : '')
            + (summary.skipped ? ` · ${summary.skipped} skipped` : '');
        // PR-27 — bulk-action toolbar. The toolbar is always visible
        // (even with 0 selected) so the affordance is discoverable
        // before the user clicks any checkbox.
        const allRowIds = (typeof helpers.selectAllRowIds === 'function')
            ? helpers.selectAllRowIds(rows)
            : new Set();
        const allSelected = allRowIds.size > 0 && allRowIds.size === selected.size
            && [...allRowIds].every((id) => selected.has(id));
        const noneSelected = selected.size === 0;
        const selStr = noneSelected ? 'no rows selected' : `${selSummary.total} selected`;
        const rerollDisabled = noneSelected || selSummary.scenes.size === 0;
        let html = `<div class="stats-row"><span>${escapeHtml(summaryStr)}</span></div>`;
        html += `<div class="sbb-toolbar" data-sbb-toolbar="${escapeHtml(kind)}">`
            + `<span class="sbb-toolbar-summary">${escapeHtml(selStr)}</span>`
            + `<button class="secondary" data-sbb-bulk="select-all" data-sbb-kind="${escapeHtml(kind)}"`
            + `${rows.length === 0 ? ' disabled' : ''}>${allSelected ? 'Deselect all' : 'Select all'}</button>`
            + `<button class="secondary" data-sbb-bulk="reroll" data-sbb-kind="${escapeHtml(kind)}"`
            + ` title="Re-roll variant prompts for the selected scenes using the current Visual DNA. Settled / in-flight rows are left alone."`
            + `${rerollDisabled || kind !== 'image' ? ' disabled' : ''}>Re-roll variants</button>`
            + `<button class="secondary danger" data-sbb-bulk="delete" data-sbb-kind="${escapeHtml(kind)}"`
            + ` title="Drop the selected rows from the table. Generated assets stay on disk."`
            + `${noneSelected ? ' disabled' : ''}>Delete selected</button>`
            + `</div>`;
        // Video table includes a Source column that previews the
        // hero image paired by ``pairImagePathsForI2V`` so the user
        // can confirm which still each video row will animate from
        // before pressing Generate. The image table omits this
        // column — it has its own Output thumbnail already.
        const sourceHeader = kind === 'video' ? '<th>Source</th>' : '';
        html += `<table class="swc-table"><thead><tr>
            <th class="sbb-select-cell"><input type="checkbox" data-sbb-bulk="header-select"
                data-sbb-kind="${escapeHtml(kind)}"
                ${allSelected ? 'checked' : ''}
                ${rows.length === 0 ? 'disabled' : ''} /></th>
            <th>#</th><th>Scene</th>${sourceHeader}<th>Prompt</th><th>Status</th><th>Output</th><th>Actions</th>
        </tr></thead><tbody>`;
        // PR-24: count variants per scene_id so we can render
        // "scene N · variant K/M" labels — without this every variant
        // row looks identical to the next one and the user can't tell
        // a 60-row table apart from a duplicated 1-row scene.
        const variantTotals = (typeof helpers.buildVariantTotals === 'function')
            ? helpers.buildVariantTotals(rows)
            : new Map();
        const editKey = sbbState.editingRowKey;
        for (const r of rows) {
            const label = helpers.statusLabel(r.status);
            const cls = helpers.statusClass(r.status);
            // PR-29: surface the row's reason (Grok error string,
            // moderation hint, etc.) as a `title=` tooltip on the pill
            // so the user can hover-discover it even when the inline
            // <div class="reason"> is wrapped or off-screen on a tall
            // table.
            const pillTitle = (r.reason && (r.status === 'fallback' || r.status === 'skipped'))
                ? ` title="${escapeHtml(r.reason)}"` : '';
            let statusCell = `<span class="pill ${escapeHtml(cls)}"${pillTitle}>${escapeHtml(label)} (${escapeHtml(r.attempts || 0)}x)</span>`;
            if (r.status === 'generating') {
                statusCell += `<div class="progress-bar"><div style="width:${escapeHtml(r.progress || 0)}%"></div></div>`;
            }
            if (r.reason && (r.status === 'fallback' || r.status === 'skipped')) {
                statusCell += `<div class="reason">${escapeHtml(r.reason)}</div>`;
            }
            let outCell = '<span class="muted">—</span>';
            const outPath = kind === 'image' ? r.image_path : r.video_path;
            if (outPath) {
                if (kind === 'image' && r.url) {
                    outCell = `<div class="thumb-cell"><img src="${escapeHtml(r.url)}" alt="scene ${escapeHtml(r.scene_id)}" /></div>`;
                } else if (kind === 'video' && r.url) {
                    outCell = `<div class="thumb-cell"><video src="${escapeHtml(r.url)}" muted playsinline preload="metadata"></video></div>`;
                } else {
                    outCell = `<div class="thumb-cell"><div class="thumb-placeholder">loading…</div></div>`;
                }
                outCell += `<div class="reason"><code>${escapeHtml(outPath)}</code></div>`;
            }
            const sceneCellLabel = (typeof helpers.formatVariantLabel === 'function')
                ? helpers.formatVariantLabel(r, variantTotals)
                : `scene ${r.scene_id != null ? r.scene_id : '?'}`;
            const refBadge = kind === 'image' ? sbbRenderRefBadge(r) : '';
            // Per-row "Make video" chip on settled image rows so the
            // user can bridge an image → video without leaving the
            // batch panel.
            let bridgeChip = '';
            if (kind === 'image' && r.status === 'generated' && outPath) {
                bridgeChip = ` <a href="#" class="bridge-chip" data-sbb-make-video="${escapeHtml(r.scene_id != null ? r.scene_id : '')}" data-sbb-make-video-row="${escapeHtml(r.row_id || '')}">▶ Make video</a>`;
            }
            const baseActions = outPath ? sbbRenderPathActions(outPath) : '';
            const editable = (typeof helpers.canEditRow === 'function') ? helpers.canEditRow(r) : true;
            const deletable = (typeof helpers.canDeleteRow === 'function') ? helpers.canDeleteRow(r) : true;
            const editTitle = editable
                ? 'Edit prompt before generating'
                : (r.status === 'generating'
                    ? 'Cannot edit — row is generating; cancel via Delete first'
                    : 'Cannot edit a settled row — output is already on disk');
            const editBtn = `<button class="sbb-icon-btn" data-sbb-row-action="edit"`
                + ` data-sbb-kind="${escapeHtml(kind)}" data-sbb-row="${escapeHtml(r.row_id || '')}"`
                + ` title="${escapeHtml(editTitle)}"${editable ? '' : ' disabled'}>Edit</button>`;
            const delBtn = `<button class="sbb-icon-btn danger" data-sbb-row-action="delete"`
                + ` data-sbb-kind="${escapeHtml(kind)}" data-sbb-row="${escapeHtml(r.row_id || '')}"`
                + ` title="Drop this row from the table"${deletable ? '' : ' disabled'}>Delete</button>`;
            // PR-29 — per-row Retry button for failed rows. The
            // handler (`sbbRetryRow`) re-runs exactly this row's
            // generation regardless of the current bulk-select set,
            // so the user can recover one row without re-checking the
            // selection or running the whole batch again.
            const retryBtn = (r.status === 'fallback')
                ? `<button class="sbb-icon-btn" data-sbb-row-action="retry"`
                    + ` data-sbb-kind="${escapeHtml(kind)}" data-sbb-row="${escapeHtml(r.row_id || '')}"`
                    + ` title="Re-run just this row">Retry</button>`
                : '';
            const refButtons = kind === 'image' ? sbbRenderRefRowButtons(r) : '';
            const rowActions = `<div class="sbb-row-actions">${editBtn}${retryBtn}${delBtn}${refButtons}${baseActions}${bridgeChip}</div>`;
            const rowKey = `${kind}:${r.row_id}`;
            const inEdit = editKey === rowKey;
            // PR-46 — wrap the prompt body in a clamp container so a
            // 250-word variant prompt only consumes ~5 lines until
            // the user clicks to expand. Edit-mode bypasses the clamp
            // so the textarea can size freely.
            const promptCell = inEdit
                ? sbbRenderEditShell(kind, r)
                : sbbRenderPromptCell(kind, r);
            // Source cell — only emitted for the video table.
            // Three states:
            //   1. ``source_image_url`` resolved → render <img> thumb.
            //   2. Only ``image_path`` populated → render placeholder
            //      ("loading…") so the user sees the pairing landed
            //      even before getFileUrl resolves.
            //   3. No image_path → muted "no image yet" hint, makes
            //      the I2V gate state visually obvious next to the
            //      already-disabled Generate button.
            let sourceCell = '';
            if (kind === 'video') {
                if (r.source_image_url) {
                    sourceCell = `<td><div class="thumb-cell"><img src="${escapeHtml(r.source_image_url)}" alt="hero for scene ${escapeHtml(r.scene_id)}" /></div></td>`;
                } else if (r.image_path) {
                    sourceCell = `<td><div class="thumb-cell"><div class="thumb-placeholder">loading…</div></div></td>`;
                } else {
                    sourceCell = `<td><span class="muted">no image yet</span></td>`;
                }
            }
            const isSelected = selected.has(String(r.row_id));
            const trCls = isSelected ? ' class="sbb-row-selected"' : '';
            html += `<tr${trCls}>
                <td class="sbb-select-cell"><input type="checkbox" data-sbb-row-select="${escapeHtml(r.row_id || '')}" data-sbb-kind="${escapeHtml(kind)}" ${isSelected ? 'checked' : ''} /></td>
                <td class="scene-num">${escapeHtml(r.order)}</td>
                <td><b>${escapeHtml(sceneCellLabel)}</b>${refBadge}<div class="reason">${escapeHtml(r.title)} · ${escapeHtml((typeof r.duration_s === 'number') ? r.duration_s.toFixed(1) : r.duration_s)}s</div></td>
                ${sourceCell}
                <td class="prompt-cell">${promptCell}</td>
                <td>${statusCell}</td>
                <td>${outCell}</td>
                <td class="actions">${rowActions}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        return html;
    }

    /**
     * PR-46 — render a clamp-wrapped read-only prompt cell. The
     * outer wrapper carries ``data-sbb-prompt-toggle`` so the
     * delegated click handler can flip ``is-expanded`` on the same
     * element. Long prompts default to clamped (5 lines via CSS);
     * "click to expand" / "click to collapse" hint inside the
     * wrapper appears on hover. The expansion state is keyed by
     * ``kind:row_id`` so re-renders preserve the user's choice for
     * the rows they've already opened — without that, every
     * progress tick on a sibling row would silently re-collapse the
     * one the user just opened.
     */
    function sbbRenderPromptCell(kind, row) {
        const rowId = row && row.row_id != null ? String(row.row_id) : '';
        const key = `${kind}:${rowId}`;
        const expanded = sbbState.promptExpanded && sbbState.promptExpanded.has(key);
        const cls = expanded ? 'prompt-cell-content is-expanded' : 'prompt-cell-content';
        const hint = expanded ? 'click to collapse ↑' : 'click to expand ↓';
        return `<div class="${cls}" data-sbb-prompt-toggle="${escapeHtml(key)}">`
            + `<div class="prompt-cell-body">${escapeHtml(row.prompt || '')}</div>`
            + `<span class="prompt-cell-hint">${escapeHtml(hint)}</span>`
            + `</div>`;
    }

    /**
     * PR-46 — toggle the expansion state of a single clamped prompt
     * cell. Repaints just the affected kind so progress on the other
     * table doesn't re-collapse this user's open cell. The state
     * lives in ``sbbState.promptExpanded`` (Set<"kind:row_id">) so
     * the renderer's ``sbbRenderPromptCell`` call picks it up on the
     * next paint without needing a separate DOM walk.
     */
    function sbbTogglePromptExpansion(key) {
        if (!key) return;
        if (!sbbState.promptExpanded) sbbState.promptExpanded = new Set();
        if (sbbState.promptExpanded.has(key)) {
            sbbState.promptExpanded.delete(key);
        } else {
            sbbState.promptExpanded.add(key);
        }
        const kind = key.split(':')[0];
        if (kind === 'image') sbbRepaintImage();
        else if (kind === 'video') sbbRepaintVideo();
    }

    /**
     * PR-27 — inline-edit shell for the prompt cell. A textarea
     * pre-filled with the row's current prompt + Save / Cancel
     * buttons. The textarea uses ``data-sbb-edit-input`` so the
     * delegated change handler can read its value back without
     * needing an id.
     */
    function sbbRenderEditShell(kind, row) {
        const draft = sbbState.editingDraft != null ? sbbState.editingDraft : (row.prompt || '');
        return `<div class="sbb-edit-shell" data-sbb-edit-shell="${escapeHtml(kind)}:${escapeHtml(row.row_id || '')}">`
            + `<textarea class="sbb-edit-input" data-sbb-edit-input="${escapeHtml(kind)}:${escapeHtml(row.row_id || '')}" rows="3">${escapeHtml(draft)}</textarea>`
            + `<div class="sbb-edit-actions">`
            + `<button class="sbb-icon-btn" data-sbb-edit-action="save" data-sbb-kind="${escapeHtml(kind)}" data-sbb-row="${escapeHtml(row.row_id || '')}" title="Save prompt edit (Enter)">Save</button>`
            + `<button class="sbb-icon-btn" data-sbb-edit-action="cancel" data-sbb-kind="${escapeHtml(kind)}" data-sbb-row="${escapeHtml(row.row_id || '')}" title="Cancel edit (Esc)">Cancel</button>`
            + `</div>`
            + `</div>`;
    }

    /** Per-kind selection accessor. */
    function sbbGetSelected(kind) {
        return kind === 'video' ? sbbState.videoSelected : sbbState.imageSelected;
    }

    /** Per-kind rows accessor. */
    function sbbGetRows(kind) {
        return kind === 'video' ? sbbState.videoRows : sbbState.imageRows;
    }

    /** Per-kind rows mutator. */
    function sbbSetRows(kind, rows) {
        if (kind === 'video') sbbState.videoRows = rows;
        else sbbState.imageRows = rows;
    }

    /** Per-kind selection mutator. */
    function sbbSetSelected(kind, selected) {
        if (kind === 'video') sbbState.videoSelected = selected;
        else sbbState.imageSelected = selected;
    }

    /** Repaint the right side of the panel after a kind-specific change. */
    function sbbRepaintKind(kind) {
        if (kind === 'video') sbbRepaintVideo(); else sbbRepaintImage();
    }

    function sbbRenderPathActions(path) {
        if (!path) return '';
        const safe = String(path).replace(/"/g, '&quot;');
        if (api && typeof api.openPath === 'function') {
            return `<span class="actions"><a href="#" data-swc-open="${safe}">open</a> <a href="#" data-swc-show="${safe}">show in folder</a></span>`;
        }
        return '';
    }

    /**
     * PR-28 — render the per-row ref-state badge next to the scene
     * label so the user can see at a glance whether a row will go
     * through ``image:generate`` (no badge) or ``refimg:generate``
     * (badge with ref count + "global" / "override" qualifier).
     * Always returns a string; never mutates anything.
     */
    function sbbRenderRefBadge(row) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers || typeof helpers.resolveRefsForRow !== 'function') return '';
        const refs = helpers.resolveRefsForRow(row, sbbState.rowRefMap, sbbState.globalRefs);
        if (!refs.length) return '';
        const override = sbbState.rowRefMap[String(row.row_id)];
        const hasOverride = Array.isArray(override) && override.length > 0;
        const cls = hasOverride ? '' : ' is-global';
        const label = hasOverride ? `📎 ${refs.length} override` : `📎 ${refs.length} global`;
        const tipPaths = refs.map((p) => sbbBasename(p)).join('\n');
        const title = (hasOverride ? 'Per-row override:' : 'From global ref list:') + '\n' + tipPaths;
        return `<span class="sbb-row-ref${cls}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
    }

    /** PR-28 — per-row ref buttons: Refs (open picker) + Clear-override (when present). */
    function sbbRenderRefRowButtons(row) {
        const rowId = row && row.row_id != null ? String(row.row_id) : '';
        if (!rowId) return '';
        const override = sbbState.rowRefMap[rowId];
        const hasOverride = Array.isArray(override) && override.length > 0;
        const refsBtn = `<button class="sbb-icon-btn" data-sbb-row-action="refs"`
            + ` data-sbb-kind="image" data-sbb-row="${escapeHtml(rowId)}"`
            + ` title="${escapeHtml(hasOverride ? 'Replace this row\'s reference images (currently: ' + override.length + ' file' + (override.length === 1 ? '' : 's') + ')' : 'Attach reference images for this row only — overrides the global list')}">Refs${hasOverride ? ` (${override.length})` : ''}</button>`;
        let clearBtn = '';
        if (hasOverride) {
            clearBtn = `<button class="sbb-icon-btn" data-sbb-row-action="clear-refs"`
                + ` data-sbb-kind="image" data-sbb-row="${escapeHtml(rowId)}"`
                + ` title="Drop the per-row override — falls back to the global ref list">Clear refs</button>`;
        }
        return refsBtn + clearBtn;
    }

    /** Cross-platform basename (no Node ``path`` available in the renderer). */
    function sbbBasename(p) {
        const s = String(p || '');
        const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return i >= 0 ? s.slice(i + 1) : s;
    }

    /** PR-28 — render the global ref list under the Storyboard panel. */
    function sbbRenderGlobalRefs() {
        const list = $('sb-ref-list');
        const status = $('sb-ref-status');
        if (!list) return;
        const refs = sbbState.globalRefs || [];
        if (status) {
            status.textContent = refs.length
                ? `${refs.length} ref image${refs.length === 1 ? '' : 's'} attached`
                : 'no global refs attached';
        }
        if (!refs.length) {
            list.innerHTML = '';
            return;
        }
        list.innerHTML = refs.map((p, i) => `<li>
            <span class="ref-path" title="${escapeHtml(p)}">${escapeHtml(sbbBasename(p))}</span>
            <button class="ghost" data-sbb-ref-remove="${escapeHtml(String(i))}" title="Remove this ref from the global list">✕</button>
        </li>`).join('');
    }

    /** PR-28 — file picker entry-point shared by global + per-row attach. */
    async function sbbPickRefImageFiles() {
        if (!api || typeof api.selectFiles !== 'function') return [];
        try {
            const paths = await api.selectFiles({
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
            });
            return Array.isArray(paths) ? paths : [];
        } catch (err) {
            console.warn('[sbb] selectFiles failed:', err && err.message);
            return [];
        }
    }

    async function sbbAddGlobalRefs() {
        const picked = await sbbPickRefImageFiles();
        if (!picked.length) return;
        const merged = (sbbState.globalRefs || []).slice();
        for (const p of picked) if (!merged.includes(p)) merged.push(p);
        sbbState.globalRefs = merged;
        sbbRenderGlobalRefs();
        sbbRepaintImage();
    }

    function sbbRemoveGlobalRef(idx) {
        const i = parseInt(idx, 10);
        const refs = (sbbState.globalRefs || []).slice();
        if (!Number.isFinite(i) || i < 0 || i >= refs.length) return;
        refs.splice(i, 1);
        sbbState.globalRefs = refs;
        sbbRenderGlobalRefs();
        sbbRepaintImage();
    }

    function sbbClearGlobalRefs() {
        if (!sbbState.globalRefs.length) return;
        sbbState.globalRefs = [];
        sbbRenderGlobalRefs();
        sbbRepaintImage();
    }

    async function sbbAddRowRefs(rowId) {
        const key = String(rowId || '');
        if (!key) return;
        const picked = await sbbPickRefImageFiles();
        if (!picked.length) return;
        // Replace, not merge, so a re-pick is the user's clear way to
        // override the previous list. (Use the ✕ button to drop a single ref.)
        sbbState.rowRefMap = Object.assign({}, sbbState.rowRefMap, { [key]: picked.slice() });
        sbbRepaintImage();
    }

    function sbbClearRowRefs(rowId) {
        const key = String(rowId || '');
        if (!key) return;
        if (!sbbState.rowRefMap[key]) return;
        const next = Object.assign({}, sbbState.rowRefMap);
        delete next[key];
        sbbState.rowRefMap = next;
        sbbRepaintImage();
    }

    /**
     * Resolve thumbnail file:// URLs after a phase settles. Reuses
     * `electronAPI.getFileUrl` (same approach as PR-20C).
     *
     * For ``kind === 'video'`` we also resolve a thumbnail URL for
     * the row's paired *hero image* (``image_path`` populated by
     * ``pairImagePathsForI2V``) into ``source_image_url`` so the
     * video table can render a still preview of the I2V seed image
     * before the I2V job emits any output of its own.
     */
    async function sbbResolveUrls(rows, kind) {
        if (!api || typeof api.getFileUrl !== 'function') return;
        const tasks = [];
        rows.forEach((row) => {
            const pathField = kind === 'image' ? row.image_path : row.video_path;
            if (pathField && !row.url) {
                tasks.push(api.getFileUrl(pathField).then((res) => {
                    if (res && res.success && res.url) row.url = res.url;
                }).catch(() => {}));
            }
            if (kind === 'video' && row.image_path && !row.source_image_url) {
                tasks.push(api.getFileUrl(row.image_path).then((res) => {
                    if (res && res.success && res.url) row.source_image_url = res.url;
                }).catch(() => {}));
            }
        });
        if (!tasks.length) return;
        await Promise.all(tasks);
        if (kind === 'image') sbbRepaintImage(); else sbbRepaintVideo();
    }

    /** Install a single shared progress listener for both image + video phases. */
    function sbbInstallListener() {
        if (sbbState.listenerInstalled) return;
        if (!api || typeof api.onProgress !== 'function') return;
        api.onProgress((data) => {
            if (!data || !data.progress) return;
            const helpers = window.StoryboardBatchHelpers;
            const { jobId, progress } = data;
            const idx = (progress && typeof progress.globalIdx === 'number') ? progress.globalIdx : -1;
            if (jobId === 'image' && idx >= 0 && idx < sbbState.currentImageBatchSceneIds.length) {
                // PR-23: prefer row_id (variant-precise) over scene_id so
                // progress for variant N doesn't bleed into siblings.
                const rid = (sbbState.currentImageBatchRowIds && sbbState.currentImageBatchRowIds[idx])
                    || sbbState.currentImageBatchSceneIds[idx];
                sbbState.imageRows = helpers.applyBatchProgress(sbbState.imageRows, rid, progress);
                sbbRepaintImage();
            } else if ((jobId === 'i2v' || jobId === 'video') && idx >= 0 && idx < sbbState.currentVideoBatchSceneIds.length) {
                const rid = (sbbState.currentVideoBatchRowIds && sbbState.currentVideoBatchRowIds[idx])
                    || sbbState.currentVideoBatchSceneIds[idx];
                sbbState.videoRows = helpers.applyBatchProgress(sbbState.videoRows, rid, progress);
                sbbRepaintVideo();
            }
        });
        sbbState.listenerInstalled = true;
    }

    /**
     * Apply a derived banner state (from
     * `StoryboardLoginBannerHelpers.deriveBannerState(...)`) to the
     * DOM. Always-visible — no `hidden` toggling — the banner colour
     * + dot encodes the state.
     */
    function sbbRenderBanner(state) {
        const banner = $('sbb-login-banner');
        if (!banner || !state) return;
        const msgEl = banner.querySelector('span');
        const btnEl = banner.querySelector('button');
        // Reset state classes; keep the base `banner` class.
        banner.classList.remove('ready', 'stale', 'no-accounts', 'unknown');
        banner.classList.add(state.cssClass);
        banner.hidden = false;
        if (msgEl && typeof state.text === 'string') {
            msgEl.textContent = state.text;
        }
        if (btnEl) {
            if (typeof state.buttonText === 'string') {
                btnEl.textContent = state.buttonText;
            }
            if (typeof state.buttonAction === 'string') {
                btnEl.setAttribute('data-run', state.buttonAction);
            }
        }
    }

    /**
     * Structured session check for the always-on login banner.
     *
     * PR-21: the banner is now ALWAYS visible — `ready` shows green,
     * `stale` shows yellow, `no_accounts` shows red, `unknown` (IPC
     * blip / loading) shows neutral. The mapping from raw IPC payload
     * to renderer state lives in `storyboard_login_banner_helpers.js`
     * so it can be unit-tested under plain Node.
     *
     * PR-20E: this prefers `auth:getSessionStatus` (returns
     * `{ status, reason, ready_count, configured_count, ... }` with
     * NO cookies/headers/tokens) and falls back to `auth:getAccounts`
     * for older preloads.
     */
    async function sbbCheckSession() {
        const banner = $('sbb-login-banner');
        if (!banner) return;
        const helpers = window.StoryboardLoginBannerHelpers;
        if (!helpers) {
            // Renderer-side helper missing — keep the existing banner
            // text and just stop. Don't crash the panel.
            return;
        }
        if (!api || !api.auth) {
            sbbRenderBanner(helpers.deriveBannerState({
                status: 'unknown',
                reason: 'auth IPC unavailable — rebuild Electron.',
            }));
            return;
        }
        if (typeof api.auth.getSessionStatus === 'function') {
            try {
                const res = await api.auth.getSessionStatus();
                const state = helpers.deriveBannerState(res);
                // PR-22: if accounts.json has at least one entry but the
                // session isn't ready, prefer the programmatic auto-login
                // CTA over "Open manual login" — keeps the user one
                // click away from headful Puppeteer.
                const amh = window.StoryboardAccountManagerHelpers;
                if (amh && state.status !== 'ready') {
                    const cta = amh.deriveBannerCta(res);
                    if (cta && cta.action) {
                        state.buttonAction = cta.action;
                        state.buttonText = cta.label;
                    }
                }
                sbbRenderBanner(state);
                sbbState.sessionKnown = state.status === 'ready';
                return;
            } catch (_) {
                // fall through to the legacy check.
            }
        }
        if (typeof api.auth.getAccounts !== 'function') {
            sbbRenderBanner(helpers.deriveBannerState({
                status: 'unknown',
                reason: 'getSessionStatus / getAccounts IPC unavailable — rebuild Electron.',
            }));
            return;
        }
        try {
            const res = await api.auth.getAccounts();
            const state = helpers.deriveBannerStateFromAccounts(res);
            sbbRenderBanner(state);
            sbbState.sessionKnown = state.status === 'ready';
        } catch (_) {
            sbbRenderBanner(helpers.deriveBannerState({
                status: 'unknown',
                reason: 'getAccounts IPC threw — try Open manual login.',
            }));
        }
    }

    function sbbAutoFill() {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) {
            $('sbb-image-result').innerHTML = '<div class="error">storyboard_batch_helpers.js failed to load — rebuild Electron.</div>';
            return;
        }
        const scenes = (state.lastScenes || []).slice();
        if (!scenes.length) {
            $('sbb-image-result').innerHTML = '<div class="error">No scenes in memory. Run "Break into scenes" above first.</div>';
            $('sbb-video-result').innerHTML = '';
            return;
        }
        const imagesPerScene = sbbReadVariantCount('sbb-images-per-scene', 4);
        // HF-5 #12 — Pro mode is always-on so videos-per-scene is hardcoded
        // to 1. The hidden <select id="sbb-videos-per-scene"> is preserved
        // for backward compat with any code path still reading that id.
        const videosPerScene = 1;
        sbbState.imageRows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene });
        sbbState.videoRows = helpers.initVideoRowsFromScenes(scenes, { videosPerScene });
        sbbRepaintAll();
    }

    /**
     * PR-27 — keep the Batch image-rows table in sync with the latest
     * scene_breakdown response. Called automatically from
     * renderSceneBreakdown so the user sees image_prompts variants
     * without clicking "Auto-fill from scenes" first. Settled / in-
     * flight rows are NOT clobbered: when the existing rows already
     * cover the same scene_id × variant_idx grid we leave the table
     * alone so progress and outputs stay attached to their rows. Any
     * other case (no rows yet, scene set changed, variant count
     * changed) does a full refresh.
     */
    function sbbSyncFromScenes(scenes) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers || !Array.isArray(scenes)) return;
        const imagesPerScene = state.lastImagesPerScene || sbbReadVariantCount('sbb-images-per-scene', 4);
        const expectedRowIds = new Set();
        for (const s of scenes) {
            if (!s || s.scene_id == null) continue;
            for (let v = 0; v < imagesPerScene; v += 1) {
                expectedRowIds.add(`${s.scene_id}#${v}`);
            }
        }
        const existing = new Set();
        let hasInFlight = false;
        for (const r of sbbState.imageRows) {
            existing.add(String(r.row_id));
            if (r.status === 'generating') hasInFlight = true;
        }
        // Same scene/variant grid + something is settled or generating
        // → leave the table alone. Otherwise rebuild from scratch.
        let sameGrid = expectedRowIds.size === existing.size;
        if (sameGrid) {
            for (const id of expectedRowIds) {
                if (!existing.has(id)) { sameGrid = false; break; }
            }
        }
        if (sameGrid && (hasInFlight || sbbState.imageRows.some((r) => r.status === 'generated' || r.status === 'retried'))) {
            return;
        }
        sbbState.imageRows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene });
        // HF-5 #12 — Pro mode is always-on; video rows always pair 1:1
        // with their image variant.
        const videosPerScene = 1;
        sbbState.videoRows = helpers.initVideoRowsFromScenes(scenes, { videosPerScene });
        // Drop any selection that no longer matches a row.
        sbbState.imageSelected = helpers.reconcileSelection(sbbState.imageSelected, sbbState.imageRows);
        sbbState.videoSelected = helpers.reconcileSelection(sbbState.videoSelected, sbbState.videoRows);
        sbbRepaintAll();
    }

    /**
     * PR-27 — flip a single row's selection state for the given kind
     * and repaint just that table.
     */
    function sbbToggleRow(kind, rowId) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const next = helpers.toggleRowSelection(sbbGetSelected(kind), rowId);
        sbbSetSelected(kind, next);
        sbbRepaintKind(kind);
    }

    /**
     * PR-27 — header checkbox / "Select all" button. When some rows
     * are selected, clicking selects everything; when ALL rows are
     * selected, clicking deselects everything. Mirrors the typical
     * spreadsheet UX.
     */
    function sbbToggleSelectAll(kind) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const rows = sbbGetRows(kind);
        const selected = sbbGetSelected(kind);
        const allIds = helpers.selectAllRowIds(rows);
        const isAll = allIds.size > 0 && selected.size === allIds.size
            && [...allIds].every((id) => selected.has(id));
        sbbSetSelected(kind, isAll ? new Set() : allIds);
        sbbRepaintKind(kind);
    }

    /**
     * PR-27 — enter inline-edit mode for a single row. Settled rows
     * are guarded at the helper layer; the click handler also disables
     * the button itself so this is mostly belt-and-braces.
     */
    function sbbBeginEdit(kind, rowId) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const rows = sbbGetRows(kind);
        const row = rows.find((r) => String(r.row_id) === String(rowId));
        if (!row || !helpers.canEditRow(row)) return;
        sbbState.editingRowKey = `${kind}:${rowId}`;
        sbbState.editingDraft = row.prompt || '';
        sbbRepaintKind(kind);
        // Focus the textarea after the repaint so the user can start
        // typing immediately.
        setTimeout(() => {
            const ta = document.querySelector(`textarea[data-sbb-edit-input="${kind}:${rowId}"]`);
            if (ta) {
                ta.focus();
                const len = ta.value.length;
                try { ta.setSelectionRange(len, len); } catch (_) { /* IE polyfill not needed */ }
            }
        }, 0);
    }

    /** PR-27 — commit the in-progress edit back into the row. */
    function sbbSaveEdit(kind, rowId) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        // Read the textarea's current value first — input handler keeps
        // the draft in sync, but during a programmatic save we want to
        // be defensive and re-read in case a frame was dropped.
        const ta = document.querySelector(`textarea[data-sbb-edit-input="${kind}:${rowId}"]`);
        const draft = ta ? ta.value : (sbbState.editingDraft || '');
        sbbSetRows(kind, helpers.updatePromptForRow(sbbGetRows(kind), rowId, draft));
        sbbState.editingRowKey = null;
        sbbState.editingDraft = '';
        sbbRepaintKind(kind);
    }

    /** PR-27 — abandon the in-progress edit; the row keeps its old prompt. */
    function sbbCancelEdit(kind) {
        sbbState.editingRowKey = null;
        sbbState.editingDraft = '';
        sbbRepaintKind(kind || 'image');
    }

    /** PR-27 — drop a single row from the table. */
    function sbbDeleteRow(kind, rowId) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const rows = sbbGetRows(kind);
        const row = rows.find((r) => String(r.row_id) === String(rowId));
        if (!row) return;
        // Confirm before nuking a settled / in-flight row so the user
        // doesn't lose progress by accident. Pending / fallback /
        // skipped rows delete silently — the asset cost was zero.
        if (row.status === 'generating' || row.status === 'generated' || row.status === 'retried') {
            const msg = row.status === 'generating'
                ? `Cancel scene ${row.scene_id} variant ${(row.variant_idx || 0) + 1}? The Grok call will keep running but its result will be ignored.`
                : `Drop scene ${row.scene_id} variant ${(row.variant_idx || 0) + 1}? The generated file stays on disk.`;
            if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
        }
        sbbSetRows(kind, helpers.removeRows(rows, [rowId]));
        sbbSetSelected(kind, helpers.reconcileSelection(sbbGetSelected(kind), sbbGetRows(kind)));
        // If we just deleted the row that was being edited, exit edit mode.
        if (sbbState.editingRowKey === `${kind}:${rowId}`) {
            sbbState.editingRowKey = null;
            sbbState.editingDraft = '';
        }
        // PR-28 — drop the per-row ref override so a recycled row_id
        // (e.g. user re-runs scene_breakdown) doesn't inherit stale refs.
        if (kind === 'image' && sbbState.rowRefMap[String(rowId)]) {
            const next = Object.assign({}, sbbState.rowRefMap);
            delete next[String(rowId)];
            sbbState.rowRefMap = next;
        }
        sbbRepaintKind(kind);
    }

    /** PR-27 — drop every selected row from the table (with confirm for batches >1). */
    function sbbDeleteSelected(kind) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const selected = sbbGetSelected(kind);
        if (!selected.size) return;
        const rows = sbbGetRows(kind);
        const summary = helpers.summarizeSelection(rows, selected);
        const settledOrInFlight = rows.filter((r) => selected.has(String(r.row_id)) && (r.status === 'generating' || r.status === 'generated' || r.status === 'retried')).length;
        let proceed = true;
        if (settledOrInFlight > 0 && typeof window.confirm === 'function') {
            const msg = `Drop ${selected.size} row${selected.size === 1 ? '' : 's'}? `
                + `${settledOrInFlight} of them ${settledOrInFlight === 1 ? 'is' : 'are'} settled or generating — files on disk stay, but in-flight Grok calls will have their results ignored.`;
            proceed = window.confirm(msg);
        }
        if (!proceed) return;
        sbbSetRows(kind, helpers.removeRows(rows, selected));
        sbbSetSelected(kind, new Set());
        // Clear edit mode if the edited row was in the doomed set.
        if (sbbState.editingRowKey && sbbState.editingRowKey.startsWith(`${kind}:`)) {
            const editedRowId = sbbState.editingRowKey.slice(kind.length + 1);
            if (selected.has(editedRowId)) {
                sbbState.editingRowKey = null;
                sbbState.editingDraft = '';
            }
        }
        // PR-28 — drop ref overrides for every deleted row so the map
        // doesn't accumulate stale entries.
        if (kind === 'image') {
            const next = Object.assign({}, sbbState.rowRefMap);
            let mutated = false;
            for (const id of selected) {
                if (next[String(id)]) { delete next[String(id)]; mutated = true; }
            }
            if (mutated) sbbState.rowRefMap = next;
        }
        // Suppress the unused-var warning from the linter — summary is
        // captured for future telemetry / status messaging.
        void summary;
        sbbRepaintKind(kind);
    }

    /**
     * PR-27 — re-roll variant prompts for every selected scene using
     * the current Visual DNA. Walks the unique scene_ids in the
     * selection, calls /producer/variant_prompts for each, and merges
     * results back via applyVariantPrompts. Settled / in-flight rows
     * are protected at the helper layer.
     *
     * Only the image table supports re-roll today; the video
     * table's prompts come from a different LLM path
     * (flow_video_prompt) which PR-27 does not change.
     */
    async function sbbRerollSelected(kind) {
        if (kind !== 'image') return; // toolbar disables it for video, but be defensive
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        if (!api || !api.storyboard || typeof api.storyboard.variantPrompts !== 'function') {
            const target = $('sbb-image-result');
            if (target) target.insertAdjacentHTML('afterbegin',
                '<div class="error">storyboard.variantPrompts IPC unavailable — rebuild Electron.</div>');
            return;
        }
        const selected = sbbGetSelected(kind);
        if (!selected.size) return;
        const rows = sbbGetRows(kind);
        // Collect the scene_ids touched by the selection, deduped.
        const sceneIds = new Set();
        const sceneMeta = new Map(); // scene_id → representative row (for the LLM payload)
        for (const r of rows) {
            if (!selected.has(String(r.row_id))) continue;
            if (r.scene_id == null) continue;
            sceneIds.add(String(r.scene_id));
            if (!sceneMeta.has(String(r.scene_id))) sceneMeta.set(String(r.scene_id), r);
        }
        if (!sceneIds.size) return;
        const dna = (state.lastVisualDna || (($('sb-visual-dna') || {}).value || '')).trim();
        const count = state.lastImagesPerScene || sbbReadVariantCount('sbb-images-per-scene', 4);
        // Match the matching scene from the original scene_breakdown
        // for richer context (title / narration / flow_video_prompt).
        const scenesById = new Map();
        for (const s of (state.lastScenes || [])) {
            if (s && s.scene_id != null) scenesById.set(String(s.scene_id), s);
        }
        const target = $('sbb-image-result');
        // Mark a transient hint so the user knows something's happening.
        if (target) {
            target.insertAdjacentHTML('afterbegin',
                `<div class="info" data-sbb-reroll-banner>Re-rolling variants for ${sceneIds.size} scene${sceneIds.size === 1 ? '' : 's'}…</div>`);
        }
        const warnings = [];
        for (const sid of sceneIds) {
            const fallbackRow = sceneMeta.get(sid);
            const sceneFromBreakdown = scenesById.get(sid);
            const sceneIn = {
                scene_id: Number(sid) || sid,
                title: (sceneFromBreakdown && sceneFromBreakdown.title) || (fallbackRow && fallbackRow.title) || '',
                narration: (sceneFromBreakdown && sceneFromBreakdown.narration) || '',
                image_prompt: (sceneFromBreakdown && sceneFromBreakdown.image_prompt) || (fallbackRow && fallbackRow.prompt) || '',
                flow_video_prompt: (sceneFromBreakdown && sceneFromBreakdown.flow_video_prompt) || '',
            };
            try {
                const res = await api.storyboard.variantPrompts({
                    scene: sceneIn,
                    count,
                    visual_dna: dna,
                });
                const prompts = res && Array.isArray(res.prompts) ? res.prompts : [];
                if (Array.isArray(res && res.warnings)) warnings.push(...res.warnings);
                sbbSetRows('image', helpers.applyVariantPrompts(sbbGetRows('image'), sid, prompts));
            } catch (err) {
                warnings.push(`scene ${sid}: ${(err && err.message) || err}`);
            }
        }
        sbbRepaintImage();
        // Drop the transient banner.
        const banner = document.querySelector('[data-sbb-reroll-banner]');
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
        if (warnings.length) {
            const msg = `Re-roll completed with warnings: ${warnings.join(' · ')}`;
            const hint = $('sbb-image-result');
            if (hint) hint.insertAdjacentHTML('afterbegin', `<div class="info">${escapeHtml(msg)}</div>`);
        }
    }

    /**
     * PR-27 — "Re-roll variants" button next to "Break into scenes"
     * (Storyboard panel). Re-rolls variants for every scene currently
     * loaded in the image batch table. Convenient for "I just edited
     * Visual DNA, refresh everything" without clicking through every
     * row. Falls back to a no-op (with a friendly message) when there
     * are no scenes loaded.
     */
    async function sbbRerollAll() {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const rows = sbbState.imageRows;
        if (!rows.length) {
            const target = $('sb-result');
            if (target) {
                target.insertAdjacentHTML('afterbegin',
                    '<div class="error">No scenes loaded — click "Break into scenes" first, then re-roll.</div>');
            }
            return;
        }
        const allIds = helpers.selectAllRowIds(rows);
        const prev = sbbState.imageSelected;
        sbbState.imageSelected = allIds;
        try {
            await sbbRerollSelected('image');
        } finally {
            // Restore the user's prior selection — re-roll all is a
            // one-shot action, not a selection change.
            sbbState.imageSelected = helpers.reconcileSelection(prev, sbbState.imageRows);
            sbbRepaintImage();
        }
    }

    function sbbReadVariantCount(elementId, fallback) {
        const el = $(elementId);
        const raw = el && el.value != null ? el.value : '';
        const n = parseInt(raw, 10);
        // HF-16 — backend's MAX_VARIANTS_PER_SCENE is 8. Older builds of
        // this helper allowed up to 16, which would let stale UI values
        // sneak past the renderer and trip a sidecar 422 even though the
        // backend now clamps. Match the server cap so the user never
        // sees a clamp warning unless they hand-edit the form.
        if (Number.isFinite(n) && n > 0 && n <= 8) return n;
        if (Number.isFinite(n) && n > 8) return 8;
        return fallback;
    }

    /**
     * PR-48 — apply Pro mode UI rules. When the checkbox is on, force
     * ``Images per scene`` to 1 (Grok's Quality model returns 1 high-
     * quality image per request — no side-by-side preview), disable
     * the select to make the rule visible, and remember the previous
     * value so toggling Pro back off restores the user's pick. When
     * off, re-enable the select and restore the value.
     */
    function sbbApplyProMode() {
        const cb = $('sbb-pro-mode');
        const sel = $('sbb-images-per-scene');
        sbbState.proMode = !!(cb && cb.checked);
        if (!sel) return;
        if (sbbState.proMode) {
            if (sel.value !== '1') {
                sbbState.savedImagesPerScene = sel.value;
            }
            sel.value = '1';
            sel.disabled = true;
        } else {
            sel.disabled = false;
            if (sbbState.savedImagesPerScene && sel.value === '1') {
                sel.value = sbbState.savedImagesPerScene;
            }
        }
        sbbSyncVideosFromImages();
    }

    /**
     * PR-48 — keep ``Videos per scene`` in sync with ``Images per
     * scene`` so each video variant pairs 1:1 with its image variant.
     * Only fires until the user explicitly touches the videos select
     * (tracked in ``sbbState.userOverroteVideosPerScene``); after that
     * the user's pick wins until the next session.
     */
    function sbbSyncVideosFromImages() {
        if (sbbState.userOverroteVideosPerScene) return;
        const imgSel = $('sbb-images-per-scene');
        const vidSel = $('sbb-videos-per-scene');
        if (!imgSel || !vidSel) return;
        const target = String(imgSel.value || '');
        // Only set if the videos dropdown actually offers that value;
        // otherwise leave the dropdown alone (avoid inserting bogus
        // options at runtime).
        for (const opt of vidSel.options) {
            if (String(opt.value) === target) {
                vidSel.value = target;
                return;
            }
        }
    }

    function sbbClear() {
        sbbState.imageRows = [];
        sbbState.videoRows = [];
        sbbRepaintAll();
    }

    /**
     * HF-5 #9 — Bulk re-run only the rows that landed in the fallback
     * bucket on the last batch. Settled / pending / generating rows are
     * skipped. Reuses the existing single-row retry plumbing
     * (``sbbRunImageBatchForRowIds`` / ``sbbRunVideoBatchForRowIds``) so
     * the IPC payload + state-flip semantics are bytes-identical to a
     * sequence of per-row Retry clicks — no new code paths in the
     * planners.
     */
    async function sbbRetryFailed(kind) {
        const rows = kind === 'video' ? sbbState.videoRows : sbbState.imageRows;
        const ids = new Set();
        for (const r of rows) {
            if (r && r.status === 'fallback') {
                ids.add(String(r.row_id != null ? r.row_id : r.scene_id));
            }
        }
        const banner = $(kind === 'video' ? 'sbb-video-result' : 'sbb-image-result');
        if (!ids.size) {
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                '<div class="empty">No fallback rows to retry — every row either succeeded or has not run yet.</div>',
            );
            return;
        }
        if (kind === 'video') return sbbRunVideoBatchForRowIds(ids);
        return sbbRunImageBatchForRowIds(ids);
    }

    /**
     * HF-13 — bulk-rewrite the image_prompts in every storyboard scene
     * via DeepSeek so explicit anatomy / fabric vocabulary is replaced
     * with editorial equivalents (\"form-fitting silk slip\" instead of
     * \"see-through wet-look transparent fabric revealing nipples\")
     * while pose / lighting / camera / mood are preserved verbatim.
     *
     * Used to rescue rows that keep landing in the ``fallback`` bucket
     * because Grok / generic CDN moderation returns ~80 KB blurred
     * placeholders for explicit prompts. After softening:
     *
     * - ``state.lastScenes[].image_prompt`` is overwritten in place so
     *   the next \"Generate images\" run uses the softened text.
     * - ``state.lastScenes[].image_prompts[]`` (per-variant array) is
     *   overwritten in lock-step when the variant count matches.
     * - ``sbbState.imageRows[].prompt`` is updated for every row that
     *   maps to a softened variant; rows currently in flight are
     *   skipped (the next batch run picks up the new prompt).
     * - The image table is re-rendered so the user can see the new
     *   prompt text.
     *
     * Falls back gracefully when the LLM is unreachable or
     * ``DEEPSEEK_API_KEY`` is missing — the response includes the
     * originals unchanged + a warning that the renderer surfaces in
     * the result banner.
     */
    async function sbbSoftenPrompts() {
        const banner = $('sbb-image-result');
        if (!api || !api.producer || typeof api.producer.softenPrompts !== 'function') {
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                '<div class="error">electronAPI.producer.softenPrompts is unavailable — desktop shell needs the new preload.</div>',
            );
            return;
        }
        const scenes = Array.isArray(state.lastScenes) ? state.lastScenes : [];
        if (!scenes.length) {
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                '<div class="empty">No scenes in memory — run "Break into scenes" above first.</div>',
            );
            return;
        }
        // Collect every prompt across scenes — the singular
        // image_prompt + every per-variant image_prompts[] entry.
        // Track the (scene_index, variant_index | -1 for singular)
        // tuple so we can splice the rewrites back into the right
        // slot after the call.
        const slots = [];
        const prompts = [];
        scenes.forEach((s, sceneIdx) => {
            if (!s || typeof s !== 'object') return;
            if (typeof s.image_prompt === 'string' && s.image_prompt.trim()) {
                slots.push({ sceneIdx, variantIdx: -1 });
                prompts.push(s.image_prompt.trim());
            }
            if (Array.isArray(s.image_prompts)) {
                s.image_prompts.forEach((p, variantIdx) => {
                    if (typeof p === 'string' && p.trim()) {
                        slots.push({ sceneIdx, variantIdx });
                        prompts.push(p.trim());
                    }
                });
            }
        });
        if (!prompts.length) {
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                '<div class="empty">No image prompts to soften — every scene is blank.</div>',
            );
            return;
        }
        showLoading('sbb-image-result', `Softening ${prompts.length} image prompt(s) via DeepSeek…`);
        let data;
        try {
            data = await api.producer.softenPrompts({
                prompts,
                language: 'Vietnamese',
            });
        } catch (err) {
            showError('sbb-image-result', err);
            return;
        }
        const usedLlm = !!(data && data.used_llm);
        const warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];
        const rewritten = (data && Array.isArray(data.softened_prompts)) ? data.softened_prompts : [];
        if (usedLlm && rewritten.length === prompts.length) {
            // Splice back into state.lastScenes in the same shape we
            // pulled the originals from.
            for (let i = 0; i < slots.length; i += 1) {
                const { sceneIdx, variantIdx } = slots[i];
                const next = (rewritten[i] || '').trim() || prompts[i];
                const scene = scenes[sceneIdx];
                if (!scene || typeof scene !== 'object') continue;
                if (variantIdx === -1) {
                    scene.image_prompt = next;
                } else if (Array.isArray(scene.image_prompts) && variantIdx < scene.image_prompts.length) {
                    scene.image_prompts[variantIdx] = next;
                }
            }
            // Mirror into the image-batch rows so the user sees the
            // new prompt text in the table immediately. Match by
            // scene_id + variant_idx; rows in flight are left alone
            // (their next attempt picks up the fresh state.lastScenes).
            for (const row of sbbState.imageRows) {
                if (!row || row.status === 'generating') continue;
                const scene = scenes.find((s) => s && s.scene_id === row.scene_id);
                if (!scene) continue;
                const variantIdx = typeof row.variant_idx === 'number' ? row.variant_idx : 0;
                const variantList = Array.isArray(scene.image_prompts) ? scene.image_prompts : [];
                const next = (typeof variantList[variantIdx] === 'string' && variantList[variantIdx].trim())
                    ? variantList[variantIdx].trim()
                    : (typeof scene.image_prompt === 'string' ? scene.image_prompt.trim() : '');
                if (next) row.prompt = next;
            }
            sbbRepaintImage();
        }
        const target = $('sbb-image-result');
        if (target) {
            const head = usedLlm
                ? `<div class="info">Softened ${rewritten.length} prompt(s) via DeepSeek. Run "Generate images" / "🔄 Retry failed" to re-render with the new prompts.</div>`
                : '<div class="info">Prompts unchanged (LLM did not run).</div>';
            const warnHtml = warnings.length
                ? `<div class="warn">${warnings.map(escapeHtml).join('<br>')}</div>`
                : '';
            target.innerHTML = head + warnHtml;
            scrollResultIntoView(target);
        }
    }

    /**
     * HF-5 #10 — repaint the small status pill that lives in the section
     * header next to the Generate / Retry / Open-folder buttons. Format:
     *
     *   ``3/12 done · 2 failed · ETA ~2m``
     *
     * Empty when no rows exist (CSS :empty rule collapses the badge).
     * ETA is a coarse estimate (remaining rows × assumed per-row
     * throughput); a precise ETA would need IPC-level timing telemetry
     * the current pipeline doesn't expose.
     */
    function sbbUpdateProgressBadge(kind) {
        const target = $(kind === 'video' ? 'sbb-video-progress-badge' : 'sbb-image-progress-badge');
        if (!target) return;
        const rows = kind === 'video' ? sbbState.videoRows : sbbState.imageRows;
        if (!rows.length) {
            target.textContent = '';
            return;
        }
        let done = 0;
        let failed = 0;
        let pending = 0;
        let generating = 0;
        for (const r of rows) {
            const s = r && r.status;
            if (s === 'generated' || s === 'retried') done += 1;
            else if (s === 'fallback') failed += 1;
            else if (s === 'generating') generating += 1;
            else pending += 1;
        }
        const total = rows.length;
        const parts = [`${done}/${total} done`];
        if (failed) parts.push(`${failed} failed`);
        const remaining = pending + generating;
        if (remaining > 0) {
            const perRowSec = kind === 'video' ? 60 : 25;
            const etaSec = remaining * perRowSec;
            const etaStr = etaSec < 60 ? `${etaSec}s` : `~${Math.max(1, Math.round(etaSec / 60))}m`;
            parts.push(`ETA ${etaStr}`);
        }
        target.textContent = parts.join(' · ');
    }

    /**
     * HF-5 #11 — open the output folder for a given batch kind in the
     * OS file browser. Resolution order:
     *   1. ``sbb-output-dir`` hidden input (user picked an explicit folder).
     *   2. parent dir of the first settled row's saved file (auto-create
     *      timestamped folders land here on first generation).
     * Falls back to a friendly empty banner when neither is available.
     */
    async function sbbOpenOutputFolder(kind) {
        const banner = $(kind === 'video' ? 'sbb-video-result' : 'sbb-image-result');
        if (!api || typeof api.openFolder !== 'function') {
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                '<div class="error">electronAPI.openFolder unavailable — update the desktop shell.</div>',
            );
            return;
        }
        const explicit = (($('sbb-output-dir') || {}).value || '').trim();
        let target = explicit;
        if (!target) {
            const rows = kind === 'video' ? sbbState.videoRows : sbbState.imageRows;
            for (const r of rows) {
                const path = (r && (r.video_path || r.image_path)) || '';
                if (typeof path === 'string' && path) {
                    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                    target = idx >= 0 ? path.slice(0, idx) : '';
                    if (target) break;
                }
            }
        }
        if (!target) {
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                '<div class="empty">No output folder yet — pick one with the 📁 button or generate a row first.</div>',
            );
            return;
        }
        try {
            await api.openFolder(target);
        } catch (err) {
            console.warn('openFolder failed:', err);
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                `<div class="error">openFolder failed: ${escapeHtml(err && err.message || String(err))}</div>`,
            );
        }
    }

    /**
     * HF-5 #1 — the icon-only 📁 picker has no visible textbox, so we
     * surface the chosen path via the button's tooltip instead. Called
     * on init + every time ``sbbPickOutputDir`` mutates the hidden input.
     */
    function sbbRefreshOutputDirTooltip() {
        const btn = $('sbb-output-dir-picker');
        const input = $('sbb-output-dir');
        if (!btn) return;
        const value = (input && input.value || '').trim();
        if (value) {
            btn.title = `Output folder: ${value} (click to change)`;
        } else {
            btn.title = 'Choose output folder (auto-create ~/.creator-forge/output/batch-<timestamp>/ if blank)';
        }
    }

    /**
     * PR-24 — open the OS folder picker and stuff the chosen path into
     * the input identified by ``inputId``. Cancel = no-op so the
     * existing value is preserved. The IPC degrades gracefully when
     * the dialog API isn't available (older preload, web preview).
     */
    async function sbbPickOutputDir(inputId) {
        const input = $(inputId);
        if (!input) return;
        if (!api || !api.dialog || typeof api.dialog.chooseOutputDir !== 'function') {
            // Renderer running outside Electron (or a stale preload) —
            // fall back to a simple prompt so the picker is still
            // usable rather than silently doing nothing.
            const fallback = window.prompt('Output folder (absolute path):', input.value || '');
            if (fallback) input.value = fallback;
            return;
        }
        try {
            const res = await api.dialog.chooseOutputDir({
                title: 'Choose output folder',
                defaultPath: input.value || undefined,
            });
            if (res && !res.canceled && res.path) {
                input.value = res.path;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (err) {
            console.warn('chooseOutputDir failed:', err);
        }
    }

    /**
     * PR-24 — bridge a settled image row to the video flow. Re-pairs
     * image_path into the matching video row, switches mode to I2V,
     * scrolls the video panel into view, and surfaces a status hint
     * so the user can click "Generate videos" themselves. We
     * deliberately don't auto-dispatch the IPC: the user may want to
     * pair more images first or flip to T2V.
     */
    function sbbBridgeImageToVideo(sceneId, _rowId) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        if (!sbbState.videoRows.length) {
            // Re-init from current scenes if the user cleared the
            // video table or never auto-filled.
            sbbAutoFill();
        }
        sbbState.videoRows = helpers.pairImagePathsForI2V(sbbState.videoRows, sbbState.imageRows);
        // Force I2V mode — bridging an image makes T2V nonsensical.
        const modeEl = $('sbb-video-mode');
        if (modeEl && modeEl.value !== 'i2v') modeEl.value = 'i2v';
        sbbRepaintVideo();
        // Resolve a thumbnail URL for the just-paired hero image so
        // the Source column shows a real preview, not just a path.
        sbbResolveUrls(sbbState.videoRows, 'video').catch(() => {});
        const result = $('sbb-video-result');
        if (result) {
            const sceneLabel = sceneId != null && sceneId !== '' ? `scene ${sceneId}` : 'this scene';
            result.innerHTML = `<div class="info">Image paired for ${escapeHtml(sceneLabel)}. Click <b>Generate videos</b> to start I2V (or pair more first).</div>`;
        }
        const target = $('sbb-video-rows') || $('sbb-video-result');
        if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    async function sbbOpenLogin() {
        if (!api || !api.auth || typeof api.auth.openManualLogin !== 'function') {
            const banner = $('sbb-login-banner');
            if (banner) banner.querySelector('span').textContent = 'auth.openManualLogin IPC unavailable — rebuild Electron.';
            return;
        }
        try {
            await api.auth.openManualLogin({});
            // Re-poll session status after the login window closes.
            setTimeout(() => sbbCheckSession().catch(() => {}), 1000);
        } catch (e) {
            console.error('openManualLogin failed', e);
        }
    }

    // ─── PR-22: Account Manager (programmatic auto-login) ─────────────────
    // The Storyboard tab now has a small Account Manager panel that
    // renders one row per entry in `accounts.json`, lets the user
    // add/remove rows, save back to disk, and trigger
    // `auth:setupAccounts` (autogrok-veo3 parity). Live progress
    // surfaces via the existing `electronAPI.onLog` channel.
    const sbaState = {
        rows: [],          // [{email, password, password_dirty}]
        sessionStatus: null, // last auth:getSessionStatus payload
        autoLoginInFlight: false,
    };

    function sbaPushLog(level, line) {
        const helpers = window.StoryboardAccountManagerHelpers;
        const feed = $('sba-log-feed');
        if (!feed) return;
        const safe = helpers
            ? helpers.sanitizeProgressLog(String(line || ''), sbaState.rows)
            : String(line || '');
        const div = document.createElement('div');
        div.className = 'log-line ' + (level === 'error' ? 'error'
            : level === 'success' ? 'success' : 'info');
        div.textContent = safe;
        feed.appendChild(div);
        feed.classList.add('visible');
        feed.scrollTop = feed.scrollHeight;
    }

    function sbaSetStatus(text, level) {
        const el = $('sba-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = level === 'error' ? 'error'
            : level === 'success' ? 'success' : 'empty';
    }

    function sbaRender() {
        const helpers = window.StoryboardAccountManagerHelpers;
        const container = $('sba-rows');
        const counter = $('sba-count');
        if (!container) return;
        const displayRows = helpers
            ? helpers.mergeWithSessionStatus(sbaState.rows, sbaState.sessionStatus)
            : sbaState.rows.map((r) => ({ email: r.email || '', state_label: '—', state_class: 'no-accounts', age_label: '—' }));
        if (counter) counter.textContent = String(sbaState.rows.length);
        if (sbaState.rows.length === 0) {
            container.innerHTML = '<div class="empty">No Grok accounts configured. Click <b>+ Add row</b> to enter one.</div>';
            return;
        }
        container.innerHTML = '';
        sbaState.rows.forEach((row, idx) => {
            const display = displayRows[idx] || {};
            const div = document.createElement('div');
            div.className = 'account-row';
            const emailInput = document.createElement('input');
            emailInput.type = 'email';
            emailInput.placeholder = 'email@example.com';
            emailInput.value = row.email || '';
            emailInput.setAttribute('data-sba-idx', String(idx));
            emailInput.setAttribute('data-sba-field', 'email');
            const passwordInput = document.createElement('input');
            passwordInput.type = 'password';
            passwordInput.placeholder = row.password ? '●●●●●● (saved)' : 'password';
            // Never echo the saved password into the DOM. The user
            // re-types only when changing it.
            passwordInput.value = row.password_dirty ? (row.password || '') : '';
            passwordInput.setAttribute('data-sba-idx', String(idx));
            passwordInput.setAttribute('data-sba-field', 'password');
            const state = document.createElement('span');
            state.className = 'state ' + (display.state_class || 'no-accounts');
            state.textContent = (display.state_label || '—') + (display.age_label && display.age_label !== '—' ? ' · ' + display.age_label : '');
            const remove = document.createElement('button');
            remove.className = 'row-remove';
            remove.type = 'button';
            remove.title = 'Remove this account';
            remove.textContent = '×';
            remove.setAttribute('data-sba-idx', String(idx));
            remove.setAttribute('data-sba-action', 'remove');
            div.appendChild(emailInput);
            div.appendChild(passwordInput);
            div.appendChild(state);
            div.appendChild(remove);
            container.appendChild(div);
        });
    }

    async function sbaLoad() {
        if (!api || !api.auth || typeof api.auth.getAccounts !== 'function') {
            sbaState.rows = [];
            sbaRender();
            return;
        }
        try {
            const data = await api.auth.getAccounts();
            const list = Array.isArray(data) ? data
                : (data && Array.isArray(data.accounts) ? data.accounts : []);
            sbaState.rows = list.map((acc) => ({
                email: typeof acc.email === 'string' ? acc.email : '',
                password: typeof acc.password === 'string' ? acc.password : '',
                password_dirty: false,
            }));
        } catch (e) {
            console.error('auth.getAccounts failed', e);
            sbaState.rows = [];
        }
        // Pull in session status too so the row badges are accurate.
        if (typeof api.auth.getSessionStatus === 'function') {
            try {
                sbaState.sessionStatus = await api.auth.getSessionStatus();
            } catch (_) { /* fall back to no badges */ }
        }
        sbaRender();
    }

    function sbaAddRow() {
        sbaState.rows.push({ email: '', password: '', password_dirty: true });
        sbaRender();
    }

    function sbaRemoveRow(idx) {
        const i = parseInt(idx, 10);
        if (!Number.isFinite(i) || i < 0 || i >= sbaState.rows.length) return;
        sbaState.rows.splice(i, 1);
        sbaRender();
    }

    function sbaSyncFromInputs() {
        // Read current input values back into state before saving /
        // auto-login. We don't repaint here so the user keeps focus.
        const inputs = document.querySelectorAll('#sba-rows input[data-sba-idx]');
        inputs.forEach((el) => {
            const idx = parseInt(el.getAttribute('data-sba-idx'), 10);
            const field = el.getAttribute('data-sba-field');
            if (!Number.isFinite(idx) || !sbaState.rows[idx]) return;
            if (field === 'email') {
                sbaState.rows[idx].email = String(el.value || '').trim();
            } else if (field === 'password') {
                const v = String(el.value || '');
                if (v) {
                    sbaState.rows[idx].password = v;
                    sbaState.rows[idx].password_dirty = true;
                }
                // Empty input means "keep existing saved password".
            }
        });
    }

    async function sbaSave() {
        const helpers = window.StoryboardAccountManagerHelpers;
        if (!api || !api.auth || typeof api.auth.saveAccounts !== 'function') {
            sbaSetStatus('auth.saveAccounts IPC unavailable — rebuild Electron.', 'error');
            return;
        }
        sbaSyncFromInputs();
        const payload = sbaState.rows.map((r) => ({ email: r.email, password: r.password }));
        if (helpers) {
            const v = helpers.validateAccountList(payload);
            if (!v.valid) {
                const msg = v.errors.map((e) => `row ${e.idx + 1}: ${e.error}`).join('; ');
                sbaSetStatus('Cannot save — ' + msg, 'error');
                return;
            }
        }
        try {
            await api.auth.saveAccounts(payload);
            sbaState.rows.forEach((r) => { r.password_dirty = false; });
            sbaSetStatus(`Saved ${payload.length} account${payload.length === 1 ? '' : 's'} to accounts.json.`, 'success');
            // Re-poll banner so it picks up the new configured count.
            sbbCheckSession().catch(() => {});
            sbaLoad().catch(() => {});
        } catch (e) {
            sbaSetStatus('Save failed: ' + (e && e.message ? e.message : String(e)), 'error');
        }
    }

    async function sbaAutoLogin() {
        const helpers = window.StoryboardAccountManagerHelpers;
        if (sbaState.autoLoginInFlight) {
            sbaSetStatus('Auto-login already in progress…', 'info');
            return;
        }
        if (!api || !api.auth || typeof api.auth.setupAccounts !== 'function') {
            sbaSetStatus('auth.setupAccounts IPC unavailable — rebuild Electron.', 'error');
            return;
        }
        sbaSyncFromInputs();
        const payload = sbaState.rows
            .map((r) => ({ email: r.email, password: r.password }))
            .filter((a) => a.email && a.password);
        if (!payload.length) {
            sbaSetStatus('Add at least one email + password row first.', 'error');
            return;
        }
        if (helpers) {
            const v = helpers.validateAccountList(payload);
            if (!v.valid) {
                const msg = v.errors.map((e) => `row ${e.idx + 1}: ${e.error}`).join('; ');
                sbaSetStatus('Cannot auto-login — ' + msg, 'error');
                return;
            }
        }
        sbaState.autoLoginInFlight = true;
        // PR-23: persist accounts.json BEFORE launching headful Puppeteer
        // so auth:getSessionStatus reflects the configured count even if
        // the user never clicked "Save accounts.json" first. Without this
        // the session is captured in RAM but accounts.json stays empty,
        // and the always-on banner / Account Manager state stay red.
        try {
            if (api.auth && typeof api.auth.saveAccounts === 'function') {
                await api.auth.saveAccounts(payload);
                sbaState.rows.forEach((r) => { r.password_dirty = false; });
                sbaPushLog('info', `→ auth:saveAccounts persisted ${payload.length} row${payload.length === 1 ? '' : 's'} to accounts.json before login`);
            }
        } catch (e) {
            sbaPushLog('error', 'auth:saveAccounts before auto-login failed: ' + (e && e.message ? e.message : String(e)));
            // Continue anyway — setupAccounts can still succeed in RAM.
        }
        sbaSetStatus(`Auto-login: launching headful Puppeteer for ${payload.length} account${payload.length === 1 ? '' : 's'}…`, 'info');
        sbaPushLog('info', `→ auth:setupAccounts (${payload.length} row${payload.length === 1 ? '' : 's'})`);
        try {
            const result = await api.auth.setupAccounts(payload);
            const ok = !!(result && result.success);
            const sessions = (result && Number.isFinite(result.sessions)) ? result.sessions : 0;
            const msg = ok
                ? `Auto-login OK — ${sessions}/${payload.length} session${sessions === 1 ? '' : 's'} captured. Browsers minimised.`
                : `Auto-login finished with errors${result && result.error ? ': ' + result.error : '.'}`;
            sbaSetStatus(msg, ok ? 'success' : 'error');
            sbaPushLog(ok ? 'success' : 'error', msg);
        } catch (e) {
            const msg = 'Auto-login threw: ' + (e && e.message ? e.message : String(e));
            sbaSetStatus(msg, 'error');
            sbaPushLog('error', msg);
        } finally {
            sbaState.autoLoginInFlight = false;
            // Refresh banner + row state badges.
            sbbCheckSession().catch(() => {});
            sbaLoad().catch(() => {});
        }
    }

    function sbaWireDelegatedHandlers() {
        const rows = $('sba-rows');
        if (!rows) return;
        rows.addEventListener('click', (e) => {
            const t = e.target;
            if (!t || !t.matches) return;
            if (t.matches('button[data-sba-action="remove"]')) {
                sbaRemoveRow(t.getAttribute('data-sba-idx'));
            }
        });
        // Sync input values into state on every change so the next
        // Save / Auto-login picks them up even if the user didn't blur.
        rows.addEventListener('input', () => {
            sbaSyncFromInputs();
        });
    }

    /**
     * PR-29 — public Generate handler. Reads the user's checkbox
     * selection from ``sbbState.imageSelected`` and refuses to run
     * when nothing is selected (we now require explicit intent
     * instead of silently generating every row). Bulk Generate goes
     * through this; per-row Retry calls ``sbbRunImageBatchForRowIds``
     * directly with a synthetic single-id set so a Retry click never
     * fans out to siblings.
     */
    async function sbbGenerateImages() {
        if (!sbbState.imageRows.length) {
            sbbAutoFill();
            if (!sbbState.imageRows.length) return;
        }
        // PR-46 — when nothing is explicitly selected, fall back to
        // "generate all rows" instead of refusing. This matches the
        // user-facing button label ("Generate all (N)") and the
        // original feature spec from the live-E2E backlog.
        const helpers = window.StoryboardBatchHelpers;
        const ids = sbbState.imageSelected.size
            ? sbbState.imageSelected
            : (helpers && typeof helpers.selectAllRowIds === 'function'
                ? helpers.selectAllRowIds(sbbState.imageRows)
                : new Set(sbbState.imageRows.map((r) => String(r.row_id))));
        return sbbRunImageBatchForRowIds(ids);
    }

    /**
     * PR-29 — body of the image-generation flow, scoped to a specific
     * set of row_ids. Used by both bulk Generate and per-row Retry.
     * Skipped / empty-prompt rows in the subset are filtered out by
     * the planners so they don't bleed into the IPC payload.
     */
    async function sbbRunImageBatchForRowIds(rowIds) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const banner = $('sbb-image-result');
        if (!api || !api.image || typeof api.image.generate !== 'function') {
            if (banner) banner.innerHTML = '<div class="error">electronAPI.image.generate unavailable.</div>';
            return;
        }
        const subset = helpers.filterRowsBySelection(sbbState.imageRows, rowIds);
        if (!subset.length) {
            if (banner) banner.insertAdjacentHTML('afterbegin', '<div class="error">No matching rows to generate.</div>');
            return;
        }
        // PR-28: when any row resolves to ≥1 ref image, we route those
        // rows through `refimg:generate` (Grok's imagine-image-edit
        // model) and the remainder through plain `image:generate`.
        const refOpts = { rowRefMap: sbbState.rowRefMap, globalRefs: sbbState.globalRefs };
        const split = helpers.partitionRowsByRefs(subset, refOpts);
        const plainPlan = helpers.planImageGenerate(split.withoutRefs);
        const refPlan = helpers.planRefImageGenerate(split.withRefs, refOpts);
        const eligibleCount = plainPlan.prompts.length + refPlan.items.length;
        if (!eligibleCount) {
            if (banner) banner.insertAdjacentHTML('afterbegin', '<div class="error">No eligible image prompts in the selection (every row was skipped — check image_prompt).</div>');
            return;
        }
        if (refPlan.items.length && (!api.refimg || typeof api.refimg.generate !== 'function')) {
            if (banner) banner.innerHTML = '<div class="error">electronAPI.refimg.generate unavailable — drop the reference images or update the desktop shell.</div>';
            return;
        }
        sbbInstallListener();
        // PR-29: only flip the subset rows to "generating"; siblings
        // outside the subset stay in their current status so a retry
        // / partial run doesn't visually obliterate the rest of the
        // table. Skipped rows in the subset are still left alone.
        const subsetIds = new Set(subset.map((r) => String(r.row_id)));
        sbbState.imageRows = sbbState.imageRows.map((row) => {
            if (!subsetIds.has(String(row.row_id))) return row;
            if (row.status === 'skipped') return row;
            return Object.assign({}, row, { status: 'generating', progress: 0, attempts: (row.attempts || 0) + 1, url: null, image_path: null, bytes: 0 });
        });
        // currentImageBatch* covers BOTH plans so progress events for
        // either IPC channel route through the same row mapping.
        sbbState.currentImageBatchSceneIds = [...plainPlan.sceneIds, ...refPlan.sceneIds];
        sbbState.currentImageBatchRowIds = [
            ...((plainPlan.rowIds || plainPlan.sceneIds).slice()),
            ...refPlan.rowIds,
        ];
        sbbRepaintImage();

        // Detect whether this batch contains rows that already failed
        // at least once. When retrying, boost imageGenerationCount so
        // Grok produces multiple candidates — the service picks the
        // largest and the renderer gates out anything below 100 KB.
        // Pro mode forces count=1 so the boost is skipped there.
        const hasRetryRows = sbbState.imageRows.some(
            (r) => subsetIds.has(String(r.row_id)) && (r.attempts || 0) > 1
        );
        const config = { imageGenerationCount: hasRetryRows ? 4 : 1 };
        const aspect = asNonEmpty(($('sbb-aspect') || {}).value || '');
        if (aspect) config.aspectRatio = aspect;
        // PR-48 — Pro mode flips Grok's Quality model on; ImageService
        // already accepts ``enablePro`` and translates it to the
        // imagine-image-pro side of the API. We forward the cached
        // sbbState.proMode (set by sbbApplyProMode) so the user's
        // checkbox state survives a re-render.
        if (sbbState.proMode) config.enablePro = true;

        // HF-12 — apply the Storyboard Character anchor verbatim to
        // every prompt so Grok's imagine / imagine-image-edit model
        // sees the same identity cue on every variant. Visual DNA
        // covers style; this covers WHO. The helper is a no-op when
        // the textarea is empty so existing flows are unaffected.
        const charHelpers = (typeof window !== 'undefined' && window.StoryboardCharacterAnchorHelpers) || null;
        const characterAnchor = (($('sb-character-anchor') || {}).value || '').trim();
        const finalPlainPrompts = (charHelpers && characterAnchor)
            ? charHelpers.applyCharacterAnchor(plainPlan.prompts, characterAnchor)
            : plainPlan.prompts;
        const finalRefItems = (charHelpers && characterAnchor)
            ? charHelpers.applyCharacterAnchorToRefItems(refPlan.items, characterAnchor)
            : refPlan.items;

        const tasks = [];
        if (finalPlainPrompts.length) {
            tasks.push(api.image.generate({ prompts: finalPlainPrompts, config })
                .then((resp) => ({ kind: 'image', resp, plan: plainPlan }))
                .catch((err) => ({ kind: 'image', err, plan: plainPlan })));
        }
        if (finalRefItems.length) {
            tasks.push(api.refimg.generate({ items: finalRefItems, config })
                .then((resp) => ({ kind: 'refimg', resp, plan: refPlan }))
                .catch((err) => ({ kind: 'refimg', err, plan: refPlan })));
        }
        const outcomes = await Promise.all(tasks);

        for (const o of outcomes) {
            if (o.err) {
                const channel = o.kind === 'refimg' ? 'refimg:generate' : 'image:generate';
                if (banner) banner.insertAdjacentHTML('afterbegin', `<div class="error">${channel} IPC threw: ${escapeHtml(o.err && o.err.message || String(o.err))}</div>`);
                continue;
            }
            const mapped = helpers.mapBatchResponse(o.resp, o.plan.sceneIds, 'image', o.plan.rowIds || o.plan.sceneIds);
            // Hot-fix — ImageService / RefImageService return ``savedFiles``
            // as a ``string[]`` (no per-file ``bytes``), so ``mapped`` lands
            // here with ``bytes === 0`` and the ``MIN_OK_IMAGE_BYTES`` gate
            // in ``applyBatchResult`` would silently skip a < 100 KB file.
            // Stat each settled image on disk so the gate sees the real
            // size before the row reaches the I2V batch.
            const settled = (typeof helpers.enrichBatchRowsWithFileBytes === 'function' && api && typeof api.statBytes === 'function')
                ? await helpers.enrichBatchRowsWithFileBytes(mapped, api.statBytes)
                : mapped;
            for (const r of settled) {
                sbbState.imageRows = helpers.applyBatchResult(sbbState.imageRows, r.row_id != null ? r.row_id : r.scene_id, r);
            }
            if (o.resp && o.resp.success === false) {
                const channel = o.kind === 'refimg' ? 'refimg:generate' : 'image:generate';
                const why = o.resp.error || 'Unknown — check Login panel for an active Grok session.';
                if (banner) banner.insertAdjacentHTML('afterbegin', `<div class="error">${channel} failed: ${escapeHtml(why)}</div>`);
            }
        }
        // Re-pair the video table now that some images settled —
        // I2V mode depends on having the latest image_path bindings.
        sbbState.videoRows = helpers.pairImagePathsForI2V(sbbState.videoRows, sbbState.imageRows);
        sbbRepaintAll();
        sbbResolveUrls(sbbState.imageRows, 'image').catch(() => {});
        // Also resolve hero-image URLs for the freshly-paired video
        // rows so the Source column flips from "loading…" to a real
        // thumbnail without waiting for the I2V phase to start.
        sbbResolveUrls(sbbState.videoRows, 'video').catch(() => {});

        // PR-B — once at least one image has settled, the Video
        // Generate button just became reachable. Smooth-scroll the
        // Video panel into view so the user can immediately continue
        // the Image → Video flow without hunting for the section
        // below the (potentially long) image table. ``scrollResultIntoView``
        // is a no-op when the panel is already on screen, so this is
        // idempotent across multiple batch runs / retries.
        const settledNow = (typeof helpers.countSettledImageRows === 'function')
            ? helpers.countSettledImageRows(sbbState.imageRows)
            : 0;
        if (settledNow > 0) {
            const videoSection = document.getElementById('sbb-video-section');
            if (videoSection) scrollResultIntoView(videoSection);
        }

        // Auto-retry rows that were demoted to fallback by the image
        // size gate (< 100 KB). Grok occasionally returns small
        // placeholder / moderated images on first attempt but succeeds
        // on a subsequent try with the same prompt and session. Cap at
        // SBB_MAX_AUTO_RETRIES total attempts per row so we don't spin
        // forever on genuinely un-generatable prompts.
        const SBB_MAX_AUTO_RETRIES = 3;
        const autoRetryIds = new Set();
        for (const row of sbbState.imageRows) {
            if (
                rowIds.has(String(row.row_id))
                && row.status === 'fallback'
                && (row.attempts || 0) < SBB_MAX_AUTO_RETRIES
            ) {
                autoRetryIds.add(String(row.row_id));
            }
        }
        if (autoRetryIds.size > 0) {
            const nextAttempt = (sbbState.imageRows.find((r) => autoRetryIds.has(String(r.row_id))) || {}).attempts || 1;
            if (banner) banner.insertAdjacentHTML(
                'afterbegin',
                `<div class="info">Auto-retrying ${autoRetryIds.size} failed row(s)… (attempt ${nextAttempt + 1}/${SBB_MAX_AUTO_RETRIES})</div>`,
            );
            await new Promise((r) => setTimeout(r, 3000));
            return sbbRunImageBatchForRowIds(autoRetryIds);
        }
    }

    /**
     * PR-29 — per-row Retry. Always re-runs exactly one row,
     * regardless of the current selection, by passing a synthetic
     * single-element row_id set to the matching batch helper. Failed
     * (status=fallback) rows are the primary use case but the
     * handler is permissive — re-running a settled row is harmless
     * since the planners will skip already-generated rows.
     */
    async function sbbRetryRow(kind, rowId) {
        if (rowId == null || rowId === '') return;
        const set = new Set([String(rowId)]);
        if (kind === 'video') return sbbRunVideoBatchForRowIds(set);
        return sbbRunImageBatchForRowIds(set);
    }

    /**
     * PR-29 — public Generate handler for the video table. Same
     * selection-aware contract as ``sbbGenerateImages``: refuses to
     * run with an empty selection so the user can't accidentally
     * fan out a single-row retry to all 60 rows.
     */
    async function sbbGenerateVideos() {
        if (!sbbState.videoRows.length) {
            sbbAutoFill();
            if (!sbbState.videoRows.length) return;
        }
        // PR-46 — same "generate all" fallback as the image side
        // when no explicit selection. The screenshot-driven UX
        // finding was: user pairs an image, sees the panel hint
        // "Click Generate videos to start I2V", clicks it, nothing
        // happens because they didn't tick a checkbox. The button
        // label now matches behaviour.
        const helpers = window.StoryboardBatchHelpers;
        const ids = sbbState.videoSelected.size
            ? sbbState.videoSelected
            : (helpers && typeof helpers.selectAllRowIds === 'function'
                ? helpers.selectAllRowIds(sbbState.videoRows)
                : new Set(sbbState.videoRows.map((r) => String(r.row_id))));
        return sbbRunVideoBatchForRowIds(ids);
    }

    /**
     * PR-29 — body of the video-generation flow, scoped to a row_id
     * subset. Used by both bulk Generate and per-row Retry. Honors
     * the i2v / t2v selector and re-pairs image_path bindings before
     * planning so a freshly generated image is picked up by an
     * adjacent retry.
     */
    async function sbbRunVideoBatchForRowIds(rowIds) {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        const banner = $('sbb-video-result');
        const mode = ($('sbb-video-mode') || {}).value || 'i2v';
        if (mode === 'i2v') {
            if (!api || !api.i2v || typeof api.i2v.generate !== 'function') {
                if (banner) banner.innerHTML = '<div class="error">electronAPI.i2v.generate unavailable.</div>';
                return;
            }
        } else {
            if (!api || !api.video || typeof api.video.generate !== 'function') {
                if (banner) banner.innerHTML = '<div class="error">electronAPI.video.generate unavailable (T2V).</div>';
                return;
            }
        }
        // Always re-pair before planning so the latest image table state
        // is reflected in I2V eligibility.
        sbbState.videoRows = helpers.pairImagePathsForI2V(sbbState.videoRows, sbbState.imageRows);
        const subset = helpers.filterRowsBySelection(sbbState.videoRows, rowIds);
        if (!subset.length) {
            if (banner) banner.insertAdjacentHTML('afterbegin', '<div class="error">No matching rows to generate.</div>');
            return;
        }
        const plan = helpers.planVideoGenerate(subset, mode);
        const eligibleCount = mode === 'i2v' ? plan.items.length : plan.prompts.length;
        if (!eligibleCount) {
            const reason = mode === 'i2v'
                ? 'No eligible rows in the selection — generate images first or switch to T2V mode.'
                : 'No video prompts in the selection — every row is missing video_prompt / flow_video_prompt.';
            if (banner) banner.insertAdjacentHTML('afterbegin', `<div class="error">${escapeHtml(reason)}</div>`);
            return;
        }
        sbbInstallListener();
        // Mark eligible rows as generating, but also reflect any
        // skipped rows from the plan (e.g. I2V rows missing an image).
        // PR-23: gate by row_id when the plan supplies it so variant 0
        // can flip to `generating` while siblings remain pending.
        // PR-29: rows OUTSIDE the subset are left untouched — a partial
        // run never resets siblings, even if they're in the planner's
        // "skipped" bucket from a previous run.
        const subsetIds = new Set(subset.map((r) => String(r.row_id != null ? r.row_id : r.scene_id)));
        const eligibleRowIdSet = new Set((plan.rowIds || []).map(String));
        const eligibleSceneSet = new Set(plan.sceneIds.map(String));
        const skippedRowMap = new Map(
            (plan.skipped || []).map((s) => [String(s.row_id != null ? s.row_id : s.scene_id), s.reason])
        );
        sbbState.videoRows = sbbState.videoRows.map((row) => {
            const rid = String(row.row_id != null ? row.row_id : row.scene_id);
            const sid = String(row.scene_id);
            if (!subsetIds.has(rid)) return row;
            const eligible = plan.rowIds ? eligibleRowIdSet.has(rid) : eligibleSceneSet.has(sid);
            if (eligible) {
                return Object.assign({}, row, { status: 'generating', progress: 0, attempts: (row.attempts || 0) + 1, url: null, video_path: null });
            }
            if (skippedRowMap.has(rid)) {
                return Object.assign({}, row, { status: 'skipped', reason: skippedRowMap.get(rid) });
            }
            return row;
        });
        sbbState.currentVideoBatchSceneIds = plan.sceneIds.slice();
        sbbState.currentVideoBatchRowIds = (plan.rowIds || plan.sceneIds).slice();
        sbbRepaintVideo();

        // HF-5 #8 — wire the Duration dropdown into the video IPC. The
        // Service-layer (VideoService.buildVideoBody +
        // I2VService.buildI2VBody) already accepts ``config.videoLength``
        // and falls back to defaults when missing, so the field is
        // forward-compatible with older shells.
        const durationEl = $('sbb-duration');
        const rawDuration = durationEl && durationEl.value ? parseInt(durationEl.value, 10) : NaN;
        const config = Number.isFinite(rawDuration) && rawDuration > 0
            ? { videoLength: rawDuration }
            : {};

        let resp;
        try {
            if (mode === 'i2v') {
                resp = await api.i2v.generate({ items: plan.items, config });
            } else {
                resp = await api.video.generate({ prompts: plan.prompts, config });
            }
        } catch (err) {
            $('sbb-video-result').insertAdjacentHTML('afterbegin', `<div class="error">${escapeHtml(mode)}:generate IPC threw: ${escapeHtml(err && err.message || String(err))}</div>`);
            return;
        }
        // PR-20E: hand a validator into the async mapper so tiny/
        // invalid mp4s (which the service's 1KB floor would otherwise
        // accept) get flipped from `generated` → `fallback` with the
        // ffprobe reason attached. When the IPC isn't available we
        // fall back to the sync mapper — behavior-preserving.
        const validateFn = (api.video && typeof api.video.validateOutput === 'function')
            ? async (filePath) => {
                try {
                    return await api.video.validateOutput({ filePath });
                } catch (err) {
                    return { ok: false, reason: `validateOutput IPC threw: ${(err && err.message) || err}` };
                }
            }
            : null;
        const settled = validateFn && typeof helpers.mapBatchResponseAsync === 'function'
            ? await helpers.mapBatchResponseAsync(resp, plan.sceneIds, 'video', { validateFn, rowIds: plan.rowIds })
            : helpers.mapBatchResponse(resp, plan.sceneIds, 'video', plan.rowIds);
        for (const r of settled) {
            sbbState.videoRows = helpers.applyBatchResult(sbbState.videoRows, r.row_id != null ? r.row_id : r.scene_id, r);
        }
        sbbRepaintVideo();
        sbbResolveUrls(sbbState.videoRows, 'video').catch(() => {});

        if (resp && resp.success === false) {
            const why = resp.error || 'Unknown — check Login panel for an active Grok session.';
            $('sbb-video-result').insertAdjacentHTML('afterbegin', `<div class="error">${escapeHtml(mode)}:generate failed: ${escapeHtml(why)}</div>`);
        }
    }

    function copyScriptFromStoryboard() {
        const script = asNonEmpty($('sb-script').value);
        if (!script) {
            showError('ps-result', { status: 422, message: 'Storyboard script is empty — paste one above first.' });
            return;
        }
        $('ps-script').value = script;
        // PR-B — manual copy re-arms the auto-mirror so subsequent
        // edits to the Storyboard script keep flowing through. The
        // user explicitly asked for the Storyboard's value, so any
        // prior hand-edit was theirs to discard.
        psScriptUserEdited = false;
    }

    /**
     * PR-X — "Refine script" button. Posts the current ps-script value
     * (or sb-script fallback), the storyboard's per-scene image_prompts,
     * and the settled scene_videos paths to ``/producer/refine_script``.
     * The sidecar asks DeepSeek to (a) extract the underlying storyline
     * from any prompt JSON / bracketed lists / keyword dumps the user
     * pasted in, (b) match the narration to what each scene's image
     * shows, and (c) size the output to fit the assembled video at a
     * natural TTS cadence. On success the cleaned narration replaces
     * ps-script's value (and the auto-mirror flag is armed off so a
     * subsequent edit to sb-script does not clobber the cleaned
     * narration). On warning (missing key, LLM error) ps-script is
     * left as-is and a status banner is shown above the result panel.
     */
    async function runRefineScript() {
        const script = asNonEmpty($('ps-script').value) || asNonEmpty($('sb-script').value);
        if (!script) {
            showError('ps-result', { status: 422, message: 'Paste a script first (Compose audio script field is empty).' });
            return;
        }
        if (!api || !api.producer || typeof api.producer.refineScript !== 'function') {
            showError('ps-result', { status: 0, message: 'electronAPI.producer.refineScript is unavailable — desktop shell needs the new preload.' });
            return;
        }
        const params = { script };
        const scenes = Array.isArray(state.lastScenes) ? state.lastScenes : [];
        if (scenes.length) {
            params.scene_image_prompts = scenes.map((s) => {
                if (!s || typeof s !== 'object') return '';
                return s.image_prompt != null ? String(s.image_prompt).trim() : '';
            });
        }
        // Auto-fit target: scene videos auto-fill from settled rows of
        // the Video batch above. Explicit override wins. HF-12 — when
        // no Video batch rows have settled, fall back to the
        // scene_breakdown estimate so Refine script can size the
        // narration before the user burns Grok credits.
        const autoFit = psResolveAutoFitTarget();
        psRefreshReferenceVideos();
        if (autoFit.source === 'override') {
            params.target_duration_s = autoFit.targetDurationS;
        } else if (autoFit.source === 'videos') {
            params.scene_videos = autoFit.sceneVideos;
        } else if (autoFit.source === 'scene_breakdown') {
            params.target_duration_s = autoFit.targetDurationS;
        }
        showLoading('ps-result', 'Refining script for narration (DeepSeek LLM)...');
        try {
            const data = await api.producer.refineScript(params);
            const refined = (data && typeof data.refined_script === 'string') ? data.refined_script : '';
            const usedLlm = !!(data && data.used_llm);
            const warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];
            if (usedLlm && refined) {
                $('ps-script').value = refined;
                // PR-B mirror semantics — once the refined script is in
                // ps-script, treat that as a hand-edit so a subsequent
                // edit to sb-script does not clobber it. Same pattern as
                // copyScriptFromStoryboard's inverse.
                psScriptUserEdited = true;
            }
            const target = $('ps-result');
            if (target) {
                const head = usedLlm
                    ? `<div class="info">Refined script ready (${data.original_length} → ${data.refined_length} chars` +
                      (data.target_words ? `, target ${data.target_words} words for ${data.target_duration_s}s video` : '') +
                      ').</div>'
                    : `<div class="info">Script unchanged (LLM did not run).</div>`;
                const warnHtml = warnings.length
                    ? `<div class="warn">${warnings.map(escapeHtml).join('<br>')}</div>`
                    : '';
                target.innerHTML = head + warnHtml;
                scrollResultIntoView(target);
            }
        } catch (err) {
            showError('ps-result', err);
        }
    }

    // ─── Studio reset & cross-tab handoff ──────────────────────────────────
    function resetStudio() {
        state.lastTopic = '';
        state.lastTitle = '';
        state.lastOutlineParts = null;
        state.lastScript = '';
        state.lastHumanizedScript = '';
        ['st-topics-result', 'st-titles-result', 'st-outline-result',
            'st-script-result', 'st-humanize-result'].forEach((id) => $(id).innerHTML = '');
        $('st-titles-topic').value = '';
        $('st-outline-title').value = '';
        $('st-script-title').value = '';
        $('st-humanize-script').value = '';
    }

    /**
     * HF-16 — push the best available script into the Storyboard panel
     * and switch tabs. Source priority:
     *
     *   1. Humanized output (state.lastHumanizedScript) — the user
     *      humanizes specifically to feed the Storyboard, so prefer
     *      it when present.
     *   2. Raw generated script (state.lastScript) — fallback when
     *      step 5 (Humanize) hasn't been run yet.
     *   3. Whatever the user has typed into the Humanize input — last-
     *      resort so a user who pasted a script directly still gets
     *      the cross-tab handoff.
     *
     * ``resultId`` is the panel's result <div> id (so the Humanize
     * panel's button can complain into its own row instead of the
     * Script panel's row).
     */
    function sendScriptToStoryboard(resultId) {
        const targetResultId = resultId || 'st-script-result';
        const script = (
            asNonEmpty(state.lastHumanizedScript)
            || asNonEmpty(state.lastScript)
            || asNonEmpty($('st-humanize-script').value)
            || ''
        );
        if (!script) {
            showError(targetResultId, { status: 422, message: 'Generate a script first.' });
            return;
        }
        $('sb-script').value = script;
        // PR-B — programmatic ``.value =`` doesn't fire ``input``, so
        // mirror into the Compose panel's script box manually. The
        // mirror is a no-op when the user has already hand-edited the
        // Compose script.
        psSyncScriptFromStoryboard();
        // Switch to storyboard tab.
        const sbBtn = document.querySelector('nav.tabs button[data-tab="storyboard"]');
        if (sbBtn) sbBtn.click();
    }

    // ─── Wire up ──────────────────────────────────────────────────────────
    const handlers = {
        niche: runNiche,
        keywords: runKeywords,
        outlier: runOutlier,
        cloner: runCloner,
        topics: runTopics,
        titles: runTitles,
        outline: runOutline,
        script: runScript,
        humanize: runHumanize,
        'scene-breakdown': runSceneBreakdown,
        'compose-short': runComposeShort,
        // PR-X — LLM clean-up of the Compose-audio script before TTS.
        // Strips prompt JSON / bracketed lists / keyword dumps, sizes
        // narration to scene_videos duration via ffprobe-sum.
        'refine-script': runRefineScript,
        // PR-A — manual re-pull of settled scene videos into the Compose
        // panel's reference summary (used for SRT auto-fit).
        'compose-refresh-reference': composeRefreshReference,
        'storyboard-batch-fill': async () => sbbAutoFill(),
        'storyboard-batch-clear': async () => sbbClear(),
        'storyboard-batch-image': sbbGenerateImages,
        'storyboard-batch-video': sbbGenerateVideos,
        // HF-5 #9 — bulk re-run all rows that landed in the fallback
        // bucket on the last batch. Settled rows are skipped.
        'storyboard-batch-retry-failed-image': async () => sbbRetryFailed('image'),
        'storyboard-batch-retry-failed-video': async () => sbbRetryFailed('video'),
        // HF-13 — rewrite stuck image_prompts via DeepSeek so Grok /
        // CDN moderation stops returning <100KB blurred placeholders.
        'storyboard-soften-prompts': async () => sbbSoftenPrompts(),
        // HF-5 #11 — open the active output folder in the OS file browser.
        'storyboard-batch-open-output-image': async () => sbbOpenOutputFolder('image'),
        'storyboard-batch-open-output-video': async () => sbbOpenOutputFolder('video'),
        'storyboard-batch-login': sbbOpenLogin,
        // PR-27: re-roll all variants for every scene currently in
        // the image-batch table using the current Visual DNA.
        'storyboard-reroll-variants': sbbRerollAll,
        // PR-28: global reference image attach / clear (shared with
        // every variant unless the row has its own override).
        'storyboard-ref-add': sbbAddGlobalRefs,
        'storyboard-ref-clear': async () => sbbClearGlobalRefs(),
        // PR-24: native folder pickers — drop the chosen path into the
        // matching <input>. Cancel is a no-op (preserves current value).
        // HF-5 #1 — the picker now drives the icon-only 📁 button; refresh
        // the tooltip so the user sees the chosen path on hover.
        'storyboard-batch-pick-output': async () => {
            await sbbPickOutputDir('sbb-output-dir');
            sbbRefreshOutputDirTooltip();
        },
        'producer-short-pick-output': async () => sbbPickOutputDir('ps-output-dir'),
        // PR-31: Video Assembly panel — file pickers + autofill +
        // POST /producer/assemble.
        'assemble-pick-output': async () => sbbPickOutputDir('pa-output-dir'),
        'assemble-pick-audio': paPickAudioFile,
        'assemble-pick-srt': paPickSrtFile,
        'assemble-pull-from-batch': paPullFromBatch,
        'assemble-use-latest-audio': paUseLatestAudio,
        'assemble': runAssemble,
        // PR-21: the always-on banner swaps its CTA to "Refresh status"
        // when the session is `ready`. The handler is intentionally a
        // re-poll, not a re-login.
        'storyboard-batch-refresh-session': async () => sbbCheckSession(),
        // PR-22: Account Manager (programmatic auto-login).
        'storyboard-account-add': async () => sbaAddRow(),
        'storyboard-account-save': sbaSave,
        'storyboard-account-auto-login': sbaAutoLogin,
    };

    function setupRunButtons() {
        $$('button[data-run]').forEach((btn) => {
            // PR-21: resolve the data-run attribute at *click time*, not
            // at setup time. The login banner button mutates its own
            // data-run as the session state flips between
            // login / refresh-status, so a static lookup would freeze
            // the wrong handler in.
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-run');
                const fn = handlers[key];
                if (!fn) return;
                if (!api) {
                    const target = btn.closest('.panel').querySelector('.result');
                    if (target) showError(target.id, { message: 'electronAPI not available — run via `npm run dev`.' });
                    return;
                }
                fn().catch((err) => console.error('handler', key, err));
            });
        });
        $$('button[data-action]').forEach((btn) => {
            const action = btn.getAttribute('data-action');
            if (action === 'reset-studio') btn.addEventListener('click', resetStudio);
            if (action === 'send-to-storyboard') {
                // HF-16 — `data-result-id` lets the Humanize panel button
                // (added in this PR) report missing-script errors into
                // its own result row instead of the Script panel's.
                const resultId = btn.getAttribute('data-result-id') || 'st-script-result';
                btn.addEventListener('click', () => sendScriptToStoryboard(resultId));
            }
            if (action === 'copy-script-from-storyboard') btn.addEventListener('click', copyScriptFromStoryboard);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        setupTabs();
        setupRunButtons();
        setupApiKeysModal();
        // On first launch (no keys saved yet) auto-open the modal so the
        // user is prompted to enter keys instead of silently hitting
        // "DEEPSEEK_API_KEY not set" warnings on every Studio call.
        loadApiKeysIntoForm()
            .then((result) => {
                const keys = result && result.keys ? result.keys : {};
                const hasAnyKey = Object.values(keys).some(
                    (v) => typeof v === 'string' && v.length > 0,
                );
                if (!hasAnyKey) openApiKeysModal();
            })
            .catch(() => { /* non-fatal — pill / status will surface errors */ });
        refreshSidecarStatus();
        // Populate the voice picker once the sidecar is reachable. The first
        // attempt may hit the soft sentinel; retry alongside the status poll
        // so the picker fills in shortly after cold start.
        populateVoicePicker();
        // PR-30 — paint the Compose panel's mode-aware visibility on
        // first paint and again whenever the user flips the dropdown,
        // so the Style picker hides / button label updates without
        // requiring a panel rebuild.
        // PR-A — paint the reference-video summary on cold start so the
        // empty-state message is visible before the user runs the batch.
        try { psRefreshReferenceVideos(); } catch (_e) { /* tolerant */ }
        // PR-A — flip the user-edited flag the first time anyone types
        // into the assemble scene-videos textarea so subsequent batch
        // settles do NOT clobber the manual edit. ``Refresh from Video
        // batch`` resets the flag inside ``paPullFromBatch``.
        const paScenesTa = $('pa-scene-videos');
        if (paScenesTa) {
            paScenesTa.addEventListener('input', () => { paScenesUserEdited = true; });
        }
        // HF-10 — caption-mode change toggles the burn-only styling
        // row + paint cold-start state so the row is hidden on first
        // load (default = soft).
        const paCaptionModeSel = $('pa-caption-mode');
        if (paCaptionModeSel) {
            paCaptionModeSel.addEventListener('change', paUpdateBurnStyleVisibility);
        }
        paUpdateBurnStyleVisibility();
        // HF-10 — speech-rate slider live label sync. Paint cold-start
        // value too so a non-zero default ever shipped via HTML
        // attribute renders correctly.
        const psRateSlider = $('ps-rate');
        if (psRateSlider) {
            psRateSlider.addEventListener('input', psUpdateRateLabel);
        }
        psUpdateRateLabel();
        // PR-B — auto-mirror Storyboard's script into Compose's script
        // box on cold paint and on every Storyboard edit. We flip the
        // user-edited flag the first time anyone types into Compose's
        // box so subsequent Storyboard edits don't clobber a manual
        // tweak. ``Copy script from above`` re-arms the mirror.
        psSyncScriptFromStoryboard();
        const sbScriptTa = $('sb-script');
        if (sbScriptTa) {
            sbScriptTa.addEventListener('input', psSyncScriptFromStoryboard);
        }
        const psScriptTa = $('ps-script');
        if (psScriptTa) {
            psScriptTa.addEventListener('input', () => { psScriptUserEdited = true; });
        }
        // P2 — TTS provider × Voice picker coupling. When the user
        // flips the provider dropdown, repaint the voice <select>
        // from the cached /producer/voices payload, filtered to
        // that provider's voices. Avoids the pre-PR foot-gun where
        // ``provider=piper-tts`` + ``voice=en-US-AriaNeural`` (an
        // edge-tts id) would silently mis-route on the sidecar.
        const psProviderSel = $('ps-tts-provider');
        if (psProviderSel) psProviderSel.addEventListener('change', _psOnProviderChange);
        // PR-20D — paint the empty-state for the batch panel and
        // poll the Grok session banner so the user sees right away
        // whether they need to log in.
        sbbRepaintAll();
        // HF-5 #1 — paint the picker tooltip from cold start so users
        // who haven't picked anything yet still see the helper text.
        sbbRefreshOutputDirTooltip();
        // HF-5 #5 — Pro mode is now always-on. The HTML default already
        // sets ``checked``, but force it programmatically too so a stale
        // session restore can't sneak through with Pro mode off.
        const proModeForceCb = $('sbb-pro-mode');
        if (proModeForceCb) proModeForceCb.checked = true;
        // PR-48 — wire Pro mode + image/video count auto-sync.
        // Order matters: apply Pro mode FIRST so a stale checkbox
        // from a previous session restore is reflected in the images
        // select state before the videos select reads its value.
        sbbApplyProMode();
        const proModeCb = $('sbb-pro-mode');
        if (proModeCb) proModeCb.addEventListener('change', sbbApplyProMode);
        const imgsPerSceneSel = $('sbb-images-per-scene');
        if (imgsPerSceneSel) imgsPerSceneSel.addEventListener('change', sbbSyncVideosFromImages);
        const vidsPerSceneSel = $('sbb-videos-per-scene');
        if (vidsPerSceneSel) vidsPerSceneSel.addEventListener('change', () => {
            // Once the user explicitly picks a videos count we stop
            // auto-syncing — their intent wins until they reload.
            sbbState.userOverroteVideosPerScene = true;
        });
        // PR-28 — paint the global ref list so the empty-state is
        // visible from cold start.
        sbbRenderGlobalRefs();
        sbbCheckSession().catch(() => {});
        setInterval(() => sbbCheckSession().catch(() => {}), 30_000);
        // PR-22: Account Manager — load saved accounts, wire delegated
        // handlers for in-row inputs/buttons, and stream main-process
        // setupAccounts logs into the panel's log feed.
        sbaLoad().catch(() => {});
        sbaWireDelegatedHandlers();
        if (api && typeof api.onLog === 'function') {
            api.onLog((data) => {
                if (!sbaState.autoLoginInFlight) return;
                if (!data || typeof data !== 'object') return;
                const level = data.level === 'error' || data.level === 'success' ? data.level : 'info';
                sbaPushLog(level, String(data.message || data.msg || ''));
            });
        }
        const voicePollHandle = setInterval(() => {
            const ps = $('ps-voice');
            if (!ps || ps.options.length > 1) { clearInterval(voicePollHandle); return; }
            populateVoicePicker();
        }, 5000);
        // Re-poll every 5s so the dot recovers when the sidecar comes online late.
        setInterval(refreshSidecarStatus, 5000);
    });
})();
