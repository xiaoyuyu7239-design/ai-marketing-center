import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { settings, type Shot } from "@backend/db/schema";

export const STORE_MEMORY_KEY = "memory.store.v1";

export interface StoreMemory {
  storeName: string;
  mainCategories: string[];
  platforms: string[];
  toneTags: string[];
  preferredStyles: string[];
  ctaPhrases: string[];
  bannedPhrases: string[];
  likedExamples: Array<{
    productName: string;
    category: string;
    styleType: string;
    title: string;
    savedAt: string;
  }>;
  updatedAt: string;
}

export interface StoreMemoryPatch {
  storeName?: string;
  mainCategories?: string[];
  platforms?: string[];
  toneTags?: string[];
  preferredStyles?: string[];
  ctaPhrases?: string[];
  bannedPhrases?: string[];
}

export interface StoreMemoryContext {
  productName?: string;
  category?: string;
  platform?: string;
}

export interface LearnFromScriptInput {
  productName?: string;
  category?: string;
  styleType?: string;
  title?: string;
  shots?: Shot[];
}

const MAX_LIST = 10;
const MAX_EXAMPLES = 8;

export function defaultStoreMemory(): StoreMemory {
  return {
    storeName: "",
    mainCategories: [],
    platforms: [],
    toneTags: [],
    preferredStyles: [],
    ctaPhrases: [],
    bannedPhrases: [],
    likedExamples: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function cleanText(value: unknown, maxLen = 40) {
  return typeof value === "string" ? value.trim().slice(0, maxLen) : "";
}

function cleanList(values: unknown, maxLen = 40) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanText(value, maxLen)).filter(Boolean);
}

function mergeUnique(base: string[], extra: string[], max = MAX_LIST) {
  const out: string[] = [];
  for (const item of [...base, ...extra]) {
    const normalized = cleanText(item);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeStoreMemory(raw: unknown): StoreMemory {
  const base = defaultStoreMemory();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<StoreMemory>;
  return {
    storeName: cleanText(value.storeName, 60),
    mainCategories: mergeUnique([], cleanList(value.mainCategories)),
    platforms: mergeUnique([], cleanList(value.platforms)),
    toneTags: mergeUnique([], cleanList(value.toneTags)),
    preferredStyles: mergeUnique([], cleanList(value.preferredStyles)),
    ctaPhrases: mergeUnique([], cleanList(value.ctaPhrases, 80)),
    bannedPhrases: mergeUnique([], cleanList(value.bannedPhrases, 80)),
    likedExamples: Array.isArray(value.likedExamples)
      ? value.likedExamples
          .map((item) => ({
            productName: cleanText(item?.productName, 60),
            category: cleanText(item?.category),
            styleType: cleanText(item?.styleType),
            title: cleanText(item?.title, 80),
            savedAt: cleanText(item?.savedAt, 40) || base.updatedAt,
          }))
          .filter((item) => item.styleType || item.title || item.productName)
          .slice(0, MAX_EXAMPLES)
      : [],
    updatedAt: cleanText(value.updatedAt, 40) || base.updatedAt,
  };
}

export function applyStoreMemoryPatch(memory: StoreMemory, patch: StoreMemoryPatch): StoreMemory {
  return {
    ...memory,
    storeName: patch.storeName !== undefined ? cleanText(patch.storeName, 60) : memory.storeName,
    mainCategories:
      patch.mainCategories !== undefined ? mergeUnique([], cleanList(patch.mainCategories)) : memory.mainCategories,
    platforms: patch.platforms !== undefined ? mergeUnique([], cleanList(patch.platforms)) : memory.platforms,
    toneTags: patch.toneTags !== undefined ? mergeUnique([], cleanList(patch.toneTags)) : memory.toneTags,
    preferredStyles:
      patch.preferredStyles !== undefined ? mergeUnique([], cleanList(patch.preferredStyles)) : memory.preferredStyles,
    ctaPhrases: patch.ctaPhrases !== undefined ? mergeUnique([], cleanList(patch.ctaPhrases, 80)) : memory.ctaPhrases,
    bannedPhrases:
      patch.bannedPhrases !== undefined ? mergeUnique([], cleanList(patch.bannedPhrases, 80)) : memory.bannedPhrases,
    updatedAt: new Date().toISOString(),
  };
}

export function learnFromScript(memory: StoreMemory, input: LearnFromScriptInput): StoreMemory {
  const styleType = cleanText(input.styleType);
  const category = cleanText(input.category);
  const productName = cleanText(input.productName, 60);
  const title = cleanText(input.title, 80);
  const ctaPhrases = (input.shots ?? [])
    .filter((shot) => shot.type === "cta")
    .map((shot) => cleanText(shot.voiceover, 80))
    .filter(Boolean);
  const example = styleType || title || productName
    ? {
        productName,
        category,
        styleType,
        title,
        savedAt: new Date().toISOString(),
      }
    : null;

  const likedExamples = example
    ? [
        example,
        ...memory.likedExamples.filter(
          (item) =>
            `${item.productName}:${item.category}:${item.styleType}:${item.title}` !==
            `${example.productName}:${example.category}:${example.styleType}:${example.title}`
        ),
      ].slice(0, MAX_EXAMPLES)
    : memory.likedExamples;

  return {
    ...memory,
    mainCategories: category ? mergeUnique([category], memory.mainCategories) : memory.mainCategories,
    preferredStyles: styleType ? mergeUnique([styleType], memory.preferredStyles) : memory.preferredStyles,
    ctaPhrases: mergeUnique(ctaPhrases, memory.ctaPhrases),
    likedExamples,
    updatedAt: new Date().toISOString(),
  };
}

export function buildStoreMemoryHint(memory: StoreMemory, context: StoreMemoryContext = {}) {
  const lines: string[] = [];
  const sameCategoryExamples = memory.likedExamples
    .filter((item) => context.category && item.category === context.category)
    .slice(0, 2);
  const examples = sameCategoryExamples.length ? sameCategoryExamples : memory.likedExamples.slice(0, 2);

  if (memory.storeName) lines.push(`- 店铺名称/账号：${memory.storeName}`);
  if (memory.mainCategories.length) lines.push(`- 常卖品类：${memory.mainCategories.join("、")}`);
  if (memory.platforms.length) lines.push(`- 常发平台：${memory.platforms.join("、")}`);
  if (memory.toneTags.length) lines.push(`- 口吻偏好：${memory.toneTags.join("、")}`);
  if (memory.preferredStyles.length) lines.push(`- 用户喜欢的脚本风格：${memory.preferredStyles.join("、")}`);
  if (memory.ctaPhrases.length) lines.push(`- 常用结尾话术可参考：${memory.ctaPhrases.slice(0, 3).join(" / ")}`);
  if (memory.bannedPhrases.length) lines.push(`- 避免使用这些表达：${memory.bannedPhrases.join("、")}`);
  if (examples.length) {
    lines.push(
      `- 用户保存过的满意脚本：${examples
        .map((item) => `「${item.title || item.productName || item.styleType}」${item.styleType ? `(${item.styleType})` : ""}`)
        .join("、")}`
    );
  }

  if (!lines.length) return "";
  const contextLine = context.productName
    ? `本次商品：${context.productName}${context.category ? `（${context.category}）` : ""}。`
    : "";
  return `【店铺习惯记忆（用户希望系统越用越懂自己的店，生成时请自然参考，不要在文案里解释这些记忆）】\n${contextLine}\n${lines.join("\n")}`;
}

export async function getStoreMemory(): Promise<StoreMemory> {
  const db = getDb();
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, STORE_MEMORY_KEY));
  return normalizeStoreMemory(rows[0]?.value);
}

export async function saveStoreMemory(memory: StoreMemory) {
  const db = getDb();
  const next = normalizeStoreMemory({ ...memory, updatedAt: new Date().toISOString() });
  await db
    .insert(settings)
    .values({ key: STORE_MEMORY_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: new Date() },
    });
  return next;
}
