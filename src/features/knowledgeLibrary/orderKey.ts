import { KnowledgeError, KNOWLEDGE_LIMITS } from "./domain";
import { knowledgeHash } from "./canonical";

export const ORDER_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const isOrderKey = (key: string): boolean => /^[0-9A-Za-z]+$/.test(key) && !key.endsWith("0") && key.length <= KNOWLEDGE_LIMITS.order;
export const compareOrder = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const orderBetween = (lower: string | null, upper: string | null, commandId: string): string => {
  if ((lower !== null && !isOrderKey(lower)) || (upper !== null && !isOrderKey(upper)) || (lower !== null && upper !== null && lower >= upper) || !commandId) {
    throw new KnowledgeError("invalid", "排序边界无效");
  }
  let prefix = "";
  let index = 0;
  let bounded = upper !== null;
  while (prefix.length < KNOWLEDGE_LIMITS.order) {
    const low = lower !== null && index < lower.length ? ORDER_ALPHABET.indexOf(lower[index]) : 0;
    const high = bounded && upper !== null && index < upper.length ? ORDER_ALPHABET.indexOf(upper[index]) : 62;
    if (high - low > 1) {
      const middle = prefix + ORDER_ALPHABET[Math.floor((low + high) / 2)];
      const result = middle + knowledgeHash(commandId) + "V";
      if (result.length > KNOWLEDGE_LIMITS.order) throw new KnowledgeError("budget", "此位置排序空间已达到安全限制，请选择另一位置");
      return result;
    }
    prefix += ORDER_ALPHABET[low];
    if (low < high) bounded = false;
    index += 1;
  }
  throw new KnowledgeError("budget", "此位置排序空间已达到安全限制，请选择另一位置");
};
