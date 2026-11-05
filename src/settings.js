const $ = id => document.getElementById(id);
const storageKey = 'pi-final-model-token';
let token = location.hash.slice(1);
try {
  if (token) sessionStorage.setItem(storageKey, token);
  else token = sessionStorage.getItem(storageKey) || '';
} catch { /* The fragment still works when storage is unavailable. */ }
history.replaceState(null, '', location.pathname);
$('version').textContent = 'v' + document.documentElement.dataset.version;

const svg = (paths, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const CHECK = svg('<circle cx="12" cy="12" r="11" fill="var(--accent)"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="var(--on-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>', 22);
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LEVEL_NAMES = { inherit: '跟随', off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };

let data;
let draft;
let saved;
let saving = false;
let loading = false;
let revision = 0;
let failed = false;
let provider = 'all';
let promptTimer;
let scrolled = false;
const fields = ['enabled', 'model', 'thinking', 'prompt', 'language'];
const pick = value => Object.fromEntries(fields.map(key => [key, value[key] ?? (key === 'enabled' ? false : null)]));
const equal = (a, b) => !!a && !!b && fields.every(key => a[key] === b[key]);
const dirty = () => draft && !equal(draft, saved);
const selectedModel = () => data?.models.find(model => model.value === draft?.model);

// Theme: an explicit choice is remembered; otherwise follow the system.
const themeCookie = document.cookie.split('; ').find(item => item.startsWith('pi-final-model-theme='))?.split('=')[1];
const systemDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('[data-theme-value]')) button.setAttribute('aria-pressed', String(button.dataset.themeValue === theme));
}
applyTheme(themeCookie === 'dark' || themeCookie === 'light' ? themeCookie : systemDark.matches ? 'dark' : 'light');
systemDark.addEventListener('change', event => { if (!document.cookie.includes('pi-final-model-theme=')) applyTheme(event.matches ? 'dark' : 'light'); });
for (const button of document.querySelectorAll('[data-theme-value]')) button.onclick = () => {
  applyTheme(button.dataset.themeValue);
  try { document.cookie = `pi-final-model-theme=${button.dataset.themeValue}; Path=/; Max-Age=31536000; SameSite=Strict`; } catch { /* Still switches for this page. */ }
};

let statusText = '正在连接…';
let feedbackText = '';
function status(text, state = '') {
  statusText = text;
  $('save-text').textContent = t(text);
  $('save-status').dataset.state = state;
}
function feedback(text, retry = false, recovery = false) {
  feedbackText = text;
  $('feedback').hidden = !text;
  $('message').textContent = serverMessage(text) || '';
  $('retry').hidden = !retry;
  $('recover').hidden = !recovery;
}
async function request(method, body) {
  if (!token) throw Error('设置链接已失效，请回到 Pi 重新打开设置。');
  let response;
  try {
    response = await fetch('/settings', {
      method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
  } catch { throw Error('连接已断开，请回到 Pi 重新打开设置。'); }
  if (response.status === 403 || response.status === 410) throw Error('设置链接已失效，请回到 Pi 重新打开设置。');
  const value = await response.json();
  if (!response.ok) { const error = Error(value.error || '无法保存，请稍后重试。'); error.status = response.status; throw error; }
  return value;
}
function clamp(levels, level) {
  if (levels.includes(level)) return level;
  const index = LEVELS.indexOf(level);
  return LEVELS.slice(index).find(item => levels.includes(item)) ?? LEVELS.slice(0, index).reverse().find(item => levels.includes(item)) ?? 'off';
}
function levelName(level) { return t(LEVEL_NAMES[level] ?? level); }

function renderThinking() {
  const container = $('thinking');
  const model = selectedModel();
  const levels = model?.thinkingLevels ?? LEVELS;
  const options = ['inherit', ...levels];
  container.replaceChildren(...options.map(level => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = levelName(level);
    button.disabled = !draft;
    button.setAttribute('aria-pressed', String((draft?.thinking ?? 'inherit') === level));
    button.onclick = () => { if (!draft) return; draft.thinking = level === 'inherit' ? null : level; change(); };
    return button;
  }));
  const working = data?.workingThinking ?? 'off';
  const requested = draft?.thinking ?? working;
  const effective = clamp(levels, requested);
  let note = draft?.thinking ? '' : t('跟随工作模型，当前为：') + levelName(working);
  if (model && effective !== requested) note = (note ? note + '；' : '') + t('所选模型不支持该档位，实际使用：') + levelName(effective);
  if (model && levels.length === 1) note = t('所选模型不支持思考强度。');
  $('thinking-note').textContent = note;
  $('thinking-note').hidden = !note;
}
function defaultPromptText() {
  return data?.defaultPrompts?.[language] ?? data?.defaultPrompt ?? '';
}
function renderPrompt() {
  const custom = draft?.prompt != null;
  const text = custom ? draft.prompt : defaultPromptText();
  const area = $('prompt');
  if (area.value !== text && document.activeElement !== area) area.value = text;
  area.readOnly = !custom;
  area.disabled = !draft;
  if (data) area.maxLength = data.promptLimit;
  $('prompt-default').setAttribute('aria-pressed', String(!custom));
  $('prompt-custom').setAttribute('aria-pressed', String(custom));
  $('prompt-default').disabled = $('prompt-custom').disabled = !draft;
  $('prompt-reset').hidden = !custom;
  $('prompt-count').textContent = area.value.length + (data ? ' / ' + data.promptLimit : '') + t(' 字');
}
function preview() {
  if (!draft) return;
  $('enabled').checked = draft.enabled;
  $('enabled').disabled = !draft.model && !data.models.length;
  const selected = selectedModel();
  for (const id of ['working-model', 'final-model', 'final-action']) $(id).removeAttribute('data-i18n');
  const workingModel = data.workingModel === '当前模型' ? t('当前模型') : data.workingModel;
  $('working-model').textContent = workingModel;
  $('final-action').textContent = t(draft.enabled ? '改写答复' : '保留原答复');
  $('final-model').textContent = draft.enabled ? selected?.name || draft.model || t('选择模型') : workingModel;
  $('missing').hidden = !draft.model || !!selected;
  $('missing').textContent = selected || !draft.model ? '' : t('当前模型不可用，请重新选择：') + draft.model;
  for (const input of $('models').querySelectorAll('input')) input.checked = input.value === draft.model;
  renderThinking();
  renderPrompt();
}
function renderProviders(matches) {
  const names = ['all', ...new Set(data.models.map(model => model.provider))];
  if (!names.includes(provider)) provider = 'all';
  $('providers').replaceChildren(...names.map(name => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(provider === name));
    const label = document.createElement('span'); label.textContent = name === 'all' ? t('全部') : name;
    const count = document.createElement('span'); count.textContent = String(matches.filter(model => name === 'all' || model.provider === name).length);
    button.append(label, count);
    button.onclick = () => { provider = name; renderModels(); };
    return button;
  }));
}
function renderModels() {
  const container = $('models');
  const focusedValue = container.contains(document.activeElement) ? document.activeElement.value : undefined;
  container.replaceChildren();
  container.setAttribute('aria-busy', 'false');
  const query = $('search').value.trim().toLocaleLowerCase();
  const matches = data.models.filter(model => (model.name + ' ' + model.value).toLocaleLowerCase().includes(query));
  renderProviders(matches);
  const models = matches.filter(model => provider === 'all' || model.provider === provider);
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('strong');
    title.textContent = t(data.models.length ? '没有找到匹配的模型' : '还没有可用的模型');
    const detail = document.createElement('span');
    detail.textContent = t(data.models.length ? '换个关键词，或选“全部”。' : '先在 Pi 中登记具体模型并配置认证，再重新打开设置。');
    empty.append(title, detail);
    container.append(empty);
  }
  let group;
  for (const model of models) {
    if (provider === 'all' && group !== model.provider) {
      group = model.provider;
      const heading = document.createElement('p');
      heading.className = 'provider-head';
      heading.textContent = group;
      container.append(heading);
    }
    const label = document.createElement('label');
    label.className = 'model';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'final-model'; input.value = model.value;
    input.setAttribute('aria-label', model.name + ' · ' + model.provider);
    input.onchange = () => { if (!draft) return; draft.model = model.value; change(); };
    const top = document.createElement('span'); top.className = 'name-row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = model.name;
    const check = document.createElement('span'); check.className = 'check'; check.innerHTML = CHECK;
    top.append(name, check);
    const meta = document.createElement('span'); meta.className = 'meta';
    const id = document.createElement('span'); id.className = 'id'; id.textContent = model.id; id.title = model.value;
    const capacity = document.createElement('span'); capacity.className = 'ctx';
    capacity.textContent = model.contextWindow ? (model.contextWindow >= 1e6 ? +(model.contextWindow / 1e6).toFixed(1) + 'M' : Math.round(model.contextWindow / 1000) + 'K') : '';
    if (model.contextWindow) capacity.setAttribute('aria-label', t('上下文 ') + capacity.textContent);
    meta.append(id, capacity);
    label.append(input, top, meta);
    container.append(label);
  }
  preview();
  if (!scrolled && draft?.model) {
    const checked = container.querySelector('input:checked')?.closest('.model');
    if (checked) { scrolled = true; container.scrollTop = Math.max(0, checked.offsetTop - 48); }
  }
  if (focusedValue !== undefined) {
    const input = [...container.querySelectorAll('input')].find(option => option.value === focusedValue);
    if (input) input.focus();
    else $('search').focus();
  }
}
function change() {
  revision++;
  failed = false;
  preview();
  if (draft.enabled && !draft.model) { status('选择模型后保存'); feedback('请选择最终答复模型。'); return; }
  if (draft.prompt != null && !draft.prompt.trim()) { status('尚未保存', 'error'); feedback('提示词不能为空，且不超过 4000 字。'); return; }
  void save();
}
async function save() {
  if (saving || !draft) return;
  saving = true;
  failed = false;
  feedback('');
  try {
    while (dirty()) {
      if ((draft.enabled && !draft.model) || (draft.prompt != null && !draft.prompt.trim())) break;
      const body = { ...draft, revision: data.revision };
      const currentRevision = revision;
      status('正在保存…');
      const next = await request('PUT', body);
      const modelsChanged = JSON.stringify(data.models) !== JSON.stringify(next.models);
      saved = pick(next);
      data = next;
      if (revision === currentRevision) draft = { ...saved };
      if (modelsChanged) renderModels();
      else preview();
    }
    if (!dirty()) status('已自动保存', 'saved');
    else status('选择模型后保存');
  } catch (error) {
    // A lost response does not prove the server failed to write.
    if (error.status === 409) {
      draft = undefined;
      saved = undefined;
      $('enabled').disabled = true;
      revision++;
      failed = true;
      status('设置已变化', 'error');
      feedback(error.message, true);
      return;
    }
    saved = undefined;
    failed = true;
    status('尚未保存', 'error');
    feedback(error.message, true, data.recovery);
  } finally { saving = false; }
}
async function load(silent = false) {
  if (loading || saving || dirty() || (silent && failed)) return;
  loading = true;
  const currentRevision = revision;
  if (!silent) status('正在连接…');
  try {
    const next = await request('GET');
    // Refocusing the tab may race with a new selection and its PUT.
    if (revision !== currentRevision || saving || dirty()) return;
    const modelsChanged = JSON.stringify(data?.models) !== JSON.stringify(next.models);
    data = next;
    if (data.language && data.language !== language && !document.cookie.includes('pi-final-model-language=')) {
      language = data.language;
      translatePage();
    }
    saved = pick(data);
    draft = { ...saved, language };
    failed = false;
    $('search').disabled = false;
    if (modelsChanged) renderModels();
    else preview();
    feedback(data.catalog?.error || data.error, false, data.recovery);
    refreshTitle();
    status(data.busy ? '任务进行中' : '改动自动保存');
    if (dirty() && !data.busy && (!draft.enabled || draft.model)) void save();
  } catch (error) {
    if (revision !== currentRevision || saving || dirty()) return;
    failed = true;
    status('连接失败', 'error');
    feedback(error.message, true);
  } finally { loading = false; }
}
$('refresh-models').onclick = async () => {
  if (saving || loading || dirty()) return;
  loading = true;
  $('refresh-models').disabled = true;
  try {
    const next = await request('PUT', { action: 'refresh' });
    data = next;
    draft = pick(next);
    saved = { ...draft };
    renderModels();
    refreshTitle();
    feedback(next.catalog?.error || next.error);
    status(next.catalog?.error ? '刷新失败' : '模型目录已刷新');
  } catch (error) { feedback(error.message, true); }
  finally { loading = false; $('refresh-models').disabled = false; }
};
$('enabled').onchange = () => { if (!draft) return; draft.enabled = $('enabled').checked; change(); };
$('search').oninput = renderModels;
$('prompt-default').onclick = $('prompt-reset').onclick = () => {
  if (!draft) return;
  clearTimeout(promptTimer);
  draft.prompt = null;
  $('prompt').value = defaultPromptText();
  change();
};
$('prompt-custom').onclick = () => {
  if (!draft || draft.prompt != null) return;
  draft.prompt = defaultPromptText();
  change();
  $('prompt').focus();
};
$('prompt').oninput = () => {
  if (!draft || draft.prompt == null) return;
  draft.prompt = $('prompt').value;
  $('prompt-count').textContent = draft.prompt.length + ' / ' + data.promptLimit + t(' 字');
  status('尚未保存');
  clearTimeout(promptTimer);
  promptTimer = setTimeout(change, 800);
};
$('prompt').onblur = () => { if (promptTimer && dirty()) { clearTimeout(promptTimer); promptTimer = undefined; change(); } };
$('retry').onclick = () => { if (dirty()) void save(); else void load(); };
$('recover').onclick = async () => {
  if (saving || loading) return;
  $('recover').disabled = true;
  loading = true;
  saving = true;
  try {
    const next = await request('PUT', { action: 'recover' });
    const modelsChanged = JSON.stringify(data.models) !== JSON.stringify(next.models);
    data = next;
    if (modelsChanged) renderModels();
    else preview();
    feedback(dirty() ? '最终整理状态已恢复，请重试保存修改。' : '', !!dirty());
    status(dirty() ? '尚未保存' : '最终整理状态已恢复', dirty() ? 'error' : 'saved');
  } catch (error) {
    status(dirty() ? '尚未保存' : '恢复失败', 'error');
    feedback(error.message, !!dirty(), true);
  } finally { loading = false; saving = false; $('recover').disabled = false; }
};
window.addEventListener('beforeunload', event => {
  if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('focus', () => { if (!failed && !dirty()) void load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(true); });
setInterval(() => { if (!document.hidden) void load(true); }, 5000);
function refreshTitle() {
  const title = data?.catalog?.refreshedAt
    ? t('最近刷新：') + new Date(data.catalog.refreshedAt).toLocaleString(language)
    : t('从供应商刷新模型目录');
  $('refresh-models').title = title;
}

// How it works: collapsed by default; the demo only animates while it is visible.
const COMMON = [
  { on: ['c1'], t: '你提出任务', d: '只有普通的用户轮次会触发；其他扩展单独启动的轮次不整理。' },
  { on: ['a1', 'c2'], t: '工作模型照常执行', d: '工具调用、重试、压缩和排队消息都由 Pi 管理，工作模型和它的思考强度不变。' },
  { on: ['a2', 'c3'], t: '写出原答复', d: '这是工作模型的草稿，接下来决定要不要交给最终模型。' },
  { on: ['a3', 'd'], t: '检查能不能整理', d: '同时满足才继续：任务正常结束、开关已打开、最终模型可用、上下文容量足够。' },
];
const REWRITE = { on: ['a4', 'c4'], t: '最终模型改写', d: '带上你的提示词、固定约束和执行证据，按所选思考强度改写；不调用工具，最多 5 分钟、重试 2 次。' };
const PATHS = {
  ok: [...COMMON, REWRITE, { on: ['a5', 'c5'], t: '校验后替换', d: '确认会话里的编辑与回执一致，只替换正文，并在前后显示闪光标记。' }],
  skip: [...COMMON, { on: ['b', 'c6'], t: '保留原答复', d: '中断、报错、未开启、模型缺失或上下文不足：原答复原样保留，不显示闪光。' }],
  fail: [...COMMON, { ...REWRITE, d: '请求已发出，但超时、出错或返回无效正文。' }, { on: ['b', 'c6'], t: '保留原答复', d: '改写失败或答复已被其他扩展修改时跳过替换，原答复不受影响。' }],
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const demo = { path: 'ok', step: 0, hold: 0, playing: !reducedMotion, timer: undefined };
function renderDemo() {
  const steps = PATHS[demo.path];
  const state = {};
  steps.forEach((step, index) => { if (index <= demo.step) for (const id of step.on) state[id] = index === demo.step ? 'on' : 'past'; });
  for (const element of document.querySelectorAll('#how-panel [data-step]')) element.dataset.on = state[element.dataset.step] || 'off';
  const current = steps[demo.step];
  $('step-no').textContent = String(demo.step + 1);
  $('step-title').textContent = t(current.t);
  $('step-detail').textContent = t(current.d);
  for (const button of document.querySelectorAll('[data-path]')) button.setAttribute('aria-pressed', String(button.dataset.path === demo.path));
  $('icon-pause').hidden = !demo.playing;
  $('icon-play').hidden = demo.playing;
  const label = demo.playing ? '暂停演示' : '继续演示';
  $('play').dataset.i18nAriaLabel = label;
  $('play').setAttribute('aria-label', t(label));
}
function tick() {
  if (!demo.playing || document.hidden || $('how-panel').hidden) return;
  const steps = PATHS[demo.path];
  if (demo.step < steps.length - 1) demo.step++;
  else if (demo.hold < 1) demo.hold++;
  else { const order = ['ok', 'skip', 'fail']; demo.path = order[(order.indexOf(demo.path) + 1) % order.length]; demo.step = 0; demo.hold = 0; }
  renderDemo();
}
$('how-toggle').onclick = () => {
  const open = $('how-panel').hidden;
  $('how-panel').hidden = !open;
  $('how-toggle').setAttribute('aria-expanded', String(open));
  $('how-label').dataset.i18n = open ? '收起' : '展开';
  $('how-label').textContent = t(open ? '收起' : '展开');
  clearInterval(demo.timer);
  if (open) { demo.step = 0; demo.hold = 0; renderDemo(); demo.timer = setInterval(tick, 1800); }
};
for (const button of document.querySelectorAll('[data-path]')) button.onclick = () => { demo.path = button.dataset.path; demo.step = 0; demo.hold = 0; renderDemo(); };
$('play').onclick = () => {
  demo.playing = !demo.playing;
  // With autoplay off (reduced motion), the button steps through manually.
  if (reducedMotion && demo.playing) { demo.playing = false; demo.step = (demo.step + 1) % PATHS[demo.path].length; }
  renderDemo();
};
renderDemo();

// Language changes update presentation and default prompt language; keep drafts, search, focus and in-flight requests intact.
for (const button of document.querySelectorAll('[data-language]')) button.onclick = () => {
  language = button.dataset.language;
  try { document.cookie = `pi-final-model-language=${language}; Path=/; Max-Age=31536000; SameSite=Strict`; } catch { /* Switching still works without persistence. */ }
  translatePage();
  status(statusText, $('save-status').dataset.state);
  $('message').textContent = serverMessage(feedbackText) || '';
  if (data && draft) {
    draft.language = language;
    renderModels();
    if (!data.busy && !saving) void save();
  }
  renderDemo();
  refreshTitle();
};
void load();
