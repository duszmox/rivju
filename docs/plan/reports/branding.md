# Branding: app name + icon

Ad-hoc task (no dedicated phase). Everything left in the working tree, uncommitted.

## What was built

**Icon assets** (`build/`):
- `build/icon.svg` — master brand mark: rounded-square (squircle) on a
  lagoon→palm gradient using the app palette (`#4fb8b2 → #328f97 → #2f6a4a`),
  with a white git-merge glyph (two branch nodes, one merging into a trunk with
  an arrow — matches rivju's MR-review identity).
- `build/icon.icns` — full macOS iconset (16–1024 px) generated via
  `rsvg-convert` + `iconutil`.
- `build/icon.png` — 512 px raster, used for the dev Dock icon.

**Packaging** (`package.json`):
- `build.mac.icon` now points explicitly at `build/icon.icns`. `build/` is
  electron-builder's default resources directory, so no extra `files` entries
  were needed. `productName`/`appId` were already correct.

**Renderer branding**:
- New `src/renderer/components/brand/logo.tsx` — `RivjuLogo` React component
  rendering the same SVG inline (one source of truth for the mark in the UI).
- `sidebar.tsx` — header now shows the brand logo instead of the generic
  lucide `Bot` icon.
- `preflight-gate.tsx` — the boot splash is branded (logo + name above the
  "Checking the claude CLI…" spinner).

**Main process**:
- `src/main/index.ts` — in dev (`!app.isPackaged`) the Dock icon is set from
  `build/icon.png`, because dev runs the stock Electron binary. Packaged mac
  builds get the icon from the bundled `.icns` automatically.

## Deviations

- None of substance. `app.dock.setIcon` types return `void` in Electron 44, so
  the call is wrapped in try/catch instead of promise handling.

## Verification

- `npm run typecheck` (tsc --noEmit) — pass
- `npm run lint` — pass
- `npm test` — 45/45 pass

## Next phase notes

- If Linux/Windows targets are added later, generate `icon.ico` /
  `<size>/apps/rivju.png` from `build/icon.svg` and add matching `win`/`linux`
  icon entries.
- The SVG gradient stop colors are duplicated between `build/icon.svg` and
  `logo.tsx`. If the palette changes, both need updating (kept inline rather
  than CSS-var-driven so the packaged icon never depends on the renderer).
