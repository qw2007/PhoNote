// 渲染进程：只画界面、只调工具，不碰文件系统与网络（那两件事在主进程）。
//
// 状态少得刻意：一棵树、一批缓冲图、一篇打开的笔记、一组选中的图。
// P2 的讨论区与 P1 的批注区都往这里加，但 P0 不预埋空面板——界面上不该出现
// 一个永远是「敬请期待」的区域。

const state = {
  selected: new Set(),
  previews: new Map(), // capture_id → data URL（本次会话里刚截的图）
  openNoteId: null,
  config: null,
};

const el = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const status = el('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

async function mediaOf(capture) {
  if (state.previews.has(capture.capture_id)) {
    return state.previews.get(capture.capture_id);
  }
  try {
    return await window.phonote.mediaUrl(capture);
  } catch {
    return null;
  }
}

function nodeLabel(node) {
  return node.kind === 'folder' ? '▸' : '•';
}

function renderTree(nodes, container) {
  const list = document.createElement('ul');
  for (const node of nodes) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    if (state.openNoteId && node.id === state.openNoteId) row.classList.add('active');
    row.title = `${node.kind}: ${node.name}`;

    const icon = document.createElement('span');
    icon.className = 'kind';
    icon.textContent = nodeLabel(node);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.textContent = node.name;
    row.appendChild(name);

    row.addEventListener('click', () => {
      if (node.kind === 'note') openNote(node.id);
    });
    item.appendChild(row);

    if (node.children && node.children.length > 0) {
      renderTree(node.children, item);
    }
    list.appendChild(item);
  }
  container.appendChild(list);
}

async function refreshTree() {
  const tree = el('tree');
  tree.innerHTML = '';
  try {
    const nodes = await window.phonote.call('note_tree', {});
    if (nodes.length === 0) {
      tree.innerHTML = '<p class="muted">还没有笔记。截图后点「组成笔记」。</p>';
      return;
    }
    renderTree(nodes, tree);
  } catch (error) {
    setStatus(`读文件树失败：${error.message}`, true);
  }
}

async function refreshBuffer() {
  const buffer = el('buffer');
  try {
    const captures = await window.phonote.call('note_list_captures', {
      limit: 60,
      unused_only: true,
    });
    buffer.innerHTML = '';
    el('buffer-count').textContent = captures.length ? `${captures.length} 张未使用` : '';
    if (captures.length === 0) {
      buffer.innerHTML = '<p class="muted">缓冲区是空的。按 Ctrl+Shift+S 截一张。</p>';
      return;
    }
    for (const capture of captures) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (state.selected.has(capture.capture_id)) tile.classList.add('selected');

      const source = await mediaOf(capture);
      if (source) {
        const image = document.createElement('img');
        image.src = source;
        image.alt = capture.app_title || capture.capture_id;
        tile.appendChild(image);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'placeholder';
        placeholder.textContent = `${capture.media_type} · ${Math.round(capture.bytes / 1024)} KB\n${capture.sha256.slice(0, 12)}…`;
        tile.appendChild(placeholder);
      }

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = state.selected.has(capture.capture_id) ? '已选' : '选';
      tile.appendChild(badge);

      tile.addEventListener('click', () => {
        if (state.selected.has(capture.capture_id)) {
          state.selected.delete(capture.capture_id);
        } else {
          state.selected.add(capture.capture_id);
        }
        tile.classList.toggle('selected');
        badge.textContent = state.selected.has(capture.capture_id) ? '已选' : '选';
      });

      buffer.appendChild(tile);
    }
  } catch (error) {
    setStatus(`读图片缓冲区失败：${error.message}`, true);
  }
}

async function openNote(noteId) {
  try {
    const note = await window.phonote.call('note_get', { note_id: noteId });
    state.openNoteId = note.id;
    const pane = el('note');
    pane.innerHTML = '';

    const title = document.createElement('h1');
    title.textContent = note.name;
    pane.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `${note.id} · 更新于 ${note.updated_at} · ${note.images.length} 张图`;
    pane.appendChild(meta);

    if (note.body_md) {
      const body = document.createElement('pre');
      body.textContent = note.body_md;
      body.style.whiteSpace = 'pre-wrap';
      pane.appendChild(body);
    }

    const images = document.createElement('div');
    images.className = 'images';
    for (const capture of note.images) {
      const source = await mediaOf(capture);
      if (source) {
        const image = document.createElement('img');
        image.src = source;
        image.alt = capture.capture_id;
        images.appendChild(image);
      }
    }
    if (note.images.length > 0 && images.childElementCount === 0) {
      const noteHint = document.createElement('p');
      noteHint.className = 'muted';
      noteHint.textContent = '图片文件不在本机默认目录下（平台与壳指向了不同的 DRIVER_NOTES_DIR）。';
      images.appendChild(noteHint);
    }
    pane.appendChild(images);
    await refreshTree();
  } catch (error) {
    setStatus(`读笔记失败：${error.message}`, true);
  }
}

async function composeNote() {
  const title = el('title').value.trim();
  if (!title) {
    setStatus('先给笔记起个名字。', true);
    return;
  }
  if (state.selected.size === 0) {
    setStatus('至少选一张图。', true);
    return;
  }
  try {
    const note = await window.phonote.call('note_compose', {
      capture_ids: [...state.selected],
      title,
    });
    state.selected.clear();
    el('title').value = '';
    setStatus(`已组成笔记：${note.name}`);
    await refreshBuffer();
    await refreshTree();
    await openNote(note.id);
  } catch (error) {
    setStatus(`组成笔记失败：${error.message}`, true);
  }
}

async function captureNow() {
  setStatus('截图并上传……');
  try {
    const { capture, preview } = await window.phonote.capture();
    state.previews.set(capture.capture_id, preview);
    setStatus(`已进缓冲区：${capture.width}×${capture.height} · ${Math.round(capture.bytes / 1024)} KB`);
    await refreshBuffer();
  } catch (error) {
    setStatus(`截图失败：${error.message}`, true);
  }
}

async function boot() {
  try {
    state.config = await window.phonote.config();
    el('hint').textContent = `${state.config.apiBase}${state.config.hasApiKey ? '' : ' · 未配置钥匙'}`;
    setStatus(`平台：${state.config.apiBase}`);
  } catch (error) {
    setStatus(`读配置失败：${error.message}`, true);
  }

  el('capture').addEventListener('click', captureNow);
  el('compose').addEventListener('click', composeNote);
  el('open-folder').addEventListener('click', () => window.phonote.openFolder());

  window.phonote.onCaptured(({ capture, preview }) => {
    state.previews.set(capture.capture_id, preview);
    setStatus(`已进缓冲区：${capture.width}×${capture.height}`);
    refreshBuffer();
  });
  window.phonote.onError((message) => setStatus(`出错：${message}`, true));

  await refreshTree();
  await refreshBuffer();
}

boot();
