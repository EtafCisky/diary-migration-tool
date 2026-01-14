/**
 * ============================================================================
 * 日记本数据迁移工具 (diary-migration-tool)
 * ============================================================================
 *
 * @author    Etaf Cisky
 * @version   1.0.0
 * @description 将旧版日记本插件的世界书数据迁移到新版 extension_settings 存储格式
 *
 * ============================================================================
 * 功能说明
 * ============================================================================
 *
 * 本工具用于一次性迁移数据，迁移完成后可以卸载。
 *
 * 迁移内容：
 * 1. 从"日记本"世界书迁移日记数据
 * 2. 从"回收站"世界书迁移回收站数据
 *
 * ============================================================================
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { loadWorldInfo } from '../../../world-info.js';

const extensionName = 'diary-migration-tool';
const targetExtensionName = 'sillytavernDIARY';

// 日记内容正则表达式
const DIARY_REGEX = /<日记>\s*标题：([^\n]+)\s*时间：([^\n]+)\s*内容：([\s\S]*?)\s*<\/日记>/g;

/**
 * 解析日记内容
 * @param {string} content - AI生成的内容
 * @returns {Object|null} 解析后的日记数据 {title, time, content}
 */
function parseDiaryContent(content) {
  if (!content) return null;

  // 重置正则表达式的lastIndex
  DIARY_REGEX.lastIndex = 0;

  const match = DIARY_REGEX.exec(content);
  if (!match) {
    console.log('[迁移工具] 日记格式解析失败');
    return null;
  }

  const title = match[1].trim();
  const time = match[2].trim();
  const diaryContent = match[3].trim();

  // 验证内容有效性
  if (!title || !time || !diaryContent) {
    console.log('[迁移工具] 日记内容不完整');
    return null;
  }

  // 过滤掉模板格式（如 {{标题}}）
  if (title.includes('{{') || time.includes('{{') || diaryContent.includes('{{')) {
    console.log('[迁移工具] 检测到模板格式，跳过');
    return null;
  }

  return {
    title: title,
    time: time,
    content: diaryContent,
  };
}

/**
 * 从世界书迁移日记数据
 * @returns {Promise<Object>} 迁移后的日记数据
 */
async function migrateDiariesFromWorldInfo() {
  console.log('[迁移工具] 开始迁移日记数据...');

  try {
    // 加载"日记本"世界书
    const worldInfo = await loadWorldInfo('日记本');

    if (!worldInfo || !worldInfo.entries) {
      console.log('[迁移工具] 未找到"日记本"世界书');
      return {};
    }

    const migratedDiaries = {};
    let successCount = 0;
    let failCount = 0;

    // 遍历所有条目
    for (const uid in worldInfo.entries) {
      const entry = worldInfo.entries[uid];

      // 获取作者名（从关键字获取）
      const authorName = entry.key && entry.key.length > 0 ? entry.key[0] : null;

      if (!authorName) {
        console.warn('[迁移工具] 条目缺少作者名，跳过:', entry.comment);
        failCount++;
        continue;
      }

      // 解析条目名称（格式：标题-时间）
      const commentParts = entry.comment ? entry.comment.split('-') : [];
      if (commentParts.length < 2) {
        console.warn('[迁移工具] 条目名称格式不正确，跳过:', entry.comment);
        failCount++;
        continue;
      }

      const title = commentParts[0].trim();
      const time = commentParts.slice(1).join('-').trim();
      const content = entry.content || '';

      // 验证数据完整性
      if (!title || !time || !content) {
        console.warn('[迁移工具] 条目数据不完整，跳过:', entry.comment);
        failCount++;
        continue;
      }

      // 初始化角色的日记数组
      if (!migratedDiaries[authorName]) {
        migratedDiaries[authorName] = [];
      }

      // 获取下一个 ID
      const nextId =
        migratedDiaries[authorName].length > 0 ? Math.max(...migratedDiaries[authorName].map(d => d.id)) + 1 : 1;

      // 添加日记
      migratedDiaries[authorName].push({
        id: nextId,
        title: title,
        time: time,
        content: content,
        author: authorName,
        createTime: new Date().toISOString(),
      });

      successCount++;
      console.log(`[迁移工具] 迁移日记: ${authorName} - ${title}`);
    }

    console.log(`[迁移工具] 日记迁移完成: 成功 ${successCount} 篇, 失败 ${failCount} 篇`);
    return migratedDiaries;
  } catch (error) {
    console.error('[迁移工具] 迁移日记数据失败:', error);
    return {};
  }
}

/**
 * 从世界书迁移回收站数据
 * @returns {Promise<Object>} 迁移后的回收站数据
 */
async function migrateRecycleBinFromWorldInfo() {
  console.log('[迁移工具] 开始迁移回收站数据...');

  try {
    // 加载"回收站"世界书
    const worldInfo = await loadWorldInfo('回收站');

    if (!worldInfo || !worldInfo.entries) {
      console.log('[迁移工具] 未找到"回收站"世界书');
      return {};
    }

    const migratedRecycleBin = {};
    let successCount = 0;
    let failCount = 0;

    // 遍历所有条目
    for (const uid in worldInfo.entries) {
      const entry = worldInfo.entries[uid];

      // 获取作者名（从关键字获取）
      const authorName = entry.key && entry.key.length > 0 ? entry.key[0] : null;

      if (!authorName) {
        console.warn('[迁移工具] 回收站条目缺少作者名，跳过:', entry.comment);
        failCount++;
        continue;
      }

      // 验证条目名称格式（格式：作者名-回收站）
      if (!entry.comment || !entry.comment.includes('-回收站')) {
        console.warn('[迁移工具] 回收站条目名称格式不正确，跳过:', entry.comment);
        failCount++;
        continue;
      }

      const content = entry.content || '';

      if (!content) {
        console.warn('[迁移工具] 回收站条目内容为空，跳过:', entry.comment);
        failCount++;
        continue;
      }

      // 初始化角色的回收站数组
      if (!migratedRecycleBin[authorName]) {
        migratedRecycleBin[authorName] = [];
      }

      // 获取下一个 ID
      const nextId =
        migratedRecycleBin[authorName].length > 0 ? Math.max(...migratedRecycleBin[authorName].map(r => r.id)) + 1 : 1;

      // 尝试解析日记格式（如果是日记格式失败导致的回收站条目）
      const parsedDiary = parseDiaryContent(content);
      const failureReason = parsedDiary ? '日记格式解析失败' : '世界书保存失败';

      // 添加回收站条目
      migratedRecycleBin[authorName].push({
        id: nextId,
        content: content,
        failureReason: failureReason,
        saveTime: new Date().toLocaleString('zh-CN'),
      });

      successCount++;
      console.log(`[迁移工具] 迁移回收站条目: ${authorName} - ${nextId}`);
    }

    console.log(`[迁移工具] 回收站迁移完成: 成功 ${successCount} 条, 失败 ${failCount} 条`);
    return migratedRecycleBin;
  } catch (error) {
    console.error('[迁移工具] 迁移回收站数据失败:', error);
    return {};
  }
}

/**
 * 执行完整的数据迁移
 */
async function performMigration() {
  console.log('[迁移工具] ========== 开始数据迁移 ==========');

  try {
    // 检查目标插件是否存在
    if (!extension_settings[targetExtensionName]) {
      extension_settings[targetExtensionName] = {};
    }

    // 检查是否已经有数据
    const existingDiaries = extension_settings[targetExtensionName].diaries || {};
    const existingRecycleBin = extension_settings[targetExtensionName].recycleBin || {};

    const hasDiaries = Object.keys(existingDiaries).length > 0;
    const hasRecycleBin = Object.keys(existingRecycleBin).length > 0;

    if (hasDiaries || hasRecycleBin) {
      const confirmOverwrite = confirm(
        '检测到目标位置已有数据！\n\n' +
          `现有日记: ${Object.keys(existingDiaries).length} 个角色\n` +
          `现有回收站: ${Object.keys(existingRecycleBin).length} 个角色\n\n` +
          '是否继续迁移？（新数据会合并到现有数据中）',
      );

      if (!confirmOverwrite) {
        toastr.info('已取消迁移', '迁移工具');
        return;
      }
    }

    // 迁移日记数据
    const migratedDiaries = await migrateDiariesFromWorldInfo();

    // 迁移回收站数据
    const migratedRecycleBin = await migrateRecycleBinFromWorldInfo();

    // 合并数据
    const finalDiaries = { ...existingDiaries };
    const finalRecycleBin = { ...existingRecycleBin };

    // 合并日记
    for (const authorName in migratedDiaries) {
      if (!finalDiaries[authorName]) {
        finalDiaries[authorName] = [];
      }
      finalDiaries[authorName].push(...migratedDiaries[authorName]);
    }

    // 合并回收站
    for (const authorName in migratedRecycleBin) {
      if (!finalRecycleBin[authorName]) {
        finalRecycleBin[authorName] = [];
      }
      finalRecycleBin[authorName].push(...migratedRecycleBin[authorName]);
    }

    // 保存到 extension_settings
    extension_settings[targetExtensionName].diaries = finalDiaries;
    extension_settings[targetExtensionName].recycleBin = finalRecycleBin;
    saveSettingsDebounced();

    // 统计结果
    const totalDiaries = Object.values(finalDiaries).reduce((sum, arr) => sum + arr.length, 0);
    const totalRecycleBin = Object.values(finalRecycleBin).reduce((sum, arr) => sum + arr.length, 0);

    console.log('[迁移工具] ========== 迁移完成 ==========');
    console.log(`[迁移工具] 日记总数: ${totalDiaries}`);
    console.log(`[迁移工具] 回收站总数: ${totalRecycleBin}`);

    toastr.success(
      `迁移完成！\n\n` +
        `日记: ${totalDiaries} 篇\n` +
        `回收站: ${totalRecycleBin} 条\n\n` +
        `数据已保存到 extension_settings\n` +
        `现在可以安全卸载本迁移工具了`,
      '迁移工具',
      { timeOut: 10000 },
    );
  } catch (error) {
    console.error('[迁移工具] 迁移过程出错:', error);
    toastr.error(`迁移失败: ${error.message}`, '迁移工具');
  }
}

/**
 * 插件初始化
 */
jQuery(async () => {
  console.log('[迁移工具] 插件加载完成');

  // 添加设置UI
  const settingsHtml = `
    <div class="migration-tool-settings">
      <h3>📦 日记本数据迁移工具</h3>
      <div class="migration-info">
        <p><strong>功能说明：</strong></p>
        <p>本工具用于将旧版日记本插件的世界书数据迁移到新版 extension_settings 存储格式。</p>
        <br>
        <p><strong>迁移内容：</strong></p>
        <ul>
          <li>✅ 从"日记本"世界书迁移日记数据</li>
          <li>✅ 从"回收站"世界书迁移回收站数据</li>
        </ul>
        <br>
        <p><strong>使用步骤：</strong></p>
        <ol>
          <li>确保已安装新版日记本插件（sillytavernDIARY）</li>
          <li>点击下方"开始迁移"按钮</li>
          <li>等待迁移完成</li>
          <li>验证数据迁移成功后，可以卸载本工具</li>
        </ol>
        <br>
        <p><strong>⚠️ 注意事项：</strong></p>
        <ul>
          <li>迁移过程不会删除原世界书数据</li>
          <li>如果目标位置已有数据，新数据会合并进去</li>
          <li>建议在迁移前备份 SillyTavern 的 settings.json 文件</li>
          <li>迁移完成后可以安全卸载本工具</li>
        </ul>
      </div>
      <div class="migration-actions">
        <button id="start-migration-btn" class="menu_button">
          🚀 开始迁移
        </button>
      </div>
    </div>
  `;

  $('#extensions_settings2').append(settingsHtml);

  // 绑定按钮事件
  $('#start-migration-btn').on('click', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true).text('⏳ 迁移中...');

    try {
      await performMigration();
    } finally {
      $btn.prop('disabled', false).text('🚀 开始迁移');
    }
  });

  console.log('[迁移工具] UI 初始化完成');
});
