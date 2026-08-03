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
        this.lastHighlightedLine = -1;
        this._scrollMirror = null;
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
        $bt('#beatTapperPlaybackRate').addEventListener('change', (e) => this.setPlaybackRate(parseFloat(e.target.value)));
        document.addEventListener('touchend', () => this.stopSeeking());
        $bt('#beatTapperDir').addEventListener('change', () => this.loadFiles());
        $bt('#beatTapperFile').addEventListener('change', () => this.loadAudio());
        $bt('#beatTapperFileSearch').addEventListener('input', () => this.renderFileList());
        $bt('#beatTapperClear').addEventListener('click', () => this.clearTaps());
        $bt('#beatTapperSave').addEventListener('click', () => this.saveBRC());
        $bt('#beatTapperAddTempoChange').addEventListener('click', () => this.addTempoChange());
        $bt('#beatTapperAddMeterChange').addEventListener('click', () => this.addMeterChange());

        // 编辑器内容变化时重置跟随滚动状态
        $bt('#beatTapperEditor').addEventListener('input', () => {
            this.lastHighlightedLine = -1;
        });
        // 用户手动滚动编辑器时重置跟随状态
        $bt('#beatTapperEditor').addEventListener('scroll', () => {
            this.lastHighlightedLine = -1;
        });

        $bt('#beatTapperExportCfg').addEventListener('click', () => this.exportConfig());
        $bt('#beatTapperImportCfg').addEventListener('click', () => this.importConfig());
        $bt('#beatTapperLoadFromTrack').addEventListener('click', () => this.loadFromTrack());
        $bt('#beatTapperLoadLyric').addEventListener('click', () => this.loadLyric());
        $bt('#beatTapperExportLrc').addEventListener('click', () => this.openExportLrc());

        $bt('#exportLrcDownload').addEventListener('click', () => this.downloadLRC());
        $bt('#exportLrcSaveServer').addEventListener('click', () => this.saveLrcToServer());
        $bt('#exportLrcCopy').addEventListener('click', () => this.showLrcCopyResult());
        $bt('#exportLrcCopyBtn').addEventListener('click', () => this.copyLrcToClipboard());
        $bt('#exportLrcClose').addEventListener('click', () => this.closeExportLrcModal());
        $bt('#exportLrcModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.closeExportLrcModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && $bt('#exportLrcModal').style.display !== 'none') {
                this.closeExportLrcModal();
            }
        });

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

    /**
     * 设置音频播放倍速（仅影响播放快慢，不影响 currentTime 时间轴，打点时间依然准确）
     */
    setPlaybackRate(rate) {
        if (!rate || isNaN(rate) || rate <= 0) return;
        this.audio.playbackRate = rate;
        this.setStatus(`倍速: ${rate}×`);
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
        if (!editor || this.isSeeking) return;
        
        const content = editor.value;
        const lines = content.split('\n');
        const tagRegex = /^\[(\d+):([\d.]+)\]/;
        const charTagRegex = /<(\d+):([\d.]+)>([^<]*)/g;
        
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
        const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;
        const nvf = window.BeatUtils.noteValueFraction($bt('#beatTapperNoteValue').value);

        const barBeatToTime = (bar, beat) => {
            return window.BeatUtils.barBeatToTime(bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges, nvf);
        };
        
        // 找到当前行和当前字符位置
        let currentLineIdx = -1;
        let currentCharPos = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.trim().match(tagRegex);
            if (!match) continue;

            const lineBar = parseInt(match[1]);
            const lineBeat = parseFloat(match[2]);
            const lineTime = barBeatToTime(lineBar, lineBeat);

            if (lineTime > currentTime) break;

            currentLineIdx = i;

            // 解析当前行中的逐字标签，找到当前时间对应的字符位置
            const beforeLine = lines.slice(0, i).join('\n');
            let posInLine = line.indexOf(match[0]) + match[0].length;
            let lastCharEndTime = lineTime;
            let charMatch;
            charTagRegex.lastIndex = posInLine;

            // 修复：track whether the CURRENT line has char tags (not accumulated across iterations)
            // 普通模式（无字标签）的行需每轮更新 currentCharPos 到行尾，
            // 否则永远停在第一个匹配行的行尾，后续匹配行不滚动。
            let foundCharInLine = false;
            while ((charMatch = charTagRegex.exec(line)) !== null) {
                foundCharInLine = true;
                const cBar = parseInt(charMatch[1]);
                const cBeat = parseFloat(charMatch[2]);
                const cTime = barBeatToTime(cBar, cBeat);

                if (cTime > currentTime) break;

                lastCharEndTime = cTime;
                posInLine = charMatch.index + charMatch[0].length;

                // 当前字符的起始时间 <= currentTime < 下一字符的起始时间
                // 此时 posInLine 指向当前字符之后、下一标签之前
                currentCharPos = beforeLine.length + 1 + posInLine;
            }

            // 普通模式（本行无字标签）：滚动到当前行末尾
            // 必须无条件覆盖之前的 currentCharPos，否则上一轮的字符位置会一直保留
            if (!foundCharInLine) {
                const endOfLine = beforeLine.length + 1 + line.length;
                currentCharPos = endOfLine;
            }
        }
        
        // 滚动到当前字符位置（比行级别更精确，处理自动换行）
        if (currentCharPos >= 0) {
            this._scrollEditorToCharPos(editor, currentCharPos);
        } else if (currentLineIdx >= 0) {
            this._scrollEditorToLine(editor, currentLineIdx);
        }
    }

    /**
     * 将编辑器滚动到指定字符位置，使该字符可见
     * 使用完善的 mirror div 测量（复制全部关键 CSS 属性），精确处理自动换行
     * 当 mirror 测量异常时回退到字符比例滚动
     */
    _scrollEditorToCharPos(editor, charPos) {
        const text = editor.value;
        const beforeChar = text.substring(0, charPos);
        
        if (!this._scrollMirror) {
            this._scrollMirror = document.createElement('div');
            this._scrollMirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;top:0;left:-9999px;pointer-events:none;`;
            document.body.appendChild(this._scrollMirror);
        }
        const mirror = this._scrollMirror;
        const cs = getComputedStyle(editor);
        
        // 复制所有影响文本布局的 CSS 属性
        const paddingLeft = parseFloat(cs.paddingLeft) || 0;
        const paddingRight = parseFloat(cs.paddingRight) || 0;
        const paddingTop = parseFloat(cs.paddingTop) || 0;
        
        // 纯文本区宽度（去除 padding）
        const textWidth = editor.clientWidth - paddingLeft - paddingRight;
        mirror.style.width = textWidth + 'px';
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.fontStyle = cs.fontStyle;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.style.wordSpacing = cs.wordSpacing;
        mirror.style.textIndent = '0';
        mirror.style.padding = '0';
        mirror.style.border = '0';
        mirror.style.margin = '0';
        mirror.style.boxSizing = 'content-box';
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.wordBreak = cs.wordBreak || 'break-word';
        mirror.style.overflowWrap = cs.overflowWrap || 'break-word';
        mirror.style.tabSize = cs.tabSize || '8';
        
        // 处理尾部换行符：加空格以正确渲染末尾空行
        const displayText = beforeChar.endsWith('\n') ? beforeChar + ' ' : beforeChar;
        mirror.textContent = displayText;
        
        const cursorPixelTop = mirror.offsetHeight + paddingTop;
        
        // 合理性检查：若测量值超出 scrollHeight，回退到比例法
        const scrollHeight = editor.scrollHeight;
        const clientHeight = editor.clientHeight;
        let targetScrollTop;
        
        if (cursorPixelTop <= scrollHeight + 50) {
            // 正常：将光标放在视口 1/3 位置
            targetScrollTop = Math.max(0, cursorPixelTop - clientHeight / 3);
        } else {
            // 异常：回退到字符比例法
            const ratio = charPos / Math.max(1, text.length);
            targetScrollTop = ratio * Math.max(0, scrollHeight - clientHeight);
        }
        
        // 边界检查：确保当前字符可见
        const clampedTop = Math.max(0, Math.min(targetScrollTop, scrollHeight - clientHeight));
        editor.scrollTop = clampedTop;
    }

    /**
     * 将编辑器滚动到指定行，使该行位于视口中央偏上（1/3 位置）
     * 使用完善的 mirror div 测量，复制全部关键 CSS 属性
     */
    _scrollEditorToLine(editor, lineIdx) {
        if (!this._scrollMirror) {
            this._scrollMirror = document.createElement('div');
            this._scrollMirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;top:0;left:-9999px;pointer-events:none;`;
            document.body.appendChild(this._scrollMirror);
        }
        const mirror = this._scrollMirror;
        const cs = getComputedStyle(editor);
        const paddingLeft = parseFloat(cs.paddingLeft) || 0;
        const paddingRight = parseFloat(cs.paddingRight) || 0;
        const paddingTop = parseFloat(cs.paddingTop) || 0;
        
        const textWidth = editor.clientWidth - paddingLeft - paddingRight;
        mirror.style.width = textWidth + 'px';
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.fontStyle = cs.fontStyle;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.style.wordSpacing = cs.wordSpacing;
        mirror.style.padding = '0';
        mirror.style.border = '0';
        mirror.style.margin = '0';
        mirror.style.boxSizing = 'content-box';
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.wordBreak = cs.wordBreak || 'break-word';
        mirror.style.overflowWrap = cs.overflowWrap || 'break-word';
        mirror.style.tabSize = cs.tabSize || '8';
        
        const text = editor.value;
        const lines = text.split('\n');
        const beforeText = lines.slice(0, lineIdx).join('\n');
        const lineContent = lines[lineIdx] || '';
        
        mirror.textContent = beforeText + '\n';
        const lineTop = mirror.offsetHeight + paddingTop;
        
        mirror.textContent = beforeText + '\n' + lineContent;
        const lineBottom = mirror.offsetHeight + paddingTop;
        const lineHeight = lineBottom - lineTop;
        const viewport = editor.clientHeight;
        const scrollHeight = editor.scrollHeight;
        
        let targetScrollTop;
        if (lineHeight > viewport * 2 / 3) {
            targetScrollTop = Math.max(0, lineTop - 10);
        } else {
            targetScrollTop = Math.max(0, lineTop - viewport / 3);
        }
        
        const clampedTop = Math.max(0, Math.min(targetScrollTop, scrollHeight - viewport));
        editor.scrollTop = clampedTop;
    }

    updateBarDisplay(currentTime) {
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
        const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;
        const nvf = window.BeatUtils.noteValueFraction($bt('#beatTapperNoteValue').value);

        const result = window.BeatUtils.timeToBarBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges, nvf);

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
        const nvf = window.BeatUtils.noteValueFraction($bt('#beatTapperNoteValue').value);

        const result = window.BeatUtils.timeToBarBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges, nvf);

        const rhythm = RHYTHM_TYPES[this.currentRhythmType];
        const targetBeat = this.findNearestBeat(result.beat, rhythm.beats);

        const isKaraoke = $bt('#beatTapperKaraokeMode')?.checked;
        if (isKaraoke) {
            const charTag = `<${result.bar}:${targetBeat}>`;
            const lineTag = `[${result.bar}:${targetBeat}]`;
            this.insertKaraokeTagAtCursor(charTag, lineTag);
            this.setStatus(`逐字打点: ${result.bar}:${targetBeat.toFixed(2)}`);
        } else {
            const tag = `[${result.bar}:${targetBeat}]`;
            this.insertTagAtCursor(tag);
            this.setStatus(`已打点: ${result.bar}:${targetBeat.toFixed(2)}`);
        }

        this.flashTapArea();
        this.updateTapCount();
    }

    /**
     * 卡拉OK模式：计算从字符串指定位置（UTF-16 index）开始的下一个打点步长
     * - 英文拉丁字母（A-Za-z）：连续整个单词 + 后续所有空白字符 作为一个打点单元（支持撇号 it's / don't）
     * - 空白字符：连续跳过所有空白，直接到下一个非空白字符前
     * - 其他字符（中日韩、数字、标点、emoji）：一个 Unicode 码点一个打点单元
     * 返回需要跳过的 UTF-16 字符数
     */
    _getKaraokeStepLength(text, startIdx) {
        if (startIdx >= text.length) return 0;
        const firstCodePoint = text.codePointAt(startIdx);
        const firstIsLetter =
            (firstCodePoint >= 0x41 && firstCodePoint <= 0x5A) || // A-Z
            (firstCodePoint >= 0x61 && firstCodePoint <= 0x7A);   // a-z
        const firstIsWhitespace =
            firstCodePoint === 0x20 ||                              // space
            firstCodePoint === 0x09 ||                              // tab
            firstCodePoint === 0x0A ||                              // newline (won't occur here but safe)
            firstCodePoint === 0x0D;                                // CR
        let endIdx = startIdx;

        if (firstIsLetter) {
            // 1. 吃掉整个单词（字母 + 撇号）
            while (endIdx < text.length) {
                const cp = text.codePointAt(endIdx);
                const isWordChar =
                    (cp >= 0x41 && cp <= 0x5A) ||                    // A-Z
                    (cp >= 0x61 && cp <= 0x7A) ||                    // a-z
                    cp === 0x27;                                      // '
                if (isWordChar) {
                    endIdx += cp > 0xFFFF ? 2 : 1;
                } else {
                    break;
                }
            }
            // 2. 吃掉单词后面紧跟的全部空白字符（空格、tab、全角空格等）
            while (endIdx < text.length) {
                const cp = text.codePointAt(endIdx);
                const isWs =
                    cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D ||
                    cp === 0x3000 ||                                  // 全角空格
                    cp === 0x00A0;                                    // 非断空格
                if (isWs) {
                    endIdx += cp > 0xFFFF ? 2 : 1;
                } else {
                    break;
                }
            }
        } else if (firstIsWhitespace) {
            // 光标当前处于空白：连续跳过所有空白，直接到下一个非空白字符
            while (endIdx < text.length) {
                const cp = text.codePointAt(endIdx);
                const isWs =
                    cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D ||
                    cp === 0x3000 || cp === 0x00A0;
                if (isWs) {
                    endIdx += cp > 0xFFFF ? 2 : 1;
                } else {
                    break;
                }
            }
        } else {
            // 中日韩、数字、标点、emoji 等：一个码点一步
            endIdx += firstCodePoint > 0xFFFF ? 2 : 1;
            // 对于非空白非字母字符，如果后面紧跟空白也一并跳过
            while (endIdx < text.length) {
                const cp = text.codePointAt(endIdx);
                const isWs =
                    cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D ||
                    cp === 0x3000 || cp === 0x00A0;
                if (isWs) {
                    endIdx += cp > 0xFFFF ? 2 : 1;
                } else {
                    break;
                }
            }
        }

        return Math.max(1, endIdx - startIdx);
    }

    /**
     * 卡拉OK模式：在光标位置插入字标签 <bar:beat>
     * - 若当前行无行首 [bar:beat] 标签，先在行首插入行起点标签，再在光标处插字标签
     * - 光标后还有字：插入字标签，光标跳到下一个打点单元前
     *   - 英文/拉丁字母：跳一整个单词（A-Za-z' 连续串），逐个单词打点
     *   - 中日韩/数字/标点/emoji：跳一个码点，逐字打点
     * - 光标后无字（行尾）：插入的标签作为结束节拍（空内容，标记最后字结束时间），光标跳到下一行开头
     * - 插入后自动滚动编辑器到光标位置
     */
    insertKaraokeTagAtCursor(charTag, lineTag) {
        const editor = $bt('#beatTapperEditor');
        const content = editor.value;
        let pos = editor.selectionStart;

        const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd = content.indexOf('\n', pos);
        const lineEndAdjusted = lineEnd === -1 ? content.length : lineEnd;
        const line = content.substring(lineStart, lineEndAdjusted);

        const lineTagRegex = /^\[(\d+):([\d.]+)\]/;
        const hasLineTag = lineTagRegex.test(line);

        const beforeLine = content.substring(0, lineStart);
        const afterLine = content.substring(lineEndAdjusted);
        const insertOffset = pos - lineStart;
        const prefixLen = hasLineTag ? 0 : lineTag.length;

        // 判断光标后（跳过其他字标签）是否还有字
        const afterCursorInLine = line.substring(insertOffset).replace(/^(<\d+:[\d.]+>)+/, '');
        const remainingChars = [...afterCursorInLine];
        const isEndOfLine = remainingChars.length === 0;

        let newLineContent;
        if (!hasLineTag) {
            const lineWithLineTag = lineTag + line;
            const adjustedOffset = insertOffset + lineTag.length;
            newLineContent = lineWithLineTag.substring(0, adjustedOffset)
                + charTag
                + lineWithLineTag.substring(adjustedOffset);
        } else {
            newLineContent = line.substring(0, insertOffset)
                + charTag
                + line.substring(insertOffset);
        }

        let newContent, cursorPos;
        if (isEndOfLine) {
            // 已到行尾：插入的 <bar:beat> 作为结束节拍，光标跳到下一行开头
            if (afterLine.length > 0) {
                // 有下一行
                newContent = beforeLine + newLineContent + afterLine;
                cursorPos = beforeLine.length + newLineContent.length + 1; // +1 跳过 \n
            } else {
                // 没有下一行，创建新行
                newContent = beforeLine + newLineContent + '\n';
                cursorPos = newContent.length;
            }
        } else {
            // 还有字：光标跳到下一个打点单元前
            newContent = beforeLine + newLineContent + afterLine;
            const afterInsertOffset = insertOffset + prefixLen + charTag.length;
            const rest = newLineContent.substring(afterInsertOffset);
            const restTrimmed = rest.replace(/^(<\d+:[\d.]+>)+/, '');
            const skippedTagsLen = rest.length - restTrimmed.length;
            // 智能步长：英文整词、CJK 逐字
            const stepLen = this._getKaraokeStepLength(restTrimmed, 0);
            cursorPos = beforeLine.length + afterInsertOffset + skippedTagsLen + stepLen;
        }

        editor.value = newContent;
        editor.setSelectionRange(cursorPos, cursorPos);
        this._scrollEditorToCursor(editor);
    }

    /**
     * 滚动编辑器使光标可见（文字过长自动换行时精确滚到光标像素位置）
     * 委托给 _scrollEditorToCharPos（统一完善的 mirror 测量 + 回退逻辑）
     */
    _scrollEditorToCursor(editor) {
        const pos = editor.selectionStart;
        this._scrollEditorToCharPos(editor, pos);
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
        this._scrollEditorToCursor(editor);
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
        const isKaraoke = $bt('#beatTapperKaraokeMode')?.checked;
        if (isKaraoke) {
            this.undoKaraokeTap();
            return;
        }
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
            this._scrollEditorToCursor(editor);
            this.updateTapCount();
            this.setStatus('已撤回节拍标签');
        } else {
            this.setStatus('当前行没有节拍标签可撤回');
        }
    }

    /**
     * 卡拉OK模式撤回：从光标位置向前找最近的 <bar:beat> 字标签删除
     * 撤回后光标跳到"上一个节拍点"（前一个字标签的 > 后面，或行首标签后）
     * 若行内无字标签，则撤回行首 [bar:beat] 标签
     */
    undoKaraokeTap() {
        const editor = $bt('#beatTapperEditor');
        const content = editor.value;
        const pos = editor.selectionStart;

        const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
        const lineEnd = content.indexOf('\n', pos);
        const lineEndAdjusted = lineEnd === -1 ? content.length : lineEnd;
        const line = content.substring(lineStart, lineEndAdjusted);

        // 在光标位置向前找最近的 <bar:beat> 字标签
        const before = line.substring(0, pos - lineStart);
        const charTagRegex = /<(\d+):([\d.]+)>$/;
        const match = before.match(charTagRegex);
        if (match) {
            const tagStart = before.length - match[0].length;
            const newLine = line.substring(0, tagStart) + line.substring(tagStart + match[0].length);
            const newContent = content.substring(0, lineStart) + newLine + content.substring(lineEndAdjusted);
            editor.value = newContent;
            // 光标跳到上一个节拍点：向前找前一个 <bar:beat> 的 > 后面
            const beforeTag = newLine.substring(0, tagStart);
            const prevTagMatch = beforeTag.match(/.*<(\d+):([\d.]+)>([^<]*)$/);
            let newCursor;
            if (prevTagMatch) {
                // 前一个字标签的末尾位置
                newCursor = lineStart + beforeTag.lastIndexOf('>') + 1;
            } else {
                // 没有前一个字标签，跳到行首标签后（或行首）
                const lineTagRegex = /^\[(\d+):([\d.]+)\]/;
                const ltm = newLine.match(lineTagRegex);
                newCursor = ltm ? lineStart + ltm[0].length : lineStart;
            }
            editor.setSelectionRange(newCursor, newCursor);
            this.updateTapCount();
            this.setStatus('已撤回字标签');
            this._scrollEditorToCursor(editor);
        } else {
            // 行内无字标签，撤回行首 [bar:beat] 标签
            const lineTagRegex = /^\[(\d+):([\d.]+)\]/;
            if (lineTagRegex.test(line)) {
                const tagLength = line.match(lineTagRegex)[0].length;
                const newContent = content.substring(0, lineStart) + line.substring(tagLength) + content.substring(lineEndAdjusted);
                editor.value = newContent;
                editor.setSelectionRange(lineStart, lineStart);
                this.updateTapCount();
                this.setStatus('已撤回行首标签');
                this._scrollEditorToCursor(editor);
            } else {
                this.setStatus('当前行没有可撤回的标签');
            }
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
            const nvf = window.BeatUtils.noteValueFraction($bt('#beatTapperNoteValue').value);

            const targetTime = Math.max(0, window.BeatUtils.barBeatToTime(bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges, nvf));

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
        if (typeof window.openImportChangesModal !== 'function') {
            $bt('#beatTapperStatus').textContent = '❌ 导入弹窗未就绪';
            return;
        }
        window.openImportChangesModal((code) => {
            const result = window.BeatUtils.importChanges(code);
            if (!result) {
                window.showImportChangesErr('❌ 配置代码无效');
                return false;
            }
            this.tempoChanges = result.tempoChanges;
            this.meterChanges = result.meterChanges;
            this.renderTempoChanges();
            this.renderMeterChanges();
            $bt('#beatTapperStatus').textContent = `✅ 已导入 ${result.tempoChanges.length} 条变速、${result.meterChanges.length} 条变拍`;
            return true;
        });
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

    async loadLyric() {
        const filename = $bt('#beatTapperFile').value;
        const dirId = $bt('#beatTapperDir').value;
        if (!filename) {
            this.setStatus('❌ 请先选择音频文件');
            return;
        }

        const editor = $bt('#beatTapperEditor');
        if (editor.value.trim() && !confirm('编辑器中已有内容，载入将覆盖。是否继续？')) {
            return;
        }

        try {
            this.setStatus('正在载入歌词...');
            const resp = await fetch('/api/get-raw-lyric', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ filename, dir_id: dirId })
            });
            const data = await resp.json();

            if (!data.ok) {
                this.setStatus('❌ 载入失败: ' + (data.error || '未知错误'));
                return;
            }

            const { content, format } = data.data;
            if (!content || !format) {
                this.setStatus('⚠️ 未找到歌词文件（同名 .brc 或 .lrc）');
                return;
            }

            if (format === 'brc') {
                // BRC：保留原有节拍标签，直接载入方便调整
                editor.value = content;
                this.setStatus(`✅ 已载入 BRC 歌词（保留原有节拍标签）`);
            } else if (format === 'lrc') {
                // LRC：移除时间轴 [mm:ss.xx]，仅保留歌词文本
                const lines = content.split('\n');
                const stripped = lines.map(line => {
                    // 移除所有 [mm:ss.xx] 或 [mm:ss] 时间标签
                    return line.replace(/\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\]/g, '');
                });
                editor.value = stripped.join('\n');
                this.setStatus(`✅ 已载入 LRC 歌词（已移除时间轴，共 ${stripped.length} 行）`);
            } else {
                editor.value = content;
                this.setStatus(`✅ 已载入歌词文件（.${format}）`);
            }

            this.updateTapCount();
        } catch (e) {
            this.setStatus('❌ 载入失败: ' + e.message);
        }
    }

    /* ============================ 导出 LRC ============================ */

    /**
     * 将 BRC 内容（[小节:拍]歌词）转换为 LRC 内容（[mm:ss.xxx]歌词）
     * - 逐行模式：[bar:beat]歌词 → [mm:ss.xxx]歌词
     * - 卡拉OK模式：[bar:beat]<bar:beat>字<bar:beat>字 → [mm:ss.xxx]<mm:ss.xxx>字<mm:ss.xxx>字
     * - 空行：保留为空行（维持歌词结构）
     * - 有内容但无标签的行：跳过（在 LRC 中无意义）
     * @returns {string|null} LRC 文本；若没有节拍标签则返回 null
     */
    convertBRCToLRC(content) {
        const bpm = parseFloat($bt('#beatTapperBpm').value) || 120;
        const beatsPerBar = parseFloat($bt('#beatTapperBeatsPerBar').value) || 4;
        const zeroBar = parseFloat($bt('#beatTapperZeroBar').value) || 1;
        const zeroBeat = parseFloat($bt('#beatTapperZeroBeat').value) || 1;
        const nvf = window.BeatUtils.noteValueFraction($bt('#beatTapperNoteValue').value);
        const isKaraoke = $bt('#beatTapperKaraokeMode')?.checked;

        const lines = content.split('\n');
        const lineTagRegex = /^\[(\d+):([\d.]+)\]/;
        const result = [];
        let tagCount = 0;

        for (const line of lines) {
            const match = line.match(lineTagRegex);
            if (match) {
                const bar = parseInt(match[1]);
                const beat = parseFloat(match[2]);
                let time = window.BeatUtils.barBeatToTime(
                    bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges, nvf
                );
                if (!isFinite(time) || time < 0) time = 0;
                const lineHead = this.formatLrcTime(time);

                if (isKaraoke) {
                    // 逐字模式：扫描行内所有 <bar:beat>字 标签
                    const rest = line.substring(match[0].length);
                    let charPart = '';
                    let m;
                    const re = /<(\d+):([\d.]+)>([^<]*)/g;
                    while ((m = re.exec(rest)) !== null) {
                        const cBar = parseInt(m[1]);
                        const cBeat = parseFloat(m[2]);
                        const cText = m[3];
                        let cTime = window.BeatUtils.barBeatToTime(
                            cBar, cBeat, bpm, beatsPerBar, zeroBar, zeroBeat, this.tempoChanges, this.meterChanges, nvf
                        );
                        if (!isFinite(cTime) || cTime < 0) cTime = 0;
                        charPart += this.formatLrcTime(cTime).replace('[', '<').replace(']', '>') + cText;
                    }
                    // 兼容：整行没有逐字标签（通常模式写法 / 歌曲信息行）时，取整行剩余文本
                    result.push(lineHead + (charPart || rest));
                    tagCount++;
                } else {
                    const lyric = line.substring(match[0].length);
                    result.push(lineHead + lyric);
                    tagCount++;
                }
            } else if (line.trim() === '') {
                result.push('');
            }
            // 有内容但无标签的行：跳过
        }

        if (tagCount === 0) return null;
        return result.join('\n');
    }

    /**
     * 将秒数格式化为 LRC 时间标签 [mm:ss.xxx]（毫秒固定 3 位）
     */
    formatLrcTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const totalMs = Math.round(seconds * 1000);
        const m = Math.floor(totalMs / 60000);
        const s = Math.floor((totalMs % 60000) / 1000);
        const ms = totalMs % 1000;
        return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}]`;
    }

    openExportLrc() {
        const editor = $bt('#beatTapperEditor');
        const content = editor.value;
        if (!content.trim()) {
            this.setStatus('❌ 编辑器为空，无法导出 LRC');
            return;
        }

        const lrc = this.convertBRCToLRC(content);
        if (lrc === null) {
            this.setStatus('❌ 未找到节拍标签 [小节:拍]，请先打点');
            return;
        }

        this._exportedLrc = lrc;
        const filename = $bt('#beatTapperFile').value || 'lyric.txt';
        this._exportedLrcName = filename.replace(/\.[^.]+$/, '') + '.lrc';

        const hint = $bt('#exportLrcHint');
        const tagCount = (lrc.match(/^\[\d{2}:\d{2}\.\d{3}\]/gm) || []).length;
        const isKaraoke = $bt('#beatTapperKaraokeMode')?.checked;
        const charCount = isKaraoke ? (lrc.match(/<\d{2}:\d{2}\.\d{3}>/g) || []).length : 0;
        hint.textContent = isKaraoke
            ? `逐字模式 · 已转换 ${tagCount} 行 / ${charCount} 字标签 · 文件名：${this._exportedLrcName}`
            : `已转换 ${tagCount} 行节拍标签 · 文件名：${this._exportedLrcName}`;

        $bt('#exportLrcChoice').style.display = '';
        $bt('#exportLrcResult').style.display = 'none';
        $bt('#exportLrcModal').style.display = '';
        this.setStatus('✅ LRC 已生成，请选择导出方式');
    }

    downloadLRC() {
        if (!this._exportedLrc) return;
        const blob = new Blob([this._exportedLrc], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this._exportedLrcName || 'lyric.lrc';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.setStatus(`✅ LRC 已下载：${a.download}`);
        this.closeExportLrcModal();
    }

    async saveLrcToServer() {
        if (!this._exportedLrc) return;
        const filename = $bt('#beatTapperFile').value;
        const dirId = $bt('#beatTapperDir').value;
        if (!filename) {
            this.setStatus('❌ 请先选择音频文件');
            return;
        }
        const btn = $bt('#exportLrcSaveServer');
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 保存中...';
        try {
            const resp = await fetch('/api/save-lrc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    filename: filename,
                    dir_id: dirId,
                    content: this._exportedLrc
                })
            });
            const data = await resp.json();
            if (data.ok) {
                this.setStatus(`✅ LRC 已保存到音频同目录：${this._exportedLrcName}`);
                this.closeExportLrcModal();
            } else {
                this.setStatus('❌ 保存失败: ' + (data.error || '未知错误'));
            }
        } catch (e) {
            this.setStatus('❌ 保存失败: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = oldText;
        }
    }

    showLrcCopyResult() {
        if (!this._exportedLrc) return;
        $bt('#exportLrcCode').textContent = this._exportedLrc;
        $bt('#exportLrcChoice').style.display = 'none';
        $bt('#exportLrcResult').style.display = '';
        const btn = $bt('#exportLrcCopyBtn');
        btn.classList.remove('copied');
        btn.textContent = '📋';
    }

    async copyLrcToClipboard() {
        if (!this._exportedLrc) return;
        const btn = $bt('#exportLrcCopyBtn');
        const oldText = btn.textContent;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(this._exportedLrc);
            } else {
                const ta = document.createElement('textarea');
                ta.value = this._exportedLrc;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            btn.classList.add('copied');
            btn.textContent = '✅';
            this.setStatus('✅ LRC 已复制到剪贴板');
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = oldText;
            }, 1500);
        } catch (e) {
            this.setStatus('❌ 复制失败: ' + e.message);
        }
    }

    closeExportLrcModal() {
        $bt('#exportLrcModal').style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.beatTapper = new BeatTapper();
});