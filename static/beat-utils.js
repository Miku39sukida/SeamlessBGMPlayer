(() => {
'use strict';

const NOTE_VALUES = {
    whole:     { name: '全音符',   denom: 1,  fraction: 4 },
    half:      { name: '二分音符', denom: 2,  fraction: 2 },
    quarter:   { name: '四分音符', denom: 4,  fraction: 1 },
    eighth:    { name: '八分音符', denom: 8,  fraction: 0.5 },
    sixteenth: { name: '十六分音符', denom: 16, fraction: 0.25 }
};

const BeatUtils = {
    NOTE_VALUES: NOTE_VALUES,

    /**
     * 音符时值 → 拍长系数（以四分音符为基准 1）。
     * noteValue 可为键名（'quarter'）或分母数值（4）。默认四分音符 = 1。
     * 例：八分音符 = 0.5（一拍 = 半个四分音符），全音符 = 4。
     */
    noteValueFraction(noteValue) {
        if (NOTE_VALUES[noteValue]) return NOTE_VALUES[noteValue].fraction;
        if (typeof noteValue === 'number') {
            for (const k in NOTE_VALUES) if (NOTE_VALUES[k].denom === noteValue) return NOTE_VALUES[k].fraction;
            return 1;
        }
        return 1;
    },

    /** 音符时值 → 拍号分母（用于显示，如 4/4、6/8） */
    noteValueDenom(noteValue) {
        if (NOTE_VALUES[noteValue]) return NOTE_VALUES[noteValue].denom;
        if (typeof noteValue === 'number') {
            for (const k in NOTE_VALUES) if (NOTE_VALUES[k].denom === noteValue) return noteValue;
            return 4;
        }
        return 4;
    },

    sortAndFilterChanges(tempoChanges, meterChanges, beatsPerBar, zeroBar, zeroBeat) {
        const sortedTempo = [...(tempoChanges || [])]
            .filter(tc => tc.bar >= 1 && tc.beat >= 1 && tc.bpm > 0)
            .map(tc => {
                const abs = this.barBeatToAbs(tc.bar, tc.beat, beatsPerBar, zeroBar, zeroBeat, meterChanges);
                return { ...tc, abs };
            })
            .sort((a, b) => a.abs - b.abs);

        const sortedMeter = [...(meterChanges || [])]
            .filter(mc => mc.bar >= 1 && mc.beat >= 1 && mc.beats_per_bar > 0)
            .map(mc => {
                const abs = this.barBeatToAbs(mc.bar, mc.beat, beatsPerBar, zeroBar, zeroBeat, meterChanges);
                return { ...mc, abs };
            })
            .sort((a, b) => a.abs - b.abs);

        return { sortedTempo, sortedMeter };
    },

    barBeatToAbs(targetBar, targetBeat, beatsPerBar, zeroBar, zeroBeat, meterChanges) {
        const sortedMeter = [...(meterChanges || [])]
            .filter(mc => mc.bar >= 1 && mc.beat >= 1 && mc.beats_per_bar > 0)
            .map(mc => ({ ...mc }))
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });

        const calcAbs = (bar, beat) => {
            let currentBar = 1;
            let currentBpb = beatsPerBar;
            let absBeat = 0;

            for (const mc of sortedMeter) {
                if (mc.bar > bar) {
                    break;
                }

                if (mc.bar === bar && mc.beat <= beat) {
                    const beatsToChange = (mc.bar - currentBar) * currentBpb + (mc.beat - 1);
                    absBeat += beatsToChange;
                    currentBar = mc.bar;
                    currentBpb = mc.beats_per_bar;
                    break;
                }

                const beatsToChange = (mc.bar - currentBar) * currentBpb + (mc.beat - 1);
                absBeat += beatsToChange;
                currentBar = mc.bar;
                currentBpb = mc.beats_per_bar;
            }

            const beatsRemaining = (bar - currentBar) * currentBpb + (beat - 1);
            absBeat += beatsRemaining;
            return absBeat;
        };

        const targetAbs = calcAbs(targetBar, targetBeat);
        const zeroAbs = calcAbs(zeroBar, zeroBeat);
        return targetAbs - zeroAbs + zeroAbs;
    },

    absToBarBeat(absBeat, beatsPerBar, zeroBar, zeroBeat, meterChanges) {
        const sortedMeter = [...(meterChanges || [])]
            .filter(mc => mc.bar >= 1 && mc.beat >= 1 && mc.beats_per_bar > 0)
            .map(mc => ({ ...mc }))
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });

        let currentBar = 1;
        let currentBpb = beatsPerBar;
        let absCounter = 0;

        for (const mc of sortedMeter) {
            const prevBar = currentBar;
            const prevBeat = absCounter % currentBpb === 0 ? currentBpb : absCounter % currentBpb;
            
            let mcAbs = 0;
            let tempBar = 1;
            let tempBpb = beatsPerBar;
            for (const m of sortedMeter) {
                if (m.bar > mc.bar) break;
                if (m.bar === mc.bar && m.beat <= mc.beat) {
                    mcAbs += (m.bar - tempBar) * tempBpb + (m.beat - 1);
                    tempBar = m.bar;
                    tempBpb = m.beats_per_bar;
                    break;
                }
                mcAbs += (m.bar - tempBar) * tempBpb + (m.beat - 1);
                tempBar = m.bar;
                tempBpb = m.beats_per_bar;
            }
            mcAbs += (mc.bar - tempBar) * tempBpb + (mc.beat - 1);

            if (mcAbs > absBeat) {
                break;
            }

            absCounter = mcAbs;
            currentBar = mc.bar;
            currentBpb = mc.beats_per_bar;
        }

        const remainingBeats = absBeat - absCounter;
        const fullBars = Math.floor(remainingBeats / currentBpb);
        currentBar += fullBars;
        const beatInBar = remainingBeats % currentBpb + 1;

        return { bar: Math.max(1, currentBar), beat: beatInBar };
    },

    timeToAbsBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, noteValueFraction = 1) {
        const { sortedTempo, sortedMeter } = this.sortAndFilterChanges(tempoChanges, meterChanges, beatsPerBar, zeroBar, zeroBeat);

        const zeroAbsBeat = this.barBeatToAbs(zeroBar, zeroBeat, beatsPerBar, 1, 1, []);

        let absBeatRaw = zeroAbsBeat;
        let prevTime = 0;
        let prevBeat = zeroAbsBeat;
        let prevBpm = bpm;

        const allChanges = [];
        sortedTempo.forEach(tc => allChanges.push({ type: 'tempo', abs: tc.abs, value: tc.bpm, time: 0 }));
        sortedMeter.forEach(mc => allChanges.push({ type: 'meter', abs: mc.abs, value: mc.beats_per_bar, time: 0 }));
        allChanges.sort((a, b) => a.abs - b.abs);

        for (const change of allChanges) {
            const beatsToChange = change.abs - prevBeat;
            const timeToChange = beatsToChange * (60 / prevBpm) * noteValueFraction;
            const changeTime = prevTime + timeToChange;

            if (currentTime < changeTime) {
                const beatsElapsed = (currentTime - prevTime) * (prevBpm / 60) / noteValueFraction;
                absBeatRaw = prevBeat + beatsElapsed;
                break;
            }
            prevBeat = change.abs;
            prevTime = changeTime;
            if (change.type === 'tempo') {
                prevBpm = change.value;
            }
            absBeatRaw = change.abs;
        }
        if (currentTime >= prevTime) {
            const beatsElapsed = (currentTime - prevTime) * (prevBpm / 60) / noteValueFraction;
            absBeatRaw = prevBeat + beatsElapsed;
        }

        return absBeatRaw;
    },

    absBeatToTime(absBeat, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, noteValueFraction = 1) {
        const { sortedTempo, sortedMeter } = this.sortAndFilterChanges(tempoChanges, meterChanges, beatsPerBar, zeroBar, zeroBeat);

        const zeroAbsBeat = this.barBeatToAbs(zeroBar, zeroBeat, beatsPerBar, 1, 1, []);
        const targetAbs = absBeat;

        if (targetAbs <= zeroAbsBeat) return 0;

        let time = 0;
        let prevBeat = zeroAbsBeat;
        let prevBpm = bpm;

        const allChanges = [];
        sortedTempo.forEach(tc => allChanges.push({ type: 'tempo', abs: tc.abs, value: tc.bpm }));
        sortedMeter.forEach(mc => allChanges.push({ type: 'meter', abs: mc.abs, value: mc.beats_per_bar }));
        allChanges.sort((a, b) => a.abs - b.abs);

        for (const change of allChanges) {
            if (change.abs >= targetAbs) {
                const beatsInSegment = targetAbs - prevBeat;
                if (beatsInSegment > 0 && prevBpm > 0) {
                    time += beatsInSegment * (60 / prevBpm) * noteValueFraction;
                }
                prevBeat = targetAbs;
                break;
            }

            const beatsInSegment = change.abs - prevBeat;
            if (beatsInSegment > 0 && prevBpm > 0) {
                time += beatsInSegment * (60 / prevBpm) * noteValueFraction;
            }

            prevBeat = change.abs;
            if (change.type === 'tempo') {
                prevBpm = change.value;
            }
        }

        if (prevBpm <= 0) prevBpm = bpm;
        const finalBeats = targetAbs - prevBeat;
        if (finalBeats > 0) {
            time += finalBeats * (60 / prevBpm) * noteValueFraction;
        }

        return Math.max(0, time);
    },

    getEffectiveBeatsPerBar(bar, beat, beatsPerBar, meterChanges) {
        let effective = beatsPerBar;
        const sorted = [...(meterChanges || [])]
            .filter(mc => mc.bar >= 1 && mc.beat >= 1 && mc.beats_per_bar > 0)
            .sort((a, b) => {
                if (a.bar !== b.bar) return a.bar - b.bar;
                return a.beat - b.beat;
            });
        for (const mc of sorted) {
            if (mc.bar < bar || (mc.bar === bar && mc.beat <= beat)) {
                effective = mc.beats_per_bar;
            } else {
                break;
            }
        }
        return effective;
    },

    timeToBarBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, noteValueFraction = 1) {
        const absBeatRaw = this.timeToAbsBeat(currentTime, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, noteValueFraction);
        const { bar, beat } = this.absToBarBeat(absBeatRaw, beatsPerBar, zeroBar, zeroBeat, meterChanges);
        return { bar: Math.max(1, bar), beat, abs: absBeatRaw };
    },

    barBeatToTime(targetBar, targetBeat, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, noteValueFraction = 1) {
        const absBeat = this.barBeatToAbs(targetBar, targetBeat, beatsPerBar, zeroBar, zeroBeat, meterChanges);
        return this.absBeatToTime(absBeat, bpm, beatsPerBar, zeroBar, zeroBeat, tempoChanges, meterChanges, noteValueFraction);
    },

    exportChanges(tempoChanges, meterChanges) {
        const data = {
            t: (tempoChanges || []).map(tc => ({ b: tc.bar, d: tc.beat, v: tc.bpm })),
            m: (meterChanges || []).map(mc => ({ b: mc.bar, d: mc.beat, v: mc.beats_per_bar }))
        };
        return btoa(JSON.stringify(data));
    },

    importChanges(code) {
        try {
            const data = JSON.parse(atob(code.trim()));
            const tempoChanges = (data.t || []).map(tc => ({ bar: tc.b, beat: tc.d, bpm: tc.v }));
            const meterChanges = (data.m || []).map(mc => ({ bar: mc.b, beat: mc.d, beats_per_bar: mc.v }));
            return { tempoChanges, meterChanges };
        } catch (e) {
            return null;
        }
    }
};

window.BeatUtils = BeatUtils;

})();