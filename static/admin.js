(() => {
'use strict';

const state = {
  tracks: [],
  bgmList: [],
  bgmDirs: [],
  dirty: false,
  perCardSearch: new Map(),
};

function randId() {
  return 'id_' + Math.random().toString(36).slice(2, 10);
}

function defaultTrack() {
  return {
    _id: randId(),
    name: '新曲目',
    category: '未分类',
    filename: '',
    bgm_dir_id: 'default',
    bpm: 120,
    beats_per_bar: 4,
    audio_zero_bar: 1,
    audio_zero_beat: 1,
    loop_start_bar: 5,
    loop_start_beat: 1,
    loop_end_bar: 32,
    loop_end_beat: 1,
    fade_in_beats: 0,
    fade_out_beats: 0,
    fade_out_start_bar: 0,
    fade_out_start_beat: 1,
    loop_mode: 'single',
    jump_seg_start_bar: 0,
    jump_seg_start_beat: 0,
    jump_seg_end_bar: 0,
    jump_seg_end_beat: 0,
    font_face: 'default',
  };
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function setStatus(msg, type = 'info') {
  const bar = $('#statusBar');
  if (!bar) return;
  bar.className = 'status-bar ' + type;
  bar.textContent = msg || '';
  if (msg) {
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => {
      bar.className = 'status-bar';
      bar.textContent = '';
    }, 4000);
  }
}

function absBeat(bar, beat, bpb) {
  return (Number(bar) - 1) * Number(bpb) + Number(beat);
}

function computePreview(t) {
  const bpm = Number(t.bpm) || 0;
  const bpb = Number(t.beats_per_bar) || 4;
  if (!bpm || bpm <= 0) return { ms_per_beat: 0, lines: ['⚠️ BPM 非法'] };
  const msPerBeat = (60 / bpm) * 1000;
  const zero = absBeat(t.audio_zero_bar, t.audio_zero_beat, bpb);
  const LS = absBeat(t.loop_start_bar, t.loop_start_beat, bpb);
  const LE = absBeat(t.loop_end_bar, t.loop_end_beat, bpb);
  const ofs = (beatAbs) => (beatAbs - zero) * msPerBeat;
  const fmt = (ms) => {
    if (!isFinite(ms)) return '—';
    const sign = ms < 0 ? '-' : '';
    const m = Math.floor(Math.abs(ms) / 60000);
    const s = Math.floor((Math.abs(ms) % 60000) / 1000);
    const mil = Math.floor(Math.abs(ms) % 1000);
    return `${sign}${m}:${s.toString().padStart(2, '0')}.${mil.toString().padStart(3, '0')}`;
  };
  const LSofs = ofs(LS), LEofs = ofs(LE);
  const loopLenMs = (LE - LS) * msPerBeat;
  const lines = [
    `⏱ 每拍 ${msPerBeat.toFixed(3)} ms · 每小节 = ${(msPerBeat * bpb).toFixed(2)} ms`,
    `🎬 循环起点 (${t.loop_start_bar}:${t.loop_start_beat}) = ${fmt(LSofs)}`,
    `🔁 循环终点 (${t.loop_end_bar}:${t.loop_end_beat}) = ${fmt(LEofs)} · 循环长度 = ${fmt(loopLenMs)}`,
  ];
  if (t.fade_in_beats > 0) {
    lines.push(`🌅 淡入 ${Number(t.fade_in_beats)} 拍 = ${fmt(Number(t.fade_in_beats) * msPerBeat)}（从循环起点开始）`);
  } else {
    lines.push(`🌅 淡入：禁用（0 拍，保持原声衔接）`);
  }
  if (Number(t.fade_out_beats) > 0 && Number(t.fade_out_beats) !== null) {
    const foBeats = Number(t.fade_out_beats);
    const foDurMs = foBeats * msPerBeat;
    const foAuto = !(Number(t.fade_out_start_bar) >= 1);
    let foStartOfs, foLabel;
    if (foAuto) {
      foStartOfs = LEofs - foDurMs;
      foLabel = '自动（淡出结束对齐循环终点）';
    } else {
      const foStart = absBeat(t.fade_out_start_bar, t.fade_out_start_beat || 1, bpb);
      foStartOfs = ofs(foStart);
      foLabel = `${t.fade_out_start_bar}:${t.fade_out_start_beat || 1}`;
    }
    const foEndOfs = foStartOfs + foDurMs;
    lines.push(`🌇 淡出起点 (${foLabel}) = ${fmt(foStartOfs)} · ${foBeats}拍 = ${fmt(foDurMs)} → 淡出结束 = ${fmt(foEndOfs)}`);
  } else {
    lines.push(`🌇 淡出：禁用（0 拍，自然播放到结束不硬切）`);
  }
  if (Number(t.jump_seg_start_bar) > 0 && Number(t.jump_seg_end_bar) > 0) {
    const jS = absBeat(t.jump_seg_start_bar, t.jump_seg_start_beat || 1, bpb);
    const jE = absBeat(t.jump_seg_end_bar, t.jump_seg_end_beat || 1, bpb);
    const jSo = ofs(jS), jEo = ofs(jE);
    lines.push(`🔀 跳转段：循环终点(${fmt(LEofs)}) → 段起(${t.jump_seg_start_bar}:${t.jump_seg_start_beat||1}=${fmt(jSo)}) → 段末(${t.jump_seg_end_bar}:${t.jump_seg_end_beat||1}=${fmt(jEo)}) → 循环起点(${fmt(LSofs)}) · 段长 = ${fmt((jE-jS)*msPerBeat)}`);
  } else {
    lines.push(`🔀 跳转段：禁用`);
  }
  return { ms_per_beat: msPerBeat, lines };
}

/* ============================ API helpers ============================ */

async function loadConfig() {
  const res = await fetch('/api/config', { credentials: 'include' });
  if (res.status === 401) { location.href = '/login'; throw new Error('未登录'); }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '加载失败');
  const raw = data.data || {};
  const tracks = (raw.tracks || []).map(t => ({ ...defaultTrack(), ...t, _id: t._id || randId() }));
  tracks.forEach(t => {
    if (!t.bgm_dir_id) t.bgm_dir_id = 'default';
    if (typeof t.fade_out_start_bar === 'undefined' || t.fade_out_start_bar === null) t.fade_out_start_bar = 0;
    if (typeof t.fade_out_start_beat === 'undefined' || t.fade_out_start_beat === null) t.fade_out_start_beat = 1;
    if (typeof t.jump_seg_start_bar === 'undefined') t.jump_seg_start_bar = 0;
    if (typeof t.jump_seg_start_beat === 'undefined') t.jump_seg_start_beat = 0;
    if (typeof t.jump_seg_end_bar === 'undefined') t.jump_seg_end_bar = 0;
    if (typeof t.jump_seg_end_beat === 'undefined') t.jump_seg_end_beat = 0;
  });
  state.tracks = tracks;
  state.dirty = false;
  return tracks;
}

async function saveConfig() {
  const sanitized = state.tracks.map(({ _id, _expanded, ...t }) => t);
  const res = await fetch('/api/config', {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: sanitized }),
  });
  if (res.status === 401) { location.href = '/login'; return false; }
  const data = await res.json();
  if (!data.ok) { setStatus('💾 保存失败：' + (data.error || ''), 'err'); return false; }
  state.dirty = false;
  $$('.track-card').forEach(c => c.classList.remove('dirty'));
  setStatus('✅ 配置已保存！', 'ok');
  return true;
}

async function refreshBgmList(searchQuery) {
  const s = (typeof searchQuery === 'string') ? searchQuery.trim() : '';
  const params = new URLSearchParams();
  if (s) params.set('search', s);
  params.set('mode', 'flat');
  const res = await fetch(`/api/bgm-list?${params.toString()}`, { credentials: 'include' });
  if (!res.ok) throw new Error('加载 BGM 列表失败 ' + res.status);
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || '加载 BGM 列表失败');
  state.bgmList = (d.data && d.data.files) || [];
  state.bgmDirs = (d.data && d.data.dirs) || [];
  return d.data;
}

async function apiBgmDirs(action, payload) {
  const res = await fetch('/api/bgm-dirs', {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(payload || {}) }),
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('未登录'); }
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || '目录操作失败');
  return d.data;
}

/* ============================ DIR PANEL ============================ */

function renderDirPanel() {
  const container = $('#dirList');
  container.innerHTML = '';
  state.bgmDirs.forEach(d => {
    const card = document.createElement('div');
    card.className = 'dir-card' + (d.id === 'default' ? ' default' : '') + (d.exists && !d.is_dir ? ' bad' : '');
    let badgeHtml;
    if (d.id === 'default') badgeHtml = `<span class="dir-badge default">默认</span>`;
    else if (d.exists && d.is_dir) badgeHtml = `<span class="dir-badge ok">可用</span>`;
    else badgeHtml = `<span class="dir-badge missing">不存在</span>`;

    const fileCount = state.bgmList.filter(e => e.dir_id === d.id).length;

    card.innerHTML = `
      ${badgeHtml}
      <div class="dir-info">
        <div class="d-label"></div>
        <div class="d-path"></div>
        <div class="d-meta">ID: <span class="cnt">${escapeHtml(d.id)}</span> · 已识别音频：<span class="cnt">${fileCount}</span> 个</div>
      </div>
      <div class="dir-actions">
        <button class="btn btn-small" data-act="scan" title="重新扫描该目录">🔄 扫描</button>
        <button class="btn btn-small btn-danger" data-act="del" ${d.id === 'default' ? 'disabled' : ''} title="${d.id === 'default' ? '默认目录不可删除' : ''}">删除</button>
      </div>
    `;
    card.querySelector('.d-label').textContent = d.label || '(未命名)';
    card.querySelector('.d-path').textContent = (d.path || '') + (d.abs_path && d.abs_path !== d.path ? `   ➜   ${d.abs_path}` : '');
    card.querySelector('[data-act="scan"]').addEventListener('click', async () => {
      setStatus(`扫描目录：${d.label}...`, 'info');
      try {
        const data = await apiBgmDirs('scan', { id: d.id });
        state.bgmDirs = data.dirs;
        state.bgmList = (data.files || []);
        renderDirPanel();
        $$('.track-card select.file-select').forEach(renderSelectOptionsForOne);
        $('#dirCount').textContent = state.bgmDirs.length;
        setStatus(`✅ 扫描完成：${d.label} 新增/更新共 ${data.file_count || 0} 个文件`, 'ok');
      } catch (e) { setStatus('扫描失败：' + e.message, 'err'); }
    });
    const delBtn = card.querySelector('[data-act="del"]');
    if (d.id !== 'default') {
      delBtn.addEventListener('click', async () => {
        const used = state.tracks.filter(t => (t.bgm_dir_id || 'default') === d.id).length;
        const msg = used > 0
          ? `确定删除目录 "${d.label}" 吗？\n当前有 ${used} 首曲目引用该目录，删除后这些曲目将自动回退到"默认目录"。`
          : `确定删除目录 "${d.label}" 吗？`;
        if (!confirm(msg)) return;
        try {
          const data = await apiBgmDirs('delete', { id: d.id });
          if (used > 0) {
            state.tracks.forEach(t => { if ((t.bgm_dir_id || 'default') === d.id) t.bgm_dir_id = 'default'; });
            state.dirty = true;
          }
          state.bgmDirs = data.dirs;
          state.bgmList = (data.files || []);
          renderDirPanel();
          renderAllTracks();
          $('#dirCount').textContent = state.bgmDirs.length;
          setStatus(`✅ 已删除目录 "${d.label}"`, 'ok');
        } catch (e) { setStatus('删除失败：' + e.message, 'err'); }
      });
    }
    container.appendChild(card);
  });
  $('#dirCount').textContent = state.bgmDirs.length;
}

/* ============================ TRACK RENDER ============================ */

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function validateTrack(t, rootEl) {
  let ok = true;
  const requiredNums = ['bpm','beats_per_bar','audio_zero_bar','audio_zero_beat','loop_start_bar','loop_start_beat','loop_end_bar','loop_end_beat'];
  requiredNums.forEach(f => {
    const el = rootEl.querySelector(`[data-k="${f}"]`);
    const v = Number(t[f]);
    if (!el) return;
    if (!isFinite(v) || v <= 0) { el.classList.add('invalid'); ok = false; }
    else el.classList.remove('invalid');
  });
  const fileSel = rootEl.querySelector('select.file-select');
  if (!t.filename) {
    if (fileSel) fileSel.classList.add('invalid');
    ok = false;
  } else {
    if (fileSel) fileSel.classList.remove('invalid');
  }
  return ok;
}

function renderSelectOptionsForOne(selectEl) {
  const trackId = selectEl.dataset.trackId;
  const track = state.tracks.find(t => t._id === trackId);
  const cardSearch = (state.perCardSearch.get(trackId) || '').trim().toLowerCase();

  const curDirId = track ? (track.bgm_dir_id || 'default') : 'default';
  const curFn = track ? (track.filename || '') : '';
  const dirInfo = state.bgmDirs.find(d => d.id === curDirId) || { id: curDirId, label: curDirId };
  const dirLabel = dirInfo.label || curDirId;

  const filesInDir = state.bgmList.filter(e => e.dir_id === curDirId);
  const filtered = filesInDir.filter(e => {
    if (!cardSearch) return true;
    return (e.filename || '').toLowerCase().includes(cardSearch);
  });

  let html = '';
  html += `<option value="">— 未选择音频 —</option>`;
  filtered.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')).forEach(e => {
    const sel = e.filename === curFn ? 'selected' : '';
    html += `<option value="${encodeURIComponent(e.dir_id)}::${encodeURIComponent(e.filename)}" data-dir="${escapeHtml(e.dir_id)}" data-fn="${escapeHtml(e.filename)}" ${sel}>${escapeHtml(e.filename)}</option>`;
  });

  const totalInDir = filesInDir.length;
  const shown = filtered.length;
  if (totalInDir === 0) {
    html += `<option disabled>— 当前目录暂无音频文件 —</option>`;
  } else {
    html += `<option disabled>— ${escapeHtml(dirLabel)}：${shown}/${totalInDir} 个${cardSearch ? `（搜索：${escapeHtml(cardSearch)}）` : ''} —</option>`;
  }
  selectEl.innerHTML = html;

  if (curFn) {
    const need = encodeURIComponent(curDirId) + '::' + encodeURIComponent(curFn);
    if (selectEl.value !== need) {
      if (Array.from(selectEl.options).some(o => o.value === need)) {
        selectEl.value = need;
      } else {
        const fake = document.createElement('option');
        fake.value = need;
        fake.selected = true;
        fake.textContent = `⚠️ 当前：${curFn}（不在当前目录或搜索结果中）`;
        selectEl.insertBefore(fake, selectEl.firstChild.nextSibling);
      }
    }
  }
}

function renderTrackCard(t, index) {
  const card = document.createElement('div');
  const startExpanded = !!t._expanded;
  card.className = 'track-card' + (startExpanded ? '' : ' collapsed');
  card.dataset.trackId = t._id;
  card.innerHTML = `
    <div class="tc-header">
      <button class="tc-collapse-btn" data-act="toggle" title="展开 / 折叠">
        <span class="tc-collapse-arrow">▾</span>
      </button>
      <div class="tc-title">
        <div class="tc-idx"></div>
        <input type="text" class="tc-name-input" data-k="name" value="">
      </div>
      <div class="tc-actions">
        <button class="btn btn-icon" data-act="up" title="上移">↑</button>
        <button class="btn btn-icon" data-act="down" title="下移">↓</button>
        <button class="btn btn-icon" data-act="insert-above" title="在上方添加">⊕↑</button>
        <button class="btn btn-icon" data-act="insert-below" title="在下方添加">⊕↓</button>
        <button class="btn btn-icon" data-act="duplicate" title="复制">⎘</button>
        <button class="btn btn-icon" data-act="delete" title="删除" style="background:var(--danger);">🗑</button>
      </div>
    </div>
    <div class="tc-body">
    <div class="section-title">🎵 基础 &amp; 文件</div>
    <div class="grid-1">
      <div class="field">
        <label>分类 <span class="hint">(默认未分类；主页按此分组折叠显示，同名称归为一组)</span></label>
        <input type="text" data-k="category" placeholder="例：战斗 / 日常 / BOSS / 抒情 / 钢琴 / 未分类">
      </div>
      <div class="field">
        <label>歌词字体</label>
        <select data-k="font_face">
          <option value="default">默认字体</option>
          <option value="teyvat">提瓦特字体</option>
        </select>
      </div>
    </div>
    <div class="grid-4">
      <div class="field">
        <label>BPM <span class="hint">(每分钟拍数)</span></label>
        <input type="number" step="0.01" min="0.1" data-k="bpm">
      </div>
      <div class="field">
        <label>拍号 (每小节拍数)</label>
        <input type="number" step="1" min="1" data-k="beats_per_bar">
      </div>
      <div class="field">
        <label>循环模式</label>
        <select data-k="loop_mode">
          <option value="single">单轨循环（无缝交叉）</option>
          <option value="dual">双轨循环（旧轨放完 + 独立淡入淡出）</option>
        </select>
      </div>
      <div class="field">
        <label>所属 BGM 目录</label>
        <select data-k="bgm_dir_id" class="dir-select">
          ${state.bgmDirs.map(d => `<option value="${escapeHtml(d.id)}">${d.id === 'default' ? '🟠 ' : '🟣 '}${escapeHtml(d.label || d.id)}${d.exists ? '' : ' ⚠️'}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label>音频文件 <span class="hint">(仅显示上方所选目录；可在此过滤文件名)</span></label>
        <div class="file-picker">
          <input type="search" class="fp-search" placeholder="🔍 在此曲目内按文件名过滤…（支持中英文）">
          <select class="file-select" size="6" data-track-id="${t._id}"></select>
        </div>
      </div>
      <div class="field">
        <label>计算预览 <span class="hint">(实时)</span></label>
        <div class="calc-hint preview"></div>
      </div>
    </div>

    <div class="section-title">🕐 节拍对齐</div>
    <div class="grid-4">
      <div class="field">
        <label>音频 0s 所在小节</label>
        <input type="number" step="1" min="1" data-k="audio_zero_bar">
      </div>
      <div class="field">
        <label>音频 0s 所在拍</label>
        <input type="number" step="1" min="1" data-k="audio_zero_beat">
      </div>
      <div class="field">
        <label>循环起点 (小节)</label>
        <input type="number" step="1" min="1" data-k="loop_start_bar">
      </div>
      <div class="field">
        <label>循环起点 (拍)</label>
        <input type="number" step="1" min="1" data-k="loop_start_beat">
      </div>
      <div class="field">
        <label>循环终点 (小节)</label>
        <input type="number" step="1" min="1" data-k="loop_end_bar">
      </div>
      <div class="field">
        <label>循环终点 (拍)</label>
        <input type="number" step="1" min="1" data-k="loop_end_beat">
      </div>
      <div class="field fade_out_start_bar_wrap">
        <label>淡出起点小节 <span class="hint">(0=自动，淡出结束对齐循环终点)</span></label>
        <input type="number" step="1" min="0" data-k="fade_out_start_bar">
      </div>
      <div class="field fade_out_start_beat_wrap">
        <label>淡出起点拍</label>
        <input type="number" step="1" min="1" data-k="fade_out_start_beat">
      </div>
    </div>

    <div class="section-title">🌅 淡入淡出（双轨模式下生效；单轨始终最小交叉）</div>
    <div class="grid-2">
      <div class="field">
        <label>淡入拍数 <span class="hint">(从循环起点开始；0=禁用)</span></label>
        <input type="number" step="1" min="0" data-k="fade_in_beats">
      </div>
      <div class="field">
        <label>淡出拍数 <span class="hint">(从淡出起点开始；0=禁用，旧轨自然放完)</span></label>
        <input type="number" step="1" min="0" data-k="fade_out_beats">
      </div>
    </div>

    <div class="section-title">🔀 跳转段（可选）：循环终点 → 段起 → 段末 → 循环起点</div>
    <div class="grid-4">
      <div class="field">
        <label>跳转段起 小节 <span class="hint">(0=禁用)</span></label>
        <input type="number" step="1" min="0" data-k="jump_seg_start_bar">
      </div>
      <div class="field">
        <label>跳转段起 拍</label>
        <input type="number" step="1" min="1" data-k="jump_seg_start_beat">
      </div>
      <div class="field">
        <label>跳转段末 小节</label>
        <input type="number" step="1" min="0" data-k="jump_seg_end_bar">
      </div>
      <div class="field">
        <label>跳转段末 拍</label>
        <input type="number" step="1" min="1" data-k="jump_seg_end_beat">
      </div>
    </div>
    </div>
  `;

  $('.tc-idx', card).textContent = String(index + 1);
  $('.tc-name-input', card).value = t.name || '';
  $$('input, select', card).forEach(el => {
    const k = el.dataset.k;
    if (k && el.classList.contains('tc-name-input')) { el.value = t[k] ?? ''; }
    else if (k && typeof t[k] !== 'undefined' && k !== 'bgm_dir_id') { el.value = t[k]; }
    else if (k === 'bgm_dir_id') { el.value = t.bgm_dir_id || 'default'; }
  });
  const dirSelect = $('select[data-k="bgm_dir_id"]', card);
  dirSelect.addEventListener('change', () => {
    t.bgm_dir_id = dirSelect.value || 'default';
    markDirty(card);
    renderSelectOptionsForOne($('select.file-select', card));
  });

  const fileSelect = $('select.file-select', card);
  renderSelectOptionsForOne(fileSelect);
  fileSelect.addEventListener('change', () => {
    const v = fileSelect.value;
    if (!v) { t.filename = ''; t.bgm_dir_id = t.bgm_dir_id || 'default'; }
    else {
      const [encDir, encFn] = v.split('::');
      t.bgm_dir_id = decodeURIComponent(encDir);
      t.filename = decodeURIComponent(encFn);
      dirSelect.value = t.bgm_dir_id;
    }
    markDirty(card);
    validateTrack(t, card);
  });
  const fpSearch = $('input.fp-search', card);
  fpSearch.value = state.perCardSearch.get(t._id) || '';
  fpSearch.addEventListener('input', () => {
    state.perCardSearch.set(t._id, fpSearch.value);
    renderSelectOptionsForOne(fileSelect);
  });

  $$('input, select', card).forEach(el => {
    if (el.classList.contains('file-select') || el.classList.contains('fp-search') || el.classList.contains('dir-select')) return;
    el.addEventListener('input', () => {
      const k = el.dataset.k;
      if (!k) return;
      let v = el.value;
      if (el.type === 'number') { v = v === '' ? 0 : Number(v); }
      t[k] = v;
      markDirty(card);
      refreshPreview(card, t);
      validateTrack(t, card);
    });
  });

  // actions
  card.querySelector('[data-act="up"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    if (i <= 0) return;
    [state.tracks[i - 1], state.tracks[i]] = [state.tracks[i], state.tracks[i - 1]];
    markDirty();
    renderAllTracks();
  });
  card.querySelector('[data-act="down"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    if (i < 0 || i >= state.tracks.length - 1) return;
    [state.tracks[i + 1], state.tracks[i]] = [state.tracks[i], state.tracks[i + 1]];
    markDirty();
    renderAllTracks();
  });
  card.querySelector('[data-act="insert-above"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    const newTrack = { ...defaultTrack(), _expanded: true };
    state.tracks.splice(i, 0, newTrack);
    markDirty();
    renderAllTracks();
    requestAnimationFrame(() => {
      const container = $('#tracksContainer');
      if (container) container.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  card.querySelector('[data-act="insert-below"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    const newTrack = { ...defaultTrack(), _expanded: true };
    state.tracks.splice(i + 1, 0, newTrack);
    markDirty();
    renderAllTracks();
    requestAnimationFrame(() => {
      const newCard = document.querySelector(`.track-card[data-track-id="${newTrack._id}"]`);
      if (newCard) newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  card.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    const copy = { ...defaultTrack(), ...JSON.parse(JSON.stringify(t)), _id: randId(), name: (t.name || '新曲目') + ' (副本)', _expanded: true };
    state.tracks.splice(i + 1, 0, copy);
    markDirty();
    renderAllTracks();
  });
  card.querySelector('[data-act="delete"]').addEventListener('click', () => {
    if (!confirm(`确定删除曲目 "${t.name}" 吗？`)) return;
    state.tracks = state.tracks.filter(x => x._id !== t._id);
    markDirty();
    renderAllTracks();
  });

  // 折叠 / 展开
  const toggleCollapse = (e) => {
    if (e) {
      const tag = (e.target && e.target.tagName) || '';
      const cls = (e.target && e.target.className) || '';
      if (typeof cls === 'string' && (
        cls.includes('btn-icon') || cls.includes('tc-name-input') ||
        cls.includes('tc-collapse-btn')
      )) {
        if (cls.includes('btn-icon') || cls.includes('tc-name-input')) return;
      }
      if (e.target.closest && (e.target.closest('button') && !e.target.closest('.tc-collapse-btn'))) return;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'LABEL') return;
    }
    const collapsed = card.classList.toggle('collapsed');
    const arrow = card.querySelector('.tc-collapse-arrow');
    if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
  };
  const hdr = card.querySelector('.tc-header');
  const collBtn = card.querySelector('.tc-collapse-btn');
  if (hdr) hdr.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.tc-actions') && !e.target.closest('.tc-collapse-btn')) return;
    toggleCollapse(e);
  });
  if (collBtn) collBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCollapse(null);
  });
  // 默认折叠态箭头
  const arrow = card.querySelector('.tc-collapse-arrow');
  if (arrow && card.classList.contains('collapsed')) arrow.textContent = '▸';

  refreshPreview(card, t);
  validateTrack(t, card);
  return card;
}

function refreshPreview(card, t) {
  const box = card.querySelector('.calc-hint.preview');
  if (!box) return;
  const { lines } = computePreview(t);
  box.innerHTML = lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
}

function renderAllTracks() {
  const root = $('#tracksContainer');
  root.innerHTML = '';
  state.tracks.forEach((t, i) => {
    const c = renderTrackCard(t, i);
    if (state.dirty) c.classList.add('dirty');
    root.appendChild(c);
  });
  $('#trackCount').textContent = state.tracks.length;
}

function markDirty(card) {
  state.dirty = true;
  if (card) card.classList.add('dirty');
  else $$('.track-card').forEach(c => c.classList.add('dirty'));
}

/* ============================ INIT & BIND ============================ */

async function init() {
  try {
    setStatus('正在加载配置与 BGM 列表…', 'info');
    await loadConfig();
    await refreshBgmList('');
    renderDirPanel();
    renderAllTracks();
    setStatus(`✅ 加载完成：${state.tracks.length} 首曲目 · ${state.bgmList.length} 个 BGM 文件`, 'ok');
  } catch (e) {
    setStatus('❌ 初始化失败：' + e.message, 'err');
  }

  $('#toggleDirPanelBtn').addEventListener('click', () => {
    const p = $('#dirPanel');
    const show = p.style.display === 'none';
    p.style.display = show ? '' : 'none';
    if (show) renderDirPanel();
  });

  $('#addBtn').addEventListener('click', () => {
    const nt = defaultTrack();
    nt._expanded = true;
    state.tracks.push(nt);
    markDirty();
    renderAllTracks();
    const c = $('#tracksContainer');
    if (c) {
      requestAnimationFrame(() => {
        c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
      });
    }
  });

  $('#saveBtn').addEventListener('click', async () => {
    let allOk = true;
    $$('.track-card').forEach(c => {
      const id = c.dataset.trackId;
      const t = state.tracks.find(x => x._id === id);
      if (t && !validateTrack(t, c)) allOk = false;
    });
    if (!allOk) { setStatus('⚠️ 仍有字段非法（标红），请先修正', 'warn'); return; }
    await saveConfig();
  });

  $('#refreshBgmBtn').addEventListener('click', async () => {
    const s = $('#globalFileSearch').value;
    setStatus('🔄 重新扫描所有 BGM 目录…', 'info');
    try {
      await apiBgmDirs('scan_all', {});
      const data = await refreshBgmList(s);
      state.bgmList = data.files || [];
      state.bgmDirs = data.dirs || [];
      renderDirPanel();
      $$('.track-card select.file-select').forEach(renderSelectOptionsForOne);
      setStatus(`✅ 刷新完成，共 ${state.bgmList.length} 个文件 ${s ? `（已应用搜索 "${s}"）` : ''}`, 'ok');
    } catch (e) { setStatus('刷新失败：' + e.message, 'err'); }
  });

  $('#globalFileSearch').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const s = e.target.value;
      try {
        setStatus(`🔍 搜索："${s}"`, 'info');
        await refreshBgmList(s);
        renderDirPanel();
        $$('.track-card select.file-select').forEach(renderSelectOptionsForOne);
        setStatus(`✅ 搜索完成：共匹配 ${state.bgmList.length} 个文件`, 'ok');
      } catch (err) { setStatus('搜索失败：' + err.message, 'err'); }
    }
  });

  $('#addDirBtn').addEventListener('click', async () => {
    const label = ($('#newDirLabel').value || '').trim();
    const path = ($('#newDirPath').value || '').trim();
    if (!path) { setStatus('⚠️ 请输入路径', 'warn'); return; }
    try {
      setStatus(`添加目录：${label || path} ...`, 'info');
      const data = await apiBgmDirs('add', { label, path });
      state.bgmDirs = data.dirs;
      state.bgmList = data.files || state.bgmList;
      $('#newDirLabel').value = '';
      $('#newDirPath').value = '';
      renderDirPanel();
      renderAllTracks();
      setStatus(`✅ 目录已添加：${data.added ? data.added.label : ''}`, 'ok');
    } catch (e) { setStatus('添加失败：' + e.message, 'err'); }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    if (!confirm('确定退出登录吗？')) return;
    try {
      const r = await fetch('/api/logout', { credentials: 'include', method: 'POST' });
      const data = await r.json();
      if (r.ok && data.ok) location.href = '/login';
      else setStatus(data.error || '退出失败', 'err');
    } catch (e) {
      setStatus('退出失败：' + e.message, 'err');
    }
  });

  $('#chgPwdBtn').addEventListener('click', () => {
    $('#oldPwd').value = ''; $('#newPwd').value = ''; $('#newPwd2').value = '';
    $('#pwdErr').textContent = '';
    $('#pwdModal').style.display = '';
  });
  $('#pwdCancel').addEventListener('click', () => { $('#pwdModal').style.display = 'none'; });
  $('#pwdConfirm').addEventListener('click', async () => {
    const o = $('#oldPwd').value, n = $('#newPwd').value, n2 = $('#newPwd2').value;
    $('#pwdErr').textContent = '';
    if (!n || n.length < 4) { $('#pwdErr').textContent = '新密码至少 4 位'; return; }
    if (n !== n2) { $('#pwdErr').textContent = '两次密码不一致'; return; }
    const r = await fetch('/api/change-password', {
      credentials: 'include',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: o, new_password: n }),
    });
    const d = await r.json();
    if (!d.ok) { $('#pwdErr').textContent = d.error || '修改失败'; return; }
    $('#pwdModal').style.display = 'none';
    setStatus('✅ 密码已更新', 'ok');
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = '有未保存的修改，确定离开吗？'; return e.returnValue; }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
