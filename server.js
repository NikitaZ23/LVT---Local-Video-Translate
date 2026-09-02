import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

loadDotEnv(path.join(__dirname, '.env'));

const TELEGRAM_CONFIG_PATH = path.join(__dirname, 'telegram.config.json');
const FILE_TELEGRAM_CONFIG = loadTelegramConfig(TELEGRAM_CONFIG_PATH);
const PORT = Number(process.env.PORT || 5190);
const DEFAULT_WORK_DIR = process.env.LVT_WORK_DIR || path.join(__dirname, 'work');
const DEFAULT_FFMPEG_PATH = process.env.LVT_FFMPEG || 'E:\\AI\\Tools\\ffmpeg-release-essentials\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe';
const DEFAULT_FFPROBE_PATH = process.env.LVT_FFPROBE || defaultFfprobePath(DEFAULT_FFMPEG_PATH);
const DEFAULT_WHISPER_CPU_CLI_PATH = process.env.LVT_WHISPER_CPU_CMD || process.env.LVT_WHISPER_CMD || 'E:\\AI\\Tools\\whisper-bin-x64\\whisper-cli.exe';
const DEFAULT_WHISPER_GPU_CLI_PATH = process.env.LVT_WHISPER_GPU_CMD || 'E:\\AI\\Tools\\whisper-cublas-12.4.0-bin-x64\\Release\\whisper-cli.exe';
const DEFAULT_MODEL_PATH = process.env.LVT_WHISPER_MODEL || 'E:\\AI\\Models\\ggml-large-v3-turbo.bin';
const DEFAULT_PYTHON_PATH = process.env.LVT_PYTHON || path.join(__dirname, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
const DEFAULT_TTS_MODEL_PATH = process.env.LVT_TTS_MODEL || 'E:\\AI\\Models\\Silero\\v5_5_ru.pt';
const TRANSLATED_OUTPUT_DIR_NAME = 'Перевод';
const JSON_LIMIT_BYTES = 1024 * 1024;
const jobs = new Map();
const activeFileStreams = new Set();
const telegramBotState = {
  status: 'not_started',
  username: '',
  error: '',
  lastChatId: '',
  polling: false,
  lastUpdateId: 0,
};
let isShuttingDown = false;

mkdirSync(DEFAULT_WORK_DIR, { recursive: true });

const videoExtensions = new Set([
  '.3g2',
  '.3gp',
  '.avi',
  '.flv',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.ts',
  '.webm',
  '.wmv',
]);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.srt', 'text/plain; charset=utf-8'],
  ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.wmv', 'video/x-ms-wmv'],
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: {
        message: error.message || 'Unexpected server error',
        details: error.details || null,
      },
    });
  }
});

server.listen(PORT, () => {
  console.log(`LVT is running at http://localhost:${PORT}`);
  void startTelegramBot();
});

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      port: PORT,
      defaultWorkDir: DEFAULT_WORK_DIR,
      whisperDevice: process.env.LVT_WHISPER_DEVICE === 'cpu' ? 'cpu' : 'gpu',
      tools: {
        ffmpeg: DEFAULT_FFMPEG_PATH,
        ffprobe: DEFAULT_FFPROBE_PATH,
        whisperCommand: process.env.LVT_WHISPER_DEVICE === 'cpu' ? DEFAULT_WHISPER_CPU_CLI_PATH : DEFAULT_WHISPER_GPU_CLI_PATH,
        whisperCpuCommand: DEFAULT_WHISPER_CPU_CLI_PATH,
        whisperGpuCommand: DEFAULT_WHISPER_GPU_CLI_PATH,
        whisperModel: DEFAULT_MODEL_PATH,
        ttsModel: DEFAULT_TTS_MODEL_PATH,
        python: DEFAULT_PYTHON_PATH,
      },
      telegram: publicTelegramConfig(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: listJobs() });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const job = getJobFromPath(url.pathname);
    sendJson(res, 200, serializeJob(job));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/media') {
    await serveLocalFile(req, res, url, { allowRange: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/subtitles') {
    await serveLocalFile(req, res, url, { allowRange: false, forceType: 'text/vtt; charset=utf-8' });
    return;
  }

  if (req.method !== 'POST') {
    throw httpError(405, 'Method not allowed');
  }

  const body = await readJson(req);

  if (url.pathname === '/api/check-tools') {
    const result = await checkTools(normalizeSettings(body));
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/shutdown') {
    sendJson(res, 200, { ok: true, message: 'LVT выключается.' });
    scheduleShutdown();
    return;
  }

  if (url.pathname === '/api/pick-file') {
    const result = await pickLocalPath('file', body.initialPath);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/pick-folder') {
    const result = await pickLocalPath('folder', body.initialPath);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/scan') {
    const result = await scanSource(body);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === '/api/jobs') {
    const job = await createJob(body);
    sendJson(res, 202, serializeJob(job));
    return;
  }

  if (url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/cancel')) {
    const job = getJobFromPath(url.pathname.replace(/\/cancel$/, ''));
    job.cancelAfterCurrent = true;
    job.updatedAt = new Date().toISOString();
    sendJson(res, 200, serializeJob(job));
    return;
  }

  if (url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/stop')) {
    const job = getJobFromPath(url.pathname.replace(/\/stop$/, ''));
    stopJobNow(job);
    sendJson(res, 200, serializeJob(job));
    return;
  }

  throw httpError(404, 'API route not found');
}

async function checkTools(settings) {
  const checks = [];

  checks.push(await checkExecutable('FFmpeg', settings.tools.ffmpeg, ['-version']));
  checks.push(await checkExecutable('FFprobe', settings.tools.ffprobe, ['-version']));
  checks.push(await checkWhisperCli(settings));
  checks.push(checkFile('Whisper model', settings.tools.whisperModel));

  if (settings.translationMode === 'argos') {
    checks.push(await checkExecutable('Python', settings.tools.python, ['--version']));
    checks.push(await checkArgosTranslate(settings.tools.python, settings.sourceLang, settings.targetLang));
  }

  if (settings.voiceoverMode === 'silero') {
    checks.push(checkFile('Silero TTS model', settings.tools.ttsModel));
    checks.push(await checkSileroTts(settings));
  }

  if (settings.telegram.enabled) {
    checks.push(checkTelegramSettings(settings.telegram));
  }

  return { checks };
}

function checkTelegramSettings(telegram) {
  if (!telegram.botToken || !telegram.chatId) {
    return {
      name: 'Telegram',
      ok: false,
      message: 'Укажите Bot Token и Chat ID.',
    };
  }

  return {
    name: 'Telegram',
    ok: true,
    message: 'Настройки заполнены. Уведомление будет отправлено после завершения задания.',
  };
}

async function checkWhisperCli(settings) {
  const name = settings.whisperDevice === 'gpu' ? 'Whisper CLI (GPU)' : 'Whisper CLI (CPU)';
  if (!settings.tools.whisperCommand) {
    return { name, ok: false, message: 'Команда не указана.' };
  }

  if (looksLikePath(settings.tools.whisperCommand) && !existsSync(normalizeInputPath(settings.tools.whisperCommand))) {
    return { name, ok: false, message: missingExecutableMessage(name, settings.tools.whisperCommand) };
  }

  try {
    const output = await runProbe(settings.tools.whisperCommand, ['--version'], 10000);
    if (settings.whisperDevice === 'gpu' && !/cuda|cublas|ggml-cuda/i.test(output)) {
      return {
        name,
        ok: false,
        message: 'CLI запустился, но CUDA backend не найден. Нужна cublas/CUDA-сборка whisper.cpp.',
      };
    }

    return {
      name,
      ok: true,
      message: settings.whisperDevice === 'gpu' ? 'Найден CUDA backend.' : 'Найдено.',
    };
  } catch (error) {
    return { name, ok: false, message: error.message };
  }
}

async function pickLocalPath(kind, initialPath = '') {
  if (process.platform !== 'win32') {
    throw httpError(501, 'Системный выбор файла сейчас поддерживается только на Windows.');
  }

  const initialDirectory = await resolvePickerInitialDirectory(initialPath);
  const selectedPath = await runPowerShellPicker(kind === 'folder' ? folderPickerScript(initialDirectory) : filePickerScript(initialDirectory));
  if (!selectedPath) {
    return { path: '' };
  }

  const resolved = await resolveExistingInputPath(selectedPath);
  if (!resolved.stat) {
    throw httpError(404, `Путь не найден: ${selectedPath}`);
  }

  if (kind === 'file') {
    if (!resolved.stat.isFile()) {
      throw httpError(400, 'Выбранный путь не является файлом.');
    }
    if (!isVideoPath(resolved.path)) {
      throw httpError(400, 'Выбранный файл не похож на видео.');
    }
  } else if (!resolved.stat.isDirectory()) {
    throw httpError(400, 'Выбранный путь не является папкой.');
  }

  return {
    path: resolved.path,
    correctedPath: resolved.corrected ? resolved.path : '',
  };
}

async function resolvePickerInitialDirectory(inputPath) {
  const normalized = normalizeInputPath(inputPath);
  if (!normalized) return '';

  const resolved = await resolveExistingInputPath(normalized);
  if (!resolved.stat) return '';
  if (resolved.stat.isDirectory()) return resolved.path;
  if (resolved.stat.isFile()) return path.dirname(resolved.path);
  return '';
}

function runPowerShellPicker(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { windowsHide: false });

    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Окно выбора было открыто слишком долго.'));
    }, 10 * 60 * 1000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? 'PowerShell не найден.' : error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Окно выбора завершилось с кодом ${code}.`));
        return;
      }

      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
  });
}

function filePickerScript(initialDirectory = '') {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Write-Utf8([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
}
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Выберите видеофайл'
$dialog.Filter = 'Видео файлы|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.wmv;*.m4v;*.mpeg;*.mpg;*.mts;*.m2ts;*.ts;*.flv;*.3gp;*.3g2|Все файлы|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.AutoUpgradeEnabled = $true
$dialog.RestoreDirectory = $true
$initialDirectory = ${powerShellString(initialDirectory)}
if ($initialDirectory -and [System.IO.Directory]::Exists($initialDirectory)) {
  $dialog.InitialDirectory = $initialDirectory
}
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Utf8 $dialog.FileName
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;
}

function folderPickerScript(initialDirectory = '') {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Write-Utf8([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
}
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Откройте папку с видео и нажмите Открыть'
$dialog.Filter = 'Все элементы|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.ValidateNames = $false
$dialog.AutoUpgradeEnabled = $true
$dialog.RestoreDirectory = $true
$dialog.FileName = 'Выберите эту папку'
$initialDirectory = ${powerShellString(initialDirectory)}
if ($initialDirectory -and [System.IO.Directory]::Exists($initialDirectory)) {
  $dialog.InitialDirectory = $initialDirectory
}
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $selectedPath = $dialog.FileName
    if ([System.IO.Directory]::Exists($selectedPath)) {
      Write-Utf8 $selectedPath
    } else {
      Write-Utf8 ([System.IO.Path]::GetDirectoryName($selectedPath))
    }
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;
}

function powerShellString(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

async function checkExecutable(name, command, args) {
  if (!command) {
    return { name, ok: false, message: 'Команда не указана.' };
  }

  if (looksLikePath(command) && !existsSync(normalizeInputPath(command))) {
    return { name, ok: false, message: missingExecutableMessage(name, command) };
  }

  try {
    await runProbe(command, args, 5000);
    return { name, ok: true, message: 'Найдено.' };
  } catch (error) {
    return { name, ok: false, message: error.message };
  }
}

function missingExecutableMessage(name, command) {
  const normalized = normalizeInputPath(command);
  if (name === 'FFmpeg' && normalized.includes('E:\\AI\\Tools\\ffmpeg-9.0.1')) {
    return 'ffmpeg.exe не найден. В E:\\AI\\Tools\\ffmpeg-9.0.1 сейчас исходники FFmpeg; нужен Windows build с bin\\ffmpeg.exe.';
  }

  return `Файл не найден: ${normalized}`;
}

function checkFile(name, filePath) {
  if (!filePath) {
    return { name, ok: false, message: 'Путь к модели не указан.' };
  }

  const normalized = normalizeInputPath(filePath);
  return existsSync(normalized)
    ? { name, ok: true, message: normalized }
    : { name, ok: false, message: `Файл не найден: ${normalized}` };
}

async function checkArgosTranslate(pythonCommand, sourceLang, targetLang) {
  const source = normalizeArgosLang(sourceLang);
  const target = normalizeArgosLang(targetLang);
  const probe = [
    'from argostranslate import package',
    `source = ${JSON.stringify(source)}`,
    `target = ${JSON.stringify(target)}`,
    'installed = [(pkg.from_code, pkg.to_code) for pkg in package.get_installed_packages()]',
    'if (source, target) not in installed:',
    '    raise SystemExit(f"Не установлен языковой пакет {source}->{target}.")',
    'print("ok")',
  ].join('\n');

  try {
    await runProbe(pythonCommand, ['-c', probe], 10000);
    return { name: 'Argos Translate', ok: true, message: `Языковой пакет ${source}->${target} найден.` };
  } catch (error) {
    return {
      name: 'Argos Translate',
      ok: false,
      message: `Не готов к переводу. Установите argostranslate и языковой пакет ${source}->${target} или выберите режим "без перевода". ${error.message}`,
    };
  }
}

async function checkSileroTts(settings) {
  if (settings.targetLang !== 'ru') {
    return {
      name: 'Silero TTS',
      ok: false,
      message: 'Сейчас подключена русская модель Silero. Для озвучки выберите язык субтитров "Русский".',
    };
  }

  if (settings.translationMode === 'none' && settings.sourceLang !== 'ru') {
    return {
      name: 'Silero TTS',
      ok: false,
      message: 'Для русской озвучки включите Argos Translate или выберите русский язык оригинала.',
    };
  }

  const probe = [
    'import torch',
    'import numpy',
    'print("ok")',
  ].join('\n');

  try {
    await runProbe(settings.tools.python, ['-c', probe], 10000);
    return { name: 'Silero TTS', ok: true, message: `Python, Torch и голос ${settings.ttsSpeaker} готовы.` };
  } catch (error) {
    return {
      name: 'Silero TTS',
      ok: false,
      message: `Не готово окружение Silero TTS. ${error.message}`,
    };
  }
}

function runProbe(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Проверка заняла слишком много времени.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? `Команда не найдена: ${command}` : error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(output);
        return;
      }

      reject(new Error(`${path.basename(command)} завершился с кодом ${code}. ${output.trim()}`.trim()));
    });
  });
}

function listJobs() {
  return [...jobs.values()]
    .sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt))
    .map(serializeJob);
}

function stopJobNow(job) {
  job.cancelAfterCurrent = true;

  if (job.currentProcess && !job.currentProcess.killed) {
    job.currentProcess.kill();
    addJobLog(job, 'Текущий процесс остановлен вручную.');
  } else {
    addJobLog(job, 'Активного процесса для немедленной остановки нет.');
  }

  touchJob(job);
}

function scheduleShutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  telegramBotState.polling = false;
  closeTrackedFileStreams([...activeFileStreams]);
  stopJobsForShutdown();

  setTimeout(async () => {
    await cleanupWorkJobs();

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(0);
    }, 1500).unref();
  }, 250).unref();
}

async function cleanupWorkJobs() {
  const jobsDir = path.join(DEFAULT_WORK_DIR, 'jobs');

  try {
    await rm(jobsDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
    console.log(`Cleaned temporary jobs folder: ${jobsDir}`);
  } catch (error) {
    console.log(`Could not clean temporary jobs folder ${jobsDir}: ${error.message}`);
  }
}

function stopJobsForShutdown() {
  for (const job of jobs.values()) {
    const activeItems = job.items.filter((item) => !['ready', 'error', 'cancelled'].includes(item.status));
    if (!activeItems.length && !job.currentProcess) {
      continue;
    }

    job.cancelAfterCurrent = true;
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();

    for (const item of activeItems) {
      item.status = 'cancelled';
      item.detail = 'Проект выключен';
    }

    if (job.currentProcess && !job.currentProcess.killed) {
      job.currentProcess.kill();
    }

    updateJobProgress(job);
    addJobLog(job, 'Проект выключается. Активное задание остановлено.');
    touchJob(job);
  }
}

async function scanSource(body) {
  const mode = body.mode === 'folder' ? 'folder' : 'single';
  const settings = normalizeSettings(body.settings || {});
  const requestedSourcePath = normalizeInputPath(body.sourcePath || '');
  const namingMode = normalizeNamingMode(body.namingMode);
  const recursive = body.recursive !== false;

  if (!requestedSourcePath) {
    throw httpError(400, 'Укажите путь к файлу или папке.');
  }

  const resolvedSource = await resolveExistingInputPath(requestedSourcePath);
  const sourcePath = resolvedSource.path;
  const sourceStat = resolvedSource.stat;
  const playlistTitle = normalizeTitle(body.playlistTitle || path.basename(sourcePath) || 'Плейлист');

  if (!sourceStat) {
    throw httpError(404, `Путь не найден: ${requestedSourcePath}`);
  }

  if (mode === 'single') {
    if (!sourceStat.isFile()) {
      throw httpError(400, 'В режиме одного файла нужен путь к видеофайлу.');
    }
    if (!isVideoPath(sourcePath)) {
      throw httpError(400, 'Выбранный файл не похож на видео.');
    }

    const durationSeconds = await probeVideoDurationSeconds(settings.tools.ffprobe, sourcePath);
    const item = createScanItem(sourcePath, sourcePath, 0, playlistTitle, 'original', sourceStat.size, durationSeconds);
    sendPathInfo(item);
    return {
      mode,
      rootPath: sourcePath,
      playlistTitle,
      correctedPath: resolvedSource.corrected ? sourcePath : '',
      items: [item],
    };
  }

  if (!sourceStat.isDirectory()) {
    throw httpError(400, 'В режиме папки нужен путь к папке.');
  }

  const files = await collectVideoFiles(sourcePath, recursive);
  const items = [];
  for (const [index, file] of files.entries()) {
    const durationSeconds = await probeVideoDurationSeconds(settings.tools.ffprobe, file.path);
    items.push(createScanItem(file.path, sourcePath, index, playlistTitle, namingMode, file.size, durationSeconds));
  }
  applyTitleUniqueness(items, namingMode);

  return {
    mode,
    rootPath: sourcePath,
    playlistTitle,
    recursive,
    correctedPath: resolvedSource.corrected ? sourcePath : '',
    items,
  };
}

async function resolveExistingInputPath(inputPath) {
  const normalized = normalizeInputPath(inputPath);
  const existingStat = await safeStat(normalized);
  if (existingStat) {
    return { path: normalized, stat: existingStat, corrected: false };
  }

  const repaired = await repairMissingSeparatorPath(normalized);
  if (!repaired) {
    return { path: normalized, stat: null, corrected: false };
  }

  const repairedStat = await safeStat(repaired);
  return repairedStat
    ? { path: repaired, stat: repairedStat, corrected: true }
    : { path: normalized, stat: null, corrected: false };
}

async function repairMissingSeparatorPath(inputPath) {
  const parsed = path.parse(inputPath);
  if (!parsed.dir || !parsed.base) return '';

  const parentStat = await safeStat(parsed.dir);
  if (!parentStat?.isDirectory()) return '';

  let entries = [];
  try {
    entries = await readdir(parsed.dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const baseLower = parsed.base.toLocaleLowerCase();
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((first, second) => second.name.length - first.name.length);

  for (const entry of directories) {
    if (!baseLower.startsWith(entry.name.toLocaleLowerCase())) continue;

    const remainder = parsed.base.slice(entry.name.length);
    if (!remainder || /^[\\/]/.test(remainder)) continue;

    const candidate = path.join(parsed.dir, entry.name, remainder);
    const candidateStat = await safeStat(candidate);
    if (candidateStat) {
      return candidate;
    }
  }

  return '';
}

async function probeVideoDurationSeconds(ffprobeCommand, filePath) {
  if (!ffprobeCommand) {
    return null;
  }

  try {
    const output = await runProbe(ffprobeCommand, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      filePath,
    ], 15000);
    const payload = parseJsonFromOutput(output);
    const duration = Number(payload?.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

async function probeHasAudioStream(ffprobeCommand, filePath) {
  if (!ffprobeCommand) {
    return null;
  }

  try {
    const output = await runProbe(ffprobeCommand, [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'json',
      filePath,
    ], 15000);
    const payload = parseJsonFromOutput(output);
    return Array.isArray(payload?.streams) && payload.streams.some((stream) => stream.codec_type === 'audio');
  } catch {
    return null;
  }
}

function parseJsonFromOutput(output) {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function createScanItem(filePath, rootPath, index, playlistTitle, namingMode, size, durationSeconds = null) {
  const relativePath = rootPath === filePath ? path.basename(filePath) : path.relative(rootPath, filePath);
  const originalName = path.basename(filePath);
  const originalTitle = stripExtension(originalName);
  const parentFolder = path.basename(path.dirname(filePath));
  const title = buildTitle({ originalTitle, parentFolder, playlistTitle, namingMode });

  return {
    id: randomUUID(),
    index,
    path: filePath,
    relativePath,
    originalName,
    originalTitle,
    parentFolder,
    title,
    size,
    durationSeconds,
  };
}

function sendPathInfo(item) {
  item.relativePath = item.originalName;
  item.title = item.originalTitle;
}

function buildTitle({ originalTitle, parentFolder, playlistTitle, namingMode }) {
  if (namingMode === 'playlist') {
    return normalizeTitle(`${playlistTitle}_${originalTitle}`);
  }

  if (namingMode === 'parent') {
    return normalizeTitle(`${parentFolder}_${originalTitle}`);
  }

  return normalizeTitle(originalTitle);
}

function applyTitleUniqueness(items, namingMode) {
  if (namingMode === 'original') return;

  const seen = new Map();
  for (const item of items) {
    const key = item.title.toLocaleLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > 1) {
      item.title = withSuffix(item.title, count);
    }
  }
}

async function collectVideoFiles(rootPath, recursive) {
  const found = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && entry.name !== TRANSLATED_OUTPUT_DIR_NAME) {
          await walk(entryPath);
        }
        continue;
      }

      if (entry.isFile() && isVideoPath(entryPath)) {
        const fileStat = await stat(entryPath);
        found.push({ path: entryPath, size: fileStat.size });
      }
    }
  }

  await walk(rootPath);
  found.sort((first, second) => first.path.localeCompare(second.path, undefined, { numeric: true, sensitivity: 'base' }));
  return found;
}

async function createJob(body) {
  const settings = normalizeSettings(body.settings || {});
  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (!rawItems.length) {
    throw httpError(400, 'Нет видео для обработки.');
  }

  await mkdir(settings.workDir, { recursive: true });

  const job = {
    id: randomUUID(),
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: '',
    completedAt: '',
    cancelAfterCurrent: false,
    currentProcess: null,
    settings,
    items: rawItems.map((item, index) => ({
      id: item.id || randomUUID(),
      index,
      path: normalizeInputPath(item.path),
      title: normalizeTitle(item.title || stripExtension(path.basename(item.path || 'video'))),
      relativePath: item.relativePath || path.basename(item.path || ''),
      size: Number(item.size || 0),
      durationSeconds: normalizeDurationSeconds(item.durationSeconds),
      retryCount: Number(item.retryCount || 0),
      status: 'queued',
      progress: 0,
      detail: 'В очереди',
      subtitlePath: '',
      voicePath: '',
      voiceoverVideoPath: '',
      error: '',
      retryable: true,
    })),
    logs: [],
  };

  jobs.set(job.id, job);
  runJob(job).catch(async (error) => {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    addJobLog(job, `Ошибка задания: ${error.message}`);
    const summary = addJobSummaryLog(job);
    releaseTranslatedOutputHandles(job);
    await sendTelegramJobNotification(job, summary);
    touchJob(job);
  });

  return job;
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  touchJob(job);
  addJobLog(job, 'Задание запущено.');

  await processJobItems(job, job.items);
  await retryFailedItemsAfterBatch(job);

  const hasError = job.items.some((item) => item.status === 'error');
  const hasReady = job.items.some((item) => item.status === 'ready');
  const hasQueued = job.items.some((item) => item.status === 'queued');

  if (job.cancelAfterCurrent && hasQueued) {
    job.status = hasReady ? 'cancelled' : 'failed';
    for (const item of job.items.filter((entry) => entry.status === 'queued')) {
      item.status = 'cancelled';
      item.detail = 'Отменено';
    }
  } else if (hasError && !job.settings.continueOnError) {
    job.status = 'failed';
  } else {
    job.status = 'complete';
  }

  job.completedAt = new Date().toISOString();
  updateJobProgress(job);
  touchJob(job);
  addJobLog(job, `Задание завершено со статусом ${job.status}.`);
  const summary = addJobSummaryLog(job);
  releaseTranslatedOutputHandles(job);
  await sendTelegramJobNotification(job, summary);
}

async function processJobItems(job, items) {
  for (const item of items) {
    if (job.cancelAfterCurrent) break;

    try {
      await processItem(job, item);
    } catch (error) {
      item.status = job.cancelAfterCurrent ? 'cancelled' : 'error';
      item.error = error.message;
      item.detail = error.message;
      item.retryable = error.retryable !== false;
      addJobLog(job, `${item.title}: ${error.message}`);
      touchJob(job);

      if (!shouldContinueAfterItemError(job)) {
        break;
      }
    }
  }
}

async function retryFailedItemsAfterBatch(job) {
  if (!job.settings.retryFailedAfterBatch || job.cancelAfterCurrent) {
    return;
  }

  const failedItems = job.items.filter((item) => item.status === 'error' && item.retryable !== false);
  if (!failedItems.length) {
    return;
  }

  addJobLog(job, `Повторный запуск файлов с ошибкой: ${failedItems.length}.`);

  for (const item of failedItems) {
    resetItemForRetry(item);
  }

  updateJobProgress(job);
  touchJob(job);
  await processJobItems(job, failedItems);
}

function resetItemForRetry(item) {
  item.retryCount = Number(item.retryCount || 0) + 1;
  item.status = 'queued';
  item.progress = 0;
  item.detail = `Повторная попытка ${item.retryCount}`;
  item.error = '';
  item.retryable = true;
  item.subtitlePath = '';
  item.voicePath = '';
  item.voiceoverVideoPath = '';
}

function shouldContinueAfterItemError(job) {
  return job.settings.continueOnError || job.settings.retryFailedAfterBatch;
}

async function processItem(job, item) {
  const sourceStat = await safeStat(item.path);
  if (!sourceStat?.isFile()) {
    throw new Error(`Файл не найден: ${item.path}`);
  }
  item.size = sourceStat.size;
  item.durationSeconds = item.durationSeconds || await probeVideoDurationSeconds(job.settings.tools.ffprobe, item.path);
  const hasAudioStream = await probeHasAudioStream(job.settings.tools.ffprobe, item.path);
  if (hasAudioStream === false) {
    throw nonRetryableItemError('В видео нет аудиодорожки, поэтому распознавать речь нечего. Файл пропущен.');
  }

  const jobDir = path.join(job.settings.workDir, 'jobs', job.id, String(item.index + 1).padStart(3, '0'));
  await mkdir(jobDir, { recursive: true });

  const audioPath = path.join(jobDir, 'audio.wav');
  const whisperBase = path.join(jobDir, 'whisper');
  const originalVtt = `${whisperBase}.vtt`;
  const originalSrt = `${whisperBase}.srt`;
  const finalVtt = outputSubtitlePath(job, item);

  setItemStatus(job, item, 'extracting', 8, 'Извлечение аудио');
  await runCommand(job, job.settings.tools.ffmpeg, [
    '-y',
    '-i',
    item.path,
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    audioPath,
  ]);

  const deviceLabel = job.settings.whisperDevice === 'gpu' ? 'GPU' : 'CPU';
  const whisperArgs = [
    '-m',
    job.settings.tools.whisperModel,
    '-f',
    audioPath,
    '-l',
    job.settings.sourceLang,
    '-ovtt',
    '-osrt',
    '-of',
    whisperBase,
  ];

  if (job.settings.whisperDevice === 'cpu') {
    whisperArgs.push('--no-gpu');
  }

  setItemStatus(job, item, 'transcribing', 35, `Распознавание речи (${deviceLabel})`);
  await runCommand(job, job.settings.tools.whisperCommand, whisperArgs);

  let transcriptVtt = originalVtt;
  if (!existsSync(transcriptVtt) && existsSync(originalSrt)) {
    transcriptVtt = path.join(jobDir, 'whisper.from-srt.vtt');
    await convertSrtToVtt(originalSrt, transcriptVtt);
  }

  if (!existsSync(transcriptVtt)) {
    throw new Error('Whisper не создал .vtt или .srt файл субтитров.');
  }

  await mkdir(path.dirname(finalVtt), { recursive: true });

  if (job.settings.translationMode === 'none') {
    setItemStatus(job, item, 'translating', 78, 'Копирование субтитров без перевода');
    await copyFile(transcriptVtt, finalVtt);
  } else {
    setItemStatus(job, item, 'translating', 78, 'Перевод субтитров');
    await runCommand(job, job.settings.tools.python, [
      path.join(__dirname, 'scripts', 'translate_subtitles.py'),
      '--input',
      transcriptVtt,
      '--output',
      finalVtt,
      '--source',
      normalizeArgosLang(job.settings.sourceLang),
      '--target',
      normalizeArgosLang(job.settings.targetLang),
    ]);
  }

  item.subtitlePath = finalVtt;
  if (job.settings.voiceoverMode === 'silero') {
    if (job.settings.targetLang !== 'ru') {
      throw new Error('Silero TTS v5_5_ru может озвучивать только русский текст.');
    }

    const voicePath = outputVoicePath(job, item);
    const voiceoverVideoPath = outputVoiceoverVideoPath(job, item);

    setItemStatus(job, item, 'voicing', 88, `Озвучка Silero (${job.settings.ttsSpeaker})`);
    await runCommand(job, job.settings.tools.python, [
      path.join(__dirname, 'scripts', 'silero_voiceover.py'),
      '--input',
      finalVtt,
      '--output',
      voicePath,
      '--model',
      job.settings.tools.ttsModel,
      '--speaker',
      job.settings.ttsSpeaker,
      '--sample-rate',
      String(job.settings.ttsSampleRate),
      '--device',
      job.settings.ttsDevice,
    ]);
    item.voicePath = voicePath;

    setItemStatus(job, item, 'mixing', 95, 'Сборка видео с озвучкой');
    await buildVoiceoverVideo(job, item, voicePath, voiceoverVideoPath);
    item.voiceoverVideoPath = voiceoverVideoPath;
  }

  item.status = 'ready';
  item.progress = 100;
  item.detail = 'Готово';
  addJobLog(job, `${item.title}: ${item.voiceoverVideoPath ? 'озвученное видео готово' : 'субтитры готовы'}. ${formatItemReadyMeta(item)}.`);
  updateJobProgress(job);
  touchJob(job);
}

async function buildVoiceoverVideo(job, item, voicePath, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });

  if (job.settings.audioMixMode === 'replace') {
    await runCommand(job, job.settings.tools.ffmpeg, voiceoverReplaceArgs(item.path, voicePath, outputPath));
    return;
  }

  try {
    await runCommand(job, job.settings.tools.ffmpeg, voiceoverOverlayArgs(item.path, voicePath, outputPath));
  } catch (error) {
    addJobLog(job, `${item.title}: не удалось смешать с оригинальным звуком, пробую заменить аудио. ${error.message}`);
    await runCommand(job, job.settings.tools.ffmpeg, voiceoverReplaceArgs(item.path, voicePath, outputPath));
  }
}

function voiceoverOverlayArgs(videoPath, voicePath, outputPath) {
  return [
    '-y',
    '-i',
    videoPath,
    '-i',
    voicePath,
    '-filter_complex',
    '[0:a]volume=0.18[original];[1:a]volume=1.0[voice];[original][voice]amix=inputs=2:duration=first:dropout_transition=0[aout]',
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-map_metadata',
    '0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outputPath,
  ];
}

function voiceoverReplaceArgs(videoPath, voicePath, outputPath) {
  return [
    '-y',
    '-i',
    videoPath,
    '-i',
    voicePath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-map_metadata',
    '0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outputPath,
  ];
}

function runCommand(job, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    job.currentProcess = child;

    let output = '';
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 16000) {
        output = output.slice(-16000);
      }
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      job.currentProcess = null;
      reject(new Error(error.code === 'ENOENT' ? `Команда не найдена: ${command}` : error.message));
    });
    child.on('close', (code) => {
      job.currentProcess = null;
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${path.basename(command)} завершился с кодом ${code}. ${output.trim()}`.trim()));
      }
    });
  });
}

function outputSubtitlePath(job, item) {
  const ext = `.${job.settings.targetLang}.vtt`;

  if (job.settings.voiceoverMode === 'silero') {
    return path.join(translatedOutputDir(item), `${stripExtension(path.basename(item.path))}${ext}`);
  }

  if (job.settings.outputMode === 'sidecar') {
    return path.join(path.dirname(item.path), `${stripExtension(path.basename(item.path))}${ext}`);
  }

  const fileName = `${String(item.index + 1).padStart(3, '0')}_${sanitizeFileName(item.title)}${ext}`;
  return path.join(job.settings.workDir, 'subtitles', job.id, fileName);
}

function outputVoicePath(job, item) {
  const ext = `.${job.settings.targetLang}.voice.wav`;

  if (job.settings.voiceoverMode === 'silero') {
    return path.join(translatedOutputDir(item), `${stripExtension(path.basename(item.path))}${ext}`);
  }

  if (job.settings.outputMode === 'sidecar') {
    return path.join(path.dirname(item.path), `${stripExtension(path.basename(item.path))}${ext}`);
  }

  const fileName = `${String(item.index + 1).padStart(3, '0')}_${sanitizeFileName(item.title)}${ext}`;
  return path.join(job.settings.workDir, 'voiceover', job.id, fileName);
}

function outputVoiceoverVideoPath(job, item) {
  const ext = `.${job.settings.targetLang}.voiceover.mp4`;

  if (job.settings.voiceoverMode === 'silero') {
    return path.join(translatedOutputDir(item), `${stripExtension(path.basename(item.path))}${ext}`);
  }

  if (job.settings.outputMode === 'sidecar') {
    return path.join(path.dirname(item.path), `${stripExtension(path.basename(item.path))}${ext}`);
  }

  const fileName = `${String(item.index + 1).padStart(3, '0')}_${sanitizeFileName(item.title)}${ext}`;
  return path.join(job.settings.workDir, 'voiceover', job.id, fileName);
}

function translatedOutputDir(item) {
  return path.join(path.dirname(item.path), TRANSLATED_OUTPUT_DIR_NAME);
}

async function convertSrtToVtt(inputPath, outputPath) {
  const text = await readFile(inputPath, 'utf8');
  const converted = text
    .replace(/^\uFEFF?/, '')
    .replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
  await writeFile(outputPath, `WEBVTT\n\n${converted}`, 'utf8');
}

function normalizeSettings(raw) {
  const whisperDevice = raw.whisperDevice === 'cpu' ? 'cpu' : 'gpu';
  const whisperCpuCommand = normalizeCommand(raw.tools?.whisperCpuCommand || raw.whisperCpuCommand || DEFAULT_WHISPER_CPU_CLI_PATH);
  const whisperGpuCommand = normalizeCommand(raw.tools?.whisperGpuCommand || raw.whisperGpuCommand || DEFAULT_WHISPER_GPU_CLI_PATH);
  const whisperCommand = normalizeCommand(raw.tools?.whisperCommand || (whisperDevice === 'gpu' ? whisperGpuCommand : whisperCpuCommand));

  return {
    workDir: normalizeInputPath(raw.workDir || DEFAULT_WORK_DIR),
    whisperDevice,
    sourceLang: normalizeWhisperLang(raw.sourceLang || 'auto'),
    targetLang: normalizeArgosLang(raw.targetLang || 'ru'),
    outputMode: raw.outputMode === 'sidecar' ? 'sidecar' : 'work',
    translationMode: raw.translationMode === 'none' ? 'none' : 'argos',
    voiceoverMode: raw.voiceoverMode === 'silero' ? 'silero' : 'none',
    audioMixMode: raw.audioMixMode === 'replace' ? 'replace' : 'overlay',
    ttsSpeaker: normalizeTtsSpeaker(raw.ttsSpeaker || 'xenia'),
    ttsDevice: raw.ttsDevice === 'cuda' ? 'cuda' : 'cpu',
    ttsSampleRate: normalizeSampleRate(raw.ttsSampleRate || 48000),
    telegram: normalizeTelegramSettings(raw.telegram),
    retryFailedAfterBatch: raw.retryFailedAfterBatch === true,
    continueOnError: raw.continueOnError !== false,
    tools: {
      ffmpeg: normalizeCommand(raw.tools?.ffmpeg || DEFAULT_FFMPEG_PATH),
      ffprobe: normalizeCommand(raw.tools?.ffprobe || raw.ffprobe || DEFAULT_FFPROBE_PATH),
      whisperCommand,
      whisperCpuCommand,
      whisperGpuCommand,
      whisperModel: normalizeInputPath(raw.tools?.whisperModel || DEFAULT_MODEL_PATH),
      ttsModel: normalizeInputPath(raw.tools?.ttsModel || raw.ttsModel || DEFAULT_TTS_MODEL_PATH),
      python: normalizePythonCommand(raw.tools?.python || raw.python || DEFAULT_PYTHON_PATH),
    },
  };
}

function normalizeTelegramSettings(raw) {
  const hasRaw = raw && typeof raw === 'object';
  const fileConfig = FILE_TELEGRAM_CONFIG;

  return {
    enabled: hasRaw && Object.hasOwn(raw, 'enabled') ? raw.enabled === true : fileConfig.enabled === true,
    botToken: normalizeSecret(hasRaw && raw.botToken ? raw.botToken : fileConfig.botToken || ''),
    chatId: normalizeSecret(hasRaw && raw.chatId ? raw.chatId : fileConfig.chatId || telegramBotState.lastChatId || ''),
  };
}

function publicTelegramConfig() {
  const telegram = normalizeTelegramSettings();

  return {
    enabled: telegram.enabled,
    chatId: telegram.chatId,
    hasBotToken: Boolean(telegram.botToken),
    botStatus: telegramBotState.status,
    botUsername: telegramBotState.username,
    botError: telegramBotState.error,
  };
}

function normalizeTtsSpeaker(value) {
  const speaker = String(value || 'xenia').trim().toLowerCase();
  return ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'].includes(speaker) ? speaker : 'xenia';
}

function normalizeSampleRate(value) {
  const sampleRate = Number(value);
  return [8000, 24000, 48000].includes(sampleRate) ? sampleRate : 48000;
}

function normalizeNamingMode(value) {
  return value === 'parent' || value === 'playlist' ? value : 'original';
}

function normalizeInputPath(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function normalizeCommand(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function normalizeSecret(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function normalizePythonCommand(value) {
  const command = normalizeCommand(value);
  return /^python$/i.test(command) || /^py$/i.test(command) ? DEFAULT_PYTHON_PATH : command;
}

function normalizeWhisperLang(value) {
  const lang = String(value || 'auto').trim().toLowerCase();
  return lang || 'auto';
}

function normalizeArgosLang(value) {
  const lang = String(value || 'ru').trim().toLowerCase();
  if (lang === 'auto') return 'en';
  return lang;
}

async function serveLocalFile(req, res, url, options) {
  const requestedPath = normalizeInputPath(url.searchParams.get('path') || '');
  if (!requestedPath) {
    throw httpError(400, 'Не указан путь к файлу.');
  }

  const fileStat = await safeStat(requestedPath);
  if (!fileStat?.isFile()) {
    throw httpError(404, `Файл не найден: ${requestedPath}`);
  }

  const contentType = options.forceType || contentTypeFor(requestedPath);
  const range = options.allowRange ? req.headers.range : null;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileStat.size,
      'Accept-Ranges': options.allowRange ? 'bytes' : 'none',
      'Cache-Control': 'no-store',
    });
    pipeTrackedFile(res, requestedPath);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    throw httpError(416, 'Некорректный Range-заголовок.');
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : fileStat.size - 1;

  if (start >= fileStat.size || end >= fileStat.size || start > end) {
    throw httpError(416, 'Запрошенный диапазон вне размера файла.');
  }

  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  pipeTrackedFile(res, requestedPath, { start, end });
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw httpError(405, 'Method not allowed');
  }

  const pathname = decodeURIComponent(url.pathname);
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    throw httpError(403, 'Forbidden');
  }

  const fileStat = await safeStat(filePath);
  if (!fileStat?.isFile()) {
    throw httpError(404, 'Not found');
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  pipeTrackedFile(res, filePath);
}

function pipeTrackedFile(res, filePath, options = {}) {
  const stream = createReadStream(filePath, options);
  const handle = { filePath, stream, response: res };
  activeFileStreams.add(handle);

  const cleanup = () => {
    activeFileStreams.delete(handle);
  };

  stream.on('close', cleanup);
  stream.on('error', (error) => {
    cleanup();
    if (!res.destroyed) {
      res.destroy(error);
    }
  });
  res.on('close', () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
    cleanup();
  });

  stream.pipe(res);
}

function releaseTranslatedOutputHandles(job) {
  const outputDirs = translatedOutputDirsForJob(job);
  if (!outputDirs.length) {
    return 0;
  }

  const handles = [...activeFileStreams].filter((handle) => {
    return outputDirs.some((dirPath) => isPathInsideDir(handle.filePath, dirPath));
  });
  const closedCount = closeTrackedFileStreams(handles);

  if (closedCount > 0) {
    addJobLog(job, `Папка "${TRANSLATED_OUTPUT_DIR_NAME}": закрыто открытых потоков: ${closedCount}.`);
  }

  return closedCount;
}

function translatedOutputDirsForJob(job) {
  const dirs = new Set();
  for (const item of job.items || []) {
    dirs.add(normalizePathForCompare(translatedOutputDir(item)));
  }

  return [...dirs];
}

function closeTrackedFileStreams(handles) {
  let closedCount = 0;

  for (const handle of handles) {
    if (!activeFileStreams.has(handle)) {
      continue;
    }

    activeFileStreams.delete(handle);
    closedCount += 1;

    if (!handle.stream.destroyed) {
      handle.stream.destroy();
    }

    if (!handle.response.destroyed) {
      handle.response.destroy();
    }
  }

  return closedCount;
}

function isPathInsideDir(filePath, dirPath) {
  const normalizedFile = normalizePathForCompare(filePath);
  const normalizedDir = normalizePathForCompare(dirPath);
  const dirWithSeparator = normalizedDir.endsWith(path.sep) ? normalizedDir : `${normalizedDir}${path.sep}`;
  return normalizedFile === normalizedDir || normalizedFile.startsWith(dirWithSeparator);
}

function normalizePathForCompare(value) {
  const normalized = path.resolve(String(value || ''));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      throw httpError(413, 'Request body is too large');
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'Expected JSON body');
  }
}

function getJobFromPath(pathname) {
  const id = pathname.split('/')[3];
  const job = jobs.get(id);
  if (!job) {
    throw httpError(404, 'Задание не найдено.');
  }
  return job;
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || '',
    completedAt: job.completedAt || '',
    timing: buildJobTiming(job),
    cancelAfterCurrent: job.cancelAfterCurrent,
    error: job.error || '',
    items: job.items,
    logs: job.logs.slice(-120),
  };
}

function setItemStatus(job, item, status, progress, detail) {
  item.status = status;
  item.progress = progress;
  item.detail = detail;
  updateJobProgress(job);
  touchJob(job);
}

function updateJobProgress(job) {
  if (!job.items.length) {
    job.progress = 0;
    return;
  }

  const sum = job.items.reduce((total, item) => total + (Number(item.progress) || 0), 0);
  job.progress = Math.round(sum / job.items.length);
}

function buildJobTiming(job) {
  const startedAt = Date.parse(job.startedAt || '');
  if (!Number.isFinite(startedAt)) {
    return {
      elapsedMs: 0,
      remainingMs: null,
      estimatedFinishAt: '',
      elapsedLabel: '0 сек',
      remainingLabel: 'пока нет данных',
      finishLabel: '',
    };
  }

  const terminal = ['complete', 'failed', 'cancelled'].includes(job.status);
  const completedAt = Date.parse(job.completedAt || '');
  const now = Date.now();
  const currentAt = terminal && Number.isFinite(completedAt) ? completedAt : now;
  const elapsedMs = Math.max(0, currentAt - startedAt);

  if (terminal) {
    return {
      elapsedMs,
      remainingMs: 0,
      estimatedFinishAt: Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : '',
      elapsedLabel: formatDuration(elapsedMs),
      remainingLabel: '0 сек',
      finishLabel: Number.isFinite(completedAt) ? formatTimeOfDay(completedAt) : '',
    };
  }

  const progressRatio = weightedProgressRatio(job);
  if (progressRatio <= 0.02) {
    return {
      elapsedMs,
      remainingMs: null,
      estimatedFinishAt: '',
      elapsedLabel: formatDuration(elapsedMs),
      remainingLabel: 'пока считаю',
      finishLabel: '',
    };
  }

  const estimatedTotalMs = elapsedMs / progressRatio;
  const remainingMs = Math.max(0, estimatedTotalMs - elapsedMs);
  const estimatedFinishMs = now + remainingMs;

  return {
    elapsedMs,
    remainingMs,
    estimatedFinishAt: new Date(estimatedFinishMs).toISOString(),
    elapsedLabel: formatDuration(elapsedMs),
    remainingLabel: formatDuration(remainingMs),
    finishLabel: formatTimeOfDay(estimatedFinishMs),
  };
}

function weightedProgressRatio(job) {
  const items = Array.isArray(job.items) ? job.items : [];
  const allItemsHaveDuration = items.length > 0 && items.every((item) => Number(item.durationSeconds) > 0);

  if (allItemsHaveDuration) {
    const totalDuration = items.reduce((sum, item) => sum + Math.max(0, Number(item.durationSeconds) || 0), 0);
    const weighted = items.reduce((sum, item) => {
      const duration = Math.max(0, Number(item.durationSeconds) || 0);
      return sum + duration * boundedProgressRatio(item.progress);
    }, 0);
    return Math.max(0, Math.min(1, weighted / totalDuration));
  }

  const totalBytes = items.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0);

  if (totalBytes > 0) {
    const weighted = items.reduce((sum, item) => {
      const size = Math.max(0, Number(item.size) || 0);
      return sum + size * boundedProgressRatio(item.progress);
    }, 0);
    return Math.max(0, Math.min(1, weighted / totalBytes));
  }

  return boundedProgressRatio(job.progress);
}

function boundedProgressRatio(progress) {
  return Math.max(0, Math.min(1, (Number(progress) || 0) / 100));
}

function normalizeDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function addJobSummaryLog(job) {
  const summary = buildJobSummary(job);

  addJobLog(
    job,
    `Статистика: переведено видео: ${summary.translatedCount} из ${summary.totalCount}; общий размер исходных файлов: ${summary.totalSize}; время выполнения: ${summary.duration}.`,
  );

  return summary;
}

function buildJobSummary(job) {
  const translatedItems = job.items.filter((item) => item.status === 'ready');
  const errorItems = job.items.filter((item) => item.status === 'error');
  const cancelledItems = job.items.filter((item) => item.status === 'cancelled');
  const totalBytes = translatedItems.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const startedAt = Date.parse(job.startedAt || job.createdAt);
  const completedAt = Date.parse(job.completedAt || job.updatedAt || new Date().toISOString());
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? Math.max(0, completedAt - startedAt)
    : 0;

  return {
    totalCount: job.items.length,
    translatedCount: translatedItems.length,
    errorCount: errorItems.length,
    cancelledCount: cancelledItems.length,
    totalBytes,
    totalSize: formatBytes(totalBytes),
    elapsedMs,
    duration: formatDuration(elapsedMs),
  };
}

async function sendTelegramJobNotification(job, summary) {
  const telegram = job.settings.telegram || {};
  if (!telegram.enabled) {
    return;
  }

  if (!telegram.botToken || !telegram.chatId) {
    addJobLog(job, 'Telegram: уведомление не отправлено, не указан Bot Token или Chat ID.');
    return;
  }

  try {
    await sendTelegramMessage(telegram.botToken, telegram.chatId, buildTelegramJobMessage(job, summary));
    addJobLog(job, 'Telegram: уведомление отправлено.');
  } catch (error) {
    const message = error.name === 'AbortError' ? 'таймаут запроса' : error.message;
    addJobLog(job, `Telegram: не удалось отправить уведомление. ${message}`);
  }
}

async function startTelegramBot() {
  const telegram = normalizeTelegramSettings();
  if (!telegram.enabled) {
    telegramBotState.status = 'disabled';
    console.log('Telegram bot is disabled.');
    return;
  }

  if (!telegram.botToken) {
    telegramBotState.status = 'missing_token';
    telegramBotState.error = `Add botToken to ${TELEGRAM_CONFIG_PATH}`;
    console.log('Telegram bot token is not configured.');
    return;
  }

  try {
    const bot = await telegramApiRequest(telegram.botToken, 'getMe', {}, 15000);
    telegramBotState.status = 'ready';
    telegramBotState.username = bot.username || '';
    telegramBotState.error = '';
    console.log(`Telegram bot is running${bot.username ? `: @${bot.username}` : ''}`);
    startTelegramPolling(telegram.botToken);
  } catch (error) {
    telegramBotState.status = 'error';
    telegramBotState.error = error.message;
    console.log(`Telegram bot failed to start: ${error.message}`);
  }
}

function startTelegramPolling(botToken) {
  if (telegramBotState.polling) {
    return;
  }

  telegramBotState.polling = true;
  void pollTelegramUpdates(botToken);
}

async function pollTelegramUpdates(botToken) {
  while (telegramBotState.polling && !isShuttingDown) {
    try {
      const updates = await telegramApiRequest(botToken, 'getUpdates', {
        offset: telegramBotState.lastUpdateId + 1,
        timeout: 25,
        allowed_updates: ['message', 'channel_post'],
      }, 35000);

      for (const update of updates || []) {
        telegramBotState.lastUpdateId = Math.max(telegramBotState.lastUpdateId, Number(update.update_id) || 0);
        await handleTelegramUpdate(botToken, update);
      }
    } catch (error) {
      if (!isShuttingDown) {
        telegramBotState.status = 'error';
        telegramBotState.error = error.message;
        console.log(`Telegram polling error: ${error.message}`);
        await delay(5000);
      }
    }
  }

  telegramBotState.polling = false;
}

async function handleTelegramUpdate(botToken, update) {
  const message = update.message || update.channel_post;
  const text = String(message?.text || '').trim();
  const chatId = message?.chat?.id;
  if (!text || chatId === undefined || chatId === null) {
    return;
  }

  telegramBotState.lastChatId = String(chatId);

  if (/^\/(start|chatid)(@\w+)?(?:\s|$)/i.test(text)) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `LVT bot работает.\n\nChat ID: ${chatId}\nВставьте этот Chat ID в telegram.config.json.\n\nКоманды:\n/status - статус обработки`,
    );
    return;
  }

  if (/^\/status(@\w+)?(?:\s|$)/i.test(text)) {
    await sendTelegramMessage(botToken, chatId, buildTelegramStatusMessage(chatId));
  }
}

function buildTelegramStatusMessage(chatId) {
  const activeJob = findTelegramJob((job) => !isTerminalJobStatus(job.status));
  if (activeJob) {
    return buildTelegramActiveStatusMessage(activeJob, chatId);
  }

  const latestJob = findTelegramJob(() => true);
  const lines = [
    'LVT работает, сейчас не занят обработкой.',
  ];

  if (!latestJob) {
    lines.push('', 'Последних заданий нет.', `Chat ID: ${chatId}`);
    return lines.join('\n');
  }

  const summary = buildJobSummary(latestJob);
  lines.push(
    '',
    `Последнее задание: ${jobStatusLabel(latestJob.status)}`,
    `Видео переведено: ${summary.translatedCount} из ${summary.totalCount}`,
  );

  if (summary.errorCount > 0) {
    lines.push(`Ошибок: ${summary.errorCount}`);
  }

  if (summary.cancelledCount > 0) {
    lines.push(`Отменено: ${summary.cancelledCount}`);
  }

  lines.push(
    `Общий размер исходных файлов: ${summary.totalSize}`,
    `Время выполнения: ${summary.duration}`,
    `Chat ID: ${chatId}`,
  );

  return lines.join('\n');
}

function buildTelegramActiveStatusMessage(job, chatId) {
  const summary = buildJobSummary(job);
  const timing = buildJobTiming(job);
  const currentItem = findCurrentJobItem(job);
  const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
  const lines = [
    'LVT работает: идет обработка.',
    '',
    `Задание: ${jobStatusLabel(job.status)}`,
    `Общий прогресс: ${progress}%`,
    `Видео готово: ${summary.translatedCount} из ${summary.totalCount}`,
  ];

  if (summary.errorCount > 0) {
    lines.push(`Ошибок: ${summary.errorCount}`);
  }

  if (summary.cancelledCount > 0) {
    lines.push(`Отменено: ${summary.cancelledCount}`);
  }

  if (currentItem) {
    const itemIndex = Array.isArray(job.items) ? job.items.indexOf(currentItem) : -1;
    lines.push(
      '',
      `Текущий файл: ${truncateTelegramText(currentItem.title || currentItem.relativePath || path.basename(currentItem.path || 'видео'), 120)}`,
      `Этап: ${buildTelegramItemStage(currentItem)}`,
    );

    if (itemIndex >= 0) {
      lines.push(`Позиция в очереди: ${itemIndex + 1} из ${job.items.length}`);
    }
  }

  lines.push(
    '',
    `Прошло: ${timing.elapsedLabel}`,
    `Осталось: ${timing.remainingLabel}`,
  );

  if (timing.finishLabel) {
    lines.push(`Примерное завершение: ${timing.finishLabel}`);
  }

  lines.push(`Chat ID: ${chatId}`);
  return lines.join('\n');
}

function findTelegramJob(predicate) {
  return [...jobs.values()]
    .filter(predicate)
    .sort((first, second) => {
      const firstTime = Date.parse(first.updatedAt || first.createdAt || '') || 0;
      const secondTime = Date.parse(second.updatedAt || second.createdAt || '') || 0;
      return secondTime - firstTime;
    })[0] || null;
}

function findCurrentJobItem(job) {
  const items = Array.isArray(job.items) ? job.items : [];
  const activeStatuses = new Set(['extracting', 'transcribing', 'translating', 'voicing', 'mixing', 'running']);
  return items.find((item) => activeStatuses.has(item.status))
    || items.find((item) => item.status === 'queued')
    || null;
}

function buildTelegramItemStage(item) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(item.progress) || 0)));
  return `${item.detail || itemStatusLabel(item.status)} (${progress}%)`;
}

function itemStatusLabel(status) {
  const labels = {
    queued: 'В очереди',
    running: 'Выполняется',
    extracting: 'Извлечение аудио',
    transcribing: 'Распознавание речи',
    translating: 'Перевод субтитров',
    voicing: 'Озвучка',
    mixing: 'Сборка видео',
    ready: 'Готово',
    error: 'Ошибка',
    cancelled: 'Отменено',
  };

  return labels[status] || status || 'Ожидание';
}

function isTerminalJobStatus(status) {
  return ['complete', 'failed', 'cancelled'].includes(status);
}

function truncateTelegramText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

async function sendTelegramMessage(botToken, chatId, text) {
  return telegramApiRequest(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  }, 15000);
}

async function telegramApiRequest(botToken, method, body, timeoutMs) {
  const response = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, timeoutMs);
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.description || response.statusText || 'Telegram API вернул ошибку.');
  }

  return payload?.result;
}

function buildTelegramJobMessage(job, summary) {
  const lines = [
    'LVT: задание завершено',
    '',
    `Статус: ${jobStatusLabel(job.status)}`,
    `Видео переведено: ${summary.translatedCount} из ${summary.totalCount}`,
    `Общий размер исходных файлов: ${summary.totalSize}`,
    `Время выполнения: ${summary.duration}`,
  ];

  if (summary.errorCount > 0) {
    lines.push(`Ошибок: ${summary.errorCount}`);
  }

  if (summary.cancelledCount > 0) {
    lines.push(`Отменено: ${summary.cancelledCount}`);
  }

  return lines.join('\n');
}

function jobStatusLabel(status) {
  const labels = {
    complete: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменено',
    running: 'Выполняется',
    queued: 'В очереди',
  };

  return labels[status] || status;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatItemReadyMeta(item) {
  const size = Number(item.size);
  const durationSeconds = Number(item.durationSeconds);
  const sizeLabel = Number.isFinite(size) && size > 0 ? formatBytes(size) : 'неизвестно';
  const durationLabel = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? formatDuration(durationSeconds * 1000)
    : 'неизвестно';

  return `Размер файла: ${sizeLabel}; длительность видео: ${durationLabel}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} ч ${minutes} мин ${seconds} сек`;
  }

  if (minutes > 0) {
    return `${minutes} мин ${seconds} сек`;
  }

  return `${seconds} сек`;
}

function formatTimeOfDay(value) {
  return new Date(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function addJobLog(job, message) {
  job.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (job.logs.length > 300) {
    job.logs.splice(0, job.logs.length - 300);
  }
  touchJob(job);
}

function touchJob(job) {
  job.updatedAt = new Date().toISOString();
}

async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function isVideoPath(filePath) {
  return videoExtensions.has(path.extname(filePath).toLowerCase());
}

function defaultFfprobePath(ffmpegPath) {
  const command = normalizeCommand(ffmpegPath);
  if (!looksLikePath(command)) {
    return 'ffprobe';
  }

  const ext = path.extname(command);
  const base = path.basename(command, ext).toLocaleLowerCase();
  if (base !== 'ffmpeg') {
    return 'ffprobe';
  }

  return path.join(path.dirname(command), `ffprobe${ext || (process.platform === 'win32' ? '.exe' : '')}`);
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
}

function contentTypeFor(filePath) {
  return mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function stripExtension(name) {
  return String(name).replace(/\.[^.]+$/, '');
}

function normalizeTitle(value) {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return (normalized || 'Без названия').slice(0, 180);
}

function sanitizeFileName(value) {
  return normalizeTitle(value).replace(/[ .]+$/g, '').slice(0, 120) || 'subtitles';
}

function withSuffix(title, count) {
  const suffix = `_${String(count).padStart(2, '0')}`;
  return `${title.slice(0, 180 - suffix.length)}${suffix}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

function httpError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function nonRetryableItemError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

function loadTelegramConfig(configPath) {
  const envConfig = {
    enabled: process.env.LVT_TELEGRAM_ENABLED === 'true',
    botToken: process.env.LVT_TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.LVT_TELEGRAM_CHAT_ID || '',
  };

  if (!existsSync(configPath)) {
    return envConfig;
  }

  try {
    const fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      enabled: Object.hasOwn(fileConfig, 'enabled') ? fileConfig.enabled === true : envConfig.enabled,
      botToken: envConfig.botToken || normalizeSecret(fileConfig.botToken || ''),
      chatId: envConfig.chatId || normalizeSecret(fileConfig.chatId || ''),
    };
  } catch (error) {
    console.log(`Telegram config was not loaded: ${error.message}`);
    return envConfig;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotEnv(envPath) {
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
