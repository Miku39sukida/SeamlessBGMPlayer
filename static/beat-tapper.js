const $bt = (sel) => document.querySelector(sel);

const escapeHtml = (str) => {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
};

const RHYTHM_TYPES = {
    whole: { name: '整拍', beats: [1, 2, 3, 4] },
    half: { name: '半拍', beats: [1, 1.5, 2, 2.5, 3, 3.5, 4] },
    even: { name: '均匀节奏', beats: [1, 1.25, 1.5, 1.75, 2] },
    swing: { name: '快速摇摆', beats: [1, 1.3, 1.5, 1.8, 2] },
    triplet: { name: '三连音', beats: [1, 1.33, 1.66, 2] }
};

class BeatTapper {
    constructor() {
        this.audio = new Audio();
        this.isPlaying = false;
        this.isSeeking = false;
        this.rafId = null;
        this.dirs = [];
        this.files = [];
        this.allFiles = [];
        this.taps = [];
        this.selectedTapIndex = -1;
        this.currentRhythmType = 'whole';
        this.currentMode = 'normal';
        this.tempoChanges = [];
        this.meterChanges = [];

        this.audio.addEventListener('ended', () => this.stop());
        this.audio.addEventListener('error', (e) => {
            this.setStatus('音频播放错误: ' + e.target.error?.message || '未知错误');
        });

        this.initUI();
        this.loadDirs();
    }

    initUI() {
        $bt('#beatTapperBtn').addEventListener('click', () => this.show());
        $bt('#beatTapperClose').addEventListener('click', () => this.hide());
        $bt('#beatTapperMinimize').addEventListener('click', () => this.minimize());
        $bt('#beatTapperRestore').addEventListener('click', () => this.restore());
        $bt('#beatTapperPlay').addEventListener('click', () => this.play());
        $bt('#beatTapperPause').addEventListener('click', () => this.pause());
        $bt('#beatTapperStop').addEventListener('click', () => this.stop());
        $bt('#beatTapperProgress').addEventListener('input', (e) => this.updateDisplay(e.target.value));
        $bt('#beatTapperProgress').addEventListener('change', (e) => this.seek(e.target.value));
        $bt('#beatTapperProgress').addEventListener('mousedown', () => this.startSeeking());
        $bt('#beatTapperProgress').addEventListener('touchstart', () => this.startSeeking());
        document.addEventListener('mouseup', () => this.stopSeeking());
        document.addEventListener('touchend', () => this.stopSeeking());
        $bt('#beatTapperDir').addEventListener('change', () => this.loadFiles());
        $bt('#beatTapperFile').addEventListener('change', () => this.loadAudio());
        $bt('#beatTapperFileSearch').addEventListener('input', () => this.renderFileList());
        $bt('#beatTapperClear').addEventListener('click', () => this.clearTaps());
        $bt('#beatTapperSave').addEventListener('click', () => this.saveBRC());
        $bt('#beatTapperAddTempoChange').addEventListener('click', () => this.addTempoChange());
        $bt('#beatTapperAddMeterChange').addEventListener('click', () => this.addMeterChange());

        $bt('#beatTapperExportCfg').addEventListener('click', () => this.exportConfig());
        $bt('#beatTapperImportCfg').addEventListener('click', () => this.importConfig());
        $bt('#beatTapperLoadFromTrack').addEventListener('click', () => this.loadFromTrack());

        $bt('.beat-tapper-rhythm-types').addEventListener('click', (e) => {
            if (e.target.classList.contains('beat-tapper-rhythm-btn')) {
                this.setRhythmType(e.target.dataset.type);
            }
        });

        $bt('.beat-tapper-mode-types').addEventListener('click', (e) => {
            if (e.target.classList.contains('beat-tapper-mode-btn')) {
                this.setMode(e.target.dataset.mode);
            }
        });

        $bt('#beatTapperTapArea').addEventListener('click', () => this.tap());
        $bt('#beatTapperMobileUndo').addEventListener('click', () => this.undoTap());
        $bt('#beatTapperMobileJump').addEventListener('click', () => this.jumpToSelected());

        document.addEventListener('keydown', (e) => {
            if (!$bt('#beatTapperWindow').classList.contains('show')) return;
            const tag = e.target.tagName;
            if (tag === 'INPUT') return;
            if (e.key === 'F3') {
                e.preventDefault();
                this.tap();
            } else if (e.key === 'F2') {
                e.preventDefault();
                this.undoTap();
            } else if (e.key === 'F1') {
                e.preventDefault();
                this.jumpToSelected();
            }
        });

        const header = $bt('.beat-tapper-header');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = $bt('#beatTapperWindow').getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const win = $bt('#beatTapperWindow');
            win.style.left = (startLeft + dx) + 'px';
            win.style.top = (startTop + dy) + 'px';
            win.style.transform = 'none';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    setRhythmType(type) {
        this.currentRhythmType = type;
        document.querySelectorAll('.beat-tapper-rhythm-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === type);
        });
        this.updatePreview();
    }

    setMode(mode) {
        this.currentMode = mode;
        document.querySelectorAll('.beat-tapper-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
    }

    async loadDirs() {
        try {
            const res = await fetch('/api/config', { credentials: 'include' });
            const data = await res.json();
            if (data.ok && data.data && data.data.bgm_dirs) {
                this.dirs = data.data.bgm_dirs;
                const select = $bt('#beatTapperDir');
                select.innerHTML = '';
                this.dirs.forEach(dir => {
                    const opt = document.createElement('option');
                    opt.value = dir.id;
                    opt.textContent = dir.label || dir.path;
                    select.appendChild(opt);
                });
                await this.loadFiles();
            }
        } catch (e) {
            this.setStatus('加载目录失败');
        }
    }

    async loadFiles() {
        const dirId = $bt('#beatTapperDir').value;
        try {
            const url = `/api/bgm-list?dir_id=${encodeURIComponent(dirId)}`;
            const res = await fetch(url, { credentials: 'include' });
            const data = await res.json();
            if (data.ok && data.data && data.data.files) {
                this.allFiles = data.data.files || [];
                this.renderFileList();
            }
        } catch (e) {
            this.setStatus('加载文件列表失败');
        }
    }

    renderFileList() {
        const searchQuery = ($bt('#beatTapperFileSearch').value || '').trim().toLowerCase();
        const currentFileName = $bt('#beatTapperFile').value;

        let filtered = this.allFiles;
        if (searchQuery) {
            filtered = this.allFiles.filter(f =>
                (f.filename || '').toLowerCase().includes(searchQuery)
            );
        }

        const select = $bt('#beatTapperFile');
        select.innerHTML = '';

        if (currentFileName) {
            const hasCurrent = filtered.some(f => f.filename === currentFileName);
            if (!hasCurrent) {
                const fake = document.createElement('option');
                fake.value = currentFileName;
                fake.selected = true;
                fake.textContent = `⚠️ ${currentFileName}（不在搜索结果中）`;
                select.appendChild(fake);
            }
        }

        filtered.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.filename;
            opt.textContent = f.filename;
            if (f.filename === currentFileName) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });

        const total = this.allFiles.length;
        const shown = filtered.length;
        if (total === 0) {
            const emptyOpt = document.createElement('option');
            emptyOpt.disabled = true;
            emptyOpt.textContent = '— 当前目录暂无音频文件 —';
            select.appendChild(emptyOpt);
        } else if (searchQuery) {
            const infoOpt = document.createElement('option');
            infoOpt.disabled = true;
            infoOpt.textContent = `— 搜索 "${searchQuery}"：${shown}/${total} 个 —`;
            select.appendChild(infoOpt);
        }
    }

    async loadAudio() {
        const filename = $bt('#beatTapperFile').value;
        if (!filename) return;
        const dirId = $bt('#beatTapperDir').value;
        try {
            const url = `/api/bgm/${encodeURIComponent(filename)}?dir_id=${encodeURIComponent(dirId)}`;
            
            return new Promise((resolve, reject) => {
                const onLoadedMetadata = () => {
                    this.audio.removeEventListener('loadedmetadata', onLoadedMetadata);
                    this.audio.removeEventListener('error', onError);
                    
                    $bt('#beatTapperTotalTime').textContent = this.formatTime(this.audio.duration);
                    this.setStatus('音频加载完成');
                    this.taps = [];
                    this.selectedTapIndex = -1;
                    this.updatePreview();
                    this.updateTapCount();
                    resolve();
                };

                const onError = (e) => {
                    this.audio.removeEventListener('loadedmetadata', onLoadedMetadata);
                    this.audio.removeEventListener('error', onError);
                    this.setStatus('加载音频失败: ' + e.target.error?.message || '未知错误');
                    reject(e);
                };

                this.audio.addEventListener('loadedmetadata', onLoadedMetadata);
                this.audio.addEventListener('error', onError);
                
                this.audio.src = url;
                this.audio.load();
            });
        } catch (e) {
            this.setStatus('加载音频失败: ' + e.message);
        }
    }

    play() {
        if (!this.audio.src) {
            this.setStatus('请先选择音频文件');
            return;
        }
        this.audio.play().then(() => {
            this.isPlaying = true;
            $bt('#beatTapperPlay').style.display = 'none';
            $bt('#beatTapperPause').style.display = 'inline-block';
            this.updateLoop();
        }).catch(e => {
            this.setStatus('播放失败: ' + e.message);
        });
    }

    pause() {
        this.audio.pause();
        this.isPlaying = false;
        $bt('#beatTapperPlay').style.display = 'inline-block';
        $bt('#beatTapperPause').style.display = 'none';
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.isPlaying = false;
        $bt('#beatTapperPlay').style.display = 'inline-block';
        $bt('#beatTapperPause').style.display = 'none';
        $bt('#beatTapperProgress').value = '0';
        $bt('#beatTapperCurrentTime').textContent = '0:00.00';
        $bt('#beatTapperBarValue').textContent = '1:1 (小节:拍)';
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    startSeeking() {
        this.isSeeking = true;
        this.pause();
    }

    stopSeeking() {
        this.isSeeking = false;
    }

    seek(val) {
        if (!this.audio.duration) return;
        const time = (parseFloat(val) / 100) * this.audio.duration;
        this.audio.currentTime = time;
        this.updateDisplay(parseFloat(val));
    }

    updateDisplay(val) {
        if (!this.audio.duration) return;
        const pct = parseFloat(val) || 0;
        const time = (pct / 100) * this.audio.duration;
        $bt('#beatTapperCurrentTime').textContent = this.formatTime(time);
        this.updateBarDisplay(time);
    }

    updateLoop() {
        if (!this.isPlaying) return;
        const s = this.audio.currentTime;
        const dur = this.audio.duration;
        if (!isFinite(dur) || dur <= 0) return;
        $bt('#beatTapperCurrentTime').textContent = this.formatTime(s);
        $bt('#beatTapperProgress').value = (s / dur) * 100;
        this.updateBarDisplay(s);
        this.scrollToCurrentLine(s);
        this.rafId = requestAnimationFrame(() => this.updateLoop());
    }

    scrollToCurrentLine(currentTime) {
        const editor = $bt('#beatTapperEditor');
        if (!editor) return;
        
        const content = editor.value;
        const lines = content.split('\n');
        const tagRegex = /^\[(\d+):([\d.]+)\]/;
        
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
        const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;
        
        const zeroAbsBeat = (zeroBar - 1) * beatsPerBar + zeroBeat;
        
        const sortedTempoChanges = [...this.tempoChanges]
            .filter(tc => tc.bar >= 1 && tc.beat >= 1 && tc.bpm > 0)
            .map(tc => {
                const abs = (tc.bar - 1) * beatsPerBar + tc.beat;
                return { ...tc, abs };
            })
            .sort((a, b) => a.abs - b.abs);
        
        const barBeatToTime = (bar, beat) => {
                return window.BeatUtils.barBeatToTime(bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges);
            };
        
        let currentLineIdx = -1;
        let lastTime = -1;
        
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].trim().match(tagRegex);
            if (match) {
                const bar = parseInt(match[1]);
                const beat = parseFloat(match[2]);
                const time = barBeatToTime(bar, beat);
                
                if (time <= currentTime) {
                    currentLineIdx = i;
                    lastTime = time;
                } else {
                    break;
                }
            }
        }
        
        if (currentLineIdx >= 0 && currentLineIdx !== this.lastHighlightedLine) {
            this.lastHighlightedLine = currentLineIdx;
            
            const lineHeight = editor.scrollHeight / lines.length || 20;
            const targetScrollTop = lineHeight * currentLineIdx - editor.clientHeight / 2 + lineHeight / 2;
            editor.scrollTop = Math.max(0, targetScrollTop);
        }
    }

    updateBarDisplay(currentTime) {
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
        const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;

        const result = window.BeatUtils.timeToBarBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges);

        $bt('#beatTapperBarValue').textContent = `${result.bar}:${result.beat.toFixed(2)} (小节:拍)`;
    }

    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00.00';
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toFixed(2).padStart(5, '0')}`;
    }

    tap() {
        if (!this.audio.src) {
            this.setStatus('请先选择音频文件');
            return;
        }

        const currentTime = this.audio.currentTime;
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
        const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;

        const result = window.BeatUtils.timeToBarBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges);

        const rhythm = RHYTHM_TYPES[this.currentRhythmType];
        const targetBeat = this.findNearestBeat(result.beat, rhythm.beats);

        const tag = `[${result.bar}:${targetBeat}]`;
        this.insertTagAtCursor(tag);

        this.flashTapArea();
        this.updateTapCount();
        this.setStatus(`已打点: ${result.bar}:${targetBeat.toFixed(2)}`);
    }

    insertTagAtCursor(tag) {
        const editor = $bt('#beatTapperEditor');
        const start = editor.selectionStart;

        const content = editor.value;
        const lineStart = content.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = content.indexOf('\n', start);
        const line = content.substring(lineStart, lineEnd === -1 ? content.length : lineEnd);

        const tagRegex = /^\[(\d+):([\d.]+)\]/;
        let newLine;

        if (tagRegex.test(line)) {
            newLine = tag + line.substring(line.match(tagRegex)[0].length);
        } else {
            newLine = tag + line;
        }

        let newContent;
        let cursorPos;

        if (this.currentMode === 'translation') {
            if (lineEnd === -1) {
                newContent = content.substring(0, lineStart) + newLine + '\n' + tag;
                cursorPos = lineStart + newLine.length + 1 + tag.length;
            } else {
                const nextLineStart = lineEnd + 1;
                const nextLineEnd = content.indexOf('\n', nextLineStart);
                const nextLine = content.substring(nextLineStart, nextLineEnd === -1 ? content.length : nextLineEnd);

                let newNextLine;
                if (tagRegex.test(nextLine)) {
                    newNextLine = tag + nextLine.substring(nextLine.match(tagRegex)[0].length);
                } else {
                    newNextLine = tag + nextLine;
                }

                newContent = content.substring(0, lineStart) + newLine + '\n' + newNextLine + content.substring(nextLineEnd === -1 ? content.length : nextLineEnd);
                cursorPos = lineStart + newLine.length + 1 + newNextLine.length + 1;
            }
        } else {
            if (lineEnd === -1) {
                newContent = content.substring(0, lineStart) + newLine;
                cursorPos = lineStart + newLine.length;
            } else {
                newContent = content.substring(0, lineStart) + newLine + content.substring(lineEnd);
                cursorPos = lineStart + newLine.length + 1;
            }
        }

        editor.value = newContent;
        editor.setSelectionRange(cursorPos, cursorPos);
    }

    findNearestBeat(currentBeat, targetBeats) {
        const currentInt = Math.floor(currentBeat);
        let minDiff = Infinity;
        let nearest = currentBeat;

        for (const tb of targetBeats) {
            const fullBeat = currentInt + (tb - 1);
            const diff = Math.abs(currentBeat - fullBeat);
            if (diff < minDiff) {
                minDiff = diff;
                nearest = fullBeat;
            }
        }
        return Math.round(nearest * 100) / 100;
    }

    undoTap() {
        const editor = $bt('#beatTapperEditor');
        const content = editor.value;
        const start = editor.selectionStart;

        const lineStart = content.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = content.indexOf('\n', start);
        const line = content.substring(lineStart, lineEnd === -1 ? content.length : lineEnd);

        const tagRegex = /^\[(\d+):([\d.]+)\]/;
        if (tagRegex.test(line)) {
            const tagLength = line.match(tagRegex)[0].length;
            const newContent = content.substring(0, lineStart) + line.substring(tagLength) + content.substring(lineEnd === -1 ? content.length : lineEnd);
            editor.value = newContent;
            editor.setSelectionRange(lineStart, lineStart);
            this.updateTapCount();
            this.setStatus('已撤回节拍标签');
        } else {
            this.setStatus('当前行没有节拍标签可撤回');
        }
    }

    jumpToSelected() {
        const editor = $bt('#beatTapperEditor');
        const content = editor.value;
        const start = editor.selectionStart;

        const lineStart = content.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = content.indexOf('\n', start);
        const line = content.substring(lineStart, lineEnd === -1 ? content.length : lineEnd);

        const tagRegex = /^\[(\d+):([\d.]+)\]/;
        if (tagRegex.test(line)) {
            const match = line.match(tagRegex);
            const bar = parseInt(match[1]);
            const beat = parseFloat(match[2]);

            const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
            const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
            const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
            const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;

            const targetTime = Math.max(0, window.BeatUtils.barBeatToTime(bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges));

            if (targetTime >= 0 && targetTime <= (this.audio.duration || Infinity)) {
                this.audio.currentTime = targetTime;
                $bt('#beatTapperProgress').value = this.audio.duration ? (targetTime / this.audio.duration) * 100 : 0;
                $bt('#beatTapperCurrentTime').textContent = this.formatTime(targetTime);
                this.updateBarDisplay(targetTime);
                this.setStatus(`已跳转到 ${bar}:${beat}`);
            } else {
                this.setStatus('目标时间超出范围');
            }
        } else {
            this.setStatus('当前行没有节拍标签');
        }
    }

    flashTapArea() {
        const area = $bt('#beatTapperTapArea');
        area.classList.add('active');
        setTimeout(() => area.classList.remove('active'), 150);
    }

    updateTapCount() {
        const editor = $bt('#beatTapperEditor');
        const lines = editor.value.split('\n');
        const tagRegex = /^\[(\d+):([\d.]+)\]/;
        const count = lines.filter(line => tagRegex.test(line.trim())).length;
        $bt('#beatTapperTapCount').textContent = count;
    }

    clearTaps() {
        if (confirm('确定清空所有内容吗？')) {
            $bt('#beatTapperEditor').value = '';
            this.updateTapCount();
            this.setStatus('已清空所有内容');
        }
    }

    async saveBRC() {
        const editor = $bt('#beatTapperEditor');
        const content = editor.value.trim();
        if (!content) {
            this.setStatus('没有可保存的内容');
            return;
        }

        const filename = $bt('#beatTapperFile').value;
        const dirId = $bt('#beatTapperDir').value;
        if (!filename) {
            this.setStatus('请先选择音频文件');
            return;
        }

        try {
            const resp = await fetch('/api/save-brc', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    filename: filename,
                    dir_id: dirId,
                    content: content
                })
            });

            const data = await resp.json();
            if (data.ok) {
                this.setStatus('BRC 文件已保存到音频同目录');
            } else {
                this.setStatus('保存失败: ' + (data.error || '未知错误'));
            }
        } catch (e) {
            this.setStatus('保存失败: ' + e.message);
        }
    }

    setStatus(msg) {
        $bt('#beatTapperStatus').textContent = msg;
    }

    saveTempoChangesToInput() {
        $bt('#beatTapperTempoChanges').value = JSON.stringify(this.tempoChanges);
    }

    saveMeterChangesToInput() {
        $bt('#beatTapperMeterChanges').value = JSON.stringify(this.meterChanges);
    }

    addTempoChange() {
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        
        let nextBar = 5;
        if (this.tempoChanges.length > 0) {
            const maxBar = Math.max(...this.tempoChanges.map(tc => tc.bar || 1));
            nextBar = maxBar + 4;
        }
        
        this.tempoChanges.push({ bar: nextBar, beat: 1, bpm: bpm });
        this.saveTempoChangesToInput();
        this.renderTempoChanges();
    }

    removeTempoChange(index) {
        this.tempoChanges.splice(index, 1);
        this.saveTempoChangesToInput();
        this.renderTempoChanges();
    }

    updateTempoChangeField(index, field, value) {
        if (this.tempoChanges[index]) {
            this.tempoChanges[index][field] = value;
            this.saveTempoChangesToInput();
        }
    }

    renderTempoChanges() {
        const listEl = $bt('#beatTapperTempoChangesList');
        if (!listEl) return;
        
        const sortedWithIdx = this.tempoChanges.map((tc, idx) => ({ ...tc, __idx: idx }))
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });

        if (sortedWithIdx.length === 0) {
            listEl.innerHTML = '<div class="beat-tapper-tc-empty">暂无变速规则，点击上方「＋ 添加变速规则」按钮新增</div>';
            return;
        }

        listEl.innerHTML = '';
        sortedWithIdx.forEach((tc) => {
            const originalIdx = tc.__idx;
            const row = document.createElement('div');
            row.className = 'beat-tapper-tc-row';
            row.dataset.idx = originalIdx;
            row.innerHTML = `
                <span class="beat-tapper-tc-idx">${tc.__idx + 1}</span>
                <input type="number" step="1" min="1" class="beat-tapper-tc-bar" placeholder="小节" value="${tc.bar || ''}">
                <span class="beat-tapper-tc-sep">:</span>
                <input type="number" step="0.1" min="1" class="beat-tapper-tc-beat" placeholder="拍" value="${tc.beat || ''}">
                <span class="beat-tapper-tc-arrow">→</span>
                <input type="number" step="0.1" min="1" class="beat-tapper-tc-bpm" placeholder="BPM" value="${tc.bpm || ''}">
                <button class="beat-tapper-tc-del" title="删除">🗑</button>
            `;
            row.querySelector('.beat-tapper-tc-bar').addEventListener('input', (e) => {
                const val = parseInt(e.target.value) || 0;
                this.updateTempoChangeField(originalIdx, 'bar', val);
            });
            row.querySelector('.beat-tapper-tc-beat').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateTempoChangeField(originalIdx, 'beat', val);
            });
            row.querySelector('.beat-tapper-tc-bpm').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateTempoChangeField(originalIdx, 'bpm', val);
            });
            row.querySelector('.beat-tapper-tc-del').addEventListener('click', () => {
                this.removeTempoChange(originalIdx);
            });
            listEl.appendChild(row);
        });
    }

    addMeterChange() {
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        
        let nextBar = 5;
        if (this.meterChanges.length > 0) {
            const maxBar = Math.max(...this.meterChanges.map(mc => mc.bar || 1));
            nextBar = maxBar + 4;
        }
        
        this.meterChanges.push({ bar: nextBar, beat: 1, beats_per_bar: beatsPerBar });
        this.saveMeterChangesToInput();
        this.renderMeterChanges();
    }

    removeMeterChange(index) {
        this.meterChanges.splice(index, 1);
        this.saveMeterChangesToInput();
        this.renderMeterChanges();
    }

    updateMeterChangeField(index, field, value) {
        if (this.meterChanges[index]) {
            this.meterChanges[index][field] = value;
            this.saveMeterChangesToInput();
        }
    }

    renderMeterChanges() {
        const listEl = $bt('#beatTapperMeterChangesList');
        if (!listEl) return;
        
        const sortedWithIdx = this.meterChanges.map((mc, idx) => ({ ...mc, __idx: idx }))
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });

        if (sortedWithIdx.length === 0) {
            listEl.innerHTML = '<div class="beat-tapper-tc-empty">暂无变拍规则，点击上方「＋ 添加变拍规则」按钮新增</div>';
            return;
        }

        listEl.innerHTML = '';
        sortedWithIdx.forEach((mc) => {
            const originalIdx = mc.__idx;
            const row = document.createElement('div');
            row.className = 'beat-tapper-tc-row';
            row.dataset.idx = originalIdx;
            row.innerHTML = `
                <span class="beat-tapper-tc-idx">${mc.__idx + 1}</span>
                <input type="number" step="1" min="1" class="beat-tapper-tc-bar" placeholder="小节" value="${mc.bar || ''}">
                <span class="beat-tapper-tc-sep">:</span>
                <input type="number" step="0.1" min="1" class="beat-tapper-tc-beat" placeholder="拍" value="${mc.beat || ''}">
                <span class="beat-tapper-tc-arrow">→</span>
                <input type="number" step="0.1" min="1" class="beat-tapper-tc-bpm" placeholder="每小节拍数" value="${mc.beats_per_bar || ''}">
                <button class="beat-tapper-tc-del" title="删除">🗑</button>
            `;
            row.querySelector('.beat-tapper-tc-bar').addEventListener('input', (e) => {
                const val = parseInt(e.target.value) || 0;
                this.updateMeterChangeField(originalIdx, 'bar', val);
            });
            row.querySelector('.beat-tapper-tc-beat').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateMeterChangeField(originalIdx, 'beat', val);
            });
            row.querySelector('.beat-tapper-tc-bpm').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateMeterChangeField(originalIdx, 'beats_per_bar', val);
            });
            row.querySelector('.beat-tapper-tc-del').addEventListener('click', () => {
                this.removeMeterChange(originalIdx);
            });
            listEl.appendChild(row);
        });
    }

    show() {
        $bt('#beatTapperWindow').style.display = 'block';
        $bt('#beatTapperWindow').classList.add('show');
        $bt('#beatTapperMinimized').style.display = 'none';
    }

    hide() {
        $bt('#beatTapperWindow').style.display = 'none';
        $bt('#beatTapperWindow').classList.remove('show');
        $bt('#beatTapperMinimized').style.display = 'none';
        this.pause();
    }

    minimize() {
        $bt('#beatTapperWindow').style.display = 'none';
        $bt('#beatTapperWindow').classList.remove('show');
        $bt('#beatTapperMinimized').style.display = 'block';
    }

    restore() {
        $bt('#beatTapperMinimized').style.display = 'none';
        $bt('#beatTapperWindow').style.display = 'block';
        $bt('#beatTapperWindow').classList.add('show');
    }

    exportConfig() {
        const code = window.BeatUtils.exportChanges(this.tempoChanges, this.meterChanges);
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            $bt('#beatTapperStatus').textContent = '✅ 配置代码已复制到剪贴板';
        } catch (e) {
            $bt('#beatTapperStatus').textContent = '配置代码：' + code;
        }
        document.body.removeChild(ta);
    }

    importConfig() {
        const code = prompt('请粘贴配置代码：');
        if (!code) return;
        const result = window.BeatUtils.importChanges(code);
        if (!result) {
            $bt('#beatTapperStatus').textContent = '❌ 配置代码无效';
            return;
        }
        this.tempoChanges = result.tempoChanges;
        this.meterChanges = result.meterChanges;
        this.renderTempoChanges();
        this.renderMeterChanges();
        $bt('#beatTapperStatus').textContent = `✅ 已导入 ${result.tempoChanges.length} 条变速、${result.meterChanges.length} 条变拍`;
    }

    loadFromTrack() {
        const select = $bt('#beatTapperFile');
        const dir = $bt('#beatTapperDir').value;
        if (!select.value) {
            $bt('#beatTapperStatus').textContent = '❌ 请先选择一个曲目文件';
            return;
        }
        const fileName = select.value;
        fetch('/api/track_config?dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(fileName))
            .then(r => r.json())
            .then(cfg => {
                this.tempoChanges = (cfg.tempo_changes || []).map(tc => ({ bar: tc.bar, beat: tc.beat, bpm: tc.bpm }));
                this.meterChanges = (cfg.meter_changes || []).map(mc => ({ bar: mc.bar, beat: mc.beat, beats_per_bar: mc.beats_per_bar }));
                this.renderTempoChanges();
                this.renderMeterChanges();
                $bt('#beatTapperStatus').textContent = `✅ 已从曲目载入 ${this.tempoChanges.length} 条变速、${this.meterChanges.length} 条变拍`;
            })
            .catch(() => {
                $bt('#beatTapperStatus').textContent = '❌ 载入失败';
            });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.beatTapper = new BeatTapper();
});