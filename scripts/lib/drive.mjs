/**
 * Minimal reader for *public* Google Drive folders.
 *
 * Quaternius distributes its CC0 packs as shared Drive folders, so fetching
 * them reproducibly means walking the folder tree and pulling individual files.
 * This uses only the public `embeddedfolderview` endpoint and the public file
 * download endpoint - no credentials, no API key, nothing account-specific.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';


/**
 * @param {string} folderId
 * @returns {Promise<{id: string, name: string, isFolder: boolean}[]>}
 */
export async function listFolder(folderId) {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Drive listing failed for ${folderId}: HTTP ${res.status}`);
  const html = await res.text();

  const entries = [];
  for (const chunk of html.split('<div class="flip-entry"').slice(1)) {
    const id = /id="entry-([A-Za-z0-9_-]+)"/.exec(chunk)?.[1];
    const name = /<div class="flip-entry-title">([^<]*)<\/div>/.exec(chunk)?.[1];
    if (!id || !name) continue;
    // Folders link to /folders/<id>; files link to /file/d/<id>.
    const isFolder = chunk.includes('/folders/') || /type\/folder/.test(chunk);
    entries.push({ id, name, isFolder });
  }
  return entries;
}

/** Recursively walks a public folder, yielding files with their relative paths. */
export async function walkFolder(folderId, prefix = '', depth = 0) {
  if (depth > 6) return [];
  const entries = await listFolder(folderId);
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFolder) {
      files.push(...(await walkFolder(entry.id, rel, depth + 1)));
    } else {
      files.push({ id: entry.id, name: entry.name, path: rel });
    }
  }
  return files;
}

/**
 * Downloads one public Drive file.
 *
 * Large files get an interim "can't scan for viruses" page; the confirm token
 * in that page has to be echoed back, which is what the second request does.
 */
export async function downloadFile(fileId) {
  const base = 'https://drive.usercontent.google.com/download';
  let res = await fetch(`${base}?id=${fileId}&export=download`, { headers: { 'User-Agent': UA } });

  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    const html = await res.text();
    const confirm = /name="confirm"\s+value="([^"]+)"/.exec(html)?.[1] ?? 't';
    const uuid = /name="uuid"\s+value="([^"]+)"/.exec(html)?.[1];
    const params = new URLSearchParams({ id: fileId, export: 'download', confirm });
    if (uuid) params.set('uuid', uuid);
    res = await fetch(`${base}?${params.toString()}`, { headers: { 'User-Agent': UA } });
  }

  if (!res.ok) throw new Error(`Drive download failed for ${fileId}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
