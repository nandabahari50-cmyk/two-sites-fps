// The bomb: carrying, planting, ticking, defusing.
//
// The attackers carry it. Standing on a site pad with the bomb and holding E starts a plant that
// takes 3.2 seconds and is cancelled if you move. Once planted it ticks for 40 seconds, and the
// defenders must hold E on it for 5 seconds to defuse. Neither action is a key tap, which is what
// makes the site a place you have to commit to.
import * as THREE from 'three';
import { TEAM, MONEY_KILL, MONEY_CAP, emit } from './state.js';
import { PLANT_SECONDS, DEFUSE_SECONDS, BOMB_SECONDS, siteUnder } from './round.js';

export function createBomb(scene, world) {
  // The carried model and the planted model are built once: no geometry in a frame.
  const geo = new THREE.BoxGeometry(0.34, 0.18, 0.24);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22252a'), roughness: 0.6, metalness: 0.4 });
  const lightMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#ff3b2f'), emissive: new THREE.Color('#ff3b2f'), emissiveIntensity: 1.2, roughness: 0.4 });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.visible = false;
  scene.add(mesh);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), lightMat);
  led.position.set(0.12, 0.11, 0);
  mesh.add(led);

  const glow = new THREE.PointLight(new THREE.Color('#ff3b2f'), 3.2, 7, 2);
  glow.visible = false;
  scene.add(glow);

  function update(state, player, dt, keys) {
    const bomb = state.bomb;
    const isAttacker = player.side === TEAM.ATTACK;

    if (bomb.state === 'carried') {
      // Riding in the player's hands, or with the bot that carries it.
      const carried = isAttacker;
      mesh.visible = false;
      glow.visible = false;
      if (!carried) return;

      const onSite = siteUnder(world, player.state.position);
      if (!onSite) {
        state.plantProgress = 0;
        state.plHint = player.state.alive ? 'Carry the bomb to a site' : '';
        return;
      }
      if (!player.state.alive) {
        state.plantProgress = 0;
        return;
      }
      state.plHint = 'Hold E to plant';
      if (keys.has('KeyE') && player.state.speed < 0.6) {
        state.plantProgress += dt;
        if (state.plantProgress >= PLANT_SECONDS) {
          bomb.state = 'planted';
          bomb.timer = BOMB_SECONDS;
          bomb.site = onSite.id;
          bomb.position = onSite.center.clone();
          state.plantProgress = 0;
          emit(state, 'plant', `Bomb planted at ${onSite.id}`);
          mesh.position.set(onSite.center.x, 0.18, onSite.center.z);
          mesh.visible = true;
          glow.position.copy(mesh.position).y += 0.3;
          glow.visible = true;
        }
      } else if (state.plantProgress > 0) {
        state.plantProgress = Math.max(0, state.plantProgress - dt * 2);
      }
      return;
    }

    if (bomb.state === 'planted') {
      mesh.visible = true;
      glow.visible = true;
      // The LED blinks faster as the timer runs down: readable across the site.
      const urgency = 1 - Math.max(0, bomb.timer / BOMB_SECONDS);
      const blink = Math.sin(state.time * (6 + urgency * 26)) > 0 ? 1 : 0.15;
      lightMat.emissiveIntensity = 0.4 + blink * (1.1 + urgency * 1.9);
      glow.intensity = 1.4 + blink * (2.4 + urgency * 3);

      state.plHint = '';
      if (!isAttacker && player.state.alive) {
        const d = Math.hypot(player.state.position.x - bomb.position.x, player.state.position.z - bomb.position.z);
        if (d < 2.0) {
          state.plHint = 'Hold E to defuse';
          if (keys.has('KeyE') && player.state.speed < 0.6) {
            state.defuseProgress += dt;
            if (state.defuseProgress >= DEFUSE_SECONDS) {
              bomb.state = 'defused';
              bomb.defused = 1;
              state.defuseProgress = 0;
              emit(state, 'defuse', 'Bomb defused');
              mesh.visible = false;
              glow.visible = false;
              return;
            }
          } else if (state.defuseProgress > 0) {
            state.defuseProgress = Math.max(0, state.defuseProgress - dt * 2);
          }
        } else {
          state.defuseProgress = 0;
        }
      }
      return;
    }

    mesh.visible = false;
    glow.visible = false;
  }

  return { update, mesh, glow };
}
