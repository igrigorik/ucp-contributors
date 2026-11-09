import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  COMMENTS_AFTER_QUERY, NESTED, nestedConn, parseGraphQLBody, profileData, REVIEWS_AFTER_QUERY,
  strictData, walkConnection, walkNested, type Fetch, type GraphQLResponse, type Page,
} from "./github.ts";

// Deterministic fixtures: n nodes split into GitHub-shaped pages of `size`, with
// cursors `c1`, `c2`, ... naming the end of each page. Mirrors the live shape that
// broke the pull: ucp#780, 108 reviews, first page capped at 100.
type Node = { databaseId: number; submittedAt: string | null };
function paged(n: number, size = NESTED, total = n): Page<Node>[] {
  const nodes = Array.from({ length: n }, (_, i) => ({
    databaseId: i + 1, submittedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
  }));
  const out: Page<Node>[] = [];
  for (let i = 0; i < Math.max(n, 1); i += size) {
    const slice = nodes.slice(i, i + size);
    const last = i + size >= n;
    out.push({
      totalCount: total, nodes: slice,
      pageInfo: { hasNextPage: !last, endCursor: slice.length ? `c${out.length + 1}` : null },
    });
  }
  return out;
}

/** A Fetch backed by pages keyed by the cursor that requests them; records every call. */
function server(follow: Record<string, GraphQLResponse>, field: string) {
  const calls: { query: string; vars: Record<string, string> }[] = [];
  const fetch: Fetch = (query, vars) => {
    calls.push({ query, vars });
    const res = follow[vars.cursor!];
    if (!res) throw new Error(`unexpected cursor ${vars.cursor}`);
    return strictData(res, `test ${field}`);
  };
  return { fetch, calls };
}
const ok = (field: string, page: Page<Node> | null) => ({ data: { node: { [field]: page } } });

describe("walkNested over >100 nested nodes", () => {
  test("108 reviews: the first 100 from the parent, 8 more by cursor through node(id)", () => {
    const [p1, p2] = paged(108);
    const { fetch, calls } = server({ c1: ok("reviews", p2!) }, "reviews");
    const got = walkNested(fetch, "ucp#780 reviews", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews");
    expect(got.map((r) => r.databaseId)).toEqual(Array.from({ length: 108 }, (_, i) => i + 1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.vars).toEqual({ id: "PR_x", cursor: "c1" });
    expect(calls[0]!.query).toBe(REVIEWS_AFTER_QUERY);
  });

  test("250 comments walk three pages and preserve order", () => {
    const [p1, p2, p3] = paged(250);
    const { fetch, calls } = server({ c1: ok("comments", p2!), c2: ok("comments", p3!) }, "comments");
    const got = walkNested(fetch, "x!1 comments", "I_x", p1, COMMENTS_AFTER_QUERY, "comments");
    expect(got).toHaveLength(250);
    expect(new Set(got.map((c) => c.databaseId)).size).toBe(250);
    expect(calls.map((c) => c.vars.cursor)).toEqual(["c1", "c2"]);
  });

  test("exactly 100 is terminal on the first page: no follow-up request", () => {
    const [p1] = paged(100);
    const { fetch, calls } = server({}, "reviews");
    expect(walkNested(fetch, "r", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews")).toHaveLength(100);
    expect(calls).toHaveLength(0);
  });

  test("an empty connection is complete, not an error", () => {
    const empty = { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const { fetch } = server({}, "comments");
    expect(walkNested(fetch, "c", "I_x", empty, COMMENTS_AFTER_QUERY, "comments")).toEqual([]);
  });

  test("a pending review on a later page is returned for the caller to exclude, not dropped here", () => {
    const [p1, p2] = paged(101);
    p2!.nodes[0]!.submittedAt = null;
    const { fetch } = server({ c1: ok("reviews", p2!) }, "reviews");
    const got = walkNested(fetch, "r", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews");
    expect(got).toHaveLength(101);
    expect(got.filter((r) => !r.submittedAt)).toHaveLength(1);
  });

  test("a connection missing from the parent is malformed, not empty", () => {
    const { fetch } = server({}, "reviews");
    expect(() => walkNested(fetch, "r", "PR_x", undefined, REVIEWS_AFTER_QUERY, "reviews"))
      .toThrow(/connection missing/);
    expect(() => walkNested(fetch, "r", "PR_x", null, REVIEWS_AFTER_QUERY, "reviews"))
      .toThrow(/connection missing/);
  });

  test("a follow-up whose node does not resolve fails", () => {
    const [p1] = paged(108);
    const { fetch } = server({ c1: { data: { node: null } } }, "reviews");
    expect(() => walkNested(fetch, "r", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews")).toThrow(/did not resolve/);
  });

  test("a follow-up resolving to a node without the connection fails", () => {
    const [p1] = paged(108);
    const { fetch } = server({ c1: { data: { node: {} } } }, "reviews");
    expect(() => walkNested(fetch, "r", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews")).toThrow(/malformed/);
  });

  test("continuing without a node id fails rather than querying node(id:\"\")", () => {
    const [p1] = paged(108);
    const { fetch, calls } = server({}, "reviews");
    expect(() => walkNested(fetch, "r", "", p1, REVIEWS_AFTER_QUERY, "reviews")).toThrow(/node id/);
    expect(calls).toHaveLength(0);
  });
});

describe("walkNested fails closed on partial GraphQL errors", () => {
  test("an invalid cursor (data nulled + error) throws, never yields the first 100 alone", () => {
    const [p1] = paged(108);
    const { fetch } = server({
      c1: {
        data: { node: { reviews: null } },
        errors: [{ path: ["node", "reviews"], message: "`c1` does not appear to be a valid cursor." }],
      },
    }, "reviews");
    expect(() => walkNested(fetch, "r", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews")).toThrow(/valid cursor/);
  });

  test("an error alongside COMPLETE-looking data still throws", () => {
    const [p1, p2] = paged(108);
    const { fetch } = server({
      c1: { ...ok("reviews", p2!), errors: [{ type: "SERVICE_UNAVAILABLE", message: "timeout" }] },
    }, "reviews");
    expect(() => walkNested(fetch, "r", "PR_x", p1, REVIEWS_AFTER_QUERY, "reviews")).toThrow(/SERVICE_UNAVAILABLE/);
  });
});

describe("walkConnection cursor and count invariants", () => {
  const seq = (pages: Page<Node>[]) => {
    let i = 0;
    return (cursor: string | null) => {
      const page = pages[i++];
      if (!page) throw new Error(`no page for ${cursor}`);
      return page;
    };
  };

  test("starts from the beginning when no first page is given", () => {
    const pages = paged(30, 25);
    const cursors: (string | null)[] = [];
    const next = seq(pages);
    const got = walkConnection("top", null, (c) => (cursors.push(c), next(c)));
    expect(got).toHaveLength(30);
    expect(cursors).toEqual([null, "c1"]);
  });

  test("still supports a connection without totalCount", () => {
    const pages = paged(30, 25).map(({ totalCount: _, ...p }) => p);
    expect(walkConnection("top", null, seq(pages))).toHaveLength(30);
  });

  test("hasNextPage with a null endCursor throws", () => {
    const [p1] = paged(108);
    p1!.pageInfo.endCursor = null;
    expect(() => walkConnection("r", p1!, seq([]))).toThrow(/no endCursor/);
  });

  test("hasNextPage with an empty-string endCursor throws", () => {
    const [p1] = paged(108);
    p1!.pageInfo.endCursor = "";
    expect(() => walkConnection("r", p1!, seq([]))).toThrow(/no endCursor/);
  });

  test("a repeated cursor throws instead of looping", () => {
    const [p1, p2, p3] = paged(250);
    p2!.pageInfo.endCursor = "c1";
    expect(() => walkConnection("r", p1!, seq([p2!, p3!]))).toThrow(/repeated/);
  });

  test("an empty page that claims hasNextPage throws", () => {
    const [p1] = paged(108);
    const stall = { totalCount: 108, nodes: [], pageInfo: { hasNextPage: true, endCursor: "c2" } };
    expect(() => walkConnection("r", p1!, seq([stall]))).toThrow(/empty page/);
  });

  test("a terminal page short of totalCount throws (the old truncation guard, kept)", () => {
    const [p1, p2] = paged(108);
    p2!.nodes.pop();
    expect(() => walkConnection("r", p1!, seq([p2!]))).toThrow(/incomplete: totalCount 108 != 107/);
  });

  test("a single page that is short of totalCount and claims to be terminal throws", () => {
    const [p1] = paged(100, NESTED, 108);
    expect(() => walkConnection("r", p1!, seq([]))).toThrow(/incomplete/);
  });

  test("more nodes than totalCount throws", () => {
    const [p1, p2] = paged(108, NESTED, 105);
    expect(() => walkConnection("r", p1!, seq([p2!]))).toThrow(/exceed totalCount/);
  });

  test("totalCount moving between pages throws", () => {
    const [p1, p2] = paged(108);
    p2!.totalCount = 109;
    expect(() => walkConnection("r", p1!, seq([p2!]))).toThrow(/changed from 108 to 109/);
  });

  test("duplicate node identities fail even when totalCount remains stable", () => {
    const [p1, p2] = paged(108);
    p2!.nodes[0] = p1!.nodes[0]!;
    expect(() => walkConnection("r", p1!, seq([p2!]))).toThrow(/duplicate connection node identity/);
  });

  test("malformed pages report only safe shape metadata, never upstream node values", () => {
    const secret = "TOP-SECRET-PENDING-REVIEW";
    let message = "";
    try {
      walkConnection("r", { nodes: [{ databaseId: 1, bodyText: secret }], pageInfo: null } as any, seq([]));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("malformed connection page");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("bodyText");
  });

  test("a null or shapeless page throws", () => {
    expect(() => walkConnection("r", null as any, () => null as any)).toThrow(/malformed/);
    expect(() => walkConnection("r", { nodes: [] } as any, seq([]))).toThrow(/malformed/);
    expect(() => walkConnection("r", { nodes: null, pageInfo: { hasNextPage: false } } as any, seq([])))
      .toThrow(/malformed/);
  });
});

describe("strictData", () => {
  test("returns data when there are no errors", () => {
    expect(strictData({ data: { a: 1 } }, "x")).toEqual({ a: 1 });
    expect(strictData({ data: { a: 1 }, errors: [] }, "x")).toEqual({ a: 1 });
  });
  test("throws on any error even with data present, naming type and path", () => {
    expect(() => strictData({ data: { a: 1 }, errors: [{ type: "NOT_FOUND", path: ["a", 0], message: "m" }] }, "x"))
      .toThrow("x: GraphQL errors: NOT_FOUND at a.0: m");
  });
  test("throws when data is missing without serializing upstream values", () => {
    const secret = "TOP-SECRET-PENDING-REVIEW";
    expect(() => strictData({ errors: [], ...( { privateNode: { bodyText: secret } } as any) }, "x"))
      .toThrow(/no data/);
    try {
      strictData({ errors: [], ...( { privateNode: { bodyText: secret } } as any) }, "x");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe("profileData", () => {
  const nf = (alias: string) => ({
    type: "NOT_FOUND", path: [alias], message: `Could not resolve to a User with the login of '${alias}'.`,
  });

  test("tolerates NOT_FOUND on a requested alias that resolved to null, and reports it", () => {
    const res = { data: { rateLimit: { cost: 1 }, u0: { login: "a" }, u1: null }, errors: [nf("u1")] };
    const { data, missing } = profileData(res, ["u0", "u1"]);
    expect(missing).toEqual(["u1"]);
    expect(data.u0).toEqual({ login: "a" });
  });

  test("a non-NOT_FOUND error fails the batch", () => {
    const res = { data: { u0: { login: "a" }, u1: null }, errors: [{ ...nf("u1"), type: "FORBIDDEN" }] };
    expect(() => profileData(res, ["u0", "u1"])).toThrow(/FORBIDDEN/);
  });

  test("a NOT_FOUND nested inside a resolved user is not a missing user", () => {
    const res = { data: { u0: { login: "a", socialAccounts: null } }, errors: [{ ...nf("u0"), path: ["u0", "socialAccounts"] }] };
    expect(() => profileData(res, ["u0"])).toThrow(/u0\.socialAccounts/);
  });

  test("a NOT_FOUND that left data behind is not a missing user", () => {
    const res = { data: { u0: { login: "a" } }, errors: [nf("u0")] };
    expect(() => profileData(res, ["u0"])).toThrow(/NOT_FOUND/);
  });

  test("a NOT_FOUND on an alias that was never requested fails", () => {
    const res = { data: { u0: { login: "a" }, u9: null }, errors: [nf("u9")] };
    expect(() => profileData(res, ["u0"])).toThrow(/u9/);
  });

  test("an error with no path fails", () => {
    const res = { data: { u0: { login: "a" } }, errors: [{ type: "RATE_LIMITED", message: "slow down" }] };
    expect(() => profileData(res, ["u0"])).toThrow(/RATE_LIMITED/);
  });

  test("an alias null or absent WITHOUT an error is not skipped silently", () => {
    expect(() => profileData({ data: { u0: { login: "a" }, u1: null } }, ["u0", "u1"])).toThrow(/u1 resolved to nothing/);
    expect(() => profileData({ data: { u0: { login: "a" } } }, ["u0", "u1"])).toThrow(/u1 resolved to nothing/);
  });

  test("no data at all fails", () => {
    expect(() => profileData({ errors: [nf("u0")] }, ["u0"])).toThrow(/no data/);
  });
});

test("top-level pull request and issue queries request totalCount", () => {
  const source = readFileSync(new URL("../pull-github.ts", import.meta.url), "utf8");
  const topLevel = [...source.matchAll(/(pullRequests|issues)\(first:\$\{PAGE\}[\s\S]*?\)\{([\s\S]*?)nodes\{/g)];
  expect(topLevel).toHaveLength(2);
  for (const [, , selection] of topLevel) expect(selection).toContain("totalCount");
});

describe("parseGraphQLBody", () => {
  test("parses JSON and keeps errors for the caller to judge", () => {
    expect(parseGraphQLBody('{"data":{"a":1},"errors":[{"message":"m"}]}')).toEqual({
      data: { a: 1 }, errors: [{ message: "m" }],
    });
  });
  test("names an HTML gateway page instead of a JSON token error", () => {
    expect(() => parseGraphQLBody("<html>502 Bad Gateway</html>")).toThrow(/HTML error page/);
  });
  test("empty stdout reports stderr", () => {
    expect(() => parseGraphQLBody("", "gh: auth required")).toThrow(/auth required/);
  });
  test("a JSON non-object is rejected", () => {
    expect(() => parseGraphQLBody("null")).toThrow(/non-object/);
    expect(() => parseGraphQLBody("[1]")).toThrow(/non-object/);
  });
});

describe("query shape", () => {
  test("nested page size never exceeds GitHub's first:100 maximum", () => {
    expect(NESTED).toBeLessThanOrEqual(100);
  });
  test("every nested selection carries what pagination needs to continue and verify it", () => {
    for (const q of [nestedConn("reviews", "x"), REVIEWS_AFTER_QUERY, COMMENTS_AFTER_QUERY]) {
      expect(q).toContain("totalCount");
      expect(q).toContain("pageInfo{hasNextPage endCursor}");
      expect(q).toContain(`first:${NESTED}`);
    }
    expect(REVIEWS_AFTER_QUERY).toContain("after:$cursor");
    expect(COMMENTS_AFTER_QUERY).toMatch(/on PullRequest\{comments\(first:100,after:\$cursor\)/);
    expect(COMMENTS_AFTER_QUERY).toMatch(/on Issue\{comments\(first:100,after:\$cursor\)/);
  });
});
