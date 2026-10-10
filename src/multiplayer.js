import { Peer } from './core.js';
import { useGame } from './store.js';

// multiplayer.js - optional 2-player peer-to-peer link via PeerJS
// (uses PeerJS's free public broker only to help the two devices find
// each other; gameplay data flows directly between the two browsers)
// ============================================================
const MP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function randomMpCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += MP_CODE_CHARS[Math.floor(Math.random() * MP_CODE_CHARS.length)];
  return code;
}

// Live connection objects (not React state - these are imperative singletons).
const mpState = { peer: null, conn: null };

// Latest known state of the other player, read every frame by RemotePlayer.
// position/yaw are interpolation targets; lerped toward in useFrame.
const remotePlayer = {
  active: false,
  position: [0, 1, 8],
  yaw: 0,
  moving: false,
  sprinting: false,
  crouching: false,
  equippedWeaponId: null,
  attackSeq: 0,
};

// ---- shared rival-tribe-camp state (host is authoritative) ----
// Host: populated each frame by TribeMember's wander AI, broadcast periodically.
const tribeMemberSyncData = {}; // { [memberId]: { position: [x,y,z], yaw } }
// Joiner: latest positions received from the host, lerped toward each frame.
const remoteTribeMembers = {}; // { [memberId]: { position: [x,y,z], yaw } }

function mpSetupConnection(conn) {
  mpState.conn = conn;
  conn.on('open', () => {
    useGame.getState().setMpStatus('connected');
    remotePlayer.active = true;
  });
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'state') {
      remotePlayer.position = msg.position;
      remotePlayer.yaw = msg.yaw;
      remotePlayer.moving = msg.moving;
      remotePlayer.sprinting = msg.sprinting;
      remotePlayer.crouching = msg.crouching;
      remotePlayer.equippedWeaponId = msg.equippedWeaponId;
    } else if (msg.t === 'attack') {
      remotePlayer.attackSeq++;
    } else if (msg.t === 'tribeSync') {
      Object.assign(remoteTribeMembers, msg.members);
      const gs = useGame.getState();
      gs.setTribeMemberState(msg.tribeMemberState);
      gs.setCapturedTribes(msg.capturedTribes);
      gs.setActiveTribeIds(msg.activeTribeIds);
      if (gs.mpRole === 'joiner') {
        if (msg.raid && !gs.raid) gs.addToast(`⚠️ ${msg.raid.tribeName} is raiding!`);
        else if (!msg.raid && gs.raid) gs.addToast(`${gs.raid.tribeName} retreats!`);
        gs.setRaid(msg.raid ?? null);
        if (msg.distantRaid && !gs.distantRaid) gs.addToast(`🏔️ ${msg.distantRaid.tribeName} is marching on you!`);
        else if (!msg.distantRaid && gs.distantRaid) gs.addToast(`${gs.distantRaid.tribeName} retreats!`);
        gs.setDistantRaid(msg.distantRaid ?? null);
        if (msg.interTribalRaid && !gs.interTribalRaid) gs.addToast(`${msg.interTribalRaid.attackerName} raids ${msg.interTribalRaid.targetName}!`);
        gs.setInterTribalRaid(msg.interTribalRaid ?? null);
      }
    } else if (msg.t === 'tribeDamage') {
      if (useGame.getState().mpRole === 'host') {
        useGame.getState().damageTribeMember(msg.id, msg.dmg);
      }
    } else if (msg.t === 'chat') {
      useGame.getState().addChatMessage('friend', msg.text);
    }
  });
  const onClose = () => {
    remotePlayer.active = false;
    if (mpState.conn === conn) {
      mpState.conn = null;
      useGame.getState().setMpStatus('offline');
      useGame.getState().setMpRole(null);
    }
  };
  conn.on('close', onClose);
  conn.on('error', onClose);
}

function mpHost() {
  mpDisconnect();
  const code = randomMpCode();
  const peer = new Peer(`jungleking-${code}`);
  mpState.peer = peer;
  useGame.getState().setMpStatus('hosting');
  useGame.getState().setMpCode(code);
  useGame.getState().setMpError(null);
  useGame.getState().setMpRole('host');
  peer.on('connection', (conn) => mpSetupConnection(conn));
  peer.on('error', (err) => {
    useGame.getState().setMpError(err && err.type === 'unavailable-id'
      ? 'That code is in use, try hosting again for a new one.'
      : 'Connection error: ' + (err && err.type || 'unknown'));
    useGame.getState().setMpStatus('offline');
  });
}

function mpJoin(code) {
  mpDisconnect();
  const peer = new Peer();
  mpState.peer = peer;
  useGame.getState().setMpStatus('connecting');
  useGame.getState().setMpError(null);
  useGame.getState().setMpRole('joiner');
  peer.on('open', () => {
    const conn = peer.connect(`jungleking-${code.trim().toUpperCase()}`);
    mpSetupConnection(conn);
  });
  peer.on('error', (err) => {
    useGame.getState().setMpError(err && err.type === 'peer-unavailable'
      ? 'No game found with that code.'
      : 'Connection error: ' + (err && err.type || 'unknown'));
    useGame.getState().setMpStatus('offline');
  });
}

function mpDisconnect() {
  if (mpState.conn) { try { mpState.conn.close(); } catch (e) {} }
  if (mpState.peer) { try { mpState.peer.destroy(); } catch (e) {} }
  mpState.conn = null;
  mpState.peer = null;
  remotePlayer.active = false;
  useGame.getState().setMpStatus('offline');
  useGame.getState().setMpCode('');
  useGame.getState().setMpRole(null);
}

function mpSend(msg) {
  if (mpState.conn && mpState.conn.open) {
    try { mpState.conn.send(msg); } catch (e) {}
  }
}

// Lazily-created shared audio context for tiny procedural sound effects
// (no audio assets in this project - everything is synthesized).
let sharedAudioCtx = null;
function playChingSound() {
  try {
    if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = sharedAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [2200, 3300].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.22 / (i + 1), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    });
  } catch (err) {
    // Audio not available - ignore.
  }
}

// Shared mutable player transform, updated every frame by Player.js.
// Avoids putting per-frame position data into the zustand store.
const playerTransform = { position: [0, 0, 8], yaw: 0 };

// ============================================================

export {
  MP_CODE_CHARS,
  randomMpCode,
  mpState,
  remotePlayer,
  tribeMemberSyncData,
  remoteTribeMembers,
  mpSetupConnection,
  mpHost,
  mpJoin,
  mpDisconnect,
  mpSend,
  sharedAudioCtx,
  playChingSound,
  playerTransform,
};
