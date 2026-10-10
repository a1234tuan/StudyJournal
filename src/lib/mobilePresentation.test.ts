import { describe, expect, it } from "vitest";
import { mobilePresentationFor, type PresentationHost } from "./mobilePresentation";

describe("mobile presentation boundaries", () => {
  it.each<[PresentationHost, boolean, boolean]>([
    ["android", true, true], ["android", false, true],
    ["desktop", true, false], ["desktop", false, false],
    ["web", true, true], ["web", false, false],
  ])("keeps %s compact=%s mobile=%s", (host, compact, expected) => {
    expect(mobilePresentationFor(host, compact)).toBe(expected);
  });
});
