import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRoot(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function existsInRoot(relPath) {
  const normalized = relPath.replace(/^\.\//, '');
  return fs.existsSync(path.join(ROOT, normalized));
}

function extractPrecache(swSource) {
  const match = swSource.match(/const PRECACHE\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'sw.js must define a PRECACHE array');
  const body = match[1];
  const entries = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.length > 0, 'PRECACHE must list at least one entry');
  return entries;
}

function listJsFilesRecursive(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJsFilesRecursive(full));
    } else if (entry.name.endsWith('.js')) {
      result.push(full);
    }
  }
  return result;
}

// API-host patterns that must never appear in the precache list
// (`caja-pwa-shell` "API Requests Are Always Network-Only").
const API_HOST_PATTERNS = [/script\.google\.com/, /script\.googleusercontent\.com/, /^https?:\/\//];

test('PRECACHE: every listed entry exists on disk', () => {
  const sw = readRoot('sw.js');
  const entries = extractPrecache(sw);
  for (const entry of entries) {
    const target = entry === './' ? './index.html' : entry;
    assert.ok(existsInRoot(target), `PRECACHE entry "${entry}" must exist on disk`);
  }
});

test('PRECACHE: every js/**/*.js module (including js/views/**) is listed (no forgotten module)', () => {
  const sw = readRoot('sw.js');
  const entries = new Set(extractPrecache(sw));
  const jsDir = path.join(ROOT, 'js');
  const jsFiles = listJsFilesRecursive(jsDir).map((abs) => `./${path.relative(ROOT, abs).split(path.sep).join('/')}`);

  assert.ok(jsFiles.length > 0, 'expected at least one js module under js/');
  for (const jsFile of jsFiles) {
    assert.ok(entries.has(jsFile), `PRECACHE is missing js module "${jsFile}"`);
  }
});

test('PRECACHE: no API-host or absolute cross-origin URL is present (API is always network-only)', () => {
  const sw = readRoot('sw.js');
  const entries = extractPrecache(sw);
  for (const entry of entries) {
    for (const pattern of API_HOST_PATTERNS) {
      assert.ok(!pattern.test(entry), `PRECACHE entry "${entry}" must not reference an API host or absolute URL`);
    }
  }
});

test('sw.js: CACHE_VERSION is defined and non-empty', () => {
  const sw = readRoot('sw.js');
  const match = sw.match(/const CACHE_VERSION\s*=\s*'([^']+)'/);
  assert.ok(match, 'sw.js must define CACHE_VERSION as a string literal');
  assert.ok(match[1].length > 0, 'CACHE_VERSION must not be empty');
});

test('sw.js: CACHE_PREFIX is defined, non-empty, and used consistently (CACHE_VERSION starts with it)', () => {
  const sw = readRoot('sw.js');
  const prefixMatch = sw.match(/const CACHE_PREFIX\s*=\s*'([^']+)'/);
  const versionMatch = sw.match(/const CACHE_VERSION\s*=\s*'([^']+)'/);
  assert.ok(prefixMatch, 'sw.js must define CACHE_PREFIX');
  assert.ok(prefixMatch[1].length > 0, 'CACHE_PREFIX must not be empty');
  assert.equal(prefixMatch[1], 'foodc-caja-shell-', 'CACHE_PREFIX must be "foodc-caja-shell-"');
  assert.ok(versionMatch, 'sw.js must define CACHE_VERSION');
  assert.ok(versionMatch[1].startsWith(prefixMatch[1]), 'CACHE_VERSION must start with CACHE_PREFIX');

  const activateStart = sw.indexOf("addEventListener('activate'");
  assert.ok(activateStart !== -1, 'sw.js must define an activate handler');
  const fetchStart = sw.indexOf("addEventListener('fetch'");
  const activateBody = sw.slice(activateStart, fetchStart !== -1 ? fetchStart : undefined);
  assert.ok(activateBody.includes('CACHE_PREFIX'), 'activate handler must filter caches using CACHE_PREFIX');
});

test('no absolute paths (href="/", src="/") in index.html, manifest.webmanifest, or sw.js', () => {
  const absolutePathPattern = /(href|src)\s*=\s*"\/(?!\/)/;
  const manifestAbsolutePattern = /"(start_url|scope|src|id)"\s*:\s*"\/(?!\/)/;

  const indexHtml = readRoot('index.html');
  assert.doesNotMatch(indexHtml, absolutePathPattern, 'index.html must not reference an absolute path');

  const manifest = readRoot('manifest.webmanifest');
  assert.doesNotMatch(
    manifest,
    manifestAbsolutePattern,
    'manifest.webmanifest must not use an absolute start_url/scope/id/icon src',
  );

  const sw = readRoot('sw.js');
  assert.doesNotMatch(sw, absolutePathPattern, 'sw.js must not reference an absolute path');
});

test('css/app.css exists and is non-empty', () => {
  const stat = fs.statSync(path.join(ROOT, 'css', 'app.css'));
  assert.ok(stat.size > 0, 'css/app.css must be non-empty');
});

test('manifest.webmanifest declares the required installability fields', () => {
  const manifest = JSON.parse(readRoot('manifest.webmanifest'));

  assert.ok(manifest.name && manifest.name.length > 0, 'manifest.name must be non-empty');
  assert.equal(manifest.name, 'FoodC Caja');
  assert.ok(manifest.short_name && manifest.short_name.length > 0, 'manifest.short_name must be non-empty');
  assert.ok(manifest.start_url && manifest.start_url.length > 0, 'manifest.start_url must be non-empty');
  assert.ok(manifest.scope && manifest.scope.length > 0, 'manifest.scope must be non-empty');
  assert.equal(manifest.display, 'standalone', 'caja-pwa-shell requires display: "standalone"');
  assert.ok(manifest.theme_color, 'manifest.theme_color must be set');
  assert.ok(manifest.background_color, 'manifest.background_color must be set');

  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192'), 'manifest must declare a 192x192 icon');
  assert.ok(sizes.includes('512x512'), 'manifest must declare a 512x512 icon');

  const hasMaskable = manifest.icons.some((icon) => icon.purpose === 'maskable');
  assert.ok(hasMaskable, 'manifest must declare at least one icon with purpose "maskable"');
});

test('manifest start_url/scope/id resolve relative to the Pages sub-path', () => {
  const manifest = JSON.parse(readRoot('manifest.webmanifest'));
  assert.equal(manifest.id, './');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.lang, 'es');
});

test('manifest icons referenced are all present on disk and listed in sw.js PRECACHE', () => {
  const manifest = JSON.parse(readRoot('manifest.webmanifest'));
  const sw = readRoot('sw.js');
  const precache = new Set(extractPrecache(sw));

  for (const icon of manifest.icons) {
    assert.ok(existsInRoot(icon.src), `manifest icon "${icon.src}" must exist on disk`);
    assert.ok(precache.has(icon.src), `sw.js PRECACHE must include manifest icon "${icon.src}"`);
  }
});

test("sw.js fetch handler returns without respondWith for non-GET or cross-origin requests (API is network-only)", () => {
  const sw = readRoot('sw.js');
  const fetchHandlerMatch = sw.match(/addEventListener\('fetch'[\s\S]*$/);
  assert.ok(fetchHandlerMatch, 'sw.js must define a fetch handler');
  const body = fetchHandlerMatch[0];
  assert.match(body, /method\s*!==\s*'GET'/, 'fetch handler must check for non-GET requests');
  assert.match(body, /origin\s*!==\s*self\.location\.origin/, 'fetch handler must check for cross-origin requests');
});

test('package.json declares zero runtime dependencies', () => {
  const pkg = JSON.parse(readRoot('package.json'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'package.json must have no runtime dependencies');
});
