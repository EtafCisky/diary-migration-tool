import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { loadWorldInfo } from '../../../world-info.js';

const extensionName = 'diary-migration-tool';
const targetExtensionName = 'sillytavernDIARY';

const MODES = {
  worldToSettings: 'world-to-settings',
  settingsToFiles: 'settings-to-files',
};

const FILE_TARGETS = {
  diaries: {
    label: '普通日记',
    settingsKey: 'diaries',
    fileName: 'diary-data.json',
    kind: 'sillytavernDIARY.diaries',
  },
  exchangeDiaries: {
    label: '交换日记',
    settingsKey: 'exchangeDiaries',
    fileName: 'diary-exchange-data.json',
    kind: 'sillytavernDIARY.exchangeDiaries',
  },
  recycleBin: {
    label: '回收站',
    settingsKey: 'recycleBin',
    fileName: 'diary-recycle-bin.json',
    kind: 'sillytavernDIARY.recycleBin',
  },
};

const DIARY_REGEX = /<日记>\s*标题[:：]\s*([^\n]+)\s*时间[:：]\s*([^\n]+)\s*内容[:：]\s*([\s\S]*?)\s*<\/日记>/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneData(data) {
  if (typeof structuredClone === 'function') {
    return structuredClone(data);
  }

  return JSON.parse(JSON.stringify(data));
}

function getTargetSettings() {
  if (!extension_settings[targetExtensionName]) {
    extension_settings[targetExtensionName] = {};
  }

  return extension_settings[targetExtensionName];
}

function getObjectCount(data) {
  return Object.keys(isPlainObject(data) ? data : {}).length;
}

function getGroupedItemCount(data) {
  if (!isPlainObject(data)) {
    return 0;
  }

  return Object.values(data).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
}

function getExchangeStats(exchangeDiaries) {
  const threads = isPlainObject(exchangeDiaries?.threads) ? exchangeDiaries.threads : {};
  return {
    threads: Object.keys(threads).length,
    entries: Object.values(threads).reduce((sum, thread) => sum + (Array.isArray(thread?.entries) ? thread.entries.length : 0), 0),
  };
}

function getSettingsDataCount(target, data) {
  if (target.settingsKey === 'exchangeDiaries') {
    return getExchangeStats(data).threads;
  }

  return getGroupedItemCount(data);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function encodeJsonToBase64(data) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(data, null, 2)));
}

function buildFilePayload(target, data) {
  return {
    schemaVersion: 1,
    kind: target.kind,
    updatedAt: new Date().toISOString(),
    data: isPlainObject(data) ? data : {},
  };
}

function normalizeFilePath(path) {
  return String(path || '').replace(/^\/+/, '');
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

async function fileExists(target) {
  const path = `user/files/${target.fileName}`;
  const response = await fetch('/api/files/verify', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ urls: [path] }),
  });

  if (!response.ok) {
    throw new Error(`${target.fileName}: 检查文件是否存在失败，HTTP ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  return result[path] === true || result[`/${path}`] === true;
}

function unwrapFilePayload(target, payload) {
  if (!isPlainObject(payload)) {
    throw new Error(`${target.fileName}: 文件内容不是 JSON 对象`);
  }

  if (payload.kind === target.kind && isPlainObject(payload.data)) {
    return cloneData(payload.data);
  }

  if (payload.schemaVersion !== undefined || payload.kind !== undefined || payload.data !== undefined) {
    throw new Error(`${target.fileName}: 文件格式不是日记本 ${target.label} 数据`);
  }

  return cloneData(payload);
}

async function readJsonFile(target) {
  const path = `user/files/${target.fileName}`;
  const response = await fetch(`/${path}?diaryMigration=${Date.now()}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`${target.fileName}: 读取已有文件失败，HTTP ${response.status} ${await response.text()}`);
  }

  return unwrapFilePayload(target, await response.json());
}

async function uploadJsonFile(target, data) {
  const response = await fetch('/api/files/upload', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      name: target.fileName,
      data: encodeJsonToBase64(buildFilePayload(target, data)),
    }),
  });

  if (!response.ok) {
    throw new Error(`${target.fileName}: HTTP ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  return normalizeFilePath(result.path || `user/files/${target.fileName}`);
}

function parseDiaryContent(content) {
  if (!content) {
    return null;
  }

  DIARY_REGEX.lastIndex = 0;
  const match = DIARY_REGEX.exec(content);
  if (!match) {
    return null;
  }

  const title = match[1].trim();
  const time = match[2].trim();
  const diaryContent = match[3].trim();

  if (!title || !time || !diaryContent) {
    return null;
  }

  if (title.includes('{{') || time.includes('{{') || diaryContent.includes('{{')) {
    return null;
  }

  return {
    title,
    time,
    content: diaryContent,
  };
}

async function migrateDiariesFromWorldInfo() {
  const worldInfo = await loadWorldInfo('日记本');
  const migratedDiaries = {};
  let successCount = 0;
  let failCount = 0;

  if (!worldInfo?.entries) {
    return { data: migratedDiaries, successCount, failCount };
  }

  for (const uid in worldInfo.entries) {
    const entry = worldInfo.entries[uid];
    const authorName = Array.isArray(entry.key) && entry.key.length > 0 ? entry.key[0] : null;
    const commentParts = entry.comment ? entry.comment.split('-') : [];

    if (!authorName || commentParts.length < 2 || !entry.content) {
      failCount += 1;
      continue;
    }

    const title = commentParts[0].trim();
    const time = commentParts.slice(1).join('-').trim();

    if (!title || !time) {
      failCount += 1;
      continue;
    }

    if (!migratedDiaries[authorName]) {
      migratedDiaries[authorName] = [];
    }

    migratedDiaries[authorName].push({
      id: migratedDiaries[authorName].length + 1,
      title,
      time,
      content: entry.content,
      author: authorName,
      createTime: new Date().toISOString(),
    });
    successCount += 1;
  }

  return { data: migratedDiaries, successCount, failCount };
}

async function migrateRecycleBinFromWorldInfo() {
  const worldInfo = await loadWorldInfo('回收站');
  const migratedRecycleBin = {};
  let successCount = 0;
  let failCount = 0;

  if (!worldInfo?.entries) {
    return { data: migratedRecycleBin, successCount, failCount };
  }

  for (const uid in worldInfo.entries) {
    const entry = worldInfo.entries[uid];
    const authorName = Array.isArray(entry.key) && entry.key.length > 0 ? entry.key[0] : null;

    if (!authorName || !entry.comment?.includes('-回收站') || !entry.content) {
      failCount += 1;
      continue;
    }

    if (!migratedRecycleBin[authorName]) {
      migratedRecycleBin[authorName] = [];
    }

    migratedRecycleBin[authorName].push({
      id: migratedRecycleBin[authorName].length + 1,
      content: entry.content,
      failureReason: parseDiaryContent(entry.content) ? '日记格式解析失败' : '世界书保存失败',
      saveTime: new Date().toLocaleString('zh-CN'),
    });
    successCount += 1;
  }

  return { data: migratedRecycleBin, successCount, failCount };
}

function getMaxNumericId(items) {
  return (Array.isArray(items) ? items : []).reduce((maxId, item) => Math.max(maxId, Number(item?.id) || 0), 0);
}

function mergeGroupedItems(existingData, importedData, createItem, getDuplicateKey = null) {
  const merged = cloneData(isPlainObject(existingData) ? existingData : {});
  let addedCount = 0;
  let duplicateCount = 0;
  let sourceCount = 0;

  for (const characterName in isPlainObject(importedData) ? importedData : {}) {
    const importedItems = Array.isArray(importedData[characterName]) ? importedData[characterName] : [];
    sourceCount += importedItems.length;

    if (!Array.isArray(merged[characterName])) {
      merged[characterName] = [];
    }

    const seenKeys = new Set(
      getDuplicateKey
        ? merged[characterName].map(item => getDuplicateKey(item, characterName)).filter(Boolean)
        : [],
    );
    let nextId = getMaxNumericId(merged[characterName]) + 1;

    importedItems.forEach(item => {
      const duplicateKey = getDuplicateKey ? getDuplicateKey(item, characterName) : null;
      if (duplicateKey && seenKeys.has(duplicateKey)) {
        duplicateCount += 1;
        return;
      }

      const nextItem = createItem(item, nextId, characterName);
      merged[characterName].push(nextItem);
      if (duplicateKey) {
        seenKeys.add(duplicateKey);
      }
      nextId += 1;
      addedCount += 1;
    });
  }

  return {
    data: merged,
    addedCount,
    duplicateCount,
    sourceCount,
    totalCount: getGroupedItemCount(merged),
  };
}

function getDiaryDuplicateKey(item, characterName) {
  return [
    normalizeText(characterName),
    normalizeText(item?.author || characterName),
    normalizeText(item?.title),
    normalizeText(item?.time),
    normalizeText(item?.content),
  ].join('\u0001');
}

function getRecycleBinDuplicateKey(item, characterName) {
  return [
    normalizeText(characterName),
    normalizeText(item?.content),
    normalizeText(item?.failureReason),
    normalizeText(item?.saveTime),
  ].join('\u0001');
}

const DEFAULT_EXCHANGE_DIARIES = {
  threads: {},
  config: {
    enableNotifications: true,
    triggerWindowMin: 1,
    triggerWindowMax: 10,
    maxRerollsPerEntry: 5,
    ghostwritePrompt: '',
  },
  threadCounters: {},
  triggeredEntries: {},
};

function createDefaultExchangeDiaries() {
  return {
    threads: {},
    config: { ...DEFAULT_EXCHANGE_DIARIES.config },
    threadCounters: {},
    triggeredEntries: {},
  };
}

function normalizeExchangeDiaries(data) {
  const safeData = isPlainObject(data) ? data : {};
  return {
    ...createDefaultExchangeDiaries(),
    ...safeData,
    threads: isPlainObject(safeData.threads) ? safeData.threads : {},
    config: {
      ...DEFAULT_EXCHANGE_DIARIES.config,
      ...(isPlainObject(safeData.config) ? safeData.config : {}),
    },
    threadCounters: isPlainObject(safeData.threadCounters) ? safeData.threadCounters : {},
    triggeredEntries: isPlainObject(safeData.triggeredEntries) ? safeData.triggeredEntries : {},
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function getExchangeThreadDuplicateKey(thread) {
  return [
    normalizeText(thread?.characterName),
    normalizeText(thread?.threadName),
    normalizeText(thread?.createdAt),
    normalizeText(thread?.status),
    stableStringify(Array.isArray(thread?.entries) ? thread.entries : []),
  ].join('\u0001');
}

function getNextExchangeThreadNumber(exchangeDiaries, characterName) {
  const counterNumber = Number(exchangeDiaries.threadCounters?.[characterName]) || 1;
  const maxExistingThreadNumber = Object.values(exchangeDiaries.threads || {})
    .filter(thread => thread?.characterName === characterName)
    .reduce((maxThreadNumber, thread) => Math.max(maxThreadNumber, Number(thread.threadNumber) || 0), 0);

  return Math.max(counterNumber, maxExistingThreadNumber + 1, 1);
}

function allocateExchangeThreadId(exchangeDiaries, characterName) {
  let threadNumber = getNextExchangeThreadNumber(exchangeDiaries, characterName);
  let threadId = `${characterName}-${threadNumber}`;

  while (exchangeDiaries.threads[threadId]) {
    threadNumber += 1;
    threadId = `${characterName}-${threadNumber}`;
  }

  exchangeDiaries.threadCounters[characterName] = threadNumber + 1;
  return { threadId, threadNumber };
}

function updateExchangeThreadCounter(exchangeDiaries, characterName, threadNumber) {
  const nextThreadNumber = (Number(threadNumber) || 0) + 1;
  exchangeDiaries.threadCounters[characterName] = Math.max(
    Number(exchangeDiaries.threadCounters[characterName]) || 1,
    nextThreadNumber,
  );
}

function mergeExchangeDiaries(existingData, importedData) {
  const merged = normalizeExchangeDiaries(cloneData(existingData));
  const imported = normalizeExchangeDiaries(importedData);
  const existingThreadKeys = new Set(Object.values(merged.threads).map(getExchangeThreadDuplicateKey).filter(Boolean));
  let addedCount = 0;
  let duplicateCount = 0;
  let renamedCount = 0;

  merged.config = {
    ...imported.config,
    ...merged.config,
  };
  merged.triggeredEntries = {
    ...imported.triggeredEntries,
    ...merged.triggeredEntries,
  };

  Object.entries(imported.threadCounters || {}).forEach(([characterName, counter]) => {
    merged.threadCounters[characterName] = Math.max(
      Number(merged.threadCounters[characterName]) || 1,
      Number(counter) || 1,
    );
  });

  Object.entries(imported.threads || {}).forEach(([threadId, thread]) => {
    const characterName = thread?.characterName || threadId.split('-')[0] || '未知角色';
    const threadKey = getExchangeThreadDuplicateKey(thread);

    if (threadKey && existingThreadKeys.has(threadKey)) {
      duplicateCount += 1;
      return;
    }

    if (merged.threads[threadId]) {
      const nextThread = allocateExchangeThreadId(merged, characterName);
      merged.threads[nextThread.threadId] = {
        ...thread,
        threadId: nextThread.threadId,
        threadNumber: nextThread.threadNumber,
        characterName,
      };
      renamedCount += 1;
      addedCount += 1;
      existingThreadKeys.add(threadKey);
      return;
    }

    merged.threads[threadId] = {
      ...thread,
      threadId,
      characterName,
    };
    updateExchangeThreadCounter(merged, characterName, thread.threadNumber);
    addedCount += 1;
    existingThreadKeys.add(threadKey);
  });

  Object.values(merged.threads || {}).forEach(thread => {
    updateExchangeThreadCounter(merged, thread.characterName, thread.threadNumber);
  });

  const sourceStats = getExchangeStats(imported);
  const totalStats = getExchangeStats(merged);
  return {
    data: merged,
    sourceCount: sourceStats.threads,
    sourceEntries: sourceStats.entries,
    addedCount,
    duplicateCount,
    renamedCount,
    totalCount: totalStats.threads,
    totalEntries: totalStats.entries,
  };
}

async function runWorldToSettingsMigration() {
  const settings = getTargetSettings();
  const diaryMigration = await migrateDiariesFromWorldInfo();
  const recycleMigration = await migrateRecycleBinFromWorldInfo();

  settings.diaries = mergeGroupedItems(settings.diaries, diaryMigration.data, (item, id, characterName) => ({
    ...item,
    id,
    author: item.author || characterName,
    createTime: item.createTime || new Date().toISOString(),
  })).data;

  settings.recycleBin = mergeGroupedItems(settings.recycleBin, recycleMigration.data, item => ({
    ...item,
  })).data;

  saveSettingsDebounced();

  return {
    mode: MODES.worldToSettings,
    diaries: diaryMigration,
    recycleBin: recycleMigration,
    totalDiaries: getGroupedItemCount(settings.diaries),
    totalRecycleBin: getGroupedItemCount(settings.recycleBin),
  };
}

async function runSettingsToFilesMigration() {
  const settings = getTargetSettings();
  const results = [];
  const removedSettingsData = {};

  for (const target of Object.values(FILE_TARGETS)) {
    const settingsData = isPlainObject(settings[target.settingsKey]) ? settings[target.settingsKey] : {};
    removedSettingsData[target.settingsKey] = getSettingsDataCount(target, settingsData);
    const exists = await fileExists(target);
    const existingFileData = exists ? await readJsonFile(target) : {};
    let mergeResult;

    if (target.settingsKey === 'diaries') {
      mergeResult = mergeGroupedItems(
        existingFileData,
        settingsData,
        (item, id, characterName) => ({
          ...item,
          id,
          author: item.author || characterName,
          createTime: item.createTime || new Date().toISOString(),
        }),
        getDiaryDuplicateKey,
      );
    } else if (target.settingsKey === 'recycleBin') {
      mergeResult = mergeGroupedItems(
        existingFileData,
        settingsData,
        (item, id) => ({
          ...item,
          id,
          saveTime: item.saveTime || new Date().toLocaleString('zh-CN'),
        }),
        getRecycleBinDuplicateKey,
      );
    } else {
      mergeResult = mergeExchangeDiaries(existingFileData, settingsData);
    }

    const path = await uploadJsonFile(target, mergeResult.data);
    results.push({
      label: target.label,
      fileName: target.fileName,
      path,
      existed: exists,
      ...mergeResult,
      data: undefined,
    });
  }

  Object.values(FILE_TARGETS).forEach(target => {
    delete settings[target.settingsKey];
  });
  saveSettingsDebounced();

  return {
    mode: MODES.settingsToFiles,
    files: results,
    removedSettingsData,
  };
}

function buildCheckText(mode) {
  const settings = getTargetSettings();
  const diaries = settings.diaries || {};
  const recycleBin = settings.recycleBin || {};
  const exchangeStats = getExchangeStats(settings.exchangeDiaries);

  if (mode === MODES.settingsToFiles) {
    return [
      `settings 中普通日记：${getGroupedItemCount(diaries)} 篇，角色 ${getObjectCount(diaries)} 个`,
      `settings 中交换日记：${exchangeStats.threads} 个系列，${exchangeStats.entries} 个条目`,
      `settings 中回收站：${getGroupedItemCount(recycleBin)} 条，角色 ${getObjectCount(recycleBin)} 个`,
      '执行后会写入 user/files 下的 3 个独立 JSON 文件。',
      '如果目标文件已经存在，工具会先读取已有文件，再把 settings 数据合并进去；能识别的重复日记会跳过。',
      '三份文件全部写入成功后，会删除 settings 里的普通日记、交换日记、回收站旧数据；不会删除主题、预设等其它插件设置。',
    ].join('\n');
  }

  return [
    '将读取世界书“日记本”和“回收站”，合并到 sillytavernDIARY 的 settings 数据中。',
    `当前 settings 普通日记：${getGroupedItemCount(diaries)} 篇`,
    `当前 settings 回收站：${getGroupedItemCount(recycleBin)} 条`,
    '执行后不会删除世界书原始数据。',
  ].join('\n');
}

function setResult(text, type = 'info') {
  $('#diary-migration-result').removeClass('success error info').addClass(type).text(text);
}

function updateCheckResult() {
  const mode = $('#diary-migration-mode').val();
  $('#diary-migration-check').text(buildCheckText(mode));
  setResult('', 'info');
}

async function runSelectedMigration() {
  const mode = $('#diary-migration-mode').val();

  if (mode === MODES.settingsToFiles) {
    const result = await runSettingsToFilesMigration();
    return [
      '文件迁移完成：',
      ...result.files.map(file => {
        const parts = [
          `${file.label} -> ${file.path}`,
          file.existed ? '已合并已有文件' : '已新建文件',
          `settings 来源 ${file.sourceCount} 条`,
          `新增 ${file.addedCount} 条`,
          `跳过重复 ${file.duplicateCount} 条`,
          `文件内现有总数 ${file.totalCount} 条`,
        ];

        if (file.renamedCount) {
          parts.push(`ID 冲突改名 ${file.renamedCount} 个系列`);
        }
        if (file.totalEntries !== undefined) {
          parts.push(`交换日记条目总数 ${file.totalEntries} 条`);
        }

        return parts.join('，');
      }),
      `已删除 settings 旧数据：普通日记 ${result.removedSettingsData.diaries || 0} 条，交换日记 ${result.removedSettingsData.exchangeDiaries || 0} 个系列，回收站 ${result.removedSettingsData.recycleBin || 0} 条`,
      '已保留主题、预设、自动日记等其它 settings 配置。',
    ].join('\n');
  }

  const result = await runWorldToSettingsMigration();
  return [
    '世界书迁移完成：',
    `新增普通日记成功 ${result.diaries.successCount} 篇，跳过 ${result.diaries.failCount} 篇`,
    `新增回收站成功 ${result.recycleBin.successCount} 条，跳过 ${result.recycleBin.failCount} 条`,
    `当前 settings 普通日记总数 ${result.totalDiaries} 篇`,
    `当前 settings 回收站总数 ${result.totalRecycleBin} 条`,
  ].join('\n');
}

function createSettingsUi() {
  return `
    <div class="diary-migration-tool-settings">
      <h3>日记本数据迁移工具</h3>
      <div class="diary-migration-row">
        <label for="diary-migration-mode">迁移模式</label>
        <select id="diary-migration-mode" class="text_pole">
          <option value="${MODES.settingsToFiles}">settings -> 独立文件存储</option>
          <option value="${MODES.worldToSettings}">世界书 -> settings</option>
        </select>
      </div>
      <div class="diary-migration-panel">
        <div class="diary-migration-panel-title">检查结果</div>
        <pre id="diary-migration-check"></pre>
      </div>
      <div class="diary-migration-actions">
        <button id="diary-migration-refresh" class="menu_button">重新检查</button>
        <button id="diary-migration-run" class="menu_button">执行迁移</button>
      </div>
      <pre id="diary-migration-result" class="info"></pre>
    </div>
  `;
}

jQuery(() => {
  console.log('[Diary Migration Tool] Loaded');

  if ($('.diary-migration-tool-settings').length === 0) {
    $('#extensions_settings2').append(createSettingsUi());
  }

  updateCheckResult();

  $('#diary-migration-mode').off(`change.${extensionName}`).on(`change.${extensionName}`, updateCheckResult);
  $('#diary-migration-refresh').off(`click.${extensionName}`).on(`click.${extensionName}`, updateCheckResult);
  $('#diary-migration-run').off(`click.${extensionName}`).on(`click.${extensionName}`, async function () {
    const $button = $(this);
    $button.prop('disabled', true).text('迁移中...');
    setResult('正在执行，请稍等。', 'info');

    try {
      const resultText = await runSelectedMigration();
      updateCheckResult();
      setResult(resultText, 'success');
      toastr.success('迁移完成', '日记本迁移工具');
    } catch (error) {
      console.error('[Diary Migration Tool] Migration failed:', error);
      setResult(`迁移失败：${error.message}`, 'error');
      toastr.error(`迁移失败：${error.message}`, '日记本迁移工具');
    } finally {
      $button.prop('disabled', false).text('执行迁移');
    }
  });
});
