#!/usr/bin/env node
/**
 * fetch-python-runtime.js — download + extract python-build-standalone
 * (astral-sh) into desktop/build/python-runtime/<platform-arch>/python/
 * and pip-install research/requirements.txt against it. Used by the
 * Windows-bundled installer (PR-19) and as the dev-mode bundled-python
 * source the renderer falls back to.
 *
 * Usage:
 *   node scripts/fetch-python-runtime.js                 # auto-detect host
 *   node scripts/fetch-python-runtime.js --platform win32 --arch x64
 *   node scripts/fetch-python-runtime.js --skip-deps     # download + extract only
 *   node scripts/fetch-python-runtime.js --force         # re-extract over existing
 *
 * In PR-19 only `win32-x64` and `linux-x64` are pinned. `linux-x64` is
 * a smoke target so the Devin VM can exercise the script end-to-end
 * without needing wine. `darwin-*` exits non-zero with a "follow-up
 * PR" message — by design.
 *
 * Pure-Node, no third-party deps. Network code uses node:https with
 * manual redirect handling (GitHub release URLs 302 to S3). Extraction
 * shells out to `tar` (built into Windows 10+ since 17063, macOS, and
 * standard on every Linux distro).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');
const url = require('url');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'desktop', 'build', 'python-runtime');
const CACHE_DIR = path.join(RUNTIME_ROOT, '.cache');
const CONFIG_PATH = path.join(__dirname, 'python-runtime.config.json');

// ────────────────────────────────────────────────────────────────────
// Pure helpers (re-exported for offline tests).
// ────────────────────────────────────────────────────────────────────

function loadConfig(configPath = CONFIG_PATH, fsImpl = fs) {
    const raw = fsImpl.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.release_tag || !parsed.python_version || !parsed.platforms) {
        throw new Error(`malformed python-runtime config: ${configPath}`);
    }
    return parsed;
}

/**
 * Map a Node `process.platform` + `process.arch` pair to the bundle key
 * used in `python-runtime.config.json`. Supported values:
 *   - "win32-x64", "linux-x64" — pinned since PR-19.
 *   - "darwin-x64", "darwin-arm64" — pinned in PR-62 (installer parity).
 *
 * Other platform/arch combinations throw — bump the config + this
 * mapping in lockstep when adding support.
 */
function platformKey(platform, arch) {
    if (platform === 'win32') {
        if (arch !== 'x64') {
            throw new Error(`unsupported arch for win32: ${arch} (only x64 is pinned)`);
        }
        return 'win32-x64';
    }
    if (platform === 'linux') {
        if (arch !== 'x64') {
            throw new Error(`unsupported arch for linux: ${arch} (only x64 is pinned)`);
        }
        return 'linux-x64';
    }
    if (platform === 'darwin') {
        if (arch === 'x64') return 'darwin-x64';
        if (arch === 'arm64') return 'darwin-arm64';
        throw new Error(`unsupported arch for darwin: ${arch} (only x64 and arm64 are pinned)`);
    }
    throw new Error(`unsupported platform: ${platform}`);
}

/**
 * Build the GitHub release download URL for a pinned (release_tag,
 * python_version, triple, asset_suffix). Pure string concatenation —
 * makes the URL surface easy to assert against in tests.
 */
function buildAssetUrl({ releaseTag, pythonVersion, triple, assetSuffix }) {
    return (
        'https://github.com/astral-sh/python-build-standalone/releases/download/' +
        `${releaseTag}/cpython-${pythonVersion}+${releaseTag}-${triple}-${assetSuffix}`
    );
}

function buildAssetFilename({ pythonVersion, releaseTag, triple, assetSuffix }) {
    return `cpython-${pythonVersion}+${releaseTag}-${triple}-${assetSuffix}`;
}

function parseArgs(argv) {
    const opts = {
        platform: null,
        arch: null,
        skipDeps: false,
        force: false,
        noVerify: false,
        offlineCacheOnly: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--platform') {
            opts.platform = argv[++i];
        } else if (a === '--arch') {
            opts.arch = argv[++i];
        } else if (a === '--skip-deps') {
            opts.skipDeps = true;
        } else if (a === '--force') {
            opts.force = true;
        } else if (a === '--no-verify') {
            opts.noVerify = true;
        } else if (a === '--offline-cache-only') {
            opts.offlineCacheOnly = true;
        } else if (a === '-h' || a === '--help') {
            opts.help = true;
        } else {
            throw new Error(`unknown argument: ${a}`);
        }
    }
    return opts;
}

function sha256OfBuffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256OfFile(filePath, fsImpl = fs) {
    const buf = fsImpl.readFileSync(filePath);
    return sha256OfBuffer(buf);
}

// ────────────────────────────────────────────────────────────────────
// IO + side effects (skipped in offline tests).
// ────────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function downloadFollowingRedirects(targetUrl, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const fetchOnce = (currentUrl, redirectsLeft) => {
            const parsed = url.parse(currentUrl);
            const req = https.get(
                {
                    hostname: parsed.hostname,
                    port: parsed.port || 443,
                    path: parsed.path,
                    headers: { 'user-agent': 'creator-forge-fetch-python-runtime' },
                },
                (res) => {
                    if (
                        [301, 302, 303, 307, 308].includes(res.statusCode) &&
                        res.headers.location &&
                        redirectsLeft > 0
                    ) {
                        res.resume();
                        const next = res.headers.location.startsWith('http')
                            ? res.headers.location
                            : url.resolve(currentUrl, res.headers.location);
                        return fetchOnce(next, redirectsLeft - 1);
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`download failed: HTTP ${res.statusCode} (${currentUrl})`));
                    }
                    const out = fs.createWriteStream(destPath);
                    res.pipe(out);
                    out.on('finish', () => out.close(resolve));
                    out.on('error', reject);
                },
            );
            req.on('error', reject);
        };
        fetchOnce(targetUrl, maxRedirects);
    });
}

function runOrThrow(cmd, args, opts = {}) {
    const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (result.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} → exit ${result.status}`);
    }
}

function extractTarball(tarballPath, destDir) {
    ensureDir(destDir);
    // python-build-standalone install_only tarballs are gz-compressed
    // and contain a top-level `python/` directory, so extracting at
    // destDir gives us destDir/python/...
    runOrThrow('tar', ['-xzf', tarballPath, '-C', destDir]);
}

// ────────────────────────────────────────────────────────────────────
// Main flow.
// ────────────────────────────────────────────────────────────────────

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error('[fetch-python-runtime]', err.message);
        process.exit(2);
    }
    if (opts.help) {
        console.log(
            'Usage: node scripts/fetch-python-runtime.js [--platform <p>] [--arch <a>] [--skip-deps] [--force] [--no-verify] [--offline-cache-only]',
        );
        process.exit(0);
    }
    const platform = opts.platform || process.platform;
    const arch = opts.arch || process.arch;
    let key;
    try {
        key = platformKey(platform, arch);
    } catch (err) {
        console.error('[fetch-python-runtime]', err.message);
        process.exit(3);
    }

    const config = loadConfig();
    const platformCfg = config.platforms[key];
    if (!platformCfg) {
        console.error(`[fetch-python-runtime] no pinned config for ${key} in ${CONFIG_PATH}`);
        process.exit(3);
    }
    const assetFilename = buildAssetFilename({
        pythonVersion: config.python_version,
        releaseTag: config.release_tag,
        triple: platformCfg.triple,
        assetSuffix: platformCfg.asset_suffix,
    });
    const assetUrl = buildAssetUrl({
        releaseTag: config.release_tag,
        pythonVersion: config.python_version,
        triple: platformCfg.triple,
        assetSuffix: platformCfg.asset_suffix,
    });

    ensureDir(CACHE_DIR);
    const tarballPath = path.join(CACHE_DIR, assetFilename);
    const platformDir = path.join(RUNTIME_ROOT, key);
    const interpreter = path.join(platformDir, platformCfg.interpreter_relpath);

    // 1. download + verify
    const haveCached =
        fs.existsSync(tarballPath) &&
        (opts.noVerify ||
            sha256OfFile(tarballPath).toLowerCase() === platformCfg.sha256.toLowerCase());
    if (!haveCached) {
        if (opts.offlineCacheOnly) {
            console.error(
                `[fetch-python-runtime] cache miss for ${assetFilename} and --offline-cache-only set; aborting.`,
            );
            process.exit(4);
        }
        console.log(`[fetch-python-runtime] downloading ${assetUrl}`);
        await downloadFollowingRedirects(assetUrl, tarballPath);
        if (!opts.noVerify) {
            const got = sha256OfFile(tarballPath);
            if (got.toLowerCase() !== platformCfg.sha256.toLowerCase()) {
                console.error(
                    `[fetch-python-runtime] sha256 mismatch: expected ${platformCfg.sha256}, got ${got}`,
                );
                fs.unlinkSync(tarballPath);
                process.exit(5);
            }
            console.log(`[fetch-python-runtime] sha256 OK (${got})`);
        }
    } else {
        console.log(`[fetch-python-runtime] using cached ${tarballPath}`);
    }

    // 2. extract
    if (opts.force && fs.existsSync(platformDir)) {
        fs.rmSync(platformDir, { recursive: true, force: true });
    }
    if (!fs.existsSync(interpreter)) {
        console.log(`[fetch-python-runtime] extracting → ${platformDir}`);
        extractTarball(tarballPath, platformDir);
    } else {
        console.log(`[fetch-python-runtime] interpreter already present: ${interpreter}`);
    }
    if (!fs.existsSync(interpreter)) {
        console.error(`[fetch-python-runtime] interpreter missing after extract: ${interpreter}`);
        process.exit(6);
    }

    // 3. pip install research/requirements.txt (skippable)
    if (opts.skipDeps) {
        console.log('[fetch-python-runtime] --skip-deps: not running pip install');
    } else {
        const reqPath = path.join(REPO_ROOT, 'research', 'requirements.txt');
        if (!fs.existsSync(reqPath)) {
            console.error(`[fetch-python-runtime] requirements file missing: ${reqPath}`);
            process.exit(7);
        }
        console.log(`[fetch-python-runtime] pip install -r ${reqPath} (this can take a minute)`);
        runOrThrow(interpreter, [
            '-m',
            'pip',
            'install',
            '--no-warn-script-location',
            '--disable-pip-version-check',
            '-r',
            reqPath,
        ]);
    }

    console.log(`[fetch-python-runtime] OK — interpreter: ${interpreter}`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[fetch-python-runtime] fatal:', err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = {
    // Pure helpers (used by tests):
    loadConfig,
    platformKey,
    buildAssetUrl,
    buildAssetFilename,
    parseArgs,
    sha256OfBuffer,
    sha256OfFile,
    // Constants useful for tests:
    REPO_ROOT,
    RUNTIME_ROOT,
    CACHE_DIR,
    CONFIG_PATH,
};
