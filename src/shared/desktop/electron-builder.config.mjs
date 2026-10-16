// One product package per OS: the shell with both apps (ADR-0031, ADR-0032).
// Run through `pnpm package` (scripts/package.mjs), which builds everything
// the package holds first. Signing, notarization and the update feed come
// from the environment (ADR-0038, docs/RELEASING.md), so the same file makes
// an unsigned local package and a signed release.
import process from "node:process"
import { productVersion } from "../../../scripts/version.mjs"

const env = process.env

/** Where installed apps look for a newer version. "none" builds a package that never updates. */
function publish() {
  const url = env.PANELYTH_UPDATE_URL?.trim()
  if (url === "none") return null
  // Any static HTTPS folder that holds the release's files and latest*.yml.
  if (url) return { provider: "generic", url }
  // The project's GitHub releases; they must be readable without an account.
  return { provider: "github", owner: "petter-ka", repo: "panelyth" }
}

// macOS: a Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME for one
// in the keychain). Without one the app gets an ad-hoc signature: Apple silicon
// refuses to run unsigned code, and such a package cannot install updates itself.
export const macSigned = Boolean(env.CSC_LINK || env.CSC_NAME)
const macNotarized =
  macSigned &&
  Boolean(
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID),
  )

// Windows: a certificate file (WIN_CSC_LINK or CSC_LINK, with its password) is picked
// up by electron-builder itself; Azure Trusted Signing needs its account named here
// (and AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in the environment).
const azure =
  env.AZURE_SIGN_ENDPOINT && env.AZURE_SIGN_ACCOUNT && env.AZURE_SIGN_PROFILE
    ? {
        publisherName: env.AZURE_SIGN_PUBLISHER || "Panelyth",
        endpoint: env.AZURE_SIGN_ENDPOINT,
        codeSigningAccountName: env.AZURE_SIGN_ACCOUNT,
        certificateProfileName: env.AZURE_SIGN_PROFILE,
      }
    : null
export const winSigned = Boolean(azure || env.WIN_CSC_LINK || env.CSC_LINK)

export default {
  appId: "app.panelyth.desktop",
  productName: "Panelyth",
  copyright: "Copyright © Panelyth contributors",
  directories: { output: "release", buildResources: "build" },
  extraMetadata: {
    // The workspace name (@panelyth/desktop) would name the app's data folders.
    name: "panelyth",
    productName: "Panelyth",
    main: "dist/main/main.cjs",
    // One product version (scripts/version.mjs); the sidecar is built with the same one.
    version: productVersion(),
    // Main offers "Download and install" on macOS only in a Developer ID signed app.
    panelythSigned: macSigned,
  },
  files: ["dist/**", "!dist/**/*.map", "package.json"],
  // The renderers are served from disk through app://panelyth/, app://commander/
  // and app://documents/, the sidecar runs as a child process: all outside the
  // asar (paths.ts). ffmpeg and ffprobe sit beside the sidecar when
  // scripts/media-tools.mjs fetched them (ADR-0018).
  extraResources: [
    { from: "build/icon.png", to: "icon.png" },
    { from: "build/THIRD-PARTY-NOTICES.txt", to: "THIRD-PARTY-NOTICES.txt" },
    { from: "../../viewer/renderer/dist", to: "renderer" },
    { from: "../../commander/renderer/dist", to: "commander" },
    // Panelyth System (ADR-0042), served through app://system/.
    { from: "../../system/renderer/dist", to: "system" },
    { from: "../docviewer/dist", to: "documents" },
    { from: "resources/bin/${platform}-${arch}", to: "bin" },
    // The libraries of a Linux ffmpeg build (its RPATH is $ORIGIN/../lib); empty otherwise.
    { from: "resources/lib/${platform}-${arch}", to: "lib" },
  ],
  asar: true,
  // No native Node modules: the sidecar is a separate Go binary.
  npmRebuild: false,
  nodeGypRebuild: false,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",

  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    ...(azure && { azureSignOptions: azure }),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },

  mac: {
    icon: "build/icon.icns",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      // The zip is what an installed app downloads to update itself.
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.photography",
    ...(macSigned
      ? {
          hardenedRuntime: true,
          gatekeeperAssess: false,
          entitlements: "build/entitlements.mac.plist",
          entitlementsInherit: "build/entitlements.mac.plist",
          notarize: macNotarized,
        }
      : { identity: "-", hardenedRuntime: false, notarize: false }),
  },

  linux: {
    icon: "build/icons",
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "tar.gz", arch: ["x64"] },
    ],
    category: "Graphics",
    executableName: "panelyth",
  },

  // Writes app-update.yml into the package and latest*.yml beside the
  // installers; nothing is uploaded from here (`--publish never`).
  publish: publish(),
}
