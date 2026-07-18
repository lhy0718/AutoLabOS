import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function hashPromotionArtifactTree(root: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const hash = createHash("sha256");
  const visit = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current);
    const relative = path.relative(absoluteRoot, current).replace(/\\/gu, "/") || ".";
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in promotion benchmark artifacts: ${relative}`);
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${relative}\0`);
      const entries = await fs.readdir(current);
      for (const entry of entries.sort()) await visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported artifact type: ${relative}`);
    hash.update(`file\0${relative}\0`);
    hash.update(await fs.readFile(current));
    hash.update("\0");
  };
  await visit(absoluteRoot);
  return hash.digest("hex");
}
