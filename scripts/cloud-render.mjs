#!/usr/bin/env node
/**
 * VIDEOCOMICS Distributed Cloud Renderer
 *
 * Modes:
 *   --mode prepare  : Probes Chrome WebCodecs H.264 encoder, mixes 48kHz audio once -> audio.m4a,
 *                     encodes intro video cleanly (matching WebCodecs SPS/PPS), writes plan.json.
 *   --mode chunk    : Renders a single matrix chunk [startFrame, endFrame) using in-process Chrome
 *                     WebCodecs H.264 (zero 8.3 MB/frame HTTP overhead!) across local vCPUs.
 *   --mode assemble : Losslessly concatenates part_intro.mp4 + part_chunk_*.mp4 + audio.m4a
 *                     into final 1080p MP4 (-c:v copy -c:a copy -movflags +faststart).
 *   --mode all      : Runs prepare -> chunk -> assemble sequentially on a single machine.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const ARCHIVE_MAGIC = 'VCOMICS1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function parseArgs(argv) {
  const args = {
    mode: 'all',
    input: '',
    output: '',
    workDir: '',
    plan: '',
    chunkIndex: 0,
    chunks: 6,
    fps: null,
    quality: 'equilibrada',
    preset: 'veryfast',
    crf: '18',
    workers: null,
    summaryJson: '',
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--mode' && val) {
      args.mode = val;
      i++;
    } else if (key === '--input' && val) {
      args.input = path.resolve(val);
      i++;
    } else if (key === '--output' && val) {
      args.output = path.resolve(val);
      i++;
    } else if (key === '--work-dir' && val) {
      args.workDir = path.resolve(val);
      i++;
    } else if (key === '--plan' && val) {
      args.plan = path.resolve(val);
      i++;
    } else if (key === '--chunk-index' && val !== undefined) {
      args.chunkIndex = Math.max(0, Number(val) || 0);
      i++;
    } else if (key === '--chunks' && val) {
      args.chunks = Math.max(1, Math.min(16, Number(val) || 1));
      i++;
    } else if (key === '--fps' && val) {
      if (val === '30' || val === '60') {
        args.fps = Number(val);
      }
      i++;
    } else if (key === '--quality' && val) {
      if (val === 'rapida' || val === 'equilibrada' || val === 'maxima') {
        args.quality = val;
      }
      i++;
    } else if (key === '--preset' && val) {
      args.preset = val;
      i++;
    } else if (key === '--crf' && val) {
      args.crf = val;
      i++;
    } else if (key === '--workers' && val) {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 1 && n <= 8) {
        args.workers = Math.floor(n);
      }
      i++;
    } else if (key === '--summary-json' && val) {
      args.summaryJson = path.resolve(val);
      i++;
    }
  }

  return args;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(rem).padStart(2, '0')}s`;
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function streamRequestToFile(req, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const ws = fs.createWriteStream(destPath);
    req.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    req.pipe(ws);
  });
}

function readRequestIntoBuffer(req, targetBuf) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    req.on('data', (chunk) => {
      if (offset + chunk.length <= targetBuf.length) {
        chunk.copy(targetBuf, offset);
      }
      offset += chunk.length;
    });
    req.on('end', () => {
      if (offset !== targetBuf.length) {
        reject(new Error(`Tamaño de fotograma inesperado: ${offset} != ${targetBuf.length}`));
        return;
      }
      resolve(targetBuf);
    });
    req.on('error', reject);
  });
}

function writeStreamWithDrain(stream, buffer) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      stream.off('drain', onDrain);
      reject(err);
    };
    const onDrain = () => {
      stream.off('error', onError);
      resolve();
    };
    if (stream.write(buffer)) {
      resolve();
      return;
    }
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function runFfmpegOnce(ffArgs) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg salió con código ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractIntroVideoFromArchive(archivePath, outDir) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    const magic = header.subarray(0, 8).toString('ascii');
    if (magic !== ARCHIVE_MAGIC) return null;
    const manifestLen = header.readUInt32LE(8);
    const manifestBuf = Buffer.alloc(manifestLen);
    fs.readSync(fd, manifestBuf, 0, manifestLen, 12);
    const manifest = JSON.parse(manifestBuf.toString('utf8'));

    if (!manifest.introVideo || !manifest.introVideo.file || (manifest.aspectRatio || '16:9') !== '16:9') {
      return null;
    }
    const entry = manifest.introVideo.file;
    if (!entry.length || entry.length <= 0) return null;

    const dataStart = 12 + manifestLen;
    const start = dataStart + entry.offset;
    const end = start + entry.length - 1;
    const ext = path.extname(manifest.introVideo.name || '.mp4') || '.mp4';
    const rawPath = path.join(outDir, `intro_raw${ext}`);

    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(archivePath, { start, end });
      const ws = fs.createWriteStream(rawPath);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });

    return rawPath;
  } finally {
    fs.closeSync(fd);
  }
}

async function launchHeadlessChrome(chromium) {
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu-compositing',
    '--disable-extensions',
    '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required',
  ];

  try {
    return await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: launchArgs,
    });
  } catch {
    const chromeCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    const existingChrome = chromeCandidates.find((p) => fs.existsSync(p));
    return chromium.launch({
      ...(existingChrome ? { executablePath: existingChrome } : {}),
      headless: true,
      args: launchArgs,
    });
  }
}

async function openBridgePage(browser, baseUrl, label) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`[Browser ${label} Error]`, msg.text());
    } else if (msg.text().startsWith('[VIDEOCOMICS]')) {
      console.log(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    console.error(`[Browser ${label} PageError]`, err);
  });

  await page.goto(`${baseUrl}/?cloud-render=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__VIDEOCOMICS_CLOUD_READY__), {
    timeout: 30_000,
  });
  return page;
}

function serveStaticDist(pathname, res) {
  const safeRelPath = pathname === '/' ? '/index.html' : pathname;
  const resolvedFile = path.resolve(DIST_DIR, `.${safeRelPath}`);
  if (!resolvedFile.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let targetFile = resolvedFile;
  if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
    targetFile = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(targetFile).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(targetFile).pipe(res);
}

async function runPrepare(args) {
  if (!args.input || !fs.existsSync(args.input)) {
    throw new Error(`Archivo de proyecto no encontrado: ${args.input || '(vacío)'}`);
  }
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('No se encontró dist/index.html. Ejecuta "npm run build" primero.');
  }

  const workDir = args.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'videocomics-prep-'));
  fs.mkdirSync(workDir, { recursive: true });
  const pcmPath = path.join(workDir, 'mixed_audio.pcm');
  const audioM4aPath = path.join(workDir, 'audio.m4a');
  const partIntroPath = path.join(workDir, 'part_intro.mp4');
  const introLastImgPath = path.join(workDir, 'intro_last.jpg');
  const introFramesDir = path.join(workDir, 'intro_frames_tmp');
  const planPath = args.plan || path.join(workDir, 'plan.json');

  let pcmStream = null;

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(reqUrl.pathname);

      if (req.method === 'GET' && pathname === '/__cloud__/project.videocomics') {
        const stat = fs.statSync(args.input);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(args.input).pipe(res);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/__cloud__/intro-frame/')) {
        const name = path.basename(pathname);
        const framePath = path.join(introFramesDir, name);
        if (!fs.existsSync(framePath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        fs.createReadStream(framePath).pipe(res);
        return;
      }

      if (req.method === 'POST' && pathname === '/__cloud__/upload-intro') {
        await streamRequestToFile(req, partIntroPath);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && pathname === '/__cloud__/audio-chunk') {
        const body = await readRequestBody(req);
        if (!pcmStream) pcmStream = fs.createWriteStream(pcmPath);
        await writeStreamWithDrain(pcmStream, body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && pathname === '/__cloud__/audio-done') {
        await readRequestBody(req);
        if (pcmStream) {
          await new Promise((resolve, reject) => {
            pcmStream.end((err) => (err ? reject(err) : resolve()));
          });
          pcmStream = null;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      serveStaticDist(pathname, res);
    } catch (err) {
      console.error('[VIDEOCOMICS] Error en servidor prepare:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  server.on('connection', (sock) => sock.setNoDelay(true));
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let browser = null;
  let meta = null;
  let hasIntroVideoPart = false;
  let hasIntroLastImg = false;
  let effectiveIntroFrameCount = 0;

  try {
    const { chromium } = await import('playwright-core');
    browser = await launchHeadlessChrome(chromium);
    const page = await openBridgePage(browser, baseUrl, 'PREP');

    meta = await page.evaluate(
      async ({ projectUrl, projectFilename, fpsOverride, quality }) => {
        if (!window.__VIDEOCOMICS_CLOUD_PREPARE__) {
          throw new Error('Puente de preparación en la nube no disponible.');
        }
        return window.__VIDEOCOMICS_CLOUD_PREPARE__({
          projectUrl,
          projectFilename,
          fpsOverride,
          quality,
        });
      },
      {
        projectUrl: `${baseUrl}/__cloud__/project.videocomics`,
        projectFilename: path.basename(args.input),
        fpsOverride: args.fps,
        quality: args.quality,
      }
    );

    // Handle intro video right here while Prepare browser is open
    if (meta.introFrameCount > 0) {
      const rawIntroPath = await extractIntroVideoFromArchive(args.input, workDir);
      if (!rawIntroPath) {
        throw new Error(
          `El proyecto declara una intro de ${meta.introFrameCount} frames, pero no se pudo extraer el vídeo de intro desde ${path.basename(args.input)}.`
        );
      }
      if (rawIntroPath) {
        const scaleFilter =
          meta.introFitMode === 'cover'
            ? `scale=${meta.width}:${meta.height}:force_original_aspect_ratio=increase,crop=${meta.width}:${meta.height}`
            : `scale=${meta.width}:${meta.height}:force_original_aspect_ratio=decrease,pad=${meta.width}:${meta.height}:(ow-iw)/2:(oh-ih)/2:black`;
        const vf = `fps=${meta.fps},${scaleFilter},tpad=stop_mode=clone:stop_duration=1`;

        if (meta.webcodecsConfig) {
          console.log(
            `[VIDEOCOMICS] Extrayendo ${meta.introFrameCount} frames de intro con FFmpeg para codificar en WebCodecs...`
          );
          fs.mkdirSync(introFramesDir, { recursive: true });
          await runFfmpegOnce([
            '-y',
            '-loglevel',
            'error',
            '-i',
            rawIntroPath,
            '-vf',
            vf,
            '-frames:v',
            String(meta.introFrameCount),
            '-q:v',
            '2',
            path.join(introFramesDir, 'f_%06d.jpg'),
          ]);

          const lastFrameFile = path.join(
            introFramesDir,
            `f_${String(meta.introFrameCount).padStart(6, '0')}.jpg`
          );
          if (fs.existsSync(lastFrameFile)) {
            fs.copyFileSync(lastFrameFile, introLastImgPath);
            hasIntroLastImg = true;
          }

          console.log(
            `[VIDEOCOMICS] Codificando intro (${meta.introFrameCount} frames) con WebCodecs ${meta.webcodecsConfig.codec}...`
          );
          await page.evaluate(
            async (cfg) => {
              if (!window.__VIDEOCOMICS_CLOUD_ENCODE_INTRO__) {
                throw new Error('Codificador de intro WebCodecs no disponible.');
              }
              return window.__VIDEOCOMICS_CLOUD_ENCODE_INTRO__(cfg);
            },
            {
              width: meta.width,
              height: meta.height,
              fps: meta.fps,
              frameCount: meta.introFrameCount,
              frameUrlTemplate: `${baseUrl}/__cloud__/intro-frame/f_{INDEX}.jpg`,
              webcodecsConfig: meta.webcodecsConfig,
              uploadUrl: `${baseUrl}/__cloud__/upload-intro`,
            }
          );

          hasIntroVideoPart = fs.existsSync(partIntroPath);
          effectiveIntroFrameCount = hasIntroVideoPart ? meta.introFrameCount : 0;
          fs.rmSync(introFramesDir, { recursive: true, force: true });
        } else {
          console.log(
            `[VIDEOCOMICS] Renderizando vídeo de intro con FFmpeg (${meta.introFrameCount} frames @ ${meta.fps}fps)...`
          );
          await runFfmpegOnce([
            '-y',
            '-loglevel',
            'error',
            '-i',
            rawIntroPath,
            '-vf',
            vf,
            '-frames:v',
            String(meta.introFrameCount),
            '-c:v',
            'libx264',
            '-preset',
            args.preset,
            '-crf',
            args.crf,
            '-profile:v',
            'high',
            '-level:v',
            '4.2',
            '-pix_fmt',
            'yuv420p',
            '-g',
            String(meta.fps * 2),
            '-bf',
            '2',
            '-video_track_timescale',
            String(meta.fps * 1000),
            '-an',
            partIntroPath,
          ]);
          hasIntroVideoPart = fs.existsSync(partIntroPath);
          effectiveIntroFrameCount = hasIntroVideoPart ? meta.introFrameCount : 0;

          if (meta.introTransitionDuration > 0 && hasIntroVideoPart) {
            await runFfmpegOnce([
              '-y',
              '-loglevel',
              'error',
              '-sseof',
              '-0.15',
              '-i',
              partIntroPath,
              '-update',
              '1',
              '-frames:v',
              '1',
              '-q:v',
              '2',
              introLastImgPath,
            ]);
            hasIntroLastImg = fs.existsSync(introLastImgPath);
          }
        }

        fs.rmSync(rawIntroPath, { force: true });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (pcmStream) pcmStream.destroy();
    fs.rmSync(introFramesDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(() => resolve()));
  }

  // Encode mixed PCM audio once into compact AAC 192k M4A
  let hasAudioFile = false;
  if (meta.hasAudio && fs.existsSync(pcmPath)) {
    console.log('[VIDEOCOMICS] Codificando pista de audio maestra (AAC 192 kbps)...');
    await runFfmpegOnce([
      '-y',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-i',
      pcmPath,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      audioM4aPath,
    ]);
    fs.rmSync(pcmPath, { force: true });
    hasAudioFile = true;
  }

  const remainingFrames = Math.max(0, meta.totalFrames - effectiveIntroFrameCount);
  const chunkCount =
    remainingFrames === 0
      ? 0
      : Math.max(1, Math.min(args.chunks, Math.ceil(remainingFrames / 60)));

  const chunks = [];
  if (chunkCount > 0) {
    const baseCount = Math.floor(remainingFrames / chunkCount);
    const rem = remainingFrames % chunkCount;
    let cursor = effectiveIntroFrameCount;
    for (let idx = 0; idx < chunkCount; idx++) {
      const count = baseCount + (idx < rem ? 1 : 0);
      chunks.push({
        index: idx,
        startFrame: cursor,
        endFrame: cursor + count,
      });
      cursor += count;
    }
  }

  const plan = {
    ...meta,
    introFrameCount: effectiveIntroFrameCount,
    hasAudioFile,
    hasIntroVideoPart,
    hasIntroLastImg,
    quality: args.quality,
    preset: args.preset,
    crf: args.crf,
    inputFilename: path.basename(args.input),
    chunks,
    preparedAtIso: new Date().toISOString(),
  };

  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
  console.log(
    `[VIDEOCOMICS] Plan listo: ${plan.width}x${plan.height} @ ${plan.fps}fps · ${plan.totalFrames} frames (${formatDuration(plan.totalDuration)}) · motor=${plan.webcodecsConfig ? `WebCodecs ${plan.webcodecsConfig.codec}` : 'FFmpeg x264'} · intro=${plan.introFrameCount}f · ${chunks.length} fragmentos en paralelo.`
  );
  return plan;
}

async function runChunk(args) {
  if (!args.input || !fs.existsSync(args.input)) {
    throw new Error(`Archivo de proyecto no encontrado: ${args.input || '(vacío)'}`);
  }
  const workDir = args.workDir || path.dirname(args.plan || args.output || '.');
  fs.mkdirSync(workDir, { recursive: true });

  const findFileFallback = (primaryPath, filename) => {
    if (primaryPath && fs.existsSync(primaryPath)) return primaryPath;
    const candidates = [
      path.join(workDir, filename),
      path.join(process.cwd(), 'cloud_prep', filename),
      path.join(process.cwd(), filename),
      path.join(workDir, 'cloud_prep', filename),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) return cand;
    }
    return primaryPath;
  };

  const planPath = findFileFallback(args.plan || path.join(workDir, 'plan.json'), 'plan.json');
  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan no encontrado: ${planPath}. Buscado también en ./cloud_prep y .`);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const chunk = plan.chunks.find((c) => c.index === args.chunkIndex);
  if (!chunk) {
    throw new Error(`Fragmento #${args.chunkIndex} no encontrado en ${planPath}.`);
  }

  const introLastImgPath = findFileFallback(path.join(workDir, 'intro_last.jpg'), 'intro_last.jpg');
  const chunkOutputPath =
    args.output || path.join(workDir, `part_chunk_${chunk.index}.mp4`);
  fs.mkdirSync(path.dirname(chunkOutputPath), { recursive: true });

  const totalChunkFrames = Math.max(1, chunk.endFrame - chunk.startFrame);
  const cpuCount = Math.max(1, os.cpus().length);
  const useWebCodecs = Boolean(plan.webcodecsConfig);
  const internalWorkers =
    args.workers ?? (totalChunkFrames >= 120 ? Math.min(2, cpuCount) : 1);

  const subTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `vc-chunk-${chunk.index}-`));
  const frameBytes = plan.width * plan.height * 4;
  const timescale = String(plan.fps * 1000);
  const preset = args.preset || plan.preset || 'veryfast';
  const crf = args.crf || plan.crf || '18';

  const getSubPartPath = (workerId) =>
    internalWorkers === 1 ? chunkOutputPath : path.join(subTempDir, `sub_${workerId}.mp4`);

  const workers = new Map();
  let framesReceived = 0;
  let renderStartMs = 0;
  let lastLogMs = 0;

  const logProgressIfNeeded = (force = false) => {
    const now = Date.now();
    if (force || framesReceived >= totalChunkFrames || now - lastLogMs >= 4000) {
      lastLogMs = now;
      const elapsedSec = Math.max(0.1, (now - renderStartMs) / 1000);
      const speedFps = framesReceived / elapsedSec;
      const pct = Math.min(100, Math.round((framesReceived / totalChunkFrames) * 100));
      const remFrames = Math.max(0, totalChunkFrames - framesReceived);
      const etaSec = speedFps > 0 ? remFrames / speedFps : 0;
      const engineTag = useWebCodecs ? 'WebCodecs' : 'FFmpeg';
      console.log(
        `[VIDEOCOMICS] Fragmento ${chunk.index + 1}/${plan.chunks.length} (${engineTag}): ${pct}% (${framesReceived}/${totalChunkFrames} frames · ${speedFps.toFixed(1)} fps · ETA ${formatDuration(etaSec)})`
      );
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(reqUrl.pathname);

      if (req.method === 'GET' && pathname === '/__cloud__/project.videocomics') {
        const stat = fs.statSync(args.input);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(args.input).pipe(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/__cloud__/intro-last.jpg') {
        if (!fs.existsSync(introLastImgPath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        fs.createReadStream(introLastImgPath).pipe(res);
        return;
      }

      // WebCodecs heartbeat progress (tiny request every 30 frames)
      if (req.method === 'POST' && pathname === '/__cloud__/progress') {
        const delta = Math.max(0, Number(reqUrl.searchParams.get('delta') ?? '0') || 0);
        framesReceived += delta;
        logProgressIfNeeded(false);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      // WebCodecs single final MP4 upload per worker
      if (req.method === 'POST' && pathname === '/__cloud__/upload-part') {
        const workerId = Number(reqUrl.searchParams.get('w') ?? '0');
        const destPath = getSubPartPath(workerId);
        await streamRequestToFile(req, destPath);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      // FFmpeg fallback endpoints
      if (req.method === 'POST' && pathname === '/__cloud__/start-worker') {
        const body = await readRequestBody(req);
        const { workerId } = JSON.parse(body.toString('utf8'));
        const partPath = getSubPartPath(workerId);
        const ffThreads = internalWorkers > 1 ? '1' : '0';
        const ffArgs = [
          '-y',
          '-loglevel',
          'error',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-s:v',
          `${plan.width}x${plan.height}`,
          '-r',
          String(plan.fps),
          '-i',
          'pipe:0',
          '-c:v',
          'libx264',
          '-preset',
          preset,
          '-crf',
          crf,
          '-profile:v',
          'high',
          '-level:v',
          '4.2',
          '-pix_fmt',
          'yuv420p',
          '-g',
          String(plan.fps * 2),
          '-bf',
          '2',
          '-video_track_timescale',
          timescale,
          '-threads',
          ffThreads,
          '-an',
          partPath,
        ];

        const proc = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
        const workerState = {
          partPath,
          proc,
          stderr: '',
          buffers: [Buffer.allocUnsafe(frameBytes), Buffer.allocUnsafe(frameBytes)],
          bufIdx: 0,
          promise: null,
        };
        proc.stderr.on('data', (d) => {
          workerState.stderr += d.toString('utf8');
        });
        workerState.promise = new Promise((resolve, reject) => {
          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else
              reject(
                new Error(
                  `FFmpeg (sub-hilo ${workerId}) salió con código ${code}: ${workerState.stderr.trim()}`
                )
              );
          });
        });

        workers.set(workerId, workerState);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && pathname === '/__cloud__/frame') {
        const workerId = Number(reqUrl.searchParams.get('w') ?? '0');
        const workerState = workers.get(workerId);
        if (!workerState || !workerState.proc.stdin) {
          throw new Error(`FFmpeg del sub-hilo ${workerId} no está inicializado.`);
        }

        const frameBuf = workerState.buffers[workerState.bufIdx];
        workerState.bufIdx ^= 1;
        await readRequestIntoBuffer(req, frameBuf);
        await writeStreamWithDrain(workerState.proc.stdin, frameBuf);

        framesReceived += 1;
        logProgressIfNeeded(false);

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && pathname === '/__cloud__/finish-worker') {
        const body = await readRequestBody(req);
        const { workerId } = JSON.parse(body.toString('utf8'));
        const workerState = workers.get(workerId);
        if (workerState) {
          if (workerState.proc.stdin && !workerState.proc.stdin.destroyed) {
            workerState.proc.stdin.end();
          }
          await workerState.promise;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      serveStaticDist(pathname, res);
    } catch (err) {
      console.error('[VIDEOCOMICS] Error en servidor chunk:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  server.on('connection', (sock) => sock.setNoDelay(true));
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browsers = [];
  try {
    const { chromium } = await import('playwright-core');

    const subSlices = [];
    const baseSub = Math.floor(totalChunkFrames / internalWorkers);
    const remSub = totalChunkFrames % internalWorkers;
    let cursor = chunk.startFrame;
    for (let w = 0; w < internalWorkers; w++) {
      const count = baseSub + (w < remSub ? 1 : 0);
      subSlices.push({ workerId: w, startFrame: cursor, endFrame: cursor + count });
      cursor += count;
    }

    console.log(
      `[VIDEOCOMICS] Fragmento ${chunk.index + 1}/${plan.chunks.length}: frames [${chunk.startFrame}..${chunk.endFrame}) (${totalChunkFrames} frames) · motor=${useWebCodecs ? `WebCodecs ${plan.webcodecsConfig.codec}` : `FFmpeg ${preset}`} · ${internalWorkers} hilos (${cpuCount} vCPUs)`
    );

    const pages = await Promise.all(
      subSlices.map(async (s) => {
        const b = await launchHeadlessChrome(chromium);
        browsers.push(b);
        return openBridgePage(b, baseUrl, `C${chunk.index}-W${s.workerId}`);
      })
    );

    renderStartMs = Date.now();
    lastLogMs = renderStartMs;

    const introLastUrl = plan.hasIntroLastImg ? `${baseUrl}/__cloud__/intro-last.jpg` : null;

    await Promise.all(
      subSlices.map((s, idx) =>
        pages[idx].evaluate(
          async (cfg) => {
            if (!window.__VIDEOCOMICS_CLOUD_RENDER_SLICE__) {
              throw new Error('Puente de renderizado por segmentos no disponible.');
            }
            return window.__VIDEOCOMICS_CLOUD_RENDER_SLICE__(cfg);
          },
          {
            workerId: s.workerId,
            projectUrl: `${baseUrl}/__cloud__/project.videocomics`,
            projectFilename: path.basename(args.input),
            fps: plan.fps,
            startFrame: s.startFrame,
            endFrame: s.endFrame,
            introDuration: plan.introDuration,
            introTransitionDuration: plan.introTransitionDuration,
            introTotalEnd: plan.introTotalEnd,
            introFitMode: plan.introFitMode || 'contain',
            introLastImageUrl: introLastUrl,
            webcodecsConfig: plan.webcodecsConfig ?? null,
          }
        )
      )
    );

    logProgressIfNeeded(true);

    if (internalWorkers > 1) {
      const subConcatPath = path.join(subTempDir, 'sub_concat.txt');
      const lines = subSlices.map((s) => {
        const p = path.join(subTempDir, `sub_${s.workerId}.mp4`).replace(/'/g, "'\\''");
        return `file '${p}'`;
      });
      fs.writeFileSync(subConcatPath, lines.join('\n') + '\n', 'utf8');

      await runFfmpegOnce([
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        subConcatPath,
        '-c:v',
        'copy',
        chunkOutputPath,
      ]);
    }

    const wallSec = (Date.now() - renderStartMs) / 1000;
    const stat = fs.statSync(chunkOutputPath);
    console.log(
      `[VIDEOCOMICS] Fragmento ${chunk.index + 1}/${plan.chunks.length} terminado (${(stat.size / (1024 * 1024)).toFixed(1)} MB) en ${formatDuration(wallSec)} (${(totalChunkFrames / Math.max(0.1, wallSec)).toFixed(1)} fps).`
    );
  } finally {
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
    for (const w of workers.values()) {
      if (w.proc && !w.proc.killed) {
        try {
          w.proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(subTempDir, { recursive: true, force: true });
  }
}

async function runAssemble(args) {
  const workDir = args.workDir || path.dirname(args.plan || '.');
  fs.mkdirSync(workDir, { recursive: true });

  const findFileFallback = (primaryPath, filename) => {
    if (primaryPath && fs.existsSync(primaryPath)) return primaryPath;
    const candidates = [
      path.join(workDir, filename),
      path.join(process.cwd(), 'cloud_prep', filename),
      path.join(process.cwd(), filename),
      path.join(workDir, 'cloud_prep', filename),
      path.join(process.cwd(), 'cloud_parts', filename),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) return cand;
    }
    return primaryPath;
  };

  const planPath = findFileFallback(args.plan || path.join(workDir, 'plan.json'), 'plan.json');
  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan no encontrado para ensamblar: ${planPath}`);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const outputPath =
    args.output ||
    path.resolve(`${plan.inputFilename.replace(/\.videocomics$/i, '')}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const parts = [];
  if (plan.hasIntroVideoPart) {
    const introPart = findFileFallback(path.join(workDir, 'part_intro.mp4'), 'part_intro.mp4');
    if (!fs.existsSync(introPart)) {
      throw new Error(`Falta segmento de intro: ${introPart}`);
    }
    parts.push(introPart);
  }

  for (const c of plan.chunks) {
    const chunkName = `part_chunk_${c.index}.mp4`;
    const chunkPart = findFileFallback(path.join(workDir, chunkName), chunkName);
    if (!fs.existsSync(chunkPart)) {
      throw new Error(`Falta fragmento #${c.index}: ${chunkPart}`);
    }
    parts.push(chunkPart);
  }

  if (parts.length === 0) {
    throw new Error('No hay fragmentos de vídeo para ensamblar.');
  }

  const concatListPath = path.join(workDir, 'final_concat.txt');
  fs.writeFileSync(
    concatListPath,
    parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    'utf8'
  );

  const audioM4aPath = findFileFallback(path.join(workDir, 'audio.m4a'), 'audio.m4a');
  const hasAudio = Boolean(plan.hasAudioFile && fs.existsSync(audioM4aPath));

  const t0 = Date.now();
  const ffArgs = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
  ];

  if (hasAudio) {
    ffArgs.push('-i', audioM4aPath);
  }

  ffArgs.push('-map', '0:v:0', '-c:v', 'copy');
  if (hasAudio) {
    ffArgs.push('-map', '1:a:0', '-c:a', 'copy', '-shortest');
  }
  ffArgs.push('-movflags', '+faststart', outputPath);

  console.log(
    `[VIDEOCOMICS] Ensamblando ${parts.length} segmentos + audio=${hasAudio ? 'AAC 192k' : 'no'} sin recodificar...`
  );
  await runFfmpegOnce(ffArgs);

  const assembleSec = (Date.now() - t0) / 1000;
  const outStat = fs.statSync(outputPath);
  const totalElapsedSec = plan.preparedAtIso
    ? Math.max(assembleSec, (Date.now() - new Date(plan.preparedAtIso).getTime()) / 1000)
    : assembleSec;

  const summary = {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    totalFrames: plan.totalFrames,
    totalDuration: plan.totalDuration,
    hasAudio,
    aspectRatio: plan.aspectRatio,
    panelCount: plan.panelCount,
    chunks: plan.chunks.length,
    introFrameCount: plan.introFrameCount,
    engine: plan.webcodecsConfig ? `WebCodecs (${plan.webcodecsConfig.codec})` : `FFmpeg (${plan.preset})`,
    inputFilename: plan.inputFilename,
    outputFilename: path.basename(outputPath),
    outputPath,
    fileSizeBytes: outStat.size,
    fileSizeMB: Number((outStat.size / (1024 * 1024)).toFixed(2)),
    renderWallSeconds: Number(totalElapsedSec.toFixed(1)),
    preset: plan.preset,
    crf: plan.crf,
  };

  if (args.summaryJson) {
    fs.writeFileSync(args.summaryJson, JSON.stringify(summary, null, 2), 'utf8');
  }

  console.log(
    `[VIDEOCOMICS] Vídeo ensamblado en ${assembleSec.toFixed(1)}s: ${summary.outputFilename} (${summary.fileSizeMB} MB · total ${formatDuration(totalElapsedSec)}).`
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.mode === 'prepare') {
    await runPrepare(args);
    return;
  }
  if (args.mode === 'chunk') {
    await runChunk(args);
    return;
  }
  if (args.mode === 'assemble') {
    await runAssemble(args);
    return;
  }

  const tempWork = args.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'videocomics-all-'));
  try {
    const planPath = path.join(tempWork, 'plan.json');
    const plan = await runPrepare({ ...args, workDir: tempWork, plan: planPath, chunks: 1 });
    for (const c of plan.chunks) {
      await runChunk({ ...args, workDir: tempWork, plan: planPath, chunkIndex: c.index, output: '' });
    }
    await runAssemble({ ...args, workDir: tempWork, plan: planPath });
  } finally {
    if (!args.workDir) {
      fs.rmSync(tempWork, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('[VIDEOCOMICS] Fallo en renderizado en la nube:', err);
  process.exit(1);
});
