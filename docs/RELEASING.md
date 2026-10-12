# Releasing Panelyth

How a release is built, signed, tested and published, and what a release must keep true. The decisions are in
ADR-0032 (packaging) and ADR-0038 (updates, signing, notices); what the user sees is in `docs/INSTALL.md`.

## A release, step by step

1. Decide the version (semver: `1.2.3`, or `1.2.3-beta.1` for a pre-release).
2. Check the two release rules below (migrations, licences). `pnpm test` enforces both.
3. Tag the commit and push the tag:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

4. `release.yml` packages Windows, macOS and Linux as version 1.2.3, runs the packaged smoke test on each, runs the
   install → update → uninstall test on Windows, and creates a **draft** release with every package, the update
   metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, the block maps) and `SHA256SUMS.txt`.
5. Read the job summary: it says what each package's signature is.
6. Edit the draft's notes. Installed apps show them under "What's new" as plain text, so write lines and lists,
   not layout.
7. Publish the draft. That is the release: installed apps find it at their next check.

Run the workflow by hand (Actions → Release → Run workflow) to get the packages as workflow artifacts without a
release.

A version with a suffix is created as a pre-release; installed apps skip pre-releases.

## The version

One version for the shell, both apps and the sidecar (ADR-0038). `scripts/version.mjs` reads it:

- `PANELYTH_VERSION` when set (the workflow sets it from the tag);
- otherwise `version` in `src/shared/desktop/package.json` (`0.0.0`: a development build).

The sidecar reports `<version>+g<commit>` (with `-dirty` for uncommitted changes). `node scripts/version.mjs` prints
the version, `--sidecar` the sidecar's.

## Building a package by hand

```sh
pnpm package            # installers for this OS → src/shared/desktop/release/
pnpm package --dir      # the unpacked app only (what the smoke test runs)
pnpm test:smoke         # the packaged smoke test (PANELYTH_PACKAGED_APP names another build)
pnpm notices            # only the licence notices (after pnpm build)
pnpm media-tools        # only ffmpeg beside the sidecar; --clean removes it again
```

`pnpm package` prints what it is about to build: the version, whether the package will be signed, and where
installed apps will look for updates.

| Variable | Meaning |
|---|---|
| `PANELYTH_VERSION` | the release's version |
| `PANELYTH_UPDATE_URL` | a static HTTPS folder as the update feed, in place of the GitHub releases; `none` builds a package that never updates |
| `PANELYTH_MEDIA_TOOLS=skip` | no ffmpeg in the package |
| `PANELYTH_MEDIA_TOOLS_CACHE` | where downloaded ffmpeg archives are kept (default: the temp folder) |
| `PANELYTH_REQUIRE_SIGNING=1` | fail unless the package is signed (and notarized on macOS) |

After `pnpm package`, ffmpeg sits beside the development sidecar too (`src/shared/desktop/resources/bin/`), so
`pnpm dev` uses it. `pnpm media-tools --clean` goes back to the system's.

## The update feed

Installed apps read `latest*.yml` from the feed their package names.

- **Default: the GitHub releases of `petter-ka/panelyth`.** They must be readable without an account. While the
  repository is private, installed apps find nothing and Settings → About says the check failed.
- **Any static HTTPS folder**: set the repository variable `PANELYTH_UPDATE_URL`, and upload each release's files
  (the installers, the `.zip` and `.AppImage`, the block maps and the three `latest*.yml`) to that folder. The
  workflow does not upload there.

Changing the feed affects packages built afterwards. An installed app keeps the feed it was built with, so the old
feed must keep serving at least one release that points to the new one.

## Signing

Without the secrets below the workflow still builds; the packages are unsigned and the job summary says so. Set the
repository variable `PANELYTH_REQUIRE_SIGNING` to `1` once the certificates exist, so an unsigned release cannot be
made by accident.

### Windows

One of:

- **Azure Trusted Signing**: secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; variables
  `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`.
- **A certificate file**: secrets `WIN_CSC_LINK` (the `.pfx`, base64) and `WIN_CSC_KEY_PASSWORD`.

Signed: `Panelyth.exe`, the sidecar, the bundled programs, the installer and the uninstaller. An unsigned installer
makes SmartScreen ask before it runs. An update is verified against the publisher of the installed app, so the
publisher name must not change between releases.

### macOS

- Secrets `MAC_CSC_LINK` (a Developer ID Application certificate, `.p12`, base64) and `MAC_CSC_KEY_PASSWORD`.
- For the notary, an App Store Connect API key: secrets `APPLE_API_KEY_P8` (the key file's text), `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`.

The app is signed with the hardened runtime and `src/shared/desktop/build/entitlements.mac.plist` (JIT and unsigned
executable memory for Chromium; nothing else). Without the certificate the app has an ad-hoc signature: Gatekeeper
blocks a downloaded copy until it is opened with right-click → Open, and the app cannot install updates (it offers
the download page).

### Linux

The packages carry no signature. `SHA256SUMS.txt` lists every file of the release; with the secrets
`RELEASE_GPG_PRIVATE_KEY` and `RELEASE_GPG_PASSPHRASE` it is signed (`SHA256SUMS.txt.asc`).

## Release rules

### Database migrations

- `library.db` holds the user's settings, bookmarks, ratings and tags. It is migrated, never discarded (ADR-0016).
- A released migration is never edited. `internal/library/migrations_test.go` pins the text of every released
  migration by its SHA-256 (`released`). A schema change is a new migration, with a seed (rows a user of that schema
  could have) and its checks in the same file, and its hash added to `released` in the release that first ships it.
- The test opens a library written by every schema since the first and checks the rows afterwards.
- `index.db` and the preview cache are disposable. A new `schemaVersion` in `internal/index/schema.go` recreates
  the index on the first start of the new version; the user's first visit to each folder lists it again.
- An older version started on a newer `library.db` (a downgrade) runs without the library and leaves it untouched.

### Licences

- `pnpm package` writes `THIRD-PARTY-NOTICES.txt` into the package and fails on a component without a licence text
  or with a licence the product does not ship. The allowed list is at the top of `scripts/notices.mjs`: permissive
  licences, and LGPL for ffmpeg alone.
- A new npm dependency or Go module is found by itself. Anything copied into the sources (a font, icons, a code
  snippet) is added to `src/shared/desktop/build/third-party.json` by hand.
- ffmpeg: only an LGPL build, pinned by URL and SHA-256 in `src/shared/desktop/media-tools.json`. To change it, read
  the new build's licence file and its `-version` configuration, then change the URL and the checksum together.
  `scripts/media-tools.mjs` refuses a build configured with `--enable-gpl` or `--enable-nonfree`. The package gets
  `bin/FFMPEG-BUILD.txt`: the build, its source and its configuration.
- 7-Zip is not bundled (ADR-0030).

## Tests of a release

| Test | Where | What it proves |
|---|---|---|
| `pnpm test:smoke` | every OS, in `ci.yml` and `release.yml` | the package starts, has one version, the product's menu, the notices and the media tools; opens a folder, switches apps, copies a file, quits |
| `pnpm test:update` | Windows, in `release.yml` | the installer installs, the installed app updates itself from Settings → About and restarts into the new version, the uninstaller removes it |
| `specs/about.spec.ts` | the e2e suite | the About tab, the update steps and the native menu, with a scripted update engine |

`pnpm test:update` installs and removes a real program for the current user. It refuses a machine where Panelyth is
installed. After the update the installer starts the new version in the user's session with the account's normal
profile, and the test closes it a few seconds later; run it on a runner, or on an account whose Panelyth profile
does not matter.

## Not covered yet

- macOS: no run of the signed and notarized path, of an update on macOS, or of the packaged app on a Mac from this
  pipeline's new parts. ffmpeg is not bundled on macOS.
- Linux: no test of an AppImage updating itself.
- The licences of the libraries inside the bundled ffmpeg build are not listed one by one (its configuration names
  them). A build of our own with only the decoders posters need would fix that and the package size.
