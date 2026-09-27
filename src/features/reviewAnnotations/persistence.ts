import type { ReviewAnnotationDraft } from "./domain";
import { reviewAnnotationRepository } from "./repository";

type Repository = Pick<typeof reviewAnnotationRepository, "openDraft" | "upsertDraft">;

export const createAnnotationPersistence = (repository: Repository) => {
  const pending = new Map<string, ReviewAnnotationDraft>();
  const writes = new Map<string, Promise<void>>();

  const stage = (draft: ReviewAnnotationDraft) => { pending.set(draft.id, draft); };

  const flush = (id: string): Promise<void> => {
    const running = writes.get(id);
    if (running) return running;
    if (!pending.has(id)) return Promise.resolve();
    const write = async () => {
      while (pending.has(id)) {
        const draft = pending.get(id)!;
        const saved = await repository.upsertDraft(draft);
        if (saved === false) {
          if (pending.get(id) === draft) pending.delete(id);
          throw new Error("批注版本已变化，旧草稿未覆盖当前版本。请重新打开复习记录。");
        }
        if (pending.get(id) === draft) pending.delete(id);
      }
    };
    const result = write().finally(() => { if (writes.get(id) === result) writes.delete(id); });
    writes.set(id, result);
    return result;
  };

  return {
    stage,
    flush,
    hasPending: (id: string) => pending.has(id) || writes.has(id),
    async open(draft: ReviewAnnotationDraft) {
      await flush(draft.id);
      return repository.openDraft(draft);
    },
  };
};

export const reviewAnnotationPersistence = createAnnotationPersistence(reviewAnnotationRepository);
