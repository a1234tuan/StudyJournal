import { describe, expect, it } from "vitest";
import { systemBarStyleForTheme } from "./systemBarTheme";

describe("system bar appearance", () => {
  it("uses light icons for a dark surface, and dark icons for a light surface", () => {
    expect(systemBarStyleForTheme("dark")).toBe("DARK");
    expect(systemBarStyleForTheme("light")).toBe("LIGHT");
  });
  it("delegates system appearance and initial loading to the native host", () => {
    expect(systemBarStyleForTheme("system")).toBe("DEFAULT");
    expect(systemBarStyleForTheme(undefined)).toBe("DEFAULT");
  });
});
