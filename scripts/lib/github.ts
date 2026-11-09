// GraphQL plumbing for pull-github.ts: response classification and cursor
// pagination. Lives apart from the pull script because that script runs a pull
// on import; these rules decide whether a snapshot is complete, so they need to
// be importable and pinned by tests without a token or a network.
//
// Nothing in the git path imports this file. It belongs to the optional overlay
// as much as pull-github.ts does.

export type GraphQLError = { message?: string; type?: string; path?: (string | number)[] };
export type GraphQLResponse = { data?: any; errors?: GraphQLError[] };
export type PageInfo = { hasNextPage: boolean; endCursor: string | null };
export type Page<T> = { totalCount?: number; nodes: T[]; pageInfo: PageInfo };
/** Issues one GraphQL request and returns `data`, having already failed closed on errors. */
export type Fetch = (query: string, vars: Record<string, string>) => any;

/**
 * GitHub caps every connection at `first:100`; asking for 101 is a GraphQL error,
 * not a larger page. ucp#780 carries 108 reviews, so a single nested page cannot
 * hold every pull request and the rest are fetched by cursor.
 */
export const NESTED = 100;

// One selection per node kind, shared by the first page (inside the repository
// query) and every follow-up page, so the two cannot drift into recording
// different fields for reviews 1-100 and 101+.
export const REVIEW_FIELDS = "author{login} state submittedAt databaseId bodyText";
export const COMMENT_FIELDS = "author{login} createdAt databaseId";

/** A nested connection selection, carrying what `walkConnection` needs to continue it. */
export const nestedConn = (field: string, fields: string, after = "") =>
  `${field}(first:${NESTED}${after ? `,after:${after}` : ""}){` +
  `totalCount pageInfo{hasNextPage endCursor} nodes{${fields}}}`;

// Follow-up pages re-enter through `node(id:)` rather than re-walking the
// repository, so continuing one pull request's reviews costs one small request
// instead of re-fetching the 25-PR page that contained it.
export const REVIEWS_AFTER_QUERY = `query($id:ID!,$cursor:String!){
  rateLimit{cost}
  node(id:$id){... on PullRequest{${nestedConn("reviews", REVIEW_FIELDS, "$cursor")}}}
}`;
export const COMMENTS_AFTER_QUERY = `query($id:ID!,$cursor:String!){
  rateLimit{cost}
  node(id:$id){
    ... on PullRequest{${nestedConn("comments", COMMENT_FIELDS, "$cursor")}}
    ... on Issue{${nestedConn("comments", COMMENT_FIELDS, "$cursor")}}
  }
}`;

/**
 * Parses a `gh api graphql` body.
 *
 * A gateway timeout or an abuse-detection block answers with an HTML page, and
 * parsing that raised `Unrecognized token '<'` — an error that names neither the
 * cause nor the request. It cost a full pull to diagnose, so the response is
 * identified here instead of by its first character.
 */
export function parseGraphQLBody(body: string | undefined, stderr = ""): GraphQLResponse {
  const text = body?.trim();
  if (!text) throw new Error(`gh api graphql failed: ${stderr.trim() || "empty response"}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const kind = text.startsWith("<") ? "an HTML error page" : "a non-JSON response";
    throw new Error(
      `gh api graphql returned ${kind} (${text.length} bytes) rather than a result. ` +
        `This is usually the response being too large — reduce PAGE.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`gh api graphql returned a non-object (${typeof parsed})`);
  }
  return parsed as GraphQLResponse;
}

const describe = (errors: GraphQLError[]) =>
  errors.map((e) => `${e.type ?? "ERROR"}${e.path ? ` at ${e.path.join(".")}` : ""}: ${e.message}`)
    .join("; ");

/**
 * Event acquisition: ANY GraphQL error fails the pull.
 *
 * GraphQL returns partial data alongside errors, and for events partial data is
 * the dangerous case: a connection nulled by a timeout or an invalid cursor
 * looks exactly like a pull request with no reviews, and the snapshot would be
 * replaced by one that undercounts without saying so.
 */
export function strictData(res: GraphQLResponse, label: string): any {
  if (res.errors?.length) throw new Error(`${label}: GraphQL errors: ${describe(res.errors)}`);
  if (!res.data) {
    throw new Error(`${label}: GraphQL response carried no data (errors: ${res.errors?.length ?? 0})`);
  }
  return res.data;
}

/**
 * Profile batches: tolerate exactly one kind of error — a requested alias that
 * resolved to no user (bots, deleted or renamed accounts) — so one bad login
 * costs one profile, not fifty. Anything else fails: an error elsewhere in the
 * response, or a NOT_FOUND that left data behind, is not a missing user.
 *
 * Returns which aliases were missing so the caller can REPORT them; a tolerated
 * error that nobody sees is the silent failure this replaces.
 */
export function profileData(
  res: GraphQLResponse,
  aliases: readonly string[],
): { data: Record<string, unknown>; missing: string[] } {
  if (!res.data) {
    throw new Error(`profiles: GraphQL response carried no data (errors: ${res.errors?.length ?? 0})`);
  }
  const allowed = new Set(aliases);
  const missing: string[] = [];
  const material: GraphQLError[] = [];
  for (const e of res.errors ?? []) {
    const alias = e.path?.length === 1 ? String(e.path[0]) : undefined;
    if (e.type === "NOT_FOUND" && alias && allowed.has(alias) && res.data[alias] === null) {
      missing.push(alias);
    } else {
      material.push(e);
    }
  }
  if (material.length) throw new Error(`profiles: GraphQL errors: ${describe(material)}`);
  // The converse: an alias that came back null or absent WITHOUT a NOT_FOUND
  // explaining it would otherwise be skipped as quietly as a real missing user.
  const unexplained = aliases.filter((a) => !missing.includes(a) && !res.data[a]);
  if (unexplained.length) {
    throw new Error(`profiles: ${unexplained.join(", ")} resolved to nothing without an error`);
  }
  return { data: res.data, missing };
}

/**
 * Walks a cursor-paginated connection to its end, failing on anything that would
 * make the result silently incomplete.
 *
 * `first` is a page already in hand (a nested connection fetched inside its
 * parent); pass `null` to start from the beginning. `next(cursor)` fetches the
 * page after `cursor`.
 *
 * Fails, rather than returning what it has, when:
 *   - a page is not a connection (null, no nodes, no pageInfo);
 *   - hasNextPage is true with no endCursor, or with a cursor already seen;
 *   - hasNextPage is true on an empty page (no progress — would spin forever);
 *   - totalCount moves between pages (activity mid-pull; ordering may have shifted);
 *   - the nodes collected do not add up to totalCount when the walk ends.
 */
export function walkConnection<T>(
  label: string,
  first: Page<T> | null,
  next: (cursor: string | null) => Page<T>,
): T[] {
  const out: T[] = [];
  const seenCursors = new Set<string>();
  const seenNodes = new Set<string>();
  let page = first ?? next(null);
  let total: number | undefined;
  for (;;) {
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo ||
        typeof page.pageInfo.hasNextPage !== "boolean") {
      const kind = page === null ? "null" : Array.isArray(page) ? "array" : typeof page;
      const nodeCount = page && Array.isArray((page as any).nodes) ? (page as any).nodes.length : "unavailable";
      const pageInfoType = page && typeof (page as any).pageInfo;
      throw new Error(
        `${label}: malformed connection page (type=${kind}, nodes=${nodeCount}, pageInfo=${pageInfoType || "unavailable"})`,
      );
    }
    if (page.totalCount !== undefined) {
      if (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0) {
        throw new Error(`${label}: totalCount is not a non-negative integer`);
      }
      if (total !== undefined && page.totalCount !== total) {
        throw new Error(
          `${label}: totalCount changed from ${total} to ${page.totalCount} during pagination; re-run the pull`,
        );
      }
      total = page.totalCount;
    }
    for (const node of page.nodes) {
      const raw = node && typeof node === "object"
        ? ((node as any).id ?? (node as any).databaseId)
        : undefined;
      if ((typeof raw !== "string" && typeof raw !== "number") || raw === "") {
        throw new Error(`${label}: connection node has no stable identity (type=${typeof raw})`);
      }
      const identity = `${typeof raw}:${String(raw)}`;
      if (seenNodes.has(identity)) {
        throw new Error(`${label}: duplicate connection node identity after ${out.length} unique nodes`);
      }
      seenNodes.add(identity);
      out.push(node);
    }
    if (total !== undefined && out.length > total) {
      throw new Error(`${label}: ${out.length} nodes exceed totalCount ${total}`);
    }
    const { hasNextPage, endCursor } = page.pageInfo;
    if (!hasNextPage) break;
    if (typeof endCursor !== "string" || !endCursor) {
      throw new Error(`${label}: hasNextPage with no endCursor after ${out.length} nodes`);
    }
    if (seenCursors.has(endCursor)) {
      throw new Error(`${label}: pagination cursor repeated after ${out.length} nodes`);
    }
    if (!page.nodes.length) throw new Error(`${label}: empty page claims hasNextPage after ${out.length} nodes`);
    seenCursors.add(endCursor);
    page = next(endCursor);
  }
  if (total !== undefined && out.length !== total) {
    throw new Error(`${label} incomplete: totalCount ${total} != ${out.length} nodes`);
  }
  return out;
}

/**
 * Every node of a connection nested in a node with a global `id`, starting from
 * the first page that arrived inside the parent query.
 */
export function walkNested<T>(
  fetch: Fetch,
  label: string,
  id: string,
  first: Page<T> | null | undefined,
  query: string,
  field: string,
): T[] {
  // The parent query always selects the connection, so its absence is a
  // malformed response, not an empty one. Defaulting it to [] is how a dropped
  // field would silently become "no reviews".
  if (!first) throw new Error(`${label}: connection missing from parent response`);
  return walkConnection<T>(label, first, (cursor) => {
    if (!id) throw new Error(`${label}: cannot continue pagination without a node id`);
    const data = fetch(query, { id, cursor: cursor ?? "" });
    const node = data?.node;
    if (!node) throw new Error(`${label}: paginated node did not resolve`);
    return node[field];
  });
}
