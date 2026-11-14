// Bot roster: five a side, named, with a route and a behaviour so the two teams do something
// different from each other and from round to round.
import { createBot } from './bots.js';
import { TEAM } from './state.js';

const NAMES = ['Rook', 'Vex', 'Halyard', 'Moss', 'Pike', 'Cinder', 'Tallow', 'Brunt', 'Sable', 'Quill'];

const ATTACK_ROUTES = ['A_long', 'B_long', 'A_short', 'B_short', 'mid'];
const DEFEND_ROUTES = ['mid', 'A_short', 'B_short', 'A_long', 'B_long'];
const DEFEND_HOLDS = ['A', 'B', 'mid', 'A', 'B'];

export function createBots(scene, world, rand) {
  const bots = [];

  // The player holds slot 0 on the attack side, so the team's bots start at slot 1.
  for (let i = 0; i < 4; i += 1) {
    bots.push(createBot(scene, world, {
      side: TEAM.ATTACK,
      slot: i + 1,
      route: ATTACK_ROUTES[(i + 1) % ATTACK_ROUTES.length],
      hold: DEFEND_HOLDS[i % DEFEND_HOLDS.length],
      behaviour: 'push',
      weaponId: i === 0 ? 'rifle' : 'smg',
      skill: 0.55 + rand() * 0.2,
      rand,
      name: NAMES[i + 1],
    }));
  }

  for (let i = 0; i < 5; i += 1) {
    bots.push(createBot(scene, world, {
      side: TEAM.DEFEND,
      slot: i,
      route: DEFEND_ROUTES[i],
      hold: DEFEND_HOLDS[i],
      behaviour: 'hold',
      weaponId: i < 3 ? 'rifle' : 'smg',
      skill: 0.58 + rand() * 0.22,
      rand,
      name: NAMES[i + 5],
    }));
  }

  return bots;
}
