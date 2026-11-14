// The buy menu: money spent between rounds on a weapon and grenades.
//
// It only opens during the freeze, which is what makes the economy matter: you decide what you can
// afford before the round starts, and a bad buy is a round you play with a pistol against rifles.
import { MONEY_CAP } from './state.js';
import { WEAPONS, GRENADES } from './weapons.js';

export const BUY_LIST = [
  { key: '1', kind: 'weapon', id: 'rifle' },
  { key: '2', kind: 'weapon', id: 'smg' },
  { key: '3', kind: 'weapon', id: 'shotgun' },
  { key: '4', kind: 'grenade', id: 'frag' },
  { key: '5', kind: 'grenade', id: 'smoke' },
];

export function priceOf(entry) {
  return entry.kind === 'weapon' ? WEAPONS[entry.id].cost : GRENADES[entry.id].cost;
}

export function labelOf(entry) {
  return entry.kind === 'weapon' ? WEAPONS[entry.id].name : GRENADES[entry.id].name;
}

/**
 * Try to buy one entry. Returns a short message for the HUD, and never throws: a refused purchase
 * is a message, not a crash.
 */
export function buy(state, entry, applyWeapon) {
  if (state.phase !== 'freeze') return { ok: false, msg: 'Buy only in the freeze' };
  const price = priceOf(entry);
  if (state.money < price) return { ok: false, msg: `Need $${price}` };

  if (entry.kind === 'weapon') {
    if (state.weaponId === entry.id) return { ok: false, msg: 'Already carrying it' };
    state.money -= price;
    state.weaponId = entry.id;
    applyWeapon(entry.id);
    return { ok: true, msg: `Bought ${WEAPONS[entry.id].name}` };
  }

  const have = state.grenades[entry.id] ?? 0;
  const cap = entry.id === 'frag' ? 2 : 1;
  if (have >= cap) return { ok: false, msg: 'No room for more' };
  state.money -= price;
  state.grenades[entry.id] = have + 1;
  return { ok: true, msg: `Bought ${GRENADES[entry.id].name}` };
}

/** HTML for the menu, built as a string so the HUD owns every DOM write in one place. */
export function menuHtml(state) {
  const rows = BUY_LIST.map((entry) => {
    const price = priceOf(entry);
    const afford = state.money >= price;
    const owned = entry.kind === 'weapon'
      ? state.weaponId === entry.id
      : (state.grenades[entry.id] ?? 0) >= (entry.id === 'frag' ? 2 : 1);
    const cls = owned ? 'buy-row owned' : afford ? 'buy-row' : 'buy-row poor';
    return `<li class="${cls}"><b>${entry.key}</b><span>${labelOf(entry)}</span><i>$${price}</i></li>`;
  }).join('');
  return `<div class="buy-head">BUY &nbsp;<span>$${Math.round(state.money)}</span></div><ul>${rows}</ul>`;
}

export { MONEY_CAP };
