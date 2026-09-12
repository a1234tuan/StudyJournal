import { ArrowLeft, CalendarCheck, Download, Edit3, FilePlus, ImagePlus, Mic, MoreHorizontal, PanelRight, Pi, RotateCcw, Save, Search, Star, Trash2, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "katex/dist/katex.min.css";
import type { Editor } from "@tiptap/react";

import type { Asset, ContentTemplate, RecordBlock, RecordDraft, RecordReviewKind, RecordReviewLog, RecordReviewState, RecordSaveOptions, Subject, SubjectConfig } from "../types";
import { RichTextEditor, type RestorableDecisionBlock } from "../components/RichTextEditor";
import { RecordTagChips, recordTagStyle } from "../components/RecordTagChips";
import { AudioRecorder, type AudioRecorderHandle } from "../components/AudioRecorder";
import { StructureInsertMenu } from "../components/StructureInsertMenu";
import { TemplateInsertMenu } from "../components/TemplateInsertMenu";
import { newId } from "../lib/entity";
import { isoDateTimeToLocalDate, nowISO } from "../lib/date";
import { isDesktopPlatform, isNativePlatform } from "../lib/platform";
import { formatUiError } from "../lib/uiError";
import { pickNativeGalleryImageFile } from "../lib/nativeImagePicker";
import { normalizeRecordContent, syncRecordRefsFromContent } from "../lib/recordContent";
import { getSubjectRecordTags, normalizeRecordTag, normalizeRecordTags, recordTagKey } from "../lib/recordTags";
import { ratingLabel, reviewKindLabel } from "../lib/reviewScheduler";
import {
  createDefaultComparisonTable,
  createDefaultStickyBoard,
  createDefaultStructureDiagram,
  serializeStructureData,
  type StructureBlockKind,
} from "../lib/recordStructureBlocks";
import { DEFAULT_MERMAID_SOURCE } from "../components/RecordMermaidNode";
import {
  canUseNativeAudioRecorder,
  getNativeAudioRecordingStatus,
  stopNativeAudioRecording,
} from "../services/nativeAudioRecorder";
import { useRestoreInProgress } from "../services/restoreLockService";
import { registerDesktopFlushHandler } from "../services/desktopLifecycleService";
import {
  extractDecisionBlocks,
  renewDecisionBlockIdentitiesInHtml,
  type PendingDecisionBlockRemoval,
} from "../features/reviewCoach/decisionBlockContent";
import type { DecisionBlockArchive } from "../features/reviewCoach/domain";

interface RecordEditorPageProps {
  record: RecordBlock;
  initialEditing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onBack: () => void;
  onSave: (record: RecordBlock, options?: RecordSaveOptions) => Promise<RecordBlock | void>;
  onDelete: (recordId: string) => Promise<void>;
  onToggleFavorite: (record: RecordBlock, favorite: boolean) => Promise<void> | void;
  onAddAsset: (file: File, kind: Asset["kind"], title?: string) => Promise<Asset>;
  onAssetTitleChange?: (assetId: string, title: string) => Promise<void> | void;
  onAssetChanged?: () => void;
  highlightedAssetId?: string;
  subjects: SubjectConfig[];
  templates?: readonly ContentTemplate[];
  referenceRecords?: readonly RecordBlock[];
  onOpenRecordReference?: (recordId: string) => void;
  restoreScrollY?: number;
  onGetDraft: (recordId: string) => Promise<RecordDraft | undefined>;
  onSaveDraft: (draft: RecordDraft) => Promise<RecordDraft>;
  onDeleteDraft: (recordId: string) => Promise<void>;
  reviewState?: RecordReviewState;
  reviewLogs?: RecordReviewLog[];
  onAddToReview?: (recordId: string) => Promise<void> | void;
  onSetReviewKind?: (recordId: string, kind: RecordReviewKind) => Promise<void> | void;
  onResetReview?: (recordId: string) => Promise<void> | void;
  onRemoveReview?: (recordId: string) => Promise<void> | void;
  onExportRecord?: (recordId: string) => Promise<string> | string;
  onOpenVoiceRecall?: (record: RecordBlock) => void;
  isNewRecord?: boolean;
  onListDecisionBlockArchives?: (recordId: string) => Promise<DecisionBlockArchive[]>;
}

const cloneRecord = (record: RecordBlock): RecordBlock =>
  syncRecordRefsFromContent({ ...record, mistakeRefs: [] });

const syncEditableRecord = (record: RecordBlock): RecordBlock =>
  syncRecordRefsFromContent({ ...record, mistakeRefs: [] }, { preserveLegacyRefs: false });

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const recordAssetHtml = (asset: Asset, kind: Asset["kind"], title: string): string =>
  `<record-asset data-asset-id="${escapeAttribute(asset.id)}" data-kind="${escapeAttribute(kind)}" data-title="${escapeAttribute(asset.title ?? title)}"></record-asset><p></p>`;

const structureBlockNode = (kind: StructureBlockKind): Record<string, unknown> => {
  switch (kind) {
    case "diagram":
      return {
        type: "recordStructureDiagram",
        attrs: { data: serializeStructureData(createDefaultStructureDiagram()) },
      };
    case "comparison":
      return {
        type: "recordComparisonTable",
        attrs: { data: serializeStructureData(createDefaultComparisonTable()) },
      };
    case "sticky":
      return {
        type: "recordStickyBoard",
        attrs: { data: serializeStructureData(createDefaultStickyBoard()) },
      };
    case "collapse":
      return {
        type: "recordCollapseBlock",
        attrs: { title: "折叠块", summary: "", defaultOpen: false, autofocusSummary: true },
        content: [{ type: "paragraph" }],
      };
    case "mermaid":
      return {
        type: "recordMermaidDiagram",
        attrs: { source: DEFAULT_MERMAID_SOURCE },
      };
  }
};

const hasDraftChanges = (draft: RecordBlock, record: RecordBlock) =>
  draft.title !== record.title ||
  draft.subject !== record.subject ||
  draft.contentHtml !== record.contentHtml ||
  JSON.stringify(draft.tags) !== JSON.stringify(record.tags) ||
  JSON.stringify(draft.assets) !== JSON.stringify(record.assets) ||
  JSON.stringify(draft.formulas) !== JSON.stringify(record.formulas);

const draftDecisionBlockOptions = (
  removals: ReadonlyMap<string, PendingDecisionBlockRemoval>,
  restoredBlocks: ReadonlyMap<string, string>,
): Pick<RecordDraft, "decisionBlockRemovals" | "restoredDecisionBlocks"> => ({
  decisionBlockRemovals: Array.from(removals.values()),
  restoredDecisionBlocks: Array.from(restoredBlocks, ([decisionBlockId, contentHtml]) => ({ decisionBlockId, contentHtml })),
});

export const RecordEditorPage = ({
  record,
  initialEditing = false,
  onEditingChange,
  onBack,
  onSave,
  onDelete,
  onToggleFavorite,
  onAddAsset,
  onAssetTitleChange,
  onAssetChanged,
  highlightedAssetId,
  subjects,
  templates = [],
  referenceRecords = [],
  onOpenRecordReference,
  restoreScrollY,
  onGetDraft,
  onSaveDraft,
  onDeleteDraft,
  reviewState,
  reviewLogs = [],
  onAddToReview,
  onSetReviewKind,
  onResetReview,
  onRemoveReview,
  onExportRecord,
  onOpenVoiceRecall,
  isNewRecord = false,
  onListDecisionBlockArchives,
}: RecordEditorPageProps) => {
  const native = isNativePlatform();
  const restoreLocked = useRestoreInProgress();
  const [editing, setEditingState] = useState(initialEditing);
  const [draft, setDraft] = useState<RecordBlock>(() => cloneRecord(record));
  const [saving, setSaving] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftLoading, setDraftLoading] = useState(true);
  const interactionLocked = restoreLocked || draftLoading;
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [editingTagIndex, setEditingTagIndex] = useState<number | null>(null);
  const recordIdRef = useRef(record.id);
  const draftRef = useRef<RecordBlock>(cloneRecord(record));
  const draftLoadingRef = useRef(true);
  const draftLoadSequenceRef = useRef(0);
  const initialEditingRef = useRef(initialEditing);
  const editorRef = useRef<Editor | null>(null);
  const audioRecorderRef = useRef<AudioRecorderHandle | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const committingRef = useRef(false);
  const ignoreEditorChangesRef = useRef(false);
  const pendingAssetTasksRef = useRef<Set<Promise<void>>>(new Set());
  const leavingRef = useRef(false);
  const stoppingRecordingRef = useRef<Promise<void> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftSaveStatus, setDraftSaveStatus] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [wideContent, setWideContent] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const pendingDecisionBlockRemovalsRef = useRef<Map<string, PendingDecisionBlockRemoval>>(new Map());
  const restoredDecisionBlocksRef = useRef(new Map<string, string>());
  const [restorableDecisionBlocks, setRestorableDecisionBlocks] = useState<RestorableDecisionBlock[]>([]);

  const refreshDecisionBlockArchives = useCallback(async () => {
    if (!onListDecisionBlockArchives) {
      setRestorableDecisionBlocks([]);
      return;
    }
    const archives = await onListDecisionBlockArchives(record.id);
    setRestorableDecisionBlocks(archives.map((archive) => ({
      archiveId: archive.id,
      decisionBlockId: archive.decisionBlockId,
      contentHtml: archive.contentHtml,
      archivedAt: archive.archivedAt,
    })));
  }, [onListDecisionBlockArchives, record.id]);

  useEffect(() => {
    pendingDecisionBlockRemovalsRef.current.clear();
    restoredDecisionBlocksRef.current.clear();
    void refreshDecisionBlockArchives().catch(() => setRestorableDecisionBlocks([]));
  }, [refreshDecisionBlockArchives]);

  useEffect(() => {
    if (draftLoading || restoreScrollY === undefined) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, restoreScrollY));
    return () => window.cancelAnimationFrame(frame);
  }, [draftLoading, record.id, restoreScrollY]);

  useEffect(() => {
    initialEditingRef.current = initialEditing;
  }, [initialEditing]);

  useEffect(() => {
    if (!isDesktopPlatform()) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen]);

  const setEditing = useCallback(
    (nextEditing: boolean) => {
      if (nextEditing && (restoreLocked || draftLoadingRef.current)) {
        return;
      }
      if (nextEditing) {
        ignoreEditorChangesRef.current = false;
        setSaveError(null);
      }
      setMoreActionsOpen(false);
      setEditingState(nextEditing);
      onEditingChange?.(nextEditing);
    },
    [onEditingChange, restoreLocked],
  );

  const flushDraft = useCallback(
    async (nextDraft = draftRef.current, options: { force?: boolean } = {}) => {
      const decisionBlockOptions = draftDecisionBlockOptions(
        pendingDecisionBlockRemovalsRef.current,
        restoredDecisionBlocksRef.current,
      );
      const hasDecisionBlockIntent = Boolean(
        decisionBlockOptions.decisionBlockRemovals?.length || decisionBlockOptions.restoredDecisionBlocks?.length,
      );
      if (restoreLocked || draftLoadingRef.current || (!options.force && committingRef.current) || (!hasDraftChanges(nextDraft, record) && !hasDecisionBlockIntent)) {
        return;
      }

      const task = draftSaveQueueRef.current.then(async () => {
        if (draftLoadingRef.current || (!options.force && committingRef.current) || (!hasDraftChanges(nextDraft, record) && !hasDecisionBlockIntent)) {
          return;
        }
        setDraftSaveStatus("saving");
        try {
          await onSaveDraft({
            id: record.id,
            recordId: record.id,
            baseUpdatedAt: record.updatedAt,
            draft: cloneRecord(nextDraft),
            ...decisionBlockOptions,
            updatedAt: nowISO(),
          });
          setDraftSaveStatus("saved");
        } catch (error) {
          setDraftSaveStatus("error");
          throw error;
        }
      });

      draftSaveQueueRef.current = task.catch(() => undefined);
      await task;
    },
    [onSaveDraft, record, restoreLocked],
  );

  const scheduleDraftSave = useCallback(
    (nextDraft: RecordBlock) => {
      draftRef.current = nextDraft;
      if (draftLoadingRef.current || restoreLocked || committingRef.current || ignoreEditorChangesRef.current || !hasDraftChanges(nextDraft, record)) {
        return;
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      setDraftSaveStatus("pending");
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushDraft(nextDraft).catch(() => undefined);
      }, 350);
    },
    [flushDraft, record, restoreLocked],
  );

  const cancelScheduledDraftSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const waitForDraftSaves = useCallback(async () => {
    await draftSaveQueueRef.current;
  }, []);

  const waitForPendingAssets = useCallback(async () => {
    while (pendingAssetTasksRef.current.size > 0) {
      await Promise.all(Array.from(pendingAssetTasksRef.current));
    }
  }, []);

  const trackAssetTask = useCallback(<T,>(task: Promise<T>): Promise<T> => {
    const tracked = task.then(() => undefined);
    pendingAssetTasksRef.current.add(tracked);
    void tracked.catch(() => undefined).finally(() => {
      pendingAssetTasksRef.current.delete(tracked);
    });
    return task;
  }, []);

  const setCurrentDraft = useCallback(
    (nextDraft: RecordBlock, options: { autosave?: boolean } = {}) => {
      const cleanDraft = syncEditableRecord(nextDraft);
      draftRef.current = cleanDraft;
      setDraft(cleanDraft);
      if (options.autosave !== false && !draftLoadingRef.current) {
        scheduleDraftSave(cleanDraft);
      }
      return cleanDraft;
    },
    [scheduleDraftSave],
  );

  useEffect(() => {
    if (!restoreLocked) {
      return;
    }
    cancelScheduledDraftSave();
    ignoreEditorChangesRef.current = true;
    setMoreActionsOpen(false);
    setEditingState(false);
    onEditingChange?.(false);
  }, [cancelScheduledDraftSave, onEditingChange, restoreLocked]);

  useEffect(() => {
    let cancelled = false;
    const loadingRecord = record;
    const loadSequence = ++draftLoadSequenceRef.current;
    const loadingRecordId = loadingRecord.id;
    draftLoadingRef.current = true;
    setDraftLoading(true);
    cancelScheduledDraftSave();
    ignoreEditorChangesRef.current = true;
    recordIdRef.current = loadingRecordId;
    setDraftRestored(false);
    setMoreActionsOpen(false);
    setTagInput("");
    setEditingTagIndex(null);
    setEditingState(false);
    onEditingChange?.(false);

    const loadDraft = async () => {
      const loadStartedDuringCommit = committingRef.current;
      let storedDraft: RecordDraft | undefined;
      try {
        storedDraft = await onGetDraft(loadingRecordId);
      } catch {
        storedDraft = undefined;
      }
      if (cancelled || loadSequence !== draftLoadSequenceRef.current || recordIdRef.current !== loadingRecordId) {
        return;
      }
      if (!loadStartedDuringCommit && !committingRef.current && storedDraft && storedDraft.updatedAt > loadingRecord.updatedAt) {
        const restored = cloneRecord(storedDraft.draft);
        pendingDecisionBlockRemovalsRef.current = new Map(
          (storedDraft.decisionBlockRemovals ?? []).map((removal) => [removal.decisionBlockId, removal]),
        );
        restoredDecisionBlocksRef.current = new Map(
          (storedDraft.restoredDecisionBlocks ?? []).map((block) => [block.decisionBlockId, block.contentHtml]),
        );
        setDraft(restored);
        draftRef.current = restored;
        draftLoadingRef.current = false;
        setDraftLoading(false);
        setEditing(true);
        setDraftRestored(true);
        return;
      }
      const clean = cloneRecord(loadingRecord);
      pendingDecisionBlockRemovalsRef.current.clear();
      restoredDecisionBlocksRef.current.clear();
      setDraft(clean);
      draftRef.current = clean;
      draftLoadingRef.current = false;
      setDraftLoading(false);
      if (loadStartedDuringCommit || committingRef.current) {
        setDraftRestored(false);
        return;
      }
      setEditing(initialEditingRef.current);
      setDraftRestored(false);
    };

    void loadDraft();

    return () => {
      cancelled = true;
      if (loadSequence === draftLoadSequenceRef.current) {
        draftLoadingRef.current = true;
      }
    };
  }, [cancelScheduledDraftSave, onGetDraft, onEditingChange, record.id, setEditing]);

  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState === "hidden") {
        void flushDraft().catch(() => undefined);
      }
    };
    const flushOnPageHide = () => {
      void flushDraft().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHide);
      window.removeEventListener("pagehide", flushOnPageHide);
      cancelScheduledDraftSave();
      if (!draftLoadingRef.current) {
        void flushDraft().catch(() => undefined);
      }
    };
  }, [cancelScheduledDraftSave, flushDraft]);

  useEffect(() => {
    if (!isDesktopPlatform()) {
      return undefined;
    }
    return registerDesktopFlushHandler(async () => {
      cancelScheduledDraftSave();
      await flushDraft(draftRef.current, { force: true });
    });
  }, [cancelScheduledDraftSave, flushDraft]);

  const update = (patch: Partial<RecordBlock>) => {
    if (draftLoadingRef.current || restoreLocked || ignoreEditorChangesRef.current) {
      return;
    }
    setCurrentDraft({ ...draftRef.current, ...patch, mistakeRefs: [] });
  };

  const applyTagInput = (target: RecordBlock, value = tagInput, editIndex = editingTagIndex): RecordBlock => {
    const candidates = value.split(/[，,]/).map(normalizeRecordTag).filter(Boolean);
    const tags = normalizeRecordTags(target.tags);
    if (editIndex !== null) {
      if (!tags[editIndex] || !candidates[0]) {
        return { ...target, tags };
      }
      tags[editIndex] = candidates[0];
      return { ...target, tags: normalizeRecordTags(tags) };
    }
    return candidates.length > 0 ? { ...target, tags: normalizeRecordTags([...tags, ...candidates]) } : { ...target, tags };
  };

  const commitTagInput = () => {
    const next = applyTagInput(draftRef.current);
    if (JSON.stringify(next.tags) !== JSON.stringify(draftRef.current.tags)) {
      setCurrentDraft(next);
    }
    setTagInput("");
    setEditingTagIndex(null);
  };

  const draftTags = normalizeRecordTags(draft.tags);
  const tagSuggestions = useMemo(() => {
    const query = recordTagKey(tagInput);
    if (!query) {
      return [];
    }
    const selected = new Set(draftTags.map(recordTagKey));
    return getSubjectRecordTags(referenceRecords, draft.subject)
      .filter((tag) => !selected.has(recordTagKey(tag)) && recordTagKey(tag).includes(query))
      .slice(0, 8);
  }, [draft.subject, draftTags, referenceRecords, tagInput]);

  const addSuggestedTag = (tag: string) => {
    update({ tags: normalizeRecordTags([...draftRef.current.tags, tag]) });
    setTagInput("");
    setEditingTagIndex(null);
  };

  const removeTag = (index: number) => {
    update({ tags: draftTags.filter((_, tagIndex) => tagIndex !== index) });
    if (editingTagIndex === index) {
      setTagInput("");
      setEditingTagIndex(null);
    }
  };

  const beginTagEdit = (index: number) => {
    setEditingTagIndex(index);
    setTagInput(draftTags[index] ?? "");
  };

  const insertAfterCurrentBlock = useCallback((editor: Editor, node: Record<string, unknown>) => {
    const { $from } = editor.state.selection;
    const insertPos = $from.end($from.depth);
    editor
      .chain()
      .focus()
      .insertContentAt(insertPos, [node, { type: "paragraph" }])
      .run();
  }, []);

  const addAsset = useCallback((editor: Editor, file: File, kind: Asset["kind"], title = file.name) => {
    if (restoreLocked || draftLoadingRef.current) {
      return Promise.resolve();
    }
    const targetRecordId = record.id;
    const task = (async () => {
      const asset = await onAddAsset(file, kind, title);
      if (draftLoadingRef.current || recordIdRef.current !== targetRecordId) {
        return;
      }
      insertAfterCurrentBlock(editor, {
        type: "recordAsset",
        attrs: { assetId: asset.id, title: asset.title ?? title, kind },
      });
      setCurrentDraft({ ...draftRef.current, contentHtml: editor.getHTML() });
    })();

    return trackAssetTask(task);
  }, [insertAfterCurrentBlock, onAddAsset, record.id, restoreLocked, setCurrentDraft, trackAssetTask]);

  const uploadPastedImage = useCallback(async (file: File) => {
    if (restoreLocked || draftLoadingRef.current) {
      return undefined;
    }
    const targetRecordId = record.id;
    const task = (async () => {
      const asset = await onAddAsset(file, "image", file.name || "剪贴板图片");
      if (draftLoadingRef.current || recordIdRef.current !== targetRecordId) {
        return undefined;
      }
      return { id: asset.id, kind: "image" as const, title: (asset.title ?? file.name) || "剪贴板图片" };
    })();
    return trackAssetTask(task);
  }, [onAddAsset, record.id, restoreLocked, trackAssetTask]);

  const pickNativeEditorImage = useCallback(async (editor: Editor) => {
    try {
      const file = await pickNativeGalleryImageFile("record-gallery-image");
      if (file) {
        await addAsset(editor, file, "image");
      }
    } catch (error) {
      window.alert(formatUiError(error, "generic"));
    }
  }, [addAsset]);

  const stopRecordingIntoDraft = useCallback(async () => {
    if (stoppingRecordingRef.current) {
      return stoppingRecordingRef.current;
    }

    const task = (async () => {
      const recorder = audioRecorderRef.current;
      const wasRecording = Boolean(recorder?.isRecording());
      let file: File | null = null;
      if (wasRecording) {
        file = await recorder!.stopAndGetFile();
      }
      if (!file && wasRecording && canUseNativeAudioRecorder()) {
        const nativeStatus = await getNativeAudioRecordingStatus().catch(() => ({ recording: false }));
        if (nativeStatus.recording) {
          file = await stopNativeAudioRecording().catch(() => null);
        }
      }
      if (!file) {
        return;
      }

      const editor = editorRef.current;
      if (editor && !editor.isDestroyed) {
        await addAsset(editor, file, "audio", "录音");
        await flushDraft();
        return;
      }

      const asset = await onAddAsset(file, "audio", "录音");
      const nextDraft = setCurrentDraft({
        ...draftRef.current,
        contentHtml: `${draftRef.current.contentHtml || "<p></p>"}${recordAssetHtml(asset, "audio", "录音")}`,
      });
      await flushDraft(nextDraft);
    })();

    stoppingRecordingRef.current = task;
    try {
      await task;
    } finally {
      stoppingRecordingRef.current = null;
    }
  }, [addAsset, flushDraft, onAddAsset, setCurrentDraft]);

  const back = () => {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;
    editorRef.current?.commands.cancelMarkdownPasteConversion?.();
    void (async () => {
      try {
        await stopRecordingIntoDraft();
        await flushDraft();
      } catch {
        // Returning must not depend on a recorder or storage operation completing.
      } finally {
        leavingRef.current = false;
      }
    })();
    onBack();
  };

  useEffect(() => () => {
    editorRef.current?.commands.cancelMarkdownPasteConversion?.();
  }, []);

  const exportCurrentRecord = useCallback(async () => {
    if (!onExportRecord || exporting) {
      return;
    }
    setExporting(true);
    setExportMessage(null);
    try {
      setExportMessage(await onExportRecord(record.id));
    } catch (error) {
      setExportMessage(formatUiError(error, "generic"));
    } finally {
      setExporting(false);
      setMoreActionsOpen(false);
    }
  }, [exporting, onExportRecord, record.id]);

  useEffect(() => () => {
    void stopRecordingIntoDraft();
  }, [stopRecordingIntoDraft]);

  const save = async () => {
    if (saving || interactionLocked) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    committingRef.current = true;
    ignoreEditorChangesRef.current = true;
    let draftToSave: RecordBlock | null = null;
    try {
      cancelScheduledDraftSave();
      editorRef.current?.commands.cancelMarkdownPasteConversion?.();
      await waitForPendingAssets();
      await waitForDraftSaves();

      const editor = editorRef.current;
      draftToSave = syncEditableRecord({
        ...applyTagInput(draftRef.current),
        contentHtml: editor && !editor.isDestroyed ? editor.getHTML() : draftRef.current.contentHtml,
      });
      draftRef.current = draftToSave;
      setDraft(draftToSave);
      setTagInput("");
      setEditingTagIndex(null);

      const introducedDecisionBlocks = extractDecisionBlocks(record.contentHtml).length === 0
        && extractDecisionBlocks(draftToSave.contentHtml).length > 0;
      let shouldJoinReview = false;
      if (introducedDecisionBlocks && reviewState?.status !== "active") {
        shouldJoinReview = isNewRecord || window.confirm("这条日志新增了复习重点，是否把整条日志加入间隔复习？");
      }

      await onSave(draftToSave, {
        decisionBlockRemovals: Array.from(pendingDecisionBlockRemovalsRef.current.values()),
        restoredDecisionBlocks: Array.from(restoredDecisionBlocksRef.current, ([decisionBlockId, contentHtml]) => ({ decisionBlockId, contentHtml })),
      });
      pendingDecisionBlockRemovalsRef.current.clear();
      restoredDecisionBlocksRef.current.clear();
      if (shouldJoinReview) await onAddToReview?.(record.id);
      await refreshDecisionBlockArchives();
      await waitForDraftSaves();
      await onDeleteDraft(record.id);
      setDraftRestored(false);
      initialEditingRef.current = false;
      setEditing(false);
    } catch (error) {
      committingRef.current = false;
      ignoreEditorChangesRef.current = false;
      const fallbackDraft = draftToSave ?? draftRef.current;
      draftRef.current = fallbackDraft;
      setDraft(fallbackDraft);
      await flushDraft(fallbackDraft, { force: true }).catch(() => undefined);
      setSaveError(formatUiError(error, "record-save"));
    } finally {
      committingRef.current = false;
      setSaving(false);
    }
  };

  const discardDraft = async () => {
    if (interactionLocked) {
      return;
    }
    cancelScheduledDraftSave();
    await waitForDraftSaves();
    await onDeleteDraft(record.id);
    const clean = cloneRecord(record);
    pendingDecisionBlockRemovalsRef.current.clear();
    restoredDecisionBlocksRef.current.clear();
    setDraft(clean);
    draftRef.current = clean;
    setDraftRestored(false);
    setSaveError(null);
    setEditing(false);
  };

  const remove = async () => {
    if (restoreLocked) {
      return;
    }
    const ok = window.confirm(`确定删除“${record.title}”吗？\n\n删除后会进入回收站，30 天内可以恢复。`);
    if (!ok) {
      return;
    }
    setSaving(true);
    await onDeleteDraft(record.id);
    await onDelete(record.id);
    setSaving(false);
  };

  const toggleFavorite = async () => {
    if (restoreLocked) {
      return;
    }
    await onToggleFavorite(record, !record.favorite);
  };

  const reviewKindText = reviewKindLabel(reviewState?.reviewKind);
  const reviewButtonText = reviewState?.status === "active"
    ? reviewState.nextReviewDate
      ? `${reviewKindText} ${reviewState.nextReviewDate.slice(5)}`
      : reviewKindText
    : reviewState?.status === "mastered"
      ? "已掌握"
      : "加入复习";

  const addReview = async () => {
    if (restoreLocked) {
      return;
    }
    await onAddToReview?.(record.id);
  };

  const closeMoreActions = () => setMoreActionsOpen(false);

  return (
    <main className={`${interactionLocked ? "page record-editor-page restore-locked" : "page record-editor-page"}${wideContent ? " wide-content" : ""}`} aria-busy={interactionLocked}>
      {draftLoading && <p className="status-message draft-status">正在读取草稿，编辑已暂时锁定。</p>}
      {!draftLoading && restoreLocked && <p className="status-message draft-status">正在恢复备份，编辑已暂时锁定。</p>}
      <section className="record-editor-topbar">
        <button type="button" className="secondary-button" onClick={() => void back()} disabled={draftLoading}>
          <ArrowLeft size={18} />
          返回
        </button>
        <span className={`record-save-indicator ${draftSaveStatus === "error" || saveError ? "error" : ""}`} role="status">
          {saving ? "正在保存正式内容..." : !editing ? "正式内容已保存" : draftSaveStatus === "saving" || draftSaveStatus === "pending" ? "正在保存本机草稿..." : draftSaveStatus === "error" ? "本机草稿保存失败" : "草稿已存于本机"}
        </span>
        {editing ? (
          <div className="record-action-row">
            {draftRestored && (
              <button type="button" className="secondary-button collapsible-action" onClick={() => void discardDraft()} disabled={saving || interactionLocked}>
                <RotateCcw size={17} />
                丢弃草稿
              </button>
            )}
            {onAddToReview && (
              <button
                type="button"
                className={`secondary-button review-inline-button collapsible-action ${reviewState?.status === "active" ? "active" : ""}`}
                onClick={() => {
                  if (reviewState?.status !== "active") {
                    void addReview();
                  }
                }}
                disabled={saving || interactionLocked}
              >
                <CalendarCheck size={17} />
                {reviewButtonText}
              </button>
            )}
            <button
              type="button"
              className={`icon-button collapsible-action ${record.favorite ? "active" : ""}`}
              onClick={() => void toggleFavorite()}
              disabled={saving || interactionLocked}
              aria-label={record.favorite ? "取消收藏" : "收藏记录"}
            >
              <Star size={18} fill={record.favorite ? "currentColor" : "none"} />
            </button>
            <button type="button" className="icon-button danger collapsible-action" onClick={() => void remove()} disabled={saving || interactionLocked} aria-label="删除记录">
              <Trash2 size={18} />
            </button>
            {isDesktopPlatform() && (
              <button
                type="button"
                className={`icon-button${searchOpen ? " active" : ""}`}
                aria-label="查找替换"
                onClick={() => setSearchOpen((o) => !o)}
              >
                <Search size={18} />
              </button>
            )}
            <div className="record-more-actions">
              <button
                type="button"
                className={`icon-button ${moreActionsOpen ? "active" : ""}`}
                aria-label={moreActionsOpen ? "收起更多操作" : "更多操作"}
                aria-expanded={moreActionsOpen}
                onClick={() => setMoreActionsOpen((open) => !open)}
                disabled={saving || interactionLocked}
              >
                <MoreHorizontal size={18} />
              </button>
              {moreActionsOpen && (
                <div className="record-more-menu">
                  <label className="record-more-subject-control">
                    <span>学科</span>
                    <select
                      aria-label="日志学科"
                      value={draft.subject}
                      onChange={(event) => update({ subject: event.target.value })}
                      disabled={saving || interactionLocked}
                    >
                      {subjects
                        .filter((subject) => !subject.archivedAt || subject.name === draft.subject)
                        .sort((left, right) => left.order - right.order)
                        .map((subject) => <option key={subject.id} value={subject.name}>{subject.name}</option>)}
                    </select>
                  </label>
                  <button type="button" onClick={() => { setWideContent((value) => !value); closeMoreActions(); }}>
                    <PanelRight size={16} />
                    {wideContent ? "标准正文宽度" : "宽内容模式"}
                  </button>
                  {!isDesktopPlatform() && (
                    <button type="button" onClick={() => { setSearchOpen(true); closeMoreActions(); }}>
                      <Search size={16} />
                      查找替换
                    </button>
                  )}
                  {draftRestored && (
                    <button type="button" onClick={() => void discardDraft().finally(closeMoreActions)} disabled={saving || interactionLocked}>
                      <RotateCcw size={16} />
                      丢弃草稿
                    </button>
                  )}
                  {onAddToReview && (
                    <button
                      type="button"
                      onClick={() => {
                        if (reviewState?.status !== "active") {
                          void addReview().finally(closeMoreActions);
                        }
                      }}
                      disabled={saving || interactionLocked || reviewState?.status === "active"}
                    >
                      <CalendarCheck size={16} />
                      {reviewButtonText}
                    </button>
                  )}
                  {onExportRecord && (
                    <button type="button" onClick={() => void exportCurrentRecord()} disabled={exporting || interactionLocked}>
                      <Download size={16} />
                      {exporting ? "导出中..." : "导出此日志"}
                    </button>
                  )}
                  <button type="button" onClick={() => void Promise.resolve(toggleFavorite()).finally(closeMoreActions)} disabled={saving || interactionLocked}>
                    <Star size={16} fill={record.favorite ? "currentColor" : "none"} />
                    {record.favorite ? "取消收藏" : "收藏记录"}
                  </button>
                  <button type="button" className="danger" onClick={() => void remove().finally(closeMoreActions)} disabled={saving || interactionLocked}>
                    <Trash2 size={16} />
                    删除记录
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="primary-button" onClick={() => void save()} disabled={saving || interactionLocked}>
              <Save size={17} />
              {saving ? "保存中" : "保存"}
            </button>
          </div>
        ) : (
          <div className="record-action-row">
            {onOpenVoiceRecall && (
              <button type="button" className="secondary-button collapsible-action" onClick={() => onOpenVoiceRecall(record)}>
                <Mic size={17} />
                语音复述
              </button>
            )}
            {onAddToReview && (
              <button
                type="button"
                className={`secondary-button review-inline-button collapsible-action ${reviewState?.status === "active" ? "active" : ""}`}
                onClick={() => {
                  if (reviewState?.status !== "active") {
                    void addReview();
                  }
                }}
              >
                <CalendarCheck size={17} />
                {reviewButtonText}
              </button>
            )}
            <button
              type="button"
              className={`icon-button collapsible-action ${record.favorite ? "active" : ""}`}
              onClick={() => void toggleFavorite()}
              aria-label={record.favorite ? "取消收藏" : "收藏记录"}
            >
              <Star size={18} fill={record.favorite ? "currentColor" : "none"} />
            </button>
            {isDesktopPlatform() && (
              <button
                type="button"
                className={`icon-button${searchOpen ? " active" : ""}`}
                aria-label="查找"
                onClick={() => setSearchOpen((o) => !o)}
              >
                <Search size={18} />
              </button>
            )}
            <div className="record-more-actions">
              <button
                type="button"
                className={`icon-button ${moreActionsOpen ? "active" : ""}`}
                aria-label={moreActionsOpen ? "收起更多操作" : "更多操作"}
                aria-expanded={moreActionsOpen}
                onClick={() => setMoreActionsOpen((open) => !open)}
              >
                <MoreHorizontal size={18} />
              </button>
              {moreActionsOpen && (
                <div className="record-more-menu">
                  <button type="button" onClick={() => { setWideContent((value) => !value); closeMoreActions(); }}>
                    <PanelRight size={16} />
                    {wideContent ? "标准正文宽度" : "宽内容模式"}
                  </button>
                  {!isDesktopPlatform() && (
                    <button type="button" onClick={() => { setSearchOpen(true); closeMoreActions(); }}>
                      <Search size={16} />
                      查找
                    </button>
                  )}
                  {onAddToReview && (
                    <button
                      type="button"
                      onClick={() => {
                        if (reviewState?.status !== "active") {
                          void addReview().finally(closeMoreActions);
                        }
                      }}
                      disabled={reviewState?.status === "active"}
                    >
                      <CalendarCheck size={16} />
                      {reviewButtonText}
                    </button>
                  )}
                  {onExportRecord && (
                    <button type="button" onClick={() => void exportCurrentRecord()} disabled={exporting}>
                      <Download size={16} />
                      {exporting ? "导出中..." : "导出此日志"}
                    </button>
                  )}
                  {onOpenVoiceRecall && (
                    <button type="button" onClick={() => { onOpenVoiceRecall(record); closeMoreActions(); }}>
                      <Mic size={16} />
                      语音复述
                    </button>
                  )}
                  <button type="button" onClick={() => void Promise.resolve(toggleFavorite()).finally(closeMoreActions)}>
                    <Star size={16} fill={record.favorite ? "currentColor" : "none"} />
                    {record.favorite ? "取消收藏" : "收藏记录"}
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="primary-button" onClick={() => setEditing(true)} disabled={interactionLocked}>
              <Edit3 size={17} />
              编辑
            </button>
          </div>
        )}
      </section>

      {editing ? (
        <>
          {draftRestored && <p className="status-message draft-status">已恢复未保存草稿，点击保存后才会写入正式记录。</p>}
          {saveError && <p className="status-message draft-status">{saveError}</p>}
          {exportMessage && <p className="status-message draft-status">{exportMessage}</p>}
          <section className="record-editor-head">
            <textarea className="record-title-input" rows={1} value={draft.title} onChange={(event) => update({ title: event.target.value })} aria-label="记录标题" disabled={interactionLocked} />
            <div className="record-tag-editor">
              <span className="record-tag-label">标签</span>
              <div className="record-tag-input-wrap">
                {draftTags.map((tag, index) => (
                  <span key={tag} className="record-tag-editor-item" style={recordTagStyle(draft.subject, tag)}>
                    <button type="button" className="record-tag-editor-name" onClick={() => beginTagEdit(index)} disabled={interactionLocked}>
                      {tag}
                    </button>
                    <button type="button" className="record-tag-editor-remove" onClick={() => removeTag(index)} aria-label={`移除标签 ${tag}`} disabled={interactionLocked}>
                      <X size={13} />
                    </button>
                  </span>
                ))}
                <input
                  className="record-tag-input"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === "," || event.key === "，") {
                      event.preventDefault();
                      commitTagInput();
                    }
                  }}
                  placeholder={editingTagIndex === null ? "添加标签" : "修改标签"}
                  aria-label="日志标签"
                  disabled={interactionLocked}
                />
              </div>
              {tagSuggestions.length > 0 && (
                <div className="record-tag-suggestions" role="listbox" aria-label="已有标签">
                  {tagSuggestions.map((tag) => (
                    <button key={tag} type="button" role="option" onClick={() => addSuggestedTag(tag)}>
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
          <RichTextEditor
            value={draft.contentHtml}
            onChange={(contentHtml) => update({ contentHtml })}
            readOnly={interactionLocked}
            placeholder="像笔记页一样，把文字、思路、截图、公式和录音放进同一个记录块..."
            onAssetTitleChange={onAssetTitleChange}
            onPasteImage={uploadPastedImage}
            currentRecordId={record.id}
            referenceRecords={referenceRecords}
            referenceSubjects={subjects}
            findReplaceOpen={searchOpen}
            onFindReplaceOpen={() => setSearchOpen(true)}
            onFindReplaceClose={() => setSearchOpen(false)}
            restorableDecisionBlocks={restorableDecisionBlocks}
            onDecisionBlockRemoved={(removal) => {
              pendingDecisionBlockRemovalsRef.current.set(removal.decisionBlockId, removal);
              restoredDecisionBlocksRef.current.delete(removal.decisionBlockId);
            }}
            onDecisionBlockRestored={(archive) => {
              pendingDecisionBlockRemovalsRef.current.delete(archive.decisionBlockId);
              restoredDecisionBlocksRef.current.set(archive.decisionBlockId, archive.contentHtml);
            }}
            renderInsertTools={(editor) => {
              editorRef.current = editor;
              return (
              <>
                {native ? (
                  <button type="button" className="editor-file-button" title="图片" onClick={() => void pickNativeEditorImage(editor)}>
                    <ImagePlus size={16} />
                  </button>
                ) : (
                  <label className="editor-file-button" title="图片">
                    <ImagePlus size={16} />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void addAsset(editor, file, "image");
                        event.target.value = "";
                      }}
                    />
                  </label>
                )}
                <label className="editor-file-button" title="音频">
                  <Volume2 size={16} />
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void addAsset(editor, file, "audio");
                      event.target.value = "";
                    }}
                  />
                </label>
                <AudioRecorder compact ref={audioRecorderRef} onRecorded={(file) => void addAsset(editor, file, "audio", "录音")} />
                <label className="editor-file-button" title="附件">
                  <FilePlus size={16} />
                  <input
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void addAsset(editor, file, "attachment");
                      event.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  title="公式"
                  onClick={() =>
                    insertAfterCurrentBlock(editor, {
                      type: "recordFormula",
                      attrs: { formulaId: newId(), title: "公式", latex: "T(n)=O(n\\log n)" },
                    })
                  }
                >
                  <Pi size={16} />
                </button>
                <StructureInsertMenu
                  compact
                  onInsert={(kind) => insertAfterCurrentBlock(editor, structureBlockNode(kind))}
                />
                <TemplateInsertMenu
                  compact
                  templates={templates}
                  onInsert={(template) => editor.chain().focus().insertContent(
                    renewDecisionBlockIdentitiesInHtml(template.contentHtml, nowISO()),
                  ).run()}
                />
              </>
              );
            }}
          />
        </>
      ) : (
        <article className="record-view-page">
          <header className="record-view-header">
            <p className="eyebrow">{record.date}</p>
            <h1>{record.title}</h1>
            <span>{record.subject}</span>
            <RecordTagChips subject={record.subject} tags={record.tags} />
          </header>
          <RichTextEditor
            value={normalizeRecordContent(record)}
            onChange={() => undefined}
            placeholder=""
            readOnly
            highlightedAssetId={highlightedAssetId}
            onAssetChanged={onAssetChanged}
            onAssetTitleChange={onAssetTitleChange}
            currentRecordId={record.id}
            referenceRecords={referenceRecords}
            referenceSubjects={subjects}
            onOpenRecordReference={onOpenRecordReference}
            findReplaceOpen={searchOpen}
            onFindReplaceOpen={() => setSearchOpen(true)}
            onFindReplaceClose={() => setSearchOpen(false)}
          />
          {exportMessage && <p className="status-message">{exportMessage}</p>}
          {(reviewState || reviewLogs.length > 0) && (
            <section className="record-review-panel">
              <details open>
                <summary>复习进度</summary>
                <div className="record-review-summary">
                  <span>{reviewState?.status === "mastered" ? "已掌握" : reviewState?.status === "active" ? "复习中" : "未在队列中"}</span>
                  <strong>{reviewKindText}</strong>
                  <small>累计复习 {reviewState?.totalReviews ?? reviewLogs.length} 次</small>
                  {reviewState?.nextReviewDate && <small>下次复习：{reviewState.nextReviewDate}</small>}
                  {reviewLogs[0] && <small>最近评分：{ratingLabel(reviewLogs[0].rating)}</small>}
                </div>
                <div className="record-review-actions">
                  {onSetReviewKind && reviewState && (
                    <div className="review-kind-toggle" role="group" aria-label="复习类型">
                      {(["overview", "memory"] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          className={(reviewState.reviewKind ?? "overview") === kind ? "active" : ""}
                          onClick={() => {
                            if ((reviewState.reviewKind ?? "overview") !== kind) {
                              void onSetReviewKind(record.id, kind);
                            }
                          }}
                        >
                          {reviewKindLabel(kind)}
                        </button>
                      ))}
                    </div>
                  )}
                  {onResetReview && (
                    <button type="button" className="secondary-button" onClick={() => void onResetReview(record.id)}>
                      <RotateCcw size={16} />
                      重置复习
                    </button>
                  )}
                  {onRemoveReview && reviewState?.status === "active" && (
                    <button type="button" className="secondary-button danger" onClick={() => void onRemoveReview(record.id)}>
                      移出复习队列
                    </button>
                  )}
                </div>
                {reviewLogs.length > 0 && (
                  <div className="record-review-history">
                    {reviewLogs.slice(0, 12).map((log) => (
                      <article key={log.id}>
                        <div>
                          <strong>{isoDateTimeToLocalDate(log.reviewedAt)} · {ratingLabel(log.rating)}</strong>
                          <small>间隔 {log.previousIntervalDays} 天 → {log.nextIntervalDays} 天</small>
                        </div>
                        {log.evaluationText?.trim() && <p className="record-review-evaluation">{log.evaluationText}</p>}
                      </article>
                    ))}
                  </div>
                )}
              </details>
            </section>
          )}
        </article>
      )}
    </main>
  );
};
