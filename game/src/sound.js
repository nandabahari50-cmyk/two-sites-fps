/**
 * game/src/sound.js
 *
 * Self-contained WebAudio sound system for a tactical FPS.
 * All sounds are generated procedurally (no external audio files):
 * oscillators, noise buffers, gain envelopes, and filters.
 */

(function (global) {
    "use strict";

    const Master = {
        gain: null,
        init(ctx) {
            this.gain = ctx.createGain();
            this.gain.gain.value = 0.5;
            this.gain.connect(ctx.destination);
        },
        setVolume(v) {
            const g = Math.max(0, Math.min(1, v));
            this.gain.gain.value = g;
        },
    };

    // Shared helper: creates a gain envelope (attack, hold, release).
    function buildEnvelope(ctx, targetGain, duration, attack = 0.012, release = 0.18) {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, ctx.currentTime);
        g.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + attack);
        g.gain.setValueAtTime(targetGain, ctx.currentTime + duration - attack - release);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
        return g;
    }

    // Short filtered noise burst (gunshots, footsteps, impulses).
    function noiseBurst(ctx, gain, duration, cutoff, q) {
        const bufferSize = ctx.sampleRate * duration;
        const buf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

        const src = ctx.createBufferSource();
        src.buffer = buf;

        const f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.value = cutoff;
        f.Q.value = q;

        const env = buildEnvelope(ctx, gain, duration, 0.005, 0.08);

        src.connect(f);
        f.connect(env);
        env.connect(Master.gain);

        src.start();
        src.stop(ctx.currentTime + duration);
    }

    // Low "thump" for gunshots.
    function oscillatorThump(ctx, gain, frequency, duration) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = frequency;
        const env = buildEnvelope(ctx, gain, duration, 0.008, 0.25);
        osc.connect(env);
        env.connect(Master.gain);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    }

    // Metallic ping for hits.
    function metallicPing(ctx, gain, frequency, duration) {
        const o1 = ctx.createOscillator();
        o1.type = "sine";
        o1.frequency.value = frequency;
        const o2 = ctx.createOscillator();
        o2.type = "sine";
        o2.frequency.value = frequency * 1.02;

        const env = buildEnvelope(ctx, gain, duration, 0.008, 0.6);

        o1.connect(env);
        o2.connect(env);
        env.connect(Master.gain);

        o1.start();
        o2.start();
        o1.stop(ctx.currentTime + duration);
        o2.stop(ctx.currentTime + duration);
    }

    // Footstep noise (surface-dependent filter).
    function footstepNoise(ctx, surface, gain) {
        let cutoff = 1800;
        let q = 1.4;
        if (surface === "metal" || surface === "concrete") {
            cutoff = 2200;
            q = 1.6;
        } else if (surface === "grass" || surface === "carpet") {
            cutoff = 1200;
            q = 1.2;
        } else if (surface === "ice") {
            cutoff = 1000;
            q = 0.9;
        }
        noiseBurst(ctx, gain, 0.12, cutoff, q);
    }

    // High-pass filter helper for the reload whoosh.
    function createHighpass(ctx, cutoff = 600) {
        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = cutoff;
        return f;
    }

    function createSoundSystem(audioCtx) {
        if (!audioCtx) {
            const noop = () => {};
            return {
                master: { gain: null },
                setVolume: noop,
                gunshot: noop,
                reload: noop,
                footstep: noop,
                hit: noop,
                roundStart: noop,
                roundEnd: noop,
                bombPlant: noop,
                bombDefuse: noop,
                buyMenu: noop,
                ready: noop,
            };
        }

        if (!Master.gain) Master.init(audioCtx);

        function shotgunPatter(baseGain) {
            for (let i = 0; i < 6; i++) {
                const t = audioCtx.currentTime + i * 0.01;
                const src = audioCtx.createBufferSource();
                const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.01, audioCtx.sampleRate);
                const d = buf.getChannelData(0);
                for (let j = 0; j < buf.length; j++) d[j] = Math.random() * 2 - 1;
                src.buffer = buf;
                const g = buildEnvelope(audioCtx, baseGain, 0.01, 0.003, 0.05);
                const bp = audioCtx.createBiquadFilter();
                bp.type = "bandpass";
                bp.frequency.value = 3200 + Math.random() * 1200;
                bp.Q.value = 0.9;
                src.connect(bp);
                bp.connect(g);
                g.connect(Master.gain);
                src.start(t);
                src.stop(t + 0.01);
            }
        }

        return {
            gunshot(weapon) {
                const w = String(weapon || "pistol").toLowerCase();
                const cfg = {
                    rifle: { thump: 160, dur: 0.22, nCutoff: 2400, nQ: 1.2 },
                    shotgun: { thump: 70, dur: 0.30, nCutoff: 3600, nQ: 1.6 },
                    pistol: { thump: 220, dur: 0.16, nCutoff: 2000, nQ: 1.0 },
                };
                const c = cfg[w] || cfg.pistol;

                const noiseGain = w === "shotgun" ? 0.12 : 0.07;
                noiseBurst(audioCtx, noiseGain, c.dur, c.nCutoff, c.nQ);
                oscillatorThump(audioCtx, 0.10, c.thump, c.dur);
            },

            reload() {
                const hpf = createHighpass(audioCtx, 600);
                const src = audioCtx.createBufferSource();
                const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.35, audioCtx.sampleRate);
                const d = buf.getChannelData(0);
                for (let i = 0; i < buf.length; i++) d[i] = Math.random() * 2 - 1;
                src.buffer = buf;
                const g = buildEnvelope(audioCtx, 0.07, 0.35, 0.01, 0.05);
                src.connect(hpf);
                hpf.connect(g);
                g.connect(Master.gain);
                src.start();
                src.stop(audioCtx.currentTime + 0.35);

                setTimeout(() => {
                    const cl = audioCtx.createBufferSource();
                    const cb = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.02, audioCtx.sampleRate);
                    const cd = cb.getChannelData(0);
                    for (let i = 0; i < cd.length; i++) cd[i] = Math.random() * 2 - 1;
                    cl.buffer = cb;
                    const cg = buildEnvelope(audioCtx, 0.05, 0.02, 0.002, 0.02);
                    cl.connect(cg);
                    cg.connect(Master.gain);
                    cl.start();
                    cl.stop(audioCtx.currentTime + 0.02);
                }, 60);
            },

            footstep(surface) {
                footstepNoise(audioCtx, surface || "grass", 0.04);
            },

            hit(headshot) {
                metallicPing(audioCtx, 0.10, 1600 + (headshot ? 400 : 0), 0.35);
            },

            roundStart() {
                const t = audioCtx.currentTime;
                [523, 659, 784, 1047].forEach((f, i) => {
                    const o = audioCtx.createOscillator();
                    o.type = "square";
                    o.frequency.value = f;
                    const e = buildEnvelope(audioCtx, 0.05, 0.18, 0.008, 0.1);
                    o.connect(e);
                    e.connect(Master.gain);
                    o.start(t + i * 0.06);
                    o.stop(t + i * 0.06 + 0.18);
                });
            },

            roundEnd(win) {
                const t = audioCtx.currentTime;
                const tones = win
                    ? [523, 659, 784, 1047, 1319, 1568, 2093]
                    : [392, 349, 330, 294, 262, 247, 233];
                tones.forEach((f, i) => {
                    const o = audioCtx.createOscillator();
                    o.type = "sine";
                    o.frequency.value = f;
                    const e = buildEnvelope(audioCtx, 0.05, 0.16, 0.004, 0.05);
                    o.connect(e);
                    e.connect(Master.gain);
                    o.start(t + i * 0.04);
                    o.stop(t + i * 0.04 + 0.16);
                });
            },

            bombPlant() {
                const t = audioCtx.currentTime;
                const hum = audioCtx.createOscillator();
                hum.type = "sawtooth";
                hum.frequency.value = 80;
                const he = buildEnvelope(audioCtx, 0.03, 0.5, 0.01, 0.2);
                hum.connect(he);
                he.connect(Master.gain);
                hum.start(t);
                hum.stop(t + 0.5);

                const cl = audioCtx.createBufferSource();
                const cb = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.015, audioCtx.sampleRate);
                const cd = cb.getChannelData(0);
                for (let i = 0; i < cd.length; i++) cd[i] = Math.random() * 2 - 1;
                cl.buffer = cb;
                const cge = buildEnvelope(audioCtx, 0.04, 0.015, 0.002, 0.02);
                cl.connect(cge);
                cge.connect(Master.gain);
                cl.start(t + 0.42);
                cl.stop(t + 0.435);
            },

            bombDefuse() {
                const t = audioCtx.currentTime;
                [660, 587, 523, 466].forEach((f, i) => {
                    const o = audioCtx.createOscillator();
                    o.type = "sine";
                    o.frequency.value = f;
                    const e = buildEnvelope(audioCtx, 0.04, 0.08, 0.002, 0.02);
                    o.connect(e);
                    e.connect(Master.gain);
                    o.start(t + i * 0.07);
                    o.stop(t + i * 0.07 + 0.08);
                });
            },

            buyMenu() {
                const t = audioCtx.currentTime;
                [0.015, 0.03, 0.045, 0.06, 0.075].forEach((delay, i) => {
                    const o = audioCtx.createOscillator();
                    o.type = "square";
                    o.frequency.value = 900 + i * 200;
                    const e = buildEnvelope(audioCtx, 0.03, 0.015, 0.002, 0.01);
                    o.connect(e);
                    e.connect(Master.gain);
                    o.start(t + delay);
                    o.stop(t + delay + 0.015);
                });
            },

            ready(loaded) {
                if (loaded) {
                    const t = audioCtx.currentTime;
                    [523, 659].forEach((f, i) => {
                        const o = audioCtx.createOscillator();
                        o.type = "sine";
                        o.frequency.value = f;
                        const e = buildEnvelope(audioCtx, 0.04, 0.12, 0.004, 0.04);
                        o.connect(e);
                        e.connect(Master.gain);
                        o.start(t + i * 0.1);
                        o.stop(t + i * 0.1 + 0.12);
                    });
                } else {
                    const buzz = audioCtx.createOscillator();
                    buzz.type = "sine";
                    buzz.frequency.value = 180;
                    const e = buildEnvelope(audioCtx, 0.03, 0.15, 0.01, 0.08);
                    buzz.connect(e);
                    e.connect(Master.gain);
                    buzz.start();
                    buzz.stop(audioCtx.currentTime + 0.15);
                }
            },

            setVolume(v) {
                Master.setVolume(v);
            },
        };
    }

    global.createSoundSystem = createSoundSystem;
})(typeof window !== "undefined" ? window : globalThis);
