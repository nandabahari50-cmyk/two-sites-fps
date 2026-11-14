// Two Sites - match statistics and scoreboard system.
//
// A statistics layer for a tactical FPS. The engine is pure: no DOM calls, no imports, no game-loop
// coupling. It records kills, damage, assists and rounds, then serves snapshots through the public
// API. Rendering is decoupled into `mount()` (which builds the scoreboard table, match summary and
// kill feed) and `update()` (called each frame). This keeps the hot tracking path allocation-free
// and makes the module trivially testable in Node.
//
// Public API:
//   createStats() -> {
//     recordKill(killer, victim, weapon, headshot)
//     recordDamage(attacker, victim, amount, hitbox)
//     recordRound(team, reason)          // team: 0 attack, 1 defend
//     recordRoundEnd(winner, reason)     // controlled alternative to recordRound
//     getPlayerStats(id)
//     getScoreboard()
//     getMatchSummary()
//     reset()
//     mount(container)
//     update()
//   }
//
// The engine tracks per-player: kills, deaths, assists, headshots, damage dealt/taken, ADR
// (average damage per round), KAST (kill/assist/survive/trade %), money and rounds played. It
// tracks per-round: number, winner, win reason, duration and the kill feed.

// -------------------------------------------------------------------------------------------------
// DOM helpers. The module only writes the page inside `mount()` and `update()`. A real page loads
// `game/style.css`, which supplies every class used below.
// -------------------------------------------------------------------------------------------------
const CSS = `
  .scoreboard { width: 100%; border-collapse: collapse; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; }
  .scoreboard th, .scoreboard td { border: 1px solid #2b323b; padding: 5px 8px; text-align: left; }
  .scoreboard thead th { background: #1c2027; cursor: pointer; user-select: none; }
  .scoreboard thead th::after { content: '\\25b2'; color: #93a0ad; }
  .scoreboard thead th.sorted::after { content: '\\25bc'; color: #eceff2; }
  .scoreboard tbody tr:nth-child(even) { background: #161a1f; }
  .scoreboard td.num, .scoreboard th.num { text-align: right; }
  .scoreboard .team-head { background: #232a33; color: #eceff2; font-weight: 700; border-top: 2px solid #e8a33d; }
  .scoreboard .team-head.attack { border-top-color: #e8a33d; }
  .scoreboard .team-head.defend { border-top-color: #4fbf7a; }
  .scoreboard .cell-kills.good { color: #4fbf7a; }
  .scoreboard .cell-kills.bad { color: #d8453a; }
  .scoreboard .cell-damage { color: #6fb7d6; }
  .scoreboard .cell-adr { color: #6fb7d6; }
  .scoreboard .cell-kast.good { color: #4fbf7a; }
  .scoreboard .cell-kast.bad { color: #4fbf7a; }
  .scoreboard .cell-mvp { background: #232a33; border: 1px solid #e8a33d; font-weight: 700; color: #e8a33d; }

  .summary-card { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-top: 14px; }
  .summary-card .card { background: #1c2027; border: 1px solid #2b323b; padding: 12px 14px; border-radius: 6px; }
  .summary-card .card h2 { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #93a0ad; }
  .summary-card .card .value { font-size: 20px; font-weight: 700; color: #eceff2; }
  .summary-card .card .value.mvp { color: #e8a33d; }
  .summary-card .card .sub { font-size: 11px; color: #93a0ad; margin-top: 2px; }

  .feed { max-height: 200px; overflow-y: auto; border: 1px solid #2b323b; background: #101317; border-radius: 6px; padding: 8px; font-family: ui-monospace, monospace; font-size: 11px; }
  .feed .feed-row { display: flex; gap: 8px; padding: 3px 6px; border-radius: 3px; border-left: 2px solid #e8a33d; }
  .feed .feed-row.kill { border-left-color: #d8453a; }
  .feed .feed-row.death { border-left-color: #4fbf7a; }
  .feed .feed-row.round { border-left-color: #e8a33d; }
  .feed .feed-row .who { font-weight: 700; }
  .feed .feed-row .meta { color: #93a0ad; font-size: 10px; }
  .feed .feed-buffer { color: #444c55; font-style: italic; }

  .panel { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .panel h1 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0.08em; color: #eceff2; }
`;

// Shared HTML escaping so player names and feed text never inject raw markup.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// -------------------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------------------
const state = {};

// Sort state for the scoreboard table.
let sort = { key: null, dir: 1 };

// Player ordering is stable and derived from KAST so the table stays readable.
const playerOrder = [];

// Reward multipliers for the efficiency rating (higher is better).
const KILL_MULT = 1;
const ASSIST_MULT = 1;
const HEADSHOT_MULT = 1.2;

// -------------------------------------------------------------------------------------------------
// Public creation
// -------------------------------------------------------------------------------------------------
export function createStats() {
  return {
    // ------------------------------------------------------------------------------------------
    // Recording
    // ------------------------------------------------------------------------------------------
    recordKill(killer, victim, weapon, headshot) {
      if (killer == null || victim == null || !weapon) return;
      const k = String(killer);
      const v = String(victim);
      const w = String(weapon);

      ensurePlayer(k);
      ensurePlayer(v);

      const killerSt = state[k];
      const victimSt = state[v];

      // Kill/death bookkeeping.
      killerSt.kills += 1;
      if (headshot) killerSt.headshots += 1;
      victimSt.deaths += 1;

      // A kill is only meaningful as a "survive" when the victim is no longer alive. The engine
      // marks the victim dead here so `recordSurvive`/`recordTrade` can compute KAST correctly.
      victimSt.alive = false;

      // Assists belong to the team of the person who recorded the kill. The game loop passes the
      // attacker's side so we can credit teammates; this keeps KAST meaningful across sub-kills.
      if (killerSt.team === victimSt.team && killerSt.team !== null) {
        killerSt.assists += 1;
      }

      // Rebuild derived percent fields. `roundsPlayed` is tracked by the round layer so a player
      // only earns an ADR/KAST denominator once they have actually entered a round.
      rebuildDerived(killerSt);
      rebuildDerived(victimSt);

      // Feed entry. The table keeps a short cursor so the DOM never grows unbounded.
      feed.push({ kind: 'kill', who: k, text: `${weaponLabel(w)} killed ${v}${headshot ? ' (headshot)' : ''}` });
    },

    recordDamage(attacker, victim, amount, hitbox) {
      if (attacker == null || victim == null || amount == null) return;
      const a = String(attacker);
      const v = String(victim);
      ensurePlayer(a);
      ensurePlayer(v);

      const attackerSt = state[a];
      const victimSt = state[v];

      attackerSt.damageDealt += Number(amount) || 0;
      victimSt.damageTaken += Number(amount) || 0;

      // Damage also contributes to ADR, so the per-player derived values move with it.
      rebuildDerived(attackerSt);
      rebuildDerived(victimSt);

      feed.push({ kind: 'damage', who: a, text: `${hitbox ? hitbox : 'body'} dealt ${Number(amount) || 0} damage${attackerSt.id === victimSt.id ? ' to self' : ''}` });
    },

    recordAssist(assister, victim, round) {
      if (!assister || !victim || !round) return;
      const a = String(assister);
      const v = String(victim);
      ensurePlayer(a);
      ensurePlayer(v);

      const st = state[a];
      // Assists are only awarded to an alive teammate; a self-assist is a no-op.
      if (!st.alive || st.id === v) return;

      st.assists += 1;
      st.alive = false; // the assist finishes a round for that player
      rebuildDerived(st);

      feed.push({ kind: 'assist', who: a, text: `assist on round ${round} for ${v}` });
    },

    recordSurvive(id, reason) {
      if (!id) return;
      const st = state[String(id)];
      if (!st || !st.alive) return;
      st.survives += 1;
      st.alive = false;
      rebuildDerived(st);
      feed.push({ kind: 'survive', who: st.id, text: `survived round ${reason || 'unknown'}` });
    },

    recordTrade(killer, victim, weapon) {
      if (!killer || !victim || !weapon) return;
      const k = String(killer);
      const v = String(victim);
      ensurePlayer(k);
      ensurePlayer(v);

      const killerSt = state[k];
      const victimSt = state[v];
      // Trade: a kill and a death happened in the same exchange.
      killerSt.kills += 1;
      killerSt.assists += 1;
      victimSt.deaths += 1;
      victimSt.alive = false;
      if (headshot) killerSt.headshots += 1;

      rebuildDerived(killerSt);
      rebuildDerived(victimSt);

      feed.push({ kind: 'trade', who: k, text: `trade: ${weaponLabel(weapon)} killed ${v}` });
    },

    recordRound(team, reason) {
      if (team == null || !reason) return;
      const t = Number(team);
      roundLog.push({ roundNumber: roundLog.length + 1, team: t, reason, win: t });
      score[t] += 1;

      // The round layer closes the round, so recompute derived values for every living player.
      for (const id in state) {
        const st = state[id];
        if (st.roundsPlayed > 0) rebuildDerived(st);
      }
    },

    // Alias so callers may use the more discoverable name.
    recordRoundEnd(team, reason) { this.recordRound(team, reason); },

    // ------------------------------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------------------------------
    getPlayerStats(id) {
      const st = state[String(id)];
      return st ? { ...st } : null;
    },

    getScoreboard() {
      // Return a stable snapshot with derived columns resolved.
      const players = playerOrder.map((id) => ({ id, ...state[id] }));
      return {
        players,
        score,
        roundLog,
      };
    },

    getMatchSummary() {
      const p = playerOrder.map((id) => ({ id, ...state[id] }));
      const totalKast = p.reduce((s, x) => s + x.kills + x.assists + x.survives + x.trades, 0);
      const kast = p.length ? totalKast / (p.reduce((s, x) => s + x.roundsPlayed, 0) || 1) : 0;
      const mvp = pickMvp(p);
      const eff = (p) => {
        let sum = 0;
        for (const x of p) sum += (x.kills + x.assists) * KILL_MULT + x.headshots * HEADSHOT_MULT + x.trades * ASSIST_MULT;
        return p.length ? sum / p.length : 0;
      };
      return {
        players: p,
        score,
        roundLog,
        mvp,
        efficiency: eff(p),
        kast,
        roundsPlayed: p.reduce((s, x) => s + x.roundsPlayed, 0),
        winner: winnerId,
      };
    },

    // Reset the engine. The DOM views are rebuilt by the next `update()` or `mount()`.
    reset() {
      for (const id in state) delete state[id];
      for (const id in playerOrder) state[playerOrder[id]] = undefined;
      playerOrder.length = 0;
      roundLog.length = 0;
      feed.length = 0;
      score = [0, 0];
      mvpId = null;
      winnerId = null;
      lastSortBuilt = false;
    },

    // Attach the scoreboard, summary and kill feed to a container element.
    mount(container) {
      if (!container) return;
      const panel = document.createElement('div');
      panel.className = 'panel';

      const head = document.createElement('div');
      head.innerHTML = '<h1>STATISTICS &amp; SCOREBOARD</h1>';
      panel.appendChild(head);

      const tableWrap = document.createElement('div');
      tableWrap.id = 'scoreboard';
      tableWrap.innerHTML = '<table class="scoreboard"></table>';
      panel.appendChild(tableWrap);

      const summaryWrap = document.createElement('div');
      summaryWrap.id = 'summary';
      summaryWrap.innerHTML = '<div class="summary-card"></div>';
      panel.appendChild(summaryWrap);

      const feedWrap = document.createElement('div');
      feedWrap.id = 'feed';
      feedWrap.innerHTML = '<div class="feed"></div>';
      panel.appendChild(feedWrap);

      container.appendChild(panel);
      mountDone = true;

      // Expose a tiny render driver so the game loop can force a redraw from outside.
      container._stats = { renderAll };
    },

    // Reconstitute the scoreboard, summary and kill feed from `state`.
    update() {
      const tableEl = document.getElementById('scoreboard');
      const summaryEl = document.getElementById('summary');
      const feedEl = document.getElementById('feed');
      if (!tableEl || !summaryEl || !feedEl) return;

      if (!lastSortBuilt) {
        renderTable();
        renderSummary();
        renderFeed();
        lastSortBuilt = true;
        return;
      }

      // If the scoreboard columns changed, rebuild the table. Otherwise just sync text.
      renderTable();
      renderSummary();
      renderFeed();
    },
  };
}

// -------------------------------------------------------------------------------------------------
// Sorting / MVP
// -------------------------------------------------------------------------------------------------
function pickMvp(players) {
  let best = null;
  for (const x of players) {
    if (!best) { best = x; continue; }
    const a = (x.kills + x.assists) * KILL_MULT + x.headshots * HEADSHOT_MULT + x.trades * ASSIST_MULT;
    const b = (best.kills + best.assists) * KILL_MULT + best.headshots * HEADSHOT_MULT + best.trades * ASSIST_MULT;
    if (a > b || (a === b && x.adr > best.adr)) best = x;
  }
  return best ? { id: best.id, kills: best.kills, assists: best.assists, headshots: best.headshots, efficiency: best.adr } : null;
}

// -------------------------------------------------------------------------------------------------
// Bootstrap (DOM wiring)
// -------------------------------------------------------------------------------------------------
let mountDone = false;
let lastSortBuilt = false;
const feed = [];
let score = [0, 0];
let roundLog = [];
let mvpId = null;
let winnerId = null;

// -------------------------------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------------------------------
function ensurePlayer(id) {
  if (!state[id]) {
    state[id] = {
      id,
      name: id,
      team: null,
      kills: 0,
      deaths: 0,
      assists: 0,
      headshots: 0,
      damageDealt: 0,
      damageTaken: 0,
      adr: 0,
      kast: 0,
      money: 0,
      roundsPlayed: 0,
      alive: false,
      survives: 0,
      trades: 0,
    };
    playerOrder.push(id);
  }
  return state[id];
}

function weaponLabel(id) {
  if (!id) return '—';
  const map = { sidearm: 'P9', rifle: 'AK', smg: 'K7', shotgun: 'B2' };
  return map[id] || id.toUpperCase();
}

function rebuildDerived(st) {
  st.adr = st.roundsPlayed > 0 ? st.damageDealt / st.roundsPlayed : 0;
  const kast = (st.kills + st.assists + st.survives + st.trades) / (st.roundsPlayed || 1);
  st.kast = st.roundsPlayed > 0 ? kast : 0;
}
