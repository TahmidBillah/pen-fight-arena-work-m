import RAPIER from '@dimforge/rapier3d-compat';
import {
  BOT_SPAWN,
  DeshiColorVariantId,
  FALL_Y_THRESHOLD,
  FLOOR_Y,
  GRAVITY_Y,
  MAX_SHOT_SECONDS,
  OOB_CONFIRM_SECONDS,
  OOB_MARGIN,
  OOB_Y_THRESHOLD,
  PEN_SPECS,
  PenPhysicsSpec,
  PenTypeId,
  PHYSICS_BALANCE,
  PHYSICS_FIXED_DT,
  PLAYER_SPAWN,
  powerRatioToLaunchSpeed,
  SETTLE_ANG_SPEED,
  SETTLE_HOLD_SECONDS,
  SETTLE_LIN_SPEED,
  TABLE_FRICTION,
  TABLE_HALF_D,
  TABLE_HALF_W,
  TABLE_RESTITUTION,
  TABLE_THICKNESS,
} from '../utils/Constants';
import {
  CanonicalPose,
  CanonicalQuat,
  CanonicalVec3,
  CompactPoseTuple,
  MatchResultType,
  OnlinePenPairState,
  OnlinePenState,
  ShotCollisionEvent,
  ShotKeyframe,
} from './OnlineTypes';

let sharedRapierInitPromise: Promise<void> | null = null;

export function ensureSharedRapierInitialized(): Promise<void> {
  if (!sharedRapierInitPromise) {
    sharedRapierInitPromise = RAPIER.init();
  }
  return sharedRapierInitPromise;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function roundNum(v: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

function quatFromAxisAngle(ax: number, ay: number, az: number, angleRad: number): CanonicalQuat {
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) };
}

function rotateVecByQuat(v: CanonicalVec3, q: CanonicalQuat): CanonicalVec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;

  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function penRestY(spec: PenPhysicsSpec): number {
  return (
    Math.max(
      spec.radius,
      spec.radius * spec.cap.radiusScale,
      spec.frontCap ? spec.radius * spec.frontCap.radiusScale : 0
    ) + 0.005
  );
}

function makePoseTuple(body: RAPIER.RigidBody): CompactPoseTuple {
  const t = body.translation();
  const r = body.rotation();
  return [
    roundNum(t.x),
    roundNum(t.y),
    roundNum(t.z),
    roundNum(r.x, 5),
    roundNum(r.y, 5),
    roundNum(r.z, 5),
    roundNum(r.w, 5),
  ];
}

function readCanonicalPose(body: RAPIER.RigidBody): CanonicalPose {
  const t = body.translation();
  const r = body.rotation();
  const lv = body.linvel();
  const av = body.angvel();
  return {
    pos: { x: roundNum(t.x), y: roundNum(t.y), z: roundNum(t.z) },
    rot: { x: roundNum(r.x, 5), y: roundNum(r.y, 5), z: roundNum(r.z, 5), w: roundNum(r.w, 5) },
    linvel: { x: roundNum(lv.x), y: roundNum(lv.y), z: roundNum(lv.z) },
    angvel: { x: roundNum(av.x), y: roundNum(av.y), z: roundNum(av.z) },
  };
}

export function createInitialPenStates(
  player1: { uid: string; penType: PenTypeId; deshiVariant: DeshiColorVariantId },
  player2: { uid: string; penType: PenTypeId; deshiVariant: DeshiColorVariantId }
): OnlinePenPairState {
  const spec1 = PEN_SPECS[player1.penType];
  const spec2 = PEN_SPECS[player2.penType];

  const makeInitialPen = (
    cfg: { uid: string; penType: PenTypeId; deshiVariant: DeshiColorVariantId },
    slot: 1 | 2,
    spec: PenPhysicsSpec,
    spawn: { x: number; y: number; z: number; yaw: number }
  ): OnlinePenState => ({
    uid: cfg.uid,
    slot,
    team: slot === 1 ? 'blue' : 'red',
    penType: cfg.penType,
    deshiVariant: cfg.deshiVariant,
    pose: {
      pos: { x: spawn.x, y: penRestY(spec), z: spawn.z },
      rot: quatFromAxisAngle(0, 1, 0, spawn.yaw),
      linvel: { x: 0, y: 0, z: 0 },
      angvel: { x: 0, y: 0, z: 0 },
    },
    isEliminated: false,
    shotsCount: 0,
    knockoutsCount: 0,
    skipsCount: 0,
  });

  return {
    player1: makeInitialPen(player1, 1, spec1, PLAYER_SPAWN),
    player2: makeInitialPen(player2, 2, spec2, BOT_SPAWN),
  };
}

function clampLocalAnchorRaw(localAnchor: CanonicalVec3, spec: PenPhysicsSpec): CanonicalVec3 {
  const halfLength = spec.length * 0.5;
  const maxZ = Math.max(0.2, halfLength - 0.08);
  return {
    x: clamp(localAnchor.x, -spec.radius * 0.75, spec.radius * 0.75),
    y: clamp(localAnchor.y, -spec.radius * 0.28, spec.radius * 0.55),
    z: clamp(localAnchor.z, -maxZ, maxZ),
  };
}

function buildAuthoritativePenBody(
  world: RAPIER.World,
  penState: OnlinePenState,
  spec: PenPhysicsSpec
): { body: RAPIER.RigidBody; handles: Set<number> } {
  const t = spec.passive.tuning;
  const rotResponse = clamp(t.rotationalResponseScale, 0.4, 1.6);
  const linearDamping = spec.linearDamping * t.linearDampingScale;
  const angularDamping = (spec.angularDamping * t.angularDampingScale) / rotResponse;
  const capFrictionScale = 1 + t.capFrictionBonus * spec.cap.retention;
  const extraMass = Math.max(0, spec.mass * (t.impactMomentumScale - 1));

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(penState.pose.pos.x, penState.pose.pos.y, penState.pose.pos.z)
    .setRotation(penState.pose.rot)
    .setLinvel(penState.pose.linvel.x, penState.pose.linvel.y, penState.pose.linvel.z)
    .setAngvel(penState.pose.angvel)
    .setLinearDamping(linearDamping)
    .setAngularDamping(angularDamping)
    .setCcdEnabled(true)
    .setCanSleep(true);

  const body = world.createRigidBody(bodyDesc);

  const capsuleRot = quatFromAxisAngle(1, 0, 0, Math.PI * 0.5);
  const halfLen = spec.length * 0.5;
  const capsuleHalfSeg = Math.max(0.45, halfLen - 0.42);
  const tipZ = halfLen - 0.12;
  const tailZ = -(halfLen - 0.18);

  const mainColDesc = RAPIER.ColliderDesc.capsule(capsuleHalfSeg, spec.radius)
    .setRotation(capsuleRot)
    .setFriction(spec.friction)
    .setRestitution(spec.restitution)
    .setMass(spec.massSplit.body)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const tipColDesc = (
    spec.frontCap
      ? (() => {
          const frontCapRadius = spec.radius * spec.frontCap.radiusScale;
          const frontCapLen = spec.length * spec.frontCap.lengthRatio;
          const frontCapCenterZ = spec.length * spec.frontCap.centerZRatio;
          const frontCapHalfSeg = Math.max(0.02, frontCapLen * 0.5 - frontCapRadius);
          return RAPIER.ColliderDesc.capsule(frontCapHalfSeg, frontCapRadius)
            .setRotation(capsuleRot)
            .setTranslation(0, 0, frontCapCenterZ);
        })()
      : RAPIER.ColliderDesc.ball(spec.radius * 0.47).setTranslation(0, 0, tipZ)
  )
    .setFriction(spec.friction)
    .setRestitution(spec.restitution)
    .setMass(spec.massSplit.tip)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const tailColDesc = RAPIER.ColliderDesc.ball(spec.radius * 0.76)
    .setTranslation(0, 0, tailZ)
    .setFriction(spec.friction)
    .setRestitution(spec.restitution)
    .setMass(spec.massSplit.tail)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const capRadius = spec.radius * spec.cap.radiusScale;
  const capLen = spec.length * spec.cap.lengthRatio;
  const capCenterZ = spec.length * spec.cap.centerZRatio;
  const capHalfSeg = Math.max(0.02, capLen * 0.5 - capRadius);

  const capColDesc = RAPIER.ColliderDesc.capsule(capHalfSeg, capRadius)
    .setRotation(capsuleRot)
    .setTranslation(0, 0, capCenterZ)
    .setFriction(spec.friction * spec.cap.frictionScale * capFrictionScale)
    .setRestitution(spec.restitution * spec.cap.restitutionScale)
    .setMass(spec.massSplit.cap)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const c1 = world.createCollider(mainColDesc, body);
  const c2 = world.createCollider(tipColDesc, body);
  const c3 = world.createCollider(tailColDesc, body);
  const c4 = world.createCollider(capColDesc, body);

  if (extraMass > 0) {
    body.setAdditionalMass(extraMass, true);
  }

  return {
    body,
    handles: new Set([c1.handle, c2.handle, c3.handle, c4.handle]),
  };
}

function applyRollingAndStiction(body: RAPIER.RigidBody, dt: number): void {
  if (body.isSleeping()) return;
  const t = body.translation();
  if (t.y <= -0.1 || t.y >= 0.38) return;

  const av = body.angvel();
  const lv = body.linvel();
  const r = body.rotation();
  const axisZ = rotateVecByQuat({ x: 0, y: 0, z: 1 }, r);
  const rollRate = av.x * axisZ.x + av.y * axisZ.y + av.z * axisZ.z;
  const rollDamp = Math.exp(-5.2 * dt);
  const newRoll = rollRate * rollDamp;
  const diff = newRoll - rollRate;

  if (Math.abs(rollRate) > 0.01) {
    body.setAngvel(
      {
        x: av.x + axisZ.x * diff,
        y: av.y + axisZ.y * diff,
        z: av.z + axisZ.z * diff,
      },
      false
    );
  }

  const hSpeed = Math.hypot(lv.x, lv.z);
  if (hSpeed > 0.001 && hSpeed < 0.35) {
    const stiction = Math.exp(-6.5 * dt);
    body.setLinvel({ x: lv.x * stiction, y: lv.y, z: lv.z * stiction }, false);
  }
}

function guardCollisionEnergySpike(body: RAPIER.RigidBody): void {
  if (body.isSleeping()) return;
  const lv = body.linvel();
  const hSpeed = Math.hypot(lv.x, lv.z);
  const cap = PHYSICS_BALANCE.maxCollisionSpeedCap;
  if (hSpeed > cap && hSpeed > 1e-5) {
    const scale = cap / hSpeed;
    body.setLinvel({ x: lv.x * scale, y: Math.min(lv.y, 4.5), z: lv.z * scale }, false);
  }
}

function areBodiesSettled(bodies: RAPIER.RigidBody[]): boolean {
  for (const b of bodies) {
    const t = b.translation();
    if (t.y < FLOOR_Y + 0.5) continue;
    const lv = b.linvel();
    const av = b.angvel();
    const linSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
    const angSq = av.x * av.x + av.y * av.y + av.z * av.z;
    if (linSq > SETTLE_LIN_SPEED * SETTLE_LIN_SPEED || angSq > SETTLE_ANG_SPEED * SETTLE_ANG_SPEED) {
      return false;
    }
  }
  return true;
}

export interface AuthoritativeShotResolution {
  penStates: OnlinePenPairState;
  keyframes: ShotKeyframe[];
  collisions: ShotCollisionEvent[];
  powerPct: number;
  appliedSpeed: number;
  spinFactor: number;
  durationSeconds: number;
  firstFallenSlot: 1 | 2 | null;
  winnerSlot: 1 | 2 | null;
  isDraw: boolean;
  resultType: MatchResultType | null;
  resultReason: string | null;
}

/**
 * Authoritative deterministic Rapier3D physics resolution usable in both Node.js / Vercel
 * Serverless Functions and the browser.
 *
 * Canonical simulation always runs in the horizontal tabletop coordinate frame
 * (`TABLE_HALF_W = 9.75`, `TABLE_HALF_D = 6.25`), guaranteeing fair identical physics between
 * desktop horizontal and mobile vertical clients.
 */
export async function resolveAuthoritativeShot(params: {
  penStates: OnlinePenPairState;
  shooterSlot: 1 | 2;
  localAnchor: CanonicalVec3;
  dirX: number;
  dirZ: number;
  powerRatio: number;
}): Promise<AuthoritativeShotResolution> {
  await ensureSharedRapierInitialized();

  const { penStates, shooterSlot } = params;
  const shooterState = shooterSlot === 1 ? penStates.player1 : penStates.player2;
  if (shooterState.isEliminated) {
    throw new Error('Eliminated player cannot shoot.');
  }

  const dirLen = Math.hypot(params.dirX, params.dirZ);
  if (!Number.isFinite(dirLen) || dirLen < 1e-4) {
    throw new Error('Invalid shot direction.');
  }
  const dirX = params.dirX / dirLen;
  const dirZ = params.dirZ / dirLen;
  const powerRatio = clamp(params.powerRatio, 0.02, 1.0);
  const shooterSpec = PEN_SPECS[shooterState.penType];
  const spec1 = PEN_SPECS[penStates.player1.penType];
  const spec2 = PEN_SPECS[penStates.player2.penType];

  const world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
  world.timestep = PHYSICS_FIXED_DT;
  world.numSolverIterations = 8;
  const eventQueue = new RAPIER.EventQueue(true);

  try {
    // Tabletop & floor colliders (top surface strictly at Y = 0)
    const tableBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -TABLE_THICKNESS * 0.5, 0)
    );
    const tableCol = world.createCollider(
      RAPIER.ColliderDesc.cuboid(TABLE_HALF_W, TABLE_THICKNESS * 0.5, TABLE_HALF_D)
        .setFriction(TABLE_FRICTION)
        .setRestitution(TABLE_RESTITUTION),
      tableBody
    );

    const floorBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.25, 0)
    );
    const floorCol = world.createCollider(
      RAPIER.ColliderDesc.cuboid(45, 0.25, 45).setFriction(0.6).setRestitution(0.15),
      floorBody
    );

    const pen1Built = buildAuthoritativePenBody(world, penStates.player1, spec1);
    const pen2Built = buildAuthoritativePenBody(world, penStates.player2, spec2);

    const shooterBody = shooterSlot === 1 ? pen1Built.body : pen2Built.body;
    const clampedAnchor = clampLocalAnchorRaw(params.localAnchor, shooterSpec);

    const sPos = shooterBody.translation();
    const sRot = shooterBody.rotation();
    const sLv = shooterBody.linvel();
    const sAv = shooterBody.angvel();
    const worldOffset = rotateVecByQuat(clampedAnchor, sRot);
    const worldAnchorX = sPos.x + worldOffset.x;
    const worldAnchorZ = sPos.z + worldOffset.z;

    const com = shooterBody.localCom();
    const rx = worldAnchorX - sPos.x;
    const rz = worldAnchorZ - sPos.z;
    const rPerp = rz * dirX - rx * dirZ;
    const spinFactor = clamp(Math.abs(rPerp) / (shooterSpec.length * 0.44), 0, 1);

    const inertiaY =
      (shooterSpec.mass * shooterSpec.length * shooterSpec.length) / 12 +
      shooterSpec.mass * com.z * com.z;
    const invEffectiveMass = 1 / shooterSpec.mass + (rPerp * rPerp) / Math.max(inertiaY, 0.05);
    const effectiveMass = 1 / invEffectiveMass;
    const massRatio = clamp(effectiveMass / shooterSpec.mass, 0.25, 1.0);

    const curvedSpeed = powerRatioToLaunchSpeed(powerRatio, shooterSpec.mass);
    const leverageScale = 0.88 + 0.12 * massRatio;
    const angSpeed = Math.hypot(sAv.x, sAv.y, sAv.z);
    const rotPenalty = 1 / (1 + angSpeed * 0.02);
    const maxSpeedForPen =
      PHYSICS_BALANCE.maxLaunchSpeed / Math.pow(Math.max(0.4, shooterSpec.mass), 0.26);
    const desiredSpeed = clamp(curvedSpeed * leverageScale * rotPenalty, 0, maxSpeedForPen);

    const vAlong = Math.max(0, sLv.x * dirX + sLv.z * dirZ);
    const deltaSpeed = Math.max(0, desiredSpeed - vAlong);
    const deltaImpulse = deltaSpeed * shooterSpec.mass;

    if (deltaImpulse > 0.08) {
      shooterBody.wakeUp();
      shooterBody.applyImpulseAtPoint(
        { x: dirX * deltaImpulse, y: 0.06, z: dirZ * deltaImpulse },
        { x: worldAnchorX, y: sPos.y, z: worldAnchorZ },
        true
      );
    }

    const keyframes: ShotKeyframe[] = [
      {
        t: 0,
        p1: makePoseTuple(pen1Built.body),
        p2: makePoseTuple(pen2Built.body),
      },
    ];
    const collisions: ShotCollisionEvent[] = [];

    const maxSteps = Math.ceil(MAX_SHOT_SECONDS / PHYSICS_FIXED_DT);
    let shotTime = 0;
    let settleTimer = 0;
    let p1OobTimer = 0;
    let p2OobTimer = 0;
    let p1Fell = penStates.player1.isEliminated;
    let p2Fell = penStates.player2.isEliminated;
    let firstFallenSlot: 1 | 2 | null = null;
    let p1Knockouts = penStates.player1.knockoutsCount;
    let p2Knockouts = penStates.player2.knockoutsCount;
    let lastPenPenCollisionTime = -1;
    let lastTableImpactTime: Record<1 | 2, number> = { 1: -1, 2: -1 };
    let penHitDuringShot = false;

    const p1AngularCeiling = spec1.passive.tuning.angularSpeedCeiling;
    const p2AngularCeiling = spec2.passive.tuning.angularSpeedCeiling;

    for (let stepIdx = 1; stepIdx <= maxSteps; stepIdx++) {
      shotTime = stepIdx * PHYSICS_FIXED_DT;

      // Apply Spin Control angular speed ceiling if configured
      if (p1AngularCeiling > 0) {
        const av = pen1Built.body.angvel();
        const mag = Math.hypot(av.x, av.y, av.z);
        if (mag > p1AngularCeiling && mag > 1e-5) {
          const s = p1AngularCeiling / mag;
          pen1Built.body.setAngvel({ x: av.x * s, y: av.y * s, z: av.z * s }, false);
        }
      }
      if (p2AngularCeiling > 0) {
        const av = pen2Built.body.angvel();
        const mag = Math.hypot(av.x, av.y, av.z);
        if (mag > p2AngularCeiling && mag > 1e-5) {
          const s = p2AngularCeiling / mag;
          pen2Built.body.setAngvel({ x: av.x * s, y: av.y * s, z: av.z * s }, false);
        }
      }

      const preVel1 = pen1Built.body.linvel();
      const preVel2 = pen2Built.body.linvel();

      world.step(eventQueue);

      applyRollingAndStiction(pen1Built.body, PHYSICS_FIXED_DT);
      applyRollingAndStiction(pen2Built.body, PHYSICS_FIXED_DT);
      guardCollisionEnergySpike(pen1Built.body);
      guardCollisionEnergySpike(pen2Built.body);

      eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        const h1P1 = pen1Built.handles.has(h1);
        const h2P1 = pen1Built.handles.has(h2);
        const h1P2 = pen2Built.handles.has(h1);
        const h2P2 = pen2Built.handles.has(h2);

        if ((h1P1 && h2P2) || (h1P2 && h2P1)) {
          if (shotTime - lastPenPenCollisionTime >= 0.075) {
            lastPenPenCollisionTime = shotTime;
            penHitDuringShot = true;
            const relSpeed = Math.hypot(
              preVel1.x - preVel2.x,
              preVel1.y - preVel2.y,
              preVel1.z - preVel2.z
            );
            if (relSpeed > 0.6) {
              const t1 = pen1Built.body.translation();
              const t2 = pen2Built.body.translation();
              collisions.push({
                t: roundNum(shotTime, 3),
                kind: 'pen',
                point: [
                  roundNum((t1.x + t2.x) * 0.5, 3),
                  roundNum(Math.max(0.08, (t1.y + t2.y) * 0.5), 3),
                  roundNum((t1.z + t2.z) * 0.5, 3),
                ],
                speed: roundNum(relSpeed, 2),
              });

              // Apply passive knockbackResistance cleanly on defender
              const defenderSlot: 1 | 2 = shooterSlot === 1 ? 2 : 1;
              const defenderBody = defenderSlot === 1 ? pen1Built.body : pen2Built.body;
              const defenderSpec = defenderSlot === 1 ? spec1 : spec2;
              const resistance = defenderSpec.passive.tuning.knockbackResistance;
              if (relSpeed >= 1.2 && resistance !== 0) {
                const factor = clamp(1 - resistance, 0.4, 1.4);
                const dlv = defenderBody.linvel();
                defenderBody.setLinvel(
                  { x: dlv.x * factor, y: dlv.y * factor, z: dlv.z * factor },
                  false
                );
              }
            }
          }
          return;
        }

        const penSlot: 1 | 2 | null = h1P1 || h2P1 ? 1 : h1P2 || h2P2 ? 2 : null;
        if (!penSlot) return;
        const otherHandle = h1P1 || h1P2 ? h2 : h1;
        const surface =
          otherHandle === tableCol.handle
            ? 'table'
            : otherHandle === floorCol.handle
              ? 'floor'
              : null;
        if (surface && shotTime - lastTableImpactTime[penSlot] >= 0.08) {
          const b = penSlot === 1 ? pen1Built.body : pen2Built.body;
          const lv = b.linvel();
          const speed = Math.abs(lv.y) + Math.hypot(lv.x, lv.y, lv.z) * 0.25;
          if (speed > 0.55) {
            lastTableImpactTime[penSlot] = shotTime;
            const pos = b.translation();
            collisions.push({
              t: roundNum(shotTime, 3),
              kind: surface,
              point: [roundNum(pos.x, 3), roundNum(pos.y, 3), roundNum(pos.z, 3)],
              speed: roundNum(speed, 2),
            });
          }
        }
      });

      // OOB & Fall check (identical to TurnManager)
      const checkOob = (body: RAPIER.RigidBody, prevTimer: number): { timer: number; confirmed: boolean } => {
        const pos = body.translation();
        const isOutside =
          Math.abs(pos.x) > TABLE_HALF_W + OOB_MARGIN ||
          Math.abs(pos.z) > TABLE_HALF_D + OOB_MARGIN ||
          pos.y < OOB_Y_THRESHOLD;
        let nextTimer = prevTimer;
        if (pos.y < FALL_Y_THRESHOLD) {
          nextTimer = OOB_CONFIRM_SECONDS;
        } else if (isOutside) {
          nextTimer += PHYSICS_FIXED_DT;
        } else {
          nextTimer = 0;
        }
        return { timer: nextTimer, confirmed: nextTimer >= OOB_CONFIRM_SECONDS };
      };

      if (!p1Fell) {
        const res1 = checkOob(pen1Built.body, p1OobTimer);
        p1OobTimer = res1.timer;
        if (res1.confirmed) {
          p1Fell = true;
          if (firstFallenSlot === null) firstFallenSlot = 1;
          if (shooterSlot === 2 && penHitDuringShot) p2Knockouts += 1;
          const pos = pen1Built.body.translation();
          collisions.push({
            t: roundNum(shotTime, 3),
            kind: 'floor',
            point: [roundNum(pos.x, 3), roundNum(pos.y, 3), roundNum(pos.z, 3)],
            speed: 4.5,
            fallenSlot: 1,
          });
        }
      }

      if (!p2Fell) {
        const res2 = checkOob(pen2Built.body, p2OobTimer);
        p2OobTimer = res2.timer;
        if (res2.confirmed) {
          p2Fell = true;
          if (firstFallenSlot === null) firstFallenSlot = 2;
          if (shooterSlot === 1 && penHitDuringShot) p1Knockouts += 1;
          const pos = pen2Built.body.translation();
          collisions.push({
            t: roundNum(shotTime, 3),
            kind: 'floor',
            point: [roundNum(pos.x, 3), roundNum(pos.y, 3), roundNum(pos.z, 3)],
            speed: 4.5,
            fallenSlot: 2,
          });
        }
      }

      // Sample keyframe at 30 Hz (every 4 substeps)
      if (stepIdx % 4 === 0) {
        keyframes.push({
          t: roundNum(shotTime, 3),
          p1: makePoseTuple(pen1Built.body),
          p2: makePoseTuple(pen2Built.body),
        });
      }

      const settled = areBodiesSettled([pen1Built.body, pen2Built.body]);
      const hasPendingOob = (!p1Fell && p1OobTimer > 0) || (!p2Fell && p2OobTimer > 0);
      if (settled && !hasPendingOob) {
        settleTimer += PHYSICS_FIXED_DT;
      } else {
        settleTimer = 0;
      }

      const fellQuickResolve = firstFallenSlot !== null && shotTime > 0.85;
      if (settleTimer >= SETTLE_HOLD_SECONDS || fellQuickResolve || stepIdx === maxSteps) {
        if (stepIdx % 4 !== 0) {
          keyframes.push({
            t: roundNum(shotTime, 3),
            p1: makePoseTuple(pen1Built.body),
            p2: makePoseTuple(pen2Built.body),
          });
        }
        break;
      }
    }

    let winnerSlot: 1 | 2 | null = null;
    let isDraw = false;
    let resultType: MatchResultType | null = null;
    let resultReason: string | null = null;

    if (p1Fell && !p2Fell) {
      winnerSlot = 2;
      resultType = 'PLAYER2_WIN';
      resultReason = 'Player 1 pen fell off the desk!';
    } else if (p2Fell && !p1Fell) {
      winnerSlot = 1;
      resultType = 'PLAYER1_WIN';
      resultReason = 'Player 2 pen fell off the desk!';
    } else if (p1Fell && p2Fell) {
      if (firstFallenSlot === 1) {
        winnerSlot = 2;
        resultType = 'PLAYER2_WIN';
        resultReason = 'Double drop — Player 1 fell off the desk first!';
      } else if (firstFallenSlot === 2) {
        winnerSlot = 1;
        resultType = 'PLAYER1_WIN';
        resultReason = 'Double drop — Player 2 fell off the desk first!';
      } else {
        isDraw = true;
        resultType = 'DRAW';
        resultReason = 'Double drop — both pens fell off simultaneously!';
      }
    }

    const updatedStates: OnlinePenPairState = {
      player1: {
        ...penStates.player1,
        pose: readCanonicalPose(pen1Built.body),
        isEliminated: p1Fell,
        shotsCount: penStates.player1.shotsCount + (shooterSlot === 1 ? 1 : 0),
        knockoutsCount: p1Knockouts,
      },
      player2: {
        ...penStates.player2,
        pose: readCanonicalPose(pen2Built.body),
        isEliminated: p2Fell,
        shotsCount: penStates.player2.shotsCount + (shooterSlot === 2 ? 1 : 0),
        knockoutsCount: p2Knockouts,
      },
    };

    return {
      penStates: updatedStates,
      keyframes,
      collisions,
      powerPct: Math.round(powerRatio * 100),
      appliedSpeed: roundNum(desiredSpeed, 2),
      spinFactor: roundNum(spinFactor, 3),
      durationSeconds: roundNum(shotTime, 3),
      firstFallenSlot,
      winnerSlot,
      isDraw,
      resultType,
      resultReason,
    };
  } finally {
    eventQueue.free();
    world.free();
  }
}
