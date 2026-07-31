(() => {
'use strict';

const state = {
  tracks: [],
  bgmList: [],
  bgmDirs: [],
  dirty: false,
  structuralDirty: false,
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
    loop_start_bar: 1,
    loop_start_beat: 1,
    loop_end_bar: 32,
    loop_end_beat: 1,
    lyric_end_bar: 0,
    lyric_end_beat: 0,
    fade_in_beats: 0,
    fade_out_beats: 0,
    fade_out_start_bar: 0,
    fade_out_start_beat: 0,
    loop_mode: 'single',
    jump_seg_start_bar: 0,
    jump_seg_start_beat: 0,
    jump_seg_end_bar: 0,
    jump_seg_end_beat: 0,
    font_face: 'default',
    tempo_changes: [],
    meter_changes: [],
    multi_style_enabled: false,
    styles: [],
    extra_tracks_enabled: false,
    extra_tracks: [],
    ending_enabled: false,
    ending_filename: '',
    ending_dir_id: '',
    ending_fade_duration: 2.0,
    full_loop_enabled: false,
    full_loop_fade_duration: 2.0,
    loop_sfx_enabled: false,
    loop_sfx_filename: '',
    loop_sfx_dir_id: '',
    loop_sfx_fade_in_beats: 4,
    intro_enabled: false,
    intro_filename: '',
    intro_dir_id: '',
    gain: 1.0,
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
    // 额外轨道：旧 vocal 配置迁移 + 默认值填充
    if (!Array.isArray(t.extra_tracks)) {
      const extra = [];
      if (t.vocal_enabled && t.vocal_filename) {
        extra.push({
          name: '人声轨',
          filename: t.vocal_filename || '',
          dir_id: t.vocal_dir_id || t.bgm_dir_id || 'default',
          audio_zero_bar: t.vocal_audio_zero_bar != null ? t.vocal_audio_zero_bar : 1,
          audio_zero_beat: t.vocal_audio_zero_beat != null ? t.vocal_audio_zero_beat : 1,
          volume: 1.0
        });
      }
      t.extra_tracks = extra;
      if (extra.length > 0 && t.extra_tracks_enabled == null) t.extra_tracks_enabled = true;
    }
    if (t.extra_tracks_enabled == null) t.extra_tracks_enabled = (t.extra_tracks && t.extra_tracks.length > 0);
    if (!Array.isArray(t.extra_tracks)) t.extra_tracks = [];
    t.extra_tracks.forEach(et => {
      if (et.volume == null) et.volume = 1.0;
      if (et.audio_zero_bar == null) et.audio_zero_bar = t.audio_zero_bar || 1;
      if (et.audio_zero_beat == null) et.audio_zero_beat = t.audio_zero_beat || 1;
      if (!et.dir_id) et.dir_id = t.bgm_dir_id || 'default';
    });
  });
  state.tracks = tracks;
  state.dirty = false;
  state.structuralDirty = false;
  return tracks;
}

async function saveConfig() {
  const stripMeta = ({ _expanded, ...rest }) => rest;
  let payload, mode;
  if (state.structuralDirty) {
    mode = 'full';
    payload = { tracks: state.tracks.map(stripMeta), mode };
  } else {
    mode = 'partial';
    const dirtyIds = new Set(
      $$('.track-card.dirty').map(c => c.dataset.trackId)
    );
    const dirtyTracks = state.tracks.filter(t => dirtyIds.has(t._id));
    if (dirtyTracks.length === 0) {
      state.dirty = false;
      setStatus('✅ 无变更需要保存', 'ok');
      return true;
    }
    payload = { tracks: dirtyTracks.map(stripMeta), mode };
  }
  const res = await fetch('/api/config', {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) { location.href = '/login'; return false; }
  const data = await res.json();
  if (!data.ok) { setStatus('💾 保存失败：' + (data.error || ''), 'err'); return false; }
  state.dirty = false;
  state.structuralDirty = false;
  $$('.track-card').forEach(c => c.classList.remove('dirty'));
  const saveMsg = mode === 'full' ? '全量' : '增量 ' + payload.tracks.length + ' 项';
  setStatus('✅ 配置已保存！(' + saveMsg + ')', 'ok');
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
        $$('.track-card select.vocal-file-select').forEach(s => { if (s._render) s._render(); });
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
    <div class="tc-body"></div>
  `;

  $('.tc-idx', card).textContent = String(index + 1);
  const nameInput = $('.tc-name-input', card);
  nameInput.value = t.name || '';
  nameInput.addEventListener('input', () => {
    t.name = nameInput.value;
    markDirty(card);
    if (card.dataset.bodyRendered) {
      refreshPreview(card, t);
      validateTrack(t, card);
    }
  });

  // actions
  card.querySelector('[data-act="up"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    if (i <= 0) return;
    [state.tracks[i - 1], state.tracks[i]] = [state.tracks[i], state.tracks[i - 1]];
    markDirty();
    const cardEl = getCardByTrackId(t._id);
    const prevCard = cardEl.previousElementSibling;
    if (cardEl && prevCard && prevCard.classList.contains('track-card')) {
      prevCard.insertAdjacentElement('beforebegin', cardEl);
      updateCardIndex(cardEl, i - 1);
      updateCardIndex(prevCard, i);
    }
  });
  card.querySelector('[data-act="down"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    if (i < 0 || i >= state.tracks.length - 1) return;
    [state.tracks[i + 1], state.tracks[i]] = [state.tracks[i], state.tracks[i + 1]];
    markDirty();
    const cardEl = getCardByTrackId(t._id);
    const nextCard = cardEl.nextElementSibling;
    if (cardEl && nextCard && nextCard.classList.contains('track-card')) {
      nextCard.insertAdjacentElement('afterend', cardEl);
      updateCardIndex(cardEl, i + 1);
      updateCardIndex(nextCard, i);
    }
  });
  card.querySelector('[data-act="insert-above"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    const newTrack = { ...defaultTrack(), _expanded: true };
    state.tracks.splice(i, 0, newTrack);
    markDirty();
    insertCardDOM(newTrack, i);
    requestAnimationFrame(() => {
      const newCardEl = getCardByTrackId(newTrack._id);
      if (newCardEl) newCardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  card.querySelector('[data-act="insert-below"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    const newTrack = { ...defaultTrack(), _expanded: true };
    state.tracks.splice(i + 1, 0, newTrack);
    markDirty();
    insertCardDOM(newTrack, i + 1);
    requestAnimationFrame(() => {
      const newCardEl = getCardByTrackId(newTrack._id);
      if (newCardEl) newCardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  card.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
    const i = state.tracks.indexOf(t);
    const copy = { ...defaultTrack(), ...JSON.parse(JSON.stringify(t)), _id: randId(), name: (t.name || '新曲目') + ' (副本)', _expanded: true };
    state.tracks.splice(i + 1, 0, copy);
    markDirty();
    insertCardDOM(copy, i + 1);
  });
  card.querySelector('[data-act="delete"]').addEventListener('click', () => {
    if (!confirm(`确定删除曲目 "${t.name}" 吗？`)) return;
    const i = state.tracks.indexOf(t);
    state.tracks = state.tracks.filter(x => x._id !== t._id);
    markDirty();
    const cardEl = getCardByTrackId(t._id);
    if (cardEl) {
      cardEl.remove();
      updateIndicesFrom(i);
    }
    refreshTrackCount();
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
    if (!collapsed && !card.dataset.bodyRendered) {
      renderTrackCardBody(card, t);
    }
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

  if (startExpanded) {
    renderTrackCardBody(card, t);
  }
  return card;
}

function renderTrackCardBody(card, t) {
  if (card.dataset.bodyRendered) return;
  card.dataset.bodyRendered = '1';
  const bodyEl = card.querySelector('.tc-body');
  bodyEl.innerHTML = `
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
          <option value="851tegakizatsu">851手書き雑（手写体）</option>
          <option value="zpix">Zpix 像素字体</option>
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
        <label>音频增益 <span class="hint">(默认1.0；小于1降音量，大于1提音量)</span></label>
        <input type="number" step="0.01" min="0" max="3" data-k="gain">
      </div>
      <div class="field">
        <label>循环模式</label>
        <select data-k="loop_mode">
          <option value="single">单轨循环（无缝交叉）</option>
          <option value="dual">双轨循环（旧轨放完 + 独立淡入淡出）</option>
        </select>
      </div>
    </div>
    <div class="grid-4">
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
      <div class="field">
        <label>歌词结束 小节 <span class="hint">(0=同循环终点；双轨模式下可设置更大值以显示结尾歌词)</span></label>
        <input type="number" step="1" min="0" data-k="lyric_end_bar">
      </div>
      <div class="field">
        <label>歌词结束 拍 <span class="hint">(0=同循环终点)</span></label>
        <input type="number" step="1" min="0" data-k="lyric_end_beat">
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

    <div class="section-title">⏱️ 分段变速规则（可选）：指定小节+拍号切换BPM</div>
    <div class="field">
      <div class="tempo-changes-list" data-k="tempo_changes"></div>
      <button class="btn btn-small btn-primary" data-act="add-tempo-change" style="margin-top:8px;">＋ 添加变速规则</button>
    </div>

    <div class="section-title">🎵 分段变拍规则（可选）：指定小节+拍号切换每小节拍数</div>
    <div class="field">
      <div class="meter-changes-list" data-k="meter_changes"></div>
      <button class="btn btn-small btn-primary" data-act="add-meter-change" style="margin-top:8px;">＋ 添加变拍规则</button>
    </div>

    <div class="section-title">📦 配置导入</div>
    <div class="field">
      <button class="btn btn-small btn-primary" data-act="import-changes" style="margin-top:8px;">📥 从配置代码导入变速/变拍</button>
    </div>

    <div class="section-title">🎨 多风格切换（可选）</div>
    <div class="field">
      <label class="checkbox-label">
        <input type="checkbox" data-k="multi_style_enabled"> 启用多风格切换
      </label>
      <div class="styles-panel" data-k="styles_panel" style="display:none;">
        <div class="styles-list" data-k="styles_list"></div>
        <button class="btn btn-small btn-primary" data-act="add-style" style="margin-top:8px;">＋ 添加风格</button>
      </div>
    </div>

    <div class="section-title">🎼 多轨道混音（可选）</div>
    <div class="field">
      <label class="checkbox-label">
        <input type="checkbox" data-k="extra_tracks_enabled"> 启用额外轨道
      </label>
      <div class="extra-tracks-panel" data-k="extra_tracks_panel" style="display:none; margin-top:12px;">
        <div class="extra-tracks-list" data-k="extra_tracks_list"></div>
        <button class="btn btn-small btn-primary" data-act="add-extra-track" style="margin-top:8px;">＋ 添加轨道</button>
        <div class="hint" style="margin-top:6px; font-size:12px; color:var(--text-light);">
          提示：可添加多轨音频（如伴奏轨、人声轨、合唱轨等），播放器默认全开，可独立调节每轨音量
        </div>
      </div>
    </div>

    <div class="section-title">🎵 前奏音频（可选）</div>
    <div class="field">
      <label class="checkbox-label">
        <input type="checkbox" data-k="intro_enabled"> 启用前奏音频
      </label>
      <div class="intro-panel" data-k="intro_panel" style="display:none; margin-top:12px;">
        <div class="field">
          <label>前奏音频文件</label>
          <div class="file-picker">
            <input type="search" class="intro-file-search" placeholder="🔍 过滤文件…">
            <select class="intro-file-select" size="5"></select>
          </div>
        </div>
        <div class="hint" style="margin-top:6px; font-size:12px; color:var(--text-light);">
          提示：前奏放完后无缝切换到主音频循环播放，无淡入淡出
        </div>
      </div>
    </div>

    <div class="section-title">🎵 收尾音频（可选）</div>
    <div class="field">
      <label class="checkbox-label">
        <input type="checkbox" data-k="ending_enabled"> 启用收尾音频
      </label>
      <div class="ending-panel" data-k="ending_panel" style="display:none; margin-top:12px;">
        <div class="field">
          <label>收尾音频文件</label>
          <div class="file-picker">
            <input type="search" class="ending-file-search" placeholder="🔍 过滤文件…">
            <select class="ending-file-select" size="5"></select>
          </div>
        </div>
        <div class="field-row">
          <label>交叉淡入淡出时长:</label>
          <input type="number" class="ending-fade-dur" min="0.1" step="0.1" value="2.0" data-k="ending_fade_duration">
          <span>秒</span>
        </div>
        <div class="hint" style="margin-top:6px; font-size:12px; color:var(--text-light);">
          提示：配置后播放器「跳出循环」按钮变为「收尾」，点击后整体混音淡出，收尾音频淡入，无缝衔接
        </div>
      </div>
    </div>

    <div class="section-title">🔄 完整循环（可选）</div>
    <div class="field">
      <label class="checkbox-label">
        <input type="checkbox" data-k="full_loop_enabled"> 启用完整循环切换
      </label>
      <div class="full-loop-panel" data-k="full_loop_panel" style="display:none; margin-top:12px;">
        <div class="field-row">
          <label>切换淡入淡出时长:</label>
          <input type="number" class="full-loop-fade-dur" min="0.1" step="0.1" value="2.0" data-k="full_loop_fade_duration">
          <span>秒</span>
        </div>
        <div class="hint" style="margin-top:6px; font-size:12px; color:var(--text-light);">
          提示：启用后播放器出现「完整循环」按钮，可在循环段与整首整曲循环之间交叉淡入淡出切换
        </div>
      </div>
    </div>

    <div class="section-title">🔔 循环提示音效（可选）</div>
    <div class="field">
      <label class="checkbox-label">
        <input type="checkbox" data-k="loop_sfx_enabled"> 启用循环提示音效
      </label>
      <div class="loop-sfx-panel" data-k="loop_sfx_panel" style="display:none; margin-top:12px;">
        <div class="field">
          <label>音效文件:</label>
          <div class="file-picker">
            <input type="search" class="loop-sfx-search" placeholder="🔍 过滤文件…">
            <select class="loop-sfx-select" size="5" data-k="loop_sfx_filename"></select>
          </div>
        </div>
        <div class="field-row">
          <label>预淡入节拍数:</label>
          <input type="number" class="loop-sfx-fade-beats" min="1" max="32" value="4" data-k="loop_sfx_fade_in_beats">
          <span>拍</span>
        </div>
        <div class="hint" style="margin-top:6px; font-size:12px; color:var(--text-light);">
          提示：切入循环点时先播放音效，再从循环起点前指定节拍数开始淡入，实现更流畅的切换
        </div>
      </div>
    </div>
  `;

  $$('input, select', card).forEach(el => {
    if (el.classList.contains('tc-name-input')) return;
    const k = el.dataset.k;
    if (k && typeof t[k] !== 'undefined' && k !== 'bgm_dir_id') { el.value = t[k]; }
    else if (k === 'bgm_dir_id') { el.value = t.bgm_dir_id || 'default'; }
  });
  const dirSelect = $('select[data-k="bgm_dir_id"]', card);
  dirSelect.addEventListener('change', () => {
    t.bgm_dir_id = dirSelect.value || 'default';
    markDirty(card);
    renderSelectOptionsForOne($('select.file-select', card));
    const vocalSel = card.querySelector('select.vocal-file-select');
    if (vocalSel && vocalSel._render) vocalSel._render();
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
    if (el.classList.contains('file-select') || el.classList.contains('fp-search') || el.classList.contains('dir-select') || 
        el.classList.contains('style-name') || el.classList.contains('style-file-select') || 
        el.classList.contains('style-file-search') || el.classList.contains('style-file-list') ||
        el.classList.contains('vocal-file-select') || el.classList.contains('vocal-file-search') ||
        el.classList.contains('tc-name-input')) return;
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

  const renderTempoChanges = () => {
    const listEl = $('.tempo-changes-list', card);
    if (!listEl) return;
    t.tempo_changes = t.tempo_changes || [];
    
    listEl.innerHTML = '';
    if (t.tempo_changes.length === 0) {
      listEl.innerHTML = '<div class="tc-empty-hint">暂无变速规则，点击上方「＋ 添加变速规则」按钮新增</div>';
      return;
    }
    t.tempo_changes.forEach((tc, idx) => {
      const row = document.createElement('div');
      row.className = 'tempo-change-row';
      row.innerHTML = `
        <span class="tc-idx-badge">${idx + 1}</span>
        <input type="number" step="1" min="1" class="tc-bar" placeholder="小节" value="${tc.bar || ''}">
        <span class="tc-sep">:</span>
        <input type="number" step="0.1" min="1" class="tc-beat" placeholder="拍" value="${tc.beat || ''}">
        <span class="tc-arrow">→</span>
        <input type="number" step="0.1" min="1" class="tc-bpm" placeholder="BPM" value="${tc.bpm || ''}">
        <button class="btn btn-icon btn-danger tc-del" title="删除">🗑</button>
      `;
      row.querySelector('.tc-bar').addEventListener('input', (e) => {
        tc.bar = parseInt(e.target.value) || 0;
        markDirty(card);
      });
      row.querySelector('.tc-beat').addEventListener('input', (e) => {
        tc.beat = parseFloat(e.target.value) || 0;
        markDirty(card);
      });
      row.querySelector('.tc-bpm').addEventListener('input', (e) => {
        tc.bpm = parseFloat(e.target.value) || 0;
        markDirty(card);
      });
      row.querySelector('.tc-del').addEventListener('click', () => {
        t.tempo_changes.splice(idx, 1);
        renderTempoChanges();
        markDirty(card);
      });
      listEl.appendChild(row);
    });
  };
  renderTempoChanges();
  card.querySelector('[data-act="add-tempo-change"]').addEventListener('click', () => {
    t.tempo_changes = t.tempo_changes || [];
    const bpm = parseFloat($('[data-k="bpm"]', card).value) || 120;
    const beatsPerBar = parseFloat($('[data-k="beats_per_bar"]', card).value) || 4;
    
    let nextBar = 5;
    if (t.tempo_changes.length > 0) {
      const maxBar = Math.max(...t.tempo_changes.map(tc => tc.bar || 1));
      nextBar = maxBar + 4;
    }
    
    t.tempo_changes.push({ bar: nextBar, beat: 1, bpm: bpm });
    renderTempoChanges();
    markDirty(card);
  });

  const renderMeterChanges = () => {
    const listEl = $('.meter-changes-list', card);
    if (!listEl) return;
    t.meter_changes = t.meter_changes || [];
    
    listEl.innerHTML = '';
    if (t.meter_changes.length === 0) {
      listEl.innerHTML = '<div class="tc-empty-hint">暂无变拍规则，点击上方「＋ 添加变拍规则」按钮新增</div>';
      return;
    }
    t.meter_changes.forEach((mc, idx) => {
      const row = document.createElement('div');
      row.className = 'tempo-change-row';
      row.innerHTML = `
        <span class="tc-idx-badge">${idx + 1}</span>
        <input type="number" step="1" min="1" class="tc-bar" placeholder="小节" value="${mc.bar || ''}">
        <span class="tc-sep">:</span>
        <input type="number" step="0.1" min="1" class="tc-beat" placeholder="拍" value="${mc.beat || ''}">
        <span class="tc-arrow">→</span>
        <input type="number" step="0.1" min="1" class="tc-bpm" placeholder="每小节拍数" value="${mc.beats_per_bar || ''}">
        <button class="btn btn-icon btn-danger tc-del" title="删除">🗑</button>
      `;
      row.querySelector('.tc-bar').addEventListener('input', (e) => {
        mc.bar = parseInt(e.target.value) || 0;
        markDirty(card);
      });
      row.querySelector('.tc-beat').addEventListener('input', (e) => {
        mc.beat = parseFloat(e.target.value) || 0;
        markDirty(card);
      });
      row.querySelector('.tc-bpm').addEventListener('input', (e) => {
        mc.beats_per_bar = parseFloat(e.target.value) || 0;
        markDirty(card);
      });
      row.querySelector('.tc-del').addEventListener('click', () => {
        t.meter_changes.splice(idx, 1);
        renderMeterChanges();
        markDirty(card);
      });
      listEl.appendChild(row);
    });
  };
  renderMeterChanges();
  card.querySelector('[data-act="add-meter-change"]').addEventListener('click', () => {
    t.meter_changes = t.meter_changes || [];
    const beatsPerBar = parseFloat($('[data-k="beats_per_bar"]', card).value) || 4;
    
    let nextBar = 5;
    if (t.meter_changes.length > 0) {
      const maxBar = Math.max(...t.meter_changes.map(mc => mc.bar || 1));
      nextBar = maxBar + 4;
    }
    
    t.meter_changes.push({ bar: nextBar, beat: 1, beats_per_bar: beatsPerBar });
    renderMeterChanges();
    markDirty(card);
  });

  card.querySelector('[data-act="import-changes"]').addEventListener('click', () => {
    openImportChangesModal((code) => {
      const result = window.BeatUtils.importChanges(code);
      if (!result) {
        showImportChangesErr('❌ 配置代码无效');
        return false;
      }
      t.tempo_changes = result.tempoChanges;
      t.meter_changes = result.meterChanges;
      renderTempoChanges();
      renderMeterChanges();
      markDirty(card);
      return true;
    });
  });

  const multiStyleEnabledCheck = card.querySelector('input[data-k="multi_style_enabled"]');
  const stylesPanel = card.querySelector('[data-k="styles_panel"]');
  if (multiStyleEnabledCheck) {
    multiStyleEnabledCheck.checked = !!t.multi_style_enabled;
    multiStyleEnabledCheck.addEventListener('change', () => {
      t.multi_style_enabled = multiStyleEnabledCheck.checked;
      stylesPanel.style.display = t.multi_style_enabled ? '' : 'none';
      markDirty(card);
    });
    stylesPanel.style.display = t.multi_style_enabled ? '' : 'none';
  }

  const renderStyles = () => {
    const listEl = card.querySelector('[data-k="styles_list"]');
    if (!listEl) return;
    t.styles = t.styles || [];
    
    listEl.innerHTML = '';
    if (t.styles.length === 0) {
      listEl.innerHTML = '<div class="tc-empty-hint">暂无风格配置，点击上方「＋ 添加风格」按钮新增</div>';
      return;
    }
    t.styles.forEach((style, idx) => {
      const row = document.createElement('div');
      row.className = 'tempo-change-row style-row';
      const azb = style.audio_zero_bar != null ? style.audio_zero_bar : t.audio_zero_bar || 1;
      const azbt = style.audio_zero_beat != null ? style.audio_zero_beat : t.audio_zero_beat || 1;
      row.innerHTML = `
        <span class="tc-idx-badge">${idx + 1}</span>
        <input type="text" class="style-name" placeholder="风格名称" value="${escapeHtml(style.name || '')}">
        <span class="tc-arrow">→</span>
        <div class="style-file-picker">
          <input type="search" class="style-file-search" placeholder="🔍 在此曲目内按文件名过滤…（支持中英文）">
          <select class="style-file-list" size="6" data-track-id="${t._id}" data-style-idx="${idx}"></select>
        </div>
        <div class="style-offset-section">
          <span class="style-offset-label">偏移:</span>
          <input type="number" step="1" min="1" class="style-azb" placeholder="小节" value="${azb}">
          <span class="style-offset-sep">:</span>
          <input type="number" step="0.1" min="1" class="style-azbt" placeholder="拍" value="${azbt}">
        </div>
        <label class="style-same-lyrics-label">
          <input type="checkbox" class="style-same-lyrics" ${style.same_lyrics ? 'checked' : ''}>
          <span>歌词相同</span>
        </label>
        <div class="style-actions">
          <button class="btn btn-icon btn-danger style-up" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-icon btn-danger style-down" title="下移" ${idx === t.styles.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-icon btn-danger style-del" title="删除">🗑</button>
        </div>
      `;
      
      row.querySelector('.style-name').addEventListener('input', (e) => {
        style.name = e.target.value;
        markDirty(card);
      });
      
      row.querySelector('.style-azb').addEventListener('input', (e) => {
        style.audio_zero_bar = parseInt(e.target.value) || 1;
        markDirty(card);
      });
      
      row.querySelector('.style-azbt').addEventListener('input', (e) => {
        style.audio_zero_beat = parseFloat(e.target.value) || 1;
        markDirty(card);
      });
      
      row.querySelector('.style-same-lyrics').addEventListener('change', (e) => {
        style.same_lyrics = e.target.checked;
        markDirty(card);
      });
      
      const styleFileSearch = row.querySelector('.style-file-search');
      const styleFileList = row.querySelector('.style-file-list');
      
      const renderStyleFileOptions = (searchQuery = '') => {
        const curDirId = t.bgm_dir_id || 'default';
        const curFn = style.filename || '';
        let filesInDir = state.bgmList.filter(e => e.dir_id === curDirId);
        
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filesInDir = filesInDir.filter(e => (e.filename || '').toLowerCase().includes(q));
        }
        
        let html = '';
        html += `<option value="">— 未选择音频 —</option>`;
        filesInDir.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')).forEach(e => {
          const sel = e.filename === curFn ? 'selected' : '';
          html += `<option value="${encodeURIComponent(e.dir_id)}::${encodeURIComponent(e.filename)}" data-dir="${escapeHtml(e.dir_id)}" data-fn="${escapeHtml(e.filename)}" ${sel}>${escapeHtml(e.filename)}</option>`;
        });
        if (filesInDir.length === 0) {
          html += `<option disabled>— 当前目录暂无音频文件 —</option>`;
        }
        styleFileList.innerHTML = html;
        
        if (curFn) {
          const need = encodeURIComponent(curDirId) + '::' + encodeURIComponent(curFn);
          if (styleFileList.value !== need) {
            if (Array.from(styleFileList.options).some(o => o.value === need)) {
              styleFileList.value = need;
            } else {
              const fake = document.createElement('option');
              fake.value = need;
              fake.selected = true;
              fake.textContent = `⚠️ 当前：${curFn}`;
              styleFileList.insertBefore(fake, styleFileList.firstChild.nextSibling);
            }
          }
        }
      };
      renderStyleFileOptions();
      
      styleFileSearch.addEventListener('input', () => {
        renderStyleFileOptions(styleFileSearch.value);
      });
      
      styleFileList.addEventListener('change', () => {
        const v = styleFileList.value;
        if (!v) {
          style.filename = '';
          style.bgm_dir_id = t.bgm_dir_id || 'default';
        } else {
          const [encDir, encFn] = v.split('::');
          style.bgm_dir_id = decodeURIComponent(encDir);
          style.filename = decodeURIComponent(encFn);
        }
        markDirty(card);
      });
      
      row.querySelector('.style-up').addEventListener('click', () => {
        if (idx <= 0) return;
        [t.styles[idx - 1], t.styles[idx]] = [t.styles[idx], t.styles[idx - 1]];
        renderStyles();
        markDirty(card);
      });
      
      row.querySelector('.style-down').addEventListener('click', () => {
        if (idx >= t.styles.length - 1) return;
        [t.styles[idx + 1], t.styles[idx]] = [t.styles[idx], t.styles[idx + 1]];
        renderStyles();
        markDirty(card);
      });
      
      row.querySelector('.style-del').addEventListener('click', () => {
        t.styles.splice(idx, 1);
        renderStyles();
        markDirty(card);
      });
      
      listEl.appendChild(row);
    });
  };
  renderStyles();
  
  card.querySelector('[data-act="add-style"]').addEventListener('click', () => {
    t.styles = t.styles || [];
    t.styles.push({
      name: `风格 ${t.styles.length + 1}`,
      filename: '',
      bgm_dir_id: t.bgm_dir_id || 'default',
      audio_zero_bar: t.audio_zero_bar || 1,
      audio_zero_beat: t.audio_zero_beat || 1,
      same_lyrics: false
    });
    renderStyles();
    markDirty(card);
  });

  // --- 多轨道混音 ---
  const extraTracksEnabledCheck = card.querySelector('input[data-k="extra_tracks_enabled"]');
  const extraTracksPanel = card.querySelector('[data-k="extra_tracks_panel"]');
  if (extraTracksEnabledCheck) {
    extraTracksEnabledCheck.checked = !!t.extra_tracks_enabled;
    extraTracksPanel.style.display = t.extra_tracks_enabled ? '' : 'none';
    extraTracksEnabledCheck.addEventListener('change', () => {
      t.extra_tracks_enabled = extraTracksEnabledCheck.checked;
      extraTracksPanel.style.display = t.extra_tracks_enabled ? '' : 'none';
      markDirty(card);
    });
  }

  const renderExtraTracks = () => {
    const listEl = card.querySelector('[data-k="extra_tracks_list"]');
    if (!listEl) return;
    t.extra_tracks = t.extra_tracks || [];
    listEl.innerHTML = '';
    if (t.extra_tracks.length === 0) {
      listEl.innerHTML = '<div class="tc-empty-hint">暂无额外轨道，点击下方按钮新增</div>';
      return;
    }
    t.extra_tracks.forEach((et, idx) => {
      const row = document.createElement('div');
      row.className = 'extra-track-row';
      const azb = et.audio_zero_bar != null ? et.audio_zero_bar : t.audio_zero_bar || 1;
      const azbt = et.audio_zero_beat != null ? et.audio_zero_beat : t.audio_zero_beat || 1;
      row.innerHTML = `
        <div class="extra-track-head">
          <span class="tc-idx-badge">${idx + 1}</span>
          <input type="text" class="et-name" placeholder="轨道名称（如：人声轨、合唱轨）" value="${escapeHtml(et.name || '')}">
          <div class="et-actions">
            <button class="btn btn-icon et-up" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-icon et-down" title="下移" ${idx === t.extra_tracks.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-icon btn-danger et-del" title="删除">🗑</button>
          </div>
        </div>
        <div class="extra-track-body">
          <div class="field" style="margin-bottom:6px;">
            <label>音频文件 <span class="hint">(可搜索过滤)</span></label>
            <div class="file-picker">
              <input type="search" class="et-file-search" placeholder="🔍 按文件名过滤…">
              <select class="et-file-select" size="5" data-et-idx="${idx}"></select>
            </div>
          </div>
          <div class="field-row" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <label style="white-space:nowrap; min-width:60px;">偏移:</label>
            <input type="number" class="et-azb" min="1" step="1" value="${azb}" style="width:65px;">
            <span>:</span>
            <input type="number" class="et-azbt" min="0.1" step="0.1" value="${azbt}" style="width:65px;">
            <label style="margin-left:10px; white-space:nowrap;">音量:</label>
            <input type="number" class="et-volume" min="0" max="2" step="0.01" value="${et.volume != null ? et.volume : 1}" style="width:65px;">
            <span class="hint">0~2 (默认1)</span>
          </div>
        </div>
      `;

      row.querySelector('.et-name').addEventListener('input', (e) => {
        et.name = e.target.value;
        markDirty(card);
      });
      row.querySelector('.et-azb').addEventListener('input', (e) => {
        et.audio_zero_bar = parseInt(e.target.value) || 1;
        markDirty(card);
      });
      row.querySelector('.et-azbt').addEventListener('input', (e) => {
        et.audio_zero_beat = parseFloat(e.target.value) || 1;
        markDirty(card);
      });
      row.querySelector('.et-volume').addEventListener('input', (e) => {
        et.volume = Math.max(0, Math.min(2, parseFloat(e.target.value) || 0));
        markDirty(card);
      });

      const fileSearch = row.querySelector('.et-file-search');
      const fileSelect = row.querySelector('.et-file-select');

      const renderEtFileOptions = (searchQuery = '') => {
        const curDirId = t.bgm_dir_id || 'default';
        const curFn = et.filename || '';
        let filesInDir = state.bgmList.filter(e => e.dir_id === curDirId);
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filesInDir = filesInDir.filter(e => (e.filename || '').toLowerCase().includes(q));
        }
        let html = '';
        html += `<option value="">— 未选择音频 —</option>`;
        filesInDir.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')).forEach(e => {
          const sel = e.filename === curFn ? 'selected' : '';
          html += `<option value="${encodeURIComponent(e.dir_id)}::${encodeURIComponent(e.filename)}" data-dir="${escapeHtml(e.dir_id)}" data-fn="${escapeHtml(e.filename)}" ${sel}>${escapeHtml(e.filename)}</option>`;
        });
        if (filesInDir.length === 0) {
          html += `<option disabled>— 当前目录暂无音频文件 —</option>`;
        }
        fileSelect.innerHTML = html;
        if (curFn) {
          const need = encodeURIComponent(curDirId) + '::' + encodeURIComponent(curFn);
          if (fileSelect.value !== need) {
            if (Array.from(fileSelect.options).some(o => o.value === need)) {
              fileSelect.value = need;
            } else {
              const fake = document.createElement('option');
              fake.value = need;
              fake.selected = true;
              fake.textContent = `⚠️ 当前：${curFn}`;
              fileSelect.insertBefore(fake, fileSelect.firstChild.nextSibling);
            }
          }
        }
      };
      renderEtFileOptions();

      fileSearch.addEventListener('input', () => {
        renderEtFileOptions(fileSearch.value);
      });
      fileSelect.addEventListener('change', () => {
        const v = fileSelect.value;
        if (!v) {
          et.filename = '';
          et.dir_id = t.bgm_dir_id || 'default';
        } else {
          const [encDir, encFn] = v.split('::');
          et.dir_id = decodeURIComponent(encDir);
          et.filename = decodeURIComponent(encFn);
        }
        markDirty(card);
      });

      row.querySelector('.et-up').addEventListener('click', () => {
        if (idx <= 0) return;
        [t.extra_tracks[idx - 1], t.extra_tracks[idx]] = [t.extra_tracks[idx], t.extra_tracks[idx - 1]];
        renderExtraTracks();
        markDirty(card);
      });
      row.querySelector('.et-down').addEventListener('click', () => {
        if (idx >= t.extra_tracks.length - 1) return;
        [t.extra_tracks[idx + 1], t.extra_tracks[idx]] = [t.extra_tracks[idx], t.extra_tracks[idx + 1]];
        renderExtraTracks();
        markDirty(card);
      });
      row.querySelector('.et-del').addEventListener('click', () => {
        if (!confirm(`确定删除轨道 "${et.name || '未命名'}" 吗？`)) return;
        t.extra_tracks.splice(idx, 1);
        renderExtraTracks();
        markDirty(card);
      });

      listEl.appendChild(row);
    });
  };
  renderExtraTracks();

  // 当主曲目目录改变时，刷新所有额外轨道的文件列表
  const origDirChange = dirSelect.onchange || null;
  dirSelect.addEventListener('change', () => {
    renderExtraTracks();
  });

  card.querySelector('[data-act="add-extra-track"]').addEventListener('click', () => {
    t.extra_tracks = t.extra_tracks || [];
    t.extra_tracks.push({
      name: `轨道 ${t.extra_tracks.length + 1}`,
      filename: '',
      dir_id: t.bgm_dir_id || 'default',
      audio_zero_bar: t.audio_zero_bar || 1,
      audio_zero_beat: t.audio_zero_beat || 1,
      volume: 1.0
    });
    renderExtraTracks();
    markDirty(card);
  });

  // --- 收尾音频 ---
  const endingEnabledCheck = card.querySelector('input[data-k="ending_enabled"]');
  const endingPanel = card.querySelector('[data-k="ending_panel"]');
  if (endingEnabledCheck) {
    endingEnabledCheck.checked = !!t.ending_enabled;
    endingPanel.style.display = t.ending_enabled ? '' : 'none';
    endingEnabledCheck.addEventListener('change', () => {
      t.ending_enabled = endingEnabledCheck.checked;
      endingPanel.style.display = t.ending_enabled ? '' : 'none';
      markDirty(card);
    });
  }

  const endingFileSearch = card.querySelector('.ending-file-search');
  const endingFileSelect = card.querySelector('.ending-file-select');
  const endingFadeDur = card.querySelector('.ending-fade-dur');

  const renderEndingFileOptions = (searchQuery = '') => {
    const curDirId = t.bgm_dir_id || 'default';
    const curFn = t.ending_filename || '';
    let filesInDir = state.bgmList.filter(e => e.dir_id === curDirId);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filesInDir = filesInDir.filter(e => (e.filename || '').toLowerCase().includes(q));
    }
    let html = '';
    html += `<option value="">— 未选择收尾音频 —</option>`;
    filesInDir.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')).forEach(e => {
      const sel = e.filename === curFn ? 'selected' : '';
      html += `<option value="${encodeURIComponent(e.dir_id)}::${encodeURIComponent(e.filename)}" ${sel}>${escapeHtml(e.filename)}</option>`;
    });
    if (filesInDir.length === 0) {
      html += `<option disabled>— 当前目录暂无音频文件 —</option>`;
    }
    endingFileSelect.innerHTML = html;
    if (curFn) {
      const need = encodeURIComponent(curDirId) + '::' + encodeURIComponent(curFn);
      if (endingFileSelect.value !== need) {
        if (Array.from(endingFileSelect.options).some(o => o.value === need)) {
          endingFileSelect.value = need;
        } else {
          const fake = document.createElement('option');
          fake.value = need;
          fake.selected = true;
          fake.textContent = `⚠️ 当前：${curFn}`;
          endingFileSelect.insertBefore(fake, endingFileSelect.firstChild.nextSibling);
        }
      }
    }
  };
  renderEndingFileOptions();

  endingFileSearch.addEventListener('input', () => {
    renderEndingFileOptions(endingFileSearch.value);
  });
  endingFileSelect.addEventListener('change', () => {
    const v = endingFileSelect.value;
    if (!v) {
      t.ending_filename = '';
      t.ending_dir_id = t.bgm_dir_id || 'default';
    } else {
      const [encDir, encFn] = v.split('::');
      t.ending_dir_id = decodeURIComponent(encDir);
      t.ending_filename = decodeURIComponent(encFn);
    }
    markDirty(card);
  });

  if (endingFadeDur) {
    endingFadeDur.value = t.ending_fade_duration != null ? t.ending_fade_duration : 2.0;
    endingFadeDur.addEventListener('input', () => {
      t.ending_fade_duration = Math.max(0.1, parseFloat(endingFadeDur.value) || 2.0);
      markDirty(card);
    });
  }

  // 主目录改变时刷新收尾文件列表
  dirSelect.addEventListener('change', () => {
    renderEndingFileOptions();
  });

  // --- 前奏音频 ---
  const introEnabledCheck = card.querySelector('input[data-k="intro_enabled"]');
  const introPanel = card.querySelector('[data-k="intro_panel"]');
  if (introEnabledCheck) {
    introEnabledCheck.checked = !!t.intro_enabled;
    introPanel.style.display = t.intro_enabled ? '' : 'none';
    introEnabledCheck.addEventListener('change', () => {
      t.intro_enabled = introEnabledCheck.checked;
      introPanel.style.display = t.intro_enabled ? '' : 'none';
      markDirty(card);
    });
  }

  const introFileSearch = card.querySelector('.intro-file-search');
  const introFileSelect = card.querySelector('.intro-file-select');

  const renderIntroFileOptions = (searchQuery = '') => {
    const curDirId = t.bgm_dir_id || 'default';
    const curFn = t.intro_filename || '';
    let filesInDir = state.bgmList.filter(e => e.dir_id === curDirId);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filesInDir = filesInDir.filter(e => (e.filename || '').toLowerCase().includes(q));
    }
    let html = '';
    html += `<option value="">— 未选择前奏音频 —</option>`;
    filesInDir.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')).forEach(e => {
      const sel = e.filename === curFn ? 'selected' : '';
      html += `<option value="${encodeURIComponent(e.dir_id)}::${encodeURIComponent(e.filename)}" ${sel}>${escapeHtml(e.filename)}</option>`;
    });
    if (filesInDir.length === 0) {
      html += `<option disabled>— 当前目录暂无音频文件 —</option>`;
    }
    introFileSelect.innerHTML = html;
    if (curFn) {
      const need = encodeURIComponent(curDirId) + '::' + encodeURIComponent(curFn);
      if (introFileSelect.value !== need) {
        if (Array.from(introFileSelect.options).some(o => o.value === need)) {
          introFileSelect.value = need;
        } else {
          const fake = document.createElement('option');
          fake.value = need;
          fake.selected = true;
          fake.textContent = `⚠️ 当前：${curFn}`;
          introFileSelect.insertBefore(fake, introFileSelect.firstChild.nextSibling);
        }
      }
    }
  };
  if (introFileSelect) {
    renderIntroFileOptions();

    introFileSearch.addEventListener('input', () => {
      renderIntroFileOptions(introFileSearch.value);
    });
    introFileSelect.addEventListener('change', () => {
      const v = introFileSelect.value;
      if (!v) {
        t.intro_filename = '';
        t.intro_dir_id = t.bgm_dir_id || 'default';
      } else {
        const [encDir, encFn] = v.split('::');
        t.intro_dir_id = decodeURIComponent(encDir);
        t.intro_filename = decodeURIComponent(encFn);
      }
      markDirty(card);
    });

    dirSelect.addEventListener('change', () => {
      renderIntroFileOptions();
    });
  }

  // --- 完整循环 ---
  const fullLoopEnabledCheck = card.querySelector('input[data-k="full_loop_enabled"]');
  const fullLoopPanel = card.querySelector('[data-k="full_loop_panel"]');
  const fullLoopFadeDur = card.querySelector('.full-loop-fade-dur');
  if (fullLoopEnabledCheck) {
    fullLoopEnabledCheck.checked = !!t.full_loop_enabled;
    fullLoopPanel.style.display = t.full_loop_enabled ? '' : 'none';
    fullLoopEnabledCheck.addEventListener('change', () => {
      t.full_loop_enabled = fullLoopEnabledCheck.checked;
      fullLoopPanel.style.display = t.full_loop_enabled ? '' : 'none';
      markDirty(card);
    });
  }
  if (fullLoopFadeDur) {
    fullLoopFadeDur.value = t.full_loop_fade_duration != null ? t.full_loop_fade_duration : 2.0;
    fullLoopFadeDur.addEventListener('input', () => {
      t.full_loop_fade_duration = Math.max(0.1, parseFloat(fullLoopFadeDur.value) || 2.0);
      markDirty(card);
    });
  }

  // --- 循环提示音效 ---
  const loopSfxEnabledCheck = card.querySelector('input[data-k="loop_sfx_enabled"]');
  const loopSfxPanel = card.querySelector('[data-k="loop_sfx_panel"]');
  const loopSfxSelect = card.querySelector('.loop-sfx-select');
  const loopSfxSearch = card.querySelector('.loop-sfx-search');
  const loopSfxFadeBeats = card.querySelector('.loop-sfx-fade-beats');
  if (loopSfxEnabledCheck) {
    loopSfxEnabledCheck.checked = !!t.loop_sfx_enabled;
    loopSfxPanel.style.display = t.loop_sfx_enabled ? '' : 'none';
    loopSfxEnabledCheck.addEventListener('change', () => {
      t.loop_sfx_enabled = loopSfxEnabledCheck.checked;
      loopSfxPanel.style.display = t.loop_sfx_enabled ? '' : 'none';
      markDirty(card);
    });
  }
  if (loopSfxFadeBeats) {
    loopSfxFadeBeats.value = t.loop_sfx_fade_in_beats != null ? t.loop_sfx_fade_in_beats : 4;
    loopSfxFadeBeats.addEventListener('input', () => {
      t.loop_sfx_fade_in_beats = Math.max(1, Math.min(32, parseInt(loopSfxFadeBeats.value) || 4));
      markDirty(card);
    });
  }
  const renderLoopSfxFileOptions = (searchQuery = '') => {
    if (!loopSfxSelect) return;
    const curDirId = t.bgm_dir_id || 'default';
    const curFn = t.loop_sfx_filename || '';
    let filesInDir = state.bgmList.filter(e => e.dir_id === curDirId);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filesInDir = filesInDir.filter(e => (e.filename || '').toLowerCase().includes(q));
    }
    let html = '';
    html += `<option value="">— 未选择音效 —</option>`;
    filesInDir.sort((a, b) => (a.filename || '').localeCompare(b.filename || '')).forEach(e => {
      const sel = e.filename === curFn ? 'selected' : '';
      html += `<option value="${encodeURIComponent(e.dir_id)}::${encodeURIComponent(e.filename)}" ${sel}>${escapeHtml(e.filename)}</option>`;
    });
    if (filesInDir.length === 0) {
      html += `<option disabled>— 当前目录暂无音频文件 —</option>`;
    }
    loopSfxSelect.innerHTML = html;
    if (curFn) {
      const need = encodeURIComponent(curDirId) + '::' + encodeURIComponent(curFn);
      if (loopSfxSelect.value !== need) {
        if (Array.from(loopSfxSelect.options).some(o => o.value === need)) {
          loopSfxSelect.value = need;
        } else {
          const fake = document.createElement('option');
          fake.value = need;
          fake.selected = true;
          fake.textContent = `⚠️ 当前：${curFn}`;
          loopSfxSelect.insertBefore(fake, loopSfxSelect.firstChild.nextSibling);
        }
      }
    }
  };
  if (loopSfxSelect) {
    renderLoopSfxFileOptions();
    loopSfxSelect.addEventListener('change', () => {
      const v = loopSfxSelect.value;
      if (!v) {
        t.loop_sfx_filename = '';
        t.loop_sfx_dir_id = '';
      } else {
        const [dPart, fPart] = v.split('::');
        t.loop_sfx_dir_id = decodeURIComponent(dPart || '');
        t.loop_sfx_filename = decodeURIComponent(fPart || '');
      }
      markDirty(card);
    });
  }
  if (loopSfxSearch && loopSfxSelect) {
    loopSfxSearch.addEventListener('input', () => {
      renderLoopSfxFileOptions(loopSfxSearch.value);
    });
  }
  dirSelect.addEventListener('change', () => {
    renderLoopSfxFileOptions();
  });

  refreshPreview(card, t);
  validateTrack(t, card);
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

/* ===== 局部 DOM 更新辅助（避免全量重渲染） ===== */
function getCardByTrackId(id) {
  return document.querySelector(`.track-card[data-track-id="${id}"]`);
}
function updateCardIndex(card, idx) {
  const idxEl = $('.tc-idx', card);
  if (idxEl) idxEl.textContent = String(idx + 1);
}
function updateIndicesFrom(startIdx) {
  const cards = $$('.track-card');
  for (let i = Math.max(0, startIdx); i < cards.length; i++) {
    updateCardIndex(cards[i], i);
  }
}
function refreshTrackCount() {
  $('#trackCount').textContent = state.tracks.length;
}
function insertCardDOM(track, idx) {
  const container = $('#tracksContainer');
  const savedScrollTop = container ? container.scrollTop : 0;
  const newCard = renderTrackCard(track, idx);
  if (state.dirty) newCard.classList.add('dirty');
  const cards = $$('.track-card', container);
  if (idx >= cards.length) {
    container.appendChild(newCard);
  } else {
    cards[idx].insertAdjacentElement('beforebegin', newCard);
  }
  updateIndicesFrom(idx);
  refreshTrackCount();
  // 恢复滚动位置，防止插入新卡片时 select 渲染导致页面跳到顶部
  if (container && savedScrollTop > 0) container.scrollTop = savedScrollTop;
  return newCard;
}

/* ============================ 配置搜索 ============================ */

function doConfigSearch(query) {
  query = (query || '').trim().toLowerCase();
  const modal = $('#searchResultsModal');
  const body = $('#searchResultsBody');
  if (!modal || !body) return;

  if (!query) { closeSearchResults(); return; }

  // 搜索所有曲目的所有字符串/数字字段
  const results = [];
  state.tracks.forEach((t, i) => {
    const matchFields = [];
    for (const k in t) {
      if (k.startsWith('_')) continue;
      const v = t[k];
      if (typeof v === 'string') {
        const idx = v.toLowerCase().indexOf(query);
        if (idx >= 0) matchFields.push({ key: k, value: v, idx });
      } else if (typeof v === 'number') {
        const s = String(v);
        if (s.includes(query)) matchFields.push({ key: k, value: s, idx: s.indexOf(query) });
      } else if (typeof v === 'boolean') {
        const s = String(v);
        if (s.includes(query)) matchFields.push({ key: k, value: s, idx: s.indexOf(query) });
      }
    }
    if (matchFields.length > 0) {
      results.push({ track: t, idx: i, fields: matchFields });
    }
  });

  if (results.length === 0) {
    body.innerHTML = `<div class="search-result-empty">没有找到匹配的配置</div>`;
    modal.style.display = '';
    return;
  }

  body.innerHTML = results.map(r => {
    const name = r.track.name || '(未命名)';
    const cat = r.track.category || '';
    const firstMatch = r.fields[0];
    const hl = highlightMatch(firstMatch.value, firstMatch.idx, query);
    const otherCount = r.fields.length - 1;
    const meta = `${firstMatch.key}: ${hl}${otherCount > 0 ? ` (+${otherCount} 其他匹配)` : ''}${cat ? ' · ' + cat : ''}`;
    return `<div class="search-result-item" data-track-idx="${r.idx}">
      <div class="search-result-idx">${r.idx + 1}</div>
      <div class="search-result-info">
        <div class="search-result-name">${escapeHtml(name)}</div>
        <div class="search-result-meta">${meta}</div>
      </div>
    </div>`;
  }).join('');

  // 点击跳转
  $$('.search-result-item', body).forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.trackIdx);
      jumpToTrackByIndex(idx);
      closeSearchResults();
    });
  });

  modal.style.display = '';
  // 移动端：弹窗后让搜索框失焦，收起键盘
  const searchInput = $('#configSearch');
  if (searchInput) searchInput.blur();
}

function highlightMatch(text, matchIdx, query) {
  if (matchIdx < 0) return escapeHtml(text.length > 60 ? text.substring(0, 60) + '...' : text);
  const start = Math.max(0, matchIdx - 20);
  const end = Math.min(text.length, matchIdx + query.length + 30);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const before = escapeHtml(text.substring(start, matchIdx));
  const match = escapeHtml(text.substring(matchIdx, matchIdx + query.length));
  const after = escapeHtml(text.substring(matchIdx + query.length, end));
  return prefix + before + `<span class="search-result-highlight">${match}</span>` + after + suffix;
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function jumpToTrackByIndex(trackIdx) {
  if (trackIdx < 0 || trackIdx >= state.tracks.length) return;

  const container = $('#tracksContainer');
  if (!container) return;
  const cards = $$('.track-card', container);
  const target = cards[trackIdx];
  if (!target) return;

  // 延迟滚动，等待弹窗关闭后再定位
  setTimeout(() => {
    const container2 = $('#tracksContainer');
    if (!container2) return;
    const allCards = $$('.track-card', container2);
    const card = allCards[trackIdx];
    if (card) {
      const cardTop = card.offsetTop;
      const cardHeight = card.offsetHeight;
      const containerHeight = container2.clientHeight;
      container2.scrollTo({
        top: cardTop - containerHeight / 2 + cardHeight / 2,
        behavior: 'smooth'
      });
      card.style.transition = 'box-shadow 0.3s';
      card.style.boxShadow = '0 0 0 3px rgba(180,111,199,0.4)';
      setTimeout(() => { card.style.boxShadow = ''; }, 2000);
    }
  }, 100);
}

function closeSearchResults() {
  const modal = $('#searchResultsModal');
  if (modal) modal.style.display = 'none';
}

function markDirty(card) {
  state.dirty = true;
  if (card) card.classList.add('dirty');
  else {
    state.structuralDirty = true;
    $$('.track-card').forEach(c => c.classList.add('dirty'));
  }
}

/* ============================ IMPORT CHANGES MODAL ============================ */

let _importChangesCallback = null;

function openImportChangesModal(onConfirm) {
  _importChangesCallback = onConfirm;
  const modal = document.getElementById('importChangesModal');
  const codeEl = document.getElementById('importChangesCode');
  const errEl = document.getElementById('importChangesErr');
  if (!modal || !codeEl || !errEl) return;
  codeEl.value = '';
  errEl.textContent = '';
  modal.style.display = '';
  setTimeout(() => codeEl.focus(), 50);
}

function showImportChangesErr(msg) {
  const errEl = document.getElementById('importChangesErr');
  if (errEl) errEl.textContent = msg;
}

function closeImportChangesModal() {
  const modal = document.getElementById('importChangesModal');
  if (modal) modal.style.display = 'none';
  _importChangesCallback = null;
}

function bindImportChangesModal() {
  const modal = document.getElementById('importChangesModal');
  const codeEl = document.getElementById('importChangesCode');
  const cancelBtn = document.getElementById('importChangesCancel');
  const confirmBtn = document.getElementById('importChangesConfirm');
  if (!modal || !codeEl || !cancelBtn || !confirmBtn) return;

  cancelBtn.addEventListener('click', closeImportChangesModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeImportChangesModal();
  });
  codeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImportChangesModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      confirmBtn.click();
    }
  });
  confirmBtn.addEventListener('click', () => {
    const code = codeEl.value.trim();
    if (!code) {
      showImportChangesErr('请粘贴配置代码');
      return;
    }
    if (_importChangesCallback) {
      const success = _importChangesCallback(code);
      if (success) closeImportChangesModal();
    }
  });
}

// 暴露给节拍计算器、节奏打点器复用
window.openImportChangesModal = openImportChangesModal;
window.showImportChangesErr = showImportChangesErr;

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

  bindImportChangesModal();

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
    insertCardDOM(nt, state.tracks.length - 1);
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
      if (!c.dataset.bodyRendered) return;
      const id = c.dataset.trackId;
      const t = state.tracks.find(x => x._id === id);
      if (t && !validateTrack(t, c)) allOk = false;
    });
    if (!allOk) { setStatus('⚠️ 仍有字段非法（标红），请先修正', 'warn'); return; }
    await saveConfig();
  });

  $('#refreshBgmBtn').addEventListener('click', async () => {
    setStatus('🔄 重新扫描所有 BGM 目录…', 'info');
    try {
      await apiBgmDirs('scan_all', {});
      const data = await refreshBgmList('');
      state.bgmList = data.files || [];
      state.bgmDirs = data.dirs || [];
      renderDirPanel();
      $$('.track-card select.file-select').forEach(renderSelectOptionsForOne);
      setStatus(`✅ 刷新完成，共 ${state.bgmList.length} 个文件`, 'ok');
    } catch (e) { setStatus('刷新失败：' + e.message, 'err'); }
  });

  // 配置搜索：按回车后弹窗显示结果
  const configSearchInput = $('#configSearch');
  if (configSearchInput) {
    configSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSearchResults(); e.target.blur(); }
      else if (e.key === 'Enter') { e.preventDefault(); doConfigSearch(e.target.value); }
    });
  }
  const searchCloseBtn = $('#searchResultsClose');
  if (searchCloseBtn) searchCloseBtn.addEventListener('click', closeSearchResults);
  const searchModal = $('#searchResultsModal');
  if (searchModal) searchModal.addEventListener('click', (e) => { if (e.target === searchModal) closeSearchResults(); });

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

  $('#closeTabBtn').addEventListener('click', () => {
    window.close();
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
