const fs = require("node:fs/promises");
const path = require("node:path");
const safeRepositoryName = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,179}$/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error("备份仓库名称无效。");
  return value;
};
const assertRepositoryPath = async (root, candidate) => {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("备份仓库路径超出绑定目录。");
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = segment ? path.join(current, segment) : current;
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("备份仓库不允许符号链接或目录联接。"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  }
};
module.exports = { safeRepositoryName, assertRepositoryPath };
