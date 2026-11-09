#!/usr/bin/env bun
// OPTIONAL OVERLAY — the collaboration git cannot see: PRs, reviews, comments,
// and self-reported profile affiliation.
//
// Deliberately separate from `pull`. The git spine is offline, tokenless, and
// reproducible by anyone who clones this repo; this is none of those things.
// Git-only acquisition explicitly omits this layer. A full acquisition fails
// closed if it cannot collect a complete overlay; deployment keeps the last
// successful site. GraphQL cost is reported at the end of each pull.
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { ensureDir, loadRepos, p } from "./lib/data.ts";
import {
  COMMENT_FIELDS, COMMENTS_AFTER_QUERY, nestedConn, parseGraphQLBody, profileData, REVIEW_FIELDS,
  REVIEWS_AFTER_QUERY, strictData, walkConnection, walkNested,
  type GraphQLResponse, type Page,
} from "./lib/github.ts";
import { addBridge, bareLogin } from "./lib/identity.ts";
import type { GitHubEvent, Item, Profile } from "./lib/types.ts";

const OWNER = "Universal-Commerce-Protocol";
// Measured at 100 PRs x 50 nested x 50 nested = 2 points, and lowered to 25 when
// review bodies joined the query: 100 pull requests carrying up to 100 reviews of
// arbitrary-length prose overran whatever response ceiling sits in front of the
// API, which answers with an HTML error page rather than a GraphQL error. Points
// are charged per page, so this costs more requests and the same rate budget --
// the pull is bounded by wall clock, not by the 5000/hr limit.
const PAGE = 25;
// Nested reviews and comments arrive 100 at a time (GitHub's hard maximum, see
// NESTED in lib/github.ts) and are continued by cursor. ucp#340's 94 reviews were
// first caught by a truncation guard at 50; ucp#780's 108 then exceeded the
// ceiling itself, so raising the page size stopped being an available fix.
const PROFILE_BATCH = 50;

const gh = (args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

let points = 0;

/**
 * One `gh api graphql` request, parsed but NOT judged: whether an error is
 * tolerable depends on the caller. Event acquisition fails on any error
 * (`strictData`); a profile batch may lose specific missing users (`profileData`).
 *
 * `gh` exits non-zero whenever the body carries GraphQL errors, so stdout is read
 * regardless of exit status and the body decides.
 *
 * Variables go with `-f` (raw string), not `-F`: `-F` reads a value starting with
 * `@` as a file and coerces `true`/`null`/digits, and cursors and node ids are
 * opaque strings that must reach GitHub unchanged.
 */
function request(query: string, vars: Record<string, string> = {}): GraphQLResponse {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const parsed = parseGraphQLBody(res.stdout, res.stderr || String(res.status));
  points += parsed.data?.rateLimit?.cost ?? 0;
  return parsed;
}

/** Event acquisition: data, or an exception naming every GraphQL error. */
const graphql = (query: string, vars: Record<string, string> = {}) =>
  strictData(request(query, vars), "GraphQL request");

type Actor = { login?: string } | null;
type Conn<T> = Page<T>;
type CommentNode = { author?: Actor; createdAt: string; databaseId?: number };
/**
 * The most recent CLOSED_EVENT, for its actor.
 *
 * `last:1` and not `first:1` because an item can be closed, reopened and closed
 * again; the actor that matters is the one whose close still stands. GitHub emits
 * MERGED_EVENT rather than CLOSED_EVENT for a merge, so this is empty on merged
 * pull requests, which is the correct absence rather than a gap.
 */
type ClosedBy = { nodes: { actor?: Actor }[] };
type ReviewNode = { author?: Actor; state?: string; submittedAt?: string | null; databaseId?: number;
                    bodyText?: string };
type PullNode = {
  id: string;
  number: number;
  createdAt: string;
  title: string;
  state: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  mergeCommit?: { oid: string } | null;
  author?: Actor;
  timelineItems?: ClosedBy;
  reviews?: Conn<ReviewNode>;
  comments?: Conn<CommentNode>;
};
type IssueNode = {
  id: string;
  number: number;
  createdAt: string;
  title: string;
  state: string;
  closedAt?: string | null;
  author?: Actor;
  timelineItems?: ClosedBy;
  comments?: Conn<CommentNode>;
};

const login = (a?: Actor) => (a?.login ? bareLogin(a.login) : null);
/** The actor whose close still stands, normalized like every other login. */
const closer = (t?: ClosedBy) => login(t?.nodes?.at(-1)?.actor) ?? undefined;

// Full timestamps, not dates. Two events on one day must still order correctly
// in a feed, or "landed #501" sorts above "opened #501".
const events: GitHubEvent[] = [];
let skippedPendingReviews = 0;

/**
 * Registry of every PR and issue, keyed `repo#number`.
 *
 * Kept separate from the event stream because reviews and comments are
 * many-per-PR: storing the title on each of ~3,700 comment events would
 * duplicate it endlessly. Events reference `repo#number`; this resolves it.
 *
 * It also carries the thing the old schema could not express — a PR's verdict.
 * `merged: false` conflated 123 still-open PRs with 224 closed-unmerged ones,
 * which mean opposite things: pending versus declined.
 */
const registry: Record<string, Item> = {};

// GitHub's PR states are OPEN | MERGED | CLOSED, where CLOSED means
// closed-without-merging. "landed"/"declined" name outcomes rather than the
// mechanics of a button press.
const PR_STATE: Record<string, string> = { OPEN: "open", MERGED: "landed", CLOSED: "declined" };
// email -> login as asserted by GitHub per commit. A machine-stated identity
// fact with no time dimension, so derive may consume it without review.
const bridge = new Map<string, string>();

/** Walk a top-level cursor-paginated connection, accumulating every node. */
function pages<T>(query: string, repo: string, kind: string, pick: (d: any) => Page<T>): T[] {
  return walkConnection<T>(`${repo} ${kind}`, null,
    (cursor) => pick(graphql(query, { owner: OWNER, name: repo, ...(cursor ? { cursor } : {}) })));
}

const PR_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  rateLimit{cost}
  repository(owner:$owner,name:$name){
    pullRequests(first:${PAGE},after:$cursor,orderBy:{field:CREATED_AT,direction:DESC}){
      totalCount pageInfo{hasNextPage endCursor}
      nodes{id number createdAt title state mergedAt closedAt mergeCommit{oid} author{login}
        timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}}
        ${nestedConn("reviews", REVIEW_FIELDS)}
        ${nestedConn("comments", COMMENT_FIELDS)}}
    }
  }
}`;

const ISSUE_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  rateLimit{cost}
  repository(owner:$owner,name:$name){
    issues(first:${PAGE},after:$cursor,orderBy:{field:CREATED_AT,direction:DESC}){
      totalCount pageInfo{hasNextPage endCursor}
      nodes{id number createdAt title state closedAt author{login}
        timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}}
        ${nestedConn("comments", COMMENT_FIELDS)}}
    }
  }
}`;

// Nested connections arrive 100 at a time; every one is walked to its end, and
// any page that cannot be continued or does not sum to totalCount throws BEFORE
// any snapshot file is replaced — partial data would look like a complete overlay.
// This runs before the registry entry and events for the item are written, so a
// failure leaves nothing half-recorded even in memory.
for (const { name } of loadRepos()) {
  process.stdout.write(`${name.padEnd(11)} `);

  const pulls = pages<PullNode>(PR_QUERY, name, "pullRequests", (d) => d.repository.pullRequests);
  for (const pr of pulls) {
    const owner = login(pr.author);
    const reviews = walkNested<ReviewNode>(graphql, `${name}#${pr.number} reviews`, pr.id,
      pr.reviews, REVIEWS_AFTER_QUERY, "reviews");
    const prComments = walkNested<CommentNode>(graphql, `${name}#${pr.number} comments`, pr.id,
      pr.comments, COMMENTS_AFTER_QUERY, "comments");

    registry[`${name}#${pr.number}`] = {
      kind: "pr", repo: name, number: pr.number, title: pr.title, author: owner,
      at: pr.createdAt, state: PR_STATE[pr.state] ?? pr.state.toLowerCase(),
      endedAt: pr.mergedAt ?? pr.closedAt ?? undefined,
      closedBy: pr.mergedAt ? undefined : closer(pr.timelineItems),
      // The FULL id, as GitHub states it. It used to be cut to the spine's 12
      // characters here, which made a merge object missing from the mirror
      // unrecoverable: an abbreviation resolves only against objects already
      // present, and fetching by id needs all 40. A join against `Commit.sha`
      // abbreviates at the join instead.
      sha: pr.mergeCommit?.oid,
    };

    // One event per review SUBMISSION, stamped with when it was submitted.
    //
    // This layer records facts; derive.ts makes the judgments. Two judgments
    // used to live here and cost us real data:
    //
    //   1. Collapsing rounds into a Set. "Five rounds on one PR is one PR
    //      reviewed" is correct for the metric, but doing it here made revision
    //      cycles unrecoverable without a re-pull.
    //   2. Stamping every review with pr.createdAt. The org-at-event-date
    //      resolution in derive.ts then attributed reviews to whoever the
    //      reviewer worked for when the PR was OPENED — silently defeating the
    //      affiliation-span mechanism this tool is built around, and making
    //      time-to-first-review uncomputable.
    //
    // Self-reviews are kept here too and filtered in derive: whether your own
    // COMMENTED entry on your own PR counts as review labour is a judgment.
    for (const r of reviews) {
      // GraphQL exposes a PENDING review only to its own author. The live overlay
      // contained one belonging to the token owner, so counting it would make
      // totals depend on whose token ran the pull; it also has no event time.
      if (!r.submittedAt) {
        skippedPendingReviews++;
        continue;
      }
      const who = login(r.author);
      if (!who) continue;
      events.push({
        repo: name, kind: "review", login: who, number: pr.number,
        at: r.submittedAt,
        self: who === owner || undefined,
        // Anchors the activity log at the review itself rather than the top of a
        // pull request that may carry 90 of them.
        id: r.databaseId,
        // LENGTH ONLY. The text is fetched and discarded here, never written to
        // raw/, because the measurement is "did this person write prose, and how
        // much" and the prose itself is other people's words.
        //
        // Why this field exists at all. GitHub wraps BOTH kinds of review in the
        // same object: a design-level critique lives in `bodyText` with no inline
        // comments, while a line-level review is an empty shell around N
        // `review_comment` children. We counted the children and ignored the
        // body, so a 7,462-character critique measured the same as clicking
        // Approve -- and the undercount fell entirely on people who review at the
        // design level. On ucp alone that is 373 reviews and 160,366 characters
        // of writing that no figure on the site could see.
        chars: r.bodyText?.length || undefined,
      });
    }

    for (const c of prComments) {
      const who = login(c.author);
      if (who) {
        events.push({
          repo: name, kind: "comment", login: who, at: c.createdAt, number: pr.number,
          id: c.databaseId,
        });
      }
    }
  }

  const issues = pages<IssueNode>(ISSUE_QUERY, name, "issues", (d) => d.repository.issues);
  for (const issue of issues) {
    const issueComments = walkNested<CommentNode>(graphql, `${name}!${issue.number} comments`, issue.id,
      issue.comments, COMMENTS_AFTER_QUERY, "comments");
    const owner = login(issue.author);
    // Issues share the `repo#number` keyspace with PRs on GitHub, so a comment
    // event resolves unambiguously against either.
    registry[`${name}#${issue.number}`] = {
      kind: "issue", repo: name, number: issue.number, title: issue.title, author: owner,
      at: issue.createdAt, state: issue.state.toLowerCase(),
      endedAt: issue.closedAt ?? undefined,
      closedBy: closer(issue.timelineItems),
    };
    for (const c of issueComments) {
      const who = login(c.author);
      if (who) {
        events.push({
          repo: name, kind: "comment", login: who, at: c.createdAt, number: issue.number,
          id: c.databaseId,
        });
      }
    }
  }

  // Inline review comments: the line-level ones, attached to a file and a line
  // rather than to the pull request's timeline.
  //
  // REST rather than GraphQL because GraphQL only exposes these three levels
  // deep (pullRequests -> reviewThreads -> comments), and two levels already
  // makes this query 502. REST has a flat repo-wide listing, so it is one
  // paginated call and no truncation guard.
  //
  // Recorded under their own kind because they ARE a different object with a
  // different anchor (`#discussion_r`, not `#issuecomment`). Whether they also
  // count as comments is a judgment, and judgments belong in derive.
  const inlineRows = gh([
    "api", `repos/${OWNER}/${name}/pulls/comments`, "--paginate",
    "-q", '.[] | [.user.login, .created_at, (.pull_request_url | split("/") | last), .id] | @tsv',
  ]);
  let inlineCount = 0;
  for (const line of inlineRows.split("\n")) {
    const [who, at, number, id] = line.split("\t");
    if (!who || !at || !number) continue;
    events.push({
      repo: name, kind: "review_comment", login: bareLogin(who),
      at, number: Number(number), id: Number(id),
    });
    inlineCount++;
  }

  // REST, because the commit->account association is not worth a GraphQL query.
  const rows = gh([
    "api", `repos/${OWNER}/${name}/commits`, "--paginate",
    "-q", '.[] | [.commit.author.email, (.author.login // "")] | @tsv',
  ]);
  for (const line of rows.split("\n")) {
    const [email, who] = line.split("\t");
    if (email && who) addBridge(bridge, email, who);
  }

  console.log(`${pulls.length} PRs, ${issues.length} issues, ${inlineCount} inline comments`);
}

// --- profiles ---------------------------------------------------------------
// Self-reported `company`, batched ~50 per request. Fed to `audit` as a
// SUGGESTION only. It is a point-in-time free-text claim with no history, so
// consuming it automatically would write an unbounded span from a "today"
// snapshot and erase anyone's previous employer. It is also genuinely messy:
// one real value in this dataset is "Primarily coding in private repos."
const logins = [...new Set([
  ...events.map((e) => e.login),
  ...Object.values(registry).map((i) => i.author).filter((a): a is string => Boolean(a)),
])].sort();
const profiles: Record<string, Profile> = {};
const missingProfiles: string[] = [];

for (let i = 0; i < logins.length; i += PROFILE_BATCH) {
  const batch = logins.slice(i, i + PROFILE_BATCH);
  const fields = batch
    .map((l, j) => `u${j}: user(login:${JSON.stringify(l)}){` +
      `login name company location bio websiteUrl ` +
      `socialAccounts(first:10){nodes{provider url}}}`)
    .join(" ");
  // Bots and deleted accounts resolve to null with a NOT_FOUND error attached;
  // profileData keeps the rest of the batch for exactly that case, fails on any
  // other error, and names who was missing so the loss is reported, not silent.
  const { data, missing } = profileData(request(`query{rateLimit{cost} ${fields}}`),
    batch.map((_, j) => `u${j}`));
  for (const alias of missing) missingProfiles.push(batch[Number(alias.slice(1))]!);
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith("u") || !v) continue;
    const u = v as Profile & { login: string };
    const social = (v as any).socialAccounts?.nodes ?? [];
    // Deduplicated because websiteUrl and a GENERIC social account are often the
    // same URL, and a duplicate would look like two independent confirmations.
    const links = [...new Set([
      ...(( v as any).websiteUrl ? [(v as any).websiteUrl] : []),
      ...social.map((s: any) => s?.url).filter(Boolean),
    ] as string[])];
    profiles[u.login.toLowerCase()] = {
      name: u.name, company: u.company, location: u.location,
      bio: (v as any).bio || null,
      ...(links.length ? { links } : {}),
    };
  }
  process.stdout.write(`\rprofiles    ${Object.keys(profiles).length}/${logins.length}`);
}
console.log();

ensureDir(p("raw"));
writeFileSync(p("raw/github.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(p("raw/items.json"), JSON.stringify(registry, null, 1));
writeFileSync(p("raw/logins.json"), JSON.stringify(Object.fromEntries([...bridge].sort()), null, 1));
writeFileSync(p("raw/profiles.json"), JSON.stringify(profiles, null, 1));

const n = (k: string) => events.filter((e) => e.kind === k).length;
const items = Object.values(registry);
const byState = (k: string, s: string) =>
  items.filter((i) => i.kind === k && i.state === s).length;
// Self-closed: withdrawn by their own author. Reported here because it is the
// figure that decides whether a declined pull request is a verdict or a no-op,
// and a pull that silently stopped collecting it would be hard to notice.
const selfClosed = items.filter((i) => i.closedBy && i.closedBy === i.author).length;
const closedKnown = items.filter((i) => i.closedBy).length;
const withCompany = Object.values(profiles).filter((p) => p.company).length;
const withLinks = Object.values(profiles).filter((p) => p.links?.length).length;
console.log(
  `\nwrote raw/github.jsonl  ${events.length} events — ` +
    `${n("review")} reviews, ${n("comment")} comments, ${n("review_comment")} inline\n` +
    `wrote raw/items.json    ${items.length} items — PRs: ` +
    `${byState("pr", "landed")} landed, ${byState("pr", "open")} open, ` +
    `${byState("pr", "declined")} declined · ${items.filter((i) => i.kind === "issue").length} issues\n` +
    `  closers known         ${closedKnown}, of which ${selfClosed} closed their own\n` +
    `wrote raw/logins.json   ${bridge.size} email→login bridges\n` +
    `wrote raw/profiles.json ${Object.keys(profiles).length} profiles, ` +
    `${withCompany} list a company, ${withLinks} publish a link\n` +
    `skipped pending reviews ${skippedPendingReviews} token-private drafts without event times\n` +
    `unresolved profiles     ${missingProfiles.length}${missingProfiles.length ? ` (${missingProfiles.join(", ")})` : ""}\n` +
    `${logins.length} distinct logins · ${points} GraphQL points spent`,
);
