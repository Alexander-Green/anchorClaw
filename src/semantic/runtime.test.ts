import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveMemorySearchConfigMock,
  resolveAgentDirMock,
  getEmbeddingProviderMock,
  getMemoryEmbeddingProviderMock,
} = vi.hoisted(() => ({
  resolveMemorySearchConfigMock: vi.fn(),
  resolveAgentDirMock: vi.fn(() => "/tmp/agent"),
  getEmbeddingProviderMock: vi.fn(),
  getMemoryEmbeddingProviderMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", () => ({
  resolveMemorySearchConfig: resolveMemorySearchConfigMock,
  resolveAgentDir: resolveAgentDirMock,
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", () => ({
  getEmbeddingProvider: getEmbeddingProviderMock,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  getMemoryEmbeddingProvider: getMemoryEmbeddingProviderMock,
}));

import {
  buildSemanticEmbedding,
  probeSemanticProvider,
  resolveSemanticRuntimeProfile,
} from "./runtime.js";

describe("semantic runtime", () => {
  beforeEach(() => {
    resolveMemorySearchConfigMock.mockReset();
    resolveAgentDirMock.mockClear();
    getEmbeddingProviderMock.mockReset();
    getMemoryEmbeddingProviderMock.mockReset();
  });

  it("resolves profile metadata and stable profileKey from OpenClaw memorySearch", () => {
    resolveMemorySearchConfigMock.mockReturnValue({
      enabled: true,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
      inputType: undefined,
      queryInputType: "search_query",
      documentInputType: "search_document",
      outputDimensionality: 1536,
      local: {},
      fallback: "none",
    });

    const runtimeConfig = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai-compatible",
            model: "text-embedding-3-small",
            remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
          },
        },
        list: [{ id: "main" }],
      },
    };

    const first = resolveSemanticRuntimeProfile({
      cfg: { semantic: { enabled: true } },
      runtimeConfig,
      agentId: "main",
    });
    const second = resolveSemanticRuntimeProfile({
      cfg: { semantic: { enabled: true } },
      runtimeConfig,
      agentId: "main",
    });

    expect(first.profile).toMatchObject({
      configured: true,
      enabled: true,
      effective: true,
      source: "defaults",
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKeyConfigured: true,
    });
    expect(first.profile.profileKey).toHaveLength(64);
    expect(second.profile.profileKey).toBe(first.profile.profileKey);
  });

  it("reports disabled OpenClaw memorySearch when visible config exists but core resolves null", () => {
    resolveMemorySearchConfigMock.mockReturnValue(null);

    const result = resolveSemanticRuntimeProfile({
      cfg: { semantic: { enabled: true } },
      runtimeConfig: {
        agents: {
          defaults: {
            memorySearch: {
              provider: "openai-compatible",
              model: "text-embedding-3-small",
            },
          },
        },
      },
      agentId: "main",
    });

    expect(result.profile.error).toBe(
      "semantic enabled but OpenClaw memorySearch is disabled for the active agent",
    );
  });

  it("probes a generic embedding provider and reports dimensions", async () => {
    resolveMemorySearchConfigMock.mockReturnValue({
      enabled: true,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
      inputType: undefined,
      queryInputType: undefined,
      documentInputType: undefined,
      outputDimensionality: 3,
      local: {},
      fallback: "none",
    });
    getEmbeddingProviderMock.mockReturnValue({
      create: vi.fn(async () => ({
        provider: {
          id: "openai-compatible",
          model: "text-embedding-3-small",
          embed: vi.fn(async () => [0.1, 0.2, 0.3]),
          close: vi.fn(),
        },
      })),
    });

    const result = await probeSemanticProvider({
      cfg: { semantic: { enabled: true } },
      runtimeConfig: {
        agents: {
          defaults: {
            memorySearch: {
              provider: "openai-compatible",
              model: "text-embedding-3-small",
            },
          },
        },
      },
      agentId: "main",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      checked: true,
      providerKind: "generic",
      providerReachable: true,
      dimensions: 3,
    });
  });

  it("fails probe when provider returns unexpected dimensions", async () => {
    resolveMemorySearchConfigMock.mockReturnValue({
      enabled: true,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
      inputType: undefined,
      queryInputType: undefined,
      documentInputType: undefined,
      outputDimensionality: 3,
      local: {},
      fallback: "none",
    });
    getEmbeddingProviderMock.mockReturnValue({
      create: vi.fn(async () => ({
        provider: {
          id: "openai-compatible",
          model: "text-embedding-3-small",
          embed: vi.fn(async () => [0.1, 0.2]),
          close: vi.fn(),
        },
      })),
    });

    const result = await probeSemanticProvider({
      cfg: { semantic: { enabled: true } },
      runtimeConfig: {
        agents: {
          defaults: {
            memorySearch: {
              provider: "openai-compatible",
              model: "text-embedding-3-small",
            },
          },
        },
      },
      agentId: "main",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      checked: true,
      providerKind: "generic",
      providerReachable: false,
      error: "embedding dimensions mismatch: expected 3, got 2",
    });
  });

  it("passes query/document purpose to generic providers while create receives configured input types", async () => {
    resolveMemorySearchConfigMock.mockReturnValue({
      enabled: true,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
      inputType: "shared-input",
      queryInputType: "search_query",
      documentInputType: "search_document",
      outputDimensionality: 3,
      local: {},
      fallback: "none",
    });
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const create = vi.fn(async () => ({
      provider: {
        id: "openai-compatible",
        model: "text-embedding-3-small",
        embed,
        close: vi.fn(),
      },
    }));
    getEmbeddingProviderMock.mockReturnValue({ create });

    await buildSemanticEmbedding({
      cfg: { semantic: { enabled: true } },
      runtimeConfig: { agents: { list: [{ id: "main" }] } },
      agentId: "main",
      text: "query text",
      purpose: "query",
      timeoutMs: 1000,
    });
    await buildSemanticEmbedding({
      cfg: { semantic: { enabled: true } },
      runtimeConfig: { agents: { list: [{ id: "main" }] } },
      agentId: "main",
      text: "document text",
      purpose: "document",
      timeoutMs: 1000,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        inputType: "shared-input",
        queryInputType: "search_query",
        documentInputType: "search_document",
      }),
    );
    expect(embed).toHaveBeenNthCalledWith(
      1,
      "query text",
      expect.objectContaining({ inputType: "query" }),
    );
    expect(embed).toHaveBeenNthCalledWith(
      2,
      "document text",
      expect.objectContaining({ inputType: "document" }),
    );
  });
});
