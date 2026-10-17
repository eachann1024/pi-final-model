// Adapted from eachann1024/pi-mini-mode's daily-stable and npm release scripts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const stage = join(root, '.release');
const registry = 'https://registry.npmjs.org';
const repository = 'eachann1024/pi-final-model';
const inputs = ['src', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'tsconfig.json', 'scripts', '.github/workflows/daily-stable.yml'];
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
const git = (...args) => run('git', args).trim();
const gh = (...args) => run('gh', args);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error(`Invalid stable version: ${version}`);
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw Error('Version exceeds safe integer range');
  return parts;
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function nextVersion(metadata) {
  versionParts(manifest.version);
  const versions = Object.keys(metadata?.versions ?? {}).filter(v => /^\d+\.\d+\.\d+$/.test(v));
  if (!versions.length) return manifest.version;
  const highest = versions.sort(compareVersions).at(-1);
  const baseline = compareVersions(manifest.version, highest) > 0 ? manifest.version : highest;
  const [major, minor, localCounter] = versionParts(baseline);
  const counter = Math.max(...versions.map(versionParts).filter(v => v[0] === major).map(v => v[2]), -1);
  const next = compareVersions(manifest.version, highest) > 0 && localCounter > counter ? baseline : `${major}.${minor}.${Math.max(counter, localCounter) + 1}`;
  versionParts(next);
  return next;
}
async function fetchRegistry(path) {
  const response = await fetch(`${registry}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'cache-control': 'no-cache' } });
  if (response.status === 404) return null;
  if (!response.ok) throw Error(`npm registry HTTP ${response.status}`);
  return response;
}
async function metadata() {
  const response = await fetchRegistry(`${encodeURIComponent(manifest.name)}?release=${Date.now()}`);
  if (!response) return null;
  const value = await response.json();
  if (!value?.versions || !value['dist-tags']?.latest || !value.versions[value['dist-tags'].latest]) throw Error('Invalid npm package metadata');
  if (value['dist-tags'].latest !== '0.0.0-stage') versionParts(value['dist-tags'].latest);
  return value;
}
function api(path) {
  try { return JSON.parse(gh('api', `repos/${repository}/${path}`)); }
  catch (error) { if (String(error.stderr).includes('(HTTP 404)')) return null; throw error; }
}
function releaseForTag(tag) {
  const pages = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`));
  return pages.flat().find(release => release.tag_name === tag);
}
function fingerprint() {
  return sha256(run('git', ['ls-tree', '-r', '-z', 'HEAD', '--', ...inputs], { encoding: 'buffer' }));
}
function output(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function assertSource() {
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository) throw Error('Unexpected repository');
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/heads/main') throw Error('Release requires main');
  const head = git('rev-parse', 'HEAD');
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw Error('Checkout differs from workflow source');
  if (git('status', '--porcelain')) throw Error('Commit all changes before preparing a release');
  return head;
}
function assertRecord(record, plan) {
  if (!record || record.name !== plan.name || record.version !== plan.version || record.piRelease?.source !== plan.source || record.piRelease?.fingerprint !== plan.fingerprint || record.dist?.integrity !== plan.integrity) throw Error('Published package differs from the selected artifact; do not republish');
}
function verifyTag(plan, required = false) {
  let object = api(`git/ref/tags/${plan.tag}`)?.object;
  if (required && !object) throw Error('Published release tag is missing');
  for (let i = 0; object?.type === 'tag' && i < 5; i++) object = api(`git/tags/${object.sha}`)?.object;
  if (object && (object.type !== 'commit' || object.sha !== plan.source)) throw Error('Existing release tag points to different source');
}
function releaseAssets(plan, bytes) {
  const receipt = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const sums = Buffer.from(`${sha256(bytes)}  ${plan.filename}\n${sha256(receipt)}  release-manifest.json\n`);
  return new Map([[plan.filename, bytes], ['release-manifest.json', receipt], ['SHA256SUMS.txt', sums]]);
}
function verifyAssets(release, files) {
  if (!release || release.prerelease || release.assets.length !== files.size) throw Error('Release asset set differs from the allowlist');
  for (const asset of release.assets) {
    const bytes = files.get(asset.name);
    if (!bytes || asset.digest !== `sha256:${sha256(bytes)}` || asset.size !== bytes.length) throw Error(`Release checksum mismatch: ${asset.name}`);
  }
}
async function prepare() {
  const head = assertSource(), digest = fingerprint();
  const before = await metadata();
  if (!before && await fetchRegistry(`${encodeURIComponent(manifest.name)}/latest`)) throw Error('npm package index is still propagating; retry preparation later without publishing');
  const latest = before?.versions[before['dist-tags'].latest];
  if (latest?.version === '0.0.0-stage') throw Error('npm has a holding version; wait for processing or complete staged approval before another release');
  const repair = latest?.piRelease?.fingerprint === digest;
  const version = repair ? latest.version : nextVersion(before);
  const source = repair ? latest.piRelease.source : head;
  if (!/^[0-9a-f]{40}$/.test(source)) throw Error('Invalid source commit');
  git('merge-base', '--is-ancestor', source, head);
  const plan = { schema: 1, name: manifest.name, version, tag: `v${version}`, source, fingerprint: digest, filename: `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz` };
  verifyTag(plan);
  const existing = releaseForTag(plan.tag);
  if (!repair && existing && !existing.draft) throw Error('An immutable release already uses this version');
  mkdirSync(stage, { recursive: true });
  let bytes;
  if (repair) {
    const url = new URL(latest.dist.tarball);
    if (url.origin !== registry) throw Error('Unexpected tarball registry');
    const response = await fetchRegistry(url.pathname.slice(1));
    if (!response) throw Error('Published tarball is missing');
    bytes = Buffer.from(await response.arrayBuffer());
    if (integrity(bytes) !== latest.dist.integrity) throw Error('Published tarball integrity mismatch');
  } else {
    const temp = mkdtempSync(join(tmpdir(), 'pi-final-model-release-'));
    try {
      const archive = run('git', ['archive', '--format=tar', 'HEAD', 'package.json', 'src', 'README.md', 'LICENSE'], { encoding: 'buffer' });
      run('tar', ['-xf', '-', '-C', temp], { input: archive });
      const packedManifest = { ...manifest, version, piRelease: { source, fingerprint: digest } };
      writeFileSync(join(temp, 'package.json'), `${JSON.stringify(packedManifest, null, 2)}\n`);
      const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], { cwd: temp }))[0];
      if (packed.filename !== plan.filename) throw Error('Unexpected npm archive filename');
      const paths = new Set(packed.files.map(file => file.path));
      for (const required of ['package.json', 'README.md', 'LICENSE', 'src/index.ts', 'src/config.ts', 'src/log.ts', 'src/settings.ts', 'src/settings-web.ts', 'src/settings.html', 'src/settings.js', 'src/icon.svg', 'src/assets/cloud-grain.png', 'src/assets/icons/LICENSE', ...['arrow-right', 'check', 'chevron-down', 'search'].map(name => `src/assets/icons/${name}.svg`)]) {
        if (!paths.has(required)) throw Error(`Missing package resource: ${required}`);
      }
      if ([...paths].some(path => !['package.json', 'README.md', 'LICENSE'].includes(path) && !path.startsWith('src/'))) throw Error('Unexpected file in published package');
      bytes = readFileSync(join(stage, packed.filename));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  plan.integrity = integrity(bytes);
  if (repair) assertRecord(latest, plan);
  const files = releaseAssets(plan, bytes);
  if (repair && existing && !existing.draft) {
    verifyAssets(existing, files);
    console.log(`No changed release inputs; ${manifest.name}@${version} is already published.`);
    output('release', 'false');
    return;
  }
  for (const [name, content] of files) writeFileSync(join(stage, name), content);
  output('release', 'true');
  output('version', version);
  console.log(`${repair ? 'Repair GitHub release for' : 'Prepared'} ${manifest.name}@${version}; source ${source}`);
}
async function publish() {
  if (process.env.PUBLISH_ALLOWED !== 'true') throw Error('Publishing is disabled for validation runs');
  const head = assertSource();
  const plan = JSON.parse(readFileSync(join(stage, 'release-manifest.json'), 'utf8'));
  if (plan.name !== manifest.name || plan.fingerprint !== fingerprint() || plan.tag !== `v${plan.version}` || basename(plan.filename) !== plan.filename || !/^[0-9a-f]{40}$/.test(plan.source)) throw Error('Artifact differs from the checked source');
  versionParts(plan.version);
  git('merge-base', '--is-ancestor', plan.source, head);
  const bytes = readFileSync(join(stage, plan.filename));
  if (integrity(bytes) !== plan.integrity) throw Error('Staged tarball integrity mismatch');
  const files = releaseAssets(plan, bytes);
  if (!readFileSync(join(stage, 'SHA256SUMS.txt')).equals(files.get('SHA256SUMS.txt'))) throw Error('Staged checksum manifest differs');
  if (api('commits/main')?.sha !== head) { console.log('main advanced; leave current releases intact.'); return; }
  verifyTag(plan);
  const before = await metadata();
  const recordResponse = before?.versions[plan.version] ? undefined : await fetchRegistry(`${encodeURIComponent(plan.name)}/${plan.version}`);
  const record = before?.versions[plan.version] ?? (recordResponse ? await recordResponse.json() : undefined);
  if (record) {
    assertRecord(record, plan);
    if (before && before['dist-tags'].latest !== plan.version) throw Error('A different npm latest exists; never move it backwards');
    console.log('npm version is already verified; only completing GitHub release.');
  } else {
    if (before && Object.keys(before.versions).filter(v => /^\d+\.\d+\.\d+$/.test(v)).some(v => compareVersions(v, plan.version) >= 0)) throw Error('Prepared version no longer exceeds every published stable version');
    // Exactly one publish attempt. A lost response is reconciled from npm on the next run.
    run('npm', ['publish', join(stage, plan.filename), '--access', 'public', '--tag', 'latest', '--ignore-scripts', `--registry=${registry}`], { stdio: 'inherit' });
  }
  let published;
  for (let attempt = 0; attempt < 24; attempt++) {
    published = await metadata();
    if (published?.versions[plan.version]) break;
    if (attempt < 23) await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  if (!published?.versions[plan.version]) throw Error(`npm accepted ${plan.version}, but public metadata is still unavailable; wait and rerun to reconcile, do not republish`);
  assertRecord(published.versions[plan.version], plan);
  if (published['dist-tags'].latest !== plan.version) throw Error('npm latest was not verified; do not republish');
  const tarball = new URL(published.versions[plan.version].dist.tarball);
  if (tarball.origin !== registry) throw Error('Unexpected tarball registry');
  const response = await fetchRegistry(tarball.pathname.slice(1));
  if (!response || integrity(Buffer.from(await response.arrayBuffer())) !== plan.integrity) throw Error('Downloaded npm package integrity mismatch');
  let release = releaseForTag(plan.tag);
  if (release && !release.draft) {
    verifyAssets(release, files);
  } else {
    const notes = join(stage, 'notes.md');
    writeFileSync(notes, `Install: \`pi install npm:${plan.name}\`\n\nVersion: \`${plan.version}\`\nSource: \`${plan.source}\`\n\nPublished to npm; the Pi package catalog discovers this package via the \`pi-package\` keyword. Catalog refresh timing is controlled by Pi.\n\nAssets include the exact npm tarball, release-manifest.json and SHA256SUMS.txt.\n`);
    if (!release) gh('release', 'create', plan.tag, '--repo', repository, '--target', plan.source, '--title', `pi-final-model ${plan.version}`, '--notes-file', notes, '--draft');
    gh('release', 'upload', plan.tag, '--repo', repository, '--clobber', ...[...files.keys()].map(name => join(stage, name)));
    release = releaseForTag(plan.tag);
    verifyAssets(release, files);
    // main may advance after npm succeeds. Finish the receipt for this exact published artifact.
    gh('release', 'edit', plan.tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest');
  }
  verifyTag(plan, true);
  release = api(`releases/tags/${plan.tag}`);
  if (!release || release.draft || release.prerelease || api('releases/latest')?.tag_name !== plan.tag) throw Error('GitHub stable/latest was not verified');
  console.log(`Verified ${plan.name}@${plan.version}: npm latest, tarball integrity, GitHub tag and release. Pi installs the same npm package.`);
}

// Cheap pre-check before install/check: skip the daily run until package.json is bumped past npm latest.
async function gate() {
  const before = await metadata();
  const latest = before?.['dist-tags'].latest;
  if (!latest || latest === '0.0.0-stage') { output('proceed', 'true'); return; }
  const release = releaseForTag(`v${latest}`);
  if (compareVersions(manifest.version, latest) <= 0 && release && !release.draft) {
    console.log(`package.json ${manifest.version} is not newer than published ${manifest.name}@${latest}; bump the version to release again.`);
    output('proceed', 'false');
    return;
  }
  output('proceed', 'true');
}

const command = process.argv[2];
if (process.argv.length !== 3 || !['gate', 'prepare', 'publish'].includes(command)) throw Error('Usage: node scripts/release.mjs gate|prepare|publish');
await ({ gate, prepare, publish })[command]();
