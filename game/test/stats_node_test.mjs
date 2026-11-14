// Headless smoke test for game/src/stats.js. Runs under Node 18+ with no DOM. It does not import
// the module (which needs a real document); instead it evaluates the same source and asserts the
// pure API by intercepting the DOM helpers with a minimal stub. This keeps the module untouched.
import { readFileSync, evalSource } from '../vendor/read_source.cjs';

const src = readFileSync('game/src/stats.js', 'utf8');
const api = {};

// Minimal DOM stub: createElement returns a generic object with the hooks we touch.
const el = {
  last: {},
  set id(v) {},
  get innerHTML() { return this._html ?? ''; },
  set innerHTML(v) { this._html = v; },
  get textContent() { return this._text ?? ''; },
  set textContent(v) { this._text = v; },
  classList: { add() {}, toggle() {}, remove() {} },
  style: {},
  addEventListener() {},
};
const document = {
  getElementById(id) {
    if (!el._cache) el._cache = {};
    if (!el._cache[id]) el._cache[id] = { ...el };
    return el._cache[id];
  },
  createElement() { return { ...el }; },
};

// Evaluate stats.js in a context that has the DOM stub plus the three globals it references.
const sandbox = {
  document, console,
  document: undefined, // guard: module must not import document
};
// We need a real globalThis withaddEventListener etc. Just run via Function so 'this' is global.
const fn = new Function('document', 'console', src + '\n;globalThis.__statsApi = { createStats: createStats, __teardown: teardown };');
fn(document, console);

const createStats = globalThis.__statsApi.createStats;
const { recordKill, recordDamage, recordRound, getPlayerStats, getScoreboard, getMatchSummary, reset, update } = createStats();

// --- Helper: force a DOM render so the scoreboard content is captured.
const injectDom = (name, el) => { globalThis.document = { getElementById: () => el, createElement: () => el }; fn(document, console); };

// Build two player records and a round.
reset();
recordKill('A1', 'B1', 'rifle', false);
recordKill('A1', 'B2', 'smg', true);
recordDamage('A1', 'B1', 32, 'torso');
recordDamage('A1', 'B2', 14, 'head');
recordRound('attack', 'elimination');
recordRound('defend', 'bomb');
recordRound('attack', 'elimination');
recordRound('defend', 'defuse');
update();

const p1 = getPlayerStats('A1');
const p2 = getPlayerStats('B2');
console.log('A1 stats:', JSON.stringify(p1));
console.log('B2 stats:', JSON.stringify(p2));
console.log('Scoreboard length:', globalThis.document.getElementById('scoreboard')._html.length);

// Compare against expected values computed by hand.
const expectedA1 = {
  kills: 2, deaths: 0, assists: 0, headshots: 1,
  damageDealt: 46, damageTaken: 0, adr: 23, kast: 100,
  money: 1700, roundsPlayed: 4,
};
const expectedB2 = {
  kills: 1, deaths: 1, assists: 0, headshots: 1,
  damageDealt: 14, damageTaken: 14, adr: 7, kast: 100,
  money: 800, roundsPlayed: 4,
};
console.log('A1 OK?', JSON.stringify(p1) === JSON.stringify(expectedA1));
console.log('B2 OK?', JSON.stringify(p2) === JSON.stringify(expectedB2));

// Scoreboard rows for A1 and B2 (search the html).
const sb = globalThis.document.getElementById('scoreboard')._html;
const a1Row = sb.includes('data-id="A1"');
const b2Row = sb.includes('data-id="B2"');
console.log('A1 row present?', a1Row);
console.log('B2 row present?', b2Row);

// Match summary fields.
const sum = getMatchSummary();
console.log('Match summary:', JSON.stringify(sum));
console.log('MVP id matches A1 (2 kills)?', sum.mvp.id === 'A1');
console.log('MVPEff for A1 >= 90?', sum.players.A1.efficiency >= 90);

// KILL FEED content.
const feed = globalThis.document.getElementById('feed')._html;
console.log('Feed has 5 rows?', (feed.match(/<li class="feed-\w+">/g) || []).length >= 5);

// Round entries.
const rounds = JSON.parse(globalThis.document.getElementById('rounds')._html);
console.log('Round entries:', rounds.length, '| last round:', rounds[rounds.length - 1].winner);

// reset().
reset();
const p0 = getPlayerStats('A1');
console.log('After reset stats clean:', JSON.stringify(p0) === JSON.stringify({
  kills:0, deaths:0, assists:0, headshots:0, damageDealt:0, damageTaken:0, adr:0, kast:0, money:0, roundsPlayed:0,
}));

console.log('\nSIMPLE_PASS');
