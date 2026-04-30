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
        // Latest scene_breakdown — captured so "Compose with AutoGrok"
        // (PR-16) can pick up scenes without re-running the LLM.
        lastScenes: [],
        lastSceneScript: '',
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
        $(targetId).innerHTML = `<div class="loading"><span class="spinner"></span>${escapeHtml(label)}</div>`;
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
        let html = '';
        html += `<div class="stats-row">
            <span>Chars in<b>${escapeHtml(data.chars_in || 0)}</b></span>
            <span>Chars out<b>${escapeHtml(data.chars_out || out.length)}</b></span>
        </div>`;
        if (out) {
            html += `<details open><summary>Humanized script</summary><pre style="max-height:480px">${escapeHtml(out)}</pre></details>`;
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
        const nField = $('sb-n-scenes').value;
        const params = {
            script,
            template_key: $('sb-template').value || 'cinematic',
            words_per_minute: asInt($('sb-wpm').value, 150),
            language: $('sb-language').value || 'en',
        };
        if (nField && nField.trim().length) {
            params.n_scenes = asInt(nField, 12);
        }
        showLoading('sb-result', 'Breaking script into scenes (DeepSeek)...');
        try {
            const data = await api.storyboard.fromScript(params);
            renderSceneBreakdown(data);
        } catch (err) {
            showError('sb-result', err);
        }
    }

    function renderSceneBreakdown(data) {
        const scenes = (data && data.scenes) || [];
        // Capture for the "Compose with AutoGrok" handoff (PR-16). The
        // panel reuses the same script that was just broken into scenes.
        state.lastScenes = scenes.slice();
        state.lastSceneScript = asNonEmpty($('sb-script').value) || '';
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
    async function populateVoicePicker() {
        if (!api) return;
        const sel = $('ps-voice');
        if (!sel) return;
        try {
            const data = await api.producer.listVoices();
            if (!data || !Array.isArray(data.voices) || !data.voices.length) return;
            const current = sel.value;
            sel.innerHTML = data.voices
                .map((v) => `<option value="${escapeHtml(v.short_name)}">${escapeHtml(v.label || v.short_name)}</option>`)
                .join('');
            const desired = current || data.default || data.voices[0].short_name;
            const found = Array.from(sel.options).find((o) => o.value === desired);
            if (found) sel.value = desired;
        } catch (err) {
            // Sidecar not ready yet — listVoices returns the soft sentinel.
            // Leave the static placeholder option alone; refresh on next call.
        }
    }

    async function runComposeShort() {
        const script = asNonEmpty($('ps-script').value) || asNonEmpty($('sb-script').value);
        if (!script) {
            showError('ps-result', { status: 422, message: 'Paste a script (or copy from Storyboard above).' });
            return;
        }
        const params = {
            script,
            voice: $('ps-voice').value || 'en-US-AriaNeural',
            style: $('ps-style').value || 'violet-pink',
            write_srt: !!$('ps-write-srt').checked,
        };
        const outDir = asNonEmpty($('ps-output-dir').value);
        if (outDir) params.output_dir = outDir;
        showLoading('ps-result', 'Rendering TTS + captions + 9:16 mp4 (this can take 10–60s)...');
        try {
            const data = await api.producer.composeShort(params);
            renderComposeShort(data);
        } catch (err) {
            showError('ps-result', err);
        }
    }

    function renderComposeShort(data) {
        const d = data || {};
        let html = '';
        html += `<div class="stats-row">
            <span>Duration<b>${escapeHtml((d.duration_s || 0).toFixed(2))}s</b></span>
            <span>Voice<b>${escapeHtml(d.voice || '')}</b></span>
            <span>Engine<b>${escapeHtml(d.engine || '')}</b></span>
            <span>Style<b>${escapeHtml(d.style || '')}</b></span>
            <span>Captions<b>${escapeHtml(d.captions_count || 0)}</b></span>
            <span>Caption source<b>${escapeHtml(d.caption_source || 'none')}</b></span>
        </div>`;
        const paths = [
            ['mp4', d.mp4_path],
            ['voice.mp3', d.audio_path],
            ['captions.srt', d.srt_path],
        ].filter(([, p]) => !!p);
        if (paths.length) {
            html += `<div class="scene-card"><div class="scene-title">Output files</div>`;
            paths.forEach(([label, p]) => {
                html += `<div class="scene-block"><span class="scene-label">${escapeHtml(label)}</span><code>${escapeHtml(p)}</code></div>`;
            });
            html += `<div class="scene-meta">Output dir: <code>${escapeHtml(d.output_dir || '')}</code></div></div>`;
        } else {
            html += renderEmpty('No mp4 produced. Check warnings — Edge-TTS or moviepy may be missing.');
        }
        html += renderWarnings(d.warnings);
        html += renderRawJson(d);
        $('ps-result').innerHTML = html;
    }

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
        }
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
        currentVideoBatchSceneIds: [],
        listenerInstalled: false,
        sessionKnown: false,
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
            return;
        }
        target.innerHTML = sbbRenderTable(sbbState.imageRows, 'image');
    }

    /** Repaint just the video batch table. */
    function sbbRepaintVideo() {
        const target = $('sbb-video-result');
        if (!target) return;
        if (!sbbState.videoRows.length) {
            target.innerHTML = '<div class="empty">No prompts loaded. Click "Auto-fill from scenes" after running "Break into scenes" above.</div>';
            return;
        }
        target.innerHTML = sbbRenderTable(sbbState.videoRows, 'video');
    }

    /**
     * Render a per-row table for either kind. Same column layout for
     * both so the panels are visually consistent: # | scene | prompt |
     * status (pill + progress bar + thumb when settled) | actions.
     */
    function sbbRenderTable(rows, kind) {
        const helpers = window.StoryboardBatchHelpers;
        const summary = helpers.summarizeRows(rows);
        const summaryStr = `total ${summary.total}`
            + (summary.generated ? ` · ${summary.generated} done` : '')
            + (summary.generating ? ` · ${summary.generating} generating` : '')
            + (summary.fallback ? ` · ${summary.fallback} failed` : '')
            + (summary.skipped ? ` · ${summary.skipped} skipped` : '');
        let html = `<div class="stats-row"><span>${escapeHtml(summaryStr)}</span></div>`;
        html += `<table class="swc-table"><thead><tr>
            <th>#</th><th>Scene</th><th>Prompt</th><th>Status</th><th>Output</th><th>Actions</th>
        </tr></thead><tbody>`;
        for (const r of rows) {
            const label = helpers.statusLabel(r.status);
            const cls = helpers.statusClass(r.status);
            let statusCell = `<span class="pill ${escapeHtml(cls)}">${escapeHtml(label)} (${escapeHtml(r.attempts || 0)}x)</span>`;
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
            const actions = outPath ? sbbRenderPathActions(outPath) : '<span class="muted">—</span>';
            html += `<tr>
                <td class="scene-num">${escapeHtml(r.order)}</td>
                <td><b>scene ${escapeHtml(r.scene_id != null ? r.scene_id : '?')}</b><div class="reason">${escapeHtml(r.title)} · ${escapeHtml((typeof r.duration_s === 'number') ? r.duration_s.toFixed(1) : r.duration_s)}s</div></td>
                <td class="prompt-cell">${escapeHtml(r.prompt || '')}</td>
                <td>${statusCell}</td>
                <td>${outCell}</td>
                <td class="actions">${actions}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        return html;
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
     * Resolve thumbnail file:// URLs after a phase settles. Reuses
     * `electronAPI.getFileUrl` (same approach as PR-20C).
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
                const sid = sbbState.currentImageBatchSceneIds[idx];
                sbbState.imageRows = helpers.applyBatchProgress(sbbState.imageRows, sid, progress);
                sbbRepaintImage();
            } else if ((jobId === 'i2v' || jobId === 'video') && idx >= 0 && idx < sbbState.currentVideoBatchSceneIds.length) {
                const sid = sbbState.currentVideoBatchSceneIds[idx];
                sbbState.videoRows = helpers.applyBatchProgress(sbbState.videoRows, sid, progress);
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
        sbbState.imageRows = helpers.initImageRowsFromScenes(scenes);
        sbbState.videoRows = helpers.initVideoRowsFromScenes(scenes);
        sbbRepaintAll();
    }

    function sbbClear() {
        sbbState.imageRows = [];
        sbbState.videoRows = [];
        sbbRepaintAll();
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

    async function sbbGenerateImages() {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        if (!sbbState.imageRows.length) {
            sbbAutoFill();
            if (!sbbState.imageRows.length) return;
        }
        if (!api || !api.image || typeof api.image.generate !== 'function') {
            $('sbb-image-result').innerHTML = '<div class="error">electronAPI.image.generate unavailable.</div>';
            return;
        }
        const plan = helpers.planImageGenerate(sbbState.imageRows);
        if (!plan.prompts.length) {
            $('sbb-image-result').innerHTML = '<div class="error">No eligible image prompts (every scene was skipped — check image_prompt).</div>';
            return;
        }
        sbbInstallListener();
        sbbState.imageRows = helpers.startBatchPhase(sbbState.imageRows);
        sbbState.currentImageBatchSceneIds = plan.sceneIds.slice();
        sbbRepaintImage();

        const config = { imageGenerationCount: 1 };
        const aspect = asNonEmpty(($('sbb-aspect') || {}).value || '');
        if (aspect) config.aspectRatio = aspect;
        let resp;
        try {
            resp = await api.image.generate({ prompts: plan.prompts, config });
        } catch (err) {
            const banner = $('sbb-image-result');
            if (banner) banner.insertAdjacentHTML('afterbegin', `<div class="error">image:generate IPC threw: ${escapeHtml(err && err.message || String(err))}</div>`);
            return;
        }
        const settled = helpers.mapBatchResponse(resp, plan.sceneIds, 'image');
        for (const r of settled) {
            sbbState.imageRows = helpers.applyBatchResult(sbbState.imageRows, r.scene_id, r);
        }
        // Re-pair the video table now that some images settled —
        // I2V mode depends on having the latest image_path bindings.
        sbbState.videoRows = helpers.pairImagePathsForI2V(sbbState.videoRows, sbbState.imageRows);
        sbbRepaintAll();
        sbbResolveUrls(sbbState.imageRows, 'image').catch(() => {});

        if (resp && resp.success === false) {
            const why = resp.error || 'Unknown — check Login panel for an active Grok session.';
            $('sbb-image-result').insertAdjacentHTML('afterbegin', `<div class="error">image:generate failed: ${escapeHtml(why)}</div>`);
        }
    }

    async function sbbGenerateVideos() {
        const helpers = window.StoryboardBatchHelpers;
        if (!helpers) return;
        if (!sbbState.videoRows.length) {
            sbbAutoFill();
            if (!sbbState.videoRows.length) return;
        }
        const mode = ($('sbb-video-mode') || {}).value || 'i2v';
        if (mode === 'i2v') {
            if (!api || !api.i2v || typeof api.i2v.generate !== 'function') {
                $('sbb-video-result').innerHTML = '<div class="error">electronAPI.i2v.generate unavailable.</div>';
                return;
            }
        } else {
            if (!api || !api.video || typeof api.video.generate !== 'function') {
                $('sbb-video-result').innerHTML = '<div class="error">electronAPI.video.generate unavailable (T2V).</div>';
                return;
            }
        }
        // Always re-pair before planning so the latest image table state
        // is reflected in I2V eligibility.
        sbbState.videoRows = helpers.pairImagePathsForI2V(sbbState.videoRows, sbbState.imageRows);
        const plan = helpers.planVideoGenerate(sbbState.videoRows, mode);
        const eligibleCount = mode === 'i2v' ? plan.items.length : plan.prompts.length;
        if (!eligibleCount) {
            const reason = mode === 'i2v'
                ? 'No eligible scenes — generate images first or switch to T2V mode.'
                : 'No video prompts — every scene is missing video_prompt / flow_video_prompt.';
            $('sbb-video-result').insertAdjacentHTML('afterbegin', `<div class="error">${escapeHtml(reason)}</div>`);
            return;
        }
        sbbInstallListener();
        // Mark eligible rows as generating, but also reflect any
        // skipped rows from the plan (e.g. I2V rows missing an image).
        const eligibleSet = new Set(plan.sceneIds.map(String));
        const skippedMap = new Map((plan.skipped || []).map((s) => [String(s.scene_id), s.reason]));
        sbbState.videoRows = sbbState.videoRows.map((row) => {
            const sid = String(row.scene_id);
            if (eligibleSet.has(sid)) {
                return Object.assign({}, row, { status: 'generating', progress: 0, attempts: (row.attempts || 0) + 1 });
            }
            if (skippedMap.has(sid)) {
                return Object.assign({}, row, { status: 'skipped', reason: skippedMap.get(sid) });
            }
            return row;
        });
        sbbState.currentVideoBatchSceneIds = plan.sceneIds.slice();
        sbbRepaintVideo();

        let resp;
        try {
            if (mode === 'i2v') {
                resp = await api.i2v.generate({ items: plan.items });
            } else {
                resp = await api.video.generate({ prompts: plan.prompts });
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
            ? await helpers.mapBatchResponseAsync(resp, plan.sceneIds, 'video', { validateFn })
            : helpers.mapBatchResponse(resp, plan.sceneIds, 'video');
        for (const r of settled) {
            sbbState.videoRows = helpers.applyBatchResult(sbbState.videoRows, r.scene_id, r);
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
    }

    // ─── Studio reset & cross-tab handoff ──────────────────────────────────
    function resetStudio() {
        state.lastTopic = '';
        state.lastTitle = '';
        state.lastOutlineParts = null;
        state.lastScript = '';
        ['st-topics-result', 'st-titles-result', 'st-outline-result',
            'st-script-result', 'st-humanize-result'].forEach((id) => $(id).innerHTML = '');
        $('st-titles-topic').value = '';
        $('st-outline-title').value = '';
        $('st-script-title').value = '';
        $('st-humanize-script').value = '';
    }

    function sendScriptToStoryboard() {
        const script = state.lastScript || asNonEmpty($('st-humanize-script').value) || '';
        if (!script) {
            showError('st-script-result', { status: 422, message: 'Generate a script first.' });
            return;
        }
        $('sb-script').value = script;
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
        'storyboard-batch-fill': async () => sbbAutoFill(),
        'storyboard-batch-clear': async () => sbbClear(),
        'storyboard-batch-image': sbbGenerateImages,
        'storyboard-batch-video': sbbGenerateVideos,
        'storyboard-batch-login': sbbOpenLogin,
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
            if (action === 'send-to-storyboard') btn.addEventListener('click', sendScriptToStoryboard);
            if (action === 'copy-script-from-storyboard') btn.addEventListener('click', copyScriptFromStoryboard);
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        setupTabs();
        setupRunButtons();
        refreshSidecarStatus();
        // Populate the voice picker once the sidecar is reachable. The first
        // attempt may hit the soft sentinel; retry alongside the status poll
        // so the picker fills in shortly after cold start.
        populateVoicePicker();
        // PR-20D — paint the empty-state for the batch panel and
        // poll the Grok session banner so the user sees right away
        // whether they need to log in.
        sbbRepaintAll();
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
