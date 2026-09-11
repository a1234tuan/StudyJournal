import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { VoiceTranscript } from "./VoiceTranscript";
afterEach(cleanup);
it("keeps five turns and does not pull a reader away from history", () => {
  const turns = Array.from({ length: 5 }, (_, index) => ({ id: String(index), sessionId: "s", operationId: String(index), sequence: index, status: "completed" as const, teacherText: `回复${index}`, confirmedText: `回答${index}`, createdAt: "", updatedAt: "" }));
  const view = render(<VoiceTranscript turns={turns} revision="first"><p>当前</p></VoiceTranscript>);
  const log = screen.getByRole("log");
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  log.scrollTop = 100; fireEvent.scroll(log);
  view.rerender(<VoiceTranscript turns={turns} revision="second"><p>新内容</p></VoiceTranscript>);
  expect(log.scrollTop).toBe(100);
  expect(screen.getByText("回复0")).toBeTruthy();
  expect(screen.getByText("回复4")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /有新消息/ }));
  expect(log.scrollTop).toBe(1000);
});
