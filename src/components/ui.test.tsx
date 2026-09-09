import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ListRow } from "./ui";

describe("ListRow", () => {
  it("keeps metadata and trailing affordance in one right-aligned end group", () => {
    render(<ListRow title="知识播客" meta="已配置" trailing={<span>›</span>} />);

    const end = document.querySelector(".list-row-end");
    expect(end).not.toBeNull();
    expect(end?.querySelector(".list-row-meta")).toHaveTextContent("已配置");
    expect(end?.querySelector(".list-row-trailing")).toHaveTextContent("›");
  });

  it("keeps a trailing affordance at the row end when metadata is absent", () => {
    render(<ListRow title="模板" trailing={<span>›</span>} />);

    expect(document.querySelector(".list-row-end .list-row-trailing")).toHaveTextContent("›");
    expect(document.querySelector(".list-row-meta")).toBeNull();
  });
});
