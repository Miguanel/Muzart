// Minimalny parser Java Object Serialization Stream (tylko odczyt).
// Pozwala importować pliki .mzt zapisane przez aplikację Muzart na Androida,
// w których "project.dat" to obiekt ProjectSaveData zapisany przez ObjectOutputStream.

const TC = {
  NULL: 0x70, REFERENCE: 0x71, CLASSDESC: 0x72, OBJECT: 0x73, STRING: 0x74, ARRAY: 0x75,
  CLASS: 0x76, BLOCKDATA: 0x77, ENDBLOCKDATA: 0x78, RESET: 0x79, BLOCKDATALONG: 0x7a,
  EXCEPTION: 0x7b, LONGSTRING: 0x7c, PROXYCLASSDESC: 0x7d, ENUM: 0x7e,
};
const BASE_HANDLE = 0x7e0000;
const SC_WRITE_METHOD = 0x01;
const SC_SERIALIZABLE = 0x02;
const SC_EXTERNALIZABLE = 0x04;
const SC_BLOCK_DATA = 0x08;

export class JavaObject {
  constructor(className) {
    this.__class = className;
    this.fields = {};
    this.annotations = []; // dane zapisane przez writeObject()
  }
}

export function parseJavaSerialized(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 0;
  const handles = [];

  const u1 = () => u8[pos++];
  const s1 = () => { const v = view.getInt8(pos); pos += 1; return v; };
  const u2 = () => { const v = view.getUint16(pos); pos += 2; return v; };
  const s2 = () => { const v = view.getInt16(pos); pos += 2; return v; };
  const s4 = () => { const v = view.getInt32(pos); pos += 4; return v; };
  const s8 = () => { const v = view.getBigInt64(pos); pos += 8; return v; };
  const f4 = () => { const v = view.getFloat32(pos); pos += 4; return v; };
  const f8 = () => { const v = view.getFloat64(pos); pos += 8; return v; };

  function utf(len) {
    // "Modified UTF-8" (Java)
    let s = "";
    const end = pos + len;
    while (pos < end) {
      const a = u8[pos++];
      if (a < 0x80) s += String.fromCharCode(a);
      else if ((a & 0xe0) === 0xc0) { const b = u8[pos++]; s += String.fromCharCode(((a & 0x1f) << 6) | (b & 0x3f)); }
      else { const b = u8[pos++], c = u8[pos++]; s += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f)); }
    }
    return s;
  }

  const newHandle = (obj) => { handles.push(obj); return handles.length - 1; };

  function readClassDesc() {
    const tc = u1();
    switch (tc) {
      case TC.NULL: return null;
      case TC.REFERENCE: return handles[s4() - BASE_HANDLE];
      case TC.CLASSDESC: {
        const desc = { name: utf(u2()), serialVersionUID: s8(), fields: [] };
        newHandle(desc);
        desc.flags = u1();
        const count = s2();
        for (let i = 0; i < count; i++) {
          const typeCode = String.fromCharCode(u1());
          const fname = utf(u2());
          let className = null;
          if (typeCode === "[" || typeCode === "L") className = readContent();
          desc.fields.push({ typeCode, name: fname, className });
        }
        desc.annotations = readAnnotations();
        desc.superDesc = readClassDesc();
        return desc;
      }
      case TC.PROXYCLASSDESC: {
        const desc = { name: "$Proxy", fields: [], flags: SC_SERIALIZABLE, proxy: true };
        newHandle(desc);
        const n = s4();
        for (let i = 0; i < n; i++) utf(u2());
        desc.annotations = readAnnotations();
        desc.superDesc = readClassDesc();
        return desc;
      }
      default:
        throw new Error(`Unexpected class desc tag 0x${tc.toString(16)} at ${pos - 1}`);
    }
  }

  function readAnnotations() {
    const out = [];
    for (;;) {
      const tc = u8[pos];
      if (tc === TC.ENDBLOCKDATA) { pos++; return out; }
      out.push(readContent());
    }
  }

  function readPrimitive(typeCode) {
    switch (typeCode) {
      case "B": return s1();
      case "C": return String.fromCharCode(u2());
      case "D": return f8();
      case "F": return f4();
      case "I": return s4();
      case "J": return s8();
      case "S": return s2();
      case "Z": return u1() !== 0;
      default: return readContent();
    }
  }

  function classChain(desc) {
    const chain = [];
    for (let d = desc; d; d = d.superDesc) chain.unshift(d);
    return chain;
  }

  function readObject() {
    const desc = readClassDesc();
    const obj = new JavaObject(desc?.name);
    newHandle(obj);
    for (const d of classChain(desc)) {
      if (d.flags & SC_EXTERNALIZABLE) {
        if (d.flags & SC_BLOCK_DATA) obj.annotations.push(...readAnnotations());
        else throw new Error("Externalizable without block data not supported: " + d.name);
        continue;
      }
      for (const f of d.fields) obj.fields[f.name] = readPrimitive(f.typeCode);
      if (d.flags & SC_WRITE_METHOD) obj.annotations.push(...readAnnotations());
    }
    return obj;
  }

  function readArray() {
    const desc = readClassDesc();
    const len = s4();
    const elemType = desc.name.charAt(1);
    let arr;
    switch (elemType) {
      case "F": arr = new Float32Array(len); for (let i = 0; i < len; i++) arr[i] = f4(); break;
      case "D": arr = new Float64Array(len); for (let i = 0; i < len; i++) arr[i] = f8(); break;
      case "S": arr = new Int16Array(len); for (let i = 0; i < len; i++) arr[i] = s2(); break;
      case "I": arr = new Int32Array(len); for (let i = 0; i < len; i++) arr[i] = s4(); break;
      case "B": arr = u8.slice(pos, pos + len); pos += len; break;
      default: arr = new Array(len);
    }
    const h = newHandle(arr);
    if (Array.isArray(arr)) for (let i = 0; i < len; i++) arr[i] = readPrimitive(elemType);
    handles[h] = arr;
    return arr;
  }

  function readContent() {
    const tc = u1();
    switch (tc) {
      case TC.NULL: return null;
      case TC.REFERENCE: return handles[s4() - BASE_HANDLE];
      case TC.STRING: { const s = utf(u2()); newHandle(s); return s; }
      case TC.LONGSTRING: { const n = Number(s8()); const s = utf(n); newHandle(s); return s; }
      case TC.OBJECT: return readObject();
      case TC.ARRAY: return readArray();
      case TC.CLASS: { const d = readClassDesc(); newHandle(d); return d; }
      case TC.ENUM: {
        const d = readClassDesc();
        const e = { __enum: d?.name };
        const h = newHandle(e);
        e.name = readContent();
        handles[h] = e;
        return e;
      }
      case TC.BLOCKDATA: { const n = u1(); const b = u8.slice(pos, pos + n); pos += n; return { __block: b }; }
      case TC.BLOCKDATALONG: { const n = s4(); const b = u8.slice(pos, pos + n); pos += n; return { __block: b }; }
      case TC.RESET: handles.length = 0; return readContent();
      case TC.CLASSDESC: case TC.PROXYCLASSDESC: pos--; return readClassDesc();
      default: throw new Error(`Unsupported tag 0x${tc.toString(16)} at ${pos - 1}`);
    }
  }

  if (u2() !== 0xaced) throw new Error("Not a Java serialization stream");
  u2(); // wersja
  return readContent();
}

/** Zamiana kolekcji Javy/Kotlina na tablicę JS. */
export function toList(v) {
  if (v == null) return [];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v);
  if (!(v instanceof JavaObject)) return [v];
  const cls = v.__class || "";
  if (cls.endsWith("EmptyList") || cls.endsWith("EmptySet")) return [];
  if (cls.includes("SingletonList") || cls.includes("SingletonSet")) return [v.fields.element];
  if (cls === "java.util.Arrays$ArrayList") return toList(v.fields.a);
  if ("size" in v.fields) {
    // ArrayList / LinkedList / ArrayDeque: elementy w adnotacjach (po bloku z pojemnością)
    return v.annotations.filter((x) => !(x && x.__block));
  }
  return v.annotations.filter((x) => !(x && x.__block));
}

export function uuidToString(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof JavaObject && v.__class === "java.util.UUID") {
    const hex = (b) => BigInt.asUintN(64, b).toString(16).padStart(16, "0");
    const s = hex(v.fields.mostSigBits) + hex(v.fields.leastSigBits);
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  return String(v);
}
