const $bc = (sel) => document.querySelector(sel);

class BeatCalculator {
    constructor() {
        this.audio = new Audio();
        this.isPlaying = false;
        this.isSeeking = false;
        this.rafId = null;
        this.dirs = [];
        this.files = [];
        this.allFiles = [];
        this.tempoChanges = [];
        this.meterChanges = [];
        
        this.audioCtx = null;
        this.beatBuffer = null;
        this.barBuffer = null;
        this.audioBuffer = null;
        this.audioSource = null;
        this.gainNode = null;
        this.metronomeTimer = null;
        this.lastScheduledBeat = -1;
        this.playbackStartTime = 0;
        this.playbackOffset = 0;
        this.wasPlaying = false;

        this.audio.addEventListener('ended', () => this.stop());
        this.audio.addEventListener('error', (e) => {
            this.setStatus('音频播放错误: ' + e.target.error?.message || '未知错误');
        });

        this.initUI();
        this.loadDirs();
    }

    initUI() {
        $bc('#beatCalcBtn').addEventListener('click', () => this.show());
        $bc('#beatCalcClose').addEventListener('click', () => this.hide());
        $bc('#beatCalcMinimize').addEventListener('click', () => this.minimize());
        $bc('#beatCalcRestore').addEventListener('click', () => this.restore());
        $bc('#beatCalcPlay').addEventListener('click', () => this.play());
        $bc('#beatCalcPause').addEventListener('click', () => this.pause());
        $bc('#beatCalcStop').addEventListener('click', () => this.stop());
        $bc('#beatCalcProgress').addEventListener('input', (e) => this.updateDisplay(e.target.value));
        $bc('#beatCalcProgress').addEventListener('change', (e) => this.seek(e.target.value));
        $bc('#beatCalcProgress').addEventListener('mousedown', () => this.startSeeking());
        $bc('#beatCalcProgress').addEventListener('touchstart', () => this.startSeeking());
        document.addEventListener('mouseup', () => this.stopSeeking());
        document.addEventListener('touchend', () => this.stopSeeking());
        $bc('#beatCalcDir').addEventListener('change', () => this.loadFiles());
        $bc('#beatCalcFile').addEventListener('change', () => this.loadAudio());
        $bc('#beatCalcFileSearch').addEventListener('input', () => this.renderFileList());
        $bc('#beatCalcAddTempoChange').addEventListener('click', () => this.addTempoChange());
        $bc('#beatCalcAddMeterChange').addEventListener('click', () => this.addMeterChange());

        this.metronomeEnabled = true;
        $bc('#beatCalcMetronome').addEventListener('change', (e) => {
            this.metronomeEnabled = e.target.checked;
            if (!this.metronomeEnabled) {
                this.stopMetronome();
            } else if (this.isPlaying) {
                this.startMetronome();
            }
        });

        const header = $bc('.beat-calc-header');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = $bc('#beatCalcWindow').getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const win = $bc('#beatCalcWindow');
            win.style.left = (startLeft + dx) + 'px';
            win.style.top = (startTop + dy) + 'px';
            win.style.transform = 'none';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    async loadDirs() {
        try {
            const res = await fetch('/api/config', { credentials: 'include' });
            const data = await res.json();
            if (data.ok && data.data && data.data.bgm_dirs) {
                this.dirs = data.data.bgm_dirs;
                const select = $bc('#beatCalcDir');
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
        const dirId = $bc('#beatCalcDir').value;
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
        const searchQuery = ($bc('#beatCalcFileSearch').value || '').trim().toLowerCase();
        const currentFileName = $bc('#beatCalcFile').value;
        
        let filtered = this.allFiles;
        if (searchQuery) {
            filtered = this.allFiles.filter(f => 
                (f.filename || '').toLowerCase().includes(searchQuery)
            );
        }
        
        const select = $bc('#beatCalcFile');
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
        const dirId = $bc('#beatCalcDir').value;
        const fileName = $bc('#beatCalcFile').value;
        if (!fileName) {
            this.setStatus('请选择文件');
            return;
        }

        this.stop();
        this.setStatus('加载中...');

        try {
            this.initAudioContext();
            const url = `/api/bgm/${encodeURIComponent(fileName)}?dir_id=${encodeURIComponent(dirId)}`;
            
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            this.audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
            
            const duration = this.audioBuffer.duration || 0;
            $bc('#beatCalcTotalTime').textContent = this.formatTime(duration);
            $bc('#beatCalcProgress').max = duration;
            $bc('#beatCalcProgress').value = 0;
            this.setStatus('加载完成');
            this.updateBarDisplay(0);
        } catch (e) {
            this.setStatus('加载音频失败: ' + e.message);
        }
    }

    async play() {
        if (!this.audioBuffer) {
            await this.loadAudio();
            if (!this.audioBuffer) return;
        }

        if (this.isPlaying) return;

        try {
            this.initAudioContext();
            
            if (!this.gainNode) {
                this.gainNode = this.audioCtx.createGain();
                this.gainNode.connect(this.audioCtx.destination);
            }
            
            this.audioSource = this.audioCtx.createBufferSource();
            this.audioSource.buffer = this.audioBuffer;
            this.audioSource.connect(this.gainNode);
            
            this.playbackStartTime = this.audioCtx.currentTime;
            this.playbackOffset = parseFloat($bc('#beatCalcProgress').value) || 0;
            
            this.audioSource.start(0, this.playbackOffset);
            
            this.audioSource.onended = () => {
                this.stop();
            };
            
            this.isPlaying = true;
            this.lastScheduledBeat = -1;
            $bc('#beatCalcPlay').style.display = 'none';
            $bc('#beatCalcPause').style.display = 'inline-block';
            this.setStatus('播放中');
            this.startUiTicker();
            this.startMetronome();
        } catch (e) {
            this.setStatus('播放失败: ' + e.message);
        }
    }

    pause() {
        if (!this.isPlaying) return;
        
        const currentTime = this.getCurrentTime();
        
        if (this.audioSource) {
            this.audioSource.onended = null;
            this.audioSource.stop();
            this.audioSource = null;
        }
        
        this.playbackOffset = currentTime;
        this.isPlaying = false;
        this.stopUiTicker();
        this.stopMetronome();
        this.lastScheduledBeat = -1;
        $bc('#beatCalcPlay').style.display = 'inline-block';
        $bc('#beatCalcPause').style.display = 'none';
        this.setStatus('已暂停');
    }
    
    getCurrentTime() {
        if (!this.isPlaying || !this.audioCtx) {
            return this.playbackOffset;
        }
        return this.playbackOffset + (this.audioCtx.currentTime - this.playbackStartTime);
    }

    stop() {
        this.pause();
        this.playbackOffset = 0;
        $bc('#beatCalcProgress').value = 0;
        $bc('#beatCalcCurrentTime').textContent = '0:00.00';
        this.updateBarDisplay(0);
        this.lastScheduledBeat = -1;
        this.setStatus('已停止');
    }

    updateDisplay(value) {
        const time = parseFloat(value);
        $bc('#beatCalcCurrentTime').textContent = this.formatTime(time);
        this.updateBarDisplay(time);
    }

    seek(value) {
        let time = parseFloat(value);
        const duration = this.audioBuffer ? this.audioBuffer.duration : 0;
        
        if (isNaN(time)) time = 0;
        if (time < 0) time = 0;
        if (time > duration) time = duration;
        
        this.playbackOffset = time;
        $bc('#beatCalcProgress').value = time;
        this.updateDisplay(time);
    }

    startUiTicker() {
        cancelAnimationFrame(this.rafId);
        this.updateUi();
    }

    stopUiTicker() {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    updateUi() {
        if (!this.isPlaying || this.isSeeking) return;
        
        this.rafId = requestAnimationFrame(() => this.updateUi());
        
        const currentTime = this.getCurrentTime();
        const duration = this.audioBuffer ? this.audioBuffer.duration : 0;
        
        if (!isNaN(currentTime) && duration > 0) {
            $bc('#beatCalcProgress').value = currentTime;
            $bc('#beatCalcCurrentTime').textContent = this.formatTime(currentTime);
            this.updateBarDisplay(currentTime);
        }
    }

    startSeeking() {
        this.isSeeking = true;
        this.wasPlaying = this.isPlaying;
        if (this.audioSource) {
            this.audioSource.onended = null;
            this.audioSource.stop();
            this.audioSource = null;
        }
    }

    stopSeeking() {
        if (!this.isSeeking) return;
        this.isSeeking = false;
        
        const time = parseFloat($bc('#beatCalcProgress').value);
        this.seek(time);
        
        if (this.wasPlaying) {
            if (this.audioSource) {
                this.audioSource.stop();
                this.audioSource = null;
            }
            
            this.audioSource = this.audioCtx.createBufferSource();
            this.audioSource.buffer = this.audioBuffer;
            this.audioSource.connect(this.gainNode);
            
            this.playbackStartTime = this.audioCtx.currentTime;
            this.playbackOffset = time;
            
            this.audioSource.start(0, this.playbackOffset);
            this.audioSource.onended = () => {
                this.stop();
            };
            
            this.isPlaying = true;
            this.lastScheduledBeat = -1;
            this.startUiTicker();
            this.startMetronome();
        }
    }

    updateBarDisplay(currentTime) {
        const bpm = parseFloat($bc('#beatCalcBpm').value) || 120;
        const beatsPerBar = parseFloat($bc('#beatCalcBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bc('#beatCalcZeroBar').value) || 1;
        const zeroBeat = parseFloat($bc('#beatCalcZeroBeat').value) || 1;

        const result = window.BeatUtils.timeToBarBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges);

        $bc('#beatCalcBarValue').textContent = `${result.bar}:${result.beat.toFixed(2)} (小节:拍)`;
    }

    formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '0:00.00';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
    }
    
    initAudioContext() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        return this.audioCtx;
    }
    
    async preloadSounds() {
        if (!this.audioCtx) {
            this.initAudioContext();
        }
        
        if (this.beatBuffer && this.barBuffer) return;
        
        try {
            this.barBuffer = await this.loadBuffer('/static/Metronome/Bar.wav');
            this.beatBuffer = await this.loadBuffer('/static/Metronome/Beat.wav');
        } catch (e) {
            console.error('Failed to preload metronome sounds:', e);
        }
    }
    
    async loadBuffer(url) {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return this.audioCtx.decodeAudioData(arrayBuffer);
    }
    
    scheduleSound(buffer, time) {
        if (!this.audioCtx || !buffer) return;
        
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioCtx.destination);
        source.start(time);
    }
    
    startMetronome() {
        if (!this.metronomeEnabled) return;
        if (this.metronomeTimer) {
            cancelAnimationFrame(this.metronomeTimer);
        }
        this.scheduleNextBeat();
    }
    
    stopMetronome() {
        if (this.metronomeTimer) {
            cancelAnimationFrame(this.metronomeTimer);
            this.metronomeTimer = null;
        }
    }
    
    scheduleNextBeat() {
        if (!this.isPlaying || !this.audioCtx || !this.beatBuffer || !this.metronomeEnabled) {
            this.metronomeTimer = null;
            return;
        }

        const ctxTime = this.audioCtx.currentTime;
        const audioTime = this.getCurrentTime();

        const bpm = parseFloat($bc('#beatCalcBpm').value) || 120;
        const beatsPerBar = parseFloat($bc('#beatCalcBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bc('#beatCalcZeroBar').value) || 1;
        const zeroBeat = parseFloat($bc('#beatCalcZeroBeat').value) || 1;

        const { bar: curBar, beat: curBeat } = window.BeatUtils.timeToBarBeat(
            audioTime, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges
        );

        const effectiveBpb = window.BeatUtils.getEffectiveBeatsPerBar(
            curBar, curBeat, beatsPerBar, this.meterChanges
        );

        const curBeatFloor = Math.floor(curBeat);
        let nextBar, nextBeat;

        if (curBeatFloor + 1 <= Math.ceil(effectiveBpb)) {
            nextBar = curBar;
            nextBeat = curBeatFloor + 1;
        } else {
            nextBar = curBar + 1;
            nextBeat = 1;
        }

        const nextAbs = window.BeatUtils.barBeatToAbs(
            nextBar, nextBeat, beatsPerBar, zeroBar, zeroBeat, this.meterChanges
        );

        if (nextAbs <= this.lastScheduledBeat) {
            this.metronomeTimer = requestAnimationFrame(() => this.scheduleNextBeat());
            return;
        }

        const nextBeatTime = window.BeatUtils.absBeatToTime(
            nextAbs, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges
        );
        const timeToNextBeat = nextBeatTime - audioTime;

        if (timeToNextBeat > 0) {
            const scheduleTime = ctxTime + timeToNextBeat;
            this.lastScheduledBeat = nextAbs;

            if (nextBeat === 1) {
                this.scheduleSound(this.barBuffer, scheduleTime);
            } else {
                this.scheduleSound(this.beatBuffer, scheduleTime);
            }
        }

        this.metronomeTimer = requestAnimationFrame(() => this.scheduleNextBeat());
    }

    setStatus(text) {
        $bc('#beatCalcStatus').textContent = text;
    }

    show() {
        $bc('#beatCalcWindow').classList.add('show');
        $bc('#beatCalcMinimized').style.display = 'none';
        this.preloadSounds();
    }

    hide() {
        this.stop();
        this.lastScheduledBeat = -1;
        this.audioStartTime = 0;
        this.audioCtxStartTime = 0;
        $bc('#beatCalcWindow').classList.remove('show');
        $bc('#beatCalcMinimized').style.display = 'none';
    }

    minimize() {
        $bc('#beatCalcWindow').classList.remove('show');
        $bc('#beatCalcMinimized').style.display = 'block';
    }

    restore() {
        $bc('#beatCalcMinimized').style.display = 'none';
        $bc('#beatCalcWindow').classList.add('show');
    }

    saveTempoChangesToInput() {
        $bc('#beatCalcTempoChanges').value = JSON.stringify(this.tempoChanges);
    }

    saveMeterChangesToInput() {
        $bc('#beatCalcMeterChanges').value = JSON.stringify(this.meterChanges);
    }

    addTempoChange() {
        const bpm = parseFloat($bc('#beatCalcBpm').value) || 120;
        const beatsPerBar = parseInt($bc('#beatCalcBeatsPerBar').value) || 4;
        
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
        const listEl = $bc('#beatCalcTempoChangesList');
        if (!listEl) return;
        
        const sortedWithIdx = this.tempoChanges.map((tc, idx) => ({ ...tc, __idx: idx }))
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });

        if (sortedWithIdx.length === 0) {
            listEl.innerHTML = '<div class="beat-calc-tc-empty">暂无变速规则，点击上方「＋ 添加变速规则」按钮新增</div>';
            return;
        }

        listEl.innerHTML = '';
        sortedWithIdx.forEach((tc) => {
            const originalIdx = tc.__idx;
            const row = document.createElement('div');
            row.className = 'beat-calc-tc-row';
            row.dataset.idx = originalIdx;
            row.innerHTML = `
                <span class="beat-calc-tc-idx">${tc.__idx + 1}</span>
                <input type="number" step="1" min="1" class="beat-calc-tc-bar" placeholder="小节" value="${tc.bar || ''}">
                <span class="beat-calc-tc-sep">:</span>
                <input type="number" step="0.1" min="1" class="beat-calc-tc-beat" placeholder="拍" value="${tc.beat || ''}">
                <span class="beat-calc-tc-arrow">→</span>
                <input type="number" step="0.1" min="1" class="beat-calc-tc-bpm" placeholder="BPM" value="${tc.bpm || ''}">
                <button class="beat-calc-tc-del" title="删除">🗑</button>
            `;
            row.querySelector('.beat-calc-tc-bar').addEventListener('input', (e) => {
                const val = parseInt(e.target.value) || 0;
                this.updateTempoChangeField(originalIdx, 'bar', val);
            });
            row.querySelector('.beat-calc-tc-beat').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateTempoChangeField(originalIdx, 'beat', val);
            });
            row.querySelector('.beat-calc-tc-bpm').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateTempoChangeField(originalIdx, 'bpm', val);
            });
            row.querySelector('.beat-calc-tc-del').addEventListener('click', () => {
                this.removeTempoChange(originalIdx);
            });
            listEl.appendChild(row);
        });
    }

    addMeterChange() {
        const beatsPerBar = parseFloat($bc('#beatCalcBeatsPerBar').value) || 4;
        
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
        const listEl = $bc('#beatCalcMeterChangesList');
        if (!listEl) return;
        
        const sortedWithIdx = this.meterChanges.map((mc, idx) => ({ ...mc, __idx: idx }))
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });

        if (sortedWithIdx.length === 0) {
            listEl.innerHTML = '<div class="beat-calc-tc-empty">暂无变拍规则，点击上方「＋ 添加变拍规则」按钮新增</div>';
            return;
        }

        listEl.innerHTML = '';
        sortedWithIdx.forEach((mc) => {
            const originalIdx = mc.__idx;
            const row = document.createElement('div');
            row.className = 'beat-calc-tc-row';
            row.dataset.idx = originalIdx;
            row.innerHTML = `
                <span class="beat-calc-tc-idx">${mc.__idx + 1}</span>
                <input type="number" step="1" min="1" class="beat-calc-tc-bar" placeholder="小节" value="${mc.bar || ''}">
                <span class="beat-calc-tc-sep">:</span>
                <input type="number" step="0.1" min="1" class="beat-calc-tc-beat" placeholder="拍" value="${mc.beat || ''}">
                <span class="beat-calc-tc-arrow">→</span>
                <input type="number" step="0.1" min="1" class="beat-calc-tc-bpm" placeholder="每小节拍数" value="${mc.beats_per_bar || ''}">
                <button class="beat-calc-tc-del" title="删除">🗑</button>
            `;
            row.querySelector('.beat-calc-tc-bar').addEventListener('input', (e) => {
                const val = parseInt(e.target.value) || 0;
                this.updateMeterChangeField(originalIdx, 'bar', val);
            });
            row.querySelector('.beat-calc-tc-beat').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateMeterChangeField(originalIdx, 'beat', val);
            });
            row.querySelector('.beat-calc-tc-bpm').addEventListener('input', (e) => {
                const val = parseFloat(e.target.value) || 0;
                this.updateMeterChangeField(originalIdx, 'beats_per_bar', val);
            });
            row.querySelector('.beat-calc-tc-del').addEventListener('click', () => {
                this.removeMeterChange(originalIdx);
            });
            listEl.appendChild(row);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.beatCalculator = new BeatCalculator();
});
