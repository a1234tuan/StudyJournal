const flag = (editFlags, name, fallback) =>
  typeof editFlags?.[name] === "boolean" ? editFlags[name] : fallback;

/**
 * Build the native Electron context-menu template for the focused webContents.
 * The roles deliberately use Chromium's editing commands so ProseMirror's
 * existing copy/cut/paste event handlers remain the single clipboard path.
 */
const buildDesktopContextMenuTemplate = (params = {}) => {
  const editFlags = params.editFlags || {};
  const editable = Boolean(params.isEditable);
  const hasSelection = Boolean(String(params.selectionText || "").trim());
  const canCopy = flag(editFlags, "canCopy", hasSelection);
  const canCut = editable && flag(editFlags, "canCut", hasSelection);
  const canPaste = editable && flag(editFlags, "canPaste", true);
  const canDelete = editable && flag(editFlags, "canDelete", hasSelection);
  const canUndo = editable && flag(editFlags, "canUndo", false);
  const canRedo = editable && flag(editFlags, "canRedo", false);

  return [
    { label: "撤销", role: "undo", enabled: canUndo },
    { label: "重做", role: "redo", enabled: canRedo },
    { type: "separator" },
    { label: "剪切", role: "cut", enabled: canCut },
    { label: "复制", role: "copy", enabled: canCopy },
    { label: "粘贴", role: "paste", enabled: canPaste },
    { label: "仅粘贴文本", role: "pasteAndMatchStyle", enabled: canPaste },
    { label: "删除", role: "delete", enabled: canDelete },
    { type: "separator" },
    { label: "全选", role: "selectAll", enabled: true },
  ];
};

module.exports = { buildDesktopContextMenuTemplate };
