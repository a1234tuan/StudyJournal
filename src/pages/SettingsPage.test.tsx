import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../db/defaults";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage typography controls", () => {
  const renderPage = (settings = DEFAULT_SETTINGS) => {
    const onSaveSettings = vi.fn();
    render(
      <SettingsPage
        settings={settings}
        onSaveSettings={onSaveSettings}
        visualTheme="reading"
        onVisualThemeChange={vi.fn()}
      />,
    );
    return onSaveSettings;
  };

  it("exposes separate interface and body font sliders", () => {
    const onSaveSettings = renderPage();
    const sliders = screen.getAllByRole("slider");

    expect(screen.getByText("界面字号")).toBeInTheDocument();
    expect(screen.getByText("正文字号")).toBeInTheDocument();
    expect(sliders).toHaveLength(3); // interface font, body font, line height

    fireEvent.change(sliders[0], { target: { value: "1.1" } });
    expect(onSaveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ fontScale: 1.1 }));

    fireEvent.change(sliders[1], { target: { value: "1.2" } });
    expect(onSaveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ editorFontScale: 1.2 }));
  });

  it("falls back to the default body scale for legacy settings", () => {
    renderPage({ ...DEFAULT_SETTINGS, editorFontScale: undefined });
    const sliders = screen.getAllByRole("slider");
    expect(sliders[1]).toHaveValue("1");
  });
});
