import { describe, expect, it } from "vitest";
import { integrityHash, sha256Hex, stableStringify } from "../integrity";

describe("integrity hashing", () => {
  it("matches published SHA-256 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("serializes object keys deterministically", () => {
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(integrityHash({ b: 2, a: 1 })).toBe(integrityHash({ a: 1, b: 2 }));
  });

  it("normalizes non-finite numbers and omitted values", () => {
    expect(stableStringify({ a: Number.NaN, b: undefined, c: [Infinity, undefined] })).toBe('{"a":null,"c":[null,null]}');
  });
});
