// HMAC pseudonymization with per-kind HKDF keys (SPEC.md section 10). Identical to pipelines/src/peoplevault/pseudo.py.
//   K_kind    = HKDF-SHA256(IKM = M, salt = "peoplevault/v1", info = "pv-pseudonym:" + kind, L = 32)
//   pseudonym = prefix + base32_lower_nopad(HMAC-SHA256(K_kind, "v1|" + employee_id))[0:26]

export type PseudonymKind = "warehouse_key" | "employee_ref" | "analytics_id" | "subject_ref";
export const PSEUDONYM_KINDS: readonly PseudonymKind[] = ["warehouse_key", "employee_ref", "analytics_id", "subject_ref"];
export const PSEUDONYM_PREFIX: Record<PseudonymKind, string> = {
  warehouse_key: "wk_",
  employee_ref: "er_",
  analytics_id: "an_",
  subject_ref: "sr_",
};
export const PSEUDONYM_PATTERN = /^(wk|er|an|sr)_[a-z2-7]{26}$/;

const SALT = "peoplevault/v1";
const INFO_PREFIX = "pv-pseudonym:";
const MESSAGE_PREFIX = "v1|";
const LENGTH = 26;
const enc = new TextEncoder();

export interface Pseudonymizer {
  pseudonym(kind: PseudonymKind, employeeId: string): Promise<string>;
  all(employeeId: string): Promise<Record<PseudonymKind, string>>;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function base32LowerNoPad(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 5869 HKDF-SHA256 via WebCrypto. */
export async function hkdfSha256(ikm: BufferSource, salt: BufferSource, info: BufferSource, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export function createPseudonymizer(masterKeyB64: string): Pseudonymizer {
  const master = base64ToBytes(masterKeyB64);
  if (master.length < 16) throw new Error("master key too short");
  const keys = new Map<PseudonymKind, Promise<CryptoKey>>();
  const keyFor = (kind: PseudonymKind): Promise<CryptoKey> => {
    let k = keys.get(kind);
    if (!k) {
      k = (async () => {
        const raw = await hkdfSha256(master, enc.encode(SALT), enc.encode(INFO_PREFIX + kind), 32);
        return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      })();
      keys.set(kind, k);
    }
    return k;
  };
  const pseudonym = async (kind: PseudonymKind, employeeId: string): Promise<string> => {
    if (!(kind in PSEUDONYM_PREFIX)) throw new Error(`unknown pseudonym kind ${kind}`);
    const mac = await crypto.subtle.sign("HMAC", await keyFor(kind), enc.encode(MESSAGE_PREFIX + employeeId));
    return PSEUDONYM_PREFIX[kind] + base32LowerNoPad(new Uint8Array(mac)).slice(0, LENGTH);
  };
  return {
    pseudonym,
    async all(employeeId) {
      const [wk, er, an, sr] = await Promise.all(PSEUDONYM_KINDS.map((k) => pseudonym(k, employeeId)));
      return { warehouse_key: wk!, employee_ref: er!, analytics_id: an!, subject_ref: sr! };
    },
  };
}
