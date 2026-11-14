import * as THREE from 'three';
import { AIController } from '../ai/AIController';
import { AudioManager } from '../audio/AudioManager';
import { AbilitySystem } from './Abilities';
import { AbilityPreviewSource, AimController } from './AimController';
import { CameraManager } from './CameraManager';
import { DragController } from './DragController';
import { GameSettings, GameStateManager, PlayerId } from './GameState';
import { MultiplayerMatchConfig } from './MultiplayerTypes';
import { ParticleSystem } from './ParticleSystem';
import { PenModel } from './Pen';
import { PerformanceMonitor } from './PerformanceMonitor';
import { ensureRapierInitialized, BodyPose, PhysicsManager } from './PhysicsManager';
import { QualityController } from './QualityController';
import { detectRecommendedQuality, SceneManager } from './SceneManager';
import { ShotTrailSystem } from './ShotTrails';
import { TableEnvironment } from './Table';
import { TurnManager } from './TurnManager';
import {
  ArenaId,
  ArenaOrientation,
  DEFAULT_DESHI_VARIANT,
  PenTypeId,
  resolveArenaOrientation,
} from '../utils/Constants';
import type {
  CanonicalPose,
  CompactPoseTuple,
  ResolvedShotSummary,
  RoomSnapshot,
  ShotCollisionEvent,
  ShotKeyframe,
} from '../shared/OnlineTypes';

/** The AI always fields the same pen class so the match-up stays fair and consistent. */
const BOT_PEN_TYPE = 'IRON_FORCE' as const;

export class PenFightGame {
  private readonly container: HTMLElement;
  public readonly state: GameStateManager;
  public readonly audio = new AudioManager();
  /** Live rendering/physics telemetry for the on-screen performance panel. */
  public readonly monitor = new PerformanceMonitor();

  private settings: GameSettings;
  private sceneManager!: SceneManager;
  private cameraManager!: CameraManager;
  private tableEnv!: TableEnvironment;
  private penModels: Map<string, PenModel> = new Map();
  private penTypes: Map<string, PenTypeId> = new Map();
  private currentMatchConfig: MultiplayerMatchConfig | null = null;
  private playerPen!: PenModel;
  private botPen!: PenModel;
  private particles!: ParticleSystem;
  private trailSystem!: ShotTrailSystem;
  private physics!: PhysicsManager;
  private aimController!: AimController;
  private dragController!: DragController;
  private aiController!: AIController;
  private turnManager!: TurnManager;
  private abilitySystem!: AbilitySystem;
  private qualityController!: QualityController;

  private readonly clock = new THREE.Clock();
  /** rAF handle — kept separate from the software-GL timeout handle so both can be cancelled. */
  private rafId = 0;
  private timeoutId = 0;
  private disposed = false;
  private initialized = false;
  /** True while a full-screen overlay hides the arena; the loop is halted instead of burning GPU. */
  private suspended = false;
  private hitstopTimer = 0;
  private telemetryTimer = 0;
  private statsTimer = 0;
  /** Collisions counted between diagnostics flushes, so impacts never re-render React per hit. */
  private pendingCollisions = 0;
  /** Resolved Motion Effects preference (camera shake / hitstop / shot-follow). */
  private motionEnabled = true;
  private abilityPreviewActive = false;
  private arenaOrientation: ArenaOrientation = 'horizontal';
  private readonly trailTip = new THREE.Vector3();
  private readonly shotFocus = new THREE.Vector3();
  private resizeObserver: ResizeObserver | null = null;
  private onContextLostChange?: (lost: boolean) => void;

  // ── Online 1v1 authoritative replay & input state ──────────────────────────
  private onlineMode = false;
  private onlineMyUserId: string | null = null;
  private onlineMySlot: 1 | 2 = 1;
  private onlineCanDrag = false;
  private onlineMatchId: string | null = null;
  private onlineLastReplayedEventId: string | null = null;
  private onlineLatestSnapshot: RoomSnapshot | null = null;
  private onlineOnSubmitShot:
    | ((shot: {
        localAnchor: { x: number; y: number; z: number };
        dirX: number;
        dirZ: number;
        powerRatio: number;
      }) => void)
    | null = null;
  private onlineOnReplayStateChange: ((replaying: boolean) => void) | null = null;
  private onlineReplay: {
    keyframes: ShotKeyframe[];
    collisions: ShotCollisionEvent[];
    elapsed: number;
    duration: number;
    nextColIdx: number;
    targetSnapshot: RoomSnapshot;
    shooterSlot: 1 | 2;
  } | null = null;
  private readonly _qVertDelta = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI * 0.5
  );
  private readonly _tmpQ1 = new THREE.Quaternion();
  private readonly _tmpQ2 = new THREE.Quaternion();
  private readonly _tmpV1 = new THREE.Vector3();
  private readonly _tmpV2 = new THREE.Vector3();

  constructor(
    container: HTMLElement,
    initialSettings: GameSettings,
    initialWins = 0,
    initialLosses = 0,
    onContextLostChange?: (lost: boolean) => void
  ) {
    this.container = container;
    this.settings = { ...initialSettings };
    this.state = new GameStateManager(initialWins, initialLosses, initialSettings.playerPenType);
    this.onContextLostChange = onContextLostChange;
  }

  public async init(): Promise<void> {
    await ensureRapierInitialized();
    if (this.disposed) return;

    const rect = this.container.getBoundingClientRect();
    const width = Math.round(rect.width) || this.container.clientWidth || window.innerWidth;
    const height = Math.round(rect.height) || this.container.clientHeight || window.innerHeight;

    this.sceneManager = new SceneManager(this.container);
    this.sceneManager.onContextLostChange = this.onContextLostChange;
    // Profile the device once; AUTO quality starts here and never climbs above this tier.
    this.qualityController = new QualityController(detectRecommendedQuality());

    this.arenaOrientation = resolveArenaOrientation(width, height);
    this.cameraManager = new CameraManager(width, height, this.arenaOrientation);
    this.tableEnv = new TableEnvironment(this.sceneManager.maxAnisotropy, this.settings.arenaId);
    this.tableEnv.setOrientation(this.arenaOrientation);
    this.sceneManager.setArenaAtmosphere(this.settings.arenaId);
    this.sceneManager.scene.add(this.tableEnv.group);

    this.playerPen = new PenModel(
      'player',
      this.sceneManager.maxAnisotropy,
      this.settings.playerPenType,
      'blue',
      'team_default',
      this.settings.deshiVariant
    );
    this.botPen = new PenModel('bot', this.sceneManager.maxAnisotropy, BOT_PEN_TYPE, 'red');
    this.sceneManager.scene.add(
      this.playerPen.group,
      this.playerPen.contactShadow,
      this.botPen.group,
      this.botPen.contactShadow
    );
    this.penModels.set('player', this.playerPen);
    this.penModels.set('bot', this.botPen);
    this.penTypes.set('player', this.settings.playerPenType);
    this.penTypes.set('bot', BOT_PEN_TYPE);

    this.particles = new ParticleSystem();
    this.sceneManager.scene.add(this.particles.group);

    this.trailSystem = new ShotTrailSystem();
    this.sceneManager.scene.add(this.trailSystem.group);

    this.physics = new PhysicsManager(this.settings.playerPenType, BOT_PEN_TYPE);
    this.physics.setOrientation(this.arenaOrientation);
    this.physics.resetPens();
    this.state.update({ arenaOrientation: this.arenaOrientation });
    this.abilitySystem = new AbilitySystem(
      this.physics,
      (id: PlayerId) => this.penTypes.get(id) ?? (id === 'bot' || id.startsWith('red') ? BOT_PEN_TYPE : this.settings.playerPenType),
      {
        canActivate: (id: PlayerId) => this.canActivateAbility(id),
        onActivate: (id: PlayerId) => this.onAbilityActivated(id),
        onReady: (id: PlayerId) => this.onAbilityReady(id),
      }
    );
    this.aimController = new AimController();
    this.sceneManager.scene.add(this.aimController.group);

    this.aiController = new AIController(this.physics);

    this.turnManager = new TurnManager(this.state, this.physics, {
      onCountdownTick: (val) => {
        this.audio.playCountdownTick(val === 0);
      },
      onStartPlayerTurn: (activeId: string) => {
        for (const [id, model] of this.penModels.entries()) {
          if (id === activeId) {
            const teamColor = model.team === 'red' ? 0xfb7185 : 0x60a5fa;
            model.setHighlight(0.42, teamColor);
          } else {
            model.setHighlight(0);
          }
        }
        const activeModel = this.penModels.get(activeId);
        if (activeModel) {
          this.dragController.setActivePen(activeId, activeModel);
        }
        this.applyAbilityPreview();
      },
      onStartBotTurn: () => {
        for (const [id, model] of this.penModels.entries()) {
          if (id === 'bot') {
            model.setHighlight(0.24);
          } else {
            model.setHighlight(0);
          }
        }
        this.aiController.startTurn(this.settings.difficulty, {
          onLaunch: (powerRatio: number) => {
            this.penModels.get('bot')?.setHighlight(0);
            this.audio.playRelease(powerRatio);
            this.turnManager.notifyShotLaunched('bot', powerRatio);
          },
          onSpecialShot: () => false,
          canUseSpecialShot: () => false,
        });
      },
      onPenFell: (penId: PlayerId) => {
        const pose = this.physics.getPose(penId);
        const fallSpeed = Math.hypot(pose.linvel.x, pose.linvel.y, pose.linvel.z);
        this.audio.playFall(fallSpeed);
        const pen = this.penModels.get(penId);
        const burstColor = pen?.team === 'red' ? 0xf87171 : 0x60a5fa;
        this.particles.spawnBurst(
          new THREE.Vector3(pose.pos.x, 0.1, pose.pos.z),
          16,
          burstColor,
          4.0
        );
      },
      onTurnTimeout: (timedOutId: string) => {
        this.dragController.cancelDrag();
        this.abilitySystem.disarm(timedOutId);
        this.applyAbilityPreview();
        this.audio.playTimeExpired();
      },
      onTurnTransition: (player) => {
        this.audio.playTurnSwitch();
        for (const [id, model] of this.penModels.entries()) {
          if (id === player.id) {
            const teamColor = model.team === 'red' ? 0xfb7185 : 0x60a5fa;
            model.setHighlight(0.45, teamColor);
          } else {
            model.setHighlight(0);
          }
        }
      },
      onTimerWarning: (secondsRemaining: number) => {
        if (secondsRemaining <= 5 && secondsRemaining > 0) {
          this.audio.playTimerWarning(secondsRemaining <= 3);
        }
      },
      onMatchOver: (winner: PlayerId) => {
        for (const model of this.penModels.values()) {
          model.setHighlight(0);
        }
        if (winner === 'player' || winner === 'blue') {
          this.audio.playVictory();
          this.particles.spawnConfetti(new THREE.Vector3(0, 1.8, 0));
        } else {
          this.audio.playDefeat();
        }
      },
    });

    this.dragController = new DragController(
      this.sceneManager.renderer.domElement,
      this.cameraManager.camera,
      this.physics,
      this.playerPen,
      {
        canDrag: () => {
          if (this.onlineMode) {
            return this.onlineCanDrag && !this.onlineReplay;
          }
          const snap = this.state.getSnapshot();
          return snap.matchState === 'PLAYER_TURN' && !snap.isTurnTimeoutNotice;
        },
        canAcceptShot: () => {
          if (this.onlineMode) {
            return this.onlineCanDrag && !this.onlineReplay;
          }
          return this.turnManager.canAcceptShot();
        },
        onGrabStart: () => {
          this.audio.unlock();
          this.audio.playGrab();
          if (this.onlineMode) {
            const myId = this.onlineMySlot === 1 ? 'blue_1' : 'red_1';
            const myModel = this.penModels.get(myId);
            if (myModel) {
              const teamColor = myModel.team === 'red' ? 0xfb7185 : 0x60a5fa;
              myModel.setHighlight(0.48, teamColor);
            }
            return;
          }
          this.turnManager.dismissTurnTransition();
          const activeId = this.turnManager.getActivePlayerId();
          const activeModel = this.penModels.get(activeId);
          if (activeModel) {
            const teamColor = activeModel.team === 'red' ? 0xfb7185 : 0x60a5fa;
            activeModel.setHighlight(0.48, teamColor);
          }
        },
        onTelemetry: (telemetry) => {
          this.state.updateDragTelemetry(telemetry);
        },
        onShotLaunch: (powerRatio) => {
          const activeId = this.turnManager.getActivePlayerId();
          this.penModels.get(activeId)?.setHighlight(0);
          this.audio.playRelease(powerRatio);
          this.turnManager.notifyShotLaunched(activeId, powerRatio);
        },
        onDragCancel: () => {
          if (this.onlineMode) {
            if (this.onlineCanDrag) {
              const myId = this.onlineMySlot === 1 ? 'blue_1' : 'red_1';
              const myModel = this.penModels.get(myId);
              if (myModel) {
                const teamColor = myModel.team === 'red' ? 0xfb7185 : 0x60a5fa;
                myModel.setHighlight(0.32, teamColor);
              }
            }
            return;
          }
          if (this.state.getSnapshot().matchState === 'PLAYER_TURN') {
            const activeId = this.turnManager.getActivePlayerId();
            this.penModels.get(activeId)?.setHighlight(0.32);
          }
        },
        isAbilityArmed: () => {
          if (this.onlineMode) return false;
          const activeId = this.turnManager.getActivePlayerId();
          return this.abilitySystem.isArmed(activeId);
        },
        onAbilityLaunch: (dirX, dirZ) => {
          if (this.onlineMode) return false;
          const activeId = this.turnManager.getActivePlayerId();
          return this.abilitySystem.activate(activeId, dirX, dirZ);
        },
        onOnlineShotSubmit: (shot) => {
          if (!this.onlineMode || !this.onlineOnSubmitShot) return;
          const myId = this.onlineMySlot === 1 ? 'blue_1' : 'red_1';
          this.penModels.get(myId)?.setHighlight(0);
          this.audio.playRelease(shot.powerRatio);
          const canonDir = this.clientDirToCanonical(shot.dirX, shot.dirZ);
          this.onlineCanDrag = false;
          this.onlineOnSubmitShot({
            localAnchor: shot.localAnchor,
            dirX: canonDir.dirX,
            dirZ: canonDir.dirZ,
            powerRatio: shot.powerRatio,
          });
        },
      }
    );

    this.applySettings(this.settings);
    this.syncVisualTransforms();
    this.sceneManager.precompile(this.cameraManager.camera);

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        let w = 0;
        let h = 0;
        if (entry.contentBoxSize && entry.contentBoxSize.length > 0) {
          w = entry.contentBoxSize[0].inlineSize;
          h = entry.contentBoxSize[0].blockSize;
        } else if (entry.contentRect) {
          w = entry.contentRect.width;
          h = entry.contentRect.height;
        }
        if (!w || !h) {
          const rect = this.container.getBoundingClientRect();
          w = rect.width;
          h = rect.height;
        }
        w = Math.round(w);
        h = Math.round(h);
        if (w > 0 && h > 0) {
          this.applyViewportMetrics(w, h, false);
        }
      }
    });
    this.resizeObserver.observe(this.container);

    window.addEventListener('resize', this.handleViewportResize);
    window.addEventListener('orientationchange', this.handleOrientationChange);

    this.initialized = true;
    this.clock.start();
    this.tick();
  }

  private applyViewportMetrics(width: number, height: number, snapCamera: boolean): void {
    const nextOrientation = resolveArenaOrientation(width, height, this.arenaOrientation);
    if (nextOrientation !== this.arenaOrientation) {
      const angleRad = nextOrientation === 'vertical' ? Math.PI * 0.5 : -Math.PI * 0.5;
      this.dragController.cancelDrag();
      this.aiController.rotatePlannedShot(angleRad);

      this.arenaOrientation = nextOrientation;
      this.tableEnv.setOrientation(nextOrientation);
      this.physics.setOrientation(nextOrientation);
      this.cameraManager.setArenaOrientation(nextOrientation, snapCamera);

      this.syncVisualTransforms();
      this.sceneManager.requestShadowUpdate();
      this.state.update({ arenaOrientation: nextOrientation });
    }
    this.cameraManager.resize(width, height);
    this.sceneManager.resize(width, height);
  }

  private handleViewportResize = (): void => {
    if (!this.initialized || this.disposed) return;
    const rect = this.container.getBoundingClientRect();
    const w = Math.round(rect.width) || this.container.clientWidth || window.innerWidth;
    const h = Math.round(rect.height) || this.container.clientHeight || window.innerHeight;
    if (w > 0 && h > 0) {
      this.applyViewportMetrics(w, h, false);
    }
  };

  private handleOrientationChange = (): void => {
    // Settle dimensions immediately, next frame, and after mobile browser URL bar / viewport transition completes
    this.handleViewportResize();
    requestAnimationFrame(() => {
      this.handleViewportResize();
    });
    setTimeout(this.handleViewportResize, 100);
    setTimeout(this.handleViewportResize, 250);
  };

  public startMatch(multiplayerConfig?: MultiplayerMatchConfig): void {
    if (!this.initialized) return;
    this.currentMatchConfig = multiplayerConfig ?? null;
    this.audio.unlock();
    this.dragController.cancelDrag();
    this.aiController.cancel();

    // 1. Clean up old pen models
    for (const model of this.penModels.values()) {
      this.sceneManager.scene.remove(model.group);
      this.sceneManager.scene.remove(model.contactShadow);
      model.dispose();
    }
    this.penModels.clear();
    this.penTypes.clear();

    // 2. Setup new pen models
    if (multiplayerConfig && multiplayerConfig.mode !== 'VS_AI' && multiplayerConfig.mode !== 'PRACTICE') {
      for (const p of multiplayerConfig.players) {
        this.penTypes.set(p.id, p.penType);
        const model = new PenModel(
          p.id,
          this.sceneManager.maxAnisotropy,
          p.penType,
          p.team,
          p.skinId ?? 'team_default',
          p.deshiVariant ?? DEFAULT_DESHI_VARIANT
        );
        this.sceneManager.scene.add(model.group, model.contactShadow);
        this.penModels.set(p.id, model);
      }
      this.turnManager.startNewMatch(multiplayerConfig);
      this.abilitySystem.reset(multiplayerConfig.players.map((p) => p.id));
    } else {
      this.penTypes.set('player', this.settings.playerPenType);
      this.penTypes.set('bot', BOT_PEN_TYPE);

      const pModel = new PenModel(
        'player',
        this.sceneManager.maxAnisotropy,
        this.settings.playerPenType,
        'blue',
        'team_default',
        this.settings.deshiVariant
      );
      const bModel = new PenModel('bot', this.sceneManager.maxAnisotropy, BOT_PEN_TYPE, 'red');
      this.sceneManager.scene.add(pModel.group, pModel.contactShadow, bModel.group, bModel.contactShadow);
      this.penModels.set('player', pModel);
      this.penModels.set('bot', bModel);
      this.playerPen = pModel;
      this.botPen = bModel;

      this.turnManager.startNewMatch(
        multiplayerConfig,
        this.settings.playerPenType,
        BOT_PEN_TYPE
      );
      this.abilitySystem.reset(['player', 'bot']);
    }

    const firstId = this.turnManager.getActivePlayerId();
    const firstModel = this.penModels.get(firstId) ?? this.penModels.values().next().value;
    if (firstModel) {
      this.dragController.setActivePen(firstId, firstModel);
    }

    this.trailSystem.reset();
    this.aimController.setAbilityPreview(null);
    this.abilityPreviewActive = false;
    this.monitor.reset();
    this.pendingCollisions = 0;
    this.statsTimer = 0;
    this.cameraManager.setMenuMode(false);
    this.sceneManager.requestShadowUpdate();
    this.syncVisualTransforms();
  }

  public restartMatch(): void {
    if (this.currentMatchConfig) {
      this.startMatch(this.currentMatchConfig);
    } else {
      this.startMatch();
    }
  }

  public dismissTurnTransition(): void {
    if (!this.initialized) return;
    this.turnManager?.dismissTurnTransition();
  }

  /** Active Special Shots are disabled; only passive pen skills remain active. */
  public activatePlayerAbility(): boolean {
    return false;
  }

  /** Cancels any primed Special Shot without firing it. */
  public cancelPlayerAbility(): boolean {
    return false;
  }

  /** Active Special Shots are disabled; passives remain always on. */
  private canActivateAbility(_id: PlayerId): boolean {
    return false;
  }

  /** Raised the instant any pen's Special Shot actually starts — audio, particles, trail, camera. */
  private onAbilityActivated(id: PlayerId): void {
    this.audio.playAbilityActivate();
    const pose = this.physics.getPose(id);
    const shot = this.physics.getPenSpec(id)?.specialShot;
    if (!shot) return;
    const origin = new THREE.Vector3(pose.pos.x, Math.max(0.06, pose.pos.y), pose.pos.z);
    this.particles.spawnAbilityRing(
      origin,
      shot.colorHex,
      shot.physics.radialRadius > 0 ? 5.4 : 3.6
    );
    this.trailSystem.begin(id, shot.colorHex);
    if (id === this.turnManager?.getActivePlayerId() || id === 'player') {
      this.applyAbilityPreview();
    }
  }

  /** Raised the moment a pen's cooldown finishes so the HUD can chime that the shot is ready. */
  private onAbilityReady(id: PlayerId): void {
    if (id === this.turnManager?.getActivePlayerId() || id === 'player') {
      this.audio.playAbilityReady();
    }
  }

  /**
   * Points the aim overlay at the player's Special Shot physics while it is armed, and back at
   * the normal launch arc when it is not. Only called on a real arming transition so the preview
   * prediction cache is never needlessly invalidated.
   */
  private applyAbilityPreview(): void {
    if (!this.aimController) return;
    const activeId = this.turnManager?.getActivePlayerId() ?? 'player';
    const armed = this.abilitySystem.isArmed(activeId);
    if (armed === this.abilityPreviewActive) return;
    this.abilityPreviewActive = armed;
    if (!armed) {
      this.aimController.setAbilityPreview(null);
      return;
    }
    const shot = this.physics.getPenSpec(activeId)?.specialShot;
    if (!shot) return;
    const source: AbilityPreviewSource = {
      colorHex: shot.colorHex,
      durationSeconds: shot.durationSeconds,
      coastSeconds: 1.8,
      createProgram: (dirX: number, dirZ: number) =>
        this.abilitySystem.createPredictionProgram(activeId, dirX, dirZ),
    };
    this.aimController.setAbilityPreview(source);
  }

  /** SHOCKWAVE impact feedback: expanding ring + burst + a short camera kick. */
  private spawnShockwaveFeedback(id: PlayerId, point: { x: number; y: number; z: number }): void {
    const style = this.abilitySystem.getShockwaveStyle(id);
    if (!style) return;
    const origin = new THREE.Vector3(point.x, Math.max(0.06, point.y), point.z);
    this.particles.spawnAbilityRing(origin, style.colorHex, Math.max(4.2, style.radius * 2.4));
    this.particles.spawnBurst(origin, 18, style.colorHex, 4.6);
    if (this.motionEnabled) this.cameraManager.addShake(0.2);
  }

  /**
   * Replication entry point for a future multiplayer server: applies authoritative ability
   * windows / cooldowns so remote activations have identical physical consequences locally.
   */
  public applyRemoteAbilityState(state: Parameters<AbilitySystem['applyNetworkState']>[0]): void {
    if (!this.initialized) return;
    this.abilitySystem.applyNetworkState(state);
  }

  public enterOnlineMatch(params: {
    snapshot: RoomSnapshot;
    myUserId: string;
    onSubmitShot: (shot: {
      localAnchor: { x: number; y: number; z: number };
      dirX: number;
      dirZ: number;
      powerRatio: number;
    }) => void;
    onReplayStateChange?: (replaying: boolean) => void;
  }): void {
    if (!this.initialized || !params.snapshot.match || !params.snapshot.matchState) return;
    const { snapshot, myUserId, onSubmitShot, onReplayStateChange } = params;
    const match = snapshot.match!;
    const penStates = snapshot.matchState!.penStates;

    this.onlineMode = true;
    this.onlineMyUserId = myUserId;
    this.onlineMySlot = match.player1Uid === myUserId ? 1 : 2;
    this.onlineMatchId = match.id;
    this.onlineLastReplayedEventId = snapshot.matchState?.lastShot?.eventId ?? null;
    this.onlineLatestSnapshot = snapshot;
    this.onlineOnSubmitShot = onSubmitShot;
    this.onlineOnReplayStateChange = onReplayStateChange ?? null;
    this.onlineReplay = null;
    this.onlineOnReplayStateChange?.(false);

    this.currentMatchConfig = null;
    this.dragController.cancelDrag();
    this.aiController.cancel();
    this.audio.unlock();

    // Apply the room's authoritative arena visually
    this.tableEnv.setArena(match.arenaId);
    this.sceneManager.setArenaAtmosphere(match.arenaId);
    if (!this.sceneManager.isSoftwareGl) {
      this.sceneManager.precompile(this.cameraManager.camera);
    }

    // Clear old pen models
    for (const model of this.penModels.values()) {
      this.sceneManager.scene.remove(model.group);
      this.sceneManager.scene.remove(model.contactShadow);
      model.dispose();
    }
    this.penModels.clear();
    this.penTypes.clear();

    const p1 = penStates.player1;
    const p2 = penStates.player2;

    const p1Model = new PenModel(
      'blue_1',
      this.sceneManager.maxAnisotropy,
      p1.penType,
      'blue',
      'team_default',
      p1.deshiVariant
    );
    const p2Model = new PenModel(
      'red_1',
      this.sceneManager.maxAnisotropy,
      p2.penType,
      'red',
      'team_default',
      p2.deshiVariant
    );
    this.sceneManager.scene.add(
      p1Model.group,
      p1Model.contactShadow,
      p2Model.group,
      p2Model.contactShadow
    );
    this.penModels.set('blue_1', p1Model);
    this.penModels.set('red_1', p2Model);
    this.penTypes.set('blue_1', p1.penType);
    this.penTypes.set('red_1', p2.penType);

    const p1Pose = this.canonicalToClientPose(p1.pose);
    const p2Pose = this.canonicalToClientPose(p2.pose);
    this.physics.configurePens([
      {
        id: 'blue_1',
        penType: p1.penType,
        spawn: { x: p1Pose.pos.x, y: p1Pose.pos.y, z: p1Pose.pos.z, yaw: 0 },
      },
      {
        id: 'red_1',
        penType: p2.penType,
        spawn: { x: p2Pose.pos.x, y: p2Pose.pos.y, z: p2Pose.pos.z, yaw: 0 },
      },
    ]);
    this.physics.setBodyPose('blue_1', p1Pose);
    this.physics.setBodyPose('red_1', p2Pose);

    const myPenId = this.onlineMySlot === 1 ? 'blue_1' : 'red_1';
    const myModel = this.penModels.get(myPenId)!;
    this.dragController.setActivePen(myPenId, myModel);

    this.trailSystem.reset();
    this.aimController.setAbilityPreview(null);
    this.abilityPreviewActive = false;
    this.cameraManager.setMenuMode(false);
    this.sceneManager.requestShadowUpdate();

    this.applyOnlineTurnState(snapshot, false);
    this.syncVisualTransforms();
  }

  public syncOnlineMatchState(snapshot: RoomSnapshot, isSubmitting = false): void {
    if (!this.initialized || !this.onlineMode || !snapshot.match || !snapshot.matchState) {
      return;
    }
    if (snapshot.match.id !== this.onlineMatchId) return;

    this.onlineLatestSnapshot = snapshot;
    const lastShot = snapshot.matchState.lastShot;

    if (
      lastShot &&
      lastShot.eventId !== this.onlineLastReplayedEventId &&
      lastShot.keyframes.length > 1
    ) {
      this.onlineLastReplayedEventId = lastShot.eventId;
      this.startOnlineShotReplay(lastShot, snapshot);
      return;
    }

    if (!this.onlineReplay) {
      this.applyOnlinePenPoses(snapshot);
      this.applyOnlineTurnState(snapshot, isSubmitting);
    }
  }

  public exitOnlineMatch(): void {
    if (!this.initialized) return;
    this.onlineMode = false;
    this.onlineMyUserId = null;
    this.onlineCanDrag = false;
    this.onlineMatchId = null;
    this.onlineLastReplayedEventId = null;
    this.onlineLatestSnapshot = null;
    this.onlineOnSubmitShot = null;
    this.onlineOnReplayStateChange?.(false);
    this.onlineOnReplayStateChange = null;
    this.onlineReplay = null;

    this.tableEnv.setArena(this.settings.arenaId);
    this.sceneManager.setArenaAtmosphere(this.settings.arenaId);
    this.returnToMenu();
  }

  private canonicalToClientPose(pose: CanonicalPose): BodyPose {
    if (this.arenaOrientation === 'horizontal') {
      return {
        pos: { ...pose.pos },
        rot: { ...pose.rot },
        linvel: { ...pose.linvel },
        angvel: { ...pose.angvel },
      };
    }
    this._tmpQ1.set(pose.rot.x, pose.rot.y, pose.rot.z, pose.rot.w).premultiply(this._qVertDelta);
    return {
      pos: { x: pose.pos.z, y: pose.pos.y, z: -pose.pos.x },
      rot: { x: this._tmpQ1.x, y: this._tmpQ1.y, z: this._tmpQ1.z, w: this._tmpQ1.w },
      linvel: { x: pose.linvel.z, y: pose.linvel.y, z: -pose.linvel.x },
      angvel: { x: pose.angvel.z, y: pose.angvel.y, z: -pose.angvel.x },
    };
  }

  private canonicalTupleToClient(
    tuple: CompactPoseTuple,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion
  ): void {
    if (this.arenaOrientation === 'horizontal') {
      outPos.set(tuple[0], tuple[1], tuple[2]);
      outQuat.set(tuple[3], tuple[4], tuple[5], tuple[6]);
      return;
    }
    outPos.set(tuple[2], tuple[1], -tuple[0]);
    outQuat.set(tuple[3], tuple[4], tuple[5], tuple[6]).premultiply(this._qVertDelta);
  }

  private clientPointToVector3(pt: [number, number, number]): THREE.Vector3 {
    if (this.arenaOrientation === 'horizontal') {
      return new THREE.Vector3(pt[0], pt[1], pt[2]);
    }
    return new THREE.Vector3(pt[2], pt[1], -pt[0]);
  }

  private clientDirToCanonical(dirX: number, dirZ: number): { dirX: number; dirZ: number } {
    if (this.arenaOrientation === 'horizontal') {
      return { dirX, dirZ };
    }
    return { dirX: -dirZ, dirZ: dirX };
  }

  private applyOnlinePenPoses(snapshot: RoomSnapshot): void {
    if (!snapshot.matchState) return;
    const p1Pose = this.canonicalToClientPose(snapshot.matchState.penStates.player1.pose);
    const p2Pose = this.canonicalToClientPose(snapshot.matchState.penStates.player2.pose);
    this.physics.setBodyPose('blue_1', p1Pose);
    this.physics.setBodyPose('red_1', p2Pose);
    this.syncVisualTransforms();
  }

  private applyOnlineTurnState(snapshot: RoomSnapshot, isSubmitting: boolean): void {
    const match = snapshot.match;
    if (!match) return;

    const isMyTurn =
      match.status === 'ACTIVE' && match.currentTurnUid === this.onlineMyUserId;
    this.onlineCanDrag = isMyTurn && !isSubmitting;

    const p1Model = this.penModels.get('blue_1');
    const p2Model = this.penModels.get('red_1');
    if (p1Model && p2Model) {
      if (match.status === 'ACTIVE') {
        p1Model.setHighlight(
          match.currentTurnUid === match.player1Uid ? 0.35 : 0,
          0x60a5fa
        );
        p2Model.setHighlight(
          match.currentTurnUid === match.player2Uid ? 0.35 : 0,
          0xfb7185
        );
      } else {
        p1Model.setHighlight(0);
        p2Model.setHighlight(0);
      }
    }

    if (match.status === 'COMPLETED' && !this.onlineReplay) {
      if (match.winnerUid === this.onlineMyUserId) {
        this.audio.playVictory();
        this.particles.spawnConfetti(new THREE.Vector3(0, 1.8, 0));
      } else if (match.winnerUid) {
        this.audio.playDefeat();
      }
    }

    this.state.update({
      matchState:
        match.status === 'COMPLETED'
          ? 'MATCH_OVER'
          : isMyTurn && !isSubmitting
            ? 'PLAYER_TURN'
            : 'SHOT_IN_PROGRESS',
      activeTurn: match.currentTurnUid === match.player1Uid ? 'blue_1' : 'red_1',
      multiplayer: null,
      gameMode: '1v1',
    });
  }

  private startOnlineShotReplay(shot: ResolvedShotSummary, targetSnapshot: RoomSnapshot): void {
    this.dragController.cancelDrag();
    this.onlineCanDrag = false;

    const shooterModelId = shot.shooterSlot === 1 ? 'blue_1' : 'red_1';
    this.penModels.get(shooterModelId)?.setHighlight(0);
    if (shot.shooterSlot !== this.onlineMySlot) {
      this.audio.playRelease(shot.powerPct / 100);
    }

    const duration =
      shot.keyframes.length > 0
        ? Math.max(shot.durationSeconds, shot.keyframes[shot.keyframes.length - 1].t)
        : shot.durationSeconds;

    this.onlineReplay = {
      keyframes: shot.keyframes,
      collisions: shot.collisions,
      elapsed: 0,
      duration,
      nextColIdx: 0,
      targetSnapshot,
      shooterSlot: shot.shooterSlot,
    };
    this.onlineOnReplayStateChange?.(true);

    this.state.update({
      matchState: 'SHOT_IN_PROGRESS',
    });
  }

  private advanceOnlineReplay(dt: number): void {
    const replay = this.onlineReplay;
    if (!replay) return;

    replay.elapsed += dt;
    const t = Math.min(replay.elapsed, replay.duration);
    const kfs = replay.keyframes;

    if (kfs.length > 0) {
      let idx = 0;
      while (idx < kfs.length - 2 && kfs[idx + 1].t <= t) {
        idx += 1;
      }
      const a = kfs[idx];
      const b = kfs[Math.min(idx + 1, kfs.length - 1)];
      const span = Math.max(1e-5, b.t - a.t);
      const alpha = b === a ? 0 : THREE.MathUtils.clamp((t - a.t) / span, 0, 1);

      const { halfW, halfD } = this.physics.getArenaBounds();
      const applyInterp = (
        id: 'blue_1' | 'red_1',
        ta: CompactPoseTuple,
        tb: CompactPoseTuple
      ) => {
        this.canonicalTupleToClient(ta, this._tmpV1, this._tmpQ1);
        this.canonicalTupleToClient(tb, this._tmpV2, this._tmpQ2);
        this._tmpV1.lerp(this._tmpV2, alpha);
        this._tmpQ1.slerp(this._tmpQ2, alpha);
        const model = this.penModels.get(id);
        model?.syncTransform(
          { x: this._tmpV1.x, y: this._tmpV1.y, z: this._tmpV1.z },
          { x: this._tmpQ1.x, y: this._tmpQ1.y, z: this._tmpQ1.z, w: this._tmpQ1.w },
          halfW,
          halfD
        );
        this.physics.setBodyPose(id, {
          pos: { x: this._tmpV1.x, y: this._tmpV1.y, z: this._tmpV1.z },
          rot: { x: this._tmpQ1.x, y: this._tmpQ1.y, z: this._tmpQ1.z, w: this._tmpQ1.w },
          linvel: { x: 0, y: 0, z: 0 },
          angvel: { x: 0, y: 0, z: 0 },
        });
      };

      applyInterp('blue_1', a.p1, b.p1);
      applyInterp('red_1', a.p2, b.p2);
    }

    while (
      replay.nextColIdx < replay.collisions.length &&
      replay.collisions[replay.nextColIdx].t <= t
    ) {
      const col = replay.collisions[replay.nextColIdx++];
      const pt = this.clientPointToVector3(col.point);
      if (col.fallenSlot) {
        this.audio.playFall(col.speed);
        const color = col.fallenSlot === 2 ? 0xf87171 : 0x60a5fa;
        this.particles.spawnBurst(new THREE.Vector3(pt.x, 0.1, pt.z), 16, color, 4.0);
      } else if (col.kind === 'pen') {
        this.audio.playPenCollision(col.speed);
        this.particles.spawnCollisionBurst(pt, new THREE.Vector3(0, 1, 0), col.speed);
        if (this.motionEnabled && col.speed > 4.5) {
          this.cameraManager.addShake(Math.min(0.28, col.speed * 0.02));
        }
      } else {
        this.audio.playTableImpact(col.speed, col.kind);
        if (col.kind === 'table' && col.speed > 2.8) {
          this.particles.spawnBurst(pt, 5, 0xe7d3b5, 2.2);
        }
      }
    }

    if (replay.elapsed >= replay.duration) {
      const latest = this.onlineLatestSnapshot ?? replay.targetSnapshot;
      this.onlineReplay = null;
      this.onlineOnReplayStateChange?.(false);
      this.applyOnlinePenPoses(latest);
      this.applyOnlineTurnState(latest, false);
    }
  }

  public returnToMenu(): void {
    if (!this.initialized) return;
    const wasMultiplayer = Boolean(this.turnManager?.getMultiplayerConfig());
    const hadOnlineIds = this.penModels.has('blue_1') || this.penModels.has('red_1');
    this.onlineMode = false;
    this.onlineReplay = null;
    this.onlineCanDrag = false;
    this.onlineOnSubmitShot = null;
    this.onlineOnReplayStateChange = null;
    this.currentMatchConfig = null;
    this.dragController.cancelDrag();
    this.aiController.cancel();

    if (wasMultiplayer || hadOnlineIds || !this.penModels.has('player') || this.penModels.size > 2) {
      for (const model of this.penModels.values()) {
        this.sceneManager.scene.remove(model.group);
        this.sceneManager.scene.remove(model.contactShadow);
        model.dispose();
      }
      this.penModels.clear();
      this.penTypes.clear();

      this.penTypes.set('player', this.settings.playerPenType);
      this.penTypes.set('bot', BOT_PEN_TYPE);

      const pModel = new PenModel(
        'player',
        this.sceneManager.maxAnisotropy,
        this.settings.playerPenType,
        'blue',
        'team_default',
        this.settings.deshiVariant
      );
      const bModel = new PenModel('bot', this.sceneManager.maxAnisotropy, BOT_PEN_TYPE, 'red');
      this.sceneManager.scene.add(pModel.group, pModel.contactShadow, bModel.group, bModel.contactShadow);
      this.penModels.set('player', pModel);
      this.penModels.set('bot', bModel);
      this.playerPen = pModel;
      this.botPen = bModel;
      this.dragController.setActivePen('player', pModel);
    }

    this.turnManager.returnToMenu(this.settings.playerPenType, BOT_PEN_TYPE);
    this.abilitySystem.reset(['player', 'bot']);
    this.trailSystem.reset();
    this.aimController.setAbilityPreview(null);
    this.abilityPreviewActive = false;
    for (const model of this.penModels.values()) {
      model.setHighlight(0);
    }
    this.cameraManager.setMenuMode(true);
    this.sceneManager.requestShadowUpdate();
    this.syncVisualTransforms();
  }

  public applySettings(next: GameSettings): void {
    const penChanged = this.settings.playerPenType !== next.playerPenType;
    const deshiVariantChanged = this.settings.deshiVariant !== next.deshiVariant;
    const arenaChanged = this.settings.arenaId !== next.arenaId;
    const canSwitchArena = this.state.getSnapshot().matchState === 'MENU';
    const resolvedArenaId: ArenaId =
      arenaChanged && !canSwitchArena ? this.settings.arenaId : next.arenaId;
    this.settings = { ...next, arenaId: resolvedArenaId };
    this.audio.setSfxEnabled(next.sfxEnabled);
    this.audio.setMusicEnabled(next.musicEnabled);
    if (this.sceneManager && this.qualityController) {
      this.applyQualityProfile();
    }
    if (arenaChanged && canSwitchArena && this.tableEnv && this.sceneManager) {
      this.tableEnv.setArena(resolvedArenaId);
      this.sceneManager.setArenaAtmosphere(resolvedArenaId);
      this.sceneManager.requestShadowUpdate();
      if (!this.sceneManager.isSoftwareGl) {
        this.sceneManager.precompile(this.cameraManager.camera);
      }
    }
    const isMultiplayer = Boolean(this.turnManager?.getMultiplayerConfig());
    if (penChanged && this.physics && this.playerPen && !isMultiplayer) {
      this.penTypes.set('player', next.playerPenType);
      this.dragController?.cancelDrag();
      this.abilitySystem?.disarm('player');
      this.physics.setPenType('player', next.playerPenType);
      this.playerPen.setAppearance(next.playerPenType, 'blue', 'team_default', next.deshiVariant);
      // Rebuild the ability state: re-applies the new pen's passive to the freshly created rigid
      // body and clears any stale cooldown / active window carried over from the previous pen.
      this.abilitySystem?.reset(['player', 'bot']);
      this.applyAbilityPreview();
      this.state.updateAbility('player', this.abilitySystem.getState('player'));
      this.syncVisualTransforms();
      this.sceneManager.requestShadowUpdate();
      this.dragController?.emitTelemetry();
    } else if (deshiVariantChanged && this.playerPen && !isMultiplayer) {
      this.playerPen.setDeshiVariant(next.deshiVariant);
      this.sceneManager?.requestShadowUpdate();
    }
  }

  /**
   * Resolves the player's quality preference + per-feature ceilings into one concrete profile and
   * pushes it to every rendering subsystem. Called on settings changes and whenever AUTO mode
   * moves a tier, so it must stay cheap and idempotent — each subsystem diffs internally.
   */
  private applyQualityProfile(): void {
    const profile = this.qualityController.resolve(this.settings);
    this.sceneManager.applyProfile(profile);
    this.particles?.setQuality(profile.particles);
    this.trailSystem?.setQuality(profile.particles);
    this.motionEnabled = profile.motion;
    if (!profile.motion) {
      this.cameraManager?.setShotFocus(null);
    }
    this.monitor.latest.quality = this.qualityController.label(this.settings.graphicsQuality);
  }

  /**
   * Copies each pen's rigid-body transform onto its visual model. Returns the poses it read so
   * the caller can reuse them (edge warnings, camera) instead of paying for a second poll of the
   * physics world in the same frame.
   */
  private syncVisualTransforms(): { player: BodyPose; bot: BodyPose } {
    const { halfW, halfD } = this.physics.getArenaBounds();
    for (const [id, model] of this.penModels.entries()) {
      const pose = this.physics.getPose(id);
      model.syncTransform(pose.pos, pose.rot, halfW, halfD);
    }
    const playerPose = this.physics.getPose(
      this.penModels.has('player') ? 'player' : this.turnManager?.getActivePlayerId() ?? 'blue_1'
    );
    const botPose = this.physics.getPose(this.penModels.has('bot') ? 'bot' : 'red_1');
    return { player: playerPose, bot: botPose };
  }

  /**
   * Feeds the pooled Special Shot trails from each pen's writing tip while its shot is running,
   * dissolves them when it ends, and eases the camera to follow the acting pen. Pure visuals —
   * no physics state is touched here.
   */
  private updateAbilityVisuals(dt: number): void {
    let focusId: PlayerId | null = null;
    for (const id of this.penModels.keys()) {
      if (this.abilitySystem.isActive(id)) {
        const pose = this.physics.getPose(id);
        const fwd = this.physics.getForwardAxis(id);
        const spec = this.physics.getPenSpec(id);
        const halfLen = (spec?.length ?? 3.2) * 0.5;
        this.trailTip.set(
          pose.pos.x + fwd.x * halfLen,
          Math.max(0.05, pose.pos.y),
          pose.pos.z + fwd.z * halfLen
        );
        const color = this.abilitySystem.getActiveColor(id) ?? 0xffffff;
        this.trailSystem.push(id, this.trailTip.x, this.trailTip.y, this.trailTip.z, color);
        if (focusId === null) {
          focusId = id;
          this.shotFocus.set(pose.pos.x, pose.pos.y, pose.pos.z);
        }
      } else {
        this.trailSystem.end(id);
      }
    }
    this.trailSystem.update(dt);
    this.cameraManager.setShotFocus(this.motionEnabled && focusId ? this.shotFocus : null);
  }

  private tick = (frameTime?: number): void => {
    if (this.disposed) return;
    const tickStart = performance.now();
    // rAF hands us a real frame timestamp; the software-GL timeout path has none.
    const now = typeof frameTime === 'number' ? frameTime : tickStart;

    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);

    if (this.onlineMode) {
      this.monitor.latest.physicsMs = 0;
      if (this.onlineReplay) {
        this.advanceOnlineReplay(dt);
      } else {
        const poses = this.syncVisualTransforms();
        void poses;
      }

      const bPose = this.physics.getPose('blue_1');
      const rPose = this.physics.getPose('red_1');
      this.tableEnv.updateEdgeWarningPens(
        [
          { pos: bPose.pos, level: this.physics.getEdgeProximity('blue_1').level },
          { pos: rPose.pos, level: this.physics.getEdgeProximity('red_1').level },
        ],
        now
      );

      const dragView = this.dragController.getStateView();
      if (this.onlineCanDrag && !this.onlineReplay && !dragView.isDragging) {
        const myId = this.onlineMySlot === 1 ? 'blue_1' : 'red_1';
        const myModel = this.penModels.get(myId);
        if (myModel) {
          const pulse = 0.28 + 0.2 * (0.5 + 0.5 * Math.sin(now * 0.0065));
          const teamColor = myModel.team === 'red' ? 0xfb7185 : 0x60a5fa;
          myModel.setHighlight(pulse, teamColor);
        }
      }
      this.aimController.update(dragView);
      if (dragView.isDragging) {
        this.telemetryTimer += dt;
        if (this.telemetryTimer >= 0.045) {
          this.telemetryTimer = 0;
          this.dragController.emitTelemetry();
        }
      } else {
        this.telemetryTimer = 0;
      }
      this.particles.update(dt);
      this.cameraManager.update(dt);
      if (dragView.isDragging || Boolean(this.onlineReplay)) {
        this.sceneManager.requestShadowUpdate();
      }
    } else {
      if (this.hitstopTimer > 0) {
        this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
      } else {
        // Advance physics simulation (fixed-timestep accumulator lives inside PhysicsManager)
        const physicsStart = performance.now();
        this.physics.step(
          dt,
          (substepDt) => {
            this.dragController.applySubstepForce(substepDt);
            this.aiController.applySubstepForce();
            this.abilitySystem.onSubstep(substepDt);
          },
          {
            onPenPenImpact: (point, normal, speed, penA, penB) => {
              this.audio.playPenCollision(speed);
              if (penA && penB) {
                this.turnManager.recordPenContact(penA, penB, speed);
                if (this.abilitySystem.onImpact(penA, point, speed)) {
                  this.spawnShockwaveFeedback(penA, point);
                }
                if (this.abilitySystem.onImpact(penB, point, speed)) {
                  this.spawnShockwaveFeedback(penB, point);
                }
              } else {
                if (this.abilitySystem.onImpact('player', point, speed)) {
                  this.spawnShockwaveFeedback('player', point);
                }
                if (this.abilitySystem.onImpact('bot', point, speed)) {
                  this.spawnShockwaveFeedback('bot', point);
                }
              }
              // Accumulate instead of emitting a React snapshot per impact — the counter is
              // flushed at the 4 Hz diagnostics cadence, so a pile-up of collisions stays cheap.
              this.pendingCollisions += 1;
              this.particles.spawnCollisionBurst(point, normal, speed);
              if (this.motionEnabled && speed > 4.5) {
                this.cameraManager.addShake(Math.min(0.28, speed * 0.02));
                this.hitstopTimer = 0.036; // Crisp 36ms impact hitstop
              }
            },
            onPenTableImpact: (_penId, surface, point, speed) => {
              this.audio.playTableImpact(speed, surface);
              if (surface === 'table' && speed > 2.8) {
                this.particles.spawnBurst(point, 5, 0xe7d3b5, 2.2);
              }
            },
          }
        );
        this.monitor.latest.physicsMs = performance.now() - physicsStart;

        this.abilitySystem.update(dt);
        const activeId = this.turnManager?.getActivePlayerId() ?? 'player';
        if (this.abilitySystem.isArmed(activeId) && !this.abilitySystem.canActivate(activeId)) {
          this.abilitySystem.disarm(activeId);
        }
        this.applyAbilityPreview();
        this.dragController.setInputSteadying(this.abilitySystem.getSteadying(activeId));
        for (const id of this.penModels.keys()) {
          this.state.updateAbility(id, this.abilitySystem.getState(id));
        }

        this.aiController.update(dt);
        this.turnManager.update(dt);
      }

      this.updateAbilityVisuals(dt);
      // One physics poll per frame: the poses read here are reused for the edge-warning visuals.
      const poses = this.syncVisualTransforms();
      const snap = this.state.getSnapshot();
      if (snap.multiplayer) {
        const mpPens = snap.multiplayer.players
          .filter((p) => !p.isEliminated)
          .map((p) => ({
            pos: this.physics.getPose(p.id).pos,
            level: this.physics.getEdgeProximity(p.id).level,
          }));
        this.tableEnv.updateEdgeWarningPens(mpPens, now);
      } else {
        this.tableEnv.updateEdgeWarning(
          poses.player.pos,
          poses.bot.pos,
          snap.edgeWarning.player,
          snap.edgeWarning.bot,
          now
        );
      }

      const dragView = this.dragController.getStateView();
      if (snap.matchState === 'PLAYER_TURN' && !dragView.isDragging) {
        const activeId = this.turnManager.getActivePlayerId();
        const activeModel = this.penModels.get(activeId);
        if (activeModel) {
          const pulse = 0.28 + 0.2 * (0.5 + 0.5 * Math.sin(now * 0.0065));
          const teamColor = activeModel.team === 'red' ? 0xfb7185 : 0x60a5fa;
          activeModel.setHighlight(pulse, teamColor);
        }
      }
      this.aimController.update(dragView);
      if (dragView.isDragging) {
        this.telemetryTimer += dt;
        if (this.telemetryTimer >= 0.045) {
          this.telemetryTimer = 0;
          this.dragController.emitTelemetry();
        }
      } else {
        this.telemetryTimer = 0;
      }
      this.particles.update(dt);
      this.cameraManager.update(dt);

      // On-demand dynamic shadows: request shadow map pass only when objects are moving or active
      const dragActive = dragView.isDragging;
      const pensSettled = this.physics ? this.physics.arePensSettled(0.03, 0.06) : true;
      if (dragActive || !pensSettled || this.hitstopTimer > 0) {
        this.sceneManager.requestShadowUpdate();
      }
    }

    this.sceneManager.render(this.cameraManager.camera);

    // ---- Performance telemetry & adaptive quality (never re-renders React per frame) --------
    const renderStats = this.sceneManager.getRenderStats();
    this.monitor.latest.drawCalls = renderStats.calls;
    this.monitor.latest.triangles = renderStats.triangles;
    const res = this.sceneManager.getRenderResolution();
    this.monitor.latest.resolution = `${res.width}x${res.height} (${Math.round(res.scale * 100)}%)`;
    this.monitor.latest.cpuMs = performance.now() - tickStart;

    this.statsTimer += rawDt;
    if (this.statsTimer >= 0.25) {
      this.statsTimer = 0;
      // Rigid-body / collider counts are polled at the panel's own cadence, not per frame.
      const physStats = this.physics.getStats();
      this.monitor.latest.bodies = physStats.bodies;
      this.monitor.latest.colliders = physStats.colliders;
      this.monitor.latest.awakeBodies = physStats.awakeBodies;
      if (this.pendingCollisions > 0) {
        const prev = this.state.getSnapshot().stats;
        this.state.update({
          stats: { ...prev, collisions: prev.collisions + this.pendingCollisions },
        });
        this.pendingCollisions = 0;
      }
    }

    // Publishing happens inside frame(); the stats above are therefore sampled with this frame.
    this.monitor.frame(now);

    if (this.monitor.hasSamples) {
      const changed = this.qualityController.updateAdvanced(
        dt,
        this.monitor.latest.avgFps,
        this.monitor.latest.frameMs,
        this.monitor.latest.physicsMs,
        this.settings.graphicsQuality === 'AUTO'
      );
      if (changed) {
        this.applyQualityProfile();
      }
    }

    if (this.sceneManager.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  /**
   * Software-GL path: wait for the GPU to actually finish the frame before queueing the next one.
   * Keeps CPU work off the software rasteriser's back instead of stacking frames it cannot clear.
   */
  private afterDraw(cb: (frameTime?: number) => void): void {
    if (this.suspended) return;
    const gl = this.sceneManager.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || !gl.fenceSync) {
      this.timeoutId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed || this.suspended) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (state === gl.UNSIGNALED) {
        this.timeoutId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.timeoutId = window.setTimeout(cb, 80);
      }
    };
    this.timeoutId = window.setTimeout(poll, 5);
  }

  /**
   * Halts the render/physics loop while a full-screen overlay (settings, help, pen selector) hides
   * the arena. The GPU and CPU are fully released, and the wall-clock gap is discarded on resume so
   * the first frame back is not treated as an enormous delta.
   */
  public setSuspended(suspended: boolean): void {
    if (!this.initialized || this.disposed || suspended === this.suspended) return;
    this.suspended = suspended;
    this.turnManager?.setPaused(suspended);
    if (suspended) {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = 0;
      }
      this.monitor.latest.physicsMs = 0;
      return;
    }
    this.clock.getDelta(); // discard the paused gap
    this.tick();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.handleViewportResize);
    window.removeEventListener('orientationchange', this.handleOrientationChange);

    if (this.initialized) {
      this.dragController.dispose();
      this.aimController.dispose();
      this.tableEnv.dispose();
      for (const model of this.penModels.values()) {
        model.dispose();
      }
      this.penModels.clear();
      this.particles.dispose();
      this.trailSystem.dispose();
      this.physics.dispose();
      this.sceneManager.dispose();
    }
    this.audio.dispose();
  }
}
