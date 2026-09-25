import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

import type { Asset, ExportKind, RecordBlock, StorageSnapshot } from "../types";
import {
  createKnowledgeJsonPayload,
  createKnowledgeOutlineZip,
  createPlainText,
  createReadableRecordHtml,
  createReadableRecordMarkdown,
  createReadableRecordPlainText,
  createSubjectMarkdownZip,
  exportKnowledge,
} from "./knowledgeExportService";
import { snapshotToZip, summarizeSnapshot, zipToSnapshot } from "./backup";

vi.mock("@capacitor/filesystem", () => ({
  Directory: {
    Cache: "CACHE",
    Documents: "DOCUMENTS",
  },
  Filesystem: {
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    deleteFile: vi.fn(),
    getUri: vi.fn(),
  },
}));

vi.mock("@capacitor/share", () => ({
  Share: {
    share: vi.fn(),
  },
}));

vi.mock("file-saver", () => ({
  saveAs: vi.fn(),
}));

vi.mock("../lib/platform", () => ({
  isNativePlatform: () => true,
}));

const stamp = "2026-06-21T00:00:00.000Z";

const imageAsset: Asset = {
  id: "a1",
  createdAt: stamp,
  updatedAt: stamp,
  fileName: "tree.png",
  title: "树截图",
  mimeType: "image/png",
  size: 4,
  kind: "image",
  data: new Blob(["tree"], { type: "image/png" }),
  ocrStatus: "done",
  ocrText: "二叉树遍历 OCR 文本",
};

const snapshot: StorageSnapshot = {
  payload: {
    manifest: {
      format: "study-journal",
      version: 3,
      exportedAt: stamp,
      appVersion: "0.1.0",
      counts: {
        entries: 1,
        blocks: 2,
        mistakes: 0,
        assets: 1,
        tags: 0,
        reviews: 0,
        studySessions: 0,
      },
    },
    entries: [
      {
        id: "e1",
        createdAt: stamp,
        updatedAt: stamp,
        date: "2026-06-21",
        title: "2026-06-21",
        tags: [],
        pinned: false,
        favorite: false,
      },
    ],
    blocks: [
      {
        id: "r1",
        createdAt: stamp,
        updatedAt: stamp,
        type: "record",
        date: "2026-06-21",
        order: 0,
        subject: "数据结构",
        tags: ["树", "重点"],
        title: "树",
        contentHtml: "<h2>遍历</h2><p>先序和后序</p>",
        assets: [{ id: "a1", title: "树截图", kind: "image" }],
        formulas: [{ id: "f1", title: "复杂度", latex: "T(n)=O(n)" }],
        mistakeRefs: [],
      },
      {
        id: "r2",
        createdAt: stamp,
        updatedAt: stamp,
        type: "record",
        date: "2026-06-20",
        order: 0,
        subject: "OS",
        tags: [],
        title: "进程",
        contentHtml: "<p>同步互斥</p>",
        assets: [],
        formulas: [],
        mistakeRefs: [],
      },
    ],
    mistakes: [],
    tags: [],
    reviews: [],
    studySessions: [],
    settings: {
      id: "settings",
      examDate: "2026-12-27",
      theme: "system",
      accentColor: "#2f6f5e",
      backupReminderDays: 7,
      fontScale: 1,
      lineHeight: 1.7,
      schemaVersion: 3,
    },
  },
  assets: [imageAsset],
};

const structuredContentHtml = [
  "<h2>遍历</h2><p>先序和后序</p>",
  '<record-structure-diagram data-json=\'{"title":"结构图","orientation":"horizontal","chain":[{"id":"n1","title":"内容链路","body":"AI 读取","note":"","pitfall":"","branches":[]}]}\'></record-structure-diagram>',
  '<record-comparison-table data-json=\'{"title":"链路表","columns":[{"id":"c1","label":"概念"},{"id":"c2","label":"作用"}],"rows":[{"id":"row1","cells":{"c1":"高亮块","c2":"进入导出"}}]}\'></record-comparison-table>',
  '<record-sticky-board data-json=\'{"title":"便签板","collapsedTypes":[],"notes":[{"id":"note1","type":"question","text":"AI 是否能读到"}]}\'></record-sticky-board>',
  '<record-collapse data-title="折叠块" data-summary="复习提示"><p>折叠正文</p></record-collapse>',
  '<record-highlight-block data-tone="pink"><p><strong>浅粉重点</strong></p><ul><li>导出可读</li></ul></record-highlight-block>',
  '<record-asset data-asset-id="a1" data-kind="image" data-title="树截图"></record-asset>',
  '<record-formula data-formula-id="f1" data-title="复杂度" data-latex="T(n)=O(n)"></record-formula>',
].join("");

const structuredSnapshot: StorageSnapshot = {
  ...snapshot,
  payload: {
    ...snapshot.payload,
    blocks: snapshot.payload.blocks.map((block) =>
      block.id === "r1" ? { ...block, contentHtml: structuredContentHtml } : block,
    ),
  },
};

describe("knowledge export", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Filesystem.writeFile).mockImplementation(async (options) => ({
      uri: `file:///cache/${options.path}`,
    }));
    vi.mocked(Filesystem.appendFile).mockResolvedValue(undefined);
    vi.mocked(Filesystem.deleteFile).mockResolvedValue(undefined);
    vi.mocked(Filesystem.getUri).mockImplementation(async (options) => ({
      uri: `file:///cache/${options.path}`,
    }));
    vi.mocked(Share.share).mockResolvedValue({});
  });

  it("creates subject markdown files sorted by subject", async () => {
    const zip = await JSZip.loadAsync(await createSubjectMarkdownZip(snapshot));
    const dataStructure = await zip.file("subjects/数据结构.md")?.async("string");
    const os = await zip.file("subjects/OS.md")?.async("string");

    expect(dataStructure).toContain("# 数据结构");
    expect(dataStructure).toContain("## 2026-06-21 树");
    expect(dataStructure).toContain("标签：树、重点");
    expect(dataStructure).toContain("二叉树遍历 OCR 文本");
    expect(os).toContain("## 2026-06-20 进程");
  });

  it("exports the visible knowledge tree as nested folders and keeps unorganized records", async () => {
    const state = {
      sequence: 0,
      entities: {
        w1: { id: "w1", kind: "workspace", workspaceId: "w1", nodeId: "", recordId: "", units: { title: "rev-w1" } },
        n1: { id: "n1", kind: "node", workspaceId: "w1", nodeId: "", recordId: "", units: { title: "rev-n1", position: "rev-p1" } },
        n2: { id: "n2", kind: "node", workspaceId: "w1", nodeId: "", recordId: "", units: { title: "rev-n2", position: "rev-p2" } },
        ref1: { id: "ref1", kind: "reference", workspaceId: "w1", nodeId: "n2", recordId: "r1", units: { remark: "rev-ref1" } },
      },
      revisions: {
        "rev-w1": { id: "rev-w1", entityId: "w1", unit: "title", value: "学习", parents: [], commandId: "c1" },
        "rev-n1": { id: "rev-n1", entityId: "n1", unit: "title", value: "数学", parents: [], commandId: "c2" },
        "rev-p1": { id: "rev-p1", entityId: "n1", unit: "position", value: { parentNodeId: "@root", orderKey: "a" }, parents: [], commandId: "c3" },
        "rev-n2": { id: "rev-n2", entityId: "n2", unit: "title", value: "代数", parents: [], commandId: "c4" },
        "rev-p2": { id: "rev-p2", entityId: "n2", unit: "position", value: { parentNodeId: "n1", orderKey: "a" }, parents: [], commandId: "c5" },
        "rev-ref1": { id: "rev-ref1", entityId: "ref1", unit: "remark", value: "重点", parents: [], commandId: "c6" },
      },
      candidates: {},
      groups: {},
      receipts: {},
    } as never;

    const zip = await JSZip.loadAsync(await createKnowledgeOutlineZip({ state, records: snapshot.payload.blocks.filter((block): block is RecordBlock => block.type === "record"), assets: snapshot.assets, libraryTitle: "我的知识库", exportedAt: stamp }));
    expect(zip.file("我的知识库/学习/数学/代数/2026-06-21-树.md")).toBeTruthy();
    expect(zip.file("我的知识库/_未归类/2026-06-20-进程.md")).toBeTruthy();
    expect(await zip.file("我的知识库/学习/数学/代数/2026-06-21-树.md")?.async("string")).toContain("## 树");
    expect(await zip.file("我的知识库/学习/数学/代数/2026-06-21-树.md")?.async("string")).toContain("../../assets/a1-tree.png");
    expect(zip.file("我的知识库/assets/a1-tree.png")).toBeTruthy();
    expect(await zip.file("我的知识库/README.md")?.async("string")).toContain("Markdown 日志：2");
  });

  it("exports JSON records with formulas, assets and OCR text", () => {
    const payload = createKnowledgeJsonPayload(snapshot);

    expect(payload.records[0]).toMatchObject({
      id: "r1",
      subject: "数据结构",
      tags: ["树", "重点"],
      formulas: ["T(n)=O(n)"],
      ocrTexts: ["二叉树遍历 OCR 文本"],
    });
    expect(payload.records[0].contentText).toContain("遍历");
    expect(payload.records[0].contentText).toContain("树截图");
    expect(payload.records[0].contentText).toContain("二叉树遍历 OCR 文本");
    expect(payload.records[0].assetTexts[0]).toContain("tree.png");
  });

  it("keeps structure blocks and highlight blocks readable in knowledge exports", async () => {
    const payload = createKnowledgeJsonPayload(structuredSnapshot);
    const record = payload.records.find((item) => item.id === "r1");

    expect(record?.contentText).toContain("内容链路");
    expect(record?.contentText).toContain("AI 是否能读到");
    expect(record?.contentText).toContain("折叠正文");
    expect(record?.contentText).toContain("浅粉重点");
    expect(record?.contentMarkdown).toContain("| 概念 | 作用 |");
    expect(record?.contentMarkdown).toContain("<details>");
    expect(record?.contentMarkdown).toContain("> 浅粉色高亮");

    const zip = await JSZip.loadAsync(await createSubjectMarkdownZip(structuredSnapshot));
    const dataStructure = await zip.file("subjects/数据结构.md")?.async("string");
    expect(dataStructure).toContain("### 结构图");
    expect(dataStructure).toContain("| 高亮块 | 进入导出 |");
    expect(dataStructure).toContain("#### 疑问");
    expect(dataStructure).toContain("<summary>折叠块 · 复习提示</summary>");
    expect(dataStructure).toContain("> 浅粉色高亮");
  });

  it("exports readable plain text", () => {
    const text = createPlainText(snapshot);

    expect(text).toContain("学习日志知识库");
    expect(text).toContain("2026-06-21｜数据结构｜树");
    expect(text).toContain("标签：树、重点");
    expect(text).toContain("图片文字");
  });

  it("exports one record as readable Markdown, HTML and plain text", () => {
    const record = structuredSnapshot.payload.blocks.find((block) => block.id === "r1");
    if (!record || record.type !== "record") throw new Error("fixture record missing");

    const markdown = createReadableRecordMarkdown(record, structuredSnapshot.assets);
    const html = createReadableRecordHtml(record, structuredSnapshot.assets);
    const text = createReadableRecordPlainText(record, structuredSnapshot.assets);

    expect(markdown).toContain("# 树");
    expect(markdown).toContain("- 日期：2026-06-21");
    expect(markdown).toContain("### 结构图");
    expect(markdown).toContain("<summary>折叠块 · 复习提示</summary>");
    expect(markdown).toContain("T(n)=O(n)");
    expect(markdown).toContain("**图片：树截图**");
    expect(html).toContain("<h1>树</h1>");
    expect(html).toContain("结构图");
    expect(text).toContain("树");
    expect(text).toContain("折叠正文");
    expect(text).toContain("二叉树遍历 OCR 文本");
  });

  it("round-trips full backup assets, OCR metadata and custom block HTML", async () => {
    const backup = await snapshotToZip(structuredSnapshot);
    const restored = await zipToSnapshot(new File([backup], "backup.zip", { type: "application/zip" }));

    expect(restored.assets[0]).toMatchObject({
      id: "a1",
      fileName: "tree.png",
      size: 4,
      ocrStatus: "done",
      ocrText: "二叉树遍历 OCR 文本",
    });
    const restoredRecord = restored.payload.blocks.find((block) => block.id === "r1");
    expect(restoredRecord && "contentHtml" in restoredRecord ? restoredRecord.contentHtml : "").toContain("record-highlight-block");
    expect(restoredRecord && "contentHtml" in restoredRecord ? restoredRecord.contentHtml : "").toContain("record-comparison-table");
  });

  it.each([
    ["full-backup", "shared-exports/study-journal-2026-06-21.zip"],
    ["subject-markdown", "shared-exports/study-journal-subjects-2026-06-21.zip"],
    ["knowledge-json", "shared-exports/study-journal-knowledge-2026-06-21.json"],
    ["plain-text", "shared-exports/study-journal-knowledge-2026-06-21.txt"],
  ] as Array<[ExportKind, string]>)("shares native %s exports from cache", async (kind, expectedPath) => {
    await exportKnowledge(kind, snapshot);

    expect(Filesystem.writeFile).toHaveBeenLastCalledWith(expect.objectContaining({
      path: expectedPath,
      directory: "CACHE",
    }));
    expect(Share.share).toHaveBeenLastCalledWith(expect.objectContaining({
      files: [`file:///cache/${expectedPath}`],
    }));
  });

  it("reports import progress while parsing backup assets", async () => {
    const backup = await snapshotToZip(snapshot);
    const progress: string[] = [];

    await zipToSnapshot(new File([backup], "backup.zip", { type: "application/zip" }), {
      onProgress: (item) => progress.push(`${item.stage}:${item.current ?? 0}/${item.total ?? 0}`),
    });

    expect(progress).toContain("loading:0/0");
    expect(progress).toContain("parsing:0/0");
    expect(progress).toContain("assets:1/1");
    expect(progress).toContain("done:0/0");
  });

  it("rejects non-zip restore files with a clear message", async () => {
    await expect(
      zipToSnapshot(new File(["# notes"], "notes.md", { type: "text/markdown" })),
    ).rejects.toThrow("不支持的文件格式");
  });

  it("rejects zip files without data.json as incomplete backups", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    const blob = await zip.generateAsync({ type: "blob" });

    await expect(zipToSnapshot(new File([blob], "broken.zip", { type: "application/zip" }))).rejects.toThrow("缺少 data.json");
  });

  it("rejects corrupted data.json with a clear message", async () => {
    const zip = new JSZip();
    zip.file("data.json", "{not-json");
    const blob = await zip.generateAsync({ type: "blob" });

    await expect(zipToSnapshot(new File([blob], "broken.zip", { type: "application/zip" }))).rejects.toThrow("备份数据损坏");
  });

  it("rejects incompatible backup manifests with format and version details", async () => {
    const zip = new JSZip();
    zip.file("data.json", JSON.stringify({ manifest: { format: "other", version: 99 } }));
    const blob = await zip.generateAsync({ type: "blob" });

    await expect(zipToSnapshot(new File([blob], "broken.zip", { type: "application/zip" }))).rejects.toThrow("format=other，version=99");
  });

  it("summarizes import counts and missing resources", () => {
    const summary = summarizeSnapshot({
      ...snapshot,
      payload: {
        ...snapshot.payload,
        blocks: [
          ...snapshot.payload.blocks,
          {
            id: "deleted",
            createdAt: stamp,
            updatedAt: stamp,
            deletedAt: "2026-06-22T00:00:00.000Z",
            type: "record",
            date: "2026-06-19",
            order: 0,
            subject: "数学",
            tags: [],
            title: "回收站记录",
            contentHtml: "<p></p>",
            assets: [{ id: "missing", title: "缺失图片", kind: "image" }],
            formulas: [],
            mistakeRefs: [],
          },
        ],
      },
    });

    expect(summary).toMatchObject({
      records: 2,
      days: 2,
      deletedRecords: 1,
      assets: 1,
      images: 1,
      audio: 0,
      attachments: 0,
      version: 3,
      missingAssets: 1,
    });
  });
});
