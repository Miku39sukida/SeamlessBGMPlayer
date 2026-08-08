(() => {
'use strict';

window.DEBUG_AUDIO = false;
const DLog = (...a) => { if (window.DEBUG_AUDIO) console.log('[AUDIO]', ...a); };

let audioCtx = null;
let masterGain = null;
let configGainNode = null;
let isPaused = false;
// 保存用户调节的主音量（0~1），确保重建 AudioContext 时恢复，避免开始播放/换歌时回满音量
let currentMasterVolume = 1.0;
let audioBuffer = null;
let audioCache = {};
let audioLoading = {};
let currentTrack = null;
let currentPlayingIdx = -1;   // 当前正在播放/暂停的曲目索引（用于列表右侧按钮状态同步）
const trackPreloadState = {}; // idx -> 'idle' | 'loading' | 'done'
let nextTrack = null;
let loopSchedulerTimer = null;
let rafId = null;
let config = { tracks: [] };
// 移动端检测：移动浏览器切后台时 setTimeout 会被节流到 1 秒
const IS_MOBILE_DEVICE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
let activeTrackCfg = null;
let beatsPerSec = 0;
let beatSec = 0;
let activeTrackNvf = 1;
let zeroAbsBeat = 0;
let startS = 0;
let loopStartS = 0;
let loopEndS = 0;
let loopDurS = 0;
let lyricEndS = 0;       // 歌词结束时间（秒），0=同 loopEndS
let effectiveLoopEndS = 0;  // 双轨模式下 = max(loopEndS, lyricEndS)
let effectiveLoopDurS = 0;  // 双轨模式下 = effectiveLoopEndS - loopStartS
let lyricGhostUntil = 0;     // 歌词幽灵期结束时间（audioCtx 秒），0=无幽灵期
let lyricGhostFrom = 0;      // 幽灵期起始位置（秒）
let lyricGhostStartCtx = 0;  // 幽灵期开始时的 audioCtx.currentTime
let audioDurS = 0;
let loopMode = 'single';
let fadeInS = 0;
let fadeOutS = 0;
let fadeOutStartS = 0;
let fadeOutAuto = true;
let jumpSegStartS = 0;
let jumpSegEndS = 0;
let jumpSegEnabled = false;
let loopPhase = 'main';
let lyricLines = [];
let activeLyricIndex = -1;
let tempoChanges = [];
let meterChanges = [];
let lastDesktopLyricLineIdx = -1;
let lastDesktopLyricSendTs = 0;
let desktopLyricHiddenTimer = null;
// 加载状态锁
let isLoadingTrack = false;
let loadingTrackIdx = -1;
// 循环跳转过渡位置（防止UI先跳到开头）
let transitionPos = null;
let transitionBase = null;
let transitionStartTime = null;
let lastLyricIndex = -1;

let currentStyleIdx = -1;
let styleTracks = {};
let styleSwitching = false;
let styleSwitchTimer = null; // 风格切换“完成”定时器（允许淡变中途重新定向时清除重设）
let multiStyleMode = false;

let extraTracks = [];
let extraTracksEnabled = false;

let endingEnabled = false;
let endingBuffer = null;
let endingGain = null;
let endingTrack = null;
let endingPlaying = false;

let introEnabled = false;
let introBuffer = null;
let introTrack = null;
let introPlaying = false;

let fullLoopEnabled = false;
let isFullLoopMode = false;
let fullLoopSwitching = false;

let loopSfxEnabled = false;
let loopSfxBuffer = null;
let loopSfxGain = null;

const $ = (id) => document.getElementById(id);

const fmtTime = (s) => {
    if (s == null || isNaN(s)) return '0:00.000';
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    return `${m}:${sec.toString().padStart(2,'0')}.${ms.toString().padStart(3,'0')}`;
};

const barBeat = (sec) => {
    if (!activeTrackCfg) return { bar: 0, beat: 0, abs: 0 };
    
    const bpm = activeTrackCfg.bpm;
    const beatsPerBar = activeTrackCfg.beats_per_bar;
    const zeroBar = activeTrackCfg.audio_zero_bar;
    const zeroBeat = activeTrackCfg.audio_zero_beat;
    
    const result = window.BeatUtils.timeToBarBeat(sec, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, activeTrackNvf);
    return result;
};

const secFromBarBeat = (bar, beat) => {
    if (!activeTrackCfg) return 0;
    
    const bpm = activeTrackCfg.bpm;
    const beatsPerBar = activeTrackCfg.beats_per_bar;
    const zeroBar = activeTrackCfg.audio_zero_bar;
    const zeroBeat = activeTrackCfg.audio_zero_beat;
    
    return window.BeatUtils.barBeatToTime(bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, activeTrackNvf);
};

// 静音保活：在 destination 上挂一个增益为 0 的循环静音源，让 AudioContext 始终处于
// 「有音频在跑」的状态，避免浏览器在页面空闲 / 切后台后把 context 自动 suspend，
// 否则遥控器后续命令又会因为 ctx 再次 suspended 而无声。
let keepAliveStarted = false;
const startKeepAlive = () => {
    if (keepAliveStarted || !audioCtx) return;
    keepAliveStarted = true;
    try {
        const buf = audioCtx.createBuffer(1, Math.max(1, Math.floor(audioCtx.sampleRate * 1)), audioCtx.sampleRate);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const g = audioCtx.createGain();
        g.gain.value = 0;
        src.connect(g);
        g.connect(audioCtx.destination);
        src.start(0);
        DLog('startKeepAlive: silent loop started');
    } catch (e) {
        DLog('startKeepAlive error:', e.message);
    }
};

const ensureCtx = () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = currentMasterVolume;
        masterGain.connect(audioCtx.destination);
        configGainNode = audioCtx.createGain();
        configGainNode.gain.value = 1.0;
        configGainNode.connect(masterGain);
        // context 一旦进入 running（无论因何种方式解锁），立即尝试把此前因无手势而延迟的播放补上
        audioCtx.onstatechange = () => {
            if (audioCtx && audioCtx.state === 'running') {
                startKeepAlive();
                runPendingBeginPlayback();
            }
        };
        DLog('ensureCtx: created new AudioContext');
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => startKeepAlive()).catch(e => DLog('ensureCtx: resume failed', e.message));
    }
    if (audioCtx.state === 'closed') {
        audioCtx = null;
        return ensureCtx();
    }
};

// 浏览器自动播放策略：AudioContext 必须在本页面发生用户手势后才能从 suspended 变 running。
// 从遥控器（其他页面 / 手机）发来的播放命令不是本页手势，直接调度音频会无声且进度冻结。
// 因此 playTrack 在调度前尝试让 context 进入 running；若超时仍未 running（纯手机遥控、本页尚无手势），
// 则登记待播放并提示用户在播放器页面点击解锁，解锁后由 attachAudioUnlock / onstatechange 立即补播。
const waitForAudioRunning = (timeoutMs = 600) => {
    return new Promise((resolve) => {
        if (!audioCtx) { resolve(); return; }
        if (audioCtx.state === 'running') { resolve(); return; }
        const start = Date.now();
        const timer = setInterval(() => {
            if (!audioCtx) { clearInterval(timer); resolve(); return; }
            if (audioCtx.state === 'running') { clearInterval(timer); resolve(); return; }
            if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(); return; }
        }, 80);
        // 若有手势已发生（例如用户刚点过本页面），resume 会立即生效
        audioCtx.resume().catch(() => {});
    });
};

// 在本页首次用户手势时解锁音频；同时隐藏「需要点击启用音频」提示。
// 若此前因无手势而延迟了播放（pendingBeginPlayback 已登记），解锁后立刻启动音频。
let audioUnlockAttached = false;
let pendingBeginPlayback = null;

// 统一的「补播」入口：清掉待播放标记并启动音频，多处（手势解锁 / onstatechange / 加载即解锁）共用
const runPendingBeginPlayback = () => {
    if (!pendingBeginPlayback) return;
    const fn = pendingBeginPlayback;
    pendingBeginPlayback = null;
    try { fn(); } catch (e) { DLog('pendingBeginPlayback err:', e.message); }
    hideAudioLockHint();
};

const attachAudioUnlock = () => {
    if (audioUnlockAttached) return;
    audioUnlockAttached = true;
    const handler = () => {
        ensureCtx();
        if (!audioCtx) return;
        if (audioCtx.state !== 'running') {
            audioCtx.resume().then(() => {
                runPendingBeginPlayback();
                hideAudioLockHint();
            }).catch(() => {});
        } else {
            runPendingBeginPlayback();
            hideAudioLockHint();
        }
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
        document.addEventListener(ev, handler, { passive: true }));
};

const showAudioLockHint = () => {
    const el = document.getElementById('audioLockHint');
    if (el) el.hidden = false;
};
const hideAudioLockHint = () => {
    const el = document.getElementById('audioLockHint');
    if (el) el.hidden = true;
};

const createTrack = (label) => ({
    label,
    source: null,
    gain: null,
    startedAtCtx: 0,
    startOffset: 0,
    stopScheduled: false,
    stopAtCtx: 0,
    envelopeEndsAtCtx: 0,
});

const safeCleanupTrackForce = (track) => {
    if (!track) return;
    try { if (track.source) { track.source.disconnect(); } } catch(_){}
    try { if (track.gain) track.gain.disconnect(); } catch(_){}
    track.source = null;
    track.gain = null;
};

const safeCleanupTrack = (track, extraBufferMs = 0) => {
    if (!track) return;
    const now = audioCtx ? audioCtx.currentTime : 0;
    let waitMs;
    const naturalEnd = track.startedAtCtx + Math.max(0, audioDurS - track.startOffset);
    const hasExplicitStop = (track.stopAtCtx || 0) > 0;
    const hasExplicitEnvelope = (track.envelopeEndsAtCtx || 0) > 0;
    let latest;
    if (hasExplicitStop || hasExplicitEnvelope) {
        latest = Math.max(track.envelopeEndsAtCtx || 0, track.stopAtCtx || 0);
    } else {
        latest = naturalEnd;
    }
    if (latest > now) {
        waitMs = Math.ceil((latest - now) * 1000) + 700 + extraBufferMs;
    } else {
        waitMs = 700 + extraBufferMs;
    }
    if (waitMs < 100) waitMs = 100;
    DLog(`safeCleanup track[${track.label}]: wait=${waitMs}ms explicitStop=${hasExplicitStop} explicitEnv=${hasExplicitEnvelope} envEnd=${(track.envelopeEndsAtCtx||0).toFixed(3)} stopAt=${(track.stopAtCtx||0).toFixed(3)} naturalEnd=${naturalEnd.toFixed(3)} latest=${latest.toFixed(3)}`);
    setTimeout(() => {
        try {
            const checkEnvelope = hasExplicitEnvelope || hasExplicitStop;
            if (track.gain && typeof track.gain.gain?.value === 'number' && checkEnvelope) {
                const gv = track.gain.gain.value;
                DLog(`cleanup[${track.label}] final gain.value=${gv.toFixed(5)}`);
                if (gv > 0.006) {
                    DLog(`  gain not faded, retrying +500ms`);
                    setTimeout(() => safeCleanupTrackForce(track), 550);
                    return;
                }
            } else if (track.gain) {
                DLog(`cleanup[${track.label}] skip gain check (no explicit stop/envelope; keep until natural)`);
            }
        } catch(_){}
        safeCleanupTrackForce(track);
    }, waitMs);
};

const scheduleStopWithEnvelope = (track, stopAtCtx) => {
    if (!track || !track.source || !track.gain || track.stopScheduled) return;
    track.stopScheduled = true;
    track.stopAtCtx = stopAtCtx;
    try {
        track.source.stop(Math.max(stopAtCtx + 0.001, audioCtx.currentTime + 0.001));
    } catch (e) {
        try { track.source.stop(); } catch(_){}
    }
    safeCleanupTrack(track);
};

let _guardOnended = (track, label) => {
    if (!track || !track.source) return;
    try {
        track.source.onended = () => {
            const raw = getRawPlaybackPos(track);
            DLog(`[onended] track[${track.label}] ${label} source ended naturally; raw=${raw.toFixed(3)} audioDur=${(audioDurS||0).toFixed(3)} stopSched=${track.stopScheduled}`);
            if (track === currentTrack && !track.stopScheduled) {
                if (loopBroken) {
                    DLog(`  → loopBroken, natural end → stopAll`);
                    stopAll();
                } else {
                    DLog(`  → currentTrack ended without explicit stop; force jump now`);
                    if (loopMode === 'single') doSingleJump();
                    else doDualSwitch();
                }
            }
        };
    } catch(_) {}
};

const playSegmentAt = (track, startOffsetSec, startAtCtx, opts = {}) => {
    const buf = opts.buffer || audioBuffer;
    if (!buf) {
        DLog('playSegmentAt: buffer is null!');
        return false;
    }
    const connectTo = opts.connectTo || configGainNode || masterGain;
    if (track.source) {
        try { track.source.onended = null; } catch(_){}
        try { if (!track.stopScheduled) { try { track.source.stop(); } catch(_){} } } catch(_){}
        try { track.source.disconnect(); } catch(_){}
        if (track.gain) try { track.gain.disconnect(); } catch(_){}
    }
    track.source = audioCtx.createBufferSource();
    track.source.buffer = buf;
    if (opts.enableLoop) {
        track.source.loop = true;
        track.source.loopStart = opts.loopStart != null ? opts.loopStart : loopStartS;
        track.source.loopEnd = opts.loopEnd != null ? opts.loopEnd : loopEndS;
    } else {
        track.source.loop = false;
    }
    track.gain = audioCtx.createGain();
    track.gain.gain.value = opts.initialGain != null ? opts.initialGain : 1.0;
    track.source.connect(track.gain);
    track.gain.connect(connectTo);

    let actualStartAt = startAtCtx;
    let actualOffset = startOffsetSec;
    const now = audioCtx ? audioCtx.currentTime : 0;
    if (actualStartAt < now + 0.0005) {
        const lateBy = now - actualStartAt;
        if (lateBy > 0 && lateBy < 30) {
            actualOffset = Math.min((buf.duration || 0) - 0.05, actualOffset + lateBy);
            if (actualOffset < 0) actualOffset = 0;
            DLog(`playSegmentAt: startAtCtx late ${(lateBy*1000).toFixed(0)}ms; advance offset by late; start NOW offset=${actualOffset.toFixed(4)}`);
        } else if (lateBy >= 30) {
            DLog(`playSegmentAt: startAtCtx EXTREMELY late (${lateBy.toFixed(1)}s); ignore offset adjust, clamp`);
        }
        actualStartAt = now + 0.002;
    }

    track.startedAtCtx = actualStartAt;
    track.startOffset = actualOffset;
    track.stopScheduled = false;
    track.stopAtCtx = 0;
    track.envelopeEndsAtCtx = 0;
    try {
        track.source.start(actualStartAt, actualOffset);
        _guardOnended(track, 'playSegmentAt');
        if (opts.stopAtCtx != null) scheduleStopWithEnvelope(track, opts.stopAtCtx);
    } catch (e) {
        DLog('playSegmentAt start() threw:', e.message, '; retry with NOW start');
        try {
            track.startedAtCtx = audioCtx.currentTime + 0.002;
            track.startOffset = Math.max(0, Math.min((buf.duration||0)-0.05, actualOffset));
            track.source.start(track.startedAtCtx, track.startOffset);
            _guardOnended(track, 'playSegmentAt-retry');
            if (opts.stopAtCtx != null) scheduleStopWithEnvelope(track, opts.stopAtCtx);
        } catch (e2) {
            DLog('playSegmentAt retry also failed:', e2.message);
            return false;
        }
    }
    return true;
};

const currentPlaySec = () => {
    if (!currentTrack || !currentTrack.source) return 0;
    const ctxNow = audioCtx.currentTime;

    // 歌词幽灵期：从 switchAtCtx 开始，到 effectiveLoopEndS 对应时间结束
    // 在 switchAtCtx 之前不触发幽灵期（避免负值导致位置倒退）
    if (lyricGhostUntil > 0 && ctxNow >= lyricGhostStartCtx && ctxNow < lyricGhostUntil) {
        const ghostElapsed = ctxNow - lyricGhostStartCtx;
        const ghostPos = lyricGhostFrom + ghostElapsed;
        // 达到 effectiveLoopEndS 后不再 ghost
        if (ghostPos < effectiveLoopEndS) {
            return ghostPos;
        }
        lyricGhostUntil = 0;  // 幽灵期结束
    }

    if (ctxNow < currentTrack.startedAtCtx) {
        if (transitionBase != null && transitionStartTime != null) {
            return transitionBase + (ctxNow - transitionStartTime);
        }
        if (transitionPos != null) {
            return transitionPos;
        }
        return 0;
    }
    transitionPos = null;
    transitionBase = null;
    transitionStartTime = null;
    const raw = ctxNow - currentTrack.startedAtCtx + currentTrack.startOffset;
    // 始终用 effectiveLoopEndS 包裹（双轨模式且设置了歌词结束拍时）
    // 这样歌词 54-57 始终可达，不会被循环截断
    const useEffective = (loopMode === 'dual' && lyricEndS > loopEndS);
    const wrapEnd = useEffective ? effectiveLoopEndS : loopEndS;
    const wrapDur = useEffective ? effectiveLoopDurS : loopDurS;
    if (wrapDur > 0 && raw >= loopStartS) {
        const into = (raw - loopStartS) % wrapDur;
        return loopStartS + into;
    }
    return Math.max(0, raw);
};

const getRawPlaybackPos = (track) => {
    if (!track || !track.source) return 0;
    return Math.max(0, audioCtx.currentTime - track.startedAtCtx + track.startOffset);
};

const scheduleNextLoop = () => {
    if (!currentTrack || !audioCtx) return;
    // 暂停期间不调度循环边界（上下文已 suspend，时钟冻结，恢复后统一重启）
    if (isPaused) return;
    // 原生循环模式（移动端）：source.loop = true 时由 Web Audio API 音频线程
    // 自行处理循环，完全不依赖 setTimeout，免疫后台节流
    if (currentTrack.source && currentTrack.source.loop) {
        // 同步最新循环点到 source（用户可能调整了循环设置）
        try {
            currentTrack.source.loopStart = loopStartS;
            currentTrack.source.loopEnd = loopEndS;
        } catch(_) {}
        return;
    }
    clearTimeout(loopSchedulerTimer);

    const now = audioCtx.currentTime;
    const raw = getRawPlaybackPos(currentTrack);

    let sLoopStart = loopStartS;
    let sLoopEnd = loopEndS;
    let sLoopDur = loopDurS;
    // 音频调度始终使用 loopEndS/loopDurS —— 音频正常循环，不受歌词结束拍影响
    // 歌词显示由 currentPlaySec() 的幽灵期机制独立处理
    let sDuration = audioDurS || 0;
    let sJumpStart = jumpSegStartS;
    let sJumpEnd = jumpSegEndS;
    if (multiStyleMode) {
        const entry = styleTracks[currentStyleIdx];
        if (entry) {
            sLoopStart = entry.loopStartS || loopStartS;
            sLoopEnd = entry.loopEndS || loopEndS;
            sLoopDur = Math.max(0.01, sLoopEnd - sLoopStart);
            sDuration = entry.duration || audioDurS || 0;
            if (jumpSegEnabled) {
                sJumpStart = Math.max(0, jumpSegStartS + entry.offsetDiff);
                sJumpEnd = Math.max(0, jumpSegEndS + entry.offsetDiff);
            }
        }
    }

    const nearAudioEnd = sDuration > 0 && raw >= sDuration - 0.08;
    let distToEnd;
    if (jumpSegEnabled && loopPhase === 'seg') {
        distToEnd = sJumpEnd - raw;
    } else {
        if (raw < sLoopStart + 0.0001) {
            distToEnd = sLoopEnd - raw;
        } else {
            let into = (raw - sLoopStart) % sLoopDur;
            if (into < 0) into += sLoopDur;
            distToEnd = sLoopDur - into;
        }
    }

    if (nearAudioEnd) {
        DLog(`scheduleNextLoop: raw near/over audio end (${raw.toFixed(3)} / ${sDuration.toFixed(3)}); force jump now`);
        distToEnd = 0.002;
    }
    if (distToEnd < 0) distToEnd = 0.002;
    const safetyLimit = sDuration - raw - 0.05;
    if (safetyLimit > 0.01 && distToEnd > safetyLimit) {
        DLog(`scheduleNextLoop: safety clamp distToEnd from ${distToEnd.toFixed(3)}s to ${safetyLimit.toFixed(3)}s (near audio end)`);
        distToEnd = safetyLimit;
    }
    if (distToEnd < 0.002) distToEnd = 0.002;

    // 移动端切后台时 setTimeout 会被节流到 1 秒，需要更大的 lookAhead 留出余量。
    // 桌面端保持 180ms（无节流问题，更紧凑的调度）。
    // doSingleJump 被提前调用是安全的：它用 audioCtx.currentTime 精确调度新音频源，
    // transition 逻辑保证 UI 时间轴正确，旧音频源的淡出仍在对的时间点发生。
    const baseLookAhead = IS_MOBILE_DEVICE ? 1.5 : 0.18;
    const lookAhead = fadeOutS > 0.0002 ? Math.max(baseLookAhead, fadeOutS + 0.1) : baseLookAhead;
    let triggerDelayMs = (distToEnd - lookAhead) * 1000;
    if (nearAudioEnd || distToEnd <= lookAhead + 0.001) triggerDelayMs = 1;
    if (triggerDelayMs < 1) triggerDelayMs = 1;

    DLog(`scheduleNextLoop[${loopMode} phase=${loopPhase} style=${currentStyleIdx}]: raw=${raw.toFixed(3)} distToEnd=${distToEnd.toFixed(3)} lookAhead=${(lookAhead*1000).toFixed(0)}ms delay=${triggerDelayMs.toFixed(0)}ms nearEnd=${nearAudioEnd}`);

    loopSchedulerTimer = setTimeout(() => {
        if (multiStyleMode) {
            if (loopMode === 'single') doSingleJumpMultiStyle();
            else doDualSwitchMultiStyle();
        } else {
            if (loopMode === 'single') doSingleJump();
            else doDualSwitch();
        }
    }, triggerDelayMs);
};

const syncExtraTracksOnJump = (targetOffset, fadeStartAtCtx, fadeEndAtCtx, xfadeS) => {
    if (!extraTracksEnabled || !activeTrackCfg) return;
    const timePerBeat = 60.0 / activeTrackCfg.bpm * activeTrackNvf;
    const defZeroOffset = ((activeTrackCfg.audio_zero_bar - 1) * (activeTrackCfg.beats_per_bar || 4) + (activeTrackCfg.audio_zero_beat - 1)) * timePerBeat;
    extraTracks.forEach(et => {
        if (!et.buffer || !et.gain) return;
        const azb = et.audio_zero_bar != null ? et.audio_zero_bar : activeTrackCfg.audio_zero_bar || 1;
        const azbt = et.audio_zero_beat != null ? et.audio_zero_beat : activeTrackCfg.audio_zero_beat || 1;
        const zOffset = ((azb - 1) * (activeTrackCfg.beats_per_bar || 4) + (azbt - 1)) * timePerBeat;
        const offsetDiff = defZeroOffset - zOffset;
        const trackTarget = Math.max(0, targetOffset + offsetDiff);

        const newTrk = createTrack('et-' + (et.name || 'next'));
        const ok = playSegmentAt(newTrk, trackTarget, fadeStartAtCtx, {
            enableLoop: false,
            initialGain: 0.0,
            buffer: et.buffer,
            connectTo: et.gain,
        });
        if (!ok) return;

        // 关键：循环跳变重建额外轨道时，必须沿用 et.muted（与 et.volume）决定目标增益，
        // 否则静音的混音轨道会在每次循环后被重新唤醒出声，导致播放器声音与遥控端静音状态不同步。
        const etTargetGain = et.muted ? 0.0 : (et.volume != null ? et.volume : 1.0);
        try {
            newTrk.gain.gain.cancelScheduledValues(fadeStartAtCtx);
            newTrk.gain.gain.setValueAtTime(0.0, fadeStartAtCtx);
            newTrk.gain.gain.linearRampToValueAtTime(etTargetGain, fadeEndAtCtx);
        } catch(e) {}

        if (et.track && et.track.gain) {
            try {
                et.track.gain.gain.cancelScheduledValues(fadeStartAtCtx);
                et.track.gain.gain.setValueAtTime(et.track.gain.gain.value, fadeStartAtCtx);
                et.track.gain.gain.linearRampToValueAtTime(0.0, fadeEndAtCtx);
            } catch(e) {}
            et.track.stopScheduled = true;
            et.track.stopAtCtx = fadeEndAtCtx + 0.0005;
            try { if (et.track.source) et.track.source.stop(et.track.stopAtCtx); } catch(_) {}
            safeCleanupTrack(et.track);
        }
        newTrk.offsetDiff = offsetDiff;
        et.track = newTrk;
    });
    // 循环跳变后主动重推一次状态，确保遥控端混音静音标记与播放器实际增益重新对齐
    rcBroadcastState();
};

const MIN_XFADE_S = 0.002;

const doSingleJumpMultiStyle = () => {
    try {
        const activeEntry = styleTracks[currentStyleIdx];
        if (!activeEntry || !activeEntry.current) {
            DLog('doSingleJumpMultiStyle: no active entry');
            scheduleNextLoop();
            return;
        }
        const now = audioCtx.currentTime;
        const raw = getRawPlaybackPos(activeEntry.current);

        const sLoopStart = activeEntry.loopStartS || loopStartS;
        const sLoopEnd = activeEntry.loopEndS || loopEndS;
        const sLoopDur = Math.max(0.01, sLoopEnd - sLoopStart);
        const offsetDiff = activeEntry.offsetDiff || 0;
        const sJumpStart = jumpSegEnabled ? Math.max(0, jumpSegStartS + offsetDiff) : 0;
        const sJumpEnd = jumpSegEnabled ? Math.max(0, jumpSegEndS + offsetDiff) : 0;

        let remainingToEnd;
        let isFirst = false;
        let targetOffset;
        let nextPhase = loopPhase;

        if (jumpSegEnabled && loopPhase === 'seg') {
            remainingToEnd = sJumpEnd - raw;
            if (remainingToEnd < 0.002) remainingToEnd = 0.002;
            targetOffset = loopStartS;
            nextPhase = 'main';
        } else {
            if (raw < sLoopStart + 0.0001) {
                remainingToEnd = sLoopEnd - raw;
                isFirst = true;
            } else {
                let into = (raw - sLoopStart) % sLoopDur;
                if (into < 0) into += sLoopDur;
                remainingToEnd = sLoopDur - into;
            }
            if (remainingToEnd < 0.002) remainingToEnd = 0.002;
            if (jumpSegEnabled) {
                targetOffset = jumpSegStartS;
                nextPhase = 'seg';
            } else {
                targetOffset = loopStartS;
                nextPhase = 'main';
            }
        }
        if (remainingToEnd > 3600) remainingToEnd = 0.18;

        const switchAtCtx = now + remainingToEnd;
        const xfadeS = Math.max(MIN_XFADE_S,
            Math.max(0, +fadeInS || 0),
            Math.max(0, +fadeOutS || 0));
        const fadeStartAtCtx = Math.max(audioCtx.currentTime + 0.0005, switchAtCtx - xfadeS * 0.5);
        const fadeEndAtCtx = fadeStartAtCtx + xfadeS;

        for (const sIdx in styleTracks) {
            const entry = styleTracks[sIdx];
            if (!entry.current || !entry.next) continue;
            const sTargetOffset = Math.max(0, targetOffset + entry.offsetDiff);

            const prevTrack = entry.current;
            const newTrack = entry.next;

            if (prevTrack.gain && prevTrack.source) {
                try {
                    prevTrack.gain.gain.cancelScheduledValues(fadeStartAtCtx);
                    try { prevTrack.gain.gain.setValueAtTime(prevTrack.gain.gain.value, fadeStartAtCtx); } catch(_){}
                    prevTrack.gain.gain.linearRampToValueAtTime(0.0, fadeEndAtCtx);
                    prevTrack.envelopeEndsAtCtx = Math.max(prevTrack.envelopeEndsAtCtx || 0, fadeEndAtCtx);
                } catch(e) {}
            }
            prevTrack.stopScheduled = true;
            prevTrack.stopAtCtx = fadeEndAtCtx + 0.0005;
            try { if (prevTrack.source) prevTrack.source.stop(prevTrack.stopAtCtx); } catch(_) {}

            const ok = playSegmentAt(newTrack, sTargetOffset, fadeStartAtCtx, {
                enableLoop: false,
                initialGain: 0.0,
                buffer: entry.buffer,
                connectTo: entry.styleGain,
            });

            if (ok && newTrack.gain) {
                try {
                    newTrack.gain.gain.cancelScheduledValues(fadeStartAtCtx);
                    newTrack.gain.gain.setValueAtTime(0.0, fadeStartAtCtx);
                    newTrack.gain.gain.linearRampToValueAtTime(1.0, fadeEndAtCtx);
                    newTrack.envelopeEndsAtCtx = Math.max(newTrack.envelopeEndsAtCtx || 0, fadeEndAtCtx);
                } catch(e) {}
            }

            entry.current = newTrack;
            entry.next = prevTrack;
            safeCleanupTrack(prevTrack);
        }

        const ae = styleTracks[currentStyleIdx];
        currentTrack = ae.current;
        nextTrack = ae.next;
        loopPhase = nextPhase;

        DLog(`MULTI SINGLE XFADE JUMP${isFirst ? ' [FIRST]' : ''}: raw=${raw.toFixed(3)} rem=${remainingToEnd.toFixed(4)}s xfade=${(xfadeS*1000).toFixed(1)}ms → target=${targetOffset.toFixed(4)} (${Object.keys(styleTracks).length} styles swapped)`);

        syncExtraTracksOnJump(targetOffset, fadeStartAtCtx, fadeEndAtCtx, xfadeS);

        const curOffsetDiff = activeEntry.offsetDiff || 0;
        transitionBase = raw;
        transitionStartTime = audioCtx.currentTime;
        transitionPos = Math.max(0, targetOffset + curOffsetDiff);
    } catch (e) {
        DLog('doSingleJumpMultiStyle FATAL:', e.message, e.stack);
    }
    scheduleNextLoop();
};

const doDualSwitchMultiStyle = () => {
    try {
        const activeEntry = styleTracks[currentStyleIdx];
        if (!activeEntry || !activeEntry.current) {
            DLog('doDualSwitchMultiStyle: no active entry');
            scheduleNextLoop();
            return;
        }
        const now = audioCtx.currentTime;
        const raw = getRawPlaybackPos(activeEntry.current);
        const sDuration = activeEntry.duration || audioDurS || 0;
        const nearAudioEnd = sDuration > 0 && raw >= sDuration - 0.1;

        const sLoopStart = activeEntry.loopStartS || loopStartS;
        const sLoopEnd = activeEntry.loopEndS || loopEndS;
        const sLoopDur = Math.max(0.01, sLoopEnd - sLoopStart);
        // 音频调度始终使用 loopEndS —— 歌词显示由幽灵期机制处理

        let remainingToEnd;
        let isFirst = false;
        if (raw < sLoopStart + 0.0001) {
            remainingToEnd = sLoopEnd - raw;
            isFirst = true;
        } else {
            let into = (raw - sLoopStart) % sLoopDur;
            if (into < 0) into += sLoopDur;
            remainingToEnd = sLoopDur - into;
        }
        if (nearAudioEnd) remainingToEnd = 0.05;
        if (remainingToEnd < 0.002) remainingToEnd = 0.002;

        if (fadeOutS > 0.0002) {
            if (remainingToEnd < fadeOutS + 0.002) remainingToEnd = fadeOutS + 0.002;
            if (remainingToEnd > 3600) remainingToEnd = fadeOutS + 0.18;
        } else {
            if (remainingToEnd > 3600) remainingToEnd = 0.18;
        }

        const switchAtCtx = now + remainingToEnd;

        for (const sIdx in styleTracks) {
            const entry = styleTracks[sIdx];
            if (!entry.current || !entry.next) continue;
            const sLoopStart = entry.loopStartS;
            const sFadeOutStartS = fadeOutStartS + entry.offsetDiff;
            const sDuration = entry.duration;

            const prevTrack = entry.current;
            const newTrack = entry.next;

            const oldGain = prevTrack.gain;
            let fadeStartAtCtx = 0;
            let fadeEndAtCtx = 0;
            if (oldGain && audioCtx && fadeOutS > 0.0002) {
                const timeUntilFade = sFadeOutStartS - raw;
                if (nearAudioEnd || timeUntilFade <= -fadeOutS) {
                    fadeStartAtCtx = now + 0.0001;
                    fadeEndAtCtx = now + fadeOutS + 0.0002;
                } else {
                    fadeStartAtCtx = now + Math.max(0, timeUntilFade);
                    fadeEndAtCtx = fadeStartAtCtx + fadeOutS;
                }
                try {
                    const fs = Math.max(audioCtx.currentTime + 0.0005, fadeStartAtCtx);
                    const fe = Math.max(fs + 0.0001, fadeEndAtCtx);
                    oldGain.gain.cancelScheduledValues(fs);
                    try { oldGain.gain.setValueAtTime(oldGain.gain.value, fs); } catch(_){}
                    oldGain.gain.linearRampToValueAtTime(0.0, fe);
                    prevTrack.envelopeEndsAtCtx = Math.max(prevTrack.envelopeEndsAtCtx || 0, fe);
                } catch(e) {}
            }

            let newStartGain = (fadeInS > 0.0002) ? 0.0 : 1.0;
            const ok = playSegmentAt(newTrack, sLoopStart, switchAtCtx, {
                enableLoop: false,
                initialGain: newStartGain,
                buffer: entry.buffer,
                connectTo: entry.styleGain,
            });

            if (ok && fadeInS > 0.0002 && newTrack.gain) {
                try {
                    const gs = Math.max(audioCtx.currentTime + 0.002, newTrack.startedAtCtx);
                    newTrack.gain.gain.cancelScheduledValues(gs);
                    newTrack.gain.gain.setValueAtTime(0.0, gs);
                    newTrack.gain.gain.linearRampToValueAtTime(1.0, gs + fadeInS);
                    newTrack.envelopeEndsAtCtx = Math.max(newTrack.envelopeEndsAtCtx || 0, gs + fadeInS);
                } catch(e) {}
            }

            prevTrack.stopScheduled = true;
            prevTrack.stopAtCtx = 0;
            const naturalEndCtx = prevTrack.startedAtCtx + Math.max(0, sDuration - prevTrack.startOffset);
            const cleanupAfterCtx = Math.max(prevTrack.envelopeEndsAtCtx || 0, fadeEndAtCtx || 0, naturalEndCtx);
            safeCleanupTrack(prevTrack);

            entry.current = newTrack;
            entry.next = prevTrack;
        }

        const ae = styleTracks[currentStyleIdx];
        currentTrack = ae.current;
        nextTrack = ae.next;
        // 设置歌词幽灵期：以 switchAtCtx 为基准对齐，避免累积偏差
        if (loopMode === 'dual' && lyricEndS > loopEndS) {
            const ghostDuration = effectiveLoopEndS - loopEndS;
            lyricGhostUntil = switchAtCtx + ghostDuration;
            lyricGhostFrom = Math.min(raw + remainingToEnd, loopEndS);
            lyricGhostStartCtx = switchAtCtx;
        } else {
            lyricGhostUntil = 0;
        }

        const switchRawSec = raw + remainingToEnd;
        const bb = barBeat(switchRawSec);
        DLog(`MULTI DUAL SWITCH${isFirst ? ' [FIRST]' : ''}: raw=${raw.toFixed(3)} rem=${remainingToEnd.toFixed(4)}s → ${bb.bar}:${bb.beat} (${Object.keys(styleTracks).length} styles swapped)`);
        const aeFirst = styleTracks[currentStyleIdx];
        const vFadeEnd2 = aeFirst.current.envelopeEndsAtCtx || (aeFirst.current.startedAtCtx + Math.max(fadeInS, fadeOutS));

        const dsXfadeS = Math.max(fadeInS, fadeOutS);
        const dsMFadeStart = switchAtCtx - dsXfadeS * 0.5;
        const dsMFadeEnd = switchAtCtx + dsXfadeS * 0.5;
        syncExtraTracksOnJump(loopStartS, dsMFadeStart, dsMFadeEnd, dsXfadeS);

        const curOffsetD = aeFirst.offsetDiff || 0;
        transitionBase = Math.min(raw + remainingToEnd, loopEndS);
        transitionStartTime = switchAtCtx;
        transitionPos = Math.max(0, loopStartS + curOffsetD);
    } catch (e) {
        DLog('doDualSwitchMultiStyle FATAL:', e.message, e.stack);
    }
    scheduleNextLoop();
};

const doSingleJump = () => {
    if (!currentTrack || !audioCtx || !audioBuffer) {
        DLog('doSingleJump: abort (no currentTrack/audioCtx/audioBuffer)');
        scheduleNextLoop();
        return;
    }

    if (multiStyleMode) {
        doSingleJumpMultiStyle();
        return;
    }

    let prevTrack = null;
    let newTrack = null;
    try {
        const now = audioCtx.currentTime;
        const raw = getRawPlaybackPos(currentTrack);

        let remainingToEnd;
        let isFirst = false;
        let targetOffset;
        let nextPhase = loopPhase;

        if (jumpSegEnabled && loopPhase === 'seg') {
            remainingToEnd = jumpSegEndS - raw;
            if (remainingToEnd < 0.002) remainingToEnd = 0.002;
            targetOffset = loopStartS;
            nextPhase = 'main';
            DLog(`  seg-phase: raw=${raw.toFixed(3)} segEnd=${jumpSegEndS.toFixed(3)} rem=${remainingToEnd.toFixed(4)}`);
        } else {
            if (raw < loopStartS + 0.0001) {
                remainingToEnd = loopEndS - raw;
                isFirst = true;
                DLog(`  main-phase FIRST: raw=${raw.toFixed(3)} < loopStart=${loopStartS.toFixed(3)}; rem to loopEnd=${loopEndS.toFixed(3)} = ${remainingToEnd.toFixed(4)}`);
            } else {
                let into = (raw - loopStartS) % loopDurS;
                if (into < 0) into += loopDurS;
                remainingToEnd = loopDurS - into;
                DLog(`  main-phase LOOP: raw=${raw.toFixed(3)} into loop=${into.toFixed(3)} rem=${remainingToEnd.toFixed(4)} loopDur=${loopDurS.toFixed(3)}`);
            }
            if (remainingToEnd < 0.002) remainingToEnd = 0.002;
            if (jumpSegEnabled) {
                targetOffset = jumpSegStartS;
                nextPhase = 'seg';
            } else {
                targetOffset = loopStartS;
                nextPhase = 'main';
            }
        }
        if (remainingToEnd > 3600) {
            DLog(`  WARNING: remainingToEnd huge (${remainingToEnd.toFixed(2)}s); clamp to lookAhead`);
            remainingToEnd = 0.18;
        }

        const switchAtCtx = now + remainingToEnd;
        prevTrack = currentTrack;
        newTrack = nextTrack || createTrack('B');
        nextTrack = prevTrack;

        const xfadeS = Math.max(MIN_XFADE_S,
            Math.max(0, +fadeInS || 0),
            Math.max(0, +fadeOutS || 0));
        const fadeStartAtCtx = Math.max(audioCtx.currentTime + 0.0005, switchAtCtx - xfadeS * 0.5);
        const fadeEndAtCtx = fadeStartAtCtx + xfadeS;

        if (prevTrack.gain && prevTrack.source) {
            try {
                const fs = fadeStartAtCtx;
                const fe = fadeEndAtCtx;
                prevTrack.gain.gain.cancelScheduledValues(fs);
                try { prevTrack.gain.gain.setValueAtTime(prevTrack.gain.gain.value, fs); } catch(_){}
                prevTrack.gain.gain.linearRampToValueAtTime(0.0, fe);
                prevTrack.envelopeEndsAtCtx = Math.max(prevTrack.envelopeEndsAtCtx || 0, fe);
            } catch(e) { DLog('prev xfade err', e.message); }
        }
        prevTrack.stopScheduled = true;
        prevTrack.stopAtCtx = fadeEndAtCtx + 0.0005;
        try {
            if (prevTrack.source) prevTrack.source.stop(prevTrack.stopAtCtx);
        } catch(_) {}

        const ok = playSegmentAt(newTrack, targetOffset, fadeStartAtCtx, {
            enableLoop: false,
            initialGain: 0.0,
        });
        if (!ok) {
            DLog('  playSegmentAt FAILED; retry start NOW');
            const retry = playSegmentAt(newTrack, targetOffset, audioCtx.currentTime + 0.003, {
                enableLoop: false,
                initialGain: 0.0,
            });
            if (!retry) {
                DLog('  retry also FAILED; restore prevTrack as currentTrack');
                currentTrack = prevTrack;
                nextTrack = newTrack;
                scheduleNextLoop();
                return;
            }
        }

        if (newTrack.gain) {
            try {
                const gs = fadeStartAtCtx;
                const ge = fadeEndAtCtx;
                newTrack.gain.gain.cancelScheduledValues(gs);
                newTrack.gain.gain.setValueAtTime(0.0, gs);
                newTrack.gain.gain.linearRampToValueAtTime(1.0, ge);
                newTrack.envelopeEndsAtCtx = Math.max(newTrack.envelopeEndsAtCtx || 0, ge);
            } catch(e) { DLog('new xfade err', e.message); }
        }

        const prevPhase = loopPhase;
        loopPhase = nextPhase;
        DLog(`SINGLE XFADE JUMP${isFirst ? ' [FIRST]' : ''} phase ${prevPhase}→${nextPhase}: raw=${raw.toFixed(3)} rem=${remainingToEnd.toFixed(4)}s switchAt=${switchAtCtx.toFixed(4)} xfade=${(xfadeS*1000).toFixed(1)}ms → target=${targetOffset.toFixed(4)}`);
        safeCleanupTrack(prevTrack);

        syncExtraTracksOnJump(targetOffset, fadeStartAtCtx, fadeEndAtCtx, xfadeS);

        transitionBase = raw;
        transitionStartTime = audioCtx.currentTime;
        transitionPos = targetOffset;
        currentTrack = newTrack;
    } catch (e) {
        DLog('doSingleJump FATAL:', e.message, e.stack);
    }
    scheduleNextLoop();
};

const doDualSwitch = () => {
    if (!currentTrack || !audioCtx || !audioBuffer) {
        DLog('doDualSwitch: abort (no currentTrack/audioCtx/audioBuffer)');
        scheduleNextLoop();
        return;
    }

    if (multiStyleMode) {
        doDualSwitchMultiStyle();
        return;
    }

    let prevTrack = null;
    let newTrack = null;
    try {
        const now = audioCtx.currentTime;
        const raw = getRawPlaybackPos(currentTrack);
        const nearAudioEnd = audioDurS > 0 && raw >= audioDurS - 0.1;

        let remainingToEnd;
        let isFirst = false;
        // 音频调度始终使用 loopEndS/loopDurS —— 音频正常循环
        // 歌词显示由幽灵期机制独立处理
        if (raw < loopStartS + 0.0001) {
            remainingToEnd = loopEndS - raw;
            isFirst = true;
        } else {
            let into = (raw - loopStartS) % loopDurS;
            if (into < 0) into += loopDurS;
            remainingToEnd = loopDurS - into;
        }
        if (nearAudioEnd) remainingToEnd = 0.05;
        if (remainingToEnd < 0.002) remainingToEnd = 0.002;
        
        if (fadeOutS > 0.0002) {
            if (remainingToEnd < fadeOutS + 0.002) remainingToEnd = fadeOutS + 0.002;
            if (remainingToEnd > 3600) remainingToEnd = fadeOutS + 0.18;
        } else {
            if (remainingToEnd > 3600) remainingToEnd = 0.18;
        }

        const switchAtCtx = now + remainingToEnd;

        prevTrack = currentTrack;
        newTrack = nextTrack || createTrack('B');
        nextTrack = prevTrack;

        /* ========= 旧轨 prevTrack：淡出（fade_out_beats=0 时不碰gain，保持1，完整播放到 buffer 末尾） ========= */
        const oldGain = prevTrack.gain;
        let fadeStartAtCtx = 0;
        let fadeEndAtCtx = 0;
        if (oldGain && audioCtx && fadeOutS > 0.0002) {
            const fadeStartAtAudioS = fadeOutStartS;
            const timeUntilFade = fadeStartAtAudioS - raw;
            if (nearAudioEnd || timeUntilFade <= -fadeOutS) {
                fadeStartAtCtx = now + 0.0001;
                fadeEndAtCtx = now + fadeOutS + 0.0002;
            } else {
                fadeStartAtCtx = now + Math.max(0, timeUntilFade);
                fadeEndAtCtx = fadeStartAtCtx + fadeOutS;
            }

            try {
                const fs = Math.max(audioCtx.currentTime + 0.0005, fadeStartAtCtx);
                const fe = Math.max(fs + 0.0001, fadeEndAtCtx);
                oldGain.gain.cancelScheduledValues(fs);
                try { oldGain.gain.setValueAtTime(oldGain.gain.value, fs); } catch(_){}
                oldGain.gain.linearRampToValueAtTime(0.0, fe);
                prevTrack.envelopeEndsAtCtx = Math.max(prevTrack.envelopeEndsAtCtx || 0, fe);
                DLog(`  prev[${prevTrack.label}] fadeOut: fadeStartAudio=${fadeStartAtAudioS.toFixed(3)}s raw=${raw.toFixed(3)}s auto=${fadeOutAuto} startAtCtx=${fs.toFixed(3)}→endAtCtx=${fe.toFixed(3)} (${(fadeOutS*1000).toFixed(0)}ms)`);
            } catch(e) { DLog('fadeOut schedule err', e.message); }
        } else if (oldGain) {
            DLog(`  prev[${prevTrack.label}] fadeOut: disabled (${(fadeOutS*1000).toFixed(0)}ms); keep gain=1 until natural end`);
        }

        /* ========= 新轨 newTrack：在 switchAtCtx 从 loopStartS 开始淡入 ========= */
        let newStartGain = 1.0;
        let newStartAt = switchAtCtx;
        if (fadeInS > 0.0002) {
            newStartGain = 0.0;
        }
        const ok = playSegmentAt(newTrack, loopStartS, newStartAt, {
            enableLoop: false,
            initialGain: newStartGain,
        });
        if (!ok) {
            DLog('  playSegmentAt FAILED; retry start NOW');
            const retry = playSegmentAt(newTrack, loopStartS, audioCtx.currentTime + 0.003, {
                enableLoop: false,
                initialGain: newStartGain,
            });
            if (!retry) {
                DLog('  retry also FAILED; restore prevTrack as currentTrack');
                currentTrack = prevTrack;
                nextTrack = newTrack;
                scheduleNextLoop();
                return;
            }
        }

        if (fadeInS > 0.0002 && newTrack.gain) {
            try {
                const gs = Math.max(audioCtx.currentTime + 0.002, newTrack.startedAtCtx);
                newTrack.gain.gain.cancelScheduledValues(gs);
                newTrack.gain.gain.setValueAtTime(0.0, gs);
                const fadeInEndAt = gs + fadeInS;
                newTrack.gain.gain.linearRampToValueAtTime(1.0, fadeInEndAt);
                newTrack.envelopeEndsAtCtx = Math.max(newTrack.envelopeEndsAtCtx || 0, fadeInEndAt);
                DLog(`  new[${newTrack.label}] fadeIn: ${(fadeInS*1000).toFixed(0)}ms from loopStart, ${gs.toFixed(3)}→${fadeInEndAt.toFixed(3)}`);
            } catch(e) { DLog('fadeIn schedule err', e.message); }
        }

        /* ========= 旧轨：等淡出+自然播放结束后，再安全清理（不硬 stop source） ========= */
        prevTrack.stopScheduled = true;
        prevTrack.stopAtCtx = 0;
        const naturalEndCtx = prevTrack.startedAtCtx + Math.max(0, audioDurS - prevTrack.startOffset);
        const cleanupAfterCtx = Math.max(prevTrack.envelopeEndsAtCtx || 0, fadeEndAtCtx || 0, naturalEndCtx);
        DLog(`  prev[${prevTrack.label}] will NOT hard-stop; cleanup after ctx=${cleanupAfterCtx.toFixed(3)} (naturalEnd=${naturalEndCtx.toFixed(3)})`);
        safeCleanupTrack(prevTrack);
        const vFadeEnd = newTrack.envelopeEndsAtCtx || (newTrack.startedAtCtx + Math.max(fadeInS, fadeOutS));

        const xfadeS = Math.max(fadeInS, fadeOutS);
        const dsFadeStart = fadeStartAtCtx || switchAtCtx - xfadeS * 0.5;
        const dsFadeEnd = fadeEndAtCtx || switchAtCtx + xfadeS * 0.5;
        syncExtraTracksOnJump(loopStartS, dsFadeStart, dsFadeEnd, xfadeS);

        // transition：从旧轨位置平滑过渡到新轨起点（switchAtCtx 之后才生效）
        transitionBase = Math.min(raw + remainingToEnd, loopEndS);
        transitionStartTime = switchAtCtx;
        transitionPos = loopStartS;
        currentTrack = newTrack;
        // 设置歌词幽灵期：以 switchAtCtx 为基准对齐，避免累积偏差
        // 幽灵期从实际切换时刻 switchAtCtx 开始，延续到 effectiveLoopEndS
        if (loopMode === 'dual' && lyricEndS > loopEndS) {
            const ghostDuration = effectiveLoopEndS - loopEndS;
            lyricGhostUntil = switchAtCtx + ghostDuration;
            lyricGhostFrom = Math.min(raw + remainingToEnd, loopEndS);
            lyricGhostStartCtx = switchAtCtx;
        } else {
            lyricGhostUntil = 0;
        }

        const switchRawSec = raw + remainingToEnd;
        const bb = barBeat(switchRawSec);
        DLog(`DUAL SWITCH${isFirst ? ' [FIRST]' : ''}: raw=${raw.toFixed(3)} rem=${remainingToEnd.toFixed(4)}s switchRawSec=${switchRawSec.toFixed(3)} → ${bb.bar}:${bb.beat} switchAt=${switchAtCtx.toFixed(4)} newStartAt=${newTrack.startedAtCtx.toFixed(4)} nearEnd=${nearAudioEnd}`);
    } catch (e) {
        DLog('doDualSwitch FATAL:', e.message, e.stack);
    }
    scheduleNextLoop();
};

const loadBuffer = async (filename, dirId) => {
    ensureCtx();
    let url = `/api/bgm/${encodeURIComponent(filename)}`;
    if (dirId) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'dir_id=' + encodeURIComponent(dirId);
    }
    const cacheKey = url;
    if (audioCache[cacheKey]) {
        return audioCache[cacheKey];
    }
    if (audioLoading[cacheKey]) {
        return audioLoading[cacheKey];
    }
    DLog('loadBuffer:', url);
    const promise = (async () => {
        try {
            const resp = await fetch(url, { cache: 'force-cache' });
            if (!resp.ok) throw new Error('Audio fetch failed: ' + resp.status);
            const arrayBuffer = await resp.arrayBuffer();
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
            audioCache[cacheKey] = decodedBuffer;
            DLog(`loadBuffer done: dur=${decodedBuffer.duration.toFixed(3)}s`);
            return decodedBuffer;
        } catch (e) {
            DLog('loadBuffer error:', e.message);
            delete audioLoading[cacheKey];
            throw e;
        } finally {
            delete audioLoading[cacheKey];
        }
    })();
    audioLoading[cacheKey] = promise;
    return promise;
};

const loadAudio = async (cfg, styleIdx = -1) => {
    ensureCtx();
    let filename = cfg.filename;
    let dirId = cfg.bgm_dir_id;
    
    if (styleIdx >= 0 && Array.isArray(cfg.styles) && cfg.styles[styleIdx]) {
        const style = cfg.styles[styleIdx];
        filename = style.filename || cfg.filename;
        dirId = style.bgm_dir_id || cfg.bgm_dir_id;
    }
    
    let url = `/api/bgm/${encodeURIComponent(filename)}`;
    if (dirId) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'dir_id=' + encodeURIComponent(dirId);
    }
    
    const cacheKey = url;
    
    if (audioCache[cacheKey]) {
        DLog(`cache hit: ${url}`);
        audioBuffer = audioCache[cacheKey];
        audioDurS = audioBuffer.duration;
        DLog(`loaded from cache: dur=${audioDurS.toFixed(3)}s`);
        return audioBuffer;
    }
    
    if (audioLoading[cacheKey]) {
        DLog(`waiting for loading: ${url}`);
        return audioLoading[cacheKey];
    }
    
    DLog('loading:', url);
    
    const promise = (async () => {
        try {
            const resp = await fetch(url, { cache: 'force-cache' });
            if (!resp.ok) throw new Error('Audio fetch failed: ' + resp.status);
            
            DLog('fetch complete, decoding audio...');
            const arrayBuffer = await resp.arrayBuffer();
            DLog(`arrayBuffer received: ${arrayBuffer.byteLength} bytes`);
            
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
            audioCache[cacheKey] = decodedBuffer;
            audioBuffer = decodedBuffer;
            audioDurS = decodedBuffer.duration;
            DLog(`loaded: dur=${audioDurS.toFixed(3)}s sr=${decodedBuffer.sampleRate} ch=${decodedBuffer.numberOfChannels} from dir=${dirId || '(compat/default)'}`);
            return decodedBuffer;
        } catch (e) {
            DLog('loadAudio error:', e.message);
            delete audioLoading[cacheKey];
            throw e;
        } finally {
            delete audioLoading[cacheKey];
        }
    })();
    
    audioLoading[cacheKey] = promise;
    return promise;
};

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const _isPureEnglishText = (text) => {
    if (!text) return true;
    return /^[A-Za-z0-9\s'\-,.?!:;()"]+$/.test(text);
};

const _buildFlattenCharSlots = (karaoke, lineEndTime = null) => {
    if (!Array.isArray(karaoke) || karaoke.length === 0) return [];

    const tokens = [];
    for (let i = 0; i < karaoke.length; i += 1) {
        const curr = karaoke[i];
        const currTime = curr.time_sec || 0;
        const currText = curr.text || '';

        if (!currText) {
            if (tokens.length > 0) {
                tokens[tokens.length - 1].end = currTime;
            }
            continue;
        }

        let nextTime = null;
        let j = i + 1;
        while (j < karaoke.length && Math.abs((karaoke[j].time_sec || 0) - currTime) < 1e-6) {
            j += 1;
        }

        const hasSameTimeAfter = j > i + 1;
        let endTime = null;
        for (let k = j; k < karaoke.length; k += 1) {
            const t = karaoke[k].time_sec || 0;
            if (Math.abs(t - currTime) >= 1e-6) {
                nextTime = t;
                break;
            }
        }

        if (hasSameTimeAfter) {
            endTime = currTime;
        } else if (nextTime !== null) {
            endTime = nextTime;
        }

        tokens.push({ start: currTime, end: endTime, text: currText });
    }

    if (tokens.length === 0) return [];

    const lastToken = tokens[tokens.length - 1];
    if (lastToken.end === null) {
        if (lineEndTime !== null && lineEndTime > lastToken.start) {
            lastToken.end = lineEndTime;
        } else {
            lastToken.end = lastToken.start + 0.6;
        }
    }

    const slots = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const duration = token.end - token.start;
        if (duration <= 0) {
            const chars = Array.from(token.text);
            for (let c = 0; c < chars.length; c += 1) {
                slots.push({ start: token.start, end: token.start, text: chars[c] });
            }
            continue;
        }

        if (_isPureEnglishText(token.text)) {
            slots.push({ start: token.start, end: token.end, text: token.text });
        } else {
            const chars = Array.from(token.text);
            const charCount = chars.length;
            if (charCount === 0) continue;
            if (charCount === 1) {
                slots.push({ start: token.start, end: token.end, text: chars[0] });
            } else {
                const step = duration / charCount;
                for (let c = 0; c < charCount; c += 1) {
                    const s = token.start + step * c;
                    const e = c === charCount - 1 ? token.end : token.start + step * (c + 1);
                    slots.push({ start: s, end: e, text: chars[c] });
                }
            }
        }
    }

    if (slots.length === 0) return [];
    let totalDur = 0;
    let totalChar = 0;
    for (let i = 0; i < slots.length - 1; i += 1) {
        const dur = slots[i + 1].start - slots[i].start;
        if (dur > 0) {
            totalDur += dur;
            totalChar += slots[i].text.length;
        }
    }
    const avgPerChar = totalChar > 0 && totalDur > 0 ? totalDur / totalChar : 0.4;
    const lastSlot = slots[slots.length - 1];
    if (lastSlot.end - lastSlot.start <= 0) {
        lastSlot.end = lastSlot.start + Math.max(0.6, avgPerChar * Math.max(1, lastSlot.text.length));
    }

    return slots;
};

// ============ 卡拉OK像素级测量（解决字符宽度差异导致的错位） ============
// 不同字体下，汉字、数字、标点、空格的 advanceWidth 差异很大，若按字符数算百分比会错位。
// 方案：对已渲染出的 .lyric-karaoke-line 元素，用 mirror span 精确测量每个 slot 文本结束时的像素位置，
// 换算成 0-100 的 clip-path 百分比，实现视觉边界精确对齐。

const _karaokeMirrorEl = (() => {
    const el = document.createElement('span');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;top:-99999px;left:-99999px;opacity:0;pointer-events:none;' +
        'white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;' +
        'visibility:hidden;display:inline-block;max-width:none;';
    // 首次写入 body
    const mount = () => {
        if (!el.parentNode) {
            (document.body || document.documentElement).appendChild(el);
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
    return el;
})();

const _karaokePixelMapCache = new Map(); // key -> { slotStarts:number[], totalWidth:number, textHash, fontSig }

const _TEXT_LAYOUT_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'fontStretch', 'fontKerning', 'fontFeatureSettings', 'letterSpacing',
    'wordSpacing', 'lineHeight', 'textRendering', 'textTransform',
    'whiteSpace', 'overflowWrap', 'wordBreak', 'writingMode',
    'textOrientation', 'tabSize'
];

const _copyTextLayoutStyles = (dst, src) => {
    const cs = window.getComputedStyle(src);
    for (const p of _TEXT_LAYOUT_PROPS) {
        dst.style[p] = cs[p];
    }
    // 关键修复：mirror 绝不能继承源元素的固定宽度！
    // 否则 inline-block 被锁定为整行宽度，无论放整行还是单个字，
    // getBoundingClientRect().width 都返回同一个固定值 → slotStarts[1]=100% → 瞬间高亮整行。
    // 正确做法：width:auto 让 inline-block 收缩到文本内容宽度，测量纯 advance width；
    // white-space:pre 强制不换行（无论源元素是否换行），确保测得单行真实文本宽度。
    dst.style.width = 'auto';
    dst.style.maxWidth = 'none';
    dst.style.whiteSpace = 'pre';
};

const _fnv1a = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
};

/**
 * 基于真实 DOM 元素，测量 karaoke slots 的像素级边界百分比数组。
 * @param {HTMLElement} karaokeEl - 已渲染出文字的 .lyric-karaoke-line
 * @param {Array} slots - _buildFlattenCharSlots 的结果
 * @returns {number[]} slotStarts：长度 slots.length+1，slotStarts[i] 是第 i 个 slot 起点的百分比（0-100），
 *                     slotStarts[slots.length] = 100
 */
const _measureKaraokePixelMap = (karaokeEl, slots) => {
    if (!karaokeEl || !slots || slots.length === 0) return null;
    const mirror = _karaokeMirrorEl;
    _copyTextLayoutStyles(mirror, karaokeEl);

    // 先放整行，得到总宽度
    const fullText = slots.map(s => s.text).join('');
    mirror.textContent = fullText;
    const totalW = mirror.getBoundingClientRect().width;
    if (totalW <= 0) return null;

    const slotStarts = new Array(slots.length + 1);
    slotStarts[0] = 0;
    let prefix = '';
    for (let i = 0; i < slots.length; i += 1) {
        prefix += slots[i].text;
        mirror.textContent = prefix;
        const endW = mirror.getBoundingClientRect().width;
        slotStarts[i + 1] = Math.min(100, (endW / totalW) * 100);
    }
    // 最后一个强制为 100，避免浮点误差
    slotStarts[slotStarts.length - 1] = 100;
    mirror.textContent = '';
    return { slotStarts, totalWidth: totalW };
};

/**
 * 基于像素级 slotStarts 数组计算进度（0-100）。
 * @param {Array} slots - _buildFlattenCharSlots 结果
 * @param {number} currentSec - 当前时间
 * @param {{slotStarts:number[]}} pixelMap - _measureKaraokePixelMap 的结果
 */
const _computeKaraokeProgressPixels = (slots, currentSec, pixelMap) => {
    const slotStarts = pixelMap.slotStarts;
    let i = 0;
    let donePct = 0;
    for (i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        if (currentSec < slot.start - 1e-9) {
            donePct = slotStarts[i];
            break;
        }
        if (currentSec >= slot.end - 1e-9) {
            continue;
        }
        const duration = slot.end - slot.start;
        const partial = duration > 0 ? Math.min(1, Math.max(0, (currentSec - slot.start) / duration)) : 0;
        const startPct = slotStarts[i];
        const endPct = slotStarts[i + 1];
        donePct = startPct + (endPct - startPct) * partial;
        return Math.min(100, Math.max(0, donePct));
    }
    // 循环结束 / 间隔中：取最后完成的起点百分比
    if (i >= slots.length) donePct = slotStarts[slots.length];
    return Math.min(100, Math.max(0, donePct));
};

// 计算当前歌词的卡拉OK进度（0-100），用于平滑逐字填充
// 优先使用像素级测量（若传入 karaokeEl），解决字符宽度不等的错位问题
const _computeKaraokeProgress = (karaoke, currentSec, lineEndTime = null, karaokeEl = null) => {
    const slots = _buildFlattenCharSlots(karaoke, lineEndTime);
    if (slots.length === 0) return 0;

    // 像素级路径：仅在传入已渲染元素时使用
    if (karaokeEl) {
        const fontSig = (() => {
            const cs = window.getComputedStyle(karaokeEl);
            return [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.letterSpacing, cs.wordSpacing, cs.lineHeight].join('|');
        })();
        const textStr = slots.map(s => s.text).join('');
        const hash = _fnv1a(textStr) + '|' + _fnv1a(fontSig);
        let map = _karaokePixelMapCache.get(hash);
        if (!map) {
            map = _measureKaraokePixelMap(karaokeEl, slots);
            if (map) {
                _karaokePixelMapCache.set(hash, map);
                // 控制缓存规模
                if (_karaokePixelMapCache.size > 64) {
                    const firstKey = _karaokePixelMapCache.keys().next().value;
                    _karaokePixelMapCache.delete(firstKey);
                }
            }
        }
        if (map) {
            return _computeKaraokeProgressPixels(slots, currentSec, map);
        }
    }

    // fallback：字符数算法（兜底）
    let totalLen = 0;
    for (const s of slots) totalLen += Array.from(s.text).length;
    if (totalLen === 0) return 0;
    let doneLen = 0;
    for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        const charCount = Array.from(slot.text).length;
        if (currentSec < slot.start - 1e-9) break;
        if (currentSec >= slot.end - 1e-9) {
            doneLen += charCount;
            continue;
        }
        const duration = slot.end - slot.start;
        const partial = duration > 0 ? Math.min(1, Math.max(0, (currentSec - slot.start) / duration)) : 0;
        const progress = (doneLen + charCount * partial) / totalLen;
        return Math.min(1, Math.max(0, progress)) * 100;
    }
    return Math.min(1, Math.max(0, doneLen / totalLen)) * 100;
};

const renderLyricBody = (entry, currentSec, lineEndTime = null) => {
    if (!entry) return '<span class="lyric-empty">暂无歌词</span>';
    if (entry.is_empty) return '<div class="lyric-empty-line"></div>';
    const karaoke = Array.isArray(entry.karaoke) ? entry.karaoke : [];
    let html = '';
    if (karaoke.length > 0) {
        // 卡拉OK模式：使用 background-clip:text + CSS 变量实现平滑逐字填充
        // 多行文本也能正确显示进度（gradient 按 % 跨行应用）
        const progress = _computeKaraokeProgress(karaoke, currentSec, lineEndTime);
        const text = escapeHtml(entry.text || '');
        html = `<span class="lyric-karaoke-line" style="--karaoke-progress:${progress.toFixed(2)}">${text}</span>`;
    } else {
        html = escapeHtml(entry.text || '');
    }

    if (entry.translation) {
        const transKaraoke = Array.isArray(entry.translation_karaoke) ? entry.translation_karaoke : [];
        let transHtml = '';
        if (transKaraoke.length > 0) {
            const transProgress = _computeKaraokeProgress(transKaraoke, currentSec, lineEndTime);
            const transText = escapeHtml(entry.translation || '');
            transHtml = `<span class="lyric-karaoke-line" style="--karaoke-progress:${transProgress.toFixed(2)}">${transText}</span>`;
        } else {
            transHtml = escapeHtml(entry.translation || '');
        }
        return `<div class="lyric-main">${html}</div><div class="lyric-translation">${transHtml}</div>`;
    }
    return `<div class="lyric-main">${html}</div>`;
};

let _lastRenderedLyricKey = '';

const setLyricText = (entry, currentSec, lineEndTime = null) => {
    const el = $('lyricText');
    if (!el) return;

    if (!entry) {
        if (_lastRenderedLyricKey !== '__null__') {
            el.innerHTML = '<span class="lyric-empty">暂无歌词</span>';
            el.classList.toggle('is-empty', true);
            _lastRenderedLyricKey = '__null__';
        }
    } else if (entry.is_empty) {
        if (_lastRenderedLyricKey !== '__empty__') {
            el.innerHTML = '<span class="lyric-empty-line"></span>';
            el.classList.toggle('is-empty', true);
            _lastRenderedLyricKey = '__empty__';
        }
    } else {
        const hasKaraoke = Array.isArray(entry.karaoke) && entry.karaoke.length > 0;
        const hasTransKaraoke = Array.isArray(entry.translation_karaoke) && entry.translation_karaoke.length > 0;
        // 卡拉OK行只在切换歌词时重建结构，每帧仅更新 --karaoke-progress 变量（避免重排）
        const lineKey = activeLyricIndex + ':' + (hasKaraoke ? 'k' : '0') + (hasTransKaraoke ? 't' : '');
        if (lineKey !== _lastRenderedLyricKey) {
            el.innerHTML = renderLyricBody(entry, currentSec, lineEndTime);
            el.classList.toggle('is-empty', false);
            _lastRenderedLyricKey = lineKey;
        } else if (hasKaraoke || hasTransKaraoke) {
            if (hasKaraoke) {
                const karaokeLine = el.querySelector('.lyric-main .lyric-karaoke-line');
                if (karaokeLine) {
                    const progress = _computeKaraokeProgress(entry.karaoke, currentSec, lineEndTime, karaokeLine);
                    karaokeLine.style.setProperty('--karaoke-progress', progress.toFixed(2));
                }
            }
            if (hasTransKaraoke) {
                const transKaraokeLine = el.querySelector('.lyric-translation .lyric-karaoke-line');
                if (transKaraokeLine) {
                    const transProgress = _computeKaraokeProgress(entry.translation_karaoke, currentSec, lineEndTime, transKaraokeLine);
                    transKaraokeLine.style.setProperty('--karaoke-progress', transProgress.toFixed(2));
                }
            }
        }
    }
    // 桌面歌词由主进程 Node.js 定时器统一推送（绕过 Chromium 节流）
    // 渲染端只负责同步音频时间，不再直接发送 updateDesktopLyric
};

const updateLyricDisplay = () => {
    if (!lyricLines.length) {
        setLyricText(null, 0);
        return;
    }
    let s = currentPlaySec();
    if (multiStyleMode && currentStyleIdx >= 0) {
        const entry = styleTracks[currentStyleIdx];
        if (entry && entry.sameLyrics && entry.offsetDiff != null) {
            s = s - entry.offsetDiff;
        }
    }
    let nextIndex = 0;
    while (nextIndex < lyricLines.length - 1 && lyricLines[nextIndex + 1].time_sec <= s) {
        nextIndex += 1;
    }
    if (nextIndex !== activeLyricIndex) {
        activeLyricIndex = nextIndex;
    }
    const line = lyricLines[activeLyricIndex] || lyricLines[0];
    const nextLine = lyricLines[activeLyricIndex + 1];
    const lineEndTime = nextLine ? nextLine.time_sec : null;
    setLyricText(line || null, s, lineEndTime);
};

const loadLyrics = async (cfg, applyNow = true) => {
    // applyNow=false 时只加载数据，不更新UI（用于后台预加载）
    if (applyNow) {
        lyricLines = [];
        activeLyricIndex = -1;
        lastDesktopLyricLineIdx = -1;
        setLyricText(null, 0);
    }
    try {
        const body = {
            filename: cfg.filename,
            dir_id: cfg.bgm_dir_id || '',
            bpm: typeof cfg.bpm === 'number' ? cfg.bpm : 120,
            beats_per_bar: typeof cfg.beats_per_bar === 'number' ? cfg.beats_per_bar : 4,
            audio_zero_bar: typeof cfg.audio_zero_bar === 'number' ? cfg.audio_zero_bar : 1,
            audio_zero_beat: typeof cfg.audio_zero_beat === 'number' ? cfg.audio_zero_beat : 1,
            note_value_fraction: window.BeatUtils.noteValueFraction(cfg.note_value),
            note_value: cfg.note_value || 'quarter',
            tempo_changes: Array.isArray(cfg.tempo_changes) ? cfg.tempo_changes : [],
            meter_changes: Array.isArray(cfg.meter_changes) ? cfg.meter_changes : []
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch('/api/lyrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error('Lyrics fetch failed: ' + resp.status);
        const data = await resp.json();
        if (data.ok && Array.isArray(data.data?.lines)) {
            let loadedLines = data.data.lines;
            if (loadedLines.length > 0 && loadedLines[0].time_sec > 0.1) {
                loadedLines = [{ is_empty: true, time_sec: 0 }, ...loadedLines];
            }
            if (applyNow) {
                lyricLines = loadedLines;
                syncLyricCacheToMain();
                if (lyricLines.length > 0) {
                    updateLyricDisplay();
                } else {
                    setLyricText(null, 0);
                }
            }
            return loadedLines;
        } else if (applyNow) {
            setLyricText(null, 0);
        }
        return [];
    } catch (e) {
        DLog('loadLyrics failed:', e.message);
        if (applyNow) setLyricText(null, 0);
        return [];
    }
};

const applyTrackCfg = (cfg) => {
    activeTrackCfg = cfg;
    activeTrackNvf = window.BeatUtils.noteValueFraction(cfg.note_value);
    beatsPerSec = cfg.bpm / 60.0 / activeTrackNvf;
    beatSec = 60.0 / cfg.bpm * activeTrackNvf;
    zeroAbsBeat = (cfg.audio_zero_bar - 1) * cfg.beats_per_bar + cfg.audio_zero_beat;
    
    tempoChanges = [];
    if (Array.isArray(cfg.tempo_changes)) {
        tempoChanges = cfg.tempo_changes
            .filter(tc => typeof tc.bar === 'number' && typeof tc.beat === 'number' && typeof tc.bpm === 'number')
            .filter(tc => tc.bar >= 1 && tc.beat >= 1 && tc.bpm > 0);
    }
    
    meterChanges = [];
    if (Array.isArray(cfg.meter_changes)) {
        meterChanges = cfg.meter_changes
            .filter(mc => typeof mc.bar === 'number' && typeof mc.beat === 'number' && typeof mc.beats_per_bar === 'number')
            .filter(mc => mc.bar >= 1 && mc.beat >= 1 && mc.beats_per_bar > 0);
    }
    
    startS = secFromBarBeat(cfg.audio_zero_bar, cfg.audio_zero_beat);
    loopStartS = secFromBarBeat(cfg.loop_start_bar, cfg.loop_start_beat);
    loopEndS = secFromBarBeat(cfg.loop_end_bar, cfg.loop_end_beat);
    loopDurS = loopEndS - loopStartS;
    loopMode = (cfg.loop_mode && cfg.loop_mode === 'dual') ? 'dual' : 'single';

    // 歌词结束时间：0 或未设置时默认 = loopEndS
    const leBar = +cfg.lyric_end_bar || 0;
    const leBeat = +cfg.lyric_end_beat || 0;
    if (leBar >= 1 && leBeat >= 1) {
        lyricEndS = secFromBarBeat(leBar, leBeat);
    } else {
        lyricEndS = loopEndS;
    }
    // 双轨模式下使用更大的 effectiveLoopEndS，让旧轨播放到歌词结束位置
    effectiveLoopEndS = Math.max(loopEndS, lyricEndS);
    effectiveLoopDurS = Math.max(0.01, effectiveLoopEndS - loopStartS);
    // 重置幽灵期
    lyricGhostUntil = 0;
    fadeInS = Math.max(0, +cfg.fade_in_beats || 0) * beatSec;
    fadeOutS = Math.max(0, +cfg.fade_out_beats || 0) * beatSec;

    const fosBar = +cfg.fade_out_start_bar;
    const fosBeat = +cfg.fade_out_start_beat || 1;
    fadeOutAuto = !(fosBar >= 1);
    if (fadeOutAuto) {
        fadeOutStartS = Math.max(0, loopEndS - fadeOutS);
    } else {
        fadeOutStartS = secFromBarBeat(fosBar, fosBeat);
    }

    const jssBar = +cfg.jump_seg_start_bar || 0;
    const jssBeat = +cfg.jump_seg_start_beat || 0;
    const jseBar = +cfg.jump_seg_end_bar || 0;
    const jseBeat = +cfg.jump_seg_end_beat || 0;
    if (jssBar >= 1 && jssBeat >= 1 && jseBar >= 1 && jseBeat >= 1) {
        jumpSegStartS = secFromBarBeat(jssBar, jssBeat);
        jumpSegEndS = secFromBarBeat(jseBar, jseBeat);
        jumpSegEnabled = jumpSegEndS > jumpSegStartS + 0.0002;
    } else {
        jumpSegStartS = 0;
        jumpSegEndS = 0;
        jumpSegEnabled = false;
    }

    DLog(`cfg: ${cfg.name} mode=${loopMode} bpm=${cfg.bpm} beat=${(beatSec*1000).toFixed(1)}ms`);
    DLog(`  zeroAbsBeat=${zeroAbsBeat} beatsPerSec=${beatsPerSec}`);
    DLog(`  startS=${startS.toFixed(4)} loop=[${loopStartS.toFixed(3)} → ${loopEndS.toFixed(3)}] dur=${loopDurS.toFixed(3)}s`);
    DLog(`  tempoChanges count=${tempoChanges.length}`);
    tempoChanges.forEach((tc, i) => {
        const tcTime = secFromBarBeat(tc.bar, tc.beat);
        const tcAbs = window.BeatUtils.barBeatToAbs(tc.bar, tc.beat, cfg.beats_per_bar, cfg.audio_zero_bar, cfg.audio_zero_beat, meterChanges);
        DLog(`    tc[${i}]: ${tc.bar}:${tc.beat} → ${tc.bpm} BPM, time_sec=${tcTime.toFixed(4)}, abs=${tcAbs}`);
    });
    if (jumpSegEnabled) {
        DLog(`  jump_seg=[${jumpSegStartS.toFixed(3)} → ${jumpSegEndS.toFixed(3)}] (dur=${(jumpSegEndS-jumpSegStartS).toFixed(3)}s) ENABLED`);
    } else {
        DLog(`  jump_seg: disabled`);
    }
    const fosLabel = fadeOutAuto ? 'auto→loopEnd' : `${fosBar}:${fosBeat}`;
    DLog(`  fadeIn=${(fadeInS*1000).toFixed(0)}ms (from loopStart) fadeOut=${(fadeOutS*1000).toFixed(0)}ms (fos=${fosLabel} abs=${fadeOutStartS.toFixed(3)}s)`);
    syncLyricCacheToMain();
};

// ===== 曲目资源预加载（供「预载」按钮与播放复用，实现秒播） =====
const preloadedTracks = {};

const loadTrackAssets = async (cfg) => {
    const loadedLyricLines = await loadLyrics(cfg, false);

    const multiStyleModePre = !!(cfg.multi_style_enabled && Array.isArray(cfg.styles) && cfg.styles.length > 0);
    const extraTracksEnabledPre = !!(cfg.extra_tracks_enabled && Array.isArray(cfg.extra_tracks) && cfg.extra_tracks.length > 0);
    const endingEnabledPre = !!(cfg.ending_enabled && cfg.ending_filename);
    const loopSfxEnabledPre = !!(cfg.loop_sfx_enabled && cfg.loop_sfx_filename);
    const styleBuffers = {};
    let mainBuffer = null;
    let extraTrackBuffers = [];
    let endingBufferPre = null;
    let loopSfxBufferPre = null;

    const allLoadPromises = [];

    // 主音频
    allLoadPromises.push((async () => {
        try {
            mainBuffer = await loadBuffer(cfg.filename, cfg.bgm_dir_id || '');
            DLog('preload main track done');
        } catch(e) {
            DLog('preload main track failed:', e.message);
        }
    })());

    // 多风格
    if (multiStyleModePre) {
        cfg.styles.forEach((style, sIdx) => {
            if (!style.filename) return;
            allLoadPromises.push((async () => {
                try {
                    const sfilename = style.filename || cfg.filename;
                    const sdirId = style.bgm_dir_id || cfg.bgm_dir_id || '';
                    const buf = await loadBuffer(sfilename, sdirId);
                    styleBuffers[sIdx] = buf;
                    DLog(`preload style ${sIdx} (${style.name}) done`);
                } catch(e) {
                    DLog(`preload style ${sIdx} failed: ${e.message}`);
                }
            })());
        });
    }
    // 额外轨道
    if (extraTracksEnabledPre) {
        cfg.extra_tracks.forEach((et, etIdx) => {
            if (!et.filename) return;
            allLoadPromises.push((async () => {
                try {
                    const etfn = et.filename;
                    const etdir = et.dir_id || cfg.bgm_dir_id || '';
                    const buf = await loadBuffer(etfn, etdir);
                    extraTrackBuffers[etIdx] = buf;
                    DLog(`preload extra track ${etIdx} (${et.name}) done`);
                } catch(e) {
                    DLog(`preload extra track ${etIdx} failed: ${e.message}`);
                }
            })());
        });
    }
    // 收尾音频
    if (endingEnabledPre) {
        allLoadPromises.push((async () => {
            try {
                const efn = cfg.ending_filename;
                const edir = cfg.ending_dir_id || cfg.bgm_dir_id || '';
                endingBufferPre = await loadBuffer(efn, edir);
                DLog('preload ending audio done');
            } catch(e) {
                DLog('preload ending audio failed: ' + e.message);
            }
        })());
    }
    // 循环提示音效
    if (loopSfxEnabledPre) {
        allLoadPromises.push((async () => {
            try {
                const lfn = cfg.loop_sfx_filename;
                const ldir = cfg.loop_sfx_dir_id || cfg.bgm_dir_id || '';
                loopSfxBufferPre = await loadBuffer(lfn, ldir);
                DLog('preload loop sfx done');
            } catch(e) {
                DLog('preload loop sfx failed: ' + e.message);
            }
        })());
    }

    // 前奏音频
    const introEnabledPre = !!(cfg.intro_enabled && cfg.intro_filename);
    let introBufferPre = null;
    if (introEnabledPre) {
        allLoadPromises.push((async () => {
            try {
                const ifn = cfg.intro_filename;
                const idir = cfg.intro_dir_id || cfg.bgm_dir_id || '';
                introBufferPre = await loadBuffer(ifn, idir);
                DLog('preload intro audio done');
            } catch(e) {
                DLog('preload intro audio failed: ' + e.message);
            }
        })());
    }

    if (allLoadPromises.length > 0) {
        DLog(`loadTrackAssets: preloading ${allLoadPromises.length} audio(s) concurrently...`);
        await Promise.all(allLoadPromises);
        DLog('loadTrackAssets: all audios preloaded');
    }

    return {
        loadedLyricLines,
        multiStyleModePre,
        extraTracksEnabledPre,
        endingEnabledPre,
        loopSfxEnabledPre,
        styleBuffers,
        mainBuffer,
        extraTrackBuffers,
        endingBufferPre,
        loopSfxBufferPre,
        introEnabledPre,
        introBufferPre,
    };
};

// 统一计算并刷新某首曲目右侧按钮的显示状态
// 优先级：正在播放/暂停 > 已预载 > 预载中 > 预载
const refreshTrackButton = (idx) => {
    const el = document.querySelector(`.track-item[data-track-idx="${idx}"]`);
    if (!el) return;
    const btn = el.querySelector('.preload-btn');
    if (!btn) return;
    // 重置为基准样式，避免残留旧状态 class
    btn.className = 'preload-btn';
    if (idx === currentPlayingIdx) {
        el.classList.add('playing-item');
        if (isPaused) {
            btn.classList.add('state-paused');
            btn.textContent = '⏸';
            btn.title = '已暂停（点击列表项可继续/停止）';
        } else {
            btn.classList.add('state-playing');
            btn.textContent = '🔊';
            btn.title = '正在播放';
        }
    } else {
        el.classList.remove('playing-item');
        const st = trackPreloadState[idx] || 'idle';
        if (st === 'loading') {
            btn.classList.add('state-loading');
            btn.textContent = '⏳';
            btn.title = '预加载中…';
        } else if (st === 'done') {
            btn.classList.add('state-done');
            btn.textContent = '✓';
            btn.title = '已预载（点击曲目即可秒播）';
        } else {
            btn.textContent = '⏬';
            btn.title = '预加载（点击后再播放无需等待）';
        }
    }
};

const refreshAllTrackButtons = () => {
    if (!config || !Array.isArray(config.tracks)) return;
    config.tracks.forEach((_, idx) => refreshTrackButton(idx));
};

const markPreloadState = (idx, state) => {
    trackPreloadState[idx] = state;
    refreshTrackButton(idx);
    // 遥控器需要实时镜像每首曲目的预载进度（idle/loading/done），故状态变化时推送
    rcBroadcastState();
};

const preloadTrack = async (idx) => {
    if (preloadedTracks[idx]) return;
    const cfg = config.tracks[idx];
    if (!cfg) return;
    DLog('preloadTrack: start idx=' + idx);
    markPreloadState(idx, 'loading');
    try {
        ensureCtx();
        preloadedTracks[idx] = await loadTrackAssets(cfg);
        markPreloadState(idx, 'done');
        DLog('preloadTrack: done idx=' + idx);
    } catch (e) {
        DLog('preloadTrack error:', e.message);
        markPreloadState(idx, 'idle');
        delete preloadedTracks[idx];
    }
};

const playTrack = async (idx) => {
    // 加载锁：正在加载时禁止再次点击
    if (isLoadingTrack) {
        DLog(`playTrack: loading in progress (idx=${loadingTrackIdx}), ignore click idx=${idx}`);
        return;
    }
    // 同上一次「因无手势而延迟」的待播放作废，避免误触发旧曲目
    pendingBeginPlayback = null;
    // 同曲不重复播放
    if (currentTrack && activeTrackCfg && config.tracks[idx] === activeTrackCfg) {
        DLog(`playTrack: same track, ignore`);
        return;
    }
    
    isLoadingTrack = true;
    loadingTrackIdx = idx;
    updateLoadingUI(true, idx);
    
    try {
        DLog(`playTrack START: idx=${idx}`);
        isPaused = false;
        const cfg = config.tracks[idx];
        if (!cfg) {
            DLog('playTrack: no cfg, abort');
            return;
        }
        DLog(`playTrack: cfg.name=${cfg.name}`);
        expandCategoryForTrack(idx, true);
        
        // ===== 复用预加载资源，或实时加载 =====
        let assets;
        if (preloadedTracks[idx]) {
            assets = preloadedTracks[idx];
            DLog('playTrack: reuse preloaded assets idx=' + idx);
        } else {
            assets = await loadTrackAssets(cfg);
        }
        const loadedLyricLines = assets.loadedLyricLines;
        const multiStyleModePre = assets.multiStyleModePre;
        const extraTracksEnabledPre = assets.extraTracksEnabledPre;
        const endingEnabledPre = assets.endingEnabledPre;
        const loopSfxEnabledPre = assets.loopSfxEnabledPre;
        const styleBuffers = assets.styleBuffers;
        let mainBuffer = assets.mainBuffer;
        let extraTrackBuffers = assets.extraTrackBuffers;
        let endingBufferPre = assets.endingBufferPre;
        let loopSfxBufferPre = assets.loopSfxBufferPre;
        const introEnabledPre = assets.introEnabledPre;
        let introBufferPre = assets.introBufferPre;

        // 设置主音频全局变量
        if (mainBuffer) {
            audioBuffer = mainBuffer;
            audioDurS = audioBuffer.duration;
        }
        
        // 竞态条件检查：如果用户已经点击了其他歌曲，放弃当前加载
        if (loadingTrackIdx !== idx) {
            DLog(`playTrack: ABORT - user switched track (current loadingTrackIdx=${loadingTrackIdx}, this idx=${idx})`);
            return;
        }
        
        // 加载完成，淡出旧曲目并切换
        const wasPlaying = !!(currentTrack && currentTrack.source);
        if (wasPlaying) {
            DLog('playTrack: fading out previous track...');
            fadeOutCurrentTrack(3.0); // 3秒淡出
            // 等待淡出完成
            await new Promise(r => setTimeout(r, 300));
        }
        
        // 保存加载好的 audioBuffer 和 audioDurS（stopAll 会清空它们）
        const loadedBuffer = audioBuffer;
        const loadedDurS = audioDurS;
        
        // 现在停止旧曲目并应用新配置（等待close完成）
        await stopAll();
        
        // 恢复加载好的 audioBuffer
        audioBuffer = loadedBuffer;
        audioDurS = loadedDurS;
        
        // 应用歌词（此时才更新UI）
        lyricLines = loadedLyricLines || [];
        syncLyricCacheToMain();
        activeLyricIndex = -1;
        lastDesktopLyricLineIdx = -1;
        
        const lyricEl = $('lyricText');
        if (lyricEl) {
            lyricEl.classList.remove('font-teyvat');
            lyricEl.style.fontFamily = '';
            if (cfg.font_face === 'teyvat') {
                lyricEl.style.fontFamily = '"Teyvat", "GenshinJA", "Yu Gothic UI", "Microsoft YaHei", sans-serif';
            } else if (cfg.font_face === 'zpix') {
                lyricEl.style.fontFamily = '"Zpix", "Yu Gothic UI", sans-serif';
            } else if (cfg.font_face === '851tegakizatsu') {
                lyricEl.style.fontFamily = '"851tegakizatsu", "Yu Gothic UI", sans-serif';
            } else if (cfg.font_face === 'unifont_jp') {
                lyricEl.style.fontFamily = '"Unifont_JP", "Yu Gothic UI", sans-serif';
            }
        }
        
        applyTrackCfg(cfg);
        DLog('playTrack: applyTrackCfg done');
        
        loopPhase = 'main';
        updateInfoPanel(idx);
        
        // 更新歌词显示
        if (lyricLines.length > 0) {
            updateLyricDisplay();
        } else {
            setLyricText(null, 0);
        }
        
        try {
            renderMarkers();
            DLog('renderMarkers completed');
        } catch (e) {
            DLog('renderMarkers ERROR:', e.message);
        }
        
        ensureCtx();
        // 尝试让 AudioContext 进入 running（远程控制时本页可能尚未发生用户手势，
        // 需等用户在播放器页面点击/按键解锁后才能真正出声）。
        await waitForAudioRunning(600);

        if (!audioCtx) {
            DLog('playTrack: FATAL - audioCtx is null after ensureCtx!');
            return;
        }
        if (!audioBuffer) {
            DLog('playTrack: FATAL - audioBuffer is null!');
            return;
        }
        
        DLog(`playTrack: after loadAudio, startS=${startS.toFixed(4)}, loopStartS=${loopStartS.toFixed(4)}, loopEndS=${loopEndS.toFixed(4)}`);

        const startExtraTracks = (startAt, baseOffset) => {
            extraTracks = [];
            extraTracksEnabled = false;
            if (!extraTracksEnabledPre || !cfg.extra_tracks || cfg.extra_tracks.length === 0) return;
            const timePerBeat = 60.0 / cfg.bpm * activeTrackNvf;
            const defZeroOffset = ((cfg.audio_zero_bar - 1) * (cfg.beats_per_bar || 4) + (cfg.audio_zero_beat - 1)) * timePerBeat;
            const initialGain = (fadeInS > 0.0002) ? 0.0 : 1.0;
            cfg.extra_tracks.forEach((et, etIdx) => {
                const buf = extraTrackBuffers[etIdx];
                if (!et.filename || !buf) return;
                const azb = et.audio_zero_bar != null ? et.audio_zero_bar : cfg.audio_zero_bar || 1;
                const azbt = et.audio_zero_beat != null ? et.audio_zero_beat : cfg.audio_zero_beat || 1;
                const zOffset = ((azb - 1) * (cfg.beats_per_bar || 4) + (azbt - 1)) * timePerBeat;
                const offsetDiff = defZeroOffset - zOffset;
                const trackStartOffset = Math.max(0, baseOffset + offsetDiff);
                const trackGain = audioCtx.createGain();
                const baseVol = (et.volume != null) ? Number(et.volume) : 1.0;
                trackGain.gain.value = baseVol;
                trackGain.connect(configGainNode || masterGain);
                const trk = createTrack('et-' + (et.name || etIdx));
                const ok = playSegmentAt(trk, trackStartOffset, startAt, {
                    enableLoop: false,
                    initialGain,
                    buffer: buf,
                    connectTo: trackGain,
                });
                if (ok) {
                    trk.offsetDiff = offsetDiff;
                    if (fadeInS > 0.0002 && trk.gain) {
                        try {
                            const g0 = Math.max(audioCtx.currentTime + 0.001, startAt);
                            trk.gain.gain.cancelScheduledValues(g0);
                            trk.gain.gain.setValueAtTime(0.0, g0);
                            trk.gain.gain.linearRampToValueAtTime(1.0, g0 + fadeInS);
                        } catch(e) { DLog(`et[${et.name}] initial fade-in err`, e.message); }
                    }
                    extraTracks.push({
                        name: et.name || `轨道 ${etIdx + 1}`,
                        buffer: buf,
                        gain: trackGain,
                        track: trk,
                        offsetDiff: offsetDiff,
                        volume: baseVol,
                        muted: !!(et.muted),   // 默认不静音；若配置显式静音则继承，避免 undefined 歧义
                        audio_zero_bar: azb,
                        audio_zero_beat: azbt,
                    });
                    DLog(`extra track ${etIdx} (${et.name}) started: offset=${trackStartOffset.toFixed(3)}s diff=${offsetDiff.toFixed(3)}s vol=${baseVol}`);
                } else {
                    try { trackGain.disconnect(); } catch(_) {}
                }
            });
            extraTracksEnabled = extraTracks.length > 0;
        };

        multiStyleMode = !!(cfg.multi_style_enabled && Array.isArray(cfg.styles) && cfg.styles.length > 0);
        styleTracks = {};
        currentStyleIdx = -1;

        introEnabled = introEnabledPre && !!introBufferPre;
        introBuffer = introBufferPre;
        introTrack = null;
        introPlaying = false;

        const startMainAudio = (startAt = null) => {
            if (multiStyleMode) {
                const ctxCurrentTime = audioCtx.currentTime;
                const now = startAt !== null ? startAt : (ctxCurrentTime + 0.05);
                const initialGain = (startAt !== null) ? 1.0 : ((fadeInS > 0.0002) ? 0.0 : 1.0);
                const trackGain = cfg.gain != null ? Number(cfg.gain) : 1.0;
                
                if (configGainNode) {
                    configGainNode.gain.cancelScheduledValues(ctxCurrentTime);
                    configGainNode.gain.setValueAtTime(trackGain, ctxCurrentTime);
                }
                
                const timePerBeat = 60.0 / cfg.bpm * activeTrackNvf;
                const defZeroOffset = ((cfg.audio_zero_bar - 1) * (cfg.beats_per_bar || 4) + (cfg.audio_zero_beat - 1)) * timePerBeat;

                const getStyleOffsetDiff = (sIdx) => {
                    if (sIdx < 0) return 0;
                    const style = cfg.styles[sIdx];
                    const sAzb = style.audio_zero_bar != null ? style.audio_zero_bar : cfg.audio_zero_bar || 1;
                    const sAzbt = style.audio_zero_beat != null ? style.audio_zero_beat : cfg.audio_zero_beat || 1;
                    const sZeroOffset = ((sAzb - 1) * (cfg.beats_per_bar || 4) + (sAzbt - 1)) * timePerBeat;
                    return defZeroOffset - sZeroOffset;
                };

                const startStyleTrack = (sIdx, buffer, isDefault) => {
                    if (!buffer) return null;
                    const offsetDiff = getStyleOffsetDiff(sIdx);
                    const sLoopStart = Math.max(0, loopStartS + offsetDiff);
                    const sLoopEnd = Math.max(sLoopStart + 0.01, loopEndS + offsetDiff);

                    const styleGain = audioCtx.createGain();
                    styleGain.gain.value = isDefault ? 1.0 : 0.0;
                    styleGain.connect(configGainNode || masterGain);

                    const trackA = createTrack(sIdx === -1 ? 'default-A' : `style-${sIdx}-A`);
                    const trackB = createTrack(sIdx === -1 ? 'default-B' : `style-${sIdx}-B`);

                    const idealStartOffset = startS + offsetDiff;
                    let startOffset, trackStartTime;
                    if (idealStartOffset >= 0) {
                        startOffset = idealStartOffset;
                        trackStartTime = now;
                    } else {
                        startOffset = 0;
                        trackStartTime = now - idealStartOffset;
                    }

                    const ok = playSegmentAt(trackA, startOffset, trackStartTime, {
                        enableLoop: false,
                        initialGain: isDefault ? initialGain : 1.0,
                        buffer: buffer,
                        connectTo: styleGain,
                    });
                    if (!ok) {
                        DLog(`startStyleTrack(${sIdx}): playSegmentAt failed`);
                        try { styleGain.disconnect(); } catch(_){}
                        return null;
                    }

                    DLog(`startStyleTrack(${sIdx}): offset=${startOffset.toFixed(3)}s offsetDiff=${offsetDiff.toFixed(3)}s loop=[${sLoopStart.toFixed(3)}→${sLoopEnd.toFixed(3)}]`);

                    if (isDefault && startAt === null && fadeInS > 0.0002 && trackA.gain) {
                        try {
                            const g0 = Math.max(audioCtx.currentTime + 0.001, trackStartTime);
                            trackA.gain.gain.cancelScheduledValues(g0);
                            trackA.gain.gain.setValueAtTime(0.0, g0);
                            trackA.gain.gain.linearRampToValueAtTime(1.0, g0 + fadeInS);
                        } catch(e) { DLog('initial fade-in err', e.message); }
                    }

                    return {
                        styleGain,
                        current: trackA,
                        next: trackB,
                        buffer,
                        offsetDiff,
                        loopStartS: sLoopStart,
                        loopEndS: sLoopEnd,
                        duration: buffer.duration,
                        sameLyrics: isDefault ? false : (cfg.styles[sIdx] && cfg.styles[sIdx].same_lyrics) || false,
                    };
                };

                const defEntry = startStyleTrack(-1, audioBuffer, true);
                if (!defEntry) {
                    DLog('playTrack: FATAL - default style track start failed!');
                    return;
                }
                styleTracks[-1] = defEntry;
                currentTrack = defEntry.current;
                nextTrack = defEntry.next;

                cfg.styles.forEach((style, sIdx) => {
                    if (!style.filename) return;
                    const buf = styleBuffers[sIdx];
                    if (!buf) return;
                    const entry = startStyleTrack(sIdx, buf, false);
                    if (entry) {
                        styleTracks[sIdx] = entry;
                        DLog(`style ${sIdx} (${style.name}) started`);
                    }
                });

                startExtraTracks(now, startS);

                DLog(`playTrack: multiStyleMode active, ${Object.keys(styleTracks).length} style tracks ready`);
            } else {
                currentTrack = createTrack('A');
                nextTrack = createTrack('B');

                const ctxCurrentTime = audioCtx.currentTime;
                const now = startAt !== null ? startAt : (ctxCurrentTime + 0.05);
                const initialGain = (startAt !== null) ? 1.0 : ((fadeInS > 0.0002) ? 0.0 : 1.0);
                const trackGain = cfg.gain != null ? Number(cfg.gain) : 1.0;
                
                if (configGainNode) {
                    configGainNode.gain.cancelScheduledValues(ctxCurrentTime);
                    configGainNode.gain.setValueAtTime(trackGain, ctxCurrentTime);
                }
                
                DLog(`playTrack: ctx.currentTime=${ctxCurrentTime.toFixed(4)}, now=${now.toFixed(4)}`);
                DLog(`playTrack: startS=${startS.toFixed(4)} audioBuffer=${!!audioBuffer} ctxState=${audioCtx.state}`);

                // 移动端简单循环：使用 Web Audio API 原生 source.loop = true
                // 循环完全由音频渲染线程处理，不依赖 setTimeout，切后台零丢音
                // 仅限单轨模式且无跳段/额外轨道/结尾/SFX（这些需要 setTimeout 触发副作用）
                const useNativeLoop = IS_MOBILE_DEVICE
                    && loopMode === 'single'
                    && !jumpSegEnabled
                    && !extraTracksEnabled
                    && !endingEnabled
                    && !loopSfxEnabled
                    && loopDurS > 0.01;

                const playSuccess = playSegmentAt(currentTrack, startS, now, {
                    enableLoop: useNativeLoop,
                    initialGain,
                });
                
                if (!playSuccess) {
                    DLog('playTrack: playSegmentAt returned false!');
                    return;
                } else {
                    DLog('playTrack: playSegmentAt SUCCESS');
                }

                if (startAt === null && fadeInS > 0.0002 && currentTrack.gain) {
                    try {
                        const g0 = Math.max(audioCtx.currentTime + 0.001, now);
                        currentTrack.gain.gain.cancelScheduledValues(g0);
                        currentTrack.gain.gain.setValueAtTime(0.0, g0);
                        currentTrack.gain.gain.linearRampToValueAtTime(1.0, g0 + fadeInS);
                        currentTrack.envelopeEndsAtCtx = Math.max(currentTrack.envelopeEndsAtCtx || 0, g0 + fadeInS);
                        DLog(`initial fade-in: ${(fadeInS*1000).toFixed(0)}ms`);
                    } catch(e) { DLog('initial fade-in err', e.message); }
                }

                startExtraTracks(now, startS);
            }

            const runPostAudioTasks = () => {
                scheduleNextLoop();
                updateExtraTracksPanel();
                updateStyleButtons();
            };

            if (startAt !== null) {
                const delayMs = Math.max(0, (startAt - audioCtx.currentTime) * 1000);
                DLog(`postponing post-audio tasks for ${delayMs.toFixed(1)}ms`);
                setTimeout(runPostAudioTasks, delayMs);
            } else {
                runPostAudioTasks();
            }
        };

        const beginPlayback = () => {
            if (introEnabled && introBuffer) {
                introPlaying = true;
                introTrack = createTrack('intro');
                const introStartTime = audioCtx.currentTime + 0.05;
                const trackGain = cfg.gain != null ? Number(cfg.gain) : 1.0;
                if (configGainNode) {
                    configGainNode.gain.cancelScheduledValues(introStartTime);
                    configGainNode.gain.setValueAtTime(trackGain, introStartTime);
                }
                const ok = playSegmentAt(introTrack, 0, introStartTime, {
                    enableLoop: false,
                    initialGain: 1.0,
                    buffer: introBuffer,
                });
                if (ok) {
                    DLog(`intro track started: dur=${introBuffer.duration.toFixed(3)}s`);
                    const introEndTime = introStartTime + introBuffer.duration;
                    DLog(`intro will end at: ${introEndTime.toFixed(4)}s`);
                    startMainAudio(introEndTime);
                } else {
                    introEnabled = false;
                    introTrack = null;
                    introPlaying = false;
                    startMainAudio();
                }
            } else {
                startMainAudio();
            }
        };

        // 仅当 AudioContext 已运行才真正调度音频；否则（本页尚无手势，例如纯手机遥控）
        // 登记待播放，待用户在播放器页面点击解锁后立即启动，避免把音频调度到「过去」而解锁后仍无声。
        if (audioCtx && audioCtx.state === 'running') {
            beginPlayback();
        } else {
            showAudioLockHint();
            pendingBeginPlayback = beginPlayback;
        }

        // 收尾音频初始化（不立即播放）
        endingEnabled = endingEnabledPre && !!endingBufferPre;
        endingBuffer = endingBufferPre;
        endingGain = null;
        endingTrack = null;
        endingPlaying = false;

        // 完整循环初始化
        fullLoopEnabled = !!cfg.full_loop_enabled;
        isFullLoopMode = false;
        fullLoopSwitching = false;

        // 循环提示音效初始化（不立即播放）
        loopSfxEnabled = loopSfxEnabledPre && !!loopSfxBufferPre;
        loopSfxBuffer = loopSfxBufferPre;
        loopSfxGain = null;

        startUiTicker();

        loopBroken = false;
        const breakBtn = $('breakLoopBtn');
        const fullLoopBtn = $('fullLoopBtn');
        if (breakBtn) {
            breakBtn.disabled = false;
            if (endingEnabled) {
                breakBtn.textContent = '🎵 收尾';
            } else {
                breakBtn.textContent = '⏭ 跳出循环';
            }
        }
        if (fullLoopBtn) {
            if (fullLoopEnabled) {
                fullLoopBtn.style.display = '';
                fullLoopBtn.disabled = false;
                fullLoopBtn.textContent = '🔄 完整循环';
            } else {
                fullLoopBtn.style.display = 'none';
            }
        }

        DLog('playTrack: COMPLETE');
        currentPlayingIdx = idx;
        refreshAllTrackButtons();
        updatePauseButton();
        rcBroadcastState();
    } catch (e) {
        DLog('playTrack FATAL ERROR:', e.message, e.stack);
        console.error('playTrack error:', e);
    } finally {
        isLoadingTrack = false;
        loadingTrackIdx = -1;
        updateLoadingUI(false, idx);
    }
};

// 淡出当前播放的曲目
const fadeOutCurrentTrack = (durationSec) => {
    if (!currentTrack || !currentTrack.gain || !audioCtx) return;
    try {
        const now = audioCtx.currentTime;
        const curGain = currentTrack.gain.gain.value;
        currentTrack.gain.gain.cancelScheduledValues(now);
        currentTrack.gain.gain.setValueAtTime(curGain, now);
        currentTrack.gain.gain.linearRampToValueAtTime(0.0, now + durationSec);
        DLog(`fadeOutCurrentTrack: ${durationSec}s ramp from ${curGain.toFixed(3)} to 0`);
    } catch(e) { DLog('fadeOutCurrentTrack err:', e.message); }
};

// 加载状态UI反馈
const updateLoadingUI = (loading, idx) => {
    const list = $('trackList');
    if (!list) return;
    if (loading) {
        list.classList.add('loading');
        // 高亮正在加载的曲目
        const items = list.querySelectorAll('.track-item');
        items.forEach((item, i) => {
            const itemIdx = parseInt(item.querySelector('.preload-btn')?.dataset?.idx || '-1', 10);
            if (itemIdx === idx) {
                item.classList.add('loading-item');
            } else {
                item.classList.remove('loading-item');
            }
        });
    } else {
        list.classList.remove('loading');
        const items = list.querySelectorAll('.track-item');
        items.forEach(item => item.classList.remove('loading-item'));
    }
};

let loopBroken = false;

const EXTRA_TRACK_FADE_DURATION = 3.0;

const updateExtraTracksPanel = () => {
    const container = $('extraTracksContainer');
    const list = $('extraTracksList');
    if (!container || !list) return;
    if (!extraTracksEnabled || extraTracks.length === 0) {
        container.style.display = 'none';
        return;
    }
    container.style.display = '';
    list.innerHTML = '';
    extraTracks.forEach((et, idx) => {
        const isOn = et.muted !== true;
        const btn = document.createElement('button');
        btn.className = 'et-toggle-btn' + (isOn ? ' active' : '');
        btn.dataset.etIdx = idx;
        btn.textContent = (isOn ? '🔊 ' : '🔇 ') + (et.name || `轨道 ${idx + 1}`);
        btn.addEventListener('click', () => toggleExtraTrack(idx));
        list.appendChild(btn);
    });
};

// 切换某条额外轨道的开/关（与播放器面板按钮逻辑一致，供按钮与遥控命令共用）
const toggleExtraTrack = (idx) => {
    if (!extraTracksEnabled) return;
    const et = extraTracks[idx];
    if (!et || !et.gain) return;
    // 不在淡变中途丢弃命令（遥控端可能连续快速切换）：直接按最新目标重设增益斜坡即可。
    const now = audioCtx ? audioCtx.currentTime + 0.02 : 0;
    const fadeEnd = now + EXTRA_TRACK_FADE_DURATION;
    const targetGain = et.muted ? et.volume : 0;
    try {
        et.gain.gain.cancelScheduledValues(now);
        et.gain.gain.setValueAtTime(et.gain.gain.value, now);
        et.gain.gain.linearRampToValueAtTime(targetGain, fadeEnd);
    } catch (_) {}
    et.muted = !et.muted;
    et.switching = true;
    setTimeout(() => { et.switching = false; rcBroadcastState(); }, EXTRA_TRACK_FADE_DURATION * 1000);
    renderExtraTracks();
};

// 设置某条额外轨道的音量（0~1），非静音时实时调整增益；供遥控命令共用
const setExtraTrackVolume = (idx, vol01) => {
    if (!extraTracksEnabled) return;
    const et = extraTracks[idx];
    if (!et) return;
    const v = Math.max(0, Math.min(1, vol01));
    et.volume = v;
    if (!et.muted && et.gain) {
        const now = audioCtx ? audioCtx.currentTime + 0.02 : 0;
        const fadeEnd = now + 0.15;
        try {
            et.gain.gain.cancelScheduledValues(now);
            et.gain.gain.setValueAtTime(et.gain.gain.value, now);
            et.gain.gain.linearRampToValueAtTime(v, fadeEnd);
        } catch (_) {}
    }
    renderExtraTracks();
};

const STYLE_FADE_DURATION = 3.0;

const switchStyle = (styleIdx) => {
    if (!multiStyleMode || !activeTrackCfg) {
        DLog('switchStyle: multi_style not active');
        return;
    }
    if (styleIdx === currentStyleIdx) {
        DLog('switchStyle: same style, ignore');
        return;
    }
    // 允许淡变进行中再次切换目标：清除上一次“完成”定时器后直接对新目标做交叉淡入淡出。
    // 遥控端会连续快速发送切换命令，若直接丢弃会导致状态与高亮不同步。
    if (styleSwitchTimer != null) { clearTimeout(styleSwitchTimer); styleSwitchTimer = null; }

    const oldEntry = styleTracks[currentStyleIdx];
    const newEntry = styleTracks[styleIdx];
    if (!newEntry || !newEntry.styleGain) {
        DLog(`switchStyle: target style ${styleIdx} not loaded yet, ignore`);
        return;
    }

    styleSwitching = true;
    updateStyleButtons();
    DLog(`switchStyle: ${currentStyleIdx} → ${styleIdx} (styleGain crossfade, loop fades unaffected)`);

    const now = audioCtx.currentTime + 0.02;
    const fadeEndTime = now + STYLE_FADE_DURATION;

    if (oldEntry && oldEntry.styleGain) {
        try {
            oldEntry.styleGain.gain.cancelScheduledValues(now);
            oldEntry.styleGain.gain.setValueAtTime(oldEntry.styleGain.gain.value, now);
            oldEntry.styleGain.gain.linearRampToValueAtTime(0.0, fadeEndTime);
        } catch(e) { DLog('switchStyle fade-out err', e.message); }
    }

    try {
        newEntry.styleGain.gain.cancelScheduledValues(now);
        newEntry.styleGain.gain.setValueAtTime(newEntry.styleGain.gain.value, now);
        newEntry.styleGain.gain.linearRampToValueAtTime(1.0, fadeEndTime);
    } catch(e) { DLog('switchStyle fade-in err', e.message); }

    currentStyleIdx = styleIdx;
    const ae = styleTracks[currentStyleIdx];
    currentTrack = ae.current;
    nextTrack = ae.next;

    renderMarkers();
    rcBroadcastState();

    (async () => {
        try {
            let styleSameLyrics = false;
            if (styleIdx >= 0) {
                const style = activeTrackCfg.styles[styleIdx];
                if (style && style.same_lyrics) {
                    styleSameLyrics = true;
                }
            }
            if (styleSameLyrics) {
                DLog(`style ${styleIdx}: same_lyrics=true, skip lyrics switch`);
                return;
            }
            let styleFilename, styleDirId, styleCfg;
            if (styleIdx === -1) {
                styleFilename = activeTrackCfg.filename;
                styleDirId = activeTrackCfg.bgm_dir_id || '';
                styleCfg = activeTrackCfg;
            } else {
                const style = activeTrackCfg.styles[styleIdx];
                if (!style) return;
                styleFilename = style.filename || activeTrackCfg.filename;
                styleDirId = style.bgm_dir_id || activeTrackCfg.bgm_dir_id || '';
                styleCfg = {
                    ...activeTrackCfg,
                    filename: styleFilename,
                    bgm_dir_id: styleDirId,
                    audio_zero_bar: style.audio_zero_bar != null ? style.audio_zero_bar : activeTrackCfg.audio_zero_bar,
                    audio_zero_beat: style.audio_zero_beat != null ? style.audio_zero_beat : activeTrackCfg.audio_zero_beat,
                    bpm: style.bpm || activeTrackCfg.bpm,
                    beats_per_bar: style.beats_per_bar || activeTrackCfg.beats_per_bar,
                    tempo_changes: style.tempo_changes || activeTrackCfg.tempo_changes || [],
                    meter_changes: style.meter_changes || activeTrackCfg.meter_changes || [],
                };
            }
            const newLyrics = await loadLyrics(styleCfg, false);
            if (currentStyleIdx !== styleIdx) return;
            lyricLines = newLyrics;
            syncLyricCacheToMain();
            activeLyricIndex = -1;
            lastDesktopLyricLineIdx = -1;
            updateLyricDisplay();
            DLog(`style ${styleIdx} lyrics loaded: ${newLyrics.length} lines`);
        } catch(e) {
            DLog('style switch lyrics load failed:', e.message);
        }
    })();

    startUiTicker();

    styleSwitchTimer = setTimeout(() => {
        styleSwitchTimer = null;
        styleSwitching = false;
        updateStyleButtons();
        rcBroadcastState();
        DLog(`switchStyle: COMPLETE (styleGain ${currentStyleIdx} active, ${(STYLE_FADE_DURATION * 1000).toFixed(0)}ms)`);
    }, STYLE_FADE_DURATION * 1000);
};

const breakLoop = () => {
    if (!currentTrack || !audioBuffer || loopBroken) return;

    // 如果配置了收尾音频，执行收尾淡入淡出
    if (endingEnabled && endingBuffer && !endingPlaying) {
        playEnding();
        return;
    }

    loopBroken = true;

    clearTimeout(loopSchedulerTimer);
    loopSchedulerTimer = null;

    if (multiStyleMode) {
        for (const sIdx in styleTracks) {
            const entry = styleTracks[sIdx];
            if (entry) {
                if (entry.current && entry.current.source) {
                    try { entry.current.source.loop = false; } catch(_) {}
                }
            }
        }
    } else {
        const raw = getRawPlaybackPos(currentTrack);
        if (raw >= audioDurS - 0.05) return;
        if (currentTrack && currentTrack.source) {
            try { currentTrack.source.loop = false; } catch(_) {}
        }
    }

    fadeOutS = 0;
    loopEndS = audioDurS;
    loopDurS = Math.max(0, loopEndS - loopStartS);

    // 同步新的循环参数到主进程，避免桌面歌词仍按旧循环段做回绕计算
    // （跳出循环后 loopEndS=audioDurS，loopDurS=整曲剩余长度，主进程模运算不再回绕）
    syncLyricCacheToMain();

    const btn = $('breakLoopBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '✓ 已跳出循环';
    }
    const flBtn = $('fullLoopBtn');
    if (flBtn) flBtn.disabled = true;

    DLog(`breakLoop: loop disabled, natural end at ${audioDurS.toFixed(3)}s`);
};

const playEnding = () => {
    if (!endingEnabled || !endingBuffer || endingPlaying) return;
    if (!audioCtx || !masterGain) return;

    endingPlaying = true;
    loopBroken = true;

    clearTimeout(loopSchedulerTimer);
    loopSchedulerTimer = null;

    const fadeDur = Number(activeTrackCfg.ending_fade_duration) || 2.0;
    const now = audioCtx.currentTime + 0.02;
    const fadeEndAt = now + fadeDur;
    const endingStartAt = now + 1.0;

    // 1. 所有循环音轨淡出（主轨、人声轨、额外轨道、多风格轨）
    const fadeOutTrack = (trk) => {
        if (!trk || !trk.gain) return;
        try {
            trk.gain.gain.cancelScheduledValues(now);
            trk.gain.gain.setValueAtTime(trk.gain.gain.value, now);
            trk.gain.gain.linearRampToValueAtTime(0.0, fadeEndAt);
        } catch(_) {}
    };

    if (multiStyleMode) {
        for (const sIdx in styleTracks) {
            const entry = styleTracks[sIdx];
            if (!entry) continue;
            if (entry.current) {
                try { if (entry.current.source) entry.current.source.loop = false; } catch(_) {}
                fadeOutTrack(entry.current);
            }
            if (entry.next) {
                try { if (entry.next.source) entry.next.source.loop = false; } catch(_) {}
                fadeOutTrack(entry.next);
            }
        }
    } else {
        try { if (currentTrack && currentTrack.source) currentTrack.source.loop = false; } catch(_) {}
        fadeOutTrack(currentTrack);
        fadeOutTrack(nextTrack);
    }

    // 额外轨道淡出
    extraTracks.forEach(et => {
        if (et.track) {
            try { if (et.track.source) et.track.source.loop = false; } catch(_) {}
            fadeOutTrack(et.track);
        }
    });

    // 2. 收尾音频直接播放（不淡入）
    endingGain = audioCtx.createGain();
    endingGain.gain.value = 1.0;
    endingGain.connect(configGainNode || masterGain);

    endingTrack = createTrack('ending');
    const ok = playSegmentAt(endingTrack, 0, endingStartAt, {
        enableLoop: false,
        initialGain: 1.0,
        buffer: endingBuffer,
        connectTo: endingGain,
    });

    // 3. 更新按钮
    const btn = $('breakLoopBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '🎵 收尾中…';
    }

    // 4. 淡出完成后清理旧轨道
    setTimeout(() => {
        // 停止并断开所有已淡出的循环轨道
        if (multiStyleMode) {
            for (const sIdx in styleTracks) {
                const entry = styleTracks[sIdx];
                if (!entry) continue;
                for (const tk of [entry.current, entry.next]) {
                    if (tk) {
                        try { if (tk.source) tk.source.stop(); } catch(_){}
                        try { if (tk.source) tk.source.disconnect(); } catch(_){}
                        try { if (tk.gain) tk.gain.disconnect(); } catch(_){}
                    }
                }
            }
            styleTracks = {};
        } else {
            if (currentTrack) {
                try { if (currentTrack.source) currentTrack.source.stop(); } catch(_){}
                try { if (currentTrack.source) currentTrack.source.disconnect(); } catch(_){}
                try { if (currentTrack.gain) currentTrack.gain.disconnect(); } catch(_){}
            }
            if (nextTrack) {
                try { if (nextTrack.source) nextTrack.source.stop(); } catch(_){}
                try { if (nextTrack.source) nextTrack.source.disconnect(); } catch(_){}
                try { if (nextTrack.gain) nextTrack.gain.disconnect(); } catch(_){}
            }
            currentTrack = null;
            nextTrack = null;
        }
        extraTracks.forEach(et => {
            if (et.track) {
                try { if (et.track.source) et.track.source.stop(); } catch(_){}
                try { if (et.track.source) et.track.source.disconnect(); } catch(_){}
                try { if (et.track.gain) et.track.gain.disconnect(); } catch(_){}
            }
            if (et.gain) { try { et.gain.disconnect(); } catch(_){} }
        });
        extraTracks = [];
        extraTracksEnabled = false;
        audioBuffer = null;

        if (btn) btn.textContent = '✓ 已收尾';
        DLog('playEnding: crossfade complete, old tracks cleaned up');
    }, fadeDur * 1000 + 100);

    DLog(`playEnding: starting ${fadeDur.toFixed(1)}s crossfade to ending audio`);
};

const toggleFullLoop = () => {
    if (!currentTrack || !audioBuffer || fullLoopSwitching) return;
    if (!activeTrackCfg) return;

    fullLoopSwitching = true;

    const goingToFull = !isFullLoopMode;

    // 切换到完整循环：只改循环范围，不创建新轨道，当前轨道继续播放
    if (goingToFull) {
        if (!window._savedLoopParams) {
            window._savedLoopParams = {
                loopStartS, loopEndS, loopDurS, fadeInS, fadeOutS,
            };
        }
        loopStartS = 0;
        loopEndS = audioDurS;
        loopDurS = loopEndS - loopStartS;
        fadeInS = 0;
        fadeOutS = 0;

        // 多风格模式：同步更新各风格的循环范围
        if (multiStyleMode) {
            for (const sIdx in styleTracks) {
                const entry = styleTracks[sIdx];
                if (!entry) continue;
                const offsetDiff = entry.offsetDiff || 0;
                entry.loopStartS = Math.max(0, offsetDiff);
                entry.loopEndS = Math.max(entry.loopStartS + 0.01, audioDurS + offsetDiff);
            }
        }

        isFullLoopMode = true;
        fullLoopSwitching = false;

        const flBtn = $('fullLoopBtn');
        if (flBtn) flBtn.textContent = '↩️ 返回循环段';

        clearTimeout(loopSchedulerTimer);
        loopSchedulerTimer = null;
        scheduleNextLoop();

        // 同步完整循环参数到主进程，避免桌面歌词仍按旧循环段回绕
        syncLyricCacheToMain();

        DLog('toggleFullLoop: switched to full loop mode (no track change)');
        return;
    }

    // 以下为「返回循环段」逻辑
    const curRaw = getRawPlaybackPos(currentTrack);
    const fadeDurCfg = Number(activeTrackCfg.full_loop_fade_duration) || 2.0;

    const origLoopStart = window._savedLoopParams ? window._savedLoopParams.loopStartS : loopStartS;
    const origLoopEnd = window._savedLoopParams ? window._savedLoopParams.loopEndS : loopEndS;
    const origFadeIn = window._savedLoopParams ? window._savedLoopParams.fadeInS : fadeInS;
    const origFadeOut = window._savedLoopParams ? window._savedLoopParams.fadeOutS : fadeOutS;

    const inLoopSeg = curRaw >= origLoopStart - 0.01 && curRaw <= origLoopEnd + 0.01;

    // ========== 在循环段范围内：直接改循环参数，不换轨道 ==========
    if (inLoopSeg) {
        loopStartS = origLoopStart;
        loopEndS = origLoopEnd;
        loopDurS = loopEndS - loopStartS;
        fadeInS = origFadeIn;
        fadeOutS = origFadeOut;
        window._savedLoopParams = null;

        // 单轨模式：改当前轨道的 loop 属性
        if (!multiStyleMode) {
            [currentTrack, nextTrack].forEach(tk => {
                if (tk && tk.source) {
                    try {
                        tk.source.loopStart = loopStartS;
                        tk.source.loopEnd = loopEndS;
                    } catch(_) {}
                }
            });
        } else {
            // 多风格模式：改每个风格的轨道 loop 属性
            for (const sIdx in styleTracks) {
                const entry = styleTracks[sIdx];
                if (!entry) continue;
                const offsetDiff = entry.offsetDiff || 0;
                const sLoopStart = Math.max(0, loopStartS + offsetDiff);
                const sLoopEnd = Math.max(sLoopStart + 0.01, loopEndS + offsetDiff);
                entry.loopStartS = sLoopStart;
                entry.loopEndS = sLoopEnd;
                [entry.current, entry.next].forEach(tk => {
                    if (tk && tk.source) {
                        try {
                            tk.source.loopStart = sLoopStart;
                            tk.source.loopEnd = sLoopEnd;
                        } catch(_) {}
                    }
                });
            }
        }

        // 额外轨道：改 loop 属性
        if (extraTracksEnabled && extraTracks.length > 0) {
            const timePerBeat = 60.0 / activeTrackCfg.bpm * activeTrackNvf;
            const defZeroOffset = ((activeTrackCfg.audio_zero_bar - 1) * (activeTrackCfg.beats_per_bar || 4) + (activeTrackCfg.audio_zero_beat - 1)) * timePerBeat;
            extraTracks.forEach(et => {
                if (!et.buffer || !et.gain || !et.track) return;
                const azb = et.audio_zero_bar != null ? et.audio_zero_bar : activeTrackCfg.audio_zero_bar || 1;
                const azbt = et.audio_zero_beat != null ? et.audio_zero_beat : activeTrackCfg.audio_zero_beat || 1;
                const zOffset = ((azb - 1) * (activeTrackCfg.beats_per_bar || 4) + (azbt - 1)) * timePerBeat;
                const offsetDiff = defZeroOffset - zOffset;
                const etLoopStart = Math.max(0, loopStartS + offsetDiff);
                const etLoopEnd = Math.max(etLoopStart + 0.01, loopEndS + offsetDiff);
                [et.track, et.nextTrack].forEach(tk => {
                    if (tk && tk.source) {
                        try {
                            tk.source.loopStart = etLoopStart;
                            tk.source.loopEnd = etLoopEnd;
                        } catch(_) {}
                    }
                });
            });
        }

        isFullLoopMode = false;
        fullLoopSwitching = false;

        const flBtn = $('fullLoopBtn');
        if (flBtn) flBtn.textContent = '🔄 完整循环';

        clearTimeout(loopSchedulerTimer);
        loopSchedulerTimer = null;
        scheduleNextLoop();

        DLog('toggleFullLoop: back to segment loop (in range, no track change)');
        return;
    }

    // 循环提示音效：计算预淡入起点
    let fadeInStartOffset = origLoopStart;
    let sfxFadeDur = fadeDurCfg;
    if (loopSfxEnabled && loopSfxBuffer) {
        const timePerBeat = 60.0 / activeTrackCfg.bpm * activeTrackNvf;
        const fadeInBeats = Number(activeTrackCfg.loop_sfx_fade_in_beats) || 4;
        const fadeInSec = fadeInBeats * timePerBeat;
        fadeInStartOffset = Math.max(0, origLoopStart - fadeInSec);
        sfxFadeDur = fadeInSec;
    }

    // 范围外：交叉淡入淡出切换
    const targetStartOffset = fadeInStartOffset;
    const fadeDur = sfxFadeDur;
    const now = audioCtx.currentTime + 0.02;

    // 先淡出1秒，然后新轨道+音效同时开始淡入
    const FADE_OUT_DUR = 1.0;
    const fadeOutEndAt = now + FADE_OUT_DUR;
    const fadeInStartAt = fadeOutEndAt;
    const fadeEndAt = fadeInStartAt + fadeDur;

    // 目标循环范围（主轨视角）
    const targetLoopStart = origLoopStart;
    const targetLoopEnd = origLoopEnd;

    // 播放循环提示音效（与新轨道同时开始，即淡出完成后）
    if (loopSfxEnabled && loopSfxBuffer) {
        if (!loopSfxGain) {
            loopSfxGain = audioCtx.createGain();
            loopSfxGain.gain.value = 1.0;
            loopSfxGain.connect(configGainNode || masterGain);
        }
        const sfxTrack = createTrack('loop-sfx');
        playSegmentAt(sfxTrack, 0, fadeInStartAt, {
            enableLoop: false,
            initialGain: 1.0,
            buffer: loopSfxBuffer,
            connectTo: loopSfxGain,
        });
        DLog('toggleFullLoop: loop sfx scheduled at ' + fadeInStartAt.toFixed(3));
    }

    const fadeOutTrack = (trk) => {
        if (!trk || !trk.gain) return;
        try {
            trk.gain.gain.cancelScheduledValues(now);
            trk.gain.gain.setValueAtTime(trk.gain.gain.value, now);
            trk.gain.gain.linearRampToValueAtTime(0.0, fadeOutEndAt);
        } catch(_) {}
    };

    // 1. 主轨 / 多风格轨道切换
    let newMainTrack = null;
    let newNextTrack = null;
    const newStyleTracks = {};

    if (multiStyleMode) {
        // 多风格模式：每个风格都做切换
        for (const sIdx in styleTracks) {
            const entry = styleTracks[sIdx];
            if (!entry) continue;

            const offsetDiff = entry.offsetDiff || 0;
            const sLoopStart = Math.max(0, targetLoopStart + offsetDiff);
            const sLoopEnd = Math.max(sLoopStart + 0.01, targetLoopEnd + offsetDiff);
            const sStartOffset = Math.max(0, fadeInStartOffset + offsetDiff);

            const trackA = createTrack(`full-fl-${sIdx}-A`);
            const trackB = createTrack(`full-fl-${sIdx}-B`);
            const ok = playSegmentAt(trackA, sStartOffset, fadeInStartAt, {
                enableLoop: false,
                initialGain: 0.0,
                buffer: entry.buffer,
                connectTo: entry.styleGain,
            });

            if (ok) {
                try {
                    trackA.gain.gain.cancelScheduledValues(fadeInStartAt);
                    trackA.gain.gain.setValueAtTime(0.0, fadeInStartAt);
                    trackA.gain.gain.linearRampToValueAtTime(1.0, fadeEndAt);
                } catch(_) {}
            }

            // 旧轨道淡出
            if (entry.current) fadeOutTrack(entry.current);
            if (entry.next) fadeOutTrack(entry.next);

            newStyleTracks[sIdx] = {
                ...entry,
                current: ok ? trackA : entry.current,
                next: trackB,
                loopStartS: sLoopStart,
                loopEndS: sLoopEnd,
            };
        }

        // 默认风格的 current 作为主轨引用
        const defEntry = newStyleTracks[-1] || newStyleTracks[0];
        if (defEntry) {
            newMainTrack = defEntry.current;
            newNextTrack = defEntry.next;
        }
    } else {
        // 单轨模式
        newMainTrack = createTrack('seg-main');
        newNextTrack = createTrack('seg-main-b');
        const ok = playSegmentAt(newMainTrack, targetStartOffset, fadeInStartAt, {
            enableLoop: true,
            initialGain: 0.0,
            buffer: audioBuffer,
            connectTo: masterGain,
            loopStart: targetLoopStart,
            loopEnd: targetLoopEnd,
        });

        if (ok) {
            try {
                newMainTrack.gain.gain.cancelScheduledValues(fadeInStartAt);
                newMainTrack.gain.gain.setValueAtTime(0.0, fadeInStartAt);
                newMainTrack.gain.gain.linearRampToValueAtTime(1.0, fadeEndAt);
            } catch(_) {}
        }

        fadeOutTrack(currentTrack);
        fadeOutTrack(nextTrack);
    }

    // 2. 额外轨道同步切换
    const newExtraTracks = [];
    if (extraTracksEnabled && extraTracks.length > 0) {
        const timePerBeat = 60.0 / activeTrackCfg.bpm * activeTrackNvf;
        const defZeroOffset = ((activeTrackCfg.audio_zero_bar - 1) * (activeTrackCfg.beats_per_bar || 4) + (activeTrackCfg.audio_zero_beat - 1)) * timePerBeat;

        extraTracks.forEach((et, etIdx) => {
            if (!et.buffer || !et.gain) {
                newExtraTracks.push(et);
                return;
            }
            const azb = et.audio_zero_bar != null ? et.audio_zero_bar : activeTrackCfg.audio_zero_bar || 1;
            const azbt = et.audio_zero_beat != null ? et.audio_zero_beat : activeTrackCfg.audio_zero_beat || 1;
            const zOffset = ((azb - 1) * (activeTrackCfg.beats_per_bar || 4) + (azbt - 1)) * timePerBeat;
            const offsetDiff = defZeroOffset - zOffset;
            const etStartOffset = Math.max(0, fadeInStartOffset + offsetDiff);

            const etTargetGain = et.muted ? 0.0 : 1.0;

            const newEtTrack = createTrack(`seg-et-${etIdx}`);
            const etok = playSegmentAt(newEtTrack, etStartOffset, fadeInStartAt, {
                enableLoop: true,
                initialGain: 0.0,
                buffer: et.buffer,
                connectTo: et.gain,
                loopStart: Math.max(0, targetLoopStart + offsetDiff),
                loopEnd: Math.max(0.01, targetLoopEnd + offsetDiff),
            });

            if (etok) {
                try {
                    newEtTrack.gain.gain.cancelScheduledValues(fadeInStartAt);
                    newEtTrack.gain.gain.setValueAtTime(0.0, fadeInStartAt);
                    newEtTrack.gain.gain.linearRampToValueAtTime(etTargetGain, fadeEndAt);
                } catch(_) {}
            }
            if (etok) newEtTrack.offsetDiff = offsetDiff;

            if (et.track) fadeOutTrack(et.track);

            newExtraTracks.push({
                ...et,
                track: etok ? newEtTrack : et.track,
            });
        });
    }

    // 3. 恢复原始循环参数
    loopStartS = origLoopStart;
    loopEndS = origLoopEnd;
    loopDurS = loopEndS - loopStartS;
    fadeInS = origFadeIn;
    fadeOutS = origFadeOut;
    window._savedLoopParams = null;

    // 同步恢复后的循环参数到主进程，桌面歌词按原循环段回绕
    syncLyricCacheToMain();

    // 4. 更新按钮状态
    const flBtn = $('fullLoopBtn');
    if (flBtn) {
        flBtn.disabled = true;
        flBtn.textContent = '🔄 完整循环';
    }

    // 5. 切换完成后替换并清理（淡出1秒 + 淡入fadeDur秒）
    const totalWaitMs = (FADE_OUT_DUR + fadeDur) * 1000 + 50;
    setTimeout(() => {
        if (multiStyleMode) {
            // 清理旧风格轨道
            for (const sIdx in styleTracks) {
                const entry = styleTracks[sIdx];
                if (!entry) continue;
                for (const tk of [entry.current, entry.next]) {
                    if (tk) {
                        try { if (tk.source) tk.source.stop(); } catch(_){}
                        try { if (tk.source) tk.source.disconnect(); } catch(_){}
                        try { if (tk.gain) tk.gain.disconnect(); } catch(_){}
                    }
                }
            }
            styleTracks = newStyleTracks;
            const defEntry = styleTracks[-1] || styleTracks[0];
            if (defEntry) {
                currentTrack = defEntry.current;
                nextTrack = defEntry.next;
            }
        } else {
            // 清理旧主轨
            if (currentTrack) {
                try { if (currentTrack.source) currentTrack.source.stop(); } catch(_){}
                try { if (currentTrack.source) currentTrack.source.disconnect(); } catch(_){}
                try { if (currentTrack.gain) currentTrack.gain.disconnect(); } catch(_){}
            }
            if (nextTrack) {
                try { if (nextTrack.source) nextTrack.source.stop(); } catch(_){}
                try { if (nextTrack.source) nextTrack.source.disconnect(); } catch(_){}
                try { if (nextTrack.gain) nextTrack.gain.disconnect(); } catch(_){}
            }
            currentTrack = newMainTrack;
            nextTrack = newNextTrack;
        }

        // 清理旧额外轨道并替换
        if (newExtraTracks.length > 0) {
            extraTracks.forEach((et, i) => {
                if (et.track && newExtraTracks[i] && newExtraTracks[i].track !== et.track) {
                    try { if (et.track.source) et.track.source.stop(); } catch(_){}
                    try { if (et.track.source) et.track.source.disconnect(); } catch(_){}
                    try { if (et.track.gain) et.track.gain.disconnect(); } catch(_){}
                }
            });
            extraTracks = newExtraTracks;
        }

        isFullLoopMode = false;
        fullLoopSwitching = false;

        if (flBtn) {
            flBtn.disabled = false;
            flBtn.textContent = '🔄 完整循环';
        }

        // 重新调度循环
        clearTimeout(loopSchedulerTimer);
        loopSchedulerTimer = null;
        scheduleNextLoop();

        DLog(`toggleFullLoop: COMPLETE (mode=segment, crossfade, fadeOut=${FADE_OUT_DUR}s, fadeIn=${fadeDur.toFixed(2)}s, multiStyle=${multiStyleMode})`);
    }, totalWaitMs);
};

const STOP_FADE_DURATION = 2.0;

const PAUSE_FADE_DURATION = 0.4;

const updatePauseButton = () => {
    const btn = $('pauseBtn');
    if (!btn) return;
    if (isPaused) {
        btn.textContent = '▶ 继续';
        btn.classList.add('active');
    } else {
        btn.textContent = '⏸ 暂停';
        btn.classList.remove('active');
    }
    btn.disabled = !(currentTrack && currentTrack.source);
};

// 暂停：淡出后 suspend 上下文，冻结播放位置（类似原神战斗结束淡出暂停）
const pausePlayback = async () => {
    if (!currentTrack || !audioCtx || isPaused) return;
    if (!currentTrack.source) return;
    isPaused = true;
    updatePauseButton();
    if (currentPlayingIdx >= 0) refreshTrackButton(currentPlayingIdx);
    rcBroadcastState();
    try {
        const now = audioCtx.currentTime;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(masterGain.gain.value, now);
        masterGain.gain.linearRampToValueAtTime(0.0, now + PAUSE_FADE_DURATION);
        await new Promise(resolve => setTimeout(resolve, PAUSE_FADE_DURATION * 1000 + 30));
        // 撤销保护：若淡出期间用户又点了继续，则不 suspend，避免刚恢复又被挂起
        if (!isPaused) return;
        if (audioCtx.state === 'running') {
            await audioCtx.suspend();
        }
        DLog('pausePlayback: paused (ctx suspended)');
    } catch (e) {
        DLog('pausePlayback err:', e.message);
    }
};

// 继续：resume 上下文并淡入，从冻结位置接着播放
const resumePlayback = async () => {
    if (!isPaused || !audioCtx) return;
    try {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        const now = audioCtx.currentTime;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(masterGain.gain.value, now);
        masterGain.gain.linearRampToValueAtTime(currentMasterVolume, now + PAUSE_FADE_DURATION);
    } catch (e) {
        DLog('resumePlayback err:', e.message);
    }
    isPaused = false;
    updatePauseButton();
    if (currentPlayingIdx >= 0) refreshTrackButton(currentPlayingIdx);
    rcBroadcastState();
    scheduleNextLoop();
    DLog('resumePlayback: resumed');
};

const togglePause = async () => {
    if (isPaused) await resumePlayback();
    else await pausePlayback();
};

const stopAll = async () => {
    // 取消可能因无手势而延迟的播放（已停止，不应再启动）
    pendingBeginPlayback = null;
    clearTimeout(loopSchedulerTimer);
    loopSchedulerTimer = null;
    cancelAnimationFrame(rafId);
    rafId = null;

    if (audioCtx && masterGain) {
        // 若处于暂停(suspend)状态，先恢复上下文，否则淡出时钟冻结无法推进
        if (audioCtx.state === 'suspended') {
            try { await audioCtx.resume(); } catch(_){}
        }
        const now = audioCtx.currentTime;
        const fadeEnd = now + STOP_FADE_DURATION;
        try {
            masterGain.gain.cancelScheduledValues(now);
            masterGain.gain.setValueAtTime(masterGain.gain.value, now);
            masterGain.gain.linearRampToValueAtTime(0.0, fadeEnd);
        } catch(_) {}
        await new Promise(resolve => setTimeout(resolve, STOP_FADE_DURATION * 1000));
    }

    if (multiStyleMode) {
        for (const sIdx in styleTracks) {
            const entry = styleTracks[sIdx];
            if (!entry) continue;
            for (const tk of [entry.current, entry.next]) {
                if (tk) {
                    try {
                        if (tk.source) { try { tk.source.stop(); } catch(_){} try { tk.source.disconnect(); } catch(_){} }
                        if (tk.gain) { try { tk.gain.disconnect(); } catch(_){} }
                    } catch(_) {}
                }
            }
            if (entry.styleGain) { try { entry.styleGain.disconnect(); } catch(_){} }
        }
        styleTracks = {};
    }

    if (currentTrack) {
        try {
            if (currentTrack.source) {
                try { currentTrack.source.stop(); } catch(_){}
                try { currentTrack.source.disconnect(); } catch(_){}
            }
            if (currentTrack.gain) { try { currentTrack.gain.disconnect(); } catch(_){} }
        } catch(_) {}
    }
    if (nextTrack) {
        try {
            if (nextTrack.source) {
                try { nextTrack.source.stop(); } catch(_){}
                try { nextTrack.source.disconnect(); } catch(_){}
            }
            if (nextTrack.gain) { try { nextTrack.gain.disconnect(); } catch(_){} }
        } catch(_) {}
    }
    currentTrack = null;
    nextTrack = null;
    audioBuffer = null;
    loopBroken = false;
    multiStyleMode = false;

    extraTracks.forEach(et => {
        if (et.track) {
            try {
                if (et.track.source) { try { et.track.source.stop(); } catch(_){} try { et.track.source.disconnect(); } catch(_){} }
                if (et.track.gain) { try { et.track.gain.disconnect(); } catch(_){} }
            } catch(_) {}
        }
        if (et.gain) { try { et.gain.disconnect(); } catch(_){} }
    });
    extraTracks = [];
    extraTracksEnabled = false;

    if (endingTrack) {
        try {
            if (endingTrack.source) { try { endingTrack.source.stop(); } catch(_){} try { endingTrack.source.disconnect(); } catch(_){} }
            if (endingTrack.gain) { try { endingTrack.gain.disconnect(); } catch(_){} }
        } catch(_) {}
        endingTrack = null;
    }
    if (endingGain) { try { endingGain.disconnect(); } catch(_){} endingGain = null; }
    endingBuffer = null;
    endingEnabled = false;
    endingPlaying = false;

    if (introTrack) {
        try {
            if (introTrack.source) { try { introTrack.source.stop(); } catch(_){} try { introTrack.source.disconnect(); } catch(_){} }
            if (introTrack.gain) { try { introTrack.gain.disconnect(); } catch(_){} }
        } catch(_) {}
        introTrack = null;
    }
    introBuffer = null;
    introEnabled = false;
    introPlaying = false;

    isFullLoopMode = false;
    fullLoopSwitching = false;
    if (window._savedLoopParams) window._savedLoopParams = null;

    isPaused = false;
    updatePauseButton();
    currentPlayingIdx = -1;
    refreshAllTrackButtons();
    rcBroadcastState();

    loopSfxEnabled = false;
    loopSfxBuffer = null;
    if (loopSfxGain) { try { loopSfxGain.disconnect(); } catch(_){} loopSfxGain = null; }

    const breakBtn = $('breakLoopBtn');
    if (breakBtn) {
        breakBtn.disabled = true;
        breakBtn.textContent = '⏭ 跳出循环';
    }
    const flBtn2 = $('fullLoopBtn');
    if (flBtn2) {
        flBtn2.disabled = true;
        flBtn2.style.display = 'none';
        flBtn2.textContent = '🔄 完整循环';
    }
    
    if (audioCtx) {
        try {
            await audioCtx.close();
        } catch(_){}
        audioCtx = null;
        masterGain = null;
    }

    // 清空桌面歌词文本并停止后台推送
    if (window.electronAPI && window.electronAPI.clearDesktopLyric) {
        window.electronAPI.clearDesktopLyric();
    } else if (window.electronAPI && window.electronAPI.updateDesktopLyric) {
        window.electronAPI.updateDesktopLyric({
            text: '',
            translation: '',
            karaoke: [],
            translation_karaoke: [],
            lineEndTime: null,
            currentTime: 0
        });
    }
    // 清空歌词缓存
    syncLyricCacheToMain();
};



let lastBeatIdx = -1;
const updateUi = () => {
    rafId = requestAnimationFrame(updateUi);
    if (!currentTrack || !activeTrackCfg) return;
    // 注：向远程控制器广播进度/状态已移至下方独立的 setInterval，
    // 因为后台标签页中 requestAnimationFrame 会被浏览器暂停，导致遥控端状态冻结。
    const s = currentPlaySec();
    let beatSec = s;
    let uiTotalDur = Math.max(audioDurS || 1, loopEndS || 1);
    if (multiStyleMode && currentStyleIdx >= 0) {
        const entry = styleTracks[currentStyleIdx];
        if (entry) {
            if (entry.offsetDiff != null) beatSec = s - entry.offsetDiff;
            uiTotalDur = Math.max(entry.duration || audioDurS || 1, entry.loopEndS || loopEndS || 1);
        }
    }
    const bb = barBeat(beatSec);
    const formattedBeat = Number(bb.beat.toFixed(2));
    $('curBeat').textContent = `${bb.bar}:${formattedBeat}`;
    $('curMs').textContent = Math.floor(s * 1000).toString();
    $('curSec').textContent = s.toFixed(3);

    const pct = Math.min(99.9, (s / uiTotalDur) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressStart').textContent = fmtTime(0);
    $('progressEnd').textContent = fmtTime(uiTotalDur);

    updateLyricDisplay();
    updateLyricScrollList();

    // 同步音频时间到主进程（主进程用此值 + 墙钟时间插值估算，60fps 推送桌面歌词）
    // 即使窗口最小化后 rAF 被节流，主进程仍能根据最后一次同步值继续零延迟推送
    if (window.electronAPI && window.electronAPI.syncPlaybackState) {
        window.electronAPI.syncPlaybackState({
            audioTime: s,
            wallClock: Date.now()
        });
    }

    const beatIdx = Math.max(0, Math.min(3, Math.floor(bb.beat - 1)));
    if (beatIdx !== lastBeatIdx) {
        for (let i = 1; i <= 4; i++) {
            const dot = $('flashDot' + i);
            if (!dot) continue;
            dot.classList.remove('active', 'first');
            if (i - 1 === beatIdx) {
                dot.classList.add('active');
                if (beatIdx === 0) dot.classList.add('first');
            }
        }
        lastBeatIdx = beatIdx;
    }
};

const startUiTicker = () => {
    cancelAnimationFrame(rafId);
    lastBeatIdx = -1;
    updateUi();
};

const renderMarkers = () => {
    // 完整循环模式下，标记始终显示原始循环段位置
    const savedP = window._savedLoopParams;
    const mLoopStartSrc = (isFullLoopMode && savedP) ? savedP.loopStartS : loopStartS;
    const mLoopEndSrc = (isFullLoopMode && savedP) ? savedP.loopEndS : loopEndS;
    let totalDur = Math.max(audioDurS || 1, mLoopEndSrc || 1);
    let mLoopStart = mLoopStartSrc;
    let mLoopEnd = mLoopEndSrc;
    let mFadeOutStart = fadeOutStartS;
    let mJumpStart = jumpSegStartS;
    let mJumpEnd = jumpSegEndS;
    if (multiStyleMode && currentStyleIdx >= 0) {
        const entry = styleTracks[currentStyleIdx];
        if (entry) {
            // 多风格模式下也用原始循环范围显示标记
            const eLoopStart = (isFullLoopMode && savedP) ? Math.max(0, savedP.loopStartS + (entry.offsetDiff || 0)) : (entry.loopStartS || loopStartS);
            const eLoopEnd = (isFullLoopMode && savedP) ? Math.max(eLoopStart + 0.01, savedP.loopEndS + (entry.offsetDiff || 0)) : (entry.loopEndS || loopEndS);
            totalDur = Math.max(entry.duration || audioDurS || 1, eLoopEnd || 1);
            mLoopStart = eLoopStart;
            mLoopEnd = eLoopEnd;
            if (entry.offsetDiff != null) {
                mFadeOutStart = fadeOutStartS + entry.offsetDiff;
                mJumpStart = jumpSegEnabled ? Math.max(0, jumpSegStartS + entry.offsetDiff) : 0;
                mJumpEnd = jumpSegEnabled ? Math.max(0, jumpSegEndS + entry.offsetDiff) : 0;
            }
        }
    }
    const clampPct = (p) => Math.max(0, Math.min(99.9, p));
    const lpct = clampPct((mLoopStart / totalDur) * 100);
    const lepct = clampPct((mLoopEnd / totalDur) * 100);
    if (lepct - lpct < 0.5) {
        $('markerLoopEnd').style.left = clampPct(lpct + 0.5) + '%';
    } else {
        $('markerLoopEnd').style.left = lepct + '%';
    }
    $('markerLoopStart').style.left = lpct + '%';
    $('markerLoopStart').title = `循环起点 ${fmtTime(mLoopStart)} (${activeTrackCfg.loop_start_bar}:${activeTrackCfg.loop_start_beat})`;
    $('markerLoopEnd').title = `循环终点 ${fmtTime(mLoopEnd)} (${activeTrackCfg.loop_end_bar}:${activeTrackCfg.loop_end_beat})`;

    if ($('markerFadeOut')) {
        if (fadeOutS > 0.0002) {
            const fospct = clampPct((mFadeOutStart / totalDur) * 100);
            $('markerFadeOut').style.left = fospct + '%';
            $('markerFadeOut').style.display = 'block';
            const fosTitle = fadeOutAuto
                ? `淡出起点 ${fmtTime(mFadeOutStart)} (自动：淡出结束对齐循环终点)`
                : `淡出起点 ${fmtTime(mFadeOutStart)} (${activeTrackCfg.fade_out_start_bar}:${activeTrackCfg.fade_out_start_beat || 1})`;
            $('markerFadeOut').title = fosTitle;
        } else {
            $('markerFadeOut').style.display = 'none';
        }
    }
    if ($('markerJumpSegStart')) {
        if (jumpSegEnabled) {
            const jsspct = clampPct((mJumpStart / totalDur) * 100);
            $('markerJumpSegStart').style.left = jsspct + '%';
            $('markerJumpSegStart').style.display = 'block';
            $('markerJumpSegStart').title = `跳转段起点 ${fmtTime(mJumpStart)} (${activeTrackCfg.jump_seg_start_bar}:${activeTrackCfg.jump_seg_start_beat})`;
        } else {
            $('markerJumpSegStart').style.display = 'none';
        }
    }
    if ($('markerJumpSegEnd')) {
        if (jumpSegEnabled) {
            const jsepct = clampPct((mJumpEnd / totalDur) * 100);
            $('markerJumpSegEnd').style.left = jsepct + '%';
            $('markerJumpSegEnd').style.display = 'block';
            $('markerJumpSegEnd').title = `跳转段终点 ${fmtTime(mJumpEnd)} (${activeTrackCfg.jump_seg_end_bar}:${activeTrackCfg.jump_seg_end_beat})`;
        } else {
            $('markerJumpSegEnd').style.display = 'none';
        }
    }
};

const updateInfoPanel = (idx) => {
    const cfg = config.tracks[idx];
    if (!cfg) return;
    const modeTag = cfg.loop_mode === 'dual' ? ' [双轨]' : ' [单轨]';
    $('trackName').textContent = cfg.name + modeTag;
    $('trackBpm').textContent = `BPM: ${cfg.bpm}`;
    $('trackSig').textContent = `拍号: ${cfg.beats_per_bar}/${window.BeatUtils.noteValueDenom(cfg.note_value)}`;
    $('loopStartInfo').textContent = `${cfg.loop_start_bar}:${cfg.loop_start_beat}`;
    $('loopEndInfo').textContent = `${cfg.loop_end_bar}:${cfg.loop_end_beat}`;
    $('loopLenInfo').textContent = (loopDurS || 0).toFixed(3) + 's';

    const jsInfo = $('jumpSegInfo');
    if (jsInfo) {
        const jssBar = +cfg.jump_seg_start_bar || 0;
        const jseBar = +cfg.jump_seg_end_bar || 0;
        if (jssBar >= 1 && jseBar >= 1) {
            jsInfo.style.display = '';
            jsInfo.innerHTML = `<span class="loop-label">跳转段</span>
                <span class="loop-val">${cfg.jump_seg_start_bar}:${cfg.jump_seg_start_beat} → ${cfg.jump_seg_end_bar}:${cfg.jump_seg_end_beat}</span>`;
        } else {
            jsInfo.style.display = 'none';
        }
    }
};

const updateStyleButtons = () => {
    const container = $('styleButtons');
    if (!container) return;
    
    const cfg = activeTrackCfg;
    if (!cfg || !cfg.multi_style_enabled || !Array.isArray(cfg.styles) || cfg.styles.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = '';
    container.innerHTML = '';
    
    const defaultBtn = document.createElement('button');
    defaultBtn.className = `btn style-btn ${currentStyleIdx === -1 ? 'style-active' : ''}`;
    defaultBtn.textContent = '默认';
    defaultBtn.disabled = styleSwitching;
    defaultBtn.addEventListener('click', () => switchStyle(-1));
    container.appendChild(defaultBtn);
    
    cfg.styles.forEach((style, idx) => {
        const btn = document.createElement('button');
        btn.className = `btn style-btn ${idx === currentStyleIdx ? 'style-active' : ''}`;
        btn.textContent = style.name || `风格 ${idx + 1}`;
        btn.disabled = styleSwitching;
        btn.addEventListener('click', () => switchStyle(idx));
        container.appendChild(btn);
    });
};

const renderTrackList = () => {
    const list = $('trackList');
    list.innerHTML = '';

    const groups = new Map();
    config.tracks.forEach((cfg, idx) => {
        const cat = (cfg.category || '未分类').toString().trim() || '未分类';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push({ cfg, idx });
    });

    const categoryOrder = Array.from(groups.keys()).sort((a, b) => {
        if (a === '未分类') return 1;
        if (b === '未分类') return -1;
        return a.localeCompare(b, 'zh-CN');
    });

    categoryOrder.forEach((catName) => {
        const items = groups.get(catName) || [];
        const groupEl = document.createElement('div');
        groupEl.className = 'track-group collapsible-group collapsed';
        groupEl.dataset.category = catName;

        const headerEl = document.createElement('div');
        headerEl.className = 'group-header';
        headerEl.innerHTML = `
            <span class="group-arrow">▸</span>
            <span class="group-title">${escapeHtml(catName)}</span>
            <span class="group-count">${items.length}</span>
        `;

        const wrapEl = document.createElement('div');
        wrapEl.className = 'group-body-wrap';
        const innerEl = document.createElement('div');
        innerEl.className = 'group-body-inner';
        const bodyEl = document.createElement('div');
        bodyEl.className = 'group-body';

        items.forEach(({ cfg, idx }) => {
            const el = document.createElement('div');
            el.className = 'track-item';
            el.dataset.trackIdx = String(idx);
            const ls = secFromBarBeatWrap(cfg, cfg.loop_start_bar, cfg.loop_start_beat);
            const le = secFromBarBeatWrap(cfg, cfg.loop_end_bar, cfg.loop_end_beat);
            const dur = Math.max(0, le - ls);
            const modeTag = cfg.loop_mode === 'dual' ? ' · 双轨' : ' · 单轨';
            el.innerHTML = `
                <div class="idx">${idx + 1}</div>
                <div class="info">
                    <div class="t-name">${escapeHtml(cfg.name)}</div>
                    <div class="t-meta">${cfg.bpm} BPM${modeTag} · ${cfg.loop_start_bar}:${cfg.loop_start_beat} → ${cfg.loop_end_bar}:${cfg.loop_end_beat} · 循环${dur.toFixed(2)}s</div>
                </div>
                <button class="preload-btn" data-idx="${idx}" title="预加载（点击后再播放无需等待）">⏬</button>
            `;
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('preload-btn')) {
                    e.stopPropagation();
                    preloadTrack(idx);
                    return;
                }
                playTrack(idx);
                if (isMobileBreakpoint()) closeDrawer();
            });
            bodyEl.appendChild(el);
            if (preloadedTracks[idx]) markPreloadState(idx, 'done');
        });

        headerEl.addEventListener('click', () => {
            const nowCollapsed = groupEl.classList.contains('collapsed');
            if (nowCollapsed) groupEl.classList.remove('collapsed');
            else groupEl.classList.add('collapsed');
            animateGroupHeight(groupEl, !nowCollapsed);
        });

        innerEl.appendChild(bodyEl);
        wrapEl.appendChild(innerEl);
        groupEl.appendChild(headerEl);
        groupEl.appendChild(wrapEl);
        list.appendChild(groupEl);
    });
    // 列表重建后统一刷新右侧按钮状态（预载/播放中），确保元素已在 DOM 中
    refreshAllTrackButtons();
};

const animateGroupHeight = (groupEl, toCollapsed) => {
    const wrapEl = groupEl.querySelector(':scope > .group-body-wrap');
    const innerEl = groupEl.querySelector(':scope > .group-body-wrap > .group-body-inner');
    if (!wrapEl || !innerEl) return;
    const duration = 350;
    if (toCollapsed) {
        const current = innerEl.scrollHeight;
        wrapEl.style.height = current + 'px';
        wrapEl.style.gridTemplateRows = '0fr';
        requestAnimationFrame(() => {
            wrapEl.style.height = '0px';
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                wrapEl.style.height = '';
                wrapEl.style.gridTemplateRows = '';
            };
            wrapEl.addEventListener('transitionend', function onEnd(e) {
                if (e.target !== wrapEl || e.propertyName !== 'height') return;
                wrapEl.removeEventListener('transitionend', onEnd);
                finish();
            }, { once: false });
            setTimeout(finish, duration + 30);
        });
    } else {
        wrapEl.style.height = '0px';
        wrapEl.style.gridTemplateRows = '1fr';
        requestAnimationFrame(() => {
            const target = innerEl.scrollHeight;
            wrapEl.style.height = target + 'px';
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                wrapEl.style.gridTemplateRows = '';
                if (wrapEl.style.height) {
                    const actual = innerEl.scrollHeight;
                    wrapEl.style.height = actual + 'px';
                }
            };
            wrapEl.addEventListener('transitionend', function onEnd(e) {
                if (e.target !== wrapEl || e.propertyName !== 'height') return;
                wrapEl.removeEventListener('transitionend', onEnd);
                finish();
            }, { once: false });
            setTimeout(finish, duration + 30);
        });
    }
};

const syncAllExpandedGroupHeights = () => {
    document.querySelectorAll('.track-group:not(.collapsed)').forEach((g) => {
        const wrapEl = g.querySelector(':scope > .group-body-wrap');
        const innerEl = g.querySelector(':scope > .group-body-wrap > .group-body-inner');
        if (!wrapEl || !innerEl) return;
        const h = innerEl.scrollHeight;
        wrapEl.style.height = h + 'px';
        wrapEl.style.gridTemplateRows = '';
    });
};

if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
        if (window.__resizeTimer) clearTimeout(window.__resizeTimer);
        window.__resizeTimer = setTimeout(syncAllExpandedGroupHeights, 120);
    });
}

const expandCategoryForTrack = (trackIdx, shouldScrollIntoView = true) => {
    const cfg = config.tracks[trackIdx];
    if (!cfg) return;
    const catName = (cfg.category || '未分类').toString().trim() || '未分类';
    const groupEl = document.querySelector(`.track-group[data-category="${CSS.escape(catName)}"]`);
    if (!groupEl) return;
    const wasCollapsed = groupEl.classList.contains('collapsed');
    groupEl.classList.remove('collapsed');
    if (wasCollapsed) animateGroupHeight(groupEl, false);
    if (shouldScrollIntoView) {
        const itemEl = groupEl.querySelector(`.track-item[data-track-idx="${trackIdx}"]`);
        if (itemEl) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    try {
                        itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    } catch (e) {
                        itemEl.scrollIntoView(false);
                    }
                });
            });
        }
    }
};

const isMobileBreakpoint = () => {
    if (typeof window.matchMedia === 'function') {
        return window.matchMedia('(max-width: 767px)').matches;
    }
    return window.innerWidth <= 767;
};

const openDrawer = () => {
    if (!isMobileBreakpoint()) return;
    document.body.classList.add('drawer-open');
    const ov = document.getElementById('drawerOverlay');
    if (ov) ov.setAttribute('aria-hidden', 'false');
};
const closeDrawer = () => {
    document.body.classList.remove('drawer-open');
    const ov = document.getElementById('drawerOverlay');
    if (ov) ov.setAttribute('aria-hidden', 'true');
};
const toggleDrawer = () => {
    if (document.body.classList.contains('drawer-open')) closeDrawer();
    else openDrawer();
};

const secFromBarBeatWrap = (cfg, bar, beat) => {
    const bpb = cfg.beats_per_bar || 4;
    const zab = (cfg.audio_zero_bar - 1) * bpb + cfg.audio_zero_beat;
    const targetAbs = (bar - 1) * bpb + beat;
    const remaining = targetAbs - zab;
    
    if (remaining <= 0) return 0;
    
    if (!Array.isArray(cfg.tempo_changes) || cfg.tempo_changes.length === 0) {
        const nvf = window.BeatUtils.noteValueFraction(cfg.note_value);
        const bps = cfg.bpm / 60.0;
        if (bps <= 0) return remaining / (120 / 60.0) * nvf;
        return remaining / bps * nvf;
    }
    
    const filtered = cfg.tempo_changes
        .filter(tc => typeof tc.bar === 'number' && typeof tc.beat === 'number' && typeof tc.bpm === 'number')
        .filter(tc => tc.bar >= 1 && tc.beat >= 1 && tc.bpm > 0)
        .map(tc => {
            const abs = (tc.bar - 1) * bpb + tc.beat;
            return { ...tc, abs };
        })
        .sort((a, b) => a.abs - b.abs);
    
    let time = 0;
    let prevBeat = zab;
    let prevBpm = cfg.bpm;
    
    for (const tc of filtered) {
        if (prevBpm <= 0) prevBpm = cfg.bpm;
        
        if (tc.abs >= targetAbs) {
            const beatsInSegment = targetAbs - prevBeat;
            time += beatsInSegment * (60 / prevBpm) * window.BeatUtils.noteValueFraction(cfg.note_value);
            const result = Math.max(0, time);
            return isNaN(result) ? 0 : result;
        }
        
        const beatsInSegment = tc.abs - prevBeat;
        if (beatsInSegment > 0) {
            time += beatsInSegment * (60 / prevBpm) * window.BeatUtils.noteValueFraction(cfg.note_value);
        }
        
        prevBeat = tc.abs;
        prevBpm = tc.bpm;
    }
    
    if (prevBpm <= 0) prevBpm = cfg.bpm;
    const finalBeats = targetAbs - prevBeat;
    if (finalBeats > 0) {
        time += finalBeats * (60 / prevBpm) * window.BeatUtils.noteValueFraction(cfg.note_value);
    }
    
    const result = Math.max(0, time);
    return isNaN(result) ? 0 : result;
};

const openLyricModal = () => {
    const overlay = $('lyricModalOverlay');
    const title = $('lyricModalTitle');
    const list = $('lyricScrollList');
    if (!overlay || !title || !list) return;
    
    title.textContent = activeTrackCfg?.name || '歌词';
    list.style.transform = 'translateY(0)';
    lastLyricIndex = -1;
    
    if (!lyricLines.length) {
        list.innerHTML = '<div class="lyric-scroll-item empty-line">暂无歌词</div>';
    } else {
        list.innerHTML = lyricLines.map((line, idx) => {
            if (line.is_empty) {
                return '<div class="lyric-scroll-item empty-line"></div>';
            }
            const text = escapeHtml(line.text || '');
            const karaoke = Array.isArray(line.karaoke) ? line.karaoke : [];
            let textHtml = text;
            if (karaoke.length > 0) {
                // 卡拉OK：单 span + CSS 变量 --karaoke-progress 实现平滑逐字填充
                textHtml = `<span class="lyric-karaoke-line" style="--karaoke-progress:0">${text}</span>`;
            }
            const translation = line.translation ? (() => {
                const transKaraoke = Array.isArray(line.translation_karaoke) ? line.translation_karaoke : [];
                let transHtml = escapeHtml(line.translation);
                if (transKaraoke.length > 0) {
                    transHtml = `<span class="lyric-karaoke-line" style="--karaoke-progress:0">${escapeHtml(line.translation)}</span>`;
                }
                return `<div class="translation">${transHtml}</div>`;
            })() : '';
            return `<div class="lyric-scroll-item" data-idx="${idx}" data-time="${line.time_sec}">${textHtml}${translation}</div>`;
        }).join('');
    }
    
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    
    setTimeout(() => {
        if (!lyricLines.length) return;
        
        const s = currentPlaySec();
        let currentIdx = 0;
        while (currentIdx < lyricLines.length - 1 && lyricLines[currentIdx + 1].time_sec <= s) {
            currentIdx += 1;
        }
        
        const items = list.querySelectorAll('.lyric-scroll-item');
        items.forEach((item, idx) => {
            item.classList.remove('active', 'done');
            if (idx === currentIdx) {
                item.classList.add('active');
            } else if (idx < currentIdx) {
                item.classList.add('done');
            }
        });
        
        updateLyricScrollPosition();
    }, 200);
};

const closeLyricModal = () => {
    const overlay = $('lyricModalOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
};

const updateLyricScrollList = () => {
    const list = $('lyricScrollList');
    const container = $('lyricScrollContainer');
    const overlay = $('lyricModalOverlay');
    if (!list || !container || !overlay.classList.contains('active') || !lyricLines.length) return;
    
    const s = currentPlaySec();
    let currentIdx = 0;
    while (currentIdx < lyricLines.length - 1 && lyricLines[currentIdx + 1].time_sec <= s) {
        currentIdx += 1;
    }
    
    const items = list.querySelectorAll('.lyric-scroll-item');

    items.forEach((item, idx) => {
        const karaokeLine = item.querySelector(':scope > .lyric-karaoke-line');
        const transKaraokeLine = item.querySelector('.translation .lyric-karaoke-line');
        if (idx === currentIdx) {
            item.classList.add('active');
            item.classList.remove('done');
            // 更新当前行的卡拉OK进度（平滑逐字填充）——传入真实 DOM 元素启用像素级精确对齐
            const lineEndTime = lyricLines[idx + 1]?.time_sec || null;
            if (karaokeLine && lyricLines[idx] && Array.isArray(lyricLines[idx].karaoke) && lyricLines[idx].karaoke.length > 0) {
                const progress = _computeKaraokeProgress(lyricLines[idx].karaoke, s, lineEndTime, karaokeLine);
                karaokeLine.style.setProperty('--karaoke-progress', progress.toFixed(2));
            }
            if (transKaraokeLine && lyricLines[idx] && Array.isArray(lyricLines[idx].translation_karaoke) && lyricLines[idx].translation_karaoke.length > 0) {
                const transProgress = _computeKaraokeProgress(lyricLines[idx].translation_karaoke, s, lineEndTime, transKaraokeLine);
                transKaraokeLine.style.setProperty('--karaoke-progress', transProgress.toFixed(2));
            }
        } else if (idx < currentIdx) {
            item.classList.remove('active');
            item.classList.add('done');
            if (karaokeLine) karaokeLine.style.setProperty('--karaoke-progress', '100');
            if (transKaraokeLine) transKaraokeLine.style.setProperty('--karaoke-progress', '100');
        } else {
            item.classList.remove('active', 'done');
            if (karaokeLine) karaokeLine.style.setProperty('--karaoke-progress', '0');
            if (transKaraokeLine) transKaraokeLine.style.setProperty('--karaoke-progress', '0');
        }
    });
    
    if (currentIdx !== lastLyricIndex) {
        lastLyricIndex = currentIdx;
        updateLyricScrollPosition();
    }
};

const updateLyricScrollPosition = () => {
    const list = $('lyricScrollList');
    const container = $('lyricScrollContainer');
    if (!list || !container) return;
    
    const activeItem = list.querySelector('.lyric-scroll-item.active');
    if (!activeItem) return;
    
    const itemTop = activeItem.offsetTop;
    const containerHeight = container.clientHeight;
    const itemHeight = activeItem.offsetHeight;
    
    let offset = itemTop - containerHeight / 2 + itemHeight / 2;
    offset = Math.max(0, offset);
    
    const maxOffset = list.offsetHeight - containerHeight + 60;
    offset = Math.min(offset, maxOffset);
    
    list.style.transform = `translateY(-${offset}px)`;
};

let lanQrInstance = null;

const generateLanQR = (url) => {
    const qrContainer = $('lanQr');
    if (!qrContainer) return;
    qrContainer.innerHTML = '';
    if (lanQrInstance) { lanQrInstance.clear && lanQrInstance.clear(); lanQrInstance = null; }
    lanQrInstance = new QRCode(qrContainer, {
        text: url,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
};

const openLanModal = async () => {
    const modal = $('lanModal');
    if (!modal) return;
    modal.style.display = 'flex';

    const ipList = $('lanIpList');
    const qrContainer = $('lanQr');
    ipList.innerHTML = '<div class="lan-ip-item" style="cursor:default;">加载中...</div>';
    qrContainer.innerHTML = '<div class="lan-qr-placeholder">选择地址生成二维码</div>';

    try {
        const r = await fetch('/api/lan_ips');
        const data = await r.json();
        const wifi_ips = data.wifi_ips || [];
        const hotspot_ips = data.hotspot_ips || [];
        const port = data.port || 5001;

        if (wifi_ips.length === 0 && hotspot_ips.length === 0) {
            ipList.innerHTML = '<div class="lan-ip-item" style="cursor:default;">未检测到局域网 IP</div>';
            return;
        }

        ipList.innerHTML = '';
        let selectedUrl = null;

        const createIpItem = (ip, label) => {
            const url = `http://${ip}:${port}/`;
            const item = document.createElement('div');
            item.className = 'lan-ip-item';
            item.dataset.url = url;
            item.innerHTML = `<span class="ip-label">${label}</span>${url}`;
            item.addEventListener('click', () => {
                ipList.querySelectorAll('.lan-ip-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                generateLanQR(url);
            });
            return { item, url };
        };

        if (wifi_ips.length > 0) {
            const wifiHeader = document.createElement('div');
            wifiHeader.className = 'lan-ip-group-header';
            wifiHeader.textContent = '📶 WiFi';
            ipList.appendChild(wifiHeader);
            wifi_ips.forEach((ip, idx) => {
                const { item, url } = createIpItem(ip, 'WiFi');
                ipList.appendChild(item);
                if (selectedUrl === null && idx === 0) {
                    selectedUrl = url;
                }
            });
        }

        if (hotspot_ips.length > 0) {
            const hotspotHeader = document.createElement('div');
            hotspotHeader.className = 'lan-ip-group-header';
            hotspotHeader.textContent = '📡 热点';
            ipList.appendChild(hotspotHeader);
            hotspot_ips.forEach((ip, idx) => {
                const { item, url } = createIpItem(ip, '热点');
                ipList.appendChild(item);
                if (selectedUrl === null && idx === 0) {
                    selectedUrl = url;
                }
            });
        }

        if (selectedUrl) {
            const firstItem = ipList.querySelector('.lan-ip-item');
            if (firstItem) firstItem.classList.add('selected');
            generateLanQR(selectedUrl);
        }

    } catch (e) {
        console.warn('load lan ips err:', e);
        ipList.innerHTML = '<div class="lan-ip-item" style="cursor:default;">加载失败</div>';
    }
};

const closeLanModal = () => {
    const modal = $('lanModal');
    if (modal) modal.style.display = 'none';
};

const init = async () => {
    try {
        const r = await fetch('/api/config', { credentials: 'include' });
        const data = await r.json();
        if (data.ok) config = data.data;
    } catch (e) {
        console.warn('load config err:', e);
    }
    renderTrackList();

    $('stopBtn').addEventListener('click', async () => await stopAll());

    const pauseBtnEl = $('pauseBtn');
    if (pauseBtnEl) {
        pauseBtnEl.addEventListener('click', () => togglePause());
    }

    $('breakLoopBtn').addEventListener('click', () => breakLoop());
    const flBtn = $('fullLoopBtn');
    if (flBtn) {
        flBtn.addEventListener('click', () => toggleFullLoop());
    }

    $('volumeSlider').addEventListener('input', (e) => {
        const v = parseInt(e.target.value);
        $('volumeVal').textContent = v;
        currentMasterVolume = v / 100.0;
        if (masterGain) masterGain.gain.value = currentMasterVolume;
        rcBroadcastState();
    });

    $('addBtn').addEventListener('click', () => {
        window.open('/admin', '_blank');
    });

    // --- Drawer (mobile) wiring ---
    const dt = document.getElementById('drawerToggle');
    if (dt) dt.addEventListener('click', toggleDrawer);
    const do_el = document.getElementById('drawerOverlay');
    if (do_el) do_el.addEventListener('click', closeDrawer);
    const dc = document.getElementById('drawerClose');
    if (dc) dc.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer();
    });
    window.addEventListener('resize', () => {
        if (!isMobileBreakpoint()) closeDrawer();
    });

    // --- Lyric modal wiring ---
    const lp = document.getElementById('lyricPanel');
    if (lp) lp.addEventListener('click', openLyricModal);
    const lmo = document.getElementById('lyricModalOverlay');
    if (lmo) lmo.addEventListener('click', (e) => {
        if (e.target === lmo) closeLyricModal();
    });
    const lmc = document.getElementById('lyricModalClose');
    if (lmc) lmc.addEventListener('click', closeLyricModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lmo?.classList.contains('active')) closeLyricModal();
    });

    // --- LAN modal wiring ---
    const lanBtn = document.getElementById('lanBtn');
    if (lanBtn) lanBtn.addEventListener('click', openLanModal);
    const lanOverlay = document.getElementById('lanModalOverlay');
    if (lanOverlay) lanOverlay.addEventListener('click', closeLanModal);
    const lanClose = document.getElementById('lanModalClose');
    if (lanClose) lanClose.addEventListener('click', closeLanModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const lanModal = document.getElementById('lanModal');
            if (lanModal && lanModal.style.display === 'flex') closeLanModal();
        }
    });

    const lcp = document.getElementById('lyricColorPicker');
    if (lcp) {
        const savedColor = localStorage.getItem('lyricHighlightColor');
        if (savedColor) {
            lcp.value = savedColor;
            document.documentElement.style.setProperty('--lyric-highlight-color', savedColor);
        }
        lcp.addEventListener('input', (e) => {
            const color = e.target.value;
            localStorage.setItem('lyricHighlightColor', color);
            document.documentElement.style.setProperty('--lyric-highlight-color', color);
        });
    }

    if (window.electronAPI && window.electronAPI.isElectron && window.electronAPI.isElectron()) {
        const dlBtn = document.getElementById('desktopLyricBtn');
        if (dlBtn) {
            dlBtn.style.display = 'inline-flex';
            dlBtn.addEventListener('click', async () => {
                await window.electronAPI.openDesktopLyric();
            });
        }
    }

    if (config.tracks.length > 0) {
        applyTrackCfg(config.tracks[0]);
        updateInfoPanel(0);
    }

    // 启动远程控制 WebSocket（player 角色）
    rcConnect();

    // 首次用户手势解锁音频（手机遥控播放需要本页面先有手势才能出声）
    attachAudioUnlock();

    // 加载即创建 AudioContext（此时为 suspended）并显示「点击启用音频」提示。
    // 浏览器自动播放策略要求本页面至少有一次用户手势，AudioContext 才能出声；
    // 用户只要在本页面点一下（或在提示条上点一下），之后遥控器就能直接播放。
    ensureCtx();
    if (audioCtx && audioCtx.state !== 'running') showAudioLockHint();
};

document.addEventListener('DOMContentLoaded', init);

// ===================== 远程控制（播放器端 / player 角色） =====================
// 与 Remote_Controller.html（remote 角色）通过 app.py 的 WebSocket 中继通信：
// 本端负责把曲目列表与播放状态广播给遥控器，并接收遥控器发来的控制命令。
let rcWs = null;
let rcWsReady = false;
let rcReconnectDelay = 1000;
let rcLastStateSent = 0;

const rcSend = (obj) => {
    if (rcWs && rcWs.readyState === WebSocket.OPEN) {
        try { rcWs.send(JSON.stringify(obj)); } catch (_) {}
    }
};

const rcSendTracks = () => {
    if (!config || !Array.isArray(config.tracks)) return;
    rcSend({
        type: 'tracks',
        tracks: config.tracks.map((c, i) => ({
            idx: i,
            name: c.name || `曲目 ${i + 1}`,
            bpm: c.bpm,
            category: c.category || '未分类',
            loop: `${c.loop_start_bar}:${c.loop_start_beat} → ${c.loop_end_bar}:${c.loop_end_beat}`,
        })),
    });
};

// 实时计算当前拍字符串（不依赖 DOM 文本，后台标签页 rAF 暂停时也能正确更新）。
// 复用 updateUi 中的 barBeat 算法；无播放时返回空串。
const currentBeatString = () => {
    if (!currentTrack) return '';
    const s = currentPlaySec();
    let beatSec = s;
    if (multiStyleMode && currentStyleIdx >= 0) {
        const entry = styleTracks[currentStyleIdx];
        if (entry && entry.offsetDiff != null) beatSec = s - entry.offsetDiff;
    }
    const bb = barBeat(beatSec);
    return `${bb.bar}:${Number(bb.beat.toFixed(2))}`;
};

// 实时计算当前「绝对拍」（自零拍起的连续网格拍，含变速/变拍补偿），
// 供遥控端本地 requestAnimationFrame 插值使用。无播放时返回 0。
const currentAbsBeat = () => {
    if (!currentTrack || !activeTrackCfg) return 0;
    const s = currentPlaySec();
    let beatSec = s;
    if (multiStyleMode && currentStyleIdx >= 0) {
        const entry = styleTracks[currentStyleIdx];
        if (entry && entry.offsetDiff != null) beatSec = s - entry.offsetDiff;
    }
    return window.BeatUtils.timeToAbsBeat(
        beatSec,
        activeTrackCfg.bpm,
        activeTrackCfg.beats_per_bar,
        activeTrackCfg.audio_zero_bar,
        activeTrackCfg.audio_zero_beat,
        tempoChanges,
        meterChanges,
        activeTrackNvf
    );
};

const rcBroadcastState = () => {
    const t = (currentPlayingIdx >= 0 && config.tracks[currentPlayingIdx]) ? config.tracks[currentPlayingIdx] : null;
    rcSend({
        type: 'state',
        idx: currentPlayingIdx,
        name: t ? (t.name || '') : null,
        is_playing: !!(currentTrack && !isPaused),
        is_paused: !!isPaused,
        progress_sec: (typeof currentPlaySec === 'function') ? currentPlaySec() : 0,
        duration_sec: Math.max(audioDurS || 0, loopEndS || 0),
        volume: Math.round((currentMasterVolume || 0) * 100),
        track_count: (config && config.tracks) ? config.tracks.length : 0,
        bpm: activeTrackCfg ? activeTrackCfg.bpm : null,
        cur_beat: currentBeatString(),
        style_switching: !!styleSwitching,
        // 以下字段供遥控端显示当前拍/进度（直接采用播放器推送值，不再本地外推）
        abs_beat: currentAbsBeat(),
        beats_per_bar: activeTrackCfg ? activeTrackCfg.beats_per_bar : 4,
        zero_bar: activeTrackCfg ? activeTrackCfg.audio_zero_bar : 1,
        zero_beat: activeTrackCfg ? activeTrackCfg.audio_zero_beat : 1,
        note_value_fraction: activeTrackNvf,
        meter_changes: (activeTrackCfg && Array.isArray(activeTrackCfg.meter_changes)) ? activeTrackCfg.meter_changes : [],
        // 风格切换：仅多风格曲目在播放时提供（默认风格 idx = -1）
        styles: (multiStyleMode && activeTrackCfg && Array.isArray(activeTrackCfg.styles)) ?
            activeTrackCfg.styles.map((st, i) => ({
                idx: i,
                name: st.name || `风格 ${i + 1}`,
                active: i === currentStyleIdx,
            })) : [],
        // 多轨混音：额外轨道的开/关与音量（0-100）
        extra_tracks: (extraTracksEnabled && extraTracks.length) ?
            extraTracks.map((et, i) => ({
                idx: i,
                name: et.name || `轨道 ${i + 1}`,
                muted: !!et.muted,
                volume: Math.round((et.volume != null ? et.volume : 1) * 100),
                switching: !!et.switching,
            })) : [],
        // 循环/收尾控制状态（供遥控端镜像按钮：跳出循环/收尾、完整循环/返回循环段）
        loop_control: {
            ending_enabled: !!endingEnabled,
            ending_playing: !!endingPlaying,
            loop_broken: !!loopBroken,
            full_loop_enabled: !!fullLoopEnabled,
            full_loop_mode: !!isFullLoopMode,
            full_loop_switching: !!fullLoopSwitching,
        },
        // 预加载状态（仅供遥控端显示每首曲目的预载进度；仅含 loading/done，idle 不推送以精简负载）
        preload_states: Object.keys(trackPreloadState)
            .map(function (k) { return { idx: parseInt(k, 10), state: trackPreloadState[k] }; })
            .filter(function (x) { return x.state !== 'idle'; }),
    });
};

// 高帧率进度推送：把进度相关字段单独抽成轻量 tick 消息，
// 结构类（风格/混音/曲目列表）仍走低频的 state，避免每帧重发大量数据。
const rcBroadcastTick = () => {
    const t = (currentPlayingIdx >= 0 && config.tracks[currentPlayingIdx]) ? config.tracks[currentPlayingIdx] : null;
    rcSend({
        type: 'tick',
        idx: currentPlayingIdx,
        name: t ? (t.name || '') : null,
        is_playing: !!(currentTrack && !isPaused),
        is_paused: !!isPaused,
        progress_sec: (typeof currentPlaySec === 'function') ? currentPlaySec() : 0,
        duration_sec: Math.max(audioDurS || 0, loopEndS || 0),
        volume: Math.round((currentMasterVolume || 0) * 100),
        cur_beat: currentBeatString(),
        // 以下标量供遥控端本地插值（meter_changes 仅 state 推送，避免每帧重发）
        bpm: activeTrackCfg ? activeTrackCfg.bpm : null,
        abs_beat: currentAbsBeat(),
        beats_per_bar: activeTrackCfg ? activeTrackCfg.beats_per_bar : 4,
        zero_bar: activeTrackCfg ? activeTrackCfg.audio_zero_bar : 1,
        zero_beat: activeTrackCfg ? activeTrackCfg.audio_zero_beat : 1,
        note_value_fraction: activeTrackNvf,
        // 预加载状态（遥控端镜像每首曲目预载进度）
        preload_states: Object.keys(trackPreloadState)
            .map(function (k) { return { idx: parseInt(k, 10), state: trackPreloadState[k] }; })
            .filter(function (x) { return x.state !== 'idle'; }),
    });
};

// 前台用 requestAnimationFrame 驱动 ~60fps 高频推送（进度条丝滑）；
// 后台标签页 rAF 会被暂停，由下面独立的 setInterval 兜底（节流到约 1 秒一次）。
let rcTickRaf = null;
let rcLastTickSent = 0;
const rcTickLoop = () => {
    const now = performance.now();
    if (rcWsReady && currentTrack && (now - rcLastTickSent >= 16)) {
        rcLastTickSent = now;
        rcBroadcastTick();
    }
    rcTickRaf = requestAnimationFrame(rcTickLoop);
};
const rcStartTick = () => { if (rcTickRaf == null) rcTickRaf = requestAnimationFrame(rcTickLoop); };
const rcStopTick = () => { if (rcTickRaf != null) { cancelAnimationFrame(rcTickRaf); rcTickRaf = null; } };

const rcHandleCommand = (data) => {
    if (!data || data.type !== 'command') return;
    const a = data.action;
    try {
        if (a === 'play_idx' || a === 'play') {
            const idx = parseInt(data.idx, 10);
            if (!isNaN(idx) && config.tracks[idx]) playTrack(idx);
        } else if (a === 'pause') {
            if (currentTrack && !isPaused) pausePlayback();
        } else if (a === 'resume') {
            if (isPaused) resumePlayback();
        } else if (a === 'toggle_pause') {
            togglePause();
        } else if (a === 'stop') {
            stopAll();
        } else if (a === 'set_volume') {
            const v = Math.max(0, Math.min(100, parseInt(data.volume, 10)));
            if (!isNaN(v)) {
                currentMasterVolume = v / 100.0;
                const vs = $('volumeSlider'); if (vs) vs.value = String(v);
                const vv = $('volumeVal'); if (vv) vv.textContent = String(v);
                if (masterGain) masterGain.gain.value = currentMasterVolume;
                rcBroadcastState();
            }
        } else if (a === 'switch_style') {
            const sIdx = parseInt(data.style_idx, 10);
            if (!isNaN(sIdx) && multiStyleMode && activeTrackCfg && activeTrackCfg.styles) {
                if (sIdx === -1 || activeTrackCfg.styles[sIdx]) {
                    switchStyle(sIdx);
                    rcBroadcastState();
                }
            }
        } else if (a === 'toggle_extra_track') {
            const etIdx = parseInt(data.et_idx, 10);
            if (!isNaN(etIdx)) {
                toggleExtraTrack(etIdx);
                rcBroadcastState();
            }
        } else if (a === 'break_loop') {
            breakLoop();
            rcBroadcastState();
        } else if (a === 'toggle_full_loop') {
            toggleFullLoop();
            rcBroadcastState();
        } else if (a === 'preload_idx') {
            const idx = parseInt(data.idx, 10);
            if (!isNaN(idx) && config.tracks[idx]) preloadTrack(idx);
        } else if (a === 'set_extra_track_volume') {
            const etIdx = parseInt(data.et_idx, 10);
            const v = Math.max(0, Math.min(100, parseInt(data.volume, 10)));
            if (!isNaN(etIdx) && !isNaN(v)) {
                setExtraTrackVolume(etIdx, v / 100.0);
                rcBroadcastState();
            }
        } else if (a === 'request_state') {
            rcBroadcastState();
        }
    } catch (e) {
        DLog('rcHandleCommand err:', e.message);
    }
};

const rcConnect = () => {
    if (typeof WebSocket === 'undefined') return;
    fetch('/api/ws_info').then(r => r.json()).then(info => {
        const url = info.ws_url || `ws://${info.host}:${info.ws_port}`;
        let ws;
        try { ws = new WebSocket(url); } catch (e) { DLog('rcConnect new WebSocket err:', e.message); return; }
        rcWs = ws;
        ws.onopen = () => {
            rcWsReady = true;
            rcReconnectDelay = 1000;
            ws.send(JSON.stringify({ type: 'hello', role: 'player' }));
            rcSendTracks();
            rcBroadcastState();
            rcStartTick();
        };
        ws.onmessage = (ev) => {
            try {
                const data = JSON.parse(ev.data);
                if (data.type === 'command') rcHandleCommand(data);
            } catch (_) {}
        };
        ws.onclose = () => {
            rcWsReady = false;
            rcWs = null;
            rcStopTick();
            setTimeout(rcConnect, rcReconnectDelay);
            rcReconnectDelay = Math.min(rcReconnectDelay * 2, 15000);
        };
        ws.onerror = () => { try { ws.close(); } catch (_) {} };
    }).catch(e => {
        DLog('rcConnect ws_info err:', e.message);
        setTimeout(rcConnect, rcReconnectDelay);
        rcReconnectDelay = Math.min(rcReconnectDelay * 2, 15000);
    });
};

// 定期把最新曲目列表推送给遥控器（以便管理面板修改后保持同步）
setInterval(() => { if (rcWsReady) rcSendTracks(); }, 10000);

// 后台标签页中 requestAnimationFrame 会被浏览器暂停，导致遥控端进度冻结。
// 这里用慢速 setInterval 仅作后台兜底（前台已由上面的 rAF 高频推送）：
// 浏览器会把后台 interval 节流到约 1 秒一次，保证后台时遥控端进度仍缓慢更新。
setInterval(() => {
    if (rcWsReady && currentTrack && document.hidden) rcBroadcastTick();
}, 1000);

// 低频完整状态安全网：风格/混音/音量/曲目结构等低频变化，进度由 tick 高频覆盖。
setInterval(() => {
    if (rcWsReady) rcBroadcastState();
}, 2000);

// 移动端切后台后 AudioContext 可能被系统挂起，返回前台时立即恢复
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        // 返回前台时若远程控制连接已断开，立即尝试重连
        if (!rcWsReady && !rcWs) rcConnect();
    }
});

// 同步歌词数据到主进程（主进程据此自动启动/停止 60fps 推送）
const syncLyricCacheToMain = () => {
    if (window.electronAPI && window.electronAPI.cacheLyricData) {
        // 双轨模式且设置了歌词结束拍时，同步 effectiveLoop 参数
        // 主进程据此正确估算歌词位置（使用 effectiveLoopEndS 包裹）
        const useEffective = (loopMode === 'dual' && lyricEndS > loopEndS);
        window.electronAPI.cacheLyricData({
            lines: lyricLines,
            loopStartS: loopStartS,
            loopDurS: useEffective ? effectiveLoopDurS : loopDurS,
            loopEndS: useEffective ? effectiveLoopEndS : loopEndS
        });
    }
};

// 注意：不再使用 visibilitychange 来切换推送模式。
// backgroundThrottling: false 时 visibilitychange 不会触发（Electron 文档明确说明
// "This also affects the Page Visibility API"）。
// 主进程始终以 60fps 推送桌面歌词，渲染端通过 rAF 同步音频时间，
// 主进程用墙钟时间插值估算，窗口最小化时也能零延迟推送。

})();