import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Asset, RecordBlock, RecordDraft, RecordReviewLog, RecordReviewState, SubjectConfig } from "../types";

const nativeAudioMock = vi.hoisted(() => ({
  canUseNativeAudioRecorder: vi.fn(() => false),
  getNativeAudioRecordingStatus: vi.fn().mockResolvedValue({ recording: false }),
  startNativeAudioRecording: vi.fn().mockResolvedValue(undefined),
  stopNativeAudioRecording: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/nativeAudioRecorder", () => nativeAudioMock);

const richEditorMock = vi.hoisted(() => {
  const state: {
    html: string;
    props: any;
    editor: any;
    insertContentAt: ReturnType<typeof vi.fn>;
    insertContent: ReturnType<typeof vi.fn>;
    cancelMarkdownPasteConversion: ReturnType<typeof vi.fn>;
    reset: () => void;
  } = {
    html: "<p></p>",
    props: null,
    editor: null,
    insertContentAt: vi.fn(),
    insertContent: vi.fn(),
    cancelMarkdownPasteConversion: vi.fn(),
    reset: () => undefined,
  };

  state.insertContentAt = vi.fn((_pos: number, nodes: Array<{ type?: string; attrs?: Record<string, string> }>) => ({
    run: () => {
      const node = nodes[0];
      if (node?.type === "recordAsset") {
        const attrs = node.attrs ?? {};
        state.html = `<record-asset data-asset-id="${attrs.assetId}" data-kind="${attrs.kind}" data-title="${attrs.title}"></record-asset><p></p>`;
      } else {
        state.html = `<${node?.type ?? "unknown"}></${node?.type ?? "unknown"}><p></p>`;
      }
      state.props?.onChange?.(state.html);
      return true;
    },
  }));

  state.insertContent = vi.fn((html: string) => ({
    run: () => {
      state.html = html;
      state.props?.onChange?.(state.html);
      return true;
    },
  }));

  state.editor = {
    isDestroyed: false,
    getHTML: () => state.html,
    commands: {
      cancelMarkdownPasteConversion: state.cancelMarkdownPasteConversion,
    },
    state: {
      selection: {
        $from: {
          depth: 0,
          end: () => 0,
        },
      },
    },
    chain: () => ({
      focus: () => ({
        insertContentAt: state.insertContentAt,
        insertContent: state.insertContent,
      }),
    }),
  };

  state.reset = () => {
    state.html = "<p></p>";
    state.props = null;
    state.editor.isDestroyed = false;
    state.insertContentAt.mockClear();
    state.insertContent.mockClear();
    state.cancelMarkdownPasteConversion.mockClear();
  };

  return state;
});

vi.mock("../components/RichTextEditor", () => ({
  RichTextEditor: (props: any) => {
    richEditorMock.props = props;
    richEditorMock.html = props.value;
    return (
      <div data-testid={props.readOnly ? "rich-viewer" : "rich-editor"}>
        {!props.readOnly && props.renderInsertTools?.(richEditorMock.editor)}
      </div>
    );
  },
}));

import { RecordEditorPage } from "./RecordEditorPage";

const stamp = "2026-06-21T00:00:00.000Z";

const record: RecordBlock = {
  id: "record-1",
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-06-21",
  order: 0,
  subject: "Math",
  tags: [],
  title: "Math note 1",
  contentHtml: "<p></p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
  favorite: false,
};

const subjects: SubjectConfig[] = [
  {
    id: "subject-math",
    createdAt: stamp,
    updatedAt: stamp,
    name: "Math",
    order: 0,
  },
  {
    id: "subject-systems",
    createdAt: stamp,
    updatedAt: stamp,
    name: "Systems",
    order: 1,
  },
];

const asset: Asset = {
  id: "asset-1",
  createdAt: stamp,
  updatedAt: stamp,
  kind: "image",
  fileName: "diagram.png",
  title: "diagram.png",
  mimeType: "image/png",
  size: 4,
  data: new File(["data"], "diagram.png", { type: "image/png" }),
};

const reviewState: RecordReviewState = {
  id: "review-1",
  createdAt: stamp,
  updatedAt: stamp,
  recordId: record.id,
  status: "active",
  easeFactor: 2.5,
  repetition: 1,
  intervalDays: 1,
  nextReviewDate: "2026-06-22",
  consecutiveRemembered: 1,
  totalReviews: 1,
};

const reviewLog = (patch: Partial<RecordReviewLog> = {}): RecordReviewLog => ({
  id: "review-log-1",
  recordId: record.id,
  createdAt: stamp,
  updatedAt: stamp,
  rating: "good",
  normalizedRating: "good",
  reviewKind: "overview",
  scheduler: "overview-v1",
  reviewedAt: "2026-06-22T00:00:00.000Z",
  previousEaseFactor: 2.5,
  nextEaseFactor: 2.6,
  previousRepetition: 1,
  nextRepetition: 2,
  previousIntervalDays: 1,
  nextIntervalDays: 6,
  ...patch,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const renderEditor = (overrides: Partial<React.ComponentProps<typeof RecordEditorPage>> = {}) => {
  const onGetDraft = vi.fn().mockResolvedValue(undefined);
  const onSave = vi.fn().mockResolvedValue(record);
  const onSaveDraft = vi.fn(async (draft: RecordDraft) => draft);
  const onDeleteDraft = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <RecordEditorPage
      record={record}
      initialEditing
      onBack={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
      onToggleFavorite={vi.fn()}
      onAddAsset={vi.fn().mockResolvedValue(asset)}
      subjects={subjects}
      onGetDraft={onGetDraft}
      onSaveDraft={onSaveDraft}
      onDeleteDraft={onDeleteDraft}
      {...overrides}
    />,
  );

  const saveButton = () => view.container.querySelector(".record-action-row .primary-button") as HTMLButtonElement;
  return { ...view, onGetDraft, onSave, onSaveDraft, onDeleteDraft, saveButton };
};

afterEach(() => {
  vi.useRealTimers();
  richEditorMock.reset();
  nativeAudioMock.canUseNativeAudioRecorder.mockReset().mockReturnValue(false);
  nativeAudioMock.getNativeAudioRecordingStatus.mockReset().mockResolvedValue({ recording: false });
  nativeAudioMock.startNativeAudioRecording.mockReset().mockResolvedValue(undefined);
  nativeAudioMock.stopNativeAudioRecording.mockReset().mockResolvedValue(null);
});

describe("RecordEditorPage", () => {
  const decisionBlockHtml = '<record-decision-block data-decision-block-id="block-1" data-content-version="1"><p>需要复习</p></record-decision-block>';

  it("automatically enrolls a newly created record when its first save contains a decision block", async () => {
    const onAddToReview = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm");
    const { onGetDraft, onSave, saveButton } = renderEditor({ isNewRecord: true, onAddToReview });
    await waitFor(() => expect(onGetDraft).toHaveBeenCalled());
    act(() => {
      richEditorMock.html = decisionBlockHtml;
      richEditorMock.props.onChange(decisionBlockHtml);
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onAddToReview).toHaveBeenCalledWith(record.id);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("asks once before enrolling an existing unscheduled record with its first decision block", async () => {
    const onAddToReview = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onGetDraft, onSave, saveButton } = renderEditor({ onAddToReview });
    await waitFor(() => expect(onGetDraft).toHaveBeenCalled());
    act(() => {
      richEditorMock.html = decisionBlockHtml;
      richEditorMock.props.onChange(decisionBlockHtml);
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onAddToReview).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does not re-enroll or prompt for a record whose FSRS review is already active", async () => {
    const onAddToReview = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm");
    const { onGetDraft, onSave, saveButton } = renderEditor({ reviewState, onAddToReview });
    await waitFor(() => expect(onGetDraft).toHaveBeenCalled());
    act(() => {
      richEditorMock.html = decisionBlockHtml;
      richEditorMock.props.onChange(decisionBlockHtml);
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onAddToReview).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("marks a menu-inserted collapse block for one-time summary autofocus", async () => {
    const { onGetDraft } = renderEditor();

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));
    fireEvent.click(screen.getByRole("button", { name: "结构块" }));
    fireEvent.click(await screen.findByRole("button", { name: /折叠块/ }));

    expect(richEditorMock.insertContentAt).toHaveBeenCalledWith(0, [
      expect.objectContaining({
        type: "recordCollapseBlock",
        attrs: expect.objectContaining({ defaultOpen: false, autofocusSummary: true }),
      }),
      { type: "paragraph" },
    ]);
  });

  it("inserts a template HTML copy at the editor selection", async () => {
    const template = {
      id: "template-translation",
      createdAt: stamp,
      updatedAt: stamp,
      title: "翻译复盘",
      contentHtml: "<blockquote>原句</blockquote><ul><li>我的翻译</li></ul>",
    };
    const { onGetDraft } = renderEditor({ templates: [template] });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));
    fireEvent.click(screen.getByRole("button", { name: "插入模板" }));
    fireEvent.click(await screen.findByRole("button", { name: /翻译复盘/ }));

    expect(richEditorMock.insertContent).toHaveBeenCalledWith(template.contentHtml);
  });

  it("renews decision-block identity when inserting a reusable template", async () => {
    const template = {
      id: "template-decision-block",
      createdAt: stamp,
      updatedAt: stamp,
      title: "重点模板",
      contentHtml: decisionBlockHtml,
    };
    const { onGetDraft } = renderEditor({ templates: [template] });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));
    fireEvent.click(screen.getByRole("button", { name: "插入模板" }));
    fireEvent.click(await screen.findByRole("button", { name: /重点模板/ }));

    const inserted = String(richEditorMock.insertContent.mock.calls.at(-1)?.[0]);
    expect(inserted).toContain("record-decision-block");
    expect(inserted).not.toContain('data-decision-block-id="block-1"');
    expect(inserted).toContain('data-content-version="1"');
    expect(inserted).toContain("data-created-at=");
  });

  it("does not expose subject creation while editing a record", async () => {
    const { onGetDraft } = renderEditor();

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    expect(screen.queryByRole("button", { name: /create subject/i })).not.toBeInTheDocument();
  });

  it("saves the latest editor html and switches to read-only with one click", async () => {
    const { onGetDraft, onSave, saveButton } = renderEditor();

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    act(() => {
      richEditorMock.html = "<record-collapse-block><p>body</p></record-collapse-block>";
      richEditorMock.props.onChange(richEditorMock.html);
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(richEditorMock.cancelMarkdownPasteConversion).toHaveBeenCalled();
    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining({
      contentHtml: "<record-collapse-block><p>body</p></record-collapse-block>",
    }));
    expect(screen.getByRole("heading", { name: "Math note 1" })).toBeInTheDocument();
  });

  it("suggests subject tags and saves a pending new tag", async () => {
    const referenceRecord: RecordBlock = {
      ...record,
      id: "reference-record",
      title: "已标记记录",
      tags: ["复习", "定义"],
    };
    const { onGetDraft, onSave, saveButton } = renderEditor({ referenceRecords: [referenceRecord] });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    const tagInput = screen.getByRole("textbox", { name: "日志标签" });
    fireEvent.change(tagInput, { target: { value: "复" } });
    fireEvent.click(screen.getByRole("option", { name: "复习" }));
    fireEvent.change(screen.getByRole("textbox", { name: "日志标签" }), { target: { value: "新标签" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ tags: ["复习", "新标签"] });
  });

  it("does not write an initialization change before an asynchronous draft has loaded", async () => {
    vi.useFakeTimers();
    const draftLoad = deferred<RecordDraft | undefined>();
    const onGetDraft = vi.fn(() => draftLoad.promise);
    const onSaveDraft = vi.fn(async (draft: RecordDraft) => draft);
    const { saveButton } = renderEditor({ onGetDraft, onSaveDraft });

    expect(screen.getByText("正在读取草稿，编辑已暂时锁定。")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    act(() => {
      richEditorMock.props?.onChange?.("<p>初始化补空行</p>");
      vi.advanceTimersByTime(500);
    });
    expect(onSaveDraft).not.toHaveBeenCalled();

    await act(async () => {
      draftLoad.resolve(undefined);
      await draftLoad.promise;
    });
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it("returns immediately while a draft save is still in flight", async () => {
    const draftSave = deferred<RecordDraft>();
    let savedDraft!: RecordDraft;
    const onSaveDraft = vi.fn((nextDraft: RecordDraft) => {
      savedDraft = nextDraft;
      return draftSave.promise;
    });
    const onBack = vi.fn();
    const { onGetDraft } = renderEditor({ onBack, onSaveDraft });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    act(() => {
      richEditorMock.html = "<p>queued draft</p>";
      richEditorMock.props.onChange(richEditorMock.html);
    });
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(onBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      draftSave.resolve(savedDraft);
      await draftSave.promise;
    });
  });

  it("does not query the native recorder when leaving preview", async () => {
    nativeAudioMock.canUseNativeAudioRecorder.mockReturnValue(true);
    const onBack = vi.fn();
    const { onGetDraft } = renderEditor({ initialEditing: false, onBack });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(nativeAudioMock.getNativeAudioRecordingStatus).not.toHaveBeenCalled();
  });

  it("stops an active native recording after navigation starts", async () => {
    const recordingFile = new File(["audio"], "recording.m4a", { type: "audio/mp4" });
    nativeAudioMock.canUseNativeAudioRecorder.mockReturnValue(true);
    nativeAudioMock.getNativeAudioRecordingStatus.mockResolvedValue({ recording: true });
    nativeAudioMock.stopNativeAudioRecording.mockResolvedValue(recordingFile);
    const onBack = vi.fn();
    const onAddAsset = vi.fn().mockResolvedValue(asset);
    const { onGetDraft } = renderEditor({ onBack, onAddAsset });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(nativeAudioMock.stopNativeAudioRecording).toHaveBeenCalledTimes(1));
    expect(onAddAsset).toHaveBeenCalledWith(recordingFile, "audio", "录音");
  });

  it("waits for an in-flight draft save before deleting the draft and entering preview", async () => {
    const draftSave = deferred<RecordDraft>();
    let savedDraft!: RecordDraft;
    const onSaveDraft = vi.fn((draft: RecordDraft) => {
      savedDraft = draft;
      return draftSave.promise;
    });
    const onDeleteDraft = vi.fn().mockResolvedValue(undefined);
    const onSave = vi.fn().mockResolvedValue(record);
    const { onGetDraft, saveButton } = renderEditor({ onSave, onSaveDraft, onDeleteDraft });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    act(() => {
      richEditorMock.html = "<p>queued draft</p>";
      richEditorMock.props.onChange(richEditorMock.html);
    });
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));

    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      draftSave.resolve(savedDraft);
      await draftSave.promise;
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onDeleteDraft).toHaveBeenCalledWith(record.id);
    expect(onSaveDraft.mock.invocationCallOrder[0]).toBeLessThan(onDeleteDraft.mock.invocationCallOrder[0]);
    expect(screen.getByRole("heading", { name: "Math note 1" })).toBeInTheDocument();
  });

  it("waits for a pending asset insertion before saving the record", async () => {
    const assetSave = deferred<Asset>();
    const onAddAsset = vi.fn(() => assetSave.promise);
    const onSave = vi.fn().mockResolvedValue(record);
    const { container, onGetDraft, saveButton } = renderEditor({ onAddAsset, onSave });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    const input = container.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(["data"], "diagram.png", { type: "image/png" })],
      },
    });
    await waitFor(() => expect(onAddAsset).toHaveBeenCalled());

    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      assetSave.resolve(asset);
      await assetSave.promise;
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].contentHtml).toContain("record-asset");
    expect(onSave.mock.calls[0][0].contentHtml).toContain("asset-1");
    expect(screen.getByRole("heading", { name: "Math note 1" })).toBeInTheDocument();
  });

  it("saves deletion of the final asset node without restoring it from refs", async () => {
    const recordWithSingleAsset: RecordBlock = {
      ...record,
      contentHtml: '<record-asset data-asset-id="asset-1" data-kind="image" data-title="diagram.png"></record-asset><p></p>',
      assets: [{ id: "asset-1", kind: "image", title: "diagram.png" }],
    };
    const onSave = vi.fn().mockResolvedValue(recordWithSingleAsset);
    const { onGetDraft, saveButton } = renderEditor({ record: recordWithSingleAsset, onSave });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    act(() => {
      richEditorMock.html = "<p></p>";
      richEditorMock.props.onChange(richEditorMock.html);
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].contentHtml).toBe("<p></p>");
    expect(onSave.mock.calls[0][0].contentHtml).not.toContain("record-asset");
    expect(onSave.mock.calls[0][0].assets).toEqual([]);
  });

  it("keeps primary topbar actions visible and secondary actions in the more menu for a restored draft", async () => {
    const draft: RecordDraft = {
      id: record.id,
      recordId: record.id,
      baseUpdatedAt: record.updatedAt,
      draft: {
        ...record,
        title: "Restored draft",
        contentHtml: "<p>draft body</p>",
      },
      updatedAt: "2026-06-21T00:01:00.000Z",
    };
    const onGetDraft = vi.fn().mockResolvedValue(draft);

    renderEditor({
      onGetDraft,
      onAddToReview: vi.fn(),
      reviewState,
    });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /编辑/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));

    expect(screen.getAllByRole("button", { name: /丢弃草稿/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /轻回看 06-22/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "收藏记录" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "删除记录" })).toHaveLength(2);
  });

  it("moves subject switching into the editing more menu", async () => {
    const onSave = vi.fn().mockImplementation(async (draft: RecordBlock) => draft);
    const { onGetDraft, saveButton } = renderEditor({ onSave });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));
    expect(screen.queryByLabelText("选择学科")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.change(screen.getByRole("combobox", { name: "日志学科" }), { target: { value: "Systems" } });
    expect(screen.getByRole("combobox", { name: "日志学科" })).toHaveValue("Systems");

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].subject).toBe("Systems");
  });

  it("restores pending decision-block removal metadata from an autosaved draft", async () => {
    const decisionRecord: RecordBlock = {
      ...record,
      contentHtml: decisionBlockHtml,
    };
    const latestRemovedHtml = decisionBlockHtml.replace("需要复习", "删除前的最新内容");
    const storedDraft: RecordDraft = {
      id: record.id,
      recordId: record.id,
      baseUpdatedAt: record.updatedAt,
      draft: { ...decisionRecord, contentHtml: "<p>保留正文</p>" },
      decisionBlockRemovals: [{
        decisionBlockId: "block-1",
        reason: "deleted",
        contentHtml: latestRemovedHtml,
      }],
      updatedAt: "2026-06-21T00:01:00.000Z",
    };
    const onGetDraft = vi.fn().mockResolvedValue(storedDraft);
    const onSave = vi.fn().mockResolvedValue(storedDraft.draft);
    const { saveButton } = renderEditor({ record: decisionRecord, onGetDraft, onSave });

    await waitFor(() => expect(screen.getByText("已恢复未保存草稿，点击保存后才会写入正式记录。")).toBeInTheDocument());
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1]).toEqual({
      decisionBlockRemovals: [{
        decisionBlockId: "block-1",
        reason: "deleted",
        contentHtml: latestRemovedHtml,
      }],
      restoredDecisionBlocks: [],
    });
  });

  it("keeps edit visible in preview and exposes secondary preview actions from the more menu", async () => {
    const onAddToReview = vi.fn();
    const onOpenVoiceRecall = vi.fn();
    const { onGetDraft } = renderEditor({
      initialEditing: false,
      onAddToReview,
      onOpenVoiceRecall,
    });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /编辑/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "语音复述" }));
    expect(onOpenVoiceRecall).toHaveBeenCalledWith(record);

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("button", { name: "语音复述" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "收藏记录" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /加入复习/ }).at(-1)!);

    await waitFor(() => expect(onAddToReview).toHaveBeenCalledWith(record.id));
  });

  it("shows review evaluation text in the read-only review history", async () => {
    const { onGetDraft } = renderEditor({
      initialEditing: false,
      reviewState,
      reviewLogs: [reviewLog({ evaluationText: "- 这里已经理解了互斥条件" })],
    });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    expect(screen.getByText("- 这里已经理解了互斥条件")).toBeInTheDocument();
  });

  it("keeps editing and preserves a draft when the formal save fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk full"));
    const onSaveDraft = vi.fn(async (draft: RecordDraft) => draft);
    const onDeleteDraft = vi.fn().mockResolvedValue(undefined);
    const { onGetDraft, saveButton } = renderEditor({ onSave, onSaveDraft, onDeleteDraft });

    await waitFor(() => expect(onGetDraft).toHaveBeenCalledWith(record.id));

    act(() => {
      richEditorMock.html = "<p>must survive</p>";
      richEditorMock.props.onChange(richEditorMock.html);
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onSaveDraft.mock.calls.at(-1)?.[0].draft.contentHtml).toBe("<p>must survive</p>");
    expect(onDeleteDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId("rich-editor")).toBeInTheDocument();
  });
});
