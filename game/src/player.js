// The player: movement with acceleration, crouch, collision against the map, and the camera.
//
// Movement is not instant. A strafe accelerates, stopping decelerates, and crouching drops the eye
// and slows the walk: which is the point, because accuracy is tied to speed. A player who crouches
// and stops is a player who hits, and the weapon module reads this state's speed to decide the cone.
import * as THREE from 'three';
import { canStand } from './bots.js';

const RADIUS = 0.38;
const STAND_EYE = 1.62;
const CROUCH_EYE = 1.06;
const MAX_RUN = 5.4;
const MAX_CROUCH = 2.1;
const GROUND_ACCEL = 62;
const AIR_ACCEL = 14;
const FRICTION = 9.5;
const GRAVITY = 16.5;
const JUMP_SPEED = 5.1;

export function createPlayer(world) {
  const state = {
    position: new THREE.Vector3(0, 0, 28),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    onGround: true,
    crouching: false,
    crouchAmount: 0,
    eye: STAND_EYE,
    hp: 100,
    alive: true,
    speed: 0,
    bob: 0,
    walkPhase: 0,
  };

  const wish = new THREE.Vector3();
  const aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  function spawnAt(point) {
    state.position.set(point.x, 0, point.z);
    state.velocity.set(0, 0, 0);
    state.onGround = true;
    state.hp = 100;
    state.alive = true;
    state.pitch = 0;
    state.bob = 0;
    state.speed = 0;
    state.crouching = false;
    state.crouchAmount = 0;
    state.eye = STAND_EYE;
  }

  /** Mouse look: yaw unbounded, pitch clamped just short of straight up and down. */
  function look(dx, dy, sensitivity = 0.0021) {
    state.yaw -= dx * sensitivity;
    state.pitch = Math.max(-1.54, Math.min(1.54, state.pitch - dy * sensitivity));
    if (state.yaw > Math.PI) state.yaw -= Math.PI * 2;
    if (state.yaw < -Math.PI) state.yaw += Math.PI * 2;
  }

  /** One fixed step. `frozen` is a round freeze: feet planted, camera live. */
  function step(dt, keys, wantJump, frozen) {
    if (!state.alive) {
      state.speed = 0;
      return;
    }
    if (frozen) {
      state.velocity.set(0, 0, 0);
      state.speed = 0;
      return;
    }

    const crouchHeld = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    state.crouching = crouchHeld && state.onGround;
    const crouchTarget = state.crouching ? 1 : 0;
    state.crouchAmount += (crouchTarget - state.crouchAmount) * Math.min(1, dt * 12);
    state.eye = STAND_EYE + (CROUCH_EYE - STAND_EYE) * state.crouchAmount;

    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wish.set(0, 0, 0);
    if (forward !== 0 || strafe !== 0) {
      const sin = Math.sin(state.yaw);
      const cos = Math.cos(state.yaw);
      wish.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe).normalize();
    }

    const maxSpeed = state.crouching ? MAX_CROUCH : MAX_RUN;
    const accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;

    // Friction before acceleration, so letting go of W slows you down instead of stopping dead.
    if (state.onGround && wish.lengthSq() < 0.01) {
      const speed = Math.hypot(state.velocity.x, state.velocity.z);
      if (speed > 0.01) {
        const drop = Math.max(0, speed - FRICTION * dt);
        const scale = drop / speed;
        state.velocity.x *= scale;
        state.velocity.z *= scale;
      } else {
        state.velocity.x = 0;
        state.velocity.z = 0;
      }
    }

    if (wish.lengthSq() > 0.01) {
      // Quake-style acceleration: adding speed only up to the cap is what makes counter-strafing
      // stop you in one step, which is the technique that makes aiming while stopping possible.
      const along = state.velocity.x * wish.x + state.velocity.z * wish.z;
      const room = maxSpeed - along;
      if (room > 0) {
        const add = Math.min(accel * dt, room);
        state.velocity.x += wish.x * add;
        state.velocity.z += wish.z * add;
      }
    }

    if (wantJump && state.onGround) {
      state.velocity.y = JUMP_SPEED;
      state.onGround = false;
    }
    state.velocity.y = Math.max(-30, state.velocity.y - GRAVITY * dt);

    // Axis by axis so a wall slides instead of swallowing the movement.
    const nextX = state.position.x + state.velocity.x * dt;
    if (canStand(world.colliders, nextX, state.position.z, RADIUS)) state.position.x = nextX;
    else state.velocity.x = 0;

    const nextZ = state.position.z + state.velocity.z * dt;
    if (canStand(world.colliders, state.position.x, nextZ, RADIUS)) state.position.z = nextZ;
    else state.velocity.z = 0;

    state.position.y += state.velocity.y * dt;
    if (state.position.y <= 0) {
      state.position.y = 0;
      state.velocity.y = 0;
      state.onGround = true;
    }

    state.position.x = Math.max(-world.halfW + 1, Math.min(world.halfW - 1, state.position.x));
    state.position.z = Math.max(-world.halfL + 1, Math.min(world.halfL - 1, state.position.z));

    state.speed = Math.hypot(state.velocity.x, state.velocity.z);
    state.bob += state.speed * dt * 2.1;
    state.walkPhase += state.speed * dt * 5.2;
  }

  /** Put the camera where the player's eyes are. */
  function applyCamera(camera) {
    const bobY = Math.sin(state.walkPhase) * 0.02 * Math.min(1, state.speed / MAX_RUN);
    camera.position.set(state.position.x, state.position.y + state.eye + bobY, state.position.z);
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  }

  /** The direction the player is aiming. */
  function aimDirection(out) {
    aimEuler.set(state.pitch, state.yaw, 0, 'YXZ');
    return out.set(0, 0, -1).applyEuler(aimEuler);
  }

  /** Recoil: kick the view so a long spray has to be fought back down. */
  function recoil(up, side) {
    state.pitch = Math.min(1.54, state.pitch + up);
    state.yaw += side;
  }

  function damage(amount) {
    if (!state.alive) return false;
    state.hp = Math.max(0, state.hp - amount);
    if (state.hp === 0) {
      state.alive = false;
      return true;
    }
    return false;
  }

  return { state, spawnAt, look, step, applyCamera, aimDirection, recoil, damage, radius: RADIUS };
}

export { RADIUS as PLAYER_RADIUS, STAND_EYE, CROUCH_EYE };
