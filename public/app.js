const form = {
  serverStatus: document.querySelector('#serverStatus'),
  themeToggle: document.querySelector('#themeToggle'),
  shutdownProject: document.querySelector('#shutdownProject'),
  modeSingle: document.querySelector('#modeSingle'),
  modeFolder: document.querySelector('#modeFolder'),
  workDir: document.querySelector('#workDir'),
  ffmpegPath: document.querySelector('#ffmpegPath'),
  ffprobePath: document.querySelector('#ffprobePath'),
  whisperDevice: document.querySelector('#whisperDevice'),
  whisperCommand: document.querySelector('#whisperCommand'),
  whisperModel: document.querySelector('#whisperModel'),
  pythonCommand: document.querySelector('#pythonCommand'),
  translationMode: document.querySelector('#translationMode'),
  ttsModel: document.querySelector('#ttsModel'),
  ttsSpeaker: document.querySelector('#ttsSpeaker'),
  ttsDevice: document.querySelector('#ttsDevice'),
  telegramEnabled: document.querySelector('#telegramEnabled'),
  telegramBotToken: document.querySelector('#telegramBotToken'),
  telegramChatId: document.querySelector('#telegramChatId'),
  voiceoverMode: document.querySelector('#voiceoverMode'),
  audioMixMode: document.querySelector('#audioMixMode'),
  saveSettings: document.querySelector('#saveSettings'),
  checkTools: document.querySelector('#checkTools'),
  toolChecks: document.querySelector('#toolChecks'),
  singlePath: document.querySelector('#singlePath'),
  pickSingle: document.querySelector('#pickSingle'),
  scanSingle: document.querySelector('#scanSingle'),
  folderPath: document.querySelector('#folderPath'),
  pickFolder: document.querySelector('#pickFolder'),
  playlistTitle: document.querySelector('#playlistTitle'),
  namingMode: document.querySelector('#namingMode'),
  recursiveScan: document.querySelector('#recursiveScan'),
  scanFolder: document.querySelector('#scanFolder'),
  sourceLang: document.querySelector('#sourceLang'),
  targetLang: document.querySelector('#targetLang'),
  outputMode: document.querySelector('#outputMode'),
  continueOnError: document.querySelector('#continueOnError'),
  retryFailedAfterBatch: document.querySelector('#retryFailedAfterBatch'),
  startJob: document.querySelector('#startJob'),
  cancelJob: document.querySelector('#cancelJob'),
  stopJob: document.querySelector('#stopJob'),
  progressLabel: document.querySelector('#progressLabel'),
  progressPercent: document.querySelector('#progressPercent'),
  progressBar: document.querySelector('#progressBar'),
  jobTiming: document.querySelector('#jobTiming'),
  elapsedTime: document.querySelector('#elapsedTime'),
  remainingTime: document.querySelector('#remainingTime'),
  finishTime: document.querySelector('#finishTime'),
  queueSummary: document.querySelector('#queueSummary'),
  queueList: document.querySelector('#queueList'),
  resultEmpty: document.querySelector('#resultEmpty'),
  videoPlayer: document.querySelector('#videoPlayer'),
  resultList: document.querySelector('#resultList'),
  log: document.querySelector('#log'),
  clearLog: document.querySelector('#clearLog'),
};

const state = {
  mode: 'single',
  queue: [],
  job: null,
  pollTimer: null,
  busy: false,
  config: null,
};

const settingsKey = 'lvt.settings';
const modeKey = 'lvt.mode';
const themeKey = 'lvt.theme';
const currentJobKey = 'lvt.currentJobId';
const lastFolderPathKey = 'lvt.lastFolderPath';
const defaultFfmpegPath = 'E:\\AI\\Tools\\ffmpeg-release-essentials\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe';
const defaultFfprobePath = 'E:\\AI\\Tools\\ffmpeg-release-essentials\\ffmpeg-9.0.1-essentials_build\\bin\\ffprobe.exe';
const defaultWhisperCommand = 'E:\\AI\\Tools\\whisper-bin-x64\\whisper-cli.exe';
const defaultGpuWhisperCommand = 'E:\\AI\\Tools\\whisper-cublas-12.4.0-bin-x64\\Release\\whisper-cli.exe';
const defaultModelPath = 'E:\\AI\\Models\\ggml-large-v3-turbo.bin';
const defaultPythonCommand = 'C:\\Users\\User\\Documents\\ChatGPT\\LVT\\.venv\\Scripts\\python.exe';
const defaultTtsModelPath = 'E:\\AI\\Models\\Silero\\v5_5_ru.pt';
const legacyFfmpegPaths = [/^ffmpeg$/i, /^E:\\AI\\Tools\\ffmpeg-9\.0\.1\\bin\\ffmpeg\.exe$/i];
const legacyWhisperCommands = [/^whisper-cli$/i];
const legacyGpuWhisperCommands = [/^E:\\AI\\Tools\\whisper-cublas-11\.8\.0-bin-x64\\Release\\whisper-cli\.exe$/i];
const legacyPythonCommands = [/^python$/i, /^py$/i];
const legacyModelPaths = [
  /^C:\\AI\\LVT-Models\\ggml-large-v3-turbo\.bin$/i,
  /^E:\\Models\\ggml-large-v3-turbo\.bin$/i,
];

boot();

async function boot() {
  bindEvents();
  applyTheme(readTheme(), { persist: false });
  loadSavedSettings();
  setMode(localStorage.getItem(modeKey) === 'folder' ? 'folder' : 'single');
  renderQueue();
  renderResults();

  try {
    const config = await apiGet('/api/config');
    state.config = config;
    form.serverStatus.textContent = 'Локальный сервер';
    fillDefaults(config);
    logLine(`LVT запущен на порту ${config.port}.`);
    await restoreJobAfterReload();
  } catch (error) {
    form.serverStatus.textContent = 'Сервер недоступен';
    logError(error);
  }
}

function bindEvents() {
  form.modeSingle.addEventListener('click', () => setMode('single'));
  form.modeFolder.addEventListener('click', () => setMode('folder'));
  form.themeToggle.addEventListener('change', () => applyTheme(form.themeToggle.checked ? 'dark' : 'light'));
  form.saveSettings.addEventListener('click', saveSettings);
  form.checkTools.addEventListener('click', checkTools);
  form.shutdownProject.addEventListener('click', shutdownProject);
  form.whisperDevice.addEventListener('change', syncWhisperCommandForDevice);
  form.pickSingle.addEventListener('click', () => pickSource('single'));
  form.pickFolder.addEventListener('click', () => pickSource('folder'));
  form.singlePath.addEventListener('click', () => pickSource('single'));
  form.folderPath.addEventListener('click', () => pickSource('folder'));
  form.scanSingle.addEventListener('click', () => scanSource('single'));
  form.scanFolder.addEventListener('click', () => scanSource('folder'));
  form.namingMode.addEventListener('change', () => {
    if (state.mode === 'folder' && form.folderPath.value.trim()) {
      scanSource('folder');
    }
  });
  form.playlistTitle.addEventListener('change', () => {
    if (state.mode === 'folder' && form.folderPath.value.trim()) {
      scanSource('folder');
    }
  });
  form.startJob.addEventListener('click', startJob);
  form.cancelJob.addEventListener('click', cancelJob);
  form.stopJob.addEventListener('click', stopJobNow);
  form.queueList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-queue]');
    if (!button) return;
    removeQueueItem(button.dataset.removeQueue);
  });
  form.resultList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-result-index]');
    if (!button) return;
    const item = state.job?.items[Number(button.dataset.resultIndex)];
    if (item) {
      showResult(item);
    }
  });
  form.clearLog.addEventListener('click', () => {
    form.log.textContent = '';
  });
}

function readTheme() {
  return localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, options = {}) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('theme-dark', isDark);
  form.themeToggle.checked = isDark;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = isDark ? '#08110f' : '#0f7f75';
  }

  if (options.persist !== false) {
    localStorage.setItem(themeKey, isDark ? 'dark' : 'light');
  }
}

function fillDefaults(config) {
  const saved = getSettings();
  const whisperDevice = saved.whisperDevice || config.whisperDevice || 'gpu';
  const telegramEnabled = saved.telegram && Object.hasOwn(saved.telegram, 'enabled')
    ? saved.telegram.enabled === true
    : config.telegram?.enabled === true;
  form.workDir.value = saved.workDir || config.defaultWorkDir || '';
  form.ffmpegPath.value = saved.ffmpeg || config.tools.ffmpeg || 'ffmpeg';
  form.ffprobePath.value = saved.ffprobe || saved.tools?.ffprobe || config.tools.ffprobe || defaultFfprobePath;
  form.whisperDevice.value = whisperDevice;
  form.whisperCommand.value = activeWhisperCommand(whisperDevice, saved, config);
  form.whisperModel.value = saved.whisperModel || config.tools.whisperModel || '';
  form.pythonCommand.value = saved.python || config.tools.python || 'python';
  form.translationMode.value = saved.translationMode || 'argos';
  form.ttsModel.value = saved.ttsModel || config.tools.ttsModel || defaultTtsModelPath;
  form.ttsSpeaker.value = saved.ttsSpeaker || 'xenia';
  form.ttsDevice.value = saved.ttsDevice || 'cpu';
  form.telegramEnabled.checked = telegramEnabled;
  form.telegramBotToken.value = saved.telegram?.botToken || '';
  form.telegramBotToken.placeholder = config.telegram?.hasBotToken ? 'Задан в telegram.config.json' : '123456789:AA...';
  form.telegramChatId.value = saved.telegram?.chatId || config.telegram?.chatId || '';
  form.voiceoverMode.value = saved.voiceoverMode || 'none';
  form.audioMixMode.value = saved.audioMixMode || 'overlay';
  form.sourceLang.value = saved.sourceLang || 'auto';
  form.targetLang.value = saved.targetLang || 'ru';
  form.outputMode.value = saved.outputMode || 'work';
  form.continueOnError.checked = saved.continueOnError !== false;
  form.retryFailedAfterBatch.checked = saved.retryFailedAfterBatch === true;
}

function loadSavedSettings() {
  const saved = getSettings();
  form.workDir.value = saved.workDir || '';
  form.ffmpegPath.value = saved.ffmpeg || '';
  form.ffprobePath.value = saved.ffprobe || saved.tools?.ffprobe || '';
  form.whisperDevice.value = saved.whisperDevice || 'gpu';
  form.whisperCommand.value = saved.whisperCommand || '';
  form.whisperModel.value = saved.whisperModel || '';
  form.pythonCommand.value = saved.python || '';
  form.translationMode.value = saved.translationMode || 'argos';
  form.ttsModel.value = saved.ttsModel || '';
  form.ttsSpeaker.value = saved.ttsSpeaker || 'xenia';
  form.ttsDevice.value = saved.ttsDevice || 'cpu';
  form.telegramEnabled.checked = saved.telegram?.enabled === true;
  form.telegramBotToken.value = saved.telegram?.botToken || '';
  form.telegramChatId.value = saved.telegram?.chatId || '';
  form.voiceoverMode.value = saved.voiceoverMode || 'none';
  form.audioMixMode.value = saved.audioMixMode || 'overlay';
  form.sourceLang.value = saved.sourceLang || 'auto';
  form.targetLang.value = saved.targetLang || 'ru';
  form.outputMode.value = saved.outputMode || 'work';
  form.continueOnError.checked = saved.continueOnError !== false;
  form.retryFailedAfterBatch.checked = saved.retryFailedAfterBatch === true;
}

function getSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(settingsKey) || '{}');
    const migrated = migrateSettings(settings);
    if (migrated !== settings) {
      localStorage.setItem(settingsKey, JSON.stringify(migrated));
    }
    return migrated;
  } catch {
    return {};
  }
}

function migrateSettings(settings) {
  const ffmpeg = migrateValue(settings.ffmpeg, legacyFfmpegPaths, defaultFfmpegPath);
  const ffprobe = settings.ffprobe || settings.tools?.ffprobe || defaultFfprobePath;
  const whisperCommand = migrateValue(
    migrateValue(settings.whisperCommand, legacyGpuWhisperCommands, defaultGpuWhisperCommand),
    legacyWhisperCommands,
    defaultWhisperCommand,
  );
  const whisperCpuCommand = migrateValue(settings.whisperCpuCommand, legacyWhisperCommands, defaultWhisperCommand);
  const whisperGpuCommand = migrateValue(settings.whisperGpuCommand, legacyGpuWhisperCommands, defaultGpuWhisperCommand) || defaultGpuWhisperCommand;
  const whisperModel = migrateValue(settings.whisperModel, legacyModelPaths, defaultModelPath);
  const toolFfmpeg = migrateValue(settings.tools?.ffmpeg, legacyFfmpegPaths, defaultFfmpegPath);
  const toolFfprobe = settings.tools?.ffprobe || settings.ffprobe || defaultFfprobePath;
  const toolWhisperCommand = migrateValue(
    migrateValue(settings.tools?.whisperCommand, legacyGpuWhisperCommands, defaultGpuWhisperCommand),
    legacyWhisperCommands,
    defaultWhisperCommand,
  );
  const toolWhisperCpuCommand = migrateValue(settings.tools?.whisperCpuCommand, legacyWhisperCommands, defaultWhisperCommand);
  const toolWhisperGpuCommand = migrateValue(settings.tools?.whisperGpuCommand, legacyGpuWhisperCommands, defaultGpuWhisperCommand) || defaultGpuWhisperCommand;
  const toolModel = migrateValue(settings.tools?.whisperModel, legacyModelPaths, defaultModelPath);
  const python = migrateValue(settings.python, legacyPythonCommands, defaultPythonCommand);
  const toolPython = migrateValue(settings.tools?.python, legacyPythonCommands, defaultPythonCommand);
  const ttsModel = settings.ttsModel || defaultTtsModelPath;
  const toolTtsModel = settings.tools?.ttsModel || defaultTtsModelPath;

  if (
    ffmpeg === settings.ffmpeg &&
    whisperCommand === settings.whisperCommand &&
    whisperCpuCommand === settings.whisperCpuCommand &&
    whisperGpuCommand === settings.whisperGpuCommand &&
    whisperModel === settings.whisperModel &&
    ffprobe === settings.ffprobe &&
    toolFfmpeg === settings.tools?.ffmpeg &&
    toolFfprobe === settings.tools?.ffprobe &&
    toolWhisperCommand === settings.tools?.whisperCommand &&
    toolWhisperCpuCommand === settings.tools?.whisperCpuCommand &&
    toolWhisperGpuCommand === settings.tools?.whisperGpuCommand &&
    toolModel === settings.tools?.whisperModel &&
    python === settings.python &&
    toolPython === settings.tools?.python &&
    ttsModel === settings.ttsModel &&
    toolTtsModel === settings.tools?.ttsModel
  ) {
    return settings;
  }

  return {
    ...settings,
    whisperDevice: settings.whisperDevice === 'cpu' ? 'cpu' : 'gpu',
    ffmpeg,
    whisperCommand,
    whisperCpuCommand,
    whisperGpuCommand,
    whisperModel,
    ffprobe,
    ttsModel,
    ttsSpeaker: normalizeTtsSpeaker(settings.ttsSpeaker),
    ttsDevice: settings.ttsDevice === 'cuda' ? 'cuda' : 'cpu',
    telegram: normalizeTelegramSettings(settings.telegram),
    retryFailedAfterBatch: settings.retryFailedAfterBatch === true,
    voiceoverMode: settings.voiceoverMode === 'silero' ? 'silero' : 'none',
    audioMixMode: settings.audioMixMode === 'replace' ? 'replace' : 'overlay',
    python,
    tools: {
      ...settings.tools,
      ffmpeg: toolFfmpeg,
      ffprobe: toolFfprobe,
      whisperCommand: toolWhisperCommand,
      whisperCpuCommand: toolWhisperCpuCommand,
      whisperGpuCommand: toolWhisperGpuCommand,
      whisperModel: toolModel,
      ttsModel: toolTtsModel,
      python: toolPython,
    },
  };
}

function migrateValue(value, legacyPatterns, nextValue) {
  return legacyPatterns.some((pattern) => pattern.test(value || '')) ? nextValue : value;
}

function saveSettings() {
  localStorage.setItem(settingsKey, JSON.stringify(readSettings()));
  logLine('Настройки сохранены в этом браузере.');
}

function readSettings() {
  const saved = getSettings();
  const whisperDevice = form.whisperDevice.value === 'cpu' ? 'cpu' : 'gpu';
  const whisperCommand = form.whisperCommand.value.trim();
  const whisperCpuCommand = whisperDevice === 'cpu'
    ? whisperCommand
    : saved.whisperCpuCommand || state.config?.tools?.whisperCpuCommand || defaultWhisperCommand;
  const whisperGpuCommand = whisperDevice === 'gpu'
    ? whisperCommand
    : saved.whisperGpuCommand || state.config?.tools?.whisperGpuCommand || defaultGpuWhisperCommand;

  return {
    workDir: form.workDir.value.trim(),
    whisperDevice,
    sourceLang: form.sourceLang.value,
    targetLang: form.targetLang.value,
    outputMode: form.outputMode.value,
    translationMode: form.translationMode.value,
    voiceoverMode: form.voiceoverMode.value,
    audioMixMode: form.audioMixMode.value,
    ttsSpeaker: normalizeTtsSpeaker(form.ttsSpeaker.value),
    ttsDevice: form.ttsDevice.value === 'cuda' ? 'cuda' : 'cpu',
    telegram: {
      enabled: form.telegramEnabled.checked,
      botToken: form.telegramBotToken.value.trim(),
      chatId: form.telegramChatId.value.trim(),
    },
    ttsModel: form.ttsModel.value.trim(),
    continueOnError: form.continueOnError.checked,
    retryFailedAfterBatch: form.retryFailedAfterBatch.checked,
    ffmpeg: form.ffmpegPath.value.trim(),
    ffprobe: form.ffprobePath.value.trim(),
    whisperCommand,
    whisperCpuCommand,
    whisperGpuCommand,
    whisperModel: form.whisperModel.value.trim(),
    python: form.pythonCommand.value.trim(),
    tools: {
      ffmpeg: form.ffmpegPath.value.trim(),
      ffprobe: form.ffprobePath.value.trim(),
      whisperCommand,
      whisperCpuCommand,
      whisperGpuCommand,
      whisperModel: form.whisperModel.value.trim(),
      ttsModel: form.ttsModel.value.trim(),
      python: form.pythonCommand.value.trim(),
    },
  };
}

function syncWhisperCommandForDevice() {
  const whisperDevice = form.whisperDevice.value === 'cpu' ? 'cpu' : 'gpu';
  const saved = getSettings();
  form.whisperCommand.value = activeWhisperCommand(whisperDevice, saved, state.config || {});
}

function activeWhisperCommand(whisperDevice, saved, config) {
  if (whisperDevice === 'gpu') {
    return saved.whisperGpuCommand || config.tools?.whisperGpuCommand || defaultGpuWhisperCommand;
  }

  return saved.whisperCpuCommand || saved.whisperCommand || config.tools?.whisperCpuCommand || defaultWhisperCommand;
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-single', mode === 'single');
  document.body.classList.toggle('mode-folder', mode === 'folder');
  form.modeSingle.classList.toggle('active', mode === 'single');
  form.modeFolder.classList.toggle('active', mode === 'folder');
  form.modeSingle.setAttribute('aria-pressed', String(mode === 'single'));
  form.modeFolder.setAttribute('aria-pressed', String(mode === 'folder'));
  localStorage.setItem(modeKey, mode);
}

async function pickSource(mode) {
  if (isActiveJob(state.job)) {
    logLine('Нельзя менять источник во время обработки. Сначала остановите или дождитесь завершения задания.');
    return;
  }

  try {
    setBusy(true);
    const previousPath = mode === 'single' ? form.singlePath.value : form.folderPath.value;
    const endpoint = mode === 'single' ? '/api/pick-file' : '/api/pick-folder';
    const result = await apiPost(endpoint, {
      initialPath: pickerInitialPath(mode),
    });

    if (!result.path) {
      logLine('Выбор отменен.');
      return;
    }

    if (mode === 'single') {
      form.singlePath.value = result.path;
      resetJobView();
      logLine(`Выбран файл: ${result.path}.`);
    } else {
      form.folderPath.value = result.path;
      localStorage.setItem(lastFolderPathKey, result.path);
      if (result.path !== previousPath) {
        resetJobView();
      }
      if (!form.playlistTitle.value.trim()) {
        form.playlistTitle.value = folderNameFromPath(result.path);
      }
      logLine(`Выбрана папка: ${result.path}.`);
    }
  } catch (error) {
    logError(error);
  } finally {
    setBusy(false);
  }
}

function pickerInitialPath(mode) {
  if (mode === 'folder') {
    return form.folderPath.value.trim() || localStorage.getItem(lastFolderPathKey) || '';
  }

  return form.singlePath.value.trim() || localStorage.getItem(lastFolderPathKey) || '';
}

async function checkTools() {
  try {
    setBusy(true);
    form.toolChecks.innerHTML = '';
    const result = await apiPost('/api/check-tools', readSettings());
    form.toolChecks.innerHTML = result.checks
      .map((check) => {
        const className = check.ok ? 'ok' : 'bad';
        const status = check.ok ? 'OK' : 'Нужно исправить';
        return `
          <div class="check-row ${className}">
            <strong>${escapeHtml(check.name)}: ${status}</strong>
            <span>${escapeHtml(check.message)}</span>
          </div>
        `;
      })
      .join('');
    logLine('Проверка инструментов завершена.');
  } catch (error) {
    logError(error);
  } finally {
    setBusy(false);
  }
}

async function scanSource(mode) {
  if (isActiveJob(state.job)) {
    logLine('Нельзя пересобрать очередь во время обработки. Сначала остановите или дождитесь завершения задания.');
    return;
  }

  try {
    setBusy(true);
    const sourcePath = mode === 'single' ? form.singlePath.value : form.folderPath.value;
    const playlistTitle = form.playlistTitle.value || folderNameFromPath(sourcePath) || 'Плейлист';
    const result = await apiPost('/api/scan', {
      mode,
      sourcePath,
      playlistTitle,
      namingMode: form.namingMode.value,
      recursive: form.recursiveScan.checked,
      settings: readSettings(),
    });

    if (result.correctedPath) {
      if (mode === 'single') {
        form.singlePath.value = result.correctedPath;
      } else {
        form.folderPath.value = result.correctedPath;
        localStorage.setItem(lastFolderPathKey, result.correctedPath);
      }
      logLine(`Путь исправлен: ${result.correctedPath}.`);
    }

    state.queue = result.items.map((item) => ({
      ...item,
      status: 'queued',
      progress: 0,
      detail: 'В очереди',
    }));
    state.job = null;
    localStorage.removeItem(currentJobKey);
    clearPlayer();
    setProgress(0, 'Ожидание', null);
    renderQueue();
    renderResults();

    if (mode === 'folder' && !form.playlistTitle.value.trim()) {
      form.playlistTitle.value = result.playlistTitle;
    }

    logLine(`В очередь добавлено видео: ${state.queue.length}.`);
  } catch (error) {
    logError(error);
  } finally {
    setBusy(false);
  }
}

async function startJob() {
  if (!state.queue.length) {
    logLine('Сначала добавьте видео в очередь.');
    return;
  }

  try {
    setBusy(true);
    clearPlayer();
    setProgress(0, 'Запуск');
    const settings = readSettings();
    const response = await apiPost('/api/jobs', {
      items: state.queue,
      settings,
    });

    state.job = response;
    localStorage.setItem(currentJobKey, response.id);
    renderQueue();
    renderResults();
    logLine(`Задание создано: ${response.id}.`);
    startPolling();
  } catch (error) {
    logError(error);
    setBusy(false);
  }
}

async function cancelJob() {
  if (!state.job?.id) return;

  try {
    await apiPost(`/api/jobs/${state.job.id}/cancel`, {});
    logLine('Задание остановится после текущего видео.');
  } catch (error) {
    logError(error);
  }
}

async function stopJobNow() {
  if (!state.job?.id) return;

  try {
    await apiPost(`/api/jobs/${state.job.id}/stop`, {});
    logLine('Останавливаю текущий процесс.');
    await refreshJob();
  } catch (error) {
    logError(error);
  }
}

async function shutdownProject() {
  const message = state.busy
    ? 'Сейчас идет обработка. Выключить проект и остановить текущий процесс?'
    : 'Выключить проект LVT?';

  if (!window.confirm(message)) {
    return;
  }

  try {
    form.shutdownProject.disabled = true;
    logLine('Выключаю проект LVT. Временная папка work\\jobs будет очищена.');
    await apiPost('/api/shutdown', {});
    stopPolling();
    form.serverStatus.textContent = 'Сервер выключается';
    logLine('Команда выключения отправлена. Страницу можно закрыть.');
  } catch (error) {
    form.shutdownProject.disabled = false;
    logError(error);
  }
}

function startPolling() {
  stopPolling();
  form.cancelJob.disabled = false;
  form.stopJob.disabled = false;

  state.pollTimer = window.setInterval(refreshJob, 2000);
  refreshJob();
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function refreshJob() {
  if (!state.job?.id) return;

  try {
    const job = await apiGet(`/api/jobs/${state.job.id}`);
    state.job = job;
    state.queue = job.items;
    localStorage.setItem(currentJobKey, job.id);
    setProgress(job.progress, statusText(job.status), job.timing);
    renderQueue();
    renderResults();
    renderLogs(job.logs);

    if (['complete', 'failed', 'cancelled'].includes(job.status)) {
      stopPolling();
      setBusy(false);
      form.cancelJob.disabled = true;
      form.stopJob.disabled = true;
    }
  } catch (error) {
    stopPolling();
    localStorage.removeItem(currentJobKey);
    logError(error);
    setBusy(false);
  }
}

async function restoreJobAfterReload() {
  const restored = await loadRestorableJob();
  if (!restored) return;

  state.job = restored;
  state.queue = restored.items || [];
  localStorage.setItem(currentJobKey, restored.id);
  setProgress(restored.progress, statusText(restored.status), restored.timing);
  renderQueue();
  renderResults();
  renderLogs(restored.logs);

  if (isActiveJob(restored)) {
    setBusy(true);
    startPolling();
    logLine(`Подключено к текущему заданию: ${restored.id}.`);
  } else {
    setBusy(false);
    form.cancelJob.disabled = true;
    form.stopJob.disabled = true;
    logLine(`Восстановлено последнее задание: ${restored.id}.`);
  }
}

async function loadRestorableJob() {
  const savedJobId = localStorage.getItem(currentJobKey);
  if (savedJobId) {
    try {
      return await apiGet(`/api/jobs/${savedJobId}`);
    } catch {
      localStorage.removeItem(currentJobKey);
    }
  }

  const response = await apiGet('/api/jobs');
  return (response.jobs || []).find(isActiveJob) || null;
}

function isActiveJob(job) {
  return job && !['complete', 'failed', 'cancelled'].includes(job.status);
}

function renderQueue() {
  const ready = state.queue.filter((item) => item.status === 'ready').length;
  const errors = state.queue.filter((item) => item.status === 'error').length;
  const canRemoveItems = canEditQueue();
  form.queueSummary.textContent = state.queue.length
    ? `В очереди: ${state.queue.length}; готово: ${ready}; ошибок: ${errors}`
    : 'Очередь пуста';

  form.queueList.innerHTML = state.queue
    .map((item) => {
      const removeButton = canRemoveItems
        ? `<button type="button" class="danger queue-remove" data-remove-queue="${escapeAttribute(item.id)}">Удалить</button>`
        : '';

      return `
        <div class="queue-row status-${escapeAttribute(item.status)}">
          <div class="badge">${escapeHtml(statusText(item.status))}</div>
          <div class="queue-title">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(formatQueueMeta(item))}</span>
          </div>
          <div class="queue-path">${escapeHtml(item.relativePath || item.path)}</div>
          <div class="queue-detail">${escapeHtml(item.detail || '')}</div>
          <div class="queue-actions">${removeButton}</div>
        </div>
      `;
    })
    .join('');
}

function canEditQueue() {
  return state.mode === 'folder' && !state.job;
}

function removeQueueItem(itemId) {
  if (!canEditQueue()) {
    logLine('Очередь можно менять до запуска задания.');
    return;
  }

  const item = state.queue.find((entry) => entry.id === itemId);
  if (!item) return;

  state.queue = state.queue
    .filter((entry) => entry.id !== itemId)
    .map((entry, index) => ({
      ...entry,
      index,
    }));

  logLine(`Удалено из очереди: ${item.title}.`);
  renderQueue();
  renderResults();
}

function renderResults() {
  const readyItems = state.queue.filter((item) => item.status === 'ready' && item.subtitlePath);
  form.resultEmpty.hidden = readyItems.length > 0;
  form.resultList.innerHTML = readyItems
    .map((item) => {
      return `
        <div class="result-row">
          <div class="result-title">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.relativePath || item.path)}</span>
          </div>
          <div class="result-subtitle">
            <span>${escapeHtml(item.subtitlePath)}</span>
            ${item.voicePath ? `<span>${escapeHtml(item.voicePath)}</span>` : ''}
            ${item.voiceoverVideoPath ? `<span>${escapeHtml(item.voiceoverVideoPath)}</span>` : ''}
          </div>
          <button type="button" class="secondary" data-result-index="${item.index}">Смотреть</button>
        </div>
      `;
    })
    .join('');
}

function showResult(item) {
  clearPlayer();

  const source = document.createElement('source');
  source.src = `/api/media?path=${encodeURIComponent(item.voiceoverVideoPath || item.path)}`;
  form.videoPlayer.append(source);

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = languageLabel(form.targetLang.value);
  track.srclang = form.targetLang.value;
  track.src = `/api/subtitles?path=${encodeURIComponent(item.subtitlePath)}`;
  track.default = true;
  form.videoPlayer.append(track);

  form.videoPlayer.hidden = false;
  form.videoPlayer.load();
  logLine(`Открыто видео с субтитрами: ${item.title}.`);
}

function clearPlayer() {
  form.videoPlayer.pause();
  form.videoPlayer.removeAttribute('src');
  form.videoPlayer.innerHTML = '';
  form.videoPlayer.hidden = true;
}

function resetJobView() {
  stopPolling();
  state.job = null;
  state.queue = [];
  localStorage.removeItem(currentJobKey);
  clearPlayer();
  setProgress(0, 'Ожидание', null);
  form.cancelJob.disabled = true;
  form.stopJob.disabled = true;
  renderQueue();
  renderResults();
}

function setProgress(percent, label, timing = null) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  form.progressBar.style.width = `${safePercent}%`;
  form.progressPercent.textContent = `${safePercent}%`;
  form.progressLabel.textContent = label;
  renderTiming(timing);
}

function renderTiming(timing) {
  if (!timing || (!timing.elapsedLabel && !timing.remainingLabel && !timing.finishLabel)) {
    form.elapsedTime.textContent = '0 сек';
    form.remainingTime.textContent = 'пока считаю';
    form.finishTime.textContent = '-';
    form.jobTiming.hidden = true;
    return;
  }

  form.jobTiming.hidden = false;
  form.elapsedTime.textContent = timing.elapsedLabel || '0 сек';
  form.remainingTime.textContent = timing.remainingLabel || 'пока считаю';
  form.finishTime.textContent = timing.finishLabel || '-';
}

function setBusy(busy) {
  state.busy = busy;
  form.checkTools.disabled = busy;
  form.pickSingle.disabled = busy;
  form.pickFolder.disabled = busy;
  form.scanSingle.disabled = busy;
  form.scanFolder.disabled = busy;
  form.startJob.disabled = busy;
  form.saveSettings.disabled = busy;
  form.retryFailedAfterBatch.disabled = busy;
  form.cancelJob.disabled = !state.job || !busy;
  form.stopJob.disabled = !state.job || !busy;
}

function renderLogs(lines) {
  if (!Array.isArray(lines)) return;
  const shouldStickToBottom = isLogNearBottom();
  const previousScrollTop = form.log.scrollTop;
  form.log.textContent = lines.length ? `${lines.join('\n')}\n` : '';
  if (shouldStickToBottom) {
    scrollLogToBottom();
  } else {
    form.log.scrollTop = previousScrollTop;
  }
}

function logLine(message) {
  const time = new Date().toLocaleTimeString();
  appendLogText(`[${time}] ${message}\n`);
}

function logError(error) {
  logLine(`Ошибка: ${error.message}`);
  if (error.details) {
    appendLogText(`${JSON.stringify(error.details, null, 2)}\n`);
  }
}

function appendLogText(text) {
  const shouldStickToBottom = isLogNearBottom();
  form.log.textContent += text;
  if (shouldStickToBottom) {
    scrollLogToBottom();
  }
}

function isLogNearBottom() {
  const threshold = 24;
  return form.log.scrollHeight - form.log.clientHeight - form.log.scrollTop <= threshold;
}

function scrollLogToBottom() {
  form.log.scrollTop = form.log.scrollHeight;
}

async function apiGet(url) {
  const response = await fetch(url);
  return parseApiResponse(response);
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || response.statusText);
    error.details = payload?.error?.details || payload;
    throw error;
  }
  return payload;
}

function statusText(status) {
  const labels = {
    queued: 'В очереди',
    running: 'Выполняется',
    extracting: 'Аудио',
    transcribing: 'Распознавание',
    translating: 'Перевод',
    voicing: 'Озвучка',
    mixing: 'Сборка',
    ready: 'Готово',
    error: 'Ошибка',
    cancelled: 'Отменено',
    complete: 'Готово',
    failed: 'Ошибка',
  };
  return labels[status] || status || 'Ожидание';
}

function normalizeTtsSpeaker(value) {
  return ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'].includes(value) ? value : 'xenia';
}

function normalizeTelegramSettings(value) {
  return {
    enabled: value?.enabled === true,
    botToken: String(value?.botToken || '').trim(),
    chatId: String(value?.chatId || '').trim(),
  };
}

function folderNameFromPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).at(-1) || '';
}

function formatQueueMeta(item) {
  const parts = [formatBytes(item.size || 0)];
  const duration = formatVideoDuration(item.durationSeconds);
  if (duration) {
    parts.push(duration);
  }
  return parts.join(' · ');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatVideoDuration(seconds) {
  const totalSeconds = Math.round(Number(seconds) || 0);
  if (totalSeconds <= 0) return '';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const rest = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
  }

  if (minutes > 0) {
    return `${minutes} мин ${String(rest).padStart(2, '0')} сек`;
  }

  return `${rest} сек`;
}

function languageLabel(code) {
  const labels = {
    ru: 'Русский',
    en: 'Английский',
    de: 'Немецкий',
    fr: 'Французский',
    es: 'Испанский',
    it: 'Итальянский',
    tr: 'Турецкий',
  };
  return labels[code] || code;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[char];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
