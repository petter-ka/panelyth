// One product version (Stage P06): the shell, both apps and the sidecar carry
// the same one. A release build is named by PANELYTH_VERSION (the release
// workflow takes it from the tag: v1.2.3 → 1.2.3); every other build has the
// version of src/shared/desktop/package.json. The sidecar adds the commit as
// semver build metadata, so `hello` says which build it is: 1.2.3+g1647109.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** The product's version, without build metadata. Throws on anything that is not semver. */
export function productVersion(env = process.env) {
  const named = env.PANELYTH_VERSION?.trim()
  const version =
    named ||
    JSON.parse(readFileSync(join(root, "src", "shared", "desktop", "package.json"), "utf8")).version
  if (!SEMVER.test(version)) {
    throw new Error(
      `"${version}" is not a version (1.2.3 or 1.2.3-beta.1; tag a release as v1.2.3)`,
    )
  }
  return version
}

/** The commit this tree is at, "-dirty" with uncommitted changes; "" outside a git checkout. */
export function commit() {
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
    const dirty = git("status", "--porcelain", "--untracked-files=no") !== ""
    return `g${git("rev-parse", "--short", "HEAD")}${dirty ? "-dirty" : ""}`
  } catch {
    return ""
  }
}

/** What the sidecar reports in `hello` and system.info. */
export function sidecarVersion(env = process.env) {
  const build = commit()
  return build ? `${productVersion(env)}+${build}` : productVersion(env)
}

// `node scripts/version.mjs` prints the version (the workflows read it).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(process.argv.includes("--sidecar") ? sidecarVersion() : productVersion())
}
