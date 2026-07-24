(() => {
'use strict';

window.DEBUG_AUDIO = true;
const DLog = (...a) => { if (window.DEBUG_AUDIO) console.log('[AUDIO]', ...a); };

let audioCtx = null;
let masterGain = null;
let audioBuffer = null;
let audioCache = {};
let audioLoading = {};
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
let lastScrollOffset = null;

let currentStyleIdx = -1;
let styleTracks = {};
let styleSwitching = false;
let multiStyleMode = false;

let vocalMode = 'original';
let vocalTrack = null;
let vocalBuffer = null;
let vocalGain = null;
let vocalEnabled = false;
let vocalSwitching = false;

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
    
    const result = window.BeatUtils.timeToBarBeat(sec, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges);
    return result;
};

const secFromBarBeat = (bar, beat) => {
    if (!activeTrackCfg) return 0;
    
    const bpm = activeTrackCfg.bpm;
    const beatsPerBar = activeTrackCfg.beats_per_bar;
    const zeroBar = activeTrackCfg.audio_zero_bar;
    const zeroBeat = activeTrackCfg.audio_zero_beat;
    
    return window.BeatUtils.barBeatToTime(bar, beat, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges);
};

const ensureCtx = () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 1.0;
        masterGain.connect(audioCtx.destination);
        DLog('ensureCtx: created new AudioContext');
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(e => DLog('ensureCtx: resume failed', e.message));
    }
    if (audioCtx.state === 'closed') {
        audioCtx = null;
        return ensureCtx();
    }
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
    const connectTo = opts.connectTo || masterGain;
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
    if (loopDurS > 0 && raw >= loopStartS) {
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

    const lookAhead = fadeOutS > 0.0002 ? Math.max(0.18, fadeOutS + 0.1) : 0.18;
    let triggerDelayMs = (distToEnd - lookAhead) * 1000;
    if (nearAudioEnd || distToEnd <= lookAhead + 0.001) triggerDelayMs = 1;
    if (triggerDelayMs < 1) triggerDelayMs = 1;

    DLog(`scheduleNextLoop[${loopMode} phase=${loopPhase}]: raw=${raw.toFixed(3)} distToEnd=${distToEnd.toFixed(3)} lookAhead=${(lookAhead*1000).toFixed(0)}ms delay=${triggerDelayMs.toFixed(0)}ms nearEnd=${nearAudioEnd}`);

    loopSchedulerTimer = setTimeout(() => {
        if (loopMode === 'single') doSingleJump();
        else doDualSwitch();
    }, triggerDelayMs);
};

const syncVocalOnJump = (targetOffset, fadeStartAtCtx, fadeEndAtCtx, xfadeS) => {
    if (!vocalEnabled || !vocalTrack || !vocalBuffer || !vocalGain) return;
    if (!activeTrackCfg) return;
    const vAzb = activeTrackCfg.vocal_audio_zero_bar != null ? activeTrackCfg.vocal_audio_zero_bar : activeTrackCfg.audio_zero_bar || 1;
    const vAzbt = activeTrackCfg.vocal_audio_zero_beat != null ? activeTrackCfg.vocal_audio_zero_beat : activeTrackCfg.audio_zero_beat || 1;
    const timePerBeat = 60.0 / activeTrackCfg.bpm;
    const defZeroOffset = ((activeTrackCfg.audio_zero_bar - 1) * (activeTrackCfg.beats_per_bar || 4) + (activeTrackCfg.audio_zero_beat - 1)) * timePerBeat;
    const vZeroOffset = ((vAzb - 1) * (activeTrackCfg.beats_per_bar || 4) + (vAzbt - 1)) * timePerBeat;
    const offsetDiff = defZeroOffset - vZeroOffset;
    const vocalTarget = Math.max(0, targetOffset + offsetDiff);

    const newVocalTrack = createTrack('vocal-next');
    const ok = playSegmentAt(newVocalTrack, vocalTarget, fadeStartAtCtx, {
        enableLoop: false,
        initialGain: 0.0,
        buffer: vocalBuffer,
        connectTo: vocalGain,
    });
    if (!ok) return;

    try {
        newVocalTrack.gain.gain.cancelScheduledValues(fadeStartAtCtx);
        newVocalTrack.gain.gain.setValueAtTime(0.0, fadeStartAtCtx);
        newVocalTrack.gain.gain.linearRampToValueAtTime(vocalMode === 'original' ? 1.0 : 0.0, fadeEndAtCtx);
    } catch(e) {}

    if (vocalTrack && vocalTrack.gain) {
        try {
            vocalTrack.gain.gain.cancelScheduledValues(fadeStartAtCtx);
            vocalTrack.gain.gain.setValueAtTime(vocalTrack.gain.gain.value, fadeStartAtCtx);
            vocalTrack.gain.gain.linearRampToValueAtTime(0.0, fadeEndAtCtx);
        } catch(e) {}
        vocalTrack.stopScheduled = true;
        vocalTrack.stopAtCtx = fadeEndAtCtx + 0.0005;
        try { if (vocalTrack.source) vocalTrack.source.stop(vocalTrack.stopAtCtx); } catch(_) {}
        safeCleanupTrack(vocalTrack);
    }
    newVocalTrack.offsetDiff = offsetDiff;
    vocalTrack = newVocalTrack;
    DLog(`vocal synced on jump: target=${vocalTarget.toFixed(3)}s xfade=${(xfadeS*1000).toFixed(0)}ms`);
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

        let remainingToEnd;
        let isFirst = false;
        let targetOffset;
        let nextPhase = loopPhase;

        if (jumpSegEnabled && loopPhase === 'seg') {
            remainingToEnd = jumpSegEndS - raw;
            if (remainingToEnd < 0.002) remainingToEnd = 0.002;
            targetOffset = loopStartS;
            nextPhase = 'main';
        } else {
            if (raw < loopStartS + 0.0001) {
                remainingToEnd = loopEndS - raw;
                isFirst = true;
            } else {
                const into = (raw - loopStartS) % loopDurS;
                remainingToEnd = loopDurS - into;
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
        syncVocalOnJump(targetOffset, fadeStartAtCtx, fadeEndAtCtx, xfadeS);
        transitionBase = raw;
        transitionStartTime = audioCtx.currentTime;
        transitionPos = targetOffset;
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

        const switchRawSec = raw + remainingToEnd;
        const bb = barBeat(switchRawSec);
        DLog(`MULTI DUAL SWITCH${isFirst ? ' [FIRST]' : ''}: raw=${raw.toFixed(3)} rem=${remainingToEnd.toFixed(4)}s → ${bb.bar}:${bb.beat} (${Object.keys(styleTracks).length} styles swapped)`);
        const aeFirst = styleTracks[currentStyleIdx];
        const vFadeEnd2 = aeFirst.current.envelopeEndsAtCtx || (aeFirst.current.startedAtCtx + Math.max(fadeInS, fadeOutS));
        syncVocalOnJump(loopStartS, aeFirst.current.startedAtCtx, vFadeEnd2, Math.max(fadeInS, fadeOutS));
        transitionBase = raw;
        transitionStartTime = audioCtx.currentTime;
        transitionPos = loopStartS;
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
        syncVocalOnJump(targetOffset, fadeStartAtCtx, fadeEndAtCtx, xfadeS);
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
        if (raw < loopStartS + 0.0001) {
            remainingToEnd = loopEndS - raw;
            isFirst = true;
        } else {
            const into = (raw - loopStartS) % loopDurS;
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
        syncVocalOnJump(loopStartS, newTrack.startedAtCtx, vFadeEnd, Math.max(fadeInS, fadeOutS));
        transitionBase = raw;
        transitionStartTime = audioCtx.currentTime;
        transitionPos = loopStartS;
        currentTrack = newTrack;

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

const renderLyricBody = (entry, currentSec, lineEndTime = null) => {
    if (!entry) return '<span class="lyric-empty">暂无歌词</span>';
    if (entry.is_empty) return '<div class="lyric-empty-line"></div>';
    const karaoke = Array.isArray(entry.karaoke) ? entry.karaoke : [];
    let html = '';
    if (karaoke.length > 0) {
        const slots = _buildFlattenCharSlots(karaoke, lineEndTime);
        let done = '';
        let active = '';
        let rest = '';
        if (slots.length === 0) {
            rest = karaoke.map((t) => t.text).join('');
        } else {
            let idx = slots.findIndex((s) => s.start > currentSec + 1e-9);
            if (idx === 0) {
                rest = slots.map((s) => s.text).join('');
            } else if (idx === -1) {
                const last = slots[slots.length - 1];
                if (currentSec < last.end - 1e-9) {
                    done = slots.slice(0, slots.length - 1).map((s) => s.text).join('');
                    active = last.text;
                } else {
                    done = slots.map((s) => s.text).join('');
                }
            } else {
                const currentSlot = slots[idx - 1];
                if (currentSec < currentSlot.end - 1e-9) {
                    done = slots.slice(0, idx - 1).map((s) => s.text).join('');
                    active = currentSlot.text;
                    rest = slots.slice(idx).map((s) => s.text).join('');
                } else {
                    done = slots.slice(0, idx).map((s) => s.text).join('');
                    rest = slots.slice(idx).map((s) => s.text).join('');
                }
            }
        }

        if (active) {
            html = `<span class="lyric-done">${escapeHtml(done)}</span><span class="lyric-active">${escapeHtml(active)}</span><span class="lyric-rest">${escapeHtml(rest)}</span>`;
        } else if (done && rest) {
            html = `<span class="lyric-done">${escapeHtml(done)}</span><span class="lyric-rest">${escapeHtml(rest)}</span>`;
        } else if (done) {
            html = `<span class="lyric-done">${escapeHtml(done)}</span>`;
        } else {
            html = `<span class="lyric-rest">${escapeHtml(rest)}</span>`;
        }
    } else {
        html = escapeHtml(entry.text || '');
    }

    if (entry.translation) {
        return `<div class="lyric-main">${html}</div><div class="lyric-translation">${escapeHtml(entry.translation)}</div>`;
    }
    return `<div class="lyric-main">${html}</div>`;
};

const setLyricText = (entry, currentSec, lineEndTime = null) => {
    const el = $('lyricText');
    if (!el) return;
    
    let lyricText = '';
    let lyricTranslation = '';
    
    if (!entry) {
        el.innerHTML = '<span class="lyric-empty">暂无歌词</span>';
        el.classList.toggle('is-empty', true);
    } else if (entry.is_empty) {
        el.innerHTML = '<span class="lyric-empty-line"></span>';
        el.classList.toggle('is-empty', true);
    } else {
        el.innerHTML = renderLyricBody(entry, currentSec, lineEndTime);
        el.classList.toggle('is-empty', false);
        lyricText = entry.text || '';
        lyricTranslation = entry.translation || '';
    }
    
    if (window.electronAPI && window.electronAPI.updateDesktopLyric) {
        const now = performance.now();
        const lineChanged = activeLyricIndex !== lastDesktopLyricLineIdx;
        const timeSyncNeeded = now - lastDesktopLyricSendTs > 500;
        if (lineChanged || timeSyncNeeded) {
            window.electronAPI.updateDesktopLyric({
                text: lyricText,
                translation: lyricTranslation,
                karaoke: entry?.karaoke || [],
                lineEndTime: lineEndTime,
                currentTime: currentSec
            });
            lastDesktopLyricLineIdx = activeLyricIndex;
            lastDesktopLyricSendTs = now;
        }
    }
};

const updateLyricDisplay = () => {
    if (!lyricLines.length) {
        setLyricText(null, 0);
        return;
    }
    const s = currentPlaySec();
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
    beatsPerSec = cfg.bpm / 60.0;
    beatSec = 60.0 / cfg.bpm;
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
};

const playTrack = async (idx) => {
    // 加载锁：正在加载时禁止再次点击
    if (isLoadingTrack) {
        DLog(`playTrack: loading in progress (idx=${loadingTrackIdx}), ignore click idx=${idx}`);
        return;
    }
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
        const cfg = config.tracks[idx];
        if (!cfg) {
            DLog('playTrack: no cfg, abort');
            return;
        }
        DLog(`playTrack: cfg.name=${cfg.name}`);
        expandCategoryForTrack(idx, true);
        
        DLog('playTrack: loading lyrics (background)...');
        const loadedLyricLines = await loadLyrics(cfg, false);
        DLog('playTrack: lyrics loaded');
        
        DLog('playTrack: loading audio (background)...');
        await loadAudio(cfg);
        DLog('playTrack: audio loaded, audioBuffer=' + !!audioBuffer);

        const multiStyleModePre = !!(cfg.multi_style_enabled && Array.isArray(cfg.styles) && cfg.styles.length > 0);
        const vocalEnabledPre = !!(cfg.vocal_enabled && cfg.vocal_filename);
        const styleBuffers = {};
        let vocalBufferPre = null;

        const extraLoadPromises = [];
        if (multiStyleModePre) {
            cfg.styles.forEach((style, sIdx) => {
                if (!style.filename) return;
                extraLoadPromises.push((async () => {
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
        if (vocalEnabledPre) {
            extraLoadPromises.push((async () => {
                try {
                    const vfilename = cfg.vocal_filename;
                    const vdirId = cfg.vocal_dir_id || cfg.bgm_dir_id || '';
                    vocalBufferPre = await loadBuffer(vfilename, vdirId);
                    DLog('preload vocal track done');
                } catch(e) {
                    DLog('preload vocal track failed:', e.message);
                }
            })());
        }
        if (extraLoadPromises.length > 0) {
            DLog(`playTrack: preloading ${extraLoadPromises.length} extra audio(s)...`);
            await Promise.all(extraLoadPromises);
            DLog('playTrack: all extra audios preloaded');
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
            fadeOutCurrentTrack(0.3); // 0.3秒淡出
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
        activeLyricIndex = -1;
        lastDesktopLyricLineIdx = -1;
        
        const lyricEl = $('lyricText');
        if (lyricEl) {
            lyricEl.classList.remove('font-teyvat');
            lyricEl.style.fontFamily = '';
            if (cfg.font_face === 'teyvat') {
                lyricEl.style.fontFamily = '"Teyvat", "GenshinJA", "Yu Gothic UI", "Microsoft YaHei", sans-serif';
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
        
        if (!audioCtx) {
            DLog('playTrack: FATAL - audioCtx is null after ensureCtx!');
            return;
        }
        if (!audioBuffer) {
            DLog('playTrack: FATAL - audioBuffer is null!');
            return;
        }
        
        DLog(`playTrack: after loadAudio, startS=${startS.toFixed(4)}, loopStartS=${loopStartS.toFixed(4)}, loopEndS=${loopEndS.toFixed(4)}`);

        vocalEnabled = !!(cfg.vocal_enabled && cfg.vocal_filename && vocalBufferPre);
        vocalBuffer = null;
        vocalTrack = null;
        vocalGain = null;
        vocalMode = 'original';

        const startVocalTrack = (startAt, baseOffset) => {
            if (!vocalEnabled || !vocalBufferPre) return;
            vocalBuffer = vocalBufferPre;
            vocalGain = audioCtx.createGain();
            vocalGain.gain.value = 1.0;
            vocalGain.connect(masterGain);
            vocalTrack = createTrack('vocal');
            const vAzb = cfg.vocal_audio_zero_bar != null ? cfg.vocal_audio_zero_bar : cfg.audio_zero_bar || 1;
            const vAzbt = cfg.vocal_audio_zero_beat != null ? cfg.vocal_audio_zero_beat : cfg.audio_zero_beat || 1;
            const timePerBeat = 60.0 / cfg.bpm;
            const defZeroOffset = ((cfg.audio_zero_bar - 1) * (cfg.beats_per_bar || 4) + (cfg.audio_zero_beat - 1)) * timePerBeat;
            const vZeroOffset = ((vAzb - 1) * (cfg.beats_per_bar || 4) + (vAzbt - 1)) * timePerBeat;
            const offsetDiff = defZeroOffset - vZeroOffset;
            const vocalStartOffset = Math.max(0, baseOffset + offsetDiff);
            const initialGain = (fadeInS > 0.0002) ? 0.0 : 1.0;
            const ok = playSegmentAt(vocalTrack, vocalStartOffset, startAt, {
                enableLoop: false,
                initialGain,
                buffer: vocalBuffer,
                connectTo: vocalGain,
            });
            if (ok) {
                vocalTrack.offsetDiff = offsetDiff;
                if (fadeInS > 0.0002 && vocalTrack.gain) {
                    try {
                        const g0 = Math.max(audioCtx.currentTime + 0.001, startAt);
                        vocalTrack.gain.gain.cancelScheduledValues(g0);
                        vocalTrack.gain.gain.setValueAtTime(0.0, g0);
                        vocalTrack.gain.gain.linearRampToValueAtTime(1.0, g0 + fadeInS);
                    } catch(e) { DLog('vocal initial fade-in err', e.message); }
                }
                DLog(`vocal track started: offset=${vocalStartOffset.toFixed(3)}s diff=${offsetDiff.toFixed(3)}s`);
            } else {
                vocalEnabled = false;
                vocalTrack = null;
                vocalBuffer = null;
                try { if (vocalGain) vocalGain.disconnect(); } catch(_){}
                vocalGain = null;
            }
        };

        multiStyleMode = !!(cfg.multi_style_enabled && Array.isArray(cfg.styles) && cfg.styles.length > 0);
        styleTracks = {};
        currentStyleIdx = -1;

        if (multiStyleMode) {
            const ctxCurrentTime = audioCtx.currentTime;
            const now = ctxCurrentTime + 0.05;
            const initialGain = (fadeInS > 0.0002) ? 0.0 : 1.0;
            const timePerBeat = 60.0 / cfg.bpm;
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
                styleGain.connect(masterGain);

                const trackA = createTrack(sIdx === -1 ? 'default-A' : `style-${sIdx}-A`);
                const trackB = createTrack(sIdx === -1 ? 'default-B' : `style-${sIdx}-B`);

                const trackStartTime = isDefault ? now : (audioCtx.currentTime + 0.05);
                let startOffset;
                if (isDefault) {
                    startOffset = startS;
                } else {
                    const defTrack = styleTracks[-1];
                    if (defTrack) {
                        const defRawAtStart = trackStartTime - defTrack.current.startedAtCtx + defTrack.current.startOffset;
                        startOffset = Math.max(0, defRawAtStart + offsetDiff);
                    } else {
                        startOffset = Math.max(0, startS + offsetDiff);
                    }
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

                if (isDefault && fadeInS > 0.0002 && trackA.gain) {
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

            startVocalTrack(now, startS);

            scheduleNextLoop();
            DLog(`playTrack: multiStyleMode active, ${Object.keys(styleTracks).length} style tracks ready`);
        } else {
            currentTrack = createTrack('A');
            nextTrack = createTrack('B');

            const ctxCurrentTime = audioCtx.currentTime;
            const now = ctxCurrentTime + 0.05;
            const initialGain = (fadeInS > 0.0002) ? 0.0 : 1.0;
            
            DLog(`playTrack: ctx.currentTime=${ctxCurrentTime.toFixed(4)}, now=${now.toFixed(4)}`);
            DLog(`playTrack: startS=${startS.toFixed(4)} audioBuffer=${!!audioBuffer} ctxState=${audioCtx.state}`);
            
            const playSuccess = playSegmentAt(currentTrack, startS, now, {
                enableLoop: false,
                initialGain,
            });
            
            if (!playSuccess) {
                DLog('playTrack: playSegmentAt returned false!');
                return;
            } else {
                DLog('playTrack: playSegmentAt SUCCESS');
            }

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

            startVocalTrack(now, startS);

            scheduleNextLoop();
        }

        startUiTicker();

        loopBroken = false;
        const breakBtn = $('breakLoopBtn');
        if (breakBtn) {
            breakBtn.disabled = false;
            breakBtn.textContent = '⏭ 跳出循环';
        }

        updateStyleButtons();

        updateVocalButton();

        DLog('playTrack: COMPLETE');
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
            const itemIdx = parseInt(item.querySelector('.play-btn')?.dataset?.idx || '-1', 10);
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

const VOCAL_FADE_DURATION = 3.0;

const updateVocalButton = () => {
    const btn = $('vocalToggleBtn');
    const container = $('vocalToggleContainer');
    if (!btn || !container) return;
    if (!vocalEnabled || !vocalTrack) {
        container.style.display = 'none';
        return;
    }
    container.style.display = '';
    btn.disabled = vocalSwitching;
    if (vocalMode === 'original') {
        btn.textContent = '🎤 原唱模式';
        btn.classList.add('active');
    } else {
        btn.textContent = '🎹 伴奏模式';
        btn.classList.remove('active');
    }
};

const toggleVocalMode = () => {
    if (!vocalEnabled || !vocalTrack || !vocalGain || vocalSwitching) return;
    const newMode = vocalMode === 'original' ? 'accompaniment' : 'original';
    const now = audioCtx.currentTime + 0.02;
    const fadeEnd = now + VOCAL_FADE_DURATION;
    const targetGain = newMode === 'original' ? 1.0 : 0.0;
    try {
        vocalGain.gain.cancelScheduledValues(now);
        vocalGain.gain.setValueAtTime(vocalGain.gain.value, now);
        vocalGain.gain.linearRampToValueAtTime(targetGain, fadeEnd);
    } catch(e) { DLog('toggleVocalMode fade err', e.message); }
    vocalSwitching = true;
    vocalMode = newMode;
    updateVocalButton();
    DLog(`vocal mode: ${vocalMode} (${VOCAL_FADE_DURATION}s fade)`);
    setTimeout(() => {
        vocalSwitching = false;
        updateVocalButton();
        DLog('vocal mode switch: COMPLETE');
    }, VOCAL_FADE_DURATION * 1000);
};

const STYLE_FADE_DURATION = 3.0;

const switchStyle = (styleIdx) => {
    if (styleSwitching) {
        DLog('switchStyle: already switching, ignore');
        return;
    }
    if (!multiStyleMode || !activeTrackCfg) {
        DLog('switchStyle: multi_style not active');
        return;
    }
    if (styleIdx === currentStyleIdx) {
        DLog('switchStyle: same style, ignore');
        return;
    }

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

    startUiTicker();

    setTimeout(() => {
        styleSwitching = false;
        updateStyleButtons();
        DLog(`switchStyle: COMPLETE (styleGain ${currentStyleIdx} active, ${(STYLE_FADE_DURATION * 1000).toFixed(0)}ms)`);
    }, STYLE_FADE_DURATION * 1000);
};

const breakLoop = () => {
    if (!currentTrack || !audioBuffer || loopBroken) return;

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

    const btn = $('breakLoopBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '✓ 已跳出循环';
    }

    DLog(`breakLoop: loop disabled, natural end at ${audioDurS.toFixed(3)}s`);
};

const stopAll = async () => {
    clearTimeout(loopSchedulerTimer);
    loopSchedulerTimer = null;
    cancelAnimationFrame(rafId);
    rafId = null;

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
            if (currentTrack.gain) {
                try { currentTrack.gain.disconnect(); } catch(_){}
            }
        } catch(_) {}
    }
    if (nextTrack) {
        try {
            if (nextTrack.source) {
                try { nextTrack.source.stop(); } catch(_){}
                try { nextTrack.source.disconnect(); } catch(_){}
            }
            if (nextTrack.gain) {
                try { nextTrack.gain.disconnect(); } catch(_){}
            }
        } catch(_) {}
    }
    currentTrack = null;
    nextTrack = null;
    audioBuffer = null;
    loopBroken = false;
    multiStyleMode = false;

    if (vocalTrack) {
        try {
            if (vocalTrack.source) { try { vocalTrack.source.stop(); } catch(_){} try { vocalTrack.source.disconnect(); } catch(_){} }
            if (vocalTrack.gain) { try { vocalTrack.gain.disconnect(); } catch(_){} }
        } catch(_) {}
        vocalTrack = null;
    }
    if (vocalGain) { try { vocalGain.disconnect(); } catch(_){} vocalGain = null; }
    vocalBuffer = null;
    vocalEnabled = false;
    vocalMode = 'original';

    const breakBtn = $('breakLoopBtn');
    if (breakBtn) {
        breakBtn.disabled = true;
        breakBtn.textContent = '⏭ 跳出循环';
    }
    
    if (audioCtx) {
        try {
            await audioCtx.close();
        } catch(_){}
        audioCtx = null;
        masterGain = null;
    }
};



let lastBeatIdx = -1;
const updateUi = () => {
    rafId = requestAnimationFrame(updateUi);
    if (!currentTrack || !activeTrackCfg) return;
    const s = currentPlaySec();
    const bb = barBeat(s);
    const formattedBeat = Number(bb.beat.toFixed(2));
    $('curBeat').textContent = `${bb.bar}:${formattedBeat}`;
    $('curMs').textContent = Math.floor(s * 1000).toString();
    $('curSec').textContent = s.toFixed(3);

    const totalDur = Math.max(audioDurS || 1, loopEndS || 1);
    const pct = Math.min(99.9, (s / totalDur) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressStart').textContent = fmtTime(0);
    $('progressEnd').textContent = fmtTime(totalDur);

    updateLyricDisplay();
    updateLyricScrollList();

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

setInterval(() => {
    if (currentTrack && activeTrackCfg) {
        updateLyricDisplay();
    }
}, 16);

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
                <button class="play-btn" data-idx="${idx}">▶</button>
            `;
            el.addEventListener('click', (e) => {
                let idx2 = idx;
                if (e.target.classList.contains('play-btn')) {
                    idx2 = parseInt(e.target.dataset.idx, 10);
                }
                playTrack(idx2);
                if (isMobileBreakpoint()) closeDrawer();
            });
            bodyEl.appendChild(el);
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
        const bps = cfg.bpm / 60.0;
        if (bps <= 0) return remaining / (120 / 60.0);
        return remaining / bps;
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
            time += beatsInSegment * (60 / prevBpm);
            const result = Math.max(0, time);
            return isNaN(result) ? 0 : result;
        }
        
        const beatsInSegment = tc.abs - prevBeat;
        if (beatsInSegment > 0) {
            time += beatsInSegment * (60 / prevBpm);
        }
        
        prevBeat = tc.abs;
        prevBpm = tc.bpm;
    }
    
    if (prevBpm <= 0) prevBpm = cfg.bpm;
    const finalBeats = targetAbs - prevBeat;
    if (finalBeats > 0) {
        time += finalBeats * (60 / prevBpm);
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
                const slots = _buildFlattenCharSlots(karaoke, lyricLines[idx + 1]?.time_sec || null);
                if (slots.length > 0) {
                    textHtml = slots.map((slot, sIdx) => 
                        `<span class="karaoke-char" data-start="${slot.start}" data-end="${slot.end}">${escapeHtml(slot.text)}</span>`
                    ).join('');
                }
            }
            const translation = line.translation ? `<div class="translation">${escapeHtml(line.translation)}</div>` : '';
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
        const karaokeChars = item.querySelectorAll('.karaoke-char');
        karaokeChars.forEach(char => {
            char.classList.remove('done', 'active');
        });
        
        if (idx === currentIdx) {
            item.classList.add('active');
            item.classList.remove('done');
            
            karaokeChars.forEach(char => {
                const start = parseFloat(char.dataset.start);
                const end = parseFloat(char.dataset.end);
                if (s >= end) {
                    char.classList.add('done');
                } else if (s >= start) {
                    char.classList.add('active');
                }
            });
        } else if (idx < currentIdx) {
            item.classList.remove('active');
            item.classList.add('done');
            karaokeChars.forEach(char => {
                char.classList.add('done');
            });
        } else {
            item.classList.remove('active', 'done');
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
        const ips = data.ips || [];
        const port = data.port || 5001;

        if (ips.length === 0) {
            ipList.innerHTML = '<div class="lan-ip-item" style="cursor:default;">未检测到局域网 IP</div>';
            return;
        }

        ipList.innerHTML = '';
        let selectedUrl = null;

        ips.forEach((ip, idx) => {
            const url = `http://${ip}:${port}/`;
            const item = document.createElement('div');
            item.className = 'lan-ip-item';
            item.dataset.url = url;
            item.innerHTML = `<span class="ip-label">地址</span>${url}`;
            item.addEventListener('click', () => {
                ipList.querySelectorAll('.lan-ip-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                generateLanQR(url);
            });
            ipList.appendChild(item);

            if (idx === 0) {
                selectedUrl = url;
            }
        });

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

    $('breakLoopBtn').addEventListener('click', () => breakLoop());
    $('vocalToggleBtn').addEventListener('click', () => toggleVocalMode());

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
};

document.addEventListener('DOMContentLoaded', init);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (!desktopLyricHiddenTimer && window.electronAPI && window.electronAPI.updateDesktopLyric) {
            desktopLyricHiddenTimer = setInterval(() => {
                if (!lyricLines.length || !activeTrackCfg) return;
                const s = currentPlaySec();
                let idx = 0;
                while (idx < lyricLines.length - 1 && lyricLines[idx + 1].time_sec <= s) idx += 1;
                if (idx !== activeLyricIndex) activeLyricIndex = idx;
                const line = lyricLines[idx] || lyricLines[0];
                const nextLine = lyricLines[idx + 1];
                const lineEndTime = nextLine ? nextLine.time_sec : null;
                setLyricText(line || null, s, lineEndTime);
            }, 500);
        }
    } else {
        if (desktopLyricHiddenTimer) {
            clearInterval(desktopLyricHiddenTimer);
            desktopLyricHiddenTimer = null;
        }
    }
});

})();
