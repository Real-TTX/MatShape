# CLAUDE.md

Guidance for working in this repository. Keep it in sync with the code: update it whenever architecture, interfaces or conventions change.

## What MatShape is

3D CAD in the browser in the spirit of the parametric CAD tools on the web. A **model** holds **Part Studios** (tabs); a Part Studio is an ordered **feature list** (sketch, plane,
extrude, revolve, sweep, loft, fillet, chamfer, hole, shell, rib, draft, thread, boolean, transform, mirror, linear/circular pattern, split, delete part, variable, import, figure) that is run from the top to make the parts. Models are shared with people who have
an account (editor / viewer) or through a read-only **link**; named **versions** keep the state of a whole model; everybody files the models they see in **folders** of their own
(models were called "documents" until M11: the tables, classes and addresses were renamed, the old addresses lead to the new ones). Part of the Mat family: sign-in through **MatIdentity**, mail through
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
- **Real tests are end to end in a browser** (Playwright with the installed Edge, see the `screenshots` skill): register, create a model, sketch with the mouse, extrude/revolve through the dialogs,
  undo, offline (`context.setOffline`), the link as a guest, a phone (390 px), dark mode. Look at the screenshots. The geometry can also be tested in Node: import `wwwroot/js/cad/model.js` and pass
  a kernel from `manifold-3d` (`regenerate(kernel, content, 'mm')`).
- **AI without a real provider:** a fake OpenAI-compatible server (Node, `/v1/models` with free models, `/v1/chat/completions` with a canned answer) on the host, profile address `http://host.docker.internal:<port>/v1` from the container. Never test with a real key in CI.
  **3D generation without Meshy:** a fake Meshy (Node: `POST /openapi/v1/image-to-3d` / `multi-image-to-3d` / `v2/text-to-3d` -> `{ result }`, `GET …/{id}` PENDING -> IN_PROGRESS -> SUCCEEDED with
  `model_urls.glb` + `thumbnail_url` on the same server, any GLB of closed or open shells); Admin → AI → 3D generation: address `http://host.docker.internal:<port>`, any key the fake accepts.
  `MeshTests` does the same with a fake `HttpMessageHandler`. Put the address and the key back afterwards.
- **Migrations:** `dotnet ef migrations add <Name> -p src/MatShape -o Data/Migrations` (local tool in `dotnet-tools.json`; a design-time factory exists). Applied at start-up.
- **Updating MatUi:** take the release of MatDesign (`origin/main`): the CSS is the parts of `src/MatUi/wwwroot/css` joined in the order of the first line of `matui.css`; `matui.js`, `matui.boot.js`,
  `matui-icons.svg` as they are. **Updating three.js / Manifold:** `npm pack three manifold-3d`, copy `build/three.module.js` + `build/three.core.js` and `manifold.js` + `manifold.wasm`, run the e2e checks.
- Write files with the editor tools, not with shell heredocs that contain apostrophes.

## Map

```
src/MatShape
  Program.cs                 composition root: services, cookie auth (+ MatIdentity), antiforgery header, razor conventions, rate limit, static files (no-cache without ?v=), endpoints
  Infrastructure.cs          HealthCheck (--healthcheck), Database.MigrateWithRetry, SecurityHeaders (CSP: no inline script/style, 'wasm-unsafe-eval' for the kernel; /lib/occt alone (the STEP reader in a worker) also 'unsafe-eval'),
                             OldAddresses (/Documents/... -> 301 /Models/..., /live/documents/... answered as /live/models/...), MaintenanceService, EmptyStringBinderProvider
  Data/                      Entities.cs (User, UserSession, Model, ModelMember, Folder, PartStudio, ModelVersion, SystemSetting), AppDbContext.cs, Migrations/
                             (ModelsAndFolders renames the Document tables BY HAND – a scaffolded rename drops and creates tables; FolderTests checks that data survives)
  Services/Models/           THE business layer, static classes (permission check in every function):
                             ModelAccess (Actor = person and/or link token -> ModelRole; null = "not found"; an administrator has NO access to the models of others),
                             ModelService (list/create/update/delete/duplicate, members, link, thumbnail), StudioService (open, save with revision -> Saved/Conflict/Invalid/Denied,
                             add/rename/move/duplicate/delete tabs), VersionService (list/create/update/delete/restore; restore keeps the state before as a version),
                             StudioContent (the JSON shape the server accepts: features of known types, unique ids, size limits), ModelUnits, ModelEndpoints (/live: JSON for the editor),
                             FolderService (folders of ONE person: create/update/move without cycles, max depth 12, delete = the content moves up; FileAsync files a model:
                             the owner on Model.FolderId, a member on ModelMember.FolderId; filing does not change the date of the model)
  Services/Accounts/          static too: Profiles (own account), UserAdmin (administrators only; the last administrator stays)
  Services/Mail/MailService  MatSMTP through MailKit, queued in the background; off unless MATSMTP_HOST is set
  Services/Auth/             CurrentUser, PasswordService, SessionService (sessions in the DB), AccountService, ExternalSignInService (MatIdentity), AccountDataService (GDPR export/erase)
  Services/                  Ui (icons, logo), MenuService, InstanceService (numbers, settings – the public address in force: MAT_PUBLIC_URL, else the stored one, PublicUrlOf;
                             the share mail and the document link take it from SettingsAsync –, housekeeping), ListModels (toolbar, pager), Dates, Assets, Outcome, StudioViewModel
  Services/Ai/               the AI (pattern of DesignThix): AiTypes, ChatCompletionsClient (any OpenAI-compatible provider, /models with "free"), ChatGptAccount (device code like Codex),
                             LenientJson (copied from DesignThix, keep in step); AiSecretStore (keys + sign-ins encrypted in {data}/secrets/ai) + AiRateLimiter; AiSettings (JSON in SystemSetting);
                             AiAdmin (profiles, settings, runs: administrators only), AiService (one call: on/off, limits, transport, one JSON object, nudges, every step into AiRun/AiRunStep),
                             ModelAssistant (the instruction = the format of the features, the situation, Merge of append/patch/replace + StudioContent check), AiEndpoints (/live/studios/{id}/ai, /live/ai/*);
                             the 3D generation (like Meshy's app): MeshyClient (the REST API of Meshy: image / multi-image / text to 3D, untextured, remeshed triangles, GLB + STL; task state,
                             files at signed addresses for 3 days), MeshService (editor right to start, only the starter asks/fetches/stops, limits count generations (running + done) per
                             person per day and for all per month, every generation an AiRun with action Mesh; the files go through the server), settings in AiSettings.Mesh, the key in
                             AiSecretStore under the installation token (Guid.Empty, kind "meshy"); endpoints /live/studios/{id}/ai/mesh, /live/ai/mesh/{run}[/model|stl|thumbnail]
  MatPlatform/               copy of the shared package of MatDesign, 2.2.1 (node tools/matplatform-copy.js src/MatShape in MatDesign): platform contract 2, MatIdentity sign-in,
                             back-channel logout, MatSmtpSettings, the Connections area (<mat-connections />, /api/connections, kept in {data}/matplatform), MAT_PUBLIC_URL,
                             MAT_FRAME_ANCESTORS. Never edit here.
  Platform/                  MatShapePlatform (contract 2: tiles, the two settings – publicUrl fixed while MAT_PUBLIC_URL is set –, actions; consumes identity.oidc and mail.smtp,
                             both optional; contributes the launcher MatShape with the quick actions New model / All models / Shared with me and the admin widgets
                             models (tiles) / users (stat)), MatShapeIdentityUsers
  Controls/                  ONE code base per control: <ms-field>, <ms-buttons>, <ms-table>, <ms-tabs>/<ms-tab>
  Pages/                     Models/ (Index = gallery + table with the folders of ?folder= above and the path as crumbs, Folder = create/edit a folder, Move = file a model,
                             Edit/Members/Share/Versions = the tabs of a model, Version = create/edit a version, Studio = the editor), Public/Link (link /s/{token}), Account/, Admin/ (Users, System, Connections = <mat-connections />, Ai/: General, Profiles, Mesh = the 3D generation, Runs),
                             About, Shared/ (_Layout, _LayoutStudio + _Studio = the editor frame, _ModelTabs, _AiTabs)
  Resources/Texts/           the text catalog (en + de): Models.json, Studio.json (server texts of the editor), Js.json (texts of the scripts, key Js.*), ...
  wwwroot/js/cad/            the editor (ES modules):
    app.js                   load (/live/models/{id}), Part Studio tabs, regeneration, feature list + rollback bar, parts list, dialogs, sketch mode, measuring, undo/redo,
                             autosave (PUT with revision; 409 -> ask), polling for changes of others, offline queue (localStorage ms.pending.<studio>), thumbnail, export, keys
    model.js                 regenerate(kernel, content, units): runs the features with Manifold -> parts (meshes with face numbers and the edges between faces), sketches (+ closed loops),
                             planes, variables, status per feature; every kernel object is in an arena freed by dispose(result). FEATURES = the kinds and their default parameters.
                             Faces have NAMES (result.faceKeys, faceKey(result, n)): every new body is relabelled (triangle faceID = FACE_BASE + index of the name), the kernel keeps
                             the numbers through booleans: "<extrude>:start" (on the sketch plane), ":end", ":<entity>" (a side; rect/polygon sides "<id>.<k>"), revolve sides,
                             "<split>:cut", "<fillet>:<n>". Fillet/chamfer find their edges by these names (geometric fallback: the picked point). sectionOf / outlineOf: cut / silhouette
    topo.js                  topology(mesh): neighbours of the triangles, the edges between faces (different face numbers, not coplanar) with their angle; chains(edges)
    blend.js                 fillets and chamfers on a mesh kernel: per chain of edges a tool (the corner minus the tangent circle, or the chamfer triangle) is swept along it, mitred
                             where the chain turns, cut away on outer edges / added on inner ones, a ball corner where three rounded edges meet; too wide -> tooLarge (an error)
    drawing.js               technical drawings without DOM (tested in Node): projectView (sharp edges, tangent edges thin, outlines of round faces; hidden lines by a depth buffer),
                             drawingViews (front / top / left / iso, section A–A with hatching and cut line), layoutDrawing (first-angle projection, scale, title block, overall
                             dimensions; primitives in sheet mm), toSvg / toDxf (R12) / toPdf (own small writer, Helvetica)
    drawingdialog.js         its dialog (ms-drawing): sheet, scale, views, section, hidden edges, dimensions, title; preview as SVG; PDF / SVG / DXF downloads; "keep as a tab"
    drawingeditor.js         a drawing TAB (content.drawing): the sheet of a Part Studio of the model, made again when it changes; settings in the side bar; tools: select
                             (drag a view), dimension (two snap points of a view, kind by the drag direction), diameter (circles found in the views), detail view; notes are
                             stored in view coordinates (drawing.js annotate / viewGeometry)
    assembly.js              an assembly TAB (content.assembly): instances { studio, part, fixed, transform } and mates { type, a/b: { inst, frame }, flip, angle, offset, dx, dy };
                             solveAssembly = a tree (grounded instance, each mate places the next; loops are left out); connectors from picked faces (flat: middle +
                             normal, round: axisOfFace); exploded view, interference (kernel intersect), BOM CSV
    sketchtools.js           trim (cut at crossings; circles become arcs), offset of a chain (lines meet at their crossings), sketch fillet of a corner, mirror (symmetric),
                             slot, tangent arc – plain functions on { entities, cons } (tested in Node)
    solids.js                offsetVertices (faces moved by their own distances: shell, draft), hole profile, sweep along a path (parallel transport, mitred corners),
                             loft rings, axisOfFace, threadTool (60° V along a helix)
    step.js                  STEP AP214 writer (faceted B-rep: flat regions merged into faces with holes, colours), readCad: STEP/IGES/BREP via occt-import-js in a worker
                             (/lib/occt has its own CSP with 'unsafe-eval' – SecurityHeaders; the pages stay strict), STL reader; packArray/unpackArray (base64 of the meshes of "import")
    geom.js                  vectors, frames of planes (Z up: Top = XY, Front = XZ normal -Y, Right = YZ), matrices (column-major), sketchLoops = profiles like OnShape: curves cut at their crossings, loose ends trimmed, the smallest enclosed regions (key = sorted border ids, #2 … for regions with the same border)
    expr.js                  expressions with units and #variables (a value carries its length dimension; a plain number in a length field means the model unit)
    viewport.js              three.js: orthographic camera turning about the model, pointer/touch navigation, parts + edges (from the face names) + smooth normals, planes, sketches,
                             picking (faces; pickEdge: the edge near the pointer that is not hidden; setPickParts: pick in other parts than shown, e.g. before a fillet), edge marks,
                             face highlight, section view (setSection: clipping plane + hatched caps), snapshot
    sketcher.js              the sketch editor (like OnShape): snapping without a grid (point •, midpoint M, on curve, H/V, ⊥ to the line before, dashed guides to lined-up points) with the symbol
                             and the length at the pointer; tools set the matching constraints; additive selection + selection box (right = window, left = crossing); constraint tools
                             (I, H, V, ∥, ⊥, T, =, M, ◎, fix); dimension tool D: pick, the dimension follows the pointer, click places it, type the value; dimensionShape() draws extension
                             and dimension lines with arrows, leaders, angle arcs (c.off = place of the value relative to its anchor); state colours, conflict list, drag through the
                             solver, own undo; callbacks.changed -> app.js rebuilds the parts live while the sketch is open. Geometry from the model: Use (U, an edge projected),
                             Section and Outline (app.js: sectionOf / outlineOf of the parts before the sketch) -> curvesFromPoints (geom.js) -> entities with use: true
    sketchsolve.js           the constraint solver: Levenberg-Marquardt over the numbers of the entities, Gram-Schmidt rank analysis (degrees of freedom, defined/free per entity and point,
                             conflicts = redundant or unmeetable constraints, which are shown but NOT applied); legacy params.dims are migrated (constraintsOf). Used by model.js too.
                             Entities with use: true (taken from the model) are fixed: their numbers are no unknowns (a big cut does not slow it down)
    assistant.js             the AI panel: sends the request with the content and the level of detail (rough/normal/fine), applies the answer as one step (it may "remove"
                             features), sends errors of new features AND new overlaps of parts (model.js overlapsOf: separate parts sharing volume) back for a repair;
                             attachments (paperclip, paste, drop; pictures scaled down in the browser, an SVG as text and as PNG)
    imagetrace.js            picture -> 3D without DOM (tested in Node): k-means colours (near ones merged), anti-aliasing seams dissolved, majority smoothing, specks removed,
                             outlines traced per colour, Douglas-Peucker, circles / rectangles recognised; buildFeatures = base plate (outline, rectangle, none) + plane + sketch/extrude per colour
    imagedialog.js           its editor (dialog ms-image): preview original / colours / shapes, a click toggles a colour, palette with height, colour, name; adds the features as one step
    meshgen.js               a generated mesh -> a solid, without DOM (tested in Node): readGlb (scene, node matrices, mirrored nodes; Draco/meshopt refused) / STL, place (Y-up -> Z-up,
                             height, turn, on Top, centred), weld; closed -> the kernel takes it (overlapping shells united); open -> voxels by ray parity on 3 axes (majority) ->
                             blurred -> Manifold.levelSet -> simplify; faceGroups (creases > 40° / 55° rebuilt, small regions joined: no scratches); meshFeature = an "import" with kept faces
    meshdialog.js            the dialog "AI 3D" (ms-mesh, toolbar, also from the picture dialog), two ways (data-has-ai / data-has-meshy; free AI blocks first): AI blocks = the request and
                             the pictures go to the assistant (host.toAssistant), which writes a figure feature – changed afterwards in the chat; Meshy = POST, polls every 4 s (also closed,
                             also after a reload: the run in localStorage ms.mesh.<model>), fetches the GLB (STL as fallback), height / turn / rebuild on the fetched mesh, adds it next to the parts
    figure.js                the feature "figure" without DOM (tested in Node): groups of blocks (sphere, ellipsoid, capsule/round cone, cone, box, cylinder, torus; rot, op cut, blend) as signed
                             distance fields (smooth union / difference in order, early-out by bounding balls), Manifold.levelSet per group (cell = largest side / 70|110|170, finer for
                             small groups), simplified; meshes cached by the blocks (LRU 48). model.js: one part per group (names/colours from the group as defaults), later groups cut
                             out of earlier ones (parts only touch), flat: trimmed at Z = 0; ModelAssistant's instruction teaches the format (+ an example bear)
    lib/occt                 occt-import-js (OpenCascade reader as WebAssembly, LGPL), unchanged copy, see its README.txt
    spacemouse.js            the 3D mouse through WebHID (no driver): readReport (report 1 shifts – or all six axes –, 2 turns, 3 buttons), motionOf (device x right,
                             y towards the person, z down -> screen; "object" mode moves the model like the cap), SpaceMouse (reconnects allowed devices, moves the view
                             once per frame by viewport.navigate); the menu ms-spacemouse-menu in _Studio, wired in app.js
    viewcube.js              the view cube in the corner: turns with the camera, a click on a face/edge/corner looks from there, a drag turns the model (own small renderer)
    dialogs.js               the forms of the features (expression, choice, parts picked in the view, plane or flat face, sketch + profiles, revolve axis)
    export.js, util.js       STL/OBJ/3MF (with a small stored ZIP writer, colours as basematerials); texts t(), DOM el(), requests with the antiforgery header, swatches through the CSSOM
  wwwroot/css/app.css        accent + few app styles (prefix ms-);  studio.css = the editor page
  Services/KeyMap.cs          the keyboard shortcuts (OnShape-like) for the "?" dialog and About; the keys themselves are in app.js (keep in step)
  wwwroot/lib/three/lines/   LineSegments2 / LineMaterial of three.js (lines with a width; the view themes in viewport.js use them)
  wwwroot/sw.js              service worker: static cache (incl. lib), network-first for editor pages and /live/models/{id} (copies for offline), offline.html; cleared on sign-out (pwa.js)
  wwwroot/js/folders.js      the list of models: drag a model or folder onto a folder (or a crumb of the path) -> the hidden form, handler Drop
tests/MatShape.Tests         unit + database tests (ModelTests, FolderTests incl. the migration, AccountTests, StudioContentTests, AiTests, MeshTests (fake Meshy), TextCatalogTests);
                             Platform/: the definition (PlatformDefinitionTests, no database) and the whole app in memory (MatShapeFactory = WebApplicationFactory on a database of
                             its own, first account admin@example.com; PlatformApiTests, the collection "The app in memory" runs alone after the rest because the factories set environment variables)
```

## The content of a Part Studio

`{ "features": [ { "id", "type", "name", "suppressed", "view" (sketch: show/hide), "params": {...} } ], "parts": { "<partId>": { "name", "color" } }, "rollback": null | index }`.
Part ids are derived from the feature that made the part (`<featureId>`, `<featureId>.<n>` for several bodies or copies, `<partId>~<featureId>` for the other half of a split), so names and colours
survive a regeneration. A sketch plane is `{ kind: "std", name }`, `{ kind: "plane", id }` (a Plane feature) or `{ kind: "face", frame: { o, x, y, n } }` (fixed when the face was picked).
Sketch constraints: `params.cons = [{ id, type, refs, value? }]`, a ref is a point `{ e, k: a|b|c|s|e|p }` (`{ e: "origin", k: "p" }`) or a curve `{ e }`; types and glyphs in `sketchsolve.js` (CONSTRAINTS).
Sketch entities: `line {a,b}`, `rect {a,b}`, `circle {c,r}`, `arc {c,r,a0,a1}` (radians, counter-clockwise), `polygon {c,r,n,rot}`, `point {p}`; `cons: true` = construction,
`use: true` = taken from the model (fixed).
A tab is a Part Studio, or a drawing (`"drawing": { source, sheet, scale, views, section, hidden, dims, centres, title, notes, moved }`, no features) or an
assembly (`"assembly": { instances, mates }`); the server makes them with POST /live/models/{id}/studios { name, kind } (StudioContent.ForKind).
Sketch entities also `spline { pts }`, `ellipse { c, rx, ry, rot }`; `params.image` = a picture behind the sketch { src, aspect, width, x, y, opacity };
constraints also `symmetric` (2 points + line), `arclength`, `driven: true` (a dimension that only shows its value).
Fillet `{ edges, radius }`, chamfer `{ edges, mode: equal|two, distance, distance2, flip }`; an edge ref is `{ part, faces: [name, name], at }` (an edge by its two faces; at = where
it was picked), `{ part, face }` (every edge of a face) or `{ part }` (every edge of the part). Profiles are referred to by
the sorted ids of their entities (`profiles: null` = all). Fields of features are strings (expressions), evaluated at regeneration.
Figure `{ scale, detail: rough|normal|fine, flat, parts: [{ name, color, smooth, blocks: [{ t, c | a/b, r | r2 | size | h | R | ra/rb, round, rot, op: "cut", blend }] }] }` (block numbers in mm,
Z up, the front looks to -Y); parts `<id>` (one group) or `<id>.<n>`. Import bodies of the 3D generation carry `kept: true` (their faces are final).

## Conventions

**Database (PostgreSQL)**: tables PascalCase and singular, key always `Id` BIGINT, every record has `CreateDate/CreateUserId/UpdateDate/UpdateUserId` (filled by `AppDbContext.SaveChanges`),
`UpdateState` (0 deleted, 1 created, 2 updated) for soft delete (`Model`, `PartStudio`, `User`), a `Token` (uuid) for a security key (`UserSession.Token`, `Model.ShareToken`). The content of a Part
Studio and of a version is `jsonb`.

**Security**: every model query goes through `ModelAccess`; a model you may not see answers 404. Every change of `/live` needs a signed-in person, the antiforgery header
`RequestVerificationToken` and the editor right (checked in the business layer). A link never edits. Saving compares the revision in the UPDATE itself (no lost update). The CSP forbids inline script and
style (scripts set styles through the CSSOM). Text is always put into the page with `textContent`, never as HTML. Mail addresses are never logged in full.

**Platform (MatDesign docs/PLATFORM.md, contract 2; the app model docs/APP-MODEL.md)**: `/api*` and the Connections area come from MatPlatform; MatShapePlatform only describes and asks the
services. MatShape consumes `identity.oidc` and `mail.smtp` (both optional) and runs without any variable. A new figure for a home screen is a widget made of existing tiles (no code per shell);
every icon of the definition must be in the MatUi sprite (an icon of `app-icons.svg` fails the validator). `MAT_PUBLIC_URL` wins over the stored public address everywhere
(`InstanceService.SettingsAsync`) and fixes it on *Administration → System* and in `/api/configure`; the stored value stays and comes back when the variable goes.

**UI (MatDesign rules)**: CRUD = list page (toolbar above, table/gallery, pager under it, actions left below) + separate edit page (Save, Back, space, Delete); a model has **tabs** (General, People,
Link, Versions) that are pages of their own. The editor is the special UI of the app (like a designer in a designer app): its own page without the menu, built on the tokens of the toolkit.
Icons via `Ui.Icon` (toolkit sprite + `wwwroot/img/app-icons.svg`; a missing name is a bug). Every `td` has `data-label`. The version at the foot of the menu links to `/About`.

**Code**: Microsoft C# guidelines, file-scoped namespaces, `.editorconfig`. The business layer is static classes taking the `AppDbContext` and the actor. No database queries in page models or views
beyond calling the business layer. English identifiers and comments, UI texts only in the catalog.

**Compose files**: no environment variables to set, no placeholders; a stack (`name:`) per file; `docker-compose.yml` (release), `.dev.yml` (nightly + pgAdmin), `.local.yml` (build + pgAdmin, subnet 10.253.39.0/24).

**Git**: commit under the user's name; never add a Claude/Anthropic co-author trailer or a "generated with" line (global rule of the user; it overrides any default). Branches: `main` = release, `dev` =
development. Versions: release `<major>.<minor>.<build>-<date>`, development `nightly-<build>-<date>`, local `local-<date>` (`Directory.Build.props`; `.github/workflows/build.yml` builds, tests and pushes the image).
