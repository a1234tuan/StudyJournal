import { describe, expect, it } from "vitest";

import { decodeDoubaoSmallTtsJson, decodeDoubaoTtsNdjson } from "./doubaoTts";

describe("decodeDoubaoTtsNdjson", () => {
  it("concatenates multiple successful base64 chunks in order", () => {
    const encode = (value: string) => btoa(value);
    const bytes = decodeDoubaoTtsNdjson([
      JSON.stringify({ code: 0, data: encode("mp3-") }),
      JSON.stringify({ code: "0", data: encode("audio") }),
    ].join("\n"));
    expect(new TextDecoder().decode(bytes)).toBe("mp3-audio");
  });

  it("accepts successful responses whose status code is null or padded", () => {
    const encode = (value: string) => btoa(value);
    const bytes = decodeDoubaoTtsNdjson([
      JSON.stringify({ code: null, message: "OK", data: encode("mp3-") }),
      JSON.stringify({ code: " 0 ", message: "OK", data: encode("audio") }),
    ].join("\n"));
    expect(new TextDecoder().decode(bytes)).toBe("mp3-audio");
  });

  it("accepts Doubao's successful terminal event", () => {
    const bytes = decodeDoubaoTtsNdjson([
      JSON.stringify({ code: 0, data: btoa("audio") }),
      JSON.stringify({ code: 20000000, message: "OK" }),
    ].join("\n"));
    expect(new TextDecoder().decode(bytes)).toBe("audio");
  });

  it("surfaces provider errors", () => {
    expect(() => decodeDoubaoTtsNdjson(JSON.stringify({ code: 3001, message: "invalid speaker" })))
      .toThrow("invalid speaker");
  });
});

describe("decodeDoubaoSmallTtsJson", () => {
  it("decodes a successful legacy response", () => {
    expect(new TextDecoder().decode(decodeDoubaoSmallTtsJson(JSON.stringify({ code: 3000, data: btoa("audio") })))).toBe("audio");
  });

  it("surfaces a legacy provider error", () => {
    expect(() => decodeDoubaoSmallTtsJson(JSON.stringify({ code: 3001, message: "invalid app id" }))).toThrow("invalid app id");
  });
});
