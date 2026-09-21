import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiMarkdown } from "./AiMarkdown";
import { copyTextToClipboard } from "../lib/clipboard";

vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

describe("AiMarkdown", () => {
  beforeEach(() => {
    vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(true);
  });

  it("renders inline and block math with KaTeX", () => {
    const { container } = render(
      <AiMarkdown content={"行内公式 $a^2+b^2=c^2$\n\n$$\n\\int_0^1 x^2\\,dx\n$$"} />,
    );

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container).not.toHaveTextContent("$$");
  });

  it("renders GitHub-flavored Markdown tables", () => {
    render(<AiMarkdown content={"| 项 | 值 |\n| --- | --- |\n| 公式 | $x^2$ |"} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("公式")).toBeInTheDocument();
  });

  it("renders a highlighted, labelled and copyable fenced code block", async () => {
    const { container } = render(<AiMarkdown content={"```ts\nconst answer: number = 408;\n```"} />);

    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("const answer: number = 408;");
    expect(container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith("const answer: number = 408;"));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("keeps inline code compact and does not add block controls", () => {
    const { container } = render(<AiMarkdown content={"调用 `queue.push(node)` 后继续。"} />);

    expect(container.querySelector("p > code")).toHaveTextContent("queue.push(node)");
    expect(container.querySelector(".ai-code-block")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制代码" })).toBeNull();
  });

  it("keeps unknown fenced languages readable without crashing", () => {
    const { container } = render(<AiMarkdown content={"```study-dsl\nremember concept -> verify later\n```"} />);

    expect(screen.getByText("study-dsl")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("remember concept -> verify later");
  });

  it("keeps the message readable when a formula is invalid", () => {
    const { container } = render(<AiMarkdown content={"公式可能写错：$\\definitelyNotACommand$，但正文不能崩。"} />);

    expect(container).toHaveTextContent("正文不能崩");
  });
});
