'use strict';

const CFG_KEY = 'db_config';

const STATUSES     = ['progress', 'backlog', 'want', 'done'];
const ADD_STATUSES = ['progress', 'backlog', 'want'];
const LABELS       = { progress: 'In Progress', backlog: 'Backlog', want: 'Want', done: 'Done' };

let config      = null;
let data        = { items: [] };
let fileSha     = null;
let isAdding    = false;
let newStatus      = 'progress';
let isSaving       = false;
let needsSave      = false;
let savedSnapshot  = null;
let draggedId      = null;
let activeTag      = null;
let editingTagsFor  = null;
let editingTitleFor = null;
let touchSelId      = null;

// ── Utilities ────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function b64enc(str) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
      (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  );
}

function b64dec(str) {
  return decodeURIComponent(
    [...atob(str)].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  );
}

// ── GitHub API ───────────────────────────────────────────────

async function ghFetch(path, opts = {}) {
  return fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}${path}`,
    {
      cache: 'no-store',
      ...opts,
      headers: {
        Authorization: `Bearer ${config.pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    }
  );
}

function normalize(d) {
  if (!d) return { items: [] };
  let items;
  if (Array.isArray(d.items)) {
    items = d.items;
  } else {
    const old = [...(d.books || []), ...(d.courses || [])];
    items = old.map(i => ({ id: i.id, title: i.title, status: i.status, addedAt: i.addedAt }));
  }
  items.forEach(i => {
    if (i.status === 'active') i.status = 'progress';
    if (!Array.isArray(i.tags)) i.tags = [];
  });
  return { items };
}

async function ghLoad() {
  const res = await ghFetch('/contents/data.json');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  fileSha = j.sha;
  return normalize(JSON.parse(b64dec(j.content.replace(/\s/g, ''))));
}

async function ghSave(action = 'update') {
  if (JSON.stringify(data) === savedSnapshot) return;
  if (isSaving) { needsSave = true; return; }
  isSaving = true;
  syncMsg('saving…');
  try {
    const body = {
      message: action,
      content: b64enc(JSON.stringify(data, null, 2)),
      ...(fileSha ? { sha: fileSha } : {})
    };
    const res = await ghFetch('/contents/data.json', {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`${res.status} — ${detail.message || 'unknown'}`);
    }
    const j = await res.json();
    fileSha = j.content.sha;
    savedSnapshot = JSON.stringify(data);
    syncMsg('Saved');
    setTimeout(() => syncMsg(''), 2000);
  } catch (e) {
    syncMsg(`save failed: ${e.message}`, true);
    console.error(e);
  } finally {
    isSaving = false;
    if (needsSave) { needsSave = false; ghSave(); }
  }
}

function syncMsg(msg, error = false) {
  const el = document.querySelector('.sync-status');
  if (el) { el.textContent = msg; el.classList.toggle('error', error); }
}

// ── Data operations ──────────────────────────────────────────

function parseTags(str) {
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function allTags() {
  const set = new Set();
  data.items.forEach(i => i.tags.forEach(t => set.add(t)));
  return [...set].sort();
}

function filterByTag(tag) {
  activeTag = activeTag === tag ? null : tag;
  if (activeTag) localStorage.setItem('activeTag', activeTag);
  else localStorage.removeItem('activeTag');
  render();
}

function setTags(id, str) {
  const item = data.items.find(i => i.id === id);
  if (!item) return;
  item.tags = parseTags(str);
  editingTagsFor = null;
  ghSave('Edit tags');
  render();
}

function startTagEdit(id) {
  editingTagsFor = id;
  render();
  const inp = document.getElementById(`tagedit-${id}`);
  if (inp) { inp.focus(); inp.select(); }
}

function cancelTagEdit() {
  editingTagsFor = null;
  render();
}

const isTouch = () => window.matchMedia('(hover: none)').matches;


function startTitleEdit(id) {
  editingTitleFor = id;
  editingTagsFor  = null;
  render();
}

function setTitle(id, value) {
  if (!editingTitleFor) return;
  const item = data.items.find(i => i.id === id);
  if (!item) return;
  const v = value.trim();
  if (v) item.title = v;
  editingTitleFor = null;
  ghSave('Edit title');
  render();
}

function cancelTitleEdit() {
  editingTitleFor = null;
  render();
}

let _popupCleanup = null;

function showTitlePopup(event, id) {
  event.stopPropagation();
  closeTitlePopup();
  const item = data.items.find(i => i.id === id);
  if (!item) return;
  const popup = document.createElement('div');
  popup.className = 'title-popup';
  popup.textContent = item.title;
  document.body.appendChild(popup);
  const itemEl = event.currentTarget.closest('.item');
  const rect = (itemEl || event.currentTarget).getBoundingClientRect();
  const bgOffset = window.matchMedia('(hover: hover)').matches ? 22 : 0;
  popup.style.left = (rect.left + bgOffset) + 'px';
  popup.style.width = (rect.width - bgOffset) + 'px';
  const ph = popup.offsetHeight;
  let top = rect.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  popup.style.top = Math.max(8, top) + 'px';
  const onOutside = e => { if (!popup.contains(e.target)) closeTitlePopup(); };
  const onKey = e => { if (e.key === 'Escape') closeTitlePopup(); };
  const onScroll = () => closeTitlePopup();
  setTimeout(() => {
    document.addEventListener('click', onOutside);
    document.addEventListener('touchstart', onOutside, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
  }, 0);
  _popupCleanup = () => {
    document.removeEventListener('click', onOutside);
    document.removeEventListener('touchstart', onOutside, true);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
  };
}

function closeTitlePopup() {
  document.querySelectorAll('.title-popup').forEach(el => el.remove());
  if (_popupCleanup) { _popupCleanup(); _popupCleanup = null; }
}

function checkTruncation() {
  document.querySelectorAll('.btn-expand').forEach(btn => { btn.style.display = 'none'; });
  document.querySelectorAll('.item-title:not([contenteditable])').forEach(el => {
    const btn = el.nextElementSibling;
    if (!btn || !btn.classList.contains('btn-expand')) return;
    if (el.scrollWidth > el.offsetWidth) {
      btn.style.display = 'inline-flex';
      el.classList.add('is-truncated');
    } else {
      el.classList.remove('is-truncated');
    }
  });
}

function toggleAddTag(tag) {
  const inp = document.getElementById('inp-tags');
  if (!inp) return;
  const tags = parseTags(inp.value);
  const idx = tags.indexOf(tag);
  if (idx >= 0) tags.splice(idx, 1);
  else tags.push(tag);
  inp.value = tags.join(', ');
  document.querySelectorAll('.add-tag-opt').forEach(el => {
    el.classList.toggle('active', tags.includes(el.dataset.tag));
  });
}

function addItem(title, status, tags) {
  data.items.unshift({ id: uid(), title: title.trim(), status, tags: tags || [], addedAt: new Date().toISOString().slice(0, 19) + 'Z' });
  ghSave('Add item');
  render();
}

function deleteItem(id) {
  data.items = data.items.filter(i => i.id !== id);
  ghSave('Delete item');
  render();
}

function confirmDelete(btn, id) {
  if (btn.dataset.pending === '1') {
    deleteItem(id);
  } else {
    btn.dataset.pending = '1';
    btn.textContent = '×?';
    btn.style.color = '#e03e3e';
    btn.style.width = 'auto';
    btn.style.padding = '0 6px';
    const itemEl = btn.closest('.item');
    itemEl?.classList.add('del-pending');
    setTimeout(() => {
      if (btn.dataset.pending === '1') {
        btn.dataset.pending = '';
        btn.textContent = '×';
        btn.style.color = '';
        btn.style.width = '';
        btn.style.padding = '';
        itemEl?.classList.remove('del-pending');
      }
    }, 3000);
  }
}

function setStatus(id, status) {
  const item = data.items.find(i => i.id === id);
  if (!item || item.status === status) return;
  item.status = status;
  ghSave('Set status');
  render();
}

// ── Drag to reorder ──────────────────────────────────────────

function onDragStart(e, id) {
  draggedId = id;
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => {
    const el = document.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add('dragging');
  });
}

function onDragOver(e, targetId) {
  if (!draggedId || draggedId === targetId) return;
  e.preventDefault();
  e.stopPropagation();
  const rect   = e.currentTarget.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
    if (el !== e.currentTarget) el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  document.querySelectorAll('.section-drag-over').forEach(el => el.classList.remove('section-drag-over'));
  e.currentTarget.classList.toggle('drag-over-top',    before);
  e.currentTarget.classList.toggle('drag-over-bottom', !before);
}

function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
  }
}

function onDrop(e, targetId) {
  e.preventDefault();
  e.stopPropagation();
  if (!draggedId || draggedId === targetId) return;
  const draggedItem = data.items.find(i => i.id === draggedId);
  const targetItem  = data.items.find(i => i.id === targetId);
  if (!draggedItem || !targetItem) return;
  const statusChanged = draggedItem.status !== targetItem.status;
  draggedItem.status = targetItem.status;
  const rect    = e.currentTarget.getBoundingClientRect();
  const before  = e.clientY < rect.top + rect.height / 2;
  const fromIdx = data.items.findIndex(i => i.id === draggedId);
  const [dragged] = data.items.splice(fromIdx, 1);
  const toIdx   = data.items.findIndex(i => i.id === targetId);
  data.items.splice(before ? toIdx : toIdx + 1, 0, dragged);
  draggedId = null;
  ghSave(statusChanged ? 'Set status' : 'Reorder');
  render();
}

function onSectionDragOver(e, status) {
  if (!draggedId) return;
  e.preventDefault();
  document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el =>
    el.classList.remove('drag-over-top', 'drag-over-bottom')
  );
  e.currentTarget.classList.add('section-drag-over');
}

function onSectionDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('section-drag-over');
  }
}

function onSectionDrop(e, status) {
  e.preventDefault();
  if (!draggedId) return;
  const item = data.items.find(i => i.id === draggedId);
  if (!item) return;
  item.status = status;
  const fromIdx = data.items.findIndex(i => i.id === draggedId);
  const [dragged] = data.items.splice(fromIdx, 1);
  data.items.push(dragged);
  draggedId = null;
  ghSave('Reorder');
  render();
}

function onDragEnd() {
  draggedId = null;
  document.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom, .section-drag-over').forEach(el =>
    el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom', 'section-drag-over')
  );
}

let autoScrollActive = false;
let autoScrollSpeed = 0;

function tickAutoScroll() {
  if (!autoScrollActive) return;
  if (autoScrollSpeed !== 0) {
    (document.scrollingElement || document.documentElement).scrollBy(0, autoScrollSpeed);
  }
  requestAnimationFrame(tickAutoScroll);
}

function clearAutoScroll() {
  autoScrollActive = false;
  autoScrollSpeed = 0;
}

function startAutoScroll(speed) {
  autoScrollSpeed = speed;
  if (!autoScrollActive) { autoScrollActive = true; requestAnimationFrame(tickAutoScroll); }
}

let activeDragHandle = null;

function onTouchDragStart(e, id) {
  e.preventDefault();
  draggedId = id;
  activeDragHandle = e.currentTarget;
  activeDragHandle.addEventListener('touchmove', onTouchDragMove, { passive: false });
  activeDragHandle.addEventListener('touchend', onTouchDragEnd);
  document.querySelector(`.item[data-id="${id}"]`)?.classList.add('dragging');
}

function onTouchDragMove(e) {
  if (!draggedId || !e.touches[0]) return;
  e.preventDefault();
  const touch = e.touches[0];

  const edgeSize = 80, maxSpeed = 4;
  const y = touch.clientY, vh = window.innerHeight;
  if (y < edgeSize) {
    startAutoScroll(-maxSpeed * (1 - y / edgeSize));
  } else if (y > vh - edgeSize) {
    startAutoScroll(maxSpeed * (1 - (vh - y) / edgeSize));
  } else {
    clearAutoScroll();
  }
  const draggedEl = document.querySelector(`.item[data-id="${draggedId}"]`);
  if (draggedEl) draggedEl.style.visibility = 'hidden';
  const target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (draggedEl) draggedEl.style.visibility = '';
  document.querySelectorAll('.item').forEach(el =>
    el.classList.remove('drag-over-top', 'drag-over-bottom')
  );
  document.querySelectorAll('.section-drag-over').forEach(el =>
    el.classList.remove('section-drag-over')
  );
  if (!target) return;
  const item = target.closest('.item');
  if (item && item.dataset.id !== draggedId) {
    const rect = item.getBoundingClientRect();
    item.classList.add(touch.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
  } else {
    let section = target.closest('[data-status]');
    if (!section) {
      let minDist = Infinity;
      document.querySelectorAll('[data-status]').forEach(s => {
        const r = s.getBoundingClientRect();
        const dist = Math.max(0, r.top - touch.clientY, touch.clientY - r.bottom);
        if (dist < minDist && dist < 40) { minDist = dist; section = s; }
      });
    }
    if (section) section.classList.add('section-drag-over');
  }
}

function onTouchDragEnd(e) {
  if (activeDragHandle) {
    activeDragHandle.removeEventListener('touchmove', onTouchDragMove);
    activeDragHandle.removeEventListener('touchend', onTouchDragEnd);
    activeDragHandle = null;
  }
  clearAutoScroll();
  if (!draggedId) return;
  const touch = e.changedTouches[0];
  const draggedEl = document.querySelector(`.item[data-id="${draggedId}"]`);
  if (draggedEl) draggedEl.style.visibility = 'hidden';
  const target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (draggedEl) draggedEl.style.visibility = '';
  if (target) {
    const item = target.closest('.item');
    if (item && item.dataset.id !== draggedId) {
      onDrop({ preventDefault:()=>{}, stopPropagation:()=>{}, clientY: touch.clientY, currentTarget: item }, item.dataset.id);
      return;
    }
    const section = target.closest('[data-status]');
    if (section) { onSectionDrop({ preventDefault:()=>{} }, section.dataset.status); }
  }
  onDragEnd();
}

// ── Render ───────────────────────────────────────────────────

function pickStatus(s) {
  newStatus = s;
  document.querySelectorAll('.spick').forEach(b => {
    b.classList.toggle('sel', b.dataset.s === s);
  });
}

function itemHTML(item) {
  const tagsArea = editingTitleFor === item.id
    ? ''
    : editingTagsFor === item.id
    ? `<div class="tag-edit-wrap">
         <span class="tag-edit-label">Tags</span>
         <input id="tagedit-${item.id}" class="tag-edit-input"
                value="${esc(item.tags.join(', '))}" placeholder="tag1, tag2"
                onkeydown="if(event.key==='Enter')setTags('${item.id}',this.value);if(event.key==='Escape')cancelTagEdit()"
                onblur="cancelTagEdit()">
         <button class="btn-tag-save" onmousedown="event.preventDefault()" onclick="setTags('${item.id}',document.getElementById('tagedit-${item.id}').value)">✓</button>
       </div>`
    : `<div class="item-tags">
         ${item.tags.map(t => `<span class="item-tag${activeTag===t?' active':''}">${esc(t)}</span>`).join('')}
       </div>`;

  return `
    <div class="item" data-id="${item.id}"
         ondragover="onDragOver(event,'${item.id}')"
         ondragleave="onDragLeave(event)"
         ondrop="onDrop(event,'${item.id}')"
         ondragend="onDragEnd()">
      <span class="drag-handle" draggable="true"
            ondragstart="onDragStart(event,'${item.id}')"
            ontouchstart="onTouchDragStart(event,'${item.id}')">⠿</span>
      ${editingTitleFor === item.id
        ? `<div class="item-title-wrap"><span id="titleedit-${item.id}" class="item-title" contenteditable="true" spellcheck="false"
                  onkeydown="if(event.key==='Enter'){event.preventDefault();setTitle('${item.id}',this.textContent.trim());}if(event.key==='Escape')cancelTitleEdit();"
                  onblur="setTitle('${item.id}',this.textContent.trim())">${esc(item.title)}</span><button class="btn-title-done" onmousedown="event.preventDefault()" onclick="setTitle('${item.id}',document.getElementById('titleedit-${item.id}').textContent.trim())">✓</button></div>`
        : `<div class="item-title-wrap"><span class="item-title">${esc(item.title)}</span><button class="btn-expand" onclick="showTitlePopup(event,'${item.id}')">[…]</button></div>`}
      ${tagsArea}
      ${editingTagsFor === item.id || editingTitleFor === item.id ? '' : `<div class="item-btns">
        <button class="btn-title-edit" onclick="startTitleEdit('${item.id}')">✎</button>
        <button class="btn-tag-edit" onclick="startTagEdit('${item.id}')">#</button>
        <button class="item-del" onclick="confirmDelete(this,'${item.id}')">×</button>
      </div>`}
    </div>`;
}

function sectionHTML(status) {
  const items = data.items.filter(i => i.status === status && (!activeTag || i.tags.includes(activeTag)));
  return `
    <div class="section" data-status="${status}"
         ondragover="onSectionDragOver(event,'${status}')"
         ondragleave="onSectionDragLeave(event)"
         ondrop="onSectionDrop(event,'${status}')">
      <div class="section-head">
        <span class="section-title">${LABELS[status]}</span>
        <span class="section-count">${items.length}</span>
      </div>
      ${items.length
        ? items.map(itemHTML).join('')
        : `<div class="section-empty">—</div>`}
    </div>`;
}

function addFormHTML() {
  return `
    <div class="add-form">
      <div class="status-picker">
        ${ADD_STATUSES.map(s => `
          <button class="spick${s === newStatus ? ' sel' : ''}" data-s="${s}" onclick="pickStatus('${s}')">${LABELS[s]}</button>
        `).join('')}
      </div>
      <input id="inp-title" class="add-input" type="text" placeholder="Title" autocomplete="off" spellcheck="false">
      <div class="add-tags-row" onclick="document.getElementById('inp-tags').focus()">
        ${allTags().map(tag=>`<span class="tag add-tag-opt" data-tag="${esc(tag)}" onclick="toggleAddTag('${esc(tag)}')">${esc(tag)}</span>`).join('')}
        <input id="inp-tags" class="add-tags-input" type="text" placeholder="Tags" autocomplete="off" spellcheck="false">
      </div>
      <div class="add-btns">
        <button class="btn-submit" onclick="submitAdd()">Add</button>
        <button class="btn-dismiss" onclick="cancelAdd()">Cancel</button>
      </div>
    </div>`;
}

function render() {
  const title = (config && config.title) || 'Dashboard';
  document.title = title;
  document.getElementById('app').innerHTML = `
    <header>
      <div class="header-inner">
        <span class="site-title">${esc(title)}</span>
        <div class="header-right">
          <span class="sync-status"></span>
          <button class="btn-new" onclick="startAdd()">+ New</button>
          <button class="btn-gear" onclick="document.querySelector('.setup-card') ? render() : showSetup()" title="settings">⚙</button>
        </div>
      </div>
    </header>
    <div class="content">
      ${isAdding ? addFormHTML() : ''}
      ${(()=>{
        const tags = allTags();
        if (!tags.length) return '';
        return `<div class="tag-cloud">
          <span class="tag-cloud-label">Tags</span>
          ${tags.map(t => `<span class="tag${activeTag===t?' active':''}" onclick="filterByTag('${esc(t)}')">${esc(t)}</span>`).join('')}
        </div>`;
      })()}
      ${STATUSES.map(sectionHTML).join('')}
      <div class="page-end">· · ·</div>
    </div>`;

  if (isAdding) {
    const inp    = document.getElementById('inp-title');
    const tagInp = document.getElementById('inp-tags');
    inp.focus();
    if (activeTag && tagInp) {
      tagInp.value = activeTag;
      document.querySelectorAll('.add-tag-opt').forEach(el => {
        el.classList.toggle('active', el.dataset.tag === activeTag);
      });
    }
    [inp, tagInp].forEach(el => el && el.addEventListener('keydown', e => {
      if (e.key === 'Enter')  submitAdd();
      if (e.key === 'Escape') cancelAdd();
    }));
  }

  if (editingTagsFor) {
    const inp = document.getElementById(`tagedit-${editingTagsFor}`);
    if (inp) { inp.focus(); inp.select(); }
  }

  if (editingTitleFor) {
    const el = document.getElementById(`titleedit-${editingTitleFor}`);
    if (el) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  if (touchSelId) {
    document.querySelector(`.item[data-id="${touchSelId}"]`)?.classList.add('touch-sel');
  }
  checkTruncation();
}

function startAdd() {
  isAdding = true;
  render();
}

function submitAdd() {
  const inp    = document.getElementById('inp-title');
  const tagInp = document.getElementById('inp-tags');
  const title  = inp ? inp.value.trim() : '';
  const tags   = tagInp ? parseTags(tagInp.value) : [];
  isAdding = false;
  if (title) addItem(title, newStatus, tags);
  else render();
}

function cancelAdd() {
  isAdding = false;
  render();
}

// ── Setup screen ─────────────────────────────────────────────

function showSetup() {
  const c = config || {};
  const title = c.title || 'Dashboard';
  document.title = title;
  document.getElementById('app').innerHTML = `
    <header>
      <div class="header-inner">
        <span class="site-title">${esc(title)}</span>
        <div class="header-right">
          <button class="btn-gear" onclick="document.querySelector('.setup-card') ? render() : showSetup()" title="settings">⚙</button>
        </div>
      </div>
    </header>
    <div class="content">
    <div class="setup-card">
      <div class="setup-head">Setup</div>
      <p class="setup-desc">
        Create a private GitHub repo for your data, then enter your credentials below.
        Your PAT is saved only in this browser.
      </p>
      <div class="field">
        <label class="field-label" for="s-title">Title</label>
        <input id="s-title" type="text" value="${esc(c.title || '')}" placeholder="Dashboard">
      </div>
      <div class="field">
        <label class="field-label" for="s-pat">GitHub PAT</label>
        <input id="s-pat" type="password" value="${esc(c.pat || '')}" placeholder="ghp_…" autocomplete="off">
      </div>
      <div class="field">
        <label class="field-label" for="s-owner">GitHub username</label>
        <input id="s-owner" type="text" value="${esc(c.owner || '')}" placeholder="username">
      </div>
      <div class="field">
        <label class="field-label" for="s-repo">Data repo name</label>
        <input id="s-repo" type="text" value="${esc(c.repo || '')}" placeholder="my-data">
      </div>
      <div class="setup-btns">
        <button class="btn-connect" onclick="saveSetup()">Save</button>
        ${config ? `<button class="btn-back" onclick="render()">Cancel</button>` : ''}
      </div>
      <div class="setup-msg" id="setup-msg"></div>
    </div>
    </div>`;

  document.getElementById('s-title').focus();
  ['s-title','s-pat','s-owner','s-repo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') saveSetup(); });
  });
}

async function saveSetup() {
  const titleVal = document.getElementById('s-title').value.trim();
  const pat      = document.getElementById('s-pat').value.trim();
  const owner    = document.getElementById('s-owner').value.trim();
  const repo     = document.getElementById('s-repo').value.trim();
  const msgEl = document.getElementById('setup-msg');

  if (!pat || !owner || !repo) {
    msgEl.style.color = '#e03e3e';
    msgEl.textContent = 'All fields required.';
    return;
  }

  msgEl.style.color = '#666';
  msgEl.textContent = 'Connecting…';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' } }
    );
    if (res.status === 401) { msgEl.style.color = '#e03e3e'; msgEl.textContent = 'Invalid PAT.'; return; }
    if (res.status === 404) { msgEl.style.color = '#e03e3e'; msgEl.textContent = 'Not found or no access.'; return; }
    if (!res.ok)            { msgEl.style.color = '#e03e3e'; msgEl.textContent = `Error: HTTP ${res.status}`; return; }
  } catch {
    msgEl.style.color = '#e03e3e';
    msgEl.textContent = 'Network error.';
    return;
  }

  config = { pat, owner, repo, title: titleVal || 'Dashboard' };
  localStorage.setItem(CFG_KEY, JSON.stringify(config));
  await init();
}

// ── Init ─────────────────────────────────────────────────────

async function init() {
  try { config = JSON.parse(localStorage.getItem(CFG_KEY)); } catch { config = null; }
  activeTag = localStorage.getItem('activeTag') || null;

  if (!config) { showSetup(); return; }

  document.getElementById('app').innerHTML = '<div class="content"><div class="loading">Loading…</div></div>';

  try {
    const fresh = await ghLoad();
    data = fresh !== null ? fresh : { items: [] };
    savedSnapshot = JSON.stringify(data);
    render();
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<div class="content"><div class="loading"><div>Failed to load: ${esc(e.message)}<button class="btn-submit" style="margin-top:16px;display:block" onclick="showSetup()">Settings</button></div></div></div>`;
  }
}

init();

document.addEventListener('click', e => {
  if (!isTouch()) return;
  if (e.target.tagName === 'BUTTON') return;
  closeTitlePopup();
  const item = e.target.closest('.item');
  const id = item?.dataset.id;
  if (touchSelId) {
    document.querySelector(`.item[data-id="${touchSelId}"]`)?.classList.remove('touch-sel');
    const prev = touchSelId;
    touchSelId = null;
    if (prev === id) return;
  }
  if (id) {
    touchSelId = id;
    item.classList.add('touch-sel');
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
