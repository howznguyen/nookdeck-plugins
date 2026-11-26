// Checks plugins.json, then each plugin's own nookdeck.json on GitHub:
//   entries: required fields, id format, no core.* ids, unique ids sorted by id, sha256 / version formats
//   manifests: fetched from the repo URL; id, version and permissions must match the entry
// Run: bun scripts/validate.ts            (OFFLINE=1 skips the manifest fetch)
const list = JSON.parse(await Bun.file("plugins.json").text());
const errors: string[] = [];
if (!Array.isArray(list)) errors.push("plugins.json must be an array");
const req = ["id", "name", "author", "repo", "version", "sha256", "description", "permissions"];
const seen = new Set<string>();
let prev = "";

function rawManifestUrl(repo: string): string | null {
  // https://github.com/o/r  or  https://github.com/o/r/tree/<branch>/<sub>
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/.exec(repo);
  if (!m) return null;
  const [, owner, name, branch = "main", sub = ""] = m;
  return `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${sub ? sub.replace(/\/$/, "") + "/" : ""}nookdeck.json`;
}
const norm = (p: any) => JSON.stringify({ network: [...(p?.network ?? [])].sort(), shell: !!p?.shell, keyboard: !!p?.keyboard, storage: !!p?.storage, onair: !!p?.onair, notify: !!p?.notify });

for (const [i, p] of (Array.isArray(list) ? list : []).entries()) {
  const at = `entry ${i} (${p?.id ?? "?"})`;
  for (const k of req) if (p?.[k] === undefined) errors.push(`${at}: missing "${k}"`);
  if (p?.verified !== undefined && typeof p.verified !== "boolean") errors.push(`${at}: verified must be true or false`);
  if (typeof p?.id === "string") {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(p.id)) errors.push(`${at}: id must look like dev.author.name`);
    if (p.id.startsWith("core.")) errors.push(`${at}: core.* ids are reserved`);
    if (seen.has(p.id)) errors.push(`${at}: duplicate id`);
    if (p.id < prev) errors.push(`${at}: keep entries sorted by id`);
    seen.add(p.id); prev = p.id;
  }
  if (p?.version && !/^\d+\.\d+\.\d+$/.test(p.version)) errors.push(`${at}: version must be x.y.z`);
  if (p?.sha256 && !/^[a-f0-9]{64}$/.test(p.sha256)) errors.push(`${at}: sha256 must be 64 hex characters`);
  const url = typeof p?.repo === "string" ? rawManifestUrl(p.repo) : null;
  if (!url) { errors.push(`${at}: repo must be a GitHub URL (repo or /tree/<branch>/<folder>)`); continue; }
  if (process.env.OFFLINE === "1") continue;
  try {
    const r = await fetch(url);
    if (!r.ok) { errors.push(`${at}: could not fetch ${url} (${r.status})`); continue; }
    const m = await r.json();
    if (m.id !== p.id) errors.push(`${at}: nookdeck.json id is "${m.id}"`);
    if (m.version !== p.version) errors.push(`${at}: nookdeck.json version is "${m.version}"`);
    if (norm(m.permissions) !== norm(p.permissions)) errors.push(`${at}: permissions differ from nookdeck.json (${JSON.stringify(m.permissions)})`);
  } catch (e: any) { errors.push(`${at}: ${url}: ${e?.message ?? e}`); }
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`plugins.json OK (${seen.size} plugins)`);

// themes.json: every variant says light or dark, and it matches the pack's own nookdeck.json (read from themes/<folder>/ here)
if (await Bun.file("themes.json").exists()) {
  const themes = JSON.parse(await Bun.file("themes.json").text());
  const terrors: string[] = [];
  if (!Array.isArray(themes)) terrors.push("themes.json must be an array");
  for (const [i, t] of (Array.isArray(themes) ? themes : []).entries()) {
    const at = `themes.json entry ${i} (${t?.id ?? "?"})`;
    const vs: any[] = Array.isArray(t?.variants) ? t.variants : [];
    if (!vs.length) { terrors.push(`${at}: variants must list every variant with its mode`); continue; }
    for (const v of vs) if (v?.mode !== "light" && v?.mode !== "dark") terrors.push(`${at}: variant "${v?.id ?? "?"}" needs mode "light" or "dark"`);
    const folder = typeof t?.repo === "string" ? /\/tree\/[^/]+\/(.+?)\/?$/.exec(t.repo)?.[1] : undefined;
    const file = folder ? Bun.file(`${folder}/nookdeck.json`) : null;
    let m: any = null;
    if (file && (await file.exists())) m = JSON.parse(await file.text());
    else if (process.env.OFFLINE !== "1" && typeof t?.repo === "string") {
      const u = rawManifestUrl(t.repo);
      try { const r = u ? await fetch(u) : null; if (r?.ok) m = await r.json(); } catch { /* reported below */ }
    }
    if (!m) { if (process.env.OFFLINE !== "1") terrors.push(`${at}: could not read the pack's nookdeck.json`); continue; }
    const mine = new Map<string, string>((Array.isArray(m.variants) ? m.variants : []).map((x: any) => [String(x.id), String(x.mode)]));
    for (const v of vs) {
      if (!mine.has(String(v.id))) terrors.push(`${at}: variant "${v.id}" is not in nookdeck.json`);
      else if (mine.get(String(v.id)) !== v.mode) terrors.push(`${at}: variant "${v.id}" is ${v.mode} here but ${mine.get(String(v.id))} in nookdeck.json`);
    }
    for (const id of mine.keys()) if (!vs.some((v) => String(v.id) === id)) terrors.push(`${at}: nookdeck.json variant "${id}" is missing from themes.json`);
  }
  if (terrors.length) { console.error(terrors.join("\n")); process.exit(1); }
  console.log(`themes.json OK (${Array.isArray(themes) ? themes.length : 0} themes)`);
}

// the README tables are generated: fail when they are out of date
{
  const { expectedReadme } = await import("./readme.ts");
  if ((await expectedReadme()) !== (await Bun.file("README.md").text())) { console.error("README.md is out of date: run bun scripts/readme.ts and commit"); process.exit(1); }
  console.log("README.md tables up to date");
}
