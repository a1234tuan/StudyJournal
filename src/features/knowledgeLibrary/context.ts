import { KnowledgeError, type KnowledgeOwner } from "./domain";

let ownerScope: KnowledgeOwner = "deviceGuest";
let generation = 0;
export const currentKnowledgeOwner = (): KnowledgeOwner => ownerScope;
export const knowledgeContextGeneration = (): number => generation;
export const changeKnowledgeOwner = (next: KnowledgeOwner): void => {
  if (next !== ownerScope) { ownerScope = next; generation += 1; }
};
export const assertKnowledgeOwner = (expected: KnowledgeOwner, expectedGeneration: number): void => {
  if (ownerScope !== expected || generation !== expectedGeneration) throw new KnowledgeError("scope", "任务期间账号上下文已变化，请重新操作");
};
