import { describe, expect, test } from "vitest";
import { normalizeQueryList, normalizeWebSearchParams } from "../xai-web-search-shim.ts";

describe("normalizeQueryList", () => {
  test("trims and drops empties", () => {
    expect(normalizeQueryList([" a ", " ", "b", 1, null] as unknown[])).toEqual(["a", "b"]);
  });
});

describe("normalizeWebSearchParams", () => {
  test("prefers cleaned queries and drops blank query", () => {
    expect(
      normalizeWebSearchParams({
        query: "   ",
        queries: [" first ", " ", "second"],
        numResults: 3,
      }),
    ).toEqual({
      queries: ["first", "second"],
      numResults: 3,
    });
  });

  test("trims single query", () => {
    expect(normalizeWebSearchParams({ query: "  pi extensions  " })).toEqual({
      query: "pi extensions",
    });
  });
});
