// The round manager: the thing that makes this a game rather than a shooting range.
//
// A round starts with a freeze, goes live, and ends three ways: the attackers plant and the bomb
// detonates, the defenders defuse it, one side is eliminated, or the clock runs out (which the
// defenders win, because an unplanted bomb is a failed attack). Between rounds both sides are paid,
// the survivors keep their gear and the dead do not, and the sides swap at the half.
//
// Plant and defuse are held-key actions with a timer, not a single press, so standing on the site
// while the other team is alive is a real risk.
import { ROUND_SECONDS, FREEZE_SECONDS, ROUNDS_TO_WIN, HALF_ROUNDS, MONEY_WIN, MONEY_LOSS, MONEY_PLANT_BONUS, MONEY_CAP, TEAM, SIDE_NAME, emit } from './state.js';
import { resetBot, syncBot } from './bots.js';
import { refill, equip, WEAPONS } from './weapons.js';

export const PLANT_SECONDS = 3.2;
export const DEFUSE_SECONDS = 5.0;
export const BOMB_SECONDS = 40;

export function createRound(world, deps) {
  const { state, player, bots, hud } = deps;

  function teamAlive(side) {
    if (side === player.side) return player.state.alive ? 1 : 0 + bots.filter((b) => b.side === player.side && b.alive).length;
    return bots.filter((b) => b.side === side && b.alive).length;
  }

  function aliveCount(side) {
    let n = 0;
    if (side === player.side && player.state.alive) n += 1;
    for (const b of bots) if (b.side === side && b.alive) n += 1;
    return n;
  }

  function startRound(resetGear) {
    state.phase = 'freeze';
    state.phaseTime = FREEZE_SECONDS;
    state.bomb.state = 'carried';
    state.bomb.timer = 0;
    state.bomb.planted = 0;
    state.bomb.defused = 0;
    state.plantProgress = 0;
    state.defuseProgress = 0;
    state.time = 0;
    state.damageTaken = 0;
    state.hitFlash = 0;
    state.events.length = 0;

    player.state.alive = true;
    player.state.hp = 100;
    const spawns = player.side === TEAM.ATTACK ? world.attackSpawns : world.defendSpawns;
    player.spawnAt(spawns[0]);

    for (const bot of bots) resetBot(bot, world);

    if (resetGear) {
      player.weapon = 'sidearm';
      player.weaponState = equipFresh('sidearm');
      state.grenades = { frag: 0, smoke: 0 };
      state.money = 800;
    } else {
      refill(player.weaponState);
    }
  }

  function equipFresh(id) {
    const state2 = { def: WEAPONS[id], mag: WEAPONS[id].magSize, reserve: WEAPONS[id].reserveMax, reloading: false, reloadLeft: 0, cooldown: 0, burstIndex: 0 };
    return state2;
  }

  function endRound(winner, reason) {
    if (state.phase === 'roundEnd' || state.phase === 'matchEnd') return;
    state.phase = 'roundEnd';
    state.phaseTime = 3.0;
    state.lastWinner = winner;
    state.roundLog.push({ round: state.round, winner, reason });
    if (winner !== null) state.score[winner] += 1;
    state.events.length = 0;
    emit(state, 'round', `${winner === null ? 'Round drawn' : `${SIDE_NAME[winner]} wins`}: ${reason}`);

    // Economy: the winner takes the round bonus, the loser the loss bonus, survivors keep gear.
    const won = winner === player.side;
    const pay = won ? MONEY_WIN : MONEY_LOSS;
    state.money = Math.min(MONEY_CAP, state.money + pay);
    if (state.bomb.planted > 0 && player.side === TEAM.ATTACK) {
      state.money = Math.min(MONEY_CAP, state.money + MONEY_PLANT_BONUS);
    }
  }

  /** One fixed step of the round clock and every rule that hangs off it. */
  function step(dt, ctx) {
    state.time += dt;

    if (state.phase === 'freeze') {
      state.phaseTime -= dt;
      if (state.phaseTime <= 0) {
        state.phase = 'live';
        state.phaseTime = ROUND_SECONDS;
        emit(state, 'live', 'Round live');
      }
      return;
    }

    if (state.phase === 'roundEnd') {
      state.phaseTime -= dt;
      if (state.phaseTime <= 0) {
        if (state.score[TEAM.ATTACK] >= ROUNDS_TO_WIN || state.score[TEAM.DEFEND] >= ROUNDS_TO_WIN) {
          state.phase = 'matchEnd';
          emit(state, 'match', `${SIDE_NAME[state.score[0] > state.score[1] ? 0 : 1]} takes the match`);
        } else {
          state.round += 1;
          // Sides swap at the half, so the player attacks for the first half and defends after.
          if (state.round === HALF_ROUNDS + 1) {
            state.score = [state.score[1], state.score[0]];
            player.side = player.side === TEAM.ATTACK ? TEAM.DEFEND : TEAM.ATTACK;
            for (const bot of bots) bot.side = bot.side === TEAM.ATTACK ? TEAM.DEFEND : TEAM.ATTACK;
            emit(state, 'swap', 'Sides swapped');
            startRound(false);
            return;
          }
          startRound(false);
        }
      }
      return;
    }

    if (state.phase === 'matchEnd') return;

    // --- Live ---
    state.phaseTime -= dt;

    // The bomb's clock is the round's clock once it is planted: no more time limit.
    if (state.bomb.state === 'planted') {
      state.bomb.timer -= dt;
      if (state.bomb.timer <= 0) {
        endRound(TEAM.ATTACK, 'the bomb detonated');
        return;
      }
    } else if (state.phaseTime <= 0) {
      endRound(TEAM.DEFEND, 'time expired');
      return;
    }

    // Elimination ends the round either way.
    const attackAlive = aliveCount(TEAM.ATTACK);
    const defendAlive = aliveCount(TEAM.DEFEND);
    if (attackAlive === 0 && state.bomb.state !== 'planted') {
      endRound(TEAM.DEFEND, 'attackers eliminated');
      return;
    }
    if (defendAlive === 0) {
      endRound(TEAM.ATTACK, 'defenders eliminated');
      return;
    }
    if (attackAlive === 0 && state.bomb.state === 'planted') {
      // The bomb keeps ticking: the defenders must still find and defuse it.
      // Nothing to do here; the timer above decides.
    }
  }

  return { startRound, step, endRound, aliveCount, equipFresh };
}

/** Where the player is standing relative to the sites: null, or the site object. */
export function siteUnder(world, position) {
  for (const site of world.sites) {
    const dx = position.x - site.center.x;
    const dz = position.z - site.center.z;
    if (Math.hypot(dx, dz) <= site.radius) return site;
  }
  return null;
}
