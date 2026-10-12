import { compareJournalLabels, type JournalTopic } from "../../lib/journalFilters";
import { KnowledgeError } from "./domain";
import { isKnowledgeVisible } from "./protocol";
import { knowledgeLabel } from "./query";
import { knowledgeTables, type KnowledgeRepository } from "./repository";

export const loadJournalTopics = async (repository: KnowledgeRepository): Promise<JournalTopic[]> => {
  return repository.database.transaction("r", knowledgeTables(repository.database), () => readJournalTopics(repository));
};

const readJournalTopics = async (repository: KnowledgeRepository): Promise<JournalTopic[]> => {
  const owner = repository.currentOwner();
  const generation = repository.contextGeneration();
  const database = repository.database;
  const libraries = await repository.listLibraries();
  const migrations = await database.knowledgeLibraryMigrations.where("ownerScope").equals(owner).toArray();
  const protectedIds = new Set<string>();
  for (const command of await database.knowledgeCommands.filter(command => command.status === "blocked" && !!command.recoveryLibraryId).toArray()) protectedIds.add(command.recoveryLibraryId!);
  for (const sync of await database.knowledgeSyncState.filter(sync => !!sync.failure?.recoveryLibraryId).toArray()) protectedIds.add(sync.failure!.recoveryLibraryId!);
  const available = libraries.filter(library => !library.detached && !library.restoreSessionId && !protectedIds.has(library.id)
    && !migrations.some(migration => (migration.sourceLibraryId === library.id && migration.phase !== "local-copying") || (migration.targetLibraryId === library.id && migration.phase === "local-copying")));
  const topics: JournalTopic[] = [];
  for (const library of available) {
    const { state } = await repository.open(library.id);
    const byWorkspace = new Map<string, Set<string>>();
    for (const entity of Object.values(state.entities)) {
      if (entity.kind !== "reference" || !isKnowledgeVisible(state, entity)) continue;
      const ids = byWorkspace.get(entity.workspaceId) ?? new Set<string>();
      ids.add(entity.recordId);
      byWorkspace.set(entity.workspaceId, ids);
    }
    for (const entity of Object.values(state.entities)) {
      if (entity.kind === "workspace" && isKnowledgeVisible(state, entity)) topics.push({ owner, libraryId: library.id, libraryTitle: library.title, workspaceId: entity.id, title: knowledgeLabel(state, entity), recordIds: byWorkspace.get(entity.id) ?? new Set() });
    }
  }
  if (owner !== repository.currentOwner() || generation !== repository.contextGeneration()) throw new KnowledgeError("scope", "账号已变化，请重新选择专题");
  return topics.sort((left, right) => compareJournalLabels(left.title, right.title) || compareJournalLabels(left.libraryTitle, right.libraryTitle) || left.workspaceId.localeCompare(right.workspaceId));
};
