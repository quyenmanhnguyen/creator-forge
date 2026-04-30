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

    // ─── Storyboard: Compose with AutoGrok (PR-16, retries+partial in PR-17) ─
    // One-click drives the full pipeline:
    //   image:generate (1 image per scene, with scene-level retry)
    //   → pick first ≥50KB savedFile per scene (PR-9 blur threshold)
    //   → producer:composeShort with scene_assets[]
    // Loading state flips between phases AND updates per retry attempt so
    // the user sees progress during the 30–120s image generation phase.
    async function runStoryboardCompose() {
        const helpers = (typeof window !== 'undefined' && window.StoryboardComposeHelpers) || null;
        if (!helpers) {
            showError('swc-result', { message: 'storyboard_compose_helpers.js failed to load (check the renderer console).' });
            return;
        }
        if (typeof helpers.orchestrateImageGenerationWithRetries !== 'function') {
            showError('swc-result', { message: 'storyboard_compose_helpers.js is out of date — rebuild Electron (missing orchestrateImageGenerationWithRetries).' });
            return;
        }
        if (!api || !api.image || typeof api.image.generate !== 'function') {
            showError('swc-result', { message: 'electronAPI.image.generate is unavailable — run via `npm run dev`.' });
            return;
        }
        if (!api.producer || typeof api.producer.composeShort !== 'function') {
            showError('swc-result', { message: 'electronAPI.producer.composeShort is unavailable — sidecar bridge missing.' });
            return;
        }
        if (typeof api.statBytes !== 'function') {
            showError('swc-result', { message: 'electronAPI.statBytes is unavailable — preload.js out of date (rebuild Electron).' });
            return;
        }

        const scenes = (state.lastScenes || []).slice();
        if (!scenes.length) {
            showError('swc-result', { status: 422, message: 'Run "Break into scenes" first — no scene_breakdown captured yet.' });
            return;
        }
        const script = state.lastSceneScript || asNonEmpty($('sb-script').value);
        if (!script) {
            showError('swc-result', { status: 422, message: 'Storyboard script is empty — paste one above first.' });
            return;
        }

        // PR-17 form fields. Default to 2 attempts (1 retry) + allow_partial=true.
        const maxAttempts = Math.max(1, Math.min(5, parseInt($('swc-max-attempts').value, 10) || 2));
        const allowPartial = !!$('swc-allow-partial').checked;
        // PR-20B fields — opt-in I2V motion clips.
        const useI2V = !!($('swc-use-i2v') && $('swc-use-i2v').checked);
        const maxAttemptsI2V = Math.max(1, Math.min(5, parseInt(($('swc-max-attempts-i2v') || {}).value, 10) || 2));
        const videoHelpers = (typeof window !== 'undefined' && window.StoryboardVideoComposeHelpers) || null;
        if (useI2V) {
            if (!videoHelpers || typeof videoHelpers.orchestrateI2VWithRetries !== 'function') {
                showError('swc-result', { message: 'storyboard_video_compose_helpers.js failed to load — rebuild Electron to pick up PR-20B.' });
                return;
            }
            if (!api.i2v || typeof api.i2v.generate !== 'function') {
                showError('swc-result', { message: 'electronAPI.i2v.generate is unavailable — preload.js out of date (rebuild Electron) or I2V provider not wired.' });
                return;
            }
        }

        // Preflight: catch the "no usable scenes at all" case before starting
        // the long-running orchestration so the error message is actionable.
        const planned = helpers.planPromptsFromScenes(scenes);
        if (!planned.prompts.length) {
            const skipDetail = planned.skipped
                .map((s) => `scene ${s.scene_id != null ? s.scene_id : '?'}: ${s.reason}`)
                .join('; ');
            showError('swc-result', {
                status: 422,
                message: `No usable scenes — every scene is missing image_prompt or duration_s. ${skipDetail ? '(' + skipDetail + ')' : ''}`,
            });
            return;
        }
        const skipNote = planned.skipped.length
            ? ` (${planned.skipped.length} scene${planned.skipped.length === 1 ? '' : 's'} skipped — missing image_prompt or duration_s)`
            : '';

        // ── PR-20C: per-scene table view ────────────────────────────────
        // The table is the single source of UI truth from this point on:
        // every phase mutates `tableState` and re-renders. We keep the
        // existing scene-level retry / fallback orchestration unchanged
        // and just plumb its progress + final settle through the table.
        const tableHelpers = (typeof window !== 'undefined' && window.StoryboardComposeTableHelpers) || null;
        if (!tableHelpers) {
            showError('swc-result', { message: 'storyboard_compose_table_helpers.js failed to load — rebuild Electron to pick up PR-20C.' });
            return;
        }
        let tableState = tableHelpers.initRowsFromScenes(scenes);
        // planPromptsFromScenes returns prompts in scene order with
        // skipped scenes filtered out — the orchestrator's sceneIds
        // match this filtered list. Recompute the eligible ids from
        // `planned.skipped` so the table phase setup is robust.
        const skippedImageIds = new Set((planned.skipped || []).map((s) => String(s.scene_id)));
        const eligibleImageIds = scenes
            .filter((s) => !skippedImageIds.has(String(s.scene_id)))
            .map((s) => s.scene_id);
        tableState = tableHelpers.startImagePhase(tableState, eligibleImageIds, planned.skipped || []);

        // Render context (shared across phases). `compose` and the
        // I2V orchestration outputs are filled in as phases complete.
        const renderCtx = {
            scenes,
            sceneCount: scenes.length,
            promptCount: planned.prompts.length,
            maxAttempts,
            allowPartial,
            useI2V,
            maxAttemptsI2V,
            phase: 'image',
            phaseNote: '',
            compose: null,
            sceneAssets: null,
            videoSceneAssets: null,
            retryCount: 0,
            fallbackCount: 0,
            videoRetryCount: 0,
            videoFallbackCount: 0,
            videoMaxAttempts: 1,
        };
        const repaint = () => renderSwcTable(tableState, renderCtx);
        repaint();

        // Wire `job:progress` so each row's progress bar moves live.
        // The IPC payload's `globalIdx` indexes into the *current
        // batch*, not the original scene list, so we keep the
        // current batch's sceneIds in closure and look up scene_id
        // from the batch index when an event fires.
        let currentImageBatchSceneIds = eligibleImageIds.slice();
        let currentI2VBatchSceneIds = [];
        const progressListener = (data) => {
            if (!data || !data.progress) return;
            const { jobId, progress } = data;
            const idx = (progress && typeof progress.globalIdx === 'number') ? progress.globalIdx : -1;
            if (jobId === 'image' && idx >= 0 && idx < currentImageBatchSceneIds.length) {
                tableState = tableHelpers.applyImageProgress(tableState, currentImageBatchSceneIds[idx], progress);
                repaint();
            } else if (jobId === 'i2v' && idx >= 0 && idx < currentI2VBatchSceneIds.length) {
                tableState = tableHelpers.applyI2VProgress(tableState, currentI2VBatchSceneIds[idx], progress);
                repaint();
            }
        };
        if (typeof api.onProgress === 'function') api.onProgress(progressListener);
        const cleanup = () => {
            if (typeof api.removeProgressListener === 'function') api.removeProgressListener();
        };

        // ── Phase 1: image:generate (with retries) ──────────────────────
        const config = { imageGenerationCount: 1 };
        const aspect = asNonEmpty($('swc-aspect').value);
        if (aspect) config.aspectRatio = aspect;

        const imageGenerateFn = async (prompts, ctx) => {
            const attemptNumber = (ctx && ctx.attemptNumber) || 1;
            const sceneIds = (ctx && Array.isArray(ctx.sceneIds)) ? ctx.sceneIds.slice() : [];
            currentImageBatchSceneIds = sceneIds;
            if (attemptNumber > 1) {
                tableState = tableHelpers.startImageRetry(tableState, sceneIds, attemptNumber);
                repaint();
            }
            return api.image.generate({ prompts, config });
        };

        let orchestration;
        try {
            orchestration = await helpers.orchestrateImageGenerationWithRetries(
                scenes, imageGenerateFn, (p) => api.statBytes(p),
                { maxAttempts },
            );
        } catch (err) {
            cleanup();
            showError('swc-result', { message: `Orchestration threw: ${err && err.message ? err.message : String(err)}` });
            return;
        }

        const { sceneAssets, perSceneStatus, retryCount, imageGenerate } = orchestration;
        const fallbackCount = helpers.countFallbackScenes(perSceneStatus);

        // Settle every image row from the orchestrator's final
        // per-scene status table.
        for (const s of perSceneStatus) {
            tableState = tableHelpers.applyImageResult(tableState, s.scene_id, {
                status: s.status,
                attempts: s.attempts,
                image_path: s.image_path != null ? s.image_path : null,
                reason: s.reason != null ? s.reason : null,
            });
        }
        renderCtx.sceneAssets = sceneAssets;
        renderCtx.retryCount = retryCount;
        renderCtx.fallbackCount = fallbackCount;
        repaint();
        // Resolve thumbnail file:// URLs for any newly-settled image
        // rows; non-blocking so the table stays responsive.
        resolveThumbnailUrls(tableState, repaint).catch(() => {});

        // Surface a Grok-session-down error early.
        if (imageGenerate && imageGenerate.success === false && sceneAssets.length === 0) {
            cleanup();
            const why = imageGenerate.error || 'Unknown — most common cause is no active Grok session. Open the Login panel, sign in, then retry.';
            renderCtx.errorMessage = `Grok image generation failed: ${why}`;
            repaint();
            return;
        }

        // Strict mode: any scene in `fallback` blocks the compose call.
        if (!allowPartial && fallbackCount > 0) {
            cleanup();
            const detail = perSceneStatus
                .filter((s) => s.status === 'fallback')
                .map((s) => `scene ${s.scene_id != null ? s.scene_id : '?'}: ${s.reason || 'no usable image'}`)
                .join('; ');
            renderCtx.errorMessage = `${fallbackCount} scene(s) missing usable images after ${maxAttempts} attempt(s) and "Allow partial compose" is off — aborting before composer. (${detail})`;
            repaint();
            return;
        }

        if (sceneAssets.length === 0) {
            cleanup();
            const detail = perSceneStatus
                .map((s) => `scene ${s.scene_id != null ? s.scene_id : '?'}: ${s.status}${s.reason ? ' (' + s.reason + ')' : ''}`)
                .join('; ');
            renderCtx.errorMessage = `No scenes produced a usable Grok image after ${maxAttempts} attempt(s). Composer would just be gradient — retry image generation. (${detail})`;
            repaint();
            return;
        }

        // ── Phase 2 (optional, PR-20B): i2v:generate per scene ──────────
        let videoSceneAssets = [];
        let videoPerSceneStatus = [];
        let videoRetryCount = 0;
        let videoFallbackCount = 0;
        let videoMaxAttempts = 1;
        let i2vFirstResp = null;
        if (useI2V && sceneAssets.length > 0) {
            const { jobs, skipped: i2vPlanSkipped } = videoHelpers
                .planI2VJobsFromScenesAndAssets(scenes, sceneAssets);
            // Surface I2V-eligible vs. plan-skipped rows in the table.
            tableState = tableHelpers.startI2VPhase(tableState, jobs.map((j) => j.scene_id), i2vPlanSkipped || []);
            renderCtx.phase = 'i2v';
            repaint();
            if (jobs.length > 0) {
                const i2vGenerateFn = async (items, ctx) => {
                    const attemptNumber = (ctx && ctx.attemptNumber) || 1;
                    const sceneIds = (ctx && Array.isArray(ctx.sceneIds)) ? ctx.sceneIds.slice() : [];
                    currentI2VBatchSceneIds = sceneIds;
                    if (attemptNumber > 1) {
                        tableState = tableHelpers.startI2VRetry(tableState, sceneIds, attemptNumber);
                        repaint();
                    }
                    return api.i2v.generate({ items });
                };
                let videoOrch;
                try {
                    videoOrch = await videoHelpers.orchestrateI2VWithRetries(
                        jobs, i2vGenerateFn, (p) => api.statBytes(p),
                        { maxAttempts: maxAttemptsI2V },
                    );
                } catch (err) {
                    cleanup();
                    renderCtx.errorMessage = `I2V orchestration threw: ${err && err.message ? err.message : String(err)}`;
                    repaint();
                    return;
                }
                videoSceneAssets = videoOrch.videoSceneAssets;
                videoPerSceneStatus = videoOrch.perSceneStatus;
                videoRetryCount = videoOrch.retryCount;
                videoMaxAttempts = videoOrch.maxAttempts;
                i2vFirstResp = videoOrch.i2vGenerate;
            }
            for (const sk of i2vPlanSkipped) {
                videoPerSceneStatus.push({
                    scene_id: sk.scene_id,
                    status: 'skipped',
                    attempts: 0,
                    reason: sk.reason,
                });
            }
            videoFallbackCount = videoHelpers.countFallbackI2VScenes(videoPerSceneStatus);

            // Settle every I2V row from the orchestrator's status.
            for (const s of videoPerSceneStatus) {
                tableState = tableHelpers.applyI2VResult(tableState, s.scene_id, {
                    status: s.status,
                    attempts: s.attempts,
                    video_path: s.video_path != null ? s.video_path : null,
                    reason: s.reason != null ? s.reason : null,
                });
            }
            renderCtx.videoSceneAssets = videoSceneAssets;
            renderCtx.videoRetryCount = videoRetryCount;
            renderCtx.videoFallbackCount = videoFallbackCount;
            renderCtx.videoMaxAttempts = videoMaxAttempts;
            renderCtx.i2vFirstResp = i2vFirstResp;
            repaint();
            resolveThumbnailUrls(tableState, repaint).catch(() => {});
        }

        // ── Phase 3: compose ────────────────────────────────────────────
        const phaseNoteParts = [];
        if (fallbackCount > 0) phaseNoteParts.push(`${fallbackCount} scene${fallbackCount === 1 ? '' : 's'} gradient-filled`);
        if (useI2V && videoFallbackCount > 0) phaseNoteParts.push(`${videoFallbackCount} I2V scene${videoFallbackCount === 1 ? '' : 's'} fall back to still image`);
        renderCtx.phase = 'compose';
        renderCtx.phaseNote = phaseNoteParts.length ? phaseNoteParts.join('; ') : '';
        repaint();

        const composePayload = {
            script,
            scene_assets: helpers.stripSceneAssetForComposer(sceneAssets),
            voice: $('swc-voice').value || 'en-US-AriaNeural',
            style: $('swc-style').value || 'violet-pink',
            write_srt: !!$('swc-write-srt').checked,
        };
        if (useI2V && videoSceneAssets.length > 0) {
            composePayload.video_scene_assets = videoHelpers
                .stripVideoSceneAssetForComposer(videoSceneAssets);
        }
        const outDir = asNonEmpty($('swc-output-dir').value);
        if (outDir) composePayload.output_dir = outDir;

        let compose;
        try {
            compose = await api.producer.composeShort(composePayload);
        } catch (err) {
            cleanup();
            renderCtx.errorMessage = `producer:composeShort IPC threw: ${err && err.message ? err.message : String(err)}`;
            repaint();
            return;
        }

        cleanup();
        renderCtx.phase = 'done';
        renderCtx.compose = compose;
        repaint();
    }

    /**
     * Async post-processor: for every settled row that has an
     * image_path or video_path but no resolved file:// URL, ask the
     * main process for a URL via `file:getFileUrl` and patch the row
     * in place. Calls `repaint()` after each batch update so the
     * thumbnails appear without blocking the orchestration loop.
     */
    async function resolveThumbnailUrls(rows, repaint) {
        if (!api || typeof api.getFileUrl !== 'function') return;
        const tasks = [];
        rows.forEach((row, idx) => {
            if (row.image && row.image.image_path && !row.image.url) {
                tasks.push(api.getFileUrl(row.image.image_path).then((res) => {
                    if (res && res.success && res.url) row.image.url = res.url;
                }).catch(() => {}));
            }
            if (row.i2v && row.i2v.video_path && !row.i2v.url) {
                tasks.push(api.getFileUrl(row.i2v.video_path).then((res) => {
                    if (res && res.success && res.url) row.i2v.url = res.url;
                }).catch(() => {}));
            }
        });
        if (!tasks.length) return;
        await Promise.all(tasks);
        if (typeof repaint === 'function') repaint();
    }

    /**
     * PR-20C: render the per-scene "Compose with AutoGrok" table.
     * This replaces the old three-card layout with a single table
     * that updates live during the run.
     */
    function renderSwcTable(rows, ctx) {
        const tableHelpers = window.StoryboardComposeTableHelpers;
        const summary = tableHelpers.summarizeRows(rows);
        const compose = ctx.compose || {};
        let html = '';

        // Phase / status banner.
        if (ctx.errorMessage) {
            html += `<div class="error" role="alert"><b>Error</b><pre>${escapeHtml(ctx.errorMessage)}</pre></div>`;
        } else if (ctx.phase === 'image') {
            html += `<div class="loading">Phase 1 — generating Grok images (${summary.image_generated + summary.image_retried}/${ctx.promptCount} settled, max attempts ${ctx.maxAttempts}). Requires an active Grok session.</div>`;
        } else if (ctx.phase === 'i2v') {
            const planned = summary.i2v_generated + summary.i2v_retried + summary.i2v_fallback;
            const total = summary.total - summary.i2v_skipped;
            html += `<div class="loading">Phase 2 — generating I2V motion clips (${planned}/${total} settled, max attempts ${ctx.maxAttemptsI2V}).</div>`;
        } else if (ctx.phase === 'compose') {
            const note = ctx.phaseNote ? ` (${ctx.phaseNote})` : '';
            html += `<div class="loading">Phase 3 — composing 9:16 mp4${note}...</div>`;
        }

        // Stats row(s).
        html += `<div class="stats-row">
            <span>Scenes total<b>${escapeHtml(ctx.sceneCount)}</b></span>
            <span>Prompts sent<b>${escapeHtml(ctx.promptCount)}</b></span>
            <span>scenes_used<b>${escapeHtml(compose.scenes_used != null ? compose.scenes_used : (ctx.sceneAssets ? ctx.sceneAssets.length : summary.image_generated + summary.image_retried))}</b></span>
            <span>scenes_missing<b>${escapeHtml(compose.scenes_missing != null ? compose.scenes_missing : summary.image_fallback)}</b></span>
            <span>retry_count<b>${escapeHtml(ctx.retryCount || 0)}</b></span>
            <span>max_attempts<b>${escapeHtml(ctx.maxAttempts || 1)}</b></span>
            <span>allow_partial<b>${escapeHtml(ctx.allowPartial ? 'yes' : 'no')}</b></span>
            <span>Duration<b>${escapeHtml((compose.duration_s || 0).toFixed ? compose.duration_s.toFixed(2) : (compose.duration_s || 0))}s</b></span>
            <span>Captions<b>${escapeHtml(compose.captions_count || 0)}</b></span>
        </div>`;
        if (ctx.useI2V) {
            html += `<div class="stats-row">
                <span>I2V<b>on</b></span>
                <span>videos_used<b>${escapeHtml(compose.videos_used != null ? compose.videos_used : (ctx.videoSceneAssets ? ctx.videoSceneAssets.length : summary.i2v_generated + summary.i2v_retried))}</b></span>
                <span>videos_missing<b>${escapeHtml(compose.videos_missing != null ? compose.videos_missing : 0)}</b></span>
                <span>i2v retry_count<b>${escapeHtml(ctx.videoRetryCount || 0)}</b></span>
                <span>i2v max_attempts<b>${escapeHtml(ctx.videoMaxAttempts || 1)}</b></span>
                <span>i2v fallback (→image)<b>${escapeHtml(ctx.videoFallbackCount || 0)}</b></span>
            </div>`;
        }

        // Final mp4 card.
        const paths = [
            ['mp4', compose.mp4_path],
            ['voice.mp3', compose.audio_path],
            ['captions.srt', compose.srt_path],
        ].filter(([, p]) => !!p);
        if (paths.length) {
            html += `<div class="scene-card"><div class="scene-title">Output files</div>`;
            paths.forEach(([label, p]) => {
                const actions = renderPathActions(p);
                html += `<div class="scene-block"><span class="scene-label">${escapeHtml(label)}</span><code>${escapeHtml(p)}</code>${actions}</div>`;
            });
            html += `<div class="scene-meta">Output dir: <code>${escapeHtml(compose.output_dir || '')}</code> ${renderPathActions(compose.output_dir, true)}</div></div>`;
        }

        // Per-scene table.
        html += `<table class="swc-table"><thead><tr>
            <th>#</th>
            <th>Scene</th>
            <th>Image prompt</th>
            <th>Image</th>
            <th>Video prompt</th>
            <th>Video</th>
            <th>Actions</th>
        </tr></thead><tbody>`;
        if (rows.length === 0) {
            html += `<tr><td colspan="7" class="empty">No scenes captured. Run "Break into scenes" first.</td></tr>`;
        }
        for (const r of rows) {
            html += renderSwcTableRow(r, ctx);
        }
        html += `</tbody></table>`;

        html += renderWarnings(compose.warnings);
        if (ctx.compose) html += renderRawJson(compose);
        $('swc-result').innerHTML = html;
    }

    function renderSwcTableRow(row, ctx) {
        const tableHelpers = window.StoryboardComposeTableHelpers;
        const order = row.order;
        const sceneId = row.scene_id != null ? row.scene_id : '?';
        const title = row.title || '';
        const dur = (typeof row.duration_s === 'number') ? row.duration_s.toFixed(1) : row.duration_s;

        // Image cell: pill + (thumb when generated/retried) + reason.
        const imgLabel = tableHelpers.imageStatusLabel(row.image.status);
        const imgClass = tableHelpers.statusClass(row.image.status);
        let imgCell = `<span class="pill ${escapeHtml(imgClass)}">${escapeHtml(imgLabel)} (${escapeHtml(row.image.attempts || 0)}x)</span>`;
        if (row.image.url) {
            imgCell = `<div class="thumb-cell"><img src="${escapeHtml(row.image.url)}" alt="scene ${escapeHtml(sceneId)}" />${imgCell}</div>`;
        } else if (row.image.image_path && (row.image.status === 'generated' || row.image.status === 'retried')) {
            imgCell = `<div class="thumb-cell"><div class="thumb-placeholder">loading…</div>${imgCell}</div>`;
        } else if (row.image.status === 'generating' || row.image.status === 'retrying') {
            imgCell = `${imgCell}<div class="progress-bar"><div style="width:${escapeHtml(row.image.progress || 0)}%"></div></div>`;
        }
        if (row.image.reason && (row.image.status === 'fallback' || row.image.status === 'skipped')) {
            imgCell += `<div class="reason">${escapeHtml(row.image.reason)}</div>`;
        }

        // Video cell: only meaningful when useI2V or row already has state.
        const v2Label = tableHelpers.i2vStatusLabel(row.i2v.status);
        const v2Class = tableHelpers.statusClass(row.i2v.status);
        let videoCell = `<span class="pill ${escapeHtml(v2Class)}">${escapeHtml(v2Label)} (${escapeHtml(row.i2v.attempts || 0)}x)</span>`;
        if (row.i2v.url) {
            videoCell = `<div class="thumb-cell"><video src="${escapeHtml(row.i2v.url)}" muted playsinline preload="metadata"></video>${videoCell}</div>`;
        } else if (row.i2v.video_path && (row.i2v.status === 'generated' || row.i2v.status === 'retried')) {
            videoCell = `<div class="thumb-cell"><div class="thumb-placeholder">loading…</div>${videoCell}</div>`;
        } else if (row.i2v.status === 'generating' || row.i2v.status === 'retrying') {
            videoCell = `${videoCell}<div class="progress-bar"><div style="width:${escapeHtml(row.i2v.progress || 0)}%"></div></div>`;
        }
        if (row.i2v.reason && (row.i2v.status === 'fallback' || row.i2v.status === 'skipped')) {
            videoCell += `<div class="reason">${escapeHtml(row.i2v.reason)}</div>`;
        }

        // Action buttons (PR-20C bonus): open file / show in folder.
        const actions = [];
        if (row.image.image_path) actions.push(renderPathActions(row.image.image_path));
        if (row.i2v.video_path) actions.push(renderPathActions(row.i2v.video_path));
        const actionsHtml = actions.length ? actions.join('') : '<span class="muted">—</span>';

        return `<tr>
            <td class="scene-num">${escapeHtml(order)}</td>
            <td><b>scene ${escapeHtml(sceneId)}</b><div class="reason">${escapeHtml(title)} · ${escapeHtml(dur)}s</div></td>
            <td class="prompt-cell">${escapeHtml(row.image_prompt || '')}</td>
            <td>${imgCell}</td>
            <td class="prompt-cell">${escapeHtml(row.video_prompt || '')}</td>
            <td>${videoCell}</td>
            <td class="actions">${actionsHtml}</td>
        </tr>`;
    }

    /**
     * Render the small per-row action chips: "open" (uses
     * shell.openPath via electronAPI.openPath) and "show" (uses
     * shell.showItemInFolder). Falls back to a copy-path link if
     * the IPC isn't available — the path stays useful even without
     * shell access.
     */
    function renderPathActions(path, dirOnly) {
        if (!path) return '';
        const safe = String(path).replace(/"/g, '&quot;');
        if (api && typeof api.openPath === 'function') {
            const html = [];
            if (!dirOnly) html.push(`<a href="#" data-swc-open="${safe}">open</a>`);
            html.push(`<a href="#" data-swc-show="${safe}">show in folder</a>`);
            return `<span class="actions">${html.join(' ')}</span>`;
        }
        return '';
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
     * Best-effort check for "is there at least one Grok account
     * configured?". `auth:getAccounts` reads `accounts.json` so a
     * non-empty list means the user has set up accounts; it does
     * NOT prove a live session, but `image:generate` /
     * `i2v:generate` / `video:generate` will surface "no active
     * sessions" inline if cookies expired. We use this banner to
     * nudge users who haven't run manual-login at all yet.
     */
    async function sbbCheckSession() {
        const banner = $('sbb-login-banner');
        if (!banner) return;
        if (!api || !api.auth || typeof api.auth.getAccounts !== 'function') {
            banner.hidden = true;
            return;
        }
        try {
            const res = await api.auth.getAccounts();
            const accounts = Array.isArray(res) ? res : (res && Array.isArray(res.accounts) ? res.accounts : []);
            const hasAny = accounts.length > 0;
            banner.hidden = hasAny;
            sbbState.sessionKnown = hasAny;
        } catch (_) {
            banner.hidden = false;
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
        const settled = helpers.mapBatchResponse(resp, plan.sceneIds, 'video');
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

    async function populateStoryboardComposeVoicePicker() {
        if (!api) return;
        const sel = $('swc-voice');
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
        } catch (_) { /* sidecar still booting — retry on the next poll */ }
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
        'storyboard-compose': runStoryboardCompose,
        'storyboard-batch-fill': async () => sbbAutoFill(),
        'storyboard-batch-clear': async () => sbbClear(),
        'storyboard-batch-image': sbbGenerateImages,
        'storyboard-batch-video': sbbGenerateVideos,
        'storyboard-batch-login': sbbOpenLogin,
    };

    function setupRunButtons() {
        $$('button[data-run]').forEach((btn) => {
            const key = btn.getAttribute('data-run');
            const fn = handlers[key];
            if (!fn) return;
            btn.addEventListener('click', () => {
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
        populateStoryboardComposeVoicePicker();
        // PR-20D — paint the empty-state for the batch panel and
        // poll the Grok session banner so the user sees right away
        // whether they need to log in.
        sbbRepaintAll();
        sbbCheckSession().catch(() => {});
        setInterval(() => sbbCheckSession().catch(() => {}), 30_000);
        const voicePollHandle = setInterval(() => {
            const ps = $('ps-voice');
            const swc = $('swc-voice');
            const psReady = !ps || ps.options.length > 1;
            const swcReady = !swc || swc.options.length > 1;
            if (psReady && swcReady) { clearInterval(voicePollHandle); return; }
            if (!psReady) populateVoicePicker();
            if (!swcReady) populateStoryboardComposeVoicePicker();
        }, 5000);
        // Re-poll every 5s so the dot recovers when the sidecar comes online late.
        setInterval(refreshSidecarStatus, 5000);
    });
})();
