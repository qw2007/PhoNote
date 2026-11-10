'use strict';

const el = (id) => document.getElementById(id);

const state = {
  config: null,
  tree: [],
  openNote: null,
  selected: new Set(),
  previews: new Map(),
  revisions: [],
};

function say(message, kind = 'info') {
  const line = el('status');
  line.textContent = message;
  line.classList.toggle('error', kind === 'error');
}

function fail(error) {
  say(String(error && error.message ? error.message : error), 'error');
}

function api(method, path, body) {
  return window.phonote.rest({ method, path, body });
}

function isReadonly() {
  return Boolean(state.config && state.config.readonly);
}

function requireWrite() {
  if (isReadonly()) {
    throw new Error('readonly: 只读模式下不能修改');
  }
}

// ---------------------------------------------------------------- 文件树

async function loadTree() {
  state.tree = await api('GET', '/tree');
  const container = el('tree');
  container.replaceChildren();
  if (state.tree.length === 0) {
    container.append(hint('还没有内容，先新建一个目录'));
    return;
  }
  container.append(renderNodes(state.tree));
}

function hint(text) {
  const node = document.createElement('p');
  node.className = 'empty';
  node.textContent = text;
  return node;
}

function renderNodes(nodes) {
  const list = document.createElement('ul');
  for (const node of nodes) {
    const item = document.createElement('li');
    const button = document.createElement('span');
    button.className = `node ${node.kind}`;
    button.textContent = node.kind === 'folder' ? `📁 ${node.name}` : `📝 ${node.name}`;
    button.title = node.name;
    button.dataset.id = node.id;
    button.dataset.kind = node.kind;
    if (state.openNote && state.openNote.id === node.id) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => selectNode(node));
    item.append(button);
    if (node.children && node.children.length > 0) {
      item.append(renderNodes(node.children));
    }
    list.append(item);
  }
  return list;
}

function findNode(id, nodes = state.tree) {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const found = node.children ? findNode(id, node.children) : null;
    if (found) {
      return found;
    }
  }
  return null;
}

async function selectNode(node) {
  if (node.kind === 'note') {
    await openNote(node.id);
    return;
  }
  say(`选中目录：${node.name}`);
}

// ---------------------------------------------------------------- 图片区

function imageUrl(image) {
  const cached = state.previews.get(image.capture_id);
  if (cached) {
    return cached;
  }
  return window.phonote.mediaUrl(image);
}

async function loadBuffer() {
  const captures = await api('GET', '/captures?limit=60&unused_only=true');
  const container = el('buffer');
  container.replaceChildren();
  el('buffer-count').textContent = captures.length ? `剩 ${captures.length} 张` : '空';
  if (captures.length === 0) {
    container.append(hint('按 Ctrl+Shift+S 截图，图片会进入这里'));
    return;
  }
  for (const capture of captures) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (state.selected.has(capture.capture_id)) {
      tile.classList.add('selected');
    }
    tile.title = `${capture.width}×${capture.height} · ${capture.bytes} 字节`;
    const image = document.createElement('img');
    image.alt = '截图';
    image.src = imageUrl(capture) || '';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = state.selected.has(capture.capture_id) ? '已选' : '选';
    tile.append(image, badge);
    tile.addEventListener('click', () => {
      if (state.selected.has(capture.capture_id)) {
        state.selected.delete(capture.capture_id);
      } else {
        state.selected.add(capture.capture_id);
      }
      tile.classList.toggle('selected');
      badge.textContent = state.selected.has(capture.capture_id) ? '已选' : '选';
    });
    container.append(tile);
  }
}

// ---------------------------------------------------------------- 现有笔记区

async function openNote(noteId) {
  const note = await api('GET', `/notes/${encodeURIComponent(noteId)}`);
  state.openNote = note;
  el('note-empty').classList.add('hidden');
  el('note').classList.remove('hidden');
  el('note-title').textContent = note.name;
  el('note-meta').textContent = `#${note.id} · 更新于 ${note.updated_at}`;
  el('note-body').value = note.body_md || '';
  el('note-body').readOnly = isReadonly();

  const images = el('note-images');
  images.replaceChildren();
  for (const image of note.images || []) {
    const src = imageUrl(image);
    if (!src) {
      continue;
    }
    const img = document.createElement('img');
    img.src = src;
    img.alt = '笔记图片';
    images.append(img);
  }

  renderAnnotations(note.annotations || []);
  clearPatch();
  await loadDiscuss();
  el('tree').querySelectorAll('.node.active').forEach((node) => node.classList.remove('active'));
  const active = el('tree').querySelector(`.node[data-id="${note.id}"]`);
  if (active) {
    active.classList.add('active');
  }
  say(`打开笔记：${note.name}`);
}

async function saveNote() {
  requireWrite();
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  const updated = await api('PATCH', `/notes/${encodeURIComponent(state.openNote.id)}`, {
    body_md: el('note-body').value,
    reason: 'shell-edit',
  });
  state.openNote = { ...state.openNote, ...updated };
  say(`已保存：${updated.name}`);
}

async function loadRevisions() {
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  state.revisions = await api('GET', `/notes/${encodeURIComponent(state.openNote.id)}/revisions`);
  if (state.revisions.length === 0) {
    say('这篇笔记还没有历史版本');
    return;
  }
  say(`共 ${state.revisions.length} 个历史版本，最新一个：${state.revisions[0].created_at}`);
}

async function rollbackLatest() {
  requireWrite();
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  await loadRevisions();
  const latest = state.revisions[0];
  if (!latest) {
    return;
  }
  const restored = await api('POST', `/notes/${encodeURIComponent(state.openNote.id)}/rollback`, {
    revision_id: latest.revision_id,
  });
  el('note-body').value = restored.body_md || '';
  state.openNote = { ...state.openNote, body_md: restored.body_md };
  say(`已回滚到版本 ${latest.revision_id}`);
  await loadRevisions();
}

// ---------------------------------------------------------------- 批注区

function renderAnnotations(annotations) {
  const container = el('annotations');
  container.replaceChildren();
  if (!annotations.length) {
    container.append(hint('暂无批注'));
    return;
  }
  for (const annotation of annotations) {
    const card = document.createElement('div');
    card.className = `annotation ${annotation.color || 'yellow'}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const label = document.createElement('span');
    label.textContent = `${annotation.kind} · ${annotation.created_at}`;
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.disabled = isReadonly();
    remove.addEventListener('click', async () => {
      try {
        requireWrite();
        await api('DELETE', `/annotations/${encodeURIComponent(annotation.annotation_id)}`);
        await openNote(state.openNote.id);
        say('批注已删除');
      } catch (error) {
        fail(error);
      }
    });
    meta.append(label, remove);
    const body = document.createElement('div');
    body.textContent = annotation.body_md;
    card.append(meta, body);
    container.append(card);
  }
}

async function addAnnotation(event) {
  event.preventDefault();
  try {
    requireWrite();
    if (!state.openNote) {
      say('先选一篇笔记');
      return;
    }
    const body = el('annotation-body').value.trim();
    if (!body) {
      say('批注内容不能为空');
      return;
    }
    const kind = el('annotation-kind').value;
    const anchor = kind === 'note' ? { type: 'note' } : { type: kind, note: '由壳后续补锚点' };
    await api('POST', `/notes/${encodeURIComponent(state.openNote.id)}/annotations`, {
      kind,
      anchor,
      body_md: body,
      color: el('annotation-color').value,
    });
    el('annotation-body').value = '';
    await openNote(state.openNote.id);
    say('批注已添加');
  } catch (error) {
    fail(error);
  }
}

// ---------------------------------------------------------------- 写操作

async function newFolder() {
  requireWrite();
  const name = window.prompt('新目录名字');
  if (!name) {
    return;
  }
  await api('POST', '/nodes', { parent_id: null, kind: 'folder', name });
  await loadTree();
  say(`已新建目录：${name}`);
}

async function newNode() {
  requireWrite();
  const name = window.prompt('新笔记标题');
  if (!name) {
    return;
  }
  const parent = state.openNote ? state.openNote.parent_id : null;
  const created = await api('POST', '/nodes', {
    parent_id: parent,
    kind: 'note',
    name,
    body_md: '',
  });
  await loadTree();
  await openNote(created.id);
  say(`已新建笔记：${name}`);
}

async function renameSelected() {
  requireWrite();
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  const name = window.prompt('新名字', state.openNote.name);
  if (!name || name === state.openNote.name) {
    return;
  }
  await api('PATCH', `/nodes/${encodeURIComponent(state.openNote.id)}`, { name });
  await loadTree();
  await openNote(state.openNote.id);
  say(`已改名为：${name}`);
}

async function deleteSelected() {
  requireWrite();
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  if (!window.confirm(`删除「${state.openNote.name}」？图片会留在缓冲区。`)) {
    return;
  }
  await api('DELETE', `/nodes/${encodeURIComponent(state.openNote.id)}?recursive=false`);
  state.openNote = null;
  el('note').classList.add('hidden');
  el('note-empty').classList.remove('hidden');
  await loadTree();
  say('已删除');
}

async function composeNote() {
  requireWrite();
  if (state.selected.size === 0) {
    say('先在图片区选至少一张图');
    return;
  }
  const title = el('title').value.trim() || `笔记 ${new Date().toLocaleString('zh-CN')}`;
  const composed = await api('POST', '/notes', {
    parent_id: null,
    capture_ids: [...state.selected],
    title,
    body_md: '',
  });
  state.selected.clear();
  el('title').value = '';
  await Promise.all([loadTree(), loadBuffer()]);
  await openNote(composed.id);
  say(`已组成笔记：${composed.name}（${(composed.images || []).length} 张图）`);
}

async function exportNote() {
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  const markdown = await api('GET', `/notes/${encodeURIComponent(state.openNote.id)}/export`);
  await navigator.clipboard.writeText(String(markdown));
  say('Markdown 已复制到剪贴板');
}

async function captureNow() {
  requireWrite();
  const payload = await window.phonote.capture();
  state.previews.set(payload.capture.capture_id, payload.preview);
  await loadBuffer();
  say(`已截图：${payload.capture.capture_id}`);
}

// ---------------------------------------------------------------- 讨论区（P2）

let pendingEdits = [];

function renderMessage(message) {
  const row = document.createElement('div');
  row.className = `msg msg-${message.role}`;
  const who = document.createElement('span');
  who.className = 'msg-who';
  who.textContent = message.role === 'assistant' ? 'AI' : '我';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = message.body;
  row.append(who, body);
  return row;
}

async function loadDiscuss() {
  if (!state.openNote) {
    return;
  }
  const box = el('discuss');
  const messages = await api(
    'GET',
    `/notes/${encodeURIComponent(state.openNote.id)}/messages?limit=50`
  );
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有消息。可以让 AI 总结，或直接提问。';
    box.replaceChildren(empty);
    return;
  }
  box.replaceChildren(...messages.map(renderMessage));
  box.scrollTop = box.scrollHeight;
}

function clearPatch() {
  pendingEdits = [];
  el('patch-preview').classList.add('hidden');
  el('patch-edits').replaceChildren();
  el('patch-summary').textContent = '';
}

function showOutcome(outcome) {
  if (!outcome) {
    return;
  }
  if (outcome.mode === 'manual') {
    // manual 模式不调模型：把上下文包放剪贴板，用户自己贴给网页版。
    el('patch-summary').textContent = 'manual 模式：上下文已复制，粘给网页版模型再把回复粘贴回来';
    el('patch-edits').replaceChildren();
    pendingEdits = [];
    el('patch-preview').classList.remove('hidden');
    if (outcome.copy_text) {
      navigator.clipboard?.writeText(outcome.copy_text).catch(() => undefined);
    }
    return;
  }
  pendingEdits = Array.isArray(outcome.edits) ? outcome.edits : [];
  el('patch-summary').textContent = outcome.summary || '（模型没有给出摘要）';
  const list = el('patch-edits');
  list.replaceChildren();
  for (const edit of pendingEdits) {
    const item = document.createElement('li');
    const find = edit.find === '' ? '（追加到末尾）' : edit.find;
    item.textContent = `${find} → ${edit.replace}`;
    list.append(item);
  }
  // 没有补丁就别让「套用」按钮假装有活干。
  el('patch-apply').disabled = pendingEdits.length === 0 || isReadonly();
  el('patch-preview').classList.remove('hidden');
}

async function sendChat() {
  requireWrite();
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  const input = el('discuss-input');
  const message = input.value.trim();
  if (!message) {
    return;
  }
  input.value = '';
  clearPatch();
  const outcome = await api('POST', `/notes/${encodeURIComponent(state.openNote.id)}/chat`, {
    message,
  });
  showOutcome(outcome);
  await loadDiscuss();
  say(outcome.mode === 'manual' ? 'manual 模式：上下文已复制' : 'AI 已回复');
}

async function summarizeNote() {
  requireWrite();
  if (!state.openNote) {
    say('先选一篇笔记');
    return;
  }
  clearPatch();
  const outcome = await api('POST', `/notes/${encodeURIComponent(state.openNote.id)}/summarize`, {
    instruction: el('discuss-input').value.trim(),
  });
  showOutcome(outcome);
  await loadDiscuss();
  say(outcome.mode === 'manual' ? 'manual 模式：上下文已复制' : 'AI 已总结');
}

async function applyPatch() {
  requireWrite();
  if (!state.openNote || !pendingEdits.length) {
    return;
  }
  // 一次一条走 /apply：每条都自己判断「锚点唯一」，被跳过的能如实报出来。
  let applied = 0;
  let skipped = 0;
  for (const edit of pendingEdits) {
    const outcome = await api('POST', `/notes/${encodeURIComponent(state.openNote.id)}/apply`, {
      find: edit.find,
      replace: edit.replace,
    });
    applied += outcome.applied.length;
    skipped += outcome.skipped.length;
  }
  clearPatch();
  await openNote(state.openNote.id);
  say(`补丁已套用 ${applied} 条${skipped ? `，跳过 ${skipped} 条` : ''}`);
}

// ---------------------------------------------------------------- 设置与只读

function applyMode() {
  const readonly = isReadonly();
  el('mode').textContent = readonly ? '只读模式' : '';
  for (const id of ['capture', 'compose', 'save', 'new-folder', 'new-note', 'rename', 'delete']) {
    el(id).disabled = readonly;
  }
  el('annotation-form').querySelector('button').disabled = readonly;
  el('rollback').disabled = readonly;
  el('discuss-send').disabled = readonly;
  el('discuss-summarize').disabled = readonly;
  el('patch-apply').disabled = readonly || pendingEdits.length === 0;
  el('discuss-input').readOnly = readonly;
}

function openSettings() {
  el('cfg-base').value = state.config.apiBase || '';
  el('cfg-key').value = state.config.apiKey || '';
  el('cfg-dir').value = state.config.notesDir || '';
  el('cfg-readonly').checked = Boolean(state.config.readonly);
  el('settings-dialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const patch = {
    apiBase: el('cfg-base').value.trim(),
    apiKey: el('cfg-key').value.trim(),
    notesDir: el('cfg-dir').value.trim(),
    readonly: el('cfg-readonly').checked,
  };
  state.config = await window.phonote.saveConfig(patch);
  el('settings-dialog').close();
  applyMode();
  await reload();
  say('设置已保存');
}

// ---------------------------------------------------------------- 启动

async function reload() {
  try {
    await Promise.all([loadTree(), loadBuffer()]);
  } catch (error) {
    fail(error);
  }
}

async function boot() {
  state.config = await window.phonote.config();
  applyMode();

  el('capture').addEventListener('click', () => captureNow().catch(fail));
  el('compose').addEventListener('click', () => composeNote().catch(fail));
  el('save').addEventListener('click', () => saveNote().catch(fail));
  el('new-folder').addEventListener('click', () => newFolder().catch(fail));
  el('new-note').addEventListener('click', () => newNode().catch(fail));
  el('rename').addEventListener('click', () => renameSelected().catch(fail));
  el('delete').addEventListener('click', () => deleteSelected().catch(fail));
  el('export').addEventListener('click', () => exportNote().catch(fail));
  el('revisions').addEventListener('click', () => loadRevisions().catch(fail));
  el('rollback').addEventListener('click', () => rollbackLatest().catch(fail));
  el('settings').addEventListener('click', openSettings);
  el('cfg-cancel').addEventListener('click', () => el('settings-dialog').close());
  el('open-folder').addEventListener('click', () => window.phonote.openFolder('notes'));
  el('annotation-form').addEventListener('submit', addAnnotation);
  el('discuss-send').addEventListener('click', () => sendChat().catch(fail));
  el('discuss-summarize').addEventListener('click', () => summarizeNote().catch(fail));
  el('patch-apply').addEventListener('click', () => applyPatch().catch(fail));
  el('patch-discard').addEventListener('click', clearPatch);
  el('settings-form').addEventListener('submit', saveSettings);

  window.phonote.onCaptured(async (payload) => {
    try {
      state.previews.set(payload.capture.capture_id, payload.preview);
      await loadBuffer();
      say(`已截图：${payload.capture.capture_id}`);
    } catch (error) {
      fail(error);
    }
  });
  window.phonote.onError((message) => fail(message));

  await reload();
  say('准备就绪：Ctrl+Shift+S 截图');
}

boot().catch(fail);
