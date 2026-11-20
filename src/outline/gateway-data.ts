/**
 * What the embedded gateway returns of Outline's answers: a fixed set of
 * fields per kind of object, copied one by one. Anything else Outline sends
 * (policies, share links and their ids, user emails, avatars, collaborator
 * lists, the ProseMirror document tree, ...) is left out, so a field Outline
 * adds later never reaches a host.
 */

type Json = Record<string, unknown>;

const MAX_TREE_DEPTH = 25;
const MAX_TEXT_NODES = 20_000;

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A text, or null where Outline says there is none (a document without parent, a draft without publish date). */
function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : text(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The `data` of an Outline answer ({ data, pagination, policies }). */
export function dataOf(answer: unknown): unknown {
  return object(answer)?.data;
}

/** Only the fields that are set, in the order given. */
function pick(entries: Array<[string, unknown]>): Json {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

/** A user as the gateway shows one: id and name, never the email address or avatar. */
export function person(value: unknown): Json | undefined {
  const user = object(value);
  if (!user) return undefined;
  return pick([
    ['id', text(user.id)],
    ['name', text(user.name)],
  ]);
}

/** A document without its text. */
export function documentSummary(value: unknown): Json {
  const doc = object(value) ?? {};
  return pick([
    ['id', text(doc.id)],
    ['urlId', text(doc.urlId)],
    ['title', text(doc.title)],
    ['url', text(doc.url)],
    ['collectionId', text(doc.collectionId)],
    ['parentDocumentId', nullableText(doc.parentDocumentId)],
    ['createdAt', text(doc.createdAt)],
    ['updatedAt', text(doc.updatedAt)],
    ['publishedAt', nullableText(doc.publishedAt)],
    ['archivedAt', text(doc.archivedAt)],
    ['createdBy', person(doc.createdBy)],
    ['updatedBy', person(doc.updatedBy)],
  ]);
}

/** A document with its text (Markdown). */
export function documentWithText(value: unknown): Json {
  const doc = object(value) ?? {};
  return { ...documentSummary(doc), ...pick([['text', text(doc.text)]]) };
}

export function collection(value: unknown): Json {
  const col = object(value) ?? {};
  return pick([
    ['id', text(col.id)],
    ['name', text(col.name)],
    ['description', text(col.description)],
    ['url', text(col.url)],
    ['createdAt', text(col.createdAt)],
    ['updatedAt', text(col.updatedAt)],
    ['archivedAt', text(col.archivedAt)],
  ]);
}

/** A collection's document tree: id, title and url per node, children nested (bounded depth). */
export function structure(value: unknown, depth = 0): Json[] {
  if (depth > MAX_TREE_DEPTH) return [];
  return list(value).map(entry => {
    const node = object(entry) ?? {};
    const children = structure(node.children, depth + 1);
    return pick([
      ['id', text(node.id)],
      ['title', text(node.title)],
      ['url', text(node.url)],
      ['children', children.length > 0 ? children : undefined],
    ]);
  });
}

/** The plain text of a ProseMirror document (an Outline comment): text nodes, block by block. */
export function plainText(value: unknown): string {
  const lines: string[] = [];
  let line = '';
  let visited = 0;
  const visit = (entry: unknown, depth: number): void => {
    const node = object(entry);
    if (!node || depth > MAX_TREE_DEPTH || visited >= MAX_TEXT_NODES) return;
    visited += 1;
    if (typeof node.text === 'string') line += node.text;
    if (node.type === 'hard_break' || node.type === 'br') line += '\n';
    for (const child of list(node.content)) visit(child, depth + 1);
    if (node.type !== 'text' && node.type !== 'doc' && list(node.content).length > 0 && line !== '') {
      lines.push(line);
      line = '';
    }
  };
  visit(value, 0);
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

export function comment(value: unknown): Json {
  const entry = object(value) ?? {};
  const body = text(entry.text) ?? (entry.data === undefined ? undefined : plainText(entry.data));
  return pick([
    ['id', text(entry.id)],
    ['documentId', text(entry.documentId)],
    ['parentCommentId', text(entry.parentCommentId)],
    ['text', body],
    ['createdAt', text(entry.createdAt)],
    ['updatedAt', text(entry.updatedAt)],
    ['resolvedAt', text(entry.resolvedAt)],
    ['createdBy', person(entry.createdBy)],
  ]);
}

/** A revision without its text: who saved which title when. */
export function revision(value: unknown): Json {
  const entry = object(value) ?? {};
  return pick([
    ['id', text(entry.id)],
    ['documentId', text(entry.documentId)],
    ['title', text(entry.title)],
    ['createdAt', text(entry.createdAt)],
    ['createdBy', person(entry.createdBy)],
  ]);
}

/** One search hit: the context snippet and the document without its text. */
export function searchHit(value: unknown): Json {
  const hit = object(value) ?? {};
  return pick([
    ['context', text(hit.context)],
    ['document', documentSummary(hit.document)],
  ]);
}

/** A page of a list: the items, where it started, its size, and whether Outline has more. */
export function page(answer: unknown, offset: number, limit: number, item: (value: unknown) => Json) {
  const items = list(dataOf(answer)).map(item);
  const pagination = object(object(answer)?.pagination);
  const hasMore = typeof pagination?.nextPath === 'string' ? items.length >= limit : false;
  return { items, offset, limit, hasMore };
}

/** auth.info: the user's and the workspace's name, and the user's role. No email address. */
export function connection(answer: unknown): Json {
  const data = object(dataOf(answer)) ?? {};
  const user = object(data.user) ?? {};
  const team = object(data.team) ?? {};
  return {
    connected: true,
    user: pick([
      ['id', text(user.id)],
      ['name', text(user.name)],
      ['role', text(user.role)],
    ]),
    workspace: pick([
      ['id', text(team.id)],
      ['name', text(team.name)],
    ]),
  };
}
