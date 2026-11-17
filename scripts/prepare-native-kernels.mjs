import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { assetManifest, prepareClientKernel, verifyKernelHeader } from './prepare-client-kernels.mjs';
import { prepareValidationResources } from './prepare-validation-resources.mjs';
import { runCommand } from './native-test-process.mjs';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function hostTarget(platform = process.platform, arch = process.arch) {
  return `${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : arch}`;
}
export function assertNativeTarget(target, host = hostTarget()) {
  if (!Object.hasOwn(assetManifest.mihomo.assets, target)) throw new Error(`Unsupported native target: ${target}`);
  if (target !== host) throw new Error(`Native target mismatch: requested ${target}, host is ${host}; cross-compilation is not native acceptance`);
}
function argument(source, name) {
  const values = [...source.matchAll(new RegExp(`^ARG ${name}=([^\\s]+)$`, 'gm'))].map(match => match[1]);
  if (!values.length || new Set(values).size !== 1) throw new Error(`Missing or inconsistent Docker pin: ${name}`);
  return values[0];
}
// Docker 发行构建已经固定源码与伴生库；读取同一基线，避免额外维护另一份锁。
export function parseNativeBuildSpec(master, agent) {
  master = master.replaceAll('\r\n', '\n'); agent = agent.replaceAll('\r\n', '\n');
  const pins = {};
  for (const name of ['SINGBOX_VERSION', 'SINGBOX_REVISION', 'SINGBOX_SHA256', 'CRONET_VERSION', 'CRONET_SHA256_AMD64', 'CRONET_SHA256_ARM64']) {
    pins[name] = argument(master, name);
    if (pins[name] !== argument(agent, name)) throw new Error(`Docker kernel pins disagree: ${name}`);
    if (name.includes('SHA256') && !/^[a-f0-9]{64}$/.test(pins[name])) throw new Error(`Invalid SHA-256 pin: ${name}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(pins.SINGBOX_VERSION) || !/^[1-9]\d*$/.test(pins.SINGBOX_REVISION) || !/^v[\d.-]+$/.test(pins.CRONET_VERSION)) throw new Error('Invalid native kernel version pins');
  const tags = master.match(/-tags (with_[a-z0-9_,]+)/)?.[1];
  if (!tags || tags !== agent.match(/-tags (with_[a-z0-9_,]+)/)?.[1] || !tags.includes('with_riri_device_tracking') || !tags.includes('with_purego')) throw new Error('Missing or inconsistent custom Sing-box build tags');
  return { ...pins, tags };
}
export async function fileDigest(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: stat.size };
}
export async function downloadPinnedArtifact({ url, sha256, destination, fetchImpl = fetch, maxBytes = 256 * 1024 * 1024 }) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || new URL(url).protocol !== 'https:') throw new Error('A pinned HTTPS artifact is required');
  try {
    const cached = await fileDigest(destination);
    if (cached.sha256 !== sha256 || cached.size > maxBytes) throw new Error(`Cached artifact SHA-256/size mismatch: ${destination}`);
    return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Artifact download HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('Artifact exceeds size limit'); }
    const hash = createHash('sha256'); let size = 0;
    await pipeline(response.body, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(new Error('Artifact exceeds size limit'));
      hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
    if (hash.digest('hex') !== sha256) throw new Error('Artifact SHA-256 mismatch');
    await fs.rename(temporary, destination);
    return destination;
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function inspectExecutable(file, target) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    verifyKernelHeader(bytes.subarray(0, bytesRead), target);
  } finally { await handle.close(); }
  return { path: file, ...await fileDigest(file) };
}
async function verifyGo(go, target, env) {
  const info = JSON.parse(await runCommand(go, ['env', '-json', 'GOHOSTOS', 'GOHOSTARCH', 'GOVERSION'], { cwd: repository, env, capture: true }));
  assertNativeTarget(target, `${info.GOHOSTOS}-${info.GOHOSTARCH}`);
  const minimum = (await fs.readFile(path.join(repository, 'apps/agent/go.mod'), 'utf8')).match(/^go (\d+\.\d+(?:\.\d+)?)$/m)?.[1];
  const actual = info.GOVERSION.match(/^go(\d+\.\d+\.\d+)$/)?.[1];
  const number = value => value.split('.').reduce((sum, item, index) => sum + Number(item) * 1000 ** (2 - index), 0);
  if (!minimum || !actual || number(actual) < number(minimum)) throw new Error(`Native Go must satisfy apps/agent/go.mod (${minimum}); found ${info.GOVERSION}`);
  return info;
}
async function removeBuildDirectory(directory, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('source-')) throw new Error('Refusing cleanup outside native build directory');
  await fs.rm(directory, { recursive: true, force: true });
}

export async function prepareNativeKernels({ target = hostTarget(), outputRoot = path.join(repository, 'artifacts/native', target), cacheRoot = path.join(repository, 'artifacts/native-downloads') } = {}) {
  assertNativeTarget(target);
  outputRoot = path.resolve(outputRoot); cacheRoot = path.resolve(cacheRoot);
  const [masterDocker, agentDocker] = await Promise.all(['Dockerfile', 'Dockerfile.agent'].map(file => fs.readFile(path.join(repository, file), 'utf8')));
  const pins = parseNativeBuildSpec(masterDocker, agentDocker);
  const [os, arch] = target.split('-');
  const go = process.env.GO_BIN || 'go';
  const env = { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch, GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '-mod=readonly' };
  const toolchain = await verifyGo(go, target, env);
  await fs.mkdir(outputRoot, { recursive: true });
  const sourceArchive = await downloadPinnedArtifact({
    url: `https://github.com/SagerNet/sing-box/archive/refs/tags/v${pins.SINGBOX_VERSION}.tar.gz`,
    sha256: pins.SINGBOX_SHA256, destination: path.join(cacheRoot, `sing-box-${pins.SINGBOX_SHA256}.tar.gz`),
  });
  const singboxDirectory = path.join(outputRoot, 'singbox', `${pins.SINGBOX_VERSION}-r${pins.SINGBOX_REVISION}`, target);
  await fs.mkdir(singboxDirectory, { recursive: true });
  const singbox = path.join(singboxDirectory, os === 'windows' ? 'sing-box.exe' : 'sing-box');
  let cronet;
  if (os === 'linux') {
    const sha256 = pins[`CRONET_SHA256_${arch.toUpperCase()}`];
    const library = await downloadPinnedArtifact({
      url: `https://github.com/SagerNet/cronet-go/releases/download/${pins.CRONET_VERSION}/libcronet-linux-${arch}.so`,
      sha256, destination: path.join(cacheRoot, `libcronet-${sha256}.so`),
    });
    const destination = path.join(singboxDirectory, 'libcronet.so');
    await fs.copyFile(library, destination); await fs.chmod(destination, 0o755);
    cronet = { version: pins.CRONET_VERSION, ...await inspectExecutable(destination, target) };
  }
  const temporary = await fs.mkdtemp(path.join(outputRoot, 'source-'));
  const patch = (await fs.readFile(path.join(repository, 'apps/agent/patches/sing-box-clashapi-inbound-user.patch'), 'utf8')).replaceAll('\r\n', '\n');
  try {
    // 每次从校验后的源码重新构建，只缓存下载和 Go 编译缓存，不信任旧的编译产物。
    // 归档使用相对文件名，避免 GNU tar 把 Windows 盘符当远程主机，同时兼容 macOS bsdtar。
    await runCommand('tar', ['-xzf', path.basename(sourceArchive), '-C', temporary.replaceAll('\\', '/')], { cwd: path.dirname(sourceArchive) });
    const source = path.join(temporary, `sing-box-${pins.SINGBOX_VERSION}`);
    await runCommand('patch', ['--batch', '--forward', '-p1'], { cwd: source, input: patch });
    await runCommand(go, ['build', '-trimpath', '-tags', pins.tags, '-ldflags', `-s -w -X github.com/sagernet/sing-box/constant.Version=${pins.SINGBOX_VERSION}`, '-o', singbox, './cmd/sing-box'], { cwd: source, env, timeoutMs: 30 * 60_000 });
  } finally { await removeBuildDirectory(temporary, outputRoot); }
  const singboxInfo = await inspectExecutable(singbox, target);
  const versionOutput = await runCommand(singbox, ['version'], { capture: true, cwd: singboxDirectory });
  if (!versionOutput.includes(`sing-box version ${pins.SINGBOX_VERSION}\n`) || !pins.tags.split(',').every(tag => versionOutput.includes(tag))) throw new Error('Custom Sing-box version/build tags mismatch');
  const mihomoSpec = assetManifest.mihomo.assets[target];
  const mihomoArchive = await downloadPinnedArtifact({ url: assetManifest.mihomo.releaseBaseUrl + mihomoSpec.file, sha256: mihomoSpec.sha256, destination: path.join(cacheRoot, mihomoSpec.file) });
  // 显式传入已验证归档，防止本地可改写的解压 manifest 替代官方归档哈希。
  const mihomo = await prepareClientKernel({ target, outputRoot: path.join(outputRoot, 'mihomo'), archiveFile: mihomoArchive });
  const mihomoVersion = await runCommand(mihomo.destination, ['-v'], { capture: true });
  if (!mihomoVersion.includes(`Mihomo Meta v${assetManifest.mihomo.version} `)) throw new Error('Mihomo runtime version mismatch');
  const validation = await prepareValidationResources({ outputRoot: path.join(cacheRoot, 'validation-resources') });
  // 真实 Agent/内核联调使用显式内核路径；不修改源码树中的嵌入占位文件。
  const agent = path.join(outputRoot, os === 'windows' ? 'riri-agent.exe' : 'riri-agent');
  const agentVersion = (await fs.readFile(path.join(repository, 'apps/agent/VERSION'), 'utf8')).trim();
  await runCommand(go, ['build', '-trimpath', '-ldflags', `-s -w -X main.Version=${agentVersion} -X main.BuildMarker=RIRICLOUD_AGENT_VERSION:${agentVersion}`, '-o', agent, '.'], { cwd: path.join(repository, 'apps/agent'), env, timeoutMs: 15 * 60_000 });
  const manifest = {
    schemaVersion: 1, target, node: process.version, toolchain,
    singbox: { ...singboxInfo, version: pins.SINGBOX_VERSION, revision: Number(pins.SINGBOX_REVISION), sourceSha256: pins.SINGBOX_SHA256, patchSha256: createHash('sha256').update(patch).digest('hex'), tags: pins.tags, versionOutput },
    cronet: cronet ?? { supported: false, reason: 'Naive/Cronet native acceptance is Linux-only' },
    mihomo: { ...mihomo.profile, path: mihomo.destination, versionOutput: mihomoVersion },
    agent: { ...await inspectExecutable(agent, target), version: agentVersion },
    validation: { path: validation.destination, ...validation.manifest },
  };
  await fs.writeFile(path.join(outputRoot, 'resources.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Prepared native kernels for ${target}: Sing-box ${pins.SINGBOX_VERSION}, Mihomo ${assetManifest.mihomo.version}, ${toolchain.GOVERSION}`);
  return manifest;
}
