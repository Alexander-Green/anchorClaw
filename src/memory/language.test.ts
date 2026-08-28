import { describe, expect, it } from "vitest";
import { looksLikeCode, primarySearchConfig, resolveSearchConfigs } from "./language.js";

describe("resolveSearchConfigs", () => {
  it("detects prose by language once there is enough text", () => {
    expect(primarySearchConfig("пользователи работают в банках и часто путешествуют")).toBe("russian");
    expect(primarySearchConfig("the users are working in the banks and traveling often")).toBe("english");
    expect(primarySearchConfig("los usuarios trabajan en los bancos y viajan frecuentemente")).toBe("spanish");
    expect(primarySearchConfig("les utilisateurs travaillent dans les banques et voyagent souvent")).toBe("french");
  });

  it("routes mixed Russian and English text to russian", () => {
    // The russian configuration sends ASCII tokens through the English stemmer,
    // so a single configuration handles both halves of this text.
    expect(primarySearchConfig("сделали backfill записей и переиндексировали таблицу поиска")).toBe("russian");
  });

  it("falls back to the script when a detected language has no configuration", () => {
    // Devanagari text is often reported as a language PostgreSQL does not ship
    // (Magahi, for one); the script still identifies a usable configuration.
    expect(primarySearchConfig("उपयोगकर्ता बैंकों में काम करते हैं और अक्सर यात्रा करते हैं")).toBe("hindi");
  });

  it("uses the script for short records and indexes them under several configurations", () => {
    expect(resolveSearchConfigs("записей")).toEqual(["russian", "simple"]);
    expect(resolveSearchConfigs("backfill")).toEqual(["english", "simple"]);
  });

  it("keeps code out of language detection", () => {
    expect(resolveSearchConfigs("const pool = new pg.Pool({ connectionString: PGURL });")).toEqual(["simple"]);
    expect(resolveSearchConfigs("src/memory/search.ts")).toEqual(["simple"]);
  });

  it("falls back for scripts without a configuration", () => {
    expect(resolveSearchConfigs("我在银行工作喜欢编程")).toEqual(["simple"]);
    expect(resolveSearchConfigs("")).toEqual(["simple"]);
    expect(resolveSearchConfigs("   ")).toEqual(["simple"]);
  });

  it("recognises non-prose without misfiring on ordinary sentences", () => {
    expect(looksLikeCode("await client.query('BEGIN')")).toBe(true);
    expect(looksLikeCode("пользователь предпочитает короткие объяснения")).toBe(false);
  });
});
