import { describe, expect, it } from "vitest";
import vectors from "../../policy/test-vectors/pseudonyms.json";
import {
  PSEUDONYM_KINDS,
  PSEUDONYM_PATTERN,
  base32LowerNoPad,
  createPseudonymizer,
  hkdfSha256,
  type PseudonymKind,
} from "../../src/worker/pseudo/hmac.ts";

const hexToBytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("pseudonym vectors shared with Python", () => {
  const p = createPseudonymizer(vectors.master_key_b64);

  it("has 12 vectors (3 ids x 4 kinds) and 2 HKDF vectors", () => {
    expect(vectors.vectors).toHaveLength(12);
    expect(vectors.hkdf_rfc5869).toHaveLength(2);
  });

  for (const v of vectors.vectors) {
    it(`${v.kind}(${v.employee_id})`, async () => {
      expect(await p.pseudonym(v.kind as PseudonymKind, v.employee_id)).toBe(v.pseudonym);
    });
  }

  for (const h of vectors.hkdf_rfc5869) {
    it(`HKDF ${h.case}`, async () => {
      const okm = await hkdfSha256(hexToBytes(h.ikm_hex), hexToBytes(h.salt_hex), hexToBytes(h.info_hex), h.length);
      expect(toHex(okm)).toBe(h.okm_hex);
    });
  }
});

describe("pseudonym properties", () => {
  const p = createPseudonymizer(vectors.master_key_b64);
  const ids = Array.from({ length: 1200 }, (_, i) => `E${String(i + 1).padStart(5, "0")}`);

  it("is deterministic, prefixed, 29 characters, kind-separated and contains no raw id", async () => {
    const a = await p.all("E00042");
    const b = await p.all("E00042");
    expect(a).toEqual(b);
    expect(new Set(Object.values(a)).size).toBe(4);
    for (const kind of PSEUDONYM_KINDS) {
      expect(a[kind]).toMatch(PSEUDONYM_PATTERN);
      expect(a[kind]).toHaveLength(29);
      expect(a[kind].toLowerCase()).not.toContain("e00042");
      expect(a[kind]).not.toContain("00042");
    }
  });

  it("has no collisions across the 1,200 synthetic ids for any kind", async () => {
    for (const kind of PSEUDONYM_KINDS) {
      const values = await Promise.all(ids.map((id) => p.pseudonym(kind, id)));
      expect(new Set(values).size).toBe(1200);
    }
  });

  it("base32 matches RFC 4648 lowercase without padding", () => {
    expect(base32LowerNoPad(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
    expect(base32LowerNoPad(new TextEncoder().encode("f"))).toBe("my");
  });

  it("different master keys give different pseudonyms", async () => {
    const other = createPseudonymizer(btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i))));
    expect(await other.pseudonym("employee_ref", "E00001")).not.toBe(await p.pseudonym("employee_ref", "E00001"));
  });
});
