export async function collectFirestorePages<T>(
  loadPage: (pageToken: string) => Promise<{ items: T[]; nextPageToken?: unknown }>,
) {
  const items: T[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken = "";
  do {
    const page = await loadPage(pageToken);
    items.push(...page.items);
    const nextPageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
    if (!nextPageToken) break;
    if (seenPageTokens.has(nextPageToken)) throw new Error("Firestore pagination token repeated");
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (pageToken);
  return items;
}
