(() => {
'use strict';

window.DEBUG_AUDIO = true;
const DLog = (...a) => { if (window.DEBUG_AUDIO) console.log('[AUDIO]', ...a); };

let audioCtx = null;
let masterGain = null;
let audioBuffer = null;
let currentTrack = null;
let nextTrack = null;
let loopSchedulerTimer = null;
let rafId = null;
let config = { tracks: [] };
let activeTrackCfg = null;
let beatsPerSec = 0;
let beatSec = 0;
let zeroAbsBeat = 0;
let startS = 0;
let loopStartS = 0;
let loopEndS = 0;
let loopDurS = 0;
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
    if (!activeTrackCfg || !beatsPerSec) return { bar: 0, beat: 0, abs: 0 };
    const absBeatRaw = sec * beatsPerSec + zeroAbsBeat;
    const currentBeatInt = Math.max(1, Math.floor(absBeatRaw));
    const bpb = activeTrackCfg.beats_per_bar;
    const b0 = currentBeatInt - 1;
    const bar = Math.floor(b0 / bpb) + 1;
    const beat = (b0 % bpb) + 1;
    return { bar, beat, abs: absBeatRaw };
};

const secFromBarBeat = (bar, beat) => {
    if (!activeTrackCfg) return 0;
    const abs = (bar - 1) * activeTrackCfg.beats_per_bar + beat;
    return (abs - zeroAbsBeat) / beatsPerSec;
};

const ensureCtx = () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 1.0;
        masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
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
                DLog(`  → currentTrack ended without explicit stop; force jump now`);
                if (loopMode === 'single') doSingleJump();
                else doDualSwitch();
            }
        };
    } catch(_) {}
};

const playSegmentAt = (track, startOffsetSec, startAtCtx, opts = {}) => {
    if (!audioBuffer) return false;
    if (track.source) {
        try { track.source.onended = null; } catch(_){}
        try { if (!track.stopScheduled) { try { track.source.stop(); } catch(_){} } } catch(_){}
        try { track.source.disconnect(); } catch(_){}
        if (track.gain) try { track.gain.disconnect(); } catch(_){}
    }
    track.source = audioCtx.createBufferSource();
    track.source.buffer = audioBuffer;
    if (opts.enableLoop) {
        track.source.loop = true;
        track.source.loopStart = loopStartS;
        track.source.loopEnd = loopEndS;
    } else {
        track.source.loop = false;
    }
    track.gain = audioCtx.createGain();
    track.gain.gain.value = opts.initialGain != null ? opts.initialGain : 1.0;
    track.source.connect(track.gain);
    track.gain.connect(masterGain);

    let actualStartAt = startAtCtx;
    let actualOffset = startOffsetSec;
    const now = audioCtx ? audioCtx.currentTime : 0;
    if (actualStartAt < now + 0.0005) {
        const lateBy = now - actualStartAt;
        if (lateBy > 0 && lateBy < 30) {
            actualOffset = Math.min((audioBuffer.duration || 0) - 0.05, actualOffset + lateBy);
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
            track.startOffset = Math.max(0, Math.min((audioBuffer.duration||0)-0.05, actualOffset));
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
    if (!currentTrack || !currentTrack.source || audioCtx.currentTime < currentTrack.startedAtCtx) return 0;
    const raw = audioCtx.currentTime - currentTrack.startedAtCtx + currentTrack.startOffset;
    if (loopMode === 'single' && loopDurS > 0 && raw >= loopStartS) {
        const into = (raw - loopStartS) % loopDurS;
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
    clearTimeout(loopSchedulerTimer);

    const now = audioCtx.currentTime;
    const raw = getRawPlaybackPos(currentTrack);

    const nearAudioEnd = audioDurS > 0 && raw >= audioDurS - 0.08;
    let distToEnd;
    if (jumpSegEnabled && loopPhase === 'seg') {
        distToEnd = jumpSegEndS - raw;
    } else {
        if (raw < loopStartS + 0.0001) {
            distToEnd = loopEndS - raw;
        } else {
            const into = (raw - loopStartS) % loopDurS;
            distToEnd = loopDurS - into;
        }
    }

    if (nearAudioEnd) {
        DLog(`scheduleNextLoop: raw near/over audio end (${raw.toFixed(3)} / ${(audioDurS||0).toFixed(3)}); force jump now`);
        distToEnd = 0.002;
    }
    if (distToEnd < 0) distToEnd = 0.002;
    const safetyLimit = (audioDurS || 0) - raw - 0.05;
    if (safetyLimit > 0.01 && distToEnd > safetyLimit) {
        DLog(`scheduleNextLoop: safety clamp distToEnd from ${distToEnd.toFixed(3)}s to ${safetyLimit.toFixed(3)}s (near audio end)`);
        distToEnd = safetyLimit;
    }
    if (distToEnd < 0.002) distToEnd = 0.002;

    const lookAhead = Math.max(0.18, fadeOutS + 0.1);
    let triggerDelayMs = (distToEnd - lookAhead) * 1000;
    if (nearAudioEnd || distToEnd <= lookAhead + 0.001) triggerDelayMs = 1;
    if (triggerDelayMs < 1) triggerDelayMs = 1;

    DLog(`scheduleNextLoop[${loopMode} phase=${loopPhase}]: raw=${raw.toFixed(3)} distToEnd=${distToEnd.toFixed(3)} lookAhead=${(lookAhead*1000).toFixed(0)}ms delay=${triggerDelayMs.toFixed(0)}ms nearEnd=${nearAudioEnd}`);

    loopSchedulerTimer = setTimeout(() => {
        if (loopMode === 'single') doSingleJump();
        else doDualSwitch();
    }, triggerDelayMs);
};

const MIN_XFADE_S = 0.002;

const doSingleJump = () => {
    if (!currentTrack || !audioCtx || !audioBuffer) {
        DLog('doSingleJump: abort (no currentTrack/audioCtx/audioBuffer)');
        scheduleNextLoop();
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
                const into = (raw - loopStartS) % loopDurS;
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
    let prevTrack = null;
    let newTrack = null;
    try {
        const now = audioCtx.currentTime;
        const raw = getRawPlaybackPos(currentTrack);
        const nearAudioEnd = audioDurS > 0 && raw >= audioDurS - 0.1;

        let remainingToEnd;
        let isFirst = false;
        if (raw < loopStartS + 0.0001) {
            remainingToEnd = loopEndS - raw;
            isFirst = true;
        } else {
            const into = (raw - loopStartS) % loopDurS;
            remainingToEnd = loopDurS - into;
        }
        if (nearAudioEnd) remainingToEnd = 0.05;
        if (remainingToEnd < 0.002) remainingToEnd = 0.002;
        if (remainingToEnd < fadeOutS + 0.002) remainingToEnd = fadeOutS + 0.002;
        if (remainingToEnd > 3600) remainingToEnd = fadeOutS + 0.18;

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

        currentTrack = newTrack;

        const switchRawSec = raw + remainingToEnd;
        const bb = barBeat(switchRawSec);
        DLog(`DUAL SWITCH${isFirst ? ' [FIRST]' : ''}: raw=${raw.toFixed(3)} rem=${remainingToEnd.toFixed(4)}s switchRawSec=${switchRawSec.toFixed(3)} → ${bb.bar}:${bb.beat} switchAt=${switchAtCtx.toFixed(4)} newStartAt=${newTrack.startedAtCtx.toFixed(4)} nearEnd=${nearAudioEnd}`);
    } catch (e) {
        DLog('doDualSwitch FATAL:', e.message, e.stack);
    }
    scheduleNextLoop();
};

const loadAudio = async (cfg) => {
    ensureCtx();
    let url = `/api/bgm/${encodeURIComponent(cfg.filename)}`;
    if (cfg && cfg.bgm_dir_id) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'dir_id=' + encodeURIComponent(cfg.bgm_dir_id);
    }
    DLog('loading:', url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Audio fetch failed: ' + resp.status);
    const arr = await resp.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arr.slice(0));
    audioDurS = audioBuffer.duration;
    DLog(`loaded: dur=${audioDurS.toFixed(3)}s sr=${audioBuffer.sampleRate} ch=${audioBuffer.numberOfChannels} from dir=${cfg.bgm_dir_id || '(compat/default)'}`);
};

const applyTrackCfg = (cfg) => {
    activeTrackCfg = cfg;
    beatsPerSec = cfg.bpm / 60.0;
    beatSec = 60.0 / cfg.bpm;
    zeroAbsBeat = (cfg.audio_zero_bar - 1) * cfg.beats_per_bar + cfg.audio_zero_beat;
    startS = secFromBarBeat(cfg.audio_zero_bar, cfg.audio_zero_beat);
    loopStartS = secFromBarBeat(cfg.loop_start_bar, cfg.loop_start_beat);
    loopEndS = secFromBarBeat(cfg.loop_end_bar, cfg.loop_end_beat);
    loopDurS = loopEndS - loopStartS;
    loopMode = (cfg.loop_mode && cfg.loop_mode === 'dual') ? 'dual' : 'single';
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
    DLog(`  startS=${startS.toFixed(4)} loop=[${loopStartS.toFixed(3)} → ${loopEndS.toFixed(3)}] dur=${loopDurS.toFixed(3)}s`);
    if (jumpSegEnabled) {
        DLog(`  jump_seg=[${jumpSegStartS.toFixed(3)} → ${jumpSegEndS.toFixed(3)}] (dur=${(jumpSegEndS-jumpSegStartS).toFixed(3)}s) ENABLED`);
    } else {
        DLog(`  jump_seg: disabled`);
    }
    const fosLabel = fadeOutAuto ? 'auto→loopEnd' : `${fosBar}:${fosBeat}`;
    DLog(`  fadeIn=${(fadeInS*1000).toFixed(0)}ms (from loopStart) fadeOut=${(fadeOutS*1000).toFixed(0)}ms (fos=${fosLabel} abs=${fadeOutStartS.toFixed(3)}s)`);
};

const playTrack = async (idx) => {
    stopAll();
    const cfg = config.tracks[idx];
    if (!cfg) return;
    applyTrackCfg(cfg);
    loopPhase = 'main';
    updateInfoPanel(idx);
    await loadAudio(cfg);
    renderMarkers();
    ensureCtx();

    currentTrack = createTrack('A');
    nextTrack = createTrack('B');

    const now = audioCtx.currentTime + 0.05;
    const initialGain = (fadeInS > 0.0002) ? 0.0 : 1.0;
    playSegmentAt(currentTrack, startS, now, {
        enableLoop: false,
        initialGain,
    });

    if (fadeInS > 0.0002 && currentTrack.gain) {
        try {
            const g0 = Math.max(audioCtx.currentTime + 0.001, now);
            currentTrack.gain.gain.cancelScheduledValues(g0);
            currentTrack.gain.gain.setValueAtTime(0.0, g0);
            currentTrack.gain.gain.linearRampToValueAtTime(1.0, g0 + fadeInS);
            currentTrack.envelopeEndsAtCtx = Math.max(currentTrack.envelopeEndsAtCtx || 0, g0 + fadeInS);
            DLog(`initial fade-in: ${(fadeInS*1000).toFixed(0)}ms`);
        } catch(e) { DLog('initial fade-in err', e.message); }
    }

    scheduleNextLoop();
    startUiTicker();
};

const stopAll = () => {
    clearTimeout(loopSchedulerTimer);
    loopSchedulerTimer = null;
    cancelAnimationFrame(rafId);
    rafId = null;
    if (currentTrack) {
        try { if (currentTrack.source && !currentTrack.stopScheduled) {
            try { currentTrack.gain?.gain?.cancelScheduledValues(audioCtx?.currentTime || 0); } catch(_){}
            if (currentTrack.gain && audioCtx) {
                try { currentTrack.gain.gain.setValueAtTime(currentTrack.gain.gain.value, audioCtx.currentTime); } catch(_){}
                try {
                    const endAt = audioCtx.currentTime + 0.03;
                    currentTrack.gain.gain.linearRampToValueAtTime(0, endAt);
                    currentTrack.envelopeEndsAtCtx = Math.max(currentTrack.envelopeEndsAtCtx || 0, endAt);
                } catch(_){}
            }
            scheduleStopWithEnvelope(currentTrack, (audioCtx?.currentTime || 0) + 0.04);
        } else safeCleanupTrack(currentTrack); } catch(_){ safeCleanupTrack(currentTrack); }
    }
    if (nextTrack) {
        safeCleanupTrack(nextTrack);
    }
    currentTrack = null;
    nextTrack = null;
};

const pauseAll = () => stopAll();

let lastBeatIdx = -1;
const updateUi = () => {
    rafId = requestAnimationFrame(updateUi);
    if (!currentTrack || !activeTrackCfg) return;
    const s = currentPlaySec();
    const bb = barBeat(s);
    $('curBeat').textContent = `${bb.bar}:${bb.beat}`;
    $('curMs').textContent = Math.floor(s * 1000).toString();
    $('curSec').textContent = s.toFixed(3);

    const totalDur = Math.max(audioDurS || 1, loopEndS || 1);
    const pct = Math.min(99.9, (s / totalDur) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressStart').textContent = fmtTime(0);
    $('progressEnd').textContent = fmtTime(totalDur);

    const absFloored = Math.max(1, Math.floor(bb.abs));
    const b0ForDot = absFloored - 1;
    const bpb = activeTrackCfg.beats_per_bar;
    const beatIdx = ((b0ForDot % bpb) + bpb) % bpb;
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
    const totalDur = Math.max(audioDurS || 1, loopEndS || 1);
    const clampPct = (p) => Math.max(0, Math.min(99.9, p));
    const lpct = clampPct((loopStartS / totalDur) * 100);
    const lepct = clampPct((loopEndS / totalDur) * 100);
    if (lepct - lpct < 0.5) {
        $('markerLoopEnd').style.left = clampPct(lpct + 0.5) + '%';
    } else {
        $('markerLoopEnd').style.left = lepct + '%';
    }
    $('markerLoopStart').style.left = lpct + '%';
    $('markerLoopStart').title = `循环起点 ${fmtTime(loopStartS)} (${activeTrackCfg.loop_start_bar}:${activeTrackCfg.loop_start_beat})`;
    $('markerLoopEnd').title = `循环终点 ${fmtTime(loopEndS)} (${activeTrackCfg.loop_end_bar}:${activeTrackCfg.loop_end_beat})`;

    if ($('markerFadeOut')) {
        if (fadeOutS > 0.0002) {
            const fospct = clampPct((fadeOutStartS / totalDur) * 100);
            $('markerFadeOut').style.left = fospct + '%';
            $('markerFadeOut').style.display = 'block';
            const fosTitle = fadeOutAuto
                ? `淡出起点 ${fmtTime(fadeOutStartS)} (自动：淡出结束对齐循环终点)`
                : `淡出起点 ${fmtTime(fadeOutStartS)} (${activeTrackCfg.fade_out_start_bar}:${activeTrackCfg.fade_out_start_beat || 1})`;
            $('markerFadeOut').title = fosTitle;
        } else {
            $('markerFadeOut').style.display = 'none';
        }
    }
    if ($('markerJumpSegStart')) {
        if (jumpSegEnabled) {
            const jsspct = clampPct((jumpSegStartS / totalDur) * 100);
            $('markerJumpSegStart').style.left = jsspct + '%';
            $('markerJumpSegStart').style.display = 'block';
            $('markerJumpSegStart').title = `跳转段起点 ${fmtTime(jumpSegStartS)} (${activeTrackCfg.jump_seg_start_bar}:${activeTrackCfg.jump_seg_start_beat})`;
        } else {
            $('markerJumpSegStart').style.display = 'none';
        }
    }
    if ($('markerJumpSegEnd')) {
        if (jumpSegEnabled) {
            const jsepct = clampPct((jumpSegEndS / totalDur) * 100);
            $('markerJumpSegEnd').style.left = jsepct + '%';
            $('markerJumpSegEnd').style.display = 'block';
            $('markerJumpSegEnd').title = `跳转段终点 ${fmtTime(jumpSegEndS)} (${activeTrackCfg.jump_seg_end_bar}:${activeTrackCfg.jump_seg_end_beat})`;
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
    $('trackSig').textContent = `拍号: ${cfg.beats_per_bar}/4`;
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

const renderTrackList = () => {
    const list = $('trackList');
    list.innerHTML = '';
    config.tracks.forEach((cfg, idx) => {
        const el = document.createElement('div');
        el.className = 'track-item';
        const ls = secFromBarBeatWrap(cfg, cfg.loop_start_bar, cfg.loop_start_beat);
        const le = secFromBarBeatWrap(cfg, cfg.loop_end_bar, cfg.loop_end_beat);
        const dur = Math.max(0, le - ls);
        const modeTag = cfg.loop_mode === 'dual' ? ' · 双轨' : ' · 单轨';
        el.innerHTML = `
            <div class="idx">${idx + 1}</div>
            <div class="info">
                <div class="t-name">${cfg.name}</div>
                <div class="t-meta">${cfg.bpm} BPM${modeTag} · ${cfg.loop_start_bar}:${cfg.loop_start_beat} → ${cfg.loop_end_bar}:${cfg.loop_end_beat} · 循环${dur.toFixed(2)}s</div>
            </div>
            <button class="play-btn" data-idx="${idx}">▶</button>
        `;
        el.addEventListener('click', (e) => {
            let idx2 = idx;
            if (e.target.classList.contains('play-btn')) {
                idx2 = parseInt(e.target.dataset.idx);
            }
            playTrack(idx2);
            if (isMobileBreakpoint()) closeDrawer();
        });
        list.appendChild(el);
    });
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
    const bps = cfg.bpm / 60.0;
    const zab = (cfg.audio_zero_bar - 1) * cfg.beats_per_bar + cfg.audio_zero_beat;
    const abs = (bar - 1) * cfg.beats_per_bar + beat;
    return (abs - zab) / bps;
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

    $('playBtn').addEventListener('click', () => {
        if (config.tracks.length > 0) playTrack(0);
    });
    $('pauseBtn').addEventListener('click', pauseAll);
    $('stopBtn').addEventListener('click', stopAll);

    $('volumeSlider').addEventListener('input', (e) => {
        const v = parseInt(e.target.value);
        $('volumeVal').textContent = v;
        if (masterGain) masterGain.gain.value = v / 100.0;
    });

    $('addBtn').addEventListener('click', () => {
        window.location.href = '/admin';
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

    if (config.tracks.length > 0) {
        applyTrackCfg(config.tracks[0]);
        updateInfoPanel(0);
    }
};

document.addEventListener('DOMContentLoaded', init);

})();
