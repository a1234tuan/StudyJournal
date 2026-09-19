const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDesktopContextMenuTemplate } = require("./contextMenu.cjs");

const findItem = (template, role) => template.find((item) => item.role === role);

test("shows native editing commands for a selected editable target", () => {
  const template = buildDesktopContextMenuTemplate({
    isEditable: true,
    selectionText: "选中的内容",
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
    },
  });

  assert.equal(findItem(template, "undo").enabled, true);
  assert.equal(findItem(template, "cut").enabled, true);
  assert.equal(findItem(template, "copy").enabled, true);
  assert.equal(findItem(template, "paste").enabled, true);
  assert.equal(findItem(template, "pasteAndMatchStyle").enabled, true);
  assert.equal(findItem(template, "delete").enabled, true);
  assert.equal(findItem(template, "selectAll").enabled, true);
});

test("keeps copy/select-all available on read-only text and disables mutations", () => {
  const template = buildDesktopContextMenuTemplate({
    isEditable: false,
    selectionText: "只读内容",
    editFlags: { canCopy: true, canPaste: true, canCut: true, canDelete: true },
  });

  assert.equal(findItem(template, "copy").enabled, true);
  assert.equal(findItem(template, "selectAll").enabled, true);
  assert.equal(findItem(template, "cut").enabled, false);
  assert.equal(findItem(template, "paste").enabled, false);
  assert.equal(findItem(template, "delete").enabled, false);
});

test("does not enable copy or cut without a selection", () => {
  const template = buildDesktopContextMenuTemplate({
    isEditable: true,
    selectionText: "",
    editFlags: {},
  });

  assert.equal(findItem(template, "copy").enabled, false);
  assert.equal(findItem(template, "cut").enabled, false);
  assert.equal(findItem(template, "paste").enabled, true);
});
