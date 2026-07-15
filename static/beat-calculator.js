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
            const url = `/api/bgm/${encodeURIComponent(fileName)}?dir_id=${encodeURIComponent(dirId)}`;
            
            return new Promise((resolve, reject) => {
                const onLoadedMetadata = () => {
                    this.audio.removeEventListener('loadedmetadata', onLoadedMetadata);
                    this.audio.removeEventListener('error', onError);
                    
                    const duration = this.audio.duration || 0;
                    $bc('#beatCalcTotalTime').textContent = this.formatTime(duration);
                    $bc('#beatCalcProgress').max = duration;
                    $bc('#beatCalcProgress').value = 0;
                    this.setStatus('加载完成');
                    this.updateBarDisplay(0);
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

    async play() {
        if (!this.audio.src) {
            await this.loadAudio();
            if (!this.audio.src) return;
        }

        if (this.isPlaying) return;

        try {
            await this.audio.play();
            this.isPlaying = true;
            $bc('#beatCalcPlay').style.display = 'none';
            $bc('#beatCalcPause').style.display = 'inline-block';
            this.setStatus('播放中');
            this.startUiTicker();
        } catch (e) {
            this.setStatus('播放失败: ' + e.message);
        }
    }

    pause() {
        if (!this.isPlaying) return;
        this.audio.pause();
        this.isPlaying = false;
        this.stopUiTicker();
        $bc('#beatCalcPlay').style.display = 'inline-block';
        $bc('#beatCalcPause').style.display = 'none';
        this.setStatus('已暂停');
    }

    stop() {
        this.pause();
        this.audio.currentTime = 0;
        $bc('#beatCalcProgress').value = 0;
        $bc('#beatCalcCurrentTime').textContent = '0:00.00';
        this.updateBarDisplay(0);
        this.setStatus('已停止');
    }

    updateDisplay(value) {
        const time = parseFloat(value);
        $bc('#beatCalcCurrentTime').textContent = this.formatTime(time);
        this.updateBarDisplay(time);
    }

    seek(value) {
        if (!this.audio.src) return;
        
        let time = parseFloat(value);
        const duration = this.audio.duration || 0;
        
        if (isNaN(time)) time = 0;
        if (time < 0) time = 0;
        if (time > duration) time = duration;
        
        this.audio.currentTime = time;
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
        
        const currentTime = this.audio.currentTime || 0;
        const duration = this.audio.duration || 0;
        
        if (!isNaN(currentTime) && duration > 0) {
            $bc('#beatCalcProgress').value = currentTime;
            $bc('#beatCalcCurrentTime').textContent = this.formatTime(currentTime);
            this.updateBarDisplay(currentTime);
        }
    }

    startSeeking() {
        this.isSeeking = true;
    }

    stopSeeking() {
        if (!this.isSeeking) return;
        this.isSeeking = false;
        
        const time = parseFloat($bc('#beatCalcProgress').value);
        this.seek(time);
        
        if (this.isPlaying) {
            this.audio.play().catch(() => {});
            this.startUiTicker();
        }
    }

    updateBarDisplay(currentTime) {
        const bpm = parseFloat($bc('#beatCalcBpm').value) || 120;
        const beatsPerBar = parseInt($bc('#beatCalcBeatsPerBar').value) || 4;
        const zeroBar = parseInt($bc('#beatCalcZeroBar').value) || 1;
        const zeroBeat = parseFloat($bc('#beatCalcZeroBeat').value) || 1;

        const beatsPerSec = bpm / 60;
        const zeroAbsBeat = (zeroBar - 1) * beatsPerBar + zeroBeat;
        const absBeatRaw = currentTime * beatsPerSec + zeroAbsBeat;

        const currentBeatInt = Math.max(1, Math.floor(absBeatRaw));
        const barNum = Math.floor((currentBeatInt - 1) / beatsPerBar) + 1;
        const beatInBar = ((currentBeatInt - 1) % beatsPerBar) + 1;

        const barStr = barNum;
        const beatStr = beatInBar.toFixed(1);

        $bc('#beatCalcBarValue').textContent = `${barStr}:${beatStr} (小节:拍)`;
    }

    formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '0:00.00';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
    }

    setStatus(text) {
        $bc('#beatCalcStatus').textContent = text;
    }

    show() {
        $bc('#beatCalcWindow').classList.add('show');
        $bc('#beatCalcMinimized').style.display = 'none';
    }

    hide() {
        this.stop();
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
}

document.addEventListener('DOMContentLoaded', () => {
    window.beatCalculator = new BeatCalculator();
});