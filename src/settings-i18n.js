// Chinese keys keep server messages and UI translations aligned. Model names and IDs are never translated.
const messages = {
  '设置。': 'Settings.',
  '最终答复': 'Final answer',
  '使用独立的最终答复模型': 'Use a separate model for the final answer',
  '工作模型负责执行任务；所选模型只改写最终答复。关闭后保留工作模型的原答复。': 'Your working model performs the task. The selected model only rewrites the final answer. Turn this off to keep the working model’s original answer.',
  '最终答复模型': 'Final answer model',
  '刷新': 'Refresh',
  '从供应商刷新模型目录': 'Refresh the model list from providers',
  '搜索模型或提供商': 'Search models or providers',
  '正在读取模型…': 'Loading models…',
  '正在读取…': 'Loading…',
  '执行任务': 'Perform task',
  '整理答复': 'Rewrite final answer',
  '保留原答复': 'Keep original answer',
  '模型分工': 'Model roles',
  '然后': 'then',
  '重试': 'Retry',
  '恢复整理状态': 'Reset rewrite state',
  '正在连接…': 'Connecting…',
  '选择模型': 'Choose a model',
  '当前模型': 'Current working model',
  '当前模型不可用，请重新选择：': 'This model is unavailable. Choose another: ',
  '没有找到匹配的模型': 'No matching models',
  '还没有可用的模型': 'No models available',
  '试试其他名称。': 'Try a different model or provider name.',
  '先在 Pi 中登记具体模型并配置认证，再重新打开设置。': 'Add a model and configure its credentials in Pi, then refresh this page.',
  '上下文 ': 'Context window: ',
  '选择模型后保存': 'Choose a model to save',
  '请选择最终答复模型。': 'Choose a final answer model.',
  '正在保存…': 'Saving…',
  '已自动保存': 'Saved automatically',
  '设置已变化': 'Settings changed',
  '尚未保存': 'Changes not saved',
  '最近刷新：': 'Last refreshed: ',
  '任务进行中': 'Task in progress · changes can be saved when it finishes',
  '改动自动保存': 'Changes save automatically',
  '连接失败': 'Connection failed',
  '刷新失败': 'Refresh failed',
  '模型目录已刷新': 'Model list refreshed',
  '最终整理状态已恢复，请重试保存修改。': 'Rewrite state reset. Retry saving your changes.',
  '最终整理状态已恢复': 'Rewrite state reset',
  '恢复失败': 'Could not reset rewrite state',
  '设置链接已失效，请回到 Pi 重新打开设置。': 'This settings link has expired. Run /pi-final-model in Pi to open a new one.',
  '连接已断开，请回到 Pi 重新打开设置。': 'Could not connect to Pi. Run /pi-final-model in Pi to reopen settings.',
  '无法保存，请稍后重试。': 'Could not save changes. Please try again.',
  '请求格式无效。': 'Invalid request format. Reopen settings in Pi and try again.',
  '设置内容过长。': 'The settings request is too large. Reopen settings in Pi and try again.',
  '设置页已关闭，请重新打开。': 'This settings page has closed. Run /pi-final-model in Pi to reopen it.',
  '不支持的操作。': 'This action is not supported. Reopen settings in Pi and try again.',
  '设置格式无效。': 'Invalid settings format. Reopen settings in Pi and try again.',
  '无法保存，请检查配置文件权限后重试。': 'Could not save settings. Check write permissions for final-model.json and try again.',
  '配置文件无效，请先修复配置文件。': 'The configuration file is invalid. Fix final-model.json, then reload this page.',
  '会话已切换，请重新打开设置。': 'The Pi session has changed. Run /pi-final-model in Pi to reopen settings.',
  '任务正在进行，结束后即可保存。': 'Pi is running a task. Wait for it to finish, then try again.',
  '暂时无法恢复最终整理状态，请稍后重试。': 'Could not reset the rewrite state. Please try again later.',
  '请选择具体模型。': 'Choose an individual model, rather than a model group.',
  '模型已不可用，请重新选择。': 'This model is no longer available. Choose another model.',
  '请先选择最终答复模型。': 'Choose a final answer model before enabling this option.',
  '请先恢复最终整理状态，再保存设置。': 'Reset the rewrite state before saving settings.',
  '会话状态已变化，请重试。': 'The Pi session state has changed. Click Retry to reload settings.',
  '另一会话正在保存设置，请稍后重新加载。': 'Another Pi session is saving settings. Wait a moment, then click Retry.',
  '设置已被另一会话修改，请重新加载后再保存。': 'Another Pi session changed these settings. Click Retry to reload before making changes.',
  '模型目录刷新失败，请稍后重试。': 'Could not refresh the model list. Please try again later.',
  '配置文件已丢失，本轮保留原答复；请打开设置重新配置。': 'The configuration file is missing. The original answer was kept. Configure the final answer model again.',
  '配置无法读取或格式无效，已停用；原文件未覆盖，请修复后重新打开设置。': 'The configuration could not be read, so rewriting is disabled. Fix final-model.json and reopen settings. The file was not overwritten.',
  '无法确认整理结果已保存，暂不显示成功标记；请检查会话文件权限和磁盘空间。': 'Could not confirm that the rewritten answer was saved. Check session file permissions and available disk space. No success marker is shown.',
  '请在设置中选择具体模型。': 'Choose an individual model in settings.',
  '最终模型未配置认证，请使用 /login 后重试。': 'The final answer model has no credentials. Run /login in Pi, then try again.',
  '当前上下文包含图片，最终模型不支持图片；已保留原答复，请选择支持图片的模型。': 'This conversation includes images, which the final answer model cannot read. The original answer was kept. Choose a model that supports images.',
  '最终模型上下文不足或容量未知，已保留原答复；请先压缩或选择更大模型。': 'The final answer model’s context window is too small or unknown. The original answer was kept. Compact the conversation or choose a model with a larger context window.',
  '界面语言': 'Interface language',
  'Pi 报告了问题。请查看 Pi 中的警告和诊断日志。': 'Pi reported a problem. Check the warning in Pi and the diagnostic log.',
};
let language = 'en';
try { if (document.cookie.split('; ').includes('pi-final-model-language=zh-CN')) language = 'zh-CN'; } catch { /* English remains the default. */ }
function t(text) { return language === 'zh-CN' ? text : messages[text] ?? text; }
function serverMessage(text) {
  if (!text || language === 'zh-CN') return text;
  if (messages[text]) return messages[text];
  const missing = text.match(/^找不到 (.+)，已保留原答复；请在 \/pi-final-model 重新选择或刷新目录。$/);
  if (missing) return `Could not find ${missing[1]}. The original answer was kept. Choose another model or refresh the list.`;
  const invalid = text.match(/^最终整理未得到完整有效正文，已保留原答复。(.*)$/);
  if (invalid) {
    const actions = {
      '请使用 /login 更新认证。': 'Run /login in Pi to update the credentials.',
      '请确认账号拥有该模型权限，或重新选择模型。': 'Check that your account can access this model, or choose another model.',
      '请检查供应商余额和额度。': 'Check your provider balance and usage limits.',
      '详情见诊断日志。': 'See the diagnostic log for details.',
    };
    return 'The rewrite did not return a complete answer. The original answer was kept. ' + (actions[invalid[1]] || 'Check the warning in Pi.');
  }
  const failed = text.match(/^整理失败（(.+)），已保留原答复。日志：(.+?)(?:；请求：(.+))?$/);
  if (failed) return `The rewrite failed (${failed[1]}). The original answer was kept. Log: ${failed[2]}${failed[3] ? '; Request: ' + failed[3] : ''}`;
  // Unknown diagnostics should not claim that rewriting failed: they may describe configuration or session state.
  if (/[\u3400-\u9fff]/.test(text)) return messages['Pi 报告了问题。请查看 Pi 中的警告和诊断日志。'];
  return text;
}
function translatePage() {
  document.documentElement.lang = language;
  document.title = language === 'en' ? 'Final Model · Settings' : 'Final Model · 设置';
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
    for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
  }
  for (const button of document.querySelectorAll('[data-language]')) button.setAttribute('aria-pressed', String(button.dataset.language === language));
}
translatePage();
