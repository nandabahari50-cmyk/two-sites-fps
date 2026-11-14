// The one place game state lives.
//
// Everything the simulation touches is created here once and mutated in place: no object is built
// inside a frame, so the hot loop allocates nothing and the render stays off the heap's back. The
// modules below read and write this object; none of them keeps a second copy of anything.
import * as THREE from 'three';

/** A round is 105 seconds of play plus 6 seconds of freeze at its head. */
export const ROUND_SECONDS = 105;
export const FREEZE_SECONDS = 6;
export const ROUNDS_TO_WIN = 4;
export const HALF_ROUNDS = 6;

/** Money for a round. Winning pays more than losing, and a loss pays a rising floor. */
export const MONEY_START = 800;
export const MONEY_WIN = 3250;
export const MONEY_LOSS = 1400;
export const MONEY_PLANT_BONUS = 300;
export const MONEY_KILL = 300;
export const MONEY_CAP = 9000;

export const TEAM = { ATTACK: 0, DEFEND: 1 };
export const SIDE_NAME = ['attack', 'defend'];

/** Create the state object every other module reads. */
export function createState(spawns) {
  return {
    phase: 'freeze', // freeze | live | roundEnd | matchEnd
    phaseTime: FREEZE_SECONDS,
    round: 1,
    score: [0, 0],
    time: 0,
    players: [],
    // The player's own economy and gear: what the buy menu spends and the HUD shows.
    money: MONEY_START,
    teamMoney: MONEY_START,
    weaponId: 'sidearm',
    grenades: { frag: 0, smoke: 0 },
    // The bomb. Only the attack side can plant; only the defend side can defuse.
    bomb: { state: 'carried', timer: 0, planted: 0, defused: 0 },
    objective: null, // the site marker, set by world.js
    events: [], // one-shot notifications the HUD drains each frame
    lastWinner: null,
    roundLog: [],
    hitFlash: 0,
    damageTaken: 0,
  };
}

/** Push a notification the HUD will show for a moment. */
export function emit(state, kind, text) {
  state.events.push({ kind, text, age: 0 });
}
