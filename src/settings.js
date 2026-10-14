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
  $('final-model').textContent = draft.enabled ? selected?.name || draft.model || '选择你的模型' : '跟随工作模型';
  $('restore-label').textContent = draft.enabled ? '完成后，回到工作模型' : '由工作模型完成全部答复';
  $('missing').hidden = !draft.model || !!selected;
  $('missing').textContent = selected || !draft.model ? '' : '当前模型不可用，请重新选择：' + draft.model;
  for (const input of $('models').querySelectorAll('input')) {
    input.checked = input.value === draft.model;
    input.closest('.model').classList.toggle('selected', input.checked);
  }
}
function renderModels() {
  const container = $('models');
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
    label.className = 'model';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'final-model'; input.value = model.value;
    input.setAttribute('aria-label', model.name + ' · ' + model.provider);
    input.onchange = () => { draft.model = model.value; change(); };
    const copy = document.createElement('span');
    copy.className = 'model-copy';
    const name = document.createElement('span'); name.className = 'model-title'; name.textContent = model.name;
    const id = document.createElement('span'); id.className = 'model-id'; id.textContent = model.id;
    copy.append(name, id);
    const capacity = document.createElement('span'); capacity.className = 'capacity';
    capacity.textContent = model.contextWindow ? Math.round(model.contextWindow / 1000) + 'K' : '';
    capacity.setAttribute('aria-label', '上下文 ' + capacity.textContent);
    const radio = document.createElement('span'); radio.className = 'radio'; radio.setAttribute('aria-hidden', 'true');
    label.append(input, copy, capacity, radio);
    container.append(label);
  }
  preview();
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
      saved = { enabled: next.enabled, model: next.model };
      data = next;
      if (revision === currentRevision) draft = { ...saved };
      preview();
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
async function load() {
  if (loading || saving || dirty()) return;
  loading = true;
  const currentRevision = revision;
  status('正在连接…');
  try {
    const next = await request('GET');
    // Refocusing the tab may race with a new selection and its PUT.
    if (revision !== currentRevision || saving || dirty()) return;
    data = next;
    draft = { enabled: data.enabled, model: data.model };
    saved = { ...draft };
    failed = false;
    $('search').disabled = false;
    renderModels();
    feedback(data.error, false, data.recovery);
    status(data.busy ? '任务进行中' : '改动自动保存');
  } catch (error) {
    if (revision !== currentRevision || saving || dirty()) return;
    status('连接失败', 'error');
    feedback(error.message, true);
  } finally { loading = false; }
}
$('enabled').onchange = () => { draft.enabled = $('enabled').checked; change(); };
$('search').oninput = renderModels;
$('retry').onclick = () => { if (dirty()) void save(); else void load(); };
$('recover').onclick = async () => {
  if (saving || loading) return;
  $('recover').disabled = true;
  loading = true;
  saving = true;
  try {
    data = await request('PUT', { action: 'recover' });
    preview();
    feedback(dirty() ? '工作模型已恢复，请重试保存修改。' : '', !!dirty());
    status(dirty() ? '尚未保存' : '工作模型已恢复', dirty() ? 'error' : 'saved');
  } catch (error) {
    status(dirty() ? '尚未保存' : '恢复失败', 'error');
    feedback(error.message, !!dirty(), true);
  } finally { loading = false; saving = false; $('recover').disabled = false; }
};
window.addEventListener('beforeunload', event => {
  if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('focus', () => { if (!failed && !dirty()) void load(); });
void load();
