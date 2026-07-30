import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Manifest = {
  name: string;
  version: string;
};

async function verifyExport(packageName: string) {
  const module = await import(`${packageName}/tui`);
  if (module.default?.id !== packageName || typeof module.default?.tui !== "function") {
    throw new Error("Invalid TUI plugin export");
  }
}

const verifyIndex = process.argv.indexOf("--verify-export");
if (verifyIndex >= 0) {
  const packageName = process.argv[verifyIndex + 1];
  if (!packageName) throw new Error("Missing package name");
  await verifyExport(packageName);
  process.exit(0);
}

const manifest = (await Bun.file("package.json").json()) as Manifest;
const packageFile = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
const root = await mkdtemp(join(tmpdir(), `${manifest.name.replaceAll("/", "-")}-`));
const install = join(root, "install");

try {
  await mkdir(install);
  await Bun.$`bun pm pack --destination ${root}`.quiet();
  await Bun.$`bun init --yes`.cwd(install).quiet();
  await Bun.$`bun add ${join(root, packageFile)}`.cwd(install).quiet();
  await Bun.$`bun ${import.meta.filename} --verify-export ${manifest.name}`.cwd(install).quiet();
} finally {
  await rm(root, { recursive: true, force: true });
}
