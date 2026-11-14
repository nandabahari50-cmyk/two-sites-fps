// Damage feedback for a Three.js FPS: a hit marker, floating damage numbers and a scrolling kill feed.
//
// This module owns every DOM write in the feedback layer and every pooled DOM element. Nothing is
// built while a frame is live: text nodes, pool slots and timers are all reused round-robin so a
// firefight cannot allocate, and `mount()` (called once by main.js) is the only place the document is
// touched. Rendering is projected 3D -> screen space, so the same elements float with the world no
// matter what the camera does.
//
// Public API (createDamageSystem(THREE)):
//   hitMarker(headshot)         -> flashes the centre X: white body, red headshot, 200 ms
//   damageNumber(pos, amount, crit) => void
//                                 -> floating number near a 3D hit point (yellow normal, orange crit)
//   killFeed(killer, victim, weapon) => void
//                                 -> top-right scroll list 'killer > victim (weapon)', 5 s hold
//   update(dt)                  => void - advance timers, fade elements, drain the pool
//   clear()                     => void - reset all state (round reload / restart)
//   mount(container)            => void - create the DOM skeleton and the element pool

import * as THREE from 'three';

// --- Constants ---------------------------------------------------------------

const FIXED_DT = 1 / 60;
const MARKER_MS = 200; // hit marker lives on screen for 200 ms
const MARKER_BODY = 0.14; // marker's screen-space half-size for a body hit
const MARKER_HEAD = 0.26; // headshot marker is bigger
const NUMBER_LIFE = 1.0; // damage numbers live 1 s
const NUMBER_BODY = 0.0; // vertical offset for normal hits
const NUMBER_KILL = 0.62; // numbers for kills sit up out of the way of the gun
const FEED_MS = 5000; // kill feed entries fade after 5 s

const COL_BODY = 0xffffff; // white flashes for every body hit
const COL_HEAD = 0xff2222; // red for headshots
const COL_NUMBER = 0xffe08a; // yellow floating numbers
const COL_CRIT = 0xff9a2a; // orange crit numbers
const COL_KILL = 0xff5a3a; // red kill numbers

const MARKER_DIV = 'damage-marker';
const NUMBER_DIV = 'damage-number';
const FEED_DIV = 'damage-feed';

// --- Pool layout -------------------------------------------------------------

// A damage number is a DOM element plus a reusable screen position. Both are
// preallocated so `damageNumber` never constructs anything per frame.
const NUMBER_CAP = 220;
const MARKER_CAP = 2;
const FEED_ROW_CAP = 8;

// Scratch used only for projection; reused every `update()` call, never allocated.
const tmpVec = new THREE.Vector3();
const tmpScreen = new THREE.Vector2();

const css = `
  .damage-wrapper {
    position: fixed;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 30;
    user-select: none;
  }

  .damage-marker {
    position: fixed;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    pointer-events: none;
    transform: translate(-50%, -50%);
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 9px solid transparent;
    border-bottom: 9px solid transparent;
    opacity: 0;
    transition: opacity 200 ms linear;
  }

  .damage-body .damage-marker {
    border-top-color: #ffffff;
  }

  .damage-head .damage-marker {
    border-top-color: #ff2222;
    border-bottom-color: #ff2222;
  }

  .damage-number {
    position: fixed;
    pointer-events: none;
    opacity: 0;
    text-shadow: 0 0 6px rgba(0, 0, 0, 0.75);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .damage-number.yellow .amount {
    color: #ffe08a;
  }

  .damage-number.orange .amount {
    color: #ff9a2a;
  }

  .damage-number.red .amount {
    color: #ff5a3a;
  }

  .damage-feed {
    position: fixed;
    top: 14px;
    right: 18px;
    width: 210px;
    max-width: calc(100vw - 36px);
    max-height: 200px;
    overflow-y: auto;
    background: rgba(14, 18, 23, 0.86);
    border: 1px solid rgba(140, 150, 165, 0.28);
    border-radius: 7px;
    padding: 9px 11px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.4;
    color: #c6cfd8;
    pointer-events: none;
    z-index: 30;
  }

  .damage-feed::-webkit-scrollbar { width: 8px; }
  .damage-feed::-webkit-scrollbar-thumb { background: rgba(140, 150, 165, 0.35); border-radius: 4px; }

  .damage-feed-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    padding-bottom: 5px;
    border-bottom: 1px solid rgba(140, 150, 165, 0.22);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #93a0ad;
  }

  .damage-feed-row {
    display: flex;
    gap: 8px;
    padding: 3px 6px;
    border-radius: 3px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .damage-feed-row .kicker {
    flex: 0 0 auto;
    color: #93a3b3;
    font-size: 10px;
    letter-spacing: 0.1em;
  }

  .damage-feed-row .name {
    font-weight: 700;
    color: #eceff2;
  }

  .damage-feed-row .arrow {
    flex: 0 0 auto;
    color: #d8a37a;
    font-weight: 700;
  }

  .damage-feed-row .meta {
    color: #a9b4c0;
    font-size: 10px;
  }

  .damage-feed-row .victim {
    color: #f0c8c0;
    font-weight: 600;
  }

  .damage-feed-empty {
    color: #5d6672;
    font-style: italic;
    font-size: 11px;
    padding: 6px 0;
  }
`;

// --- Private state ---------------------------------------------------------

// Marker pool: two elements, toggled round-robin. `active` remembers which one
// should flash next update.
let markerPool = [];
let markerActive = 0;
let markerHead = 0;
let markerTimer = 0;

// Damage number pool: elements plus their screen-space positions.
let numberPool = [];
let numberAlive = 0;
let numberHead = 0;
let numberTimer = 0;

// Feed pool: fixed ring of rows, rounded via `age`.
let feedPool = [];
let feedAlive = 0;
let feedHead = 0;
let feedTimer = 0;
let feedShowTimer = 0;

// Helper elements appended into the feed shell.
const kicker = document.createElement('span');
kicker.className = 'kicker';
kicker.textContent = 'KILL';
const name = document.createElement('span');
const meta = document.createElement('span');
const victim = document.createElement('span');
const arrow = document.createElement('span');
arrow.className = 'arrow';
arrow.textContent = '>';

// --- Public factory --------------------------------------------------------

export function createDamageSystem(THREE) {
  const { Vector3, Color, MeshBasicMaterial, RawShaderMaterial, PlaneGeometry, BufferGeometry, BufferAttribute, Mesh, AdditiveBlending, NoToneMapping } = THREE;

  // Root node for the whole feedback layer; mount() appends this to the page.
  const wrapper = document.createElement('div');
  wrapper.className = 'damage-wrapper';

  // --- Hit marker -----------------------------------------------------------
  // Marker elements are preallocated and appended to the wrapper once.
  for (let i = 0; i < MARKER_CAP; i += 1) {
    const el = document.createElement('div');
    el.className = 'damage-marker';
    el.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(el);
    markerPool.push(el);
  }

  // --- Damage numbers -----------------------------------------------------
  // A pool slot owns a DOM element and a {x, y} screen position. `head` is the
  // next write slot; `alive` is the count of visible/drawn elements.
  for (let i = 0; i < NUMBER_CAP; i += 1) {
    const el = document.createElement('div');
    el.className = 'damage-number';
    el.innerHTML = '<span class="amount"></span>';
    wrapper.appendChild(el);
    numberPool.push({ el, pos: { x: 0, y: 0 } });
  }

  // --- Kill feed ----------------------------------------------------------
  // A fixed ring of feed rows. Each row is a single prebuilt element whose
  // contents are overwritten on every `killFeed()` call, so the DOM never grows.
  const feedNode = document.createElement('div');
  feedNode.className = 'damage-feed';
  feedNode.id = 'damage-feed';
  wrapper.appendChild(feedNode);

  const head = document.createElement('div');
  head.className = 'damage-feed-head';
  const empty = document.createElement('div');
  empty.className = 'damage-feed-empty';
  empty.textContent = 'Waiting for targets';

  feedNode.appendChild(head);
  feedNode.appendChild(empty);

  for (let i = 0; i < FEED_ROW_CAP; i += 1) {
    const row = document.createElement('div');
    row.className = 'damage-feed-row';
    row.innerHTML = `
      <span class="kicker"></span>
      <span class="name"></span>
      <span class="arrow"></span>
      <span class="meta"></span>
      <span class="victim"></span>
    `;
    wrapper.appendChild(row);
    feedPool.push(row);
  }

  // --- Projection helper --------------------------------------------------

  /**
   * Project a 3D point to pixel coordinates relative to the page top-left.
   * Reuses `tmpVec` / `tmpScreen` so the fixed step never allocates.
   */
  function projectToScreen(camera, point, output) {
    tmpVec.set(point.x, point.y, point.z);
    tmpVec.project(camera);
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    output.x = (tmpVec.x * 0.5 + 0.5) * winW;
    output.y = (1 - (tmpVec.y * 0.5 + 0.5)) * winH;
    return output;
  }

  // --- Public API ---------------------------------------------------------

  /** Flashes the centre X. Body = white, headshot = red, 200 ms. */
  function hitMarker(headshot) {
    const slot = markerHead % MARKER_CAP;
    const el = markerPool[slot];
    el.className = 'damage-marker' + (headshot ? ' damage-head' : ' damage-body');
    el.style.opacity = '1';
    markerTimer = MARKER_MS / 1000;
    markerActive = slot;
    markerHead += 1;
  }

  /** Spawns a floating number at a 3D point, projected to screen space. */
  function damageNumber(pos, amount, crit = false) {
    const slot = numberHead % NUMBER_CAP;
    const item = numberPool[slot];
    const el = item.el;
    el.classList.remove('yellow', 'orange', 'red');
    el.classList.add(crit ? 'orange' : 'yellow');
    el.querySelector('.amount').textContent = amount > 0 ? amount : '';
    el.style.opacity = '1';
    projectToScreen(camera, pos, item.pos);
    item.pos.y -= crit ? NUMBER_KILL : NUMBER_BODY;
    numberTimer = NUMBER_LIFE;
    numberAlive += 1;
    numberHead += 1;
  }

  /** Appends a kill-line to the top-right feed, rounded at 5 s. */
  function killFeed(killer, victim_, weapon) {
    const slot = feedHead % FEED_ROW_CAP;
    const row = feedPool[slot];
    row.classList.add('damage-feed-row');
    row.querySelector('.kicker').textContent = 'KILL';
    row.querySelector('.name').textContent = killer;
    row.querySelector('.arrow').textContent = ' > ';
    row.querySelector('.meta').textContent = weapon || '';
    row.querySelector('.victim').textContent = victim_;
    row.style.opacity = '1';
    row._age = 0;
    feedAlive += 1;
    feedHead += 1;
  }

  // --- Tick loop ----------------------------------------------------------

  /** Advances every floating timer and fades elements out. */
  function update(dt) {
    // Marker.
    if (markerTimer > 0) {
      markerTimer -= dt;
      if (markerTimer <= 0) {
        markerPool[markerActive].style.opacity = '0';
      }
    }

    // Damage numbers: fade by age, remove when dead.
    if (numberTimer > 0) {
      numberTimer -= dt;
      const k = Math.max(0, numberTimer / NUMBER_LIFE);
      if (numberTimer > 0) {
        for (let i = 0; i < numberAlive; i += 1) {
          const el = numberPool[i % NUMBER_CAP].el;
          el.style.opacity = String(Math.max(0, k));
        }
      }
      if (numberTimer <= 0) {
        numberAlive = 0;
      }
    }

    // Kill feed: age each row and fade after FEED_MS.
    if (feedTimer > 0) {
      feedTimer -= dt;
      if (feedTimer <= 0) {
        for (let i = 0; i < feedAlive; i += 1) {
          feedPool[i % FEED_ROW_CAP].style.opacity = '0';
        }
      }
    }
    if (feedShowTimer > 0) {
      feedShowTimer -= dt;
      if (feedShowTimer <= 0) {
        for (let i = 0; i < feedAlive; i += 1) {
          feedPool[i % FEED_ROW_CAP].style.opacity = '0';
        }
      }
    }

    // Age and prune dead rows.
    if (feedAlive > 0) {
      let changed = false;
      for (let i = 0; i < feedAlive; i += 1) {
        const row = feedPool[i % FEED_ROW_CAP];
        row._age += dt;
        if (row._age >= FEED_MS / 1000) {
          row.style.opacity = '0';
          changed = true;
        }
      }
      if (changed) {
        // If all rows have expired, clear the shell back to the empty placeholder.
        let allDead = true;
        for (let i = 0; i < feedAlive; i += 1) {
          if (feedPool[i % FEED_ROW_CAP].style.opacity !== '0') {
            allDead = false;
            break;
          }
        }
        if (allDead) {
          feedAlive = 0;
          empty.textContent = 'Waiting for targets';
        }
      }
    }
  }

  // --- Cleanup ------------------------------------------------------------

  /** Resets all feedback systems so the next round starts clean. */
  function clear() {
    markerTimer = 0;
    for (let i = 0; i < MARKER_CAP; i += 1) {
      markerPool[i].style.opacity = '0';
    }
    markerActive = 0;
    markerHead = 0;

    numberTimer = 0;
    numberAlive = 0;
    numberHead = 0;
    for (let i = 0; i < NUMBER_CAP; i += 1) {
      numberPool[i].el.style.opacity = '0';
    }

    feedTimer = 0;
    feedShowTimer = 0;
    feedAlive = 0;
    feedHead = 0;
    feedShowTimer = 0;
    empty.textContent = 'Waiting for targets';
    for (let i = 0; i < FEED_ROW_CAP; i += 1) {
      feedPool[i].style.opacity = '0';
    }
  }

  // --- Mount ----------------------------------------------------------------

  /** Build the DOM once. Called before the first frame. */
  function mount(container) {
    wrapper.id = 'damage-feedback';
    if (container) container.appendChild(wrapper);
    // Marker sits above everything else.
    wrapper.appendChild(markerPool[0]);
    wrapper.appendChild(markerPool[1]);
  }

  return {
    hitMarker,
    damageNumber,
    killFeed,
    update,
    clear,
    mount,
  };
}
