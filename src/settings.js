const $ = id => document.getElementById(id);
const storageKey = 'pi-final-model-token';
let token = location.hash.slice(1);
try {
  if (token) sessionStorage.setItem(storageKey, token);
  else token = sessionStorage.getItem(storageKey) || '';
} catch { /* The fragment still works when storage is unavailable. */ }
history.replaceState(null, '', location.pathname);
$('version').textContent = 'v' + document.documentElement.dataset.version;

let data;
let draft;
let saved;
let saving = false;
let loading = false;
let revision = 0;
let failed = false;
const equal = (a, b) => a?.enabled === b?.enabled && a?.model === b?.model;
const dirty = () => draft && !equal(draft, saved);

function status(text, state = '') {
  $('save-status').textContent = text;
  $('save-status').dataset.state = state;
}
function feedback(text, retry = false, recovery = false) {
  $('feedback').hidden = !text;
  $('message').textContent = text;
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
  if (!response.ok) throw Error(value.error || '无法保存，请稍后重试。');
  return value;
}
function preview() {
  if (!draft) return;
  $('enabled').checked = draft.enabled;
  $('enabled').disabled = !draft.model && !data.models.length;
  const selected = data.models.find(model => model.value === draft.model);
  $('working-model').textContent = data.workingModel;
  $('final-model').textContent = draft.enabled ? selected?.name || draft.model || '选择模型' : data.workingModel;
  $('selected-name').textContent = selected?.name || draft.model || '选择模型';
  $('selected-id').textContent = selected ? selected.provider + ' / ' + selected.id : '';
  $('selected-id').hidden = !selected;
  $('missing').hidden = !draft.model || !!selected;
  $('missing').textContent = selected || !draft.model ? '' : '当前模型不可用，请重新选择：' + draft.model;
  for (const input of $('models').querySelectorAll('input')) {
    input.checked = input.value === draft.model;
    input.closest('.model-choice').classList.toggle('selected', input.checked);
  }
}
function chooser(open, focus = true) {
  $('model-chooser').hidden = !open;
  $('model-open').setAttribute('aria-expanded', String(open));
  if (open) {
    $('search').value = '';
    renderModels();
    if (focus) $('search').focus();
  } else if (focus) $('model-open').focus();
}
function renderModels() {
  const container = $('models');
  const focusedValue = container.contains(document.activeElement) ? document.activeElement.value : undefined;
  container.replaceChildren();
  container.setAttribute('aria-busy', 'false');
  const query = $('search').value.trim().toLocaleLowerCase();
  const models = data.models.filter(model => (model.name + ' ' + model.value).toLocaleLowerCase().includes(query));
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('strong');
    title.textContent = data.models.length ? '没有找到匹配的模型' : '还没有可用的模型';
    const detail = document.createElement('span');
    detail.textContent = data.models.length ? '试试其他名称。' : '先在 Pi 中登记具体模型并配置认证，再重新打开设置。';
    empty.append(title, detail);
    container.append(empty);
  }
  let provider;
  for (const model of models) {
    if (provider !== model.provider) {
      provider = model.provider;
      const heading = document.createElement('p');
      heading.className = 'provider';
      heading.textContent = provider;
      container.append(heading);
    }
    const label = document.createElement('label');
    label.className = 'model-choice';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'final-model'; input.value = model.value;
    input.setAttribute('aria-label', model.name + ' · ' + model.provider);
    input.onchange = () => { draft.model = model.value; change(); chooser(false); };
    const copy = document.createElement('span');
    copy.className = 'model-copy';
    const name = document.createElement('span'); name.className = 'model-name'; name.textContent = model.name;
    const id = document.createElement('span'); id.className = 'model-id'; id.textContent = model.id;
    copy.append(name, id);
    const capacity = document.createElement('span'); capacity.className = 'capacity';
    capacity.textContent = model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K' : '';
    if (model.contextWindow) capacity.setAttribute('aria-label', '上下文 ' + capacity.textContent);
    const check = document.createElement('img'); check.className = 'icon'; check.src = '/icons/check.svg'; check.alt = '';
    label.append(input, copy, capacity, check);
    container.append(label);
  }
  preview();
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
  if (draft.enabled && !draft.model) {
    status('选择模型后保存');
    feedback('请选择最终答复模型。');
    return;
  }
  void save();
}
async function save() {
  if (saving || !draft) return;
  if (draft.enabled && !draft.model) { feedback('请选择最终答复模型。'); return; }
  saving = true;
  failed = false;
  feedback('');
  try {
    while (dirty()) {
      if (draft.enabled && !draft.model) break;
      const body = { ...draft };
      const currentRevision = revision;
      status('正在保存…');
      const next = await request('PUT', body);
      const modelsChanged = JSON.stringify(data.models) !== JSON.stringify(next.models);
      saved = { enabled: next.enabled, model: next.model };
      data = next;
      if (revision === currentRevision) draft = { ...saved };
      if (modelsChanged) renderModels();
      else preview();
    }
    if (!dirty()) status('已自动保存', 'saved');
    else status('选择模型后保存');
  } catch (error) {
    // A lost response does not prove the server failed to write.
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
    draft = { enabled: data.enabled, model: data.model };
    saved = { ...draft };
    failed = false;
    $('search').disabled = false;
    $('model-open').disabled = false;
    if (modelsChanged) renderModels();
    else preview();
    feedback(data.error, false, data.recovery);
    status(data.busy ? '任务进行中' : '改动自动保存');
  } catch (error) {
    if (revision !== currentRevision || saving || dirty()) return;
    failed = true;
    status('连接失败', 'error');
    feedback(error.message, true);
  } finally { loading = false; }
}
$('enabled').onchange = () => { draft.enabled = $('enabled').checked; change(); };
$('search').oninput = renderModels;
$('model-open').onclick = () => chooser($('model-chooser').hidden);
$('model-chooser').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); chooser(false); }
};
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void load(true);
});
setInterval(() => { if (!document.hidden) void load(true); }, 5000);
void load();
