import { NOTE, playVoice, sparkle } from './rankUpSound';
import type { LeagueResultTier } from './leagueResults';

/**
 * League results stings, synthesised with Web Audio like the rank-up fanfare (no audio files), one
 * per card as it lands. 1st: a brass "ta-ta-taaa" call onto a held chord with a low drum and bells.
 * 2nd/3rd: a medal chime (two bright bells over a soft pad). 4th+ or alone: one soft two-note chime.
 * The season card (`finale`) plays a longer version of each: the 1st call answers itself with a
 * closing IV-V-I cadence (about 3 s), the chimes add a note and ring out longer.
 */

/** Ms from the call until the sting's main hit, so the overlay can land the trophy on it. */
export function leagueStingHitMs(tier: LeagueResultTier): number {
  return tier === 'first' ? 300 : 20;
}

function bell(ctx: AudioContext, out: AudioNode, semi: number, start: number, release: number, level: number): void {
  playVoice(ctx, out, { wave: 'sine', freq: NOTE(semi), start, attack: 0.004, hold: 0.01, release, level });
  playVoice(ctx, out, { wave: 'sine', freq: NOTE(semi) * 2.76, start, attack: 0.003, hold: 0, release: release * 0.3, level: level * 0.28 });
}

function brassChord(ctx: AudioContext, out: AudioNode, semis: number[], start: number, hold: number, release: number, bright: number): void {
  for (const semi of semis) {
    for (const detune of [-7, 7]) {
      playVoice(ctx, out, {
        wave: 'sawtooth',
        freq: NOTE(semi),
        start,
        attack: 0.05,
        hold,
        release,
        level: 0.07,
        detune,
        lowpass: { from: 500, to: bright },
      });
    }
  }
}

function first(ctx: AudioContext, bus: AudioNode, t0: number, finale: boolean): void {
  // The call: two short notes on G, then the hit.
  for (const at of [0, 0.13]) {
    brassChord(ctx, bus, [7], t0 + at, 0.05, 0.12, 2400);
    playVoice(ctx, bus, { wave: 'triangle', freq: NOTE(19), start: t0 + at, attack: 0.006, hold: 0.05, release: 0.15, level: 0.18 });
  }
  const hit = t0 + leagueStingHitMs('first') / 1000;
  brassChord(ctx, bus, [0, 4, 7, 12], hit, finale ? 0.5 : 0.75, 0.8, 3200);
  playVoice(ctx, bus, { wave: 'triangle', freq: NOTE(24), start: hit, attack: 0.006, hold: 0.3, release: 0.6, level: 0.16 });
  playVoice(ctx, bus, { wave: 'sine', freq: NOTE(-12), start: hit, attack: 0.04, hold: 0.6, release: 0.8, level: 0.3 });
  playVoice(ctx, bus, { wave: 'sine', freq: 110, glideTo: 46, start: hit, attack: 0.006, hold: 0.02, release: 0.7, level: 0.5 });
  [24, 28, 31, 36].forEach((semi, i) => bell(ctx, bus, semi, hit + 0.1 + i * 0.08, 1.0, 0.08));
  sparkle(ctx, bus, hit, 0.9, 0.06);

  if (!finale) return;
  // Season finale: the call answers itself, IV - V - I, onto a bigger, longer chord.
  const answer = hit + 0.7;
  brassChord(ctx, bus, [5, 9, 12], answer, 0.12, 0.2, 2800);
  brassChord(ctx, bus, [7, 11, 14], answer + 0.22, 0.12, 0.2, 3000);
  const end = answer + 0.48;
  brassChord(ctx, bus, [0, 7, 12, 16, 19], end, 1.0, 1.1, 3800);
  playVoice(ctx, bus, { wave: 'sine', freq: NOTE(-12), start: end, attack: 0.04, hold: 1.0, release: 1.0, level: 0.32 });
  playVoice(ctx, bus, { wave: 'sine', freq: 98, glideTo: 41, start: end, attack: 0.006, hold: 0.03, release: 0.9, level: 0.6 });
  [24, 31, 36, 40, 43].forEach((semi, i) => bell(ctx, bus, semi, end + 0.1 + i * 0.09, 1.3, 0.085));
  sparkle(ctx, bus, end, 1.3, 0.075);
}

function podium(ctx: AudioContext, bus: AudioNode, t0: number, finale: boolean): void {
  // Soft pad under two (season: three) bright bells a fifth apart.
  for (const semi of [12, 16, 19]) {
    playVoice(ctx, bus, { wave: 'triangle', freq: NOTE(semi), start: t0, attack: 0.08, hold: finale ? 0.6 : 0.35, release: 0.8, level: 0.07 });
  }
  const notes = finale ? [31, 38, 43] : [31, 38];
  notes.forEach((semi, i) => bell(ctx, bus, semi, t0 + i * 0.14, finale ? 1.4 : 1.1, 0.13));
  sparkle(ctx, bus, t0 + 0.1, finale ? 0.8 : 0.5, 0.03);
}

function calm(ctx: AudioContext, bus: AudioNode, t0: number, finale: boolean): void {
  const notes = finale ? [24, 28, 31] : [24, 28];
  notes.forEach((semi, i) =>
    playVoice(ctx, bus, { wave: 'sine', freq: NOTE(semi), start: t0 + i * 0.16, attack: 0.01, hold: 0.04, release: finale ? 1.0 : 0.8, level: 0.14 })
  );
}

/** Plays the sting now; `peak` is the user's volume step (as the rank-up fanfare). */
export function playLeagueResultSting(ctx: AudioContext, peak: number, tier: LeagueResultTier, finale: boolean): void {
  const t0 = ctx.currentTime + 0.02;
  // One bus with a soft compressor, so stacked voices never clip or turn harsh.
  const bus = ctx.createGain();
  bus.gain.value = peak;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.01;
  comp.release.value = 0.25;
  bus.connect(comp).connect(ctx.destination);
  if (tier === 'first') first(ctx, bus, t0, finale);
  else if (tier === 'podium') podium(ctx, bus, t0, finale);
  else calm(ctx, bus, t0, finale);
}

/** A buzz for 'vibration' (ms on/off): a celebratory one for 1st, a double tap for a medal, one tap calm. */
export function leagueResultVibration(tier: LeagueResultTier, finale: boolean): number[] {
  const base = tier === 'first' ? [30, 60, 30, 60, 120] : tier === 'podium' ? [40, 80, 60] : [40];
  return finale && tier !== 'calm' ? [...base, 80, 40, 40, 160] : base;
}
