import { describe, expect, it, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: createMock };
  },
}));

describe("extractListingFields", () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("parses a well-formed structured JSON response", async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Cordless drill",
            category: "tools",
            askingPrice: 80,
            condition: "good",
            riskSignals: [],
            requiredFieldsPresent: 0.8,
            photoQuality: 0.5,
          }),
        },
      ],
    });

    const { extractListingFields } = await import("../src/extract.js");
    const result = await extractListingFields({ rawText: "Cordless drill, good condition, $80" });

    expect(result.title).toBe("Cordless drill");
    expect(result.category).toBe("tools");
    expect(result.askingPrice).toBe(80);
    expect(result.riskSignals).toEqual([]);
  });

  it("throws cleanly when the response has no text block", async () => {
    createMock.mockResolvedValue({ content: [] });

    const { extractListingFields } = await import("../src/extract.js");
    await expect(extractListingFields({ rawText: "anything" })).rejects.toThrow(
      "no text block",
    );
  });

  it("throws cleanly when the text block isn't valid JSON", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "not json" }],
    });

    const { extractListingFields } = await import("../src/extract.js");
    await expect(extractListingFields({ rawText: "anything" })).rejects.toThrow();
  });
});
