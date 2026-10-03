// Format pliku projektu .mzt (ZIP):
//   project.json        — metadane projektu (wersja web)
//   project.dat         — (tylko pliki z Androida) ProjectSaveData zapisane przez Java ObjectOutputStream
//   <clipId>_A.pcm      — PCM 16-bit LE mono 44.1 kHz (profil A)
//   <clipId>_B.pcm      — PCM profilu B (opcjonalnie)
import { createZip, readZip } from "../zip.js";
import { parseJavaSerialized, toList, uuidToString, JavaObject } from "../javaser.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function pcmToBytes(pcm) {
  const out = new Uint8Array(pcm.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) v.setInt16(i * 2, pcm[i], true);
  return out;
}

function bytesToPcm(bytes) {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true);
  return out;
}

export function encodeProject(p) {
  const meta = {
    format: "muzart-web",
    version: 1,
    name: p.name,
    tracks: p.tracks.map((t) => ({ id: t.id, name: t.name })),
    // Jak w Androidzie: zapisujemy przetworzone wycinki, a przycinanie resetujemy (wycinek staje się nową bazą).
    clips: p.clips.map((c) => ({
      id: c.id, trackId: c.trackId, audioSourceId: c.audioSourceId,
      startBeat: c.startBeat, durationBeats: c.durationBeats,
      eqBands: Array.from(c.eqBands), trimStart: 0, trimEnd: 1, delayMs: c.delayMs, speedFactor: c.speedFactor,
      isMuted: c.isMuted, linkedMarkerId: c.linkedMarkerId, linkedMarkerAction: c.linkedMarkerAction,
      altEqBands: Array.from(c.altEqBands), linkedEqMarkerId: c.linkedEqMarkerId, activeEqProfile: c.activeEqProfile,
    })),
    bpm: p.bpm,
    masterVolume: p.masterVolume,
    secondaryVolume: p.secondaryVolume,
    loopMarkers: p.loopMarkers.map((m) => ({ ...m })),
    starterMarkers: p.starterMarkers.map((m) => ({ ...m })),
  };
  const files = [{ name: "project.json", data: enc.encode(JSON.stringify(meta)) }];
  for (const c of p.clips) {
    if (c.pcmData) files.push({ name: `${c.id}_A.pcm`, data: pcmToBytes(c.pcmData) });
    if (c.altPcmData) files.push({ name: `${c.id}_B.pcm`, data: pcmToBytes(c.altPcmData) });
  }
  return createZip(files);
}

/** @returns {Promise<{name, tracks, clips, bpm, masterVolume, secondaryVolume, loopMarkers, starterMarkers}>} */
export async function decodeProject(blobOrFile) {
  const entries = await readZip(blobOrFile);
  let meta;
  if (entries.has("project.json")) meta = JSON.parse(dec.decode(entries.get("project.json")));
  else if (entries.has("project.dat")) meta = fromAndroid(parseJavaSerialized(entries.get("project.dat")));
  else throw new Error("Missing project metadata");

  const clips = meta.clips.map((c) => {
    const a = entries.get(`${c.id}_A.pcm`);
    const b = entries.get(`${c.id}_B.pcm`);
    return { ...c, pcmData: a ? bytesToPcm(a) : null, altPcmData: b ? bytesToPcm(b) : null };
  });
  return {
    name: meta.name || "Projekt",
    tracks: meta.tracks,
    clips,
    bpm: meta.bpm || 120,
    masterVolume: meta.masterVolume ?? 1,
    secondaryVolume: meta.secondaryVolume ?? 1,
    loopMarkers: (meta.loopMarkers || []).map((m) => ({ ...m, currentLoops: m.currentLoops || 0 })),
    starterMarkers: (meta.starterMarkers || []).map((m) => ({ ...m, currentLoops: m.currentLoops || 0 })),
  };
}

// ---- Konwersja ProjectSaveData (Kotlin/Java) -> struktura web ----

const num = (v, d = 0) => (v == null ? d : typeof v === "bigint" ? Number(v) : Number(v));
const arr5 = (v) => {
  const a = v ? Array.from(v) : [];
  return a.length >= 5 ? a.slice(0, 5) : [1, 1, 1, 1, 1];
};

function fromAndroid(root) {
  if (!(root instanceof JavaObject)) throw new Error("Unexpected project.dat content");
  const f = root.fields;
  const marker = (m) => ({
    id: uuidToString(m.fields.id),
    beat: num(m.fields.beat),
    maxLoops: num(m.fields.maxLoops, -1),
    currentLoops: 0,
  });
  return {
    name: f.name,
    tracks: toList(f.tracks).map((tr) => ({ id: uuidToString(tr.fields.id), name: tr.fields.name })),
    clips: toList(f.clips).map((c) => {
      const x = c.fields;
      return {
        id: uuidToString(x.id),
        trackId: uuidToString(x.trackId),
        audioSourceId: x.audioSourceId || "",
        startBeat: num(x.startBeat),
        durationBeats: num(x.durationBeats, 1),
        eqBands: arr5(x.eqBands),
        trimStart: num(x.trimStart, 0),
        trimEnd: num(x.trimEnd, 1),
        delayMs: num(x.delayMs, 0),
        speedFactor: num(x.speedFactor, 1),
        isMuted: !!x.isMuted,
        linkedMarkerId: uuidToString(x.linkedMarkerId),
        linkedMarkerAction: x.linkedMarkerAction || "TOGGLE",
        altEqBands: arr5(x.altEqBands),
        linkedEqMarkerId: uuidToString(x.linkedEqMarkerId),
        activeEqProfile: x.activeEqProfile || "A",
      };
    }),
    bpm: num(f.bpm, 120),
    masterVolume: num(f.masterVolume, 1),
    secondaryVolume: num(f.secondaryVolume, 1),
    loopMarkers: toList(f.loopMarkers).map(marker),
    starterMarkers: toList(f.starterMarkers).map(marker),
  };
}
