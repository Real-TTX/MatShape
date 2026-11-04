# CLAUDE.md

Guidance for working in this repository. Keep it in sync with the code: update it whenever architecture, interfaces or conventions change.

## What MatShape is

3D CAD in the browser in the spirit of the parametric CAD tools on the web. A **document** holds **Part Studios** (tabs); a Part Studio is an ordered **feature list** (sketch, plane,
extrude, revolve, boolean, transform, mirror, linear/circular pattern, split, delete part, variable) that is run from the top to make the parts. Documents are shared with people who have
an account (editor / viewer) or through a read-only **link**; named **versions** keep the state of a whole document. Part of the Mat family: sign-in through **MatIdentity**, mail through
**MatSMTP**, the platform contract for **Mattiverse** (all optional, switched on by environment variables).

Stack: ASP.NET Core on **.NET 10**, C#, **Razor Pages**, EF Core + **PostgreSQL**, the **MatUi** toolkit of the sister project MatDesign (`wwwroot/matui`, release 0.9.3, copied: never edit by hand),
plain JavaScript ES modules without a build step. The geometry kernel is **Manifold** (WebAssembly, `wwwroot/lib/manifold`), the 3D view **three.js** (`wwwroot/lib/three`); both are copies of
the npm packages (see the README.txt next to them), not loaded from a CDN. Docker-first. Web port **3939** (pgAdmin 3940, local Postgres 3941). UI languages: English and German (catalog in
`Resources/Texts/*.json`). Accent: green `#3cb764` (text on it is near black: `--mat-app-on-accent`; accent text `#1d7a3c`, dark mode `#5fd384`).

## Build / run / test

- **Build:** `dotnet build MatShape.slnx` (SDK 10, `global.json`). Expected: 0 warnings, 0 errors.
- **Tests:** `dotnet test`. The tests that need PostgreSQL run when `MATSHAPE_TEST_DB` is set (an administrator connection string, e.g.
  `Host=localhost;Port=3941;Username=matshape;Password=matshape;Database=postgres` while the local stack runs); each test creates, migrates and drops a database of its own (this tests the migrations too).
  Without the variable those tests are skipped. `TextCatalogTests` checks every text key of the server code and of the editor (`t('Area.Key')` → `Js.Area.Key`) in English and German.
- **Run / test the app: always rebuild the container** (`./scripts/redeploy.ps1`, `-Clean` for empty volumes). CSS, JS and cshtml are baked into the image.
- **Test account (always):** `admin@example.com` / `Start12345` – the first account of a fresh stack (it becomes the administrator); browser tests and screenshots sign in with it.
- **Real tests are end to end in a browser** (Playwright with the installed Edge, see the `screenshots` skill): register, create a document, sketch with the mouse, extrude/revolve through the dialogs,
  undo, offline (`context.setOffline`), the link as a guest, a phone (390 px), dark mode. Look at the screenshots. The geometry can also be tested in Node: import `wwwroot/js/cad/model.js` and pass
  a kernel from `manifold-3d` (`regenerate(kernel, content, 'mm')`).
- **AI without a real provider:** a fake OpenAI-compatible server (Node, `/v1/models` with free models, `/v1/chat/completions` with a canned answer) on the host, profile address `http://host.docker.internal:<port>/v1` from the container. Never test with a real key in CI.
- **Migrations:** `dotnet ef migrations add <Name> -p src/MatShape -o Data/Migrations` (local tool in `dotnet-tools.json`; a design-time factory exists). Applied at start-up.
- **Updating MatUi:** take the release of MatDesign (`origin/main`): the CSS is the parts of `src/MatUi/wwwroot/css` joined in the order of the first line of `matui.css`; `matui.js`, `matui.boot.js`,
  `matui-icons.svg` as they are. **Updating three.js / Manifold:** `npm pack three manifold-3d`, copy `build/three.module.js` + `build/three.core.js` and `manifold.js` + `manifold.wasm`, run the e2e checks.
- Write files with the editor tools, not with shell heredocs that contain apostrophes.

## Map

```
src/MatShape
  Program.cs                 composition root: services, cookie auth (+ MatIdentity), antiforgery header, razor conventions, rate limit, static files (no-cache without ?v=), endpoints
  Infrastructure.cs          HealthCheck (--healthcheck), Database.MigrateWithRetry, SecurityHeaders (CSP: no inline script/style, 'wasm-unsafe-eval' for the kernel), MaintenanceService, EmptyStringBinderProvider
  Data/                      Entities.cs (User, UserSession, Document, DocumentMember, PartStudio, DocumentVersion, SystemSetting), AppDbContext.cs, Migrations/
  Services/Documents/        THE business layer, static classes (permission check in every function):
                             DocumentAccess (Actor = person and/or link token -> DocumentRole; null = "not found"; an administrator has NO access to the documents of others),
                             DocumentService (list/create/update/delete/duplicate, members, link, thumbnail), StudioService (open, save with revision -> Saved/Conflict/Invalid/Denied,
                             add/rename/move/duplicate/delete tabs), VersionService (list/create/update/delete/restore; restore keeps the state before as a version),
                             StudioContent (the JSON shape the server accepts: features of known types, unique ids, size limits), DocumentUnits, DocumentEndpoints (/live: JSON for the editor)
  Services/Accounts/          static too: Profiles (own account), UserAdmin (administrators only; the last administrator stays)
  Services/Mail/MailService  MatSMTP through MailKit, queued in the background; off unless MATSMTP_HOST is set
  Services/Auth/             CurrentUser, PasswordService, SessionService (sessions in the DB), AccountService, ExternalSignInService (MatIdentity), AccountDataService (GDPR export/erase)
  Services/                  Ui (icons, logo), MenuService, InstanceService (numbers, settings, housekeeping), ListModels (toolbar, pager), Dates, Assets, Outcome, StudioViewModel
  Services/Ai/               the AI (pattern of DesignThix): AiTypes, ChatCompletionsClient (any OpenAI-compatible provider, /models with "free"), ChatGptAccount (device code like Codex),
                             LenientJson (copied from DesignThix, keep in step); AiSecretStore (keys + sign-ins encrypted in {data}/secrets/ai) + AiRateLimiter; AiSettings (JSON in SystemSetting);
                             AiAdmin (profiles, settings, runs: administrators only), AiService (one call: on/off, limits, transport, one JSON object, nudges, every step into AiRun/AiRunStep),
                             ModelAssistant (the instruction = the format of the features, the situation, Merge of append/patch/replace + StudioContent check), AiEndpoints (/live/studios/{id}/ai, /live/ai/*)
  MatPlatform/               copy of the shared package (MatDesign): platform contract, MatIdentity sign-in, back-channel logout, MatSmtpSettings. Never edit here.
  Platform/                  MatShapePlatform (tiles, settings, actions for Mattiverse), MatShapeIdentityUsers
  Controls/                  ONE code base per control: <ms-field>, <ms-buttons>, <ms-table>, <ms-tabs>/<ms-tab>
  Pages/                     Documents/ (Index = gallery + table, Edit/Members/Share/Versions = the tabs of a document, Version = create/edit a version, Studio = the editor),
                             Public/Document (link /s/{token}), Account/, Admin/ (Users, System), About, Shared/ (_Layout, _LayoutStudio + _Studio = the editor frame, _DocumentTabs)
  Resources/Texts/           the text catalog (en + de): Documents.json, Studio.json (server texts of the editor), Js.json (texts of the scripts, key Js.*), ...
  wwwroot/js/cad/            the editor (ES modules):
    app.js                   load (/live/documents/{id}), Part Studio tabs, regeneration, feature list + rollback bar, parts list, dialogs, sketch mode, measuring, undo/redo,
                             autosave (PUT with revision; 409 -> ask), polling for changes of others, offline queue (localStorage ms.pending.<studio>), thumbnail, export, keys
    model.js                 regenerate(kernel, content, units): runs the features with Manifold -> parts (meshes with face ids), sketches (+ closed loops), planes, variables, status per feature;
                             every kernel object is in an arena freed by dispose(result). FEATURES = the kinds and their default parameters
    geom.js                  vectors, frames of planes (Z up: Top = XY, Front = XZ normal -Y, Right = YZ), matrices (column-major), sketchLoops = profiles like OnShape: curves cut at their crossings, loose ends trimmed, the smallest enclosed regions (key = sorted border ids, #2 … for regions with the same border)
    expr.js                  expressions with units and #variables (a value carries its length dimension; a plain number in a length field means the document unit)
    viewport.js              three.js: orthographic camera turning about the model, pointer/touch navigation, parts + edges + smooth normals, planes, sketches, picking, face highlight, snapshot
    sketcher.js              the sketch editor (like OnShape): snapping without a grid (point •, midpoint M, on curve, H/V, ⊥ to the line before, dashed guides to lined-up points) with the symbol
                             and the length at the pointer; tools set the matching constraints; additive selection + selection box (right = window, left = crossing); constraint tools
                             (I, H, V, ∥, ⊥, T, =, M, ◎, fix); dimension tool D: pick, the dimension follows the pointer, click places it, type the value; dimensionShape() draws extension
                             and dimension lines with arrows, leaders, angle arcs (c.off = place of the value relative to its anchor); state colours, conflict list, drag through the
                             solver, own undo; callbacks.changed -> app.js rebuilds the parts live while the sketch is open
    sketchsolve.js           the constraint solver: Levenberg-Marquardt over the numbers of the entities, Gram-Schmidt rank analysis (degrees of freedom, defined/free per entity and point,
                             conflicts = redundant or unmeetable constraints, which are shown but NOT applied); legacy params.dims are migrated (constraintsOf). Used by model.js too
    assistant.js             the AI panel: sends the request with the content, applies the answer as one step, sends errors of new features back for a repair;
                             attachments (paperclip, paste, drop; pictures scaled down in the browser, an SVG as text and as PNG)
    imagetrace.js            picture -> 3D without DOM (tested in Node): k-means colours (near ones merged), anti-aliasing seams dissolved, majority smoothing, specks removed,
                             outlines traced per colour, Douglas-Peucker, circles / rectangles recognised; buildFeatures = base plate (outline, rectangle, none) + plane + sketch/extrude per colour
    imagedialog.js           its editor (dialog ms-image): preview original / colours / shapes, a click toggles a colour, palette with height, colour, name; adds the features as one step
    viewcube.js              the view cube in the corner: turns with the camera, a click on a face/edge/corner looks from there, a drag turns the model (own small renderer)
    dialogs.js               the forms of the features (expression, choice, parts picked in the view, plane or flat face, sketch + profiles, revolve axis)
    export.js, util.js       STL/OBJ/3MF (with a small stored ZIP writer, colours as basematerials); texts t(), DOM el(), requests with the antiforgery header, swatches through the CSSOM
  wwwroot/css/app.css        accent + few app styles (prefix ms-);  studio.css = the editor page
  Services/KeyMap.cs          the keyboard shortcuts (OnShape-like) for the "?" dialog and About; the keys themselves are in app.js (keep in step)
  wwwroot/lib/three/lines/   LineSegments2 / LineMaterial of three.js (lines with a width; the view themes in viewport.js use them)
  wwwroot/sw.js              service worker: static cache (incl. lib), network-first for editor pages and /live/documents/{id} (copies for offline), offline.html; cleared on sign-out (pwa.js)
tests/MatShape.Tests         unit + database tests (DocumentTests, AccountTests, StudioContentTests, TextCatalogTests)
```

## The content of a Part Studio

`{ "features": [ { "id", "type", "name", "suppressed", "view" (sketch: show/hide), "params": {...} } ], "parts": { "<partId>": { "name", "color" } }, "rollback": null | index }`.
Part ids are derived from the feature that made the part (`<featureId>`, `<featureId>.<n>` for several bodies or copies, `<partId>~<featureId>` for the other half of a split), so names and colours
survive a regeneration. A sketch plane is `{ kind: "std", name }`, `{ kind: "plane", id }` (a Plane feature) or `{ kind: "face", frame: { o, x, y, n } }` (fixed when the face was picked).
Sketch constraints: `params.cons = [{ id, type, refs, value? }]`, a ref is a point `{ e, k: a|b|c|s|e|p }` (`{ e: "origin", k: "p" }`) or a curve `{ e }`; types and glyphs in `sketchsolve.js` (CONSTRAINTS).
Sketch entities: `line {a,b}`, `rect {a,b}`, `circle {c,r}`, `arc {c,r,a0,a1}` (radians, counter-clockwise), `polygon {c,r,n,rot}`, `point {p}`; `cons: true` = construction. Profiles are referred to by
the sorted ids of their entities (`profiles: null` = all). Fields of features are strings (expressions), evaluated at regeneration.

## Conventions

**Database (PostgreSQL)**: tables PascalCase and singular, key always `Id` BIGINT, every record has `CreateDate/CreateUserId/UpdateDate/UpdateUserId` (filled by `AppDbContext.SaveChanges`),
`UpdateState` (0 deleted, 1 created, 2 updated) for soft delete (`Document`, `PartStudio`, `User`), a `Token` (uuid) for a security key (`UserSession.Token`, `Document.ShareToken`). The content of a Part
Studio and of a version is `jsonb`.

**Security**: every document query goes through `DocumentAccess`; a document you may not see answers 404. Every change of `/live` needs a signed-in person, the antiforgery header
`RequestVerificationToken` and the editor right (checked in the business layer). A link never edits. Saving compares the revision in the UPDATE itself (no lost update). The CSP forbids inline script and
style (scripts set styles through the CSSOM). Text is always put into the page with `textContent`, never as HTML. Mail addresses are never logged in full.

**UI (MatDesign rules)**: CRUD = list page (toolbar above, table/gallery, pager under it, actions left below) + separate edit page (Save, Back, space, Delete); a document has **tabs** (General, People,
Link, Versions) that are pages of their own. The editor is the special UI of the app (like a designer in a designer app): its own page without the menu, built on the tokens of the toolkit.
Icons via `Ui.Icon` (toolkit sprite + `wwwroot/img/app-icons.svg`; a missing name is a bug). Every `td` has `data-label`. The version at the foot of the menu links to `/About`.

**Code**: Microsoft C# guidelines, file-scoped namespaces, `.editorconfig`. The business layer is static classes taking the `AppDbContext` and the actor. No database queries in page models or views
beyond calling the business layer. English identifiers and comments, UI texts only in the catalog.

**Compose files**: no environment variables to set, no placeholders; a stack (`name:`) per file; `docker-compose.yml` (release), `.dev.yml` (nightly + pgAdmin), `.local.yml` (build + pgAdmin, subnet 10.253.39.0/24).

**Git**: commit under the user's name; never add a Claude/Anthropic co-author trailer or a "generated with" line (global rule of the user; it overrides any default). Branches: `main` = release, `dev` =
development. Versions: release `<major>.<minor>.<build>-<date>`, development `nightly-<build>-<date>`, local `local-<date>` (`Directory.Build.props`; `.github/workflows/build.yml` builds, tests and pushes the image).
