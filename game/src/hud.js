// The HUD: health, armour, ammunition, the round clock, the score, the kill feed, the buy menu, the
// round banner and the start screen.
//
// One module owns every DOM write, and each write is diffed against the previous value so the fixed
// step can call update() every frame without touching the document unless something changed. The HUD
// never reads the simulation; main.js pushes a flat view object in.
const el = (id) => document.getElementById(id);

const COPY = {
  start: {
    title: 'Two Sites',
    copy: 'Round-based tactical shooter. Attackers carry a bomb to A or B. Defenders hold. Click to play.',
  },
  paused: {
    title: 'Paused',
    copy: 'Click to resume. B opens the buy menu during the freeze.',
  },
  match: {
    title: 'Match over',
    copy: '',
  },
};

export function createHud() {
  const last = {
    hp: -1, armour: -1, mag: -1, reserve: -1, money: -1, clock: '', score: '',
    round: -1, weapon: '', bomb: '', hint: '', banner: '', buy: '', spread: -1,
  };

  let bannerTimer = 0;
  const feed = [];
  let feedNode = null;
  let overlayHidden = false;
  let playHandler = null;

  /** Build the DOM once. After this, only values are written. */
  function mount() {
    const root = el('hud');
    if (!root) return;
    root.innerHTML = `
      <div class="hud-top">
        <div class="hud-score" id="hud-score">0 — 0</div>
        <div class="hud-clock"><span id="hud-clock">1:45</span><small id="hud-round">ROUND 1</small></div>
        <div class="hud-bomb" id="hud-bomb"></div>
      </div>
      <div class="hud-banner" id="hud-banner"></div>
      <div class="hud-feed" id="hud-feed"></div>
      <div class="hud-bottom">
        <div class="hud-vitals">
          <div class="vital"><b id="hud-hp">100</b><span>HP</span></div>
          <div class="vital"><b id="hud-armour">0</b><span>ARM</span></div>
        </div>
        <div class="hud-money" id="hud-money">$800</div>
        <div class="hud-ammo"><b id="hud-mag">12</b><i>/</i><span id="hud-reserve">48</span><small id="hud-weapon">P9</small></div>
      </div>
      <div class="hud-crosshair" id="hud-crosshair"></div>
      <div class="hud-hint" id="hud-hint"></div>
      <div class="hud-buy" id="hud-buy"></div>
      <div class="hud-damage" id="hud-damage"></div>
    `;
    feedNode = el('hud-feed');
    for (const key of Object.keys(last)) {
      last[key] = typeof last[key] === 'number' ? -1 : '';
    }
  }

  function setText(id, value) {
    const node = el(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setClass(id, cls, on) {
    const node = el(id);
    if (node) node.classList.toggle(cls, on);
  }

  /** One frame's update from a flat view object built in main.js. */
  function update(view) {
    if (view.hp !== last.hp) {
      setText('hud-hp', String(Math.max(0, Math.round(view.hp))));
      setClass('hud-hp', 'low', view.hp <= 30);
      last.hp = view.hp;
    }
    if (view.armour !== last.armour) {
      setText('hud-armour', String(Math.round(view.armour)));
      last.armour = view.armour;
    }
    if (view.mag !== last.mag) {
      setText('hud-mag', String(view.mag));
      setClass('hud-mag', 'low', view.mag <= 3);
      last.mag = view.mag;
    }
    if (view.reserve !== last.reserve) {
      setText('hud-reserve', String(view.reserve));
      last.reserve = view.reserve;
    }
    if (view.money !== last.money) {
      setText('hud-money', `$${Math.round(view.money)}`);
      last.money = view.money;
    }
    if (view.clock !== last.clock) {
      setText('hud-clock', view.clock);
      setClass('hud-clock', 'urgent', view.clock.startsWith('0:0'));
      last.clock = view.clock;
    }
    if (view.score !== last.score) {
      setText('hud-score', view.score);
      last.score = view.score;
    }
    if (view.round !== last.round) {
      setText('hud-round', `ROUND ${view.round}`);
      last.round = view.round;
    }
    if (view.weapon !== last.weapon) {
      setText('hud-weapon', view.weapon);
      last.weapon = view.weapon;
    }
    if (view.bomb !== last.bomb) {
      setText('hud-bomb', view.bomb);
      setClass('hud-bomb', 'live', view.bomb !== '');
      last.bomb = view.bomb;
    }
    if (view.hint !== last.hint) {
      setText('hud-hint', view.hint);
      last.hint = view.hint;
    }
    if (view.spread !== last.spread) {
      const crosshair = el('hud-crosshair');
      if (crosshair) crosshair.style.setProperty('--gap', `${(4 + view.spread * 820).toFixed(1)}px`);
      last.spread = view.spread;
    }
    const dmg = el('hud-damage');
    if (dmg) dmg.style.opacity = String(Math.max(0, Math.min(1, view.damageFlash)));
  }

  function banner(text, seconds = 2.2) {
    const node = el('hud-banner');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    bannerTimer = seconds;
  }

  function tick(dt) {
    if (hitTimer > 0) {
      hitTimer -= dt;
      if (hitTimer <= 0) {
        const node = el('hud-crosshair');
        if (node) node.classList.remove('hit', 'hit-kill');
      }
    }
    if (bannerTimer <= 0) return;
    bannerTimer -= dt;
    if (bannerTimer <= 0) {
      const node = el('hud-banner');
      if (node) node.classList.remove('show');
    }
  }

  function kill(who, whom, head) {
    feed.push({ text: `<b>${who}</b> ${head ? '&#9678;' : '&#8226;'} ${whom}`, age: 0 });
    if (feed.length > 5) feed.shift();
    paintFeed();
  }

  function paintFeed() {
    if (!feedNode) return;
    feedNode.innerHTML = feed.map((f) => `<div class="feed-row">${f.text}</div>`).join('');
  }

  function ageFeed(dt) {
    if (feed.length === 0) return;
    let changed = false;
    for (let i = feed.length - 1; i >= 0; i -= 1) {
      feed[i].age += dt;
      if (feed[i].age > 5) {
        feed.splice(i, 1);
        changed = true;
      }
    }
    if (changed) paintFeed();
  }

  /** The little cross that says a shot connected. Held by the caller's timer, not the HUD. */
  let hitTimer = 0;
  function hitMarker(killed) {
    const node = el('hud-crosshair');
    if (!node) return;
    node.classList.add(killed ? 'hit-kill' : 'hit');
    hitTimer = killed ? 0.28 : 0.12;
  }

  function setBuy(html) {
    if (html === last.buy) return;
    const node = el('hud-buy');
    if (node) {
      node.innerHTML = html;
      node.classList.toggle('show', html !== '');
    }
    last.buy = html;
  }

  function setOverlay(mode, detail) {
    const overlay = el('overlay');
    if (!overlay) return;
    const text = COPY[mode] ?? COPY.paused;
    const title = el('overlay-title');
    const copy = el('overlay-copy');
    const play = el('play');
    if (title) title.textContent = text.title;
    if (copy) copy.textContent = detail ? `${text.copy} ${detail}` : text.copy;
    if (play) play.textContent = mode === 'start' ? 'Click to play' : 'Click to resume';
    overlay.hidden = false;
    overlayHidden = false;
  }

  function hideOverlay() {
    const overlay = el('overlay');
    if (overlay) overlay.hidden = true;
    overlayHidden = true;
  }

  function onPlay(handler) {
    playHandler = handler;
    const play = el('play');
    if (play) play.addEventListener('click', handler);
    const overlay = el('overlay');
    if (overlay) overlay.addEventListener('click', () => {
      if (playHandler) playHandler();
    });
  }

  function clear() {
    feed.length = 0;
    paintFeed();
  }

  return { mount, update, banner, tick, kill, ageFeed, setBuy, setOverlay, hideOverlay, onPlay, clear, hitMarker };
}
