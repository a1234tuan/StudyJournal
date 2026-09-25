import type { StudyJournalDatabase } from "../../db/database";
import { KnowledgeError, type KnowledgeLibrary, type KnowledgeOwner } from "./domain";

export const getDefaultKnowledgeLibrary = async (database: StudyJournalDatabase, owner: KnowledgeOwner): Promise<KnowledgeLibrary | undefined> => {
  const binding = await database.knowledgeSyncBindings.get(owner);
  if (binding?.localLibraryId) {
    const library = await database.knowledgeLibraries.get(binding.localLibraryId);
    if (!library || library.ownerScope !== owner || library.cloudLibraryId !== binding.cloudLibraryId) throw new KnowledgeError("missing", "默认知识库映射不完整，本机内容保留");
    const copying = await database.knowledgeLibraryMigrations.where("targetLibraryId").equals(library.id).filter(migration => migration.phase === "local-copying").first();
    if (copying) return database.knowledgeLibraries.get(copying.sourceLibraryId);
    return library;
  }
  const libraries = await database.knowledgeLibraries.where("ownerScope").equals(owner).toArray();
  const migrations = await database.knowledgeLibraryMigrations.where("ownerScope").equals(owner).toArray();
  const copying = migrations.find(migration => migration.phase === "local-copying");
  if (copying) return database.knowledgeLibraries.get(copying.sourceLibraryId);
  const available = libraries.filter(library => !library.detached && !library.restoreSessionId && !migrations.some(migration => migration.sourceLibraryId === library.id));
  return available.find(library => library.cloudLibraryId) ?? available[0];
};
