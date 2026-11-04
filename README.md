<div align="center">

<img src="docs/logo/matshape-mark.svg" width="96" alt="MatShape" />

# MatShape

**3D CAD in the browser – parametric parts from sketches and features, self-hosted.**

Constraint sketches, a feature history, versions, sharing and an AI assistant that models from words or pictures.
One app container and PostgreSQL, no cloud, no CDN.

</div>

![A flange: variables, sketches, extrude, revolve, circular pattern and a boolean in the feature list](docs/images/studio.png)

---

## What this is about

The parametric CAD tools on the web are great – as long as your parts may live on someone else's servers. MatShape
brings the same way of working to your own server: a **document** holds **Part Studios**, a Part Studio is an ordered
list of **features** (sketch, extrude, revolve, boolean, pattern …) that is run from the top to make the parts. Change a
dimension or a variable and the model follows. The geometry is computed in the browser; the server stores the history,
checks it and decides who may see and change what.

## At a glance

**Sketching – constraint-based, like the CAD tools on the web**
- Sketch on Top / Front / Right, on offset planes or directly on a **flat face** of a part
- Line (as a chain), rectangle, centre rectangle, circle, 3-point arc, polygon, point, **construction geometry**
- Drawing sets the obvious **constraints** by itself: a rectangle is four lines with H/V, a snapped end is coincident, a
  point on a curve stays on it, a nearly level line becomes horizontal
- Constraints **Coincident (I), Horizontal (H), Vertical (V), Parallel, Perpendicular, Tangent, Equal, Midpoint,
  Concentric, Fix** – select first or pick after, shown as **symbols** next to the entities
- **Dimension tool (D)**: click two points, a point and a line, two lines (distance or angle) or one line, circle or arc,
  then type the value – also expressions with variables (`#width / 2`)
- **Colours tell the state**: blue = still free, black = fully defined, red = conflict. The sketch box shows the degrees of
  freedom; conflicting constraints are listed there (and flagged in the feature tree) and are **not applied**, so the
  geometry never tears apart
- Dragging moves entities as far as the constraints allow – a solver (Levenberg-Marquardt with a rank analysis) holds them

**Modelling**
- **Features**: extrude (blind, symmetric, through all; new / add / remove / intersect), revolve, boolean, move / rotate /
  copy, mirror, linear and circular pattern, split at a plane, delete part, offset plane, **variable**
- Every field takes **expressions with units**: `25`, `2.5 cm`, `1 in`, `#d / 8`, `sqrt(#a^2 + #b^2)`, `30 deg`
- **Feature history**: edit (double-click), rename, suppress, reorder, delete, **rollback bar**, live preview while editing
- **Undo / redo**, keyboard shortcuts like the CAD tools on the web – **?** shows them all
- Geometry kernel **[Manifold](https://github.com/elalish/manifold)** (WebAssembly, robust booleans), view **[three.js](https://threejs.org)** – both copied into the project

**Viewing, measuring, export**
- **View cube** in the corner: turns with the view, a click on a face, edge or corner looks from there
- **View themes**: automatic, high contrast (thick black lines), dark, blueprint
- Parts: name, **colour**, hide, isolate; mass properties; measure distances
- **Export: 3MF with part colours** (for slicers), STL, OBJ, PNG of the view, the Part Studio as JSON

**AI assistant**
- Describe what to build or change ("a plate 80 × 40 × 6 with four holes of 6 mm") – the AI adds **features** you edit
  like your own; the whole answer is **one** undo step, features that do not build are sent back for a **repair**
- **Attachments**: a **picture** of an object to rebuild, a **logo** (PNG or SVG) as a template for a sign or relief, or a
  PDF drawing – through the paperclip, by pasting (Ctrl+V) or by dropping files on the panel. Pictures are scaled down in
  the browser; an SVG travels as its paths (exact coordinates) and as a picture
- **Profiles** for any **OpenAI-compatible** provider (OpenAI, OpenRouter with a **free models** filter, Mistral, your own
  server) or a **ChatGPT account** by device code; limits against costs, a log of every run

**Working together**
- **Share** with people who have an account – *editor* or *viewer*, optionally by e-mail – or by **link** to view only
- **Autosave** with revision protection (nothing is overwritten silently), changes of others appear by themselves
- **Versions**: named states of the whole document, open read-only, restore
- **Offline**: recently opened documents stay available, changes wait on the device

**Interface**
- English and German, light and dark, **PWA** (installable, iOS safe areas), the feature list becomes a drawer on a phone
- **Your data (GDPR)**: download everything as JSON, delete the account for good
- Design from [MatDesign](https://github.com/Real-TTX/MatDesign) (MatUi 0.9.3)

## Screenshots

### A fully defined sketch

![A rectangle tied to the origin with two dimensions: all lines black, "Fully defined"](docs/images/sketch-constraints.png)

The rectangle came with its four H/V constraints; two dimensions (80 and 40) and a coincident with the origin make it
fully defined – the lines turn black and the sketch box says so. Free geometry stays blue.

### Conflicts at a glance

![A redundant distance in red, listed in the sketch box with a delete button](docs/images/sketch-conflict.png)

A distance that contradicts the length of the same side turns red and is listed in the sketch box with a delete button.
It is not applied, so the rest of the sketch keeps its shape. The feature tree flags the sketch with a warning.

### The AI rebuilds a logo

![The AI panel with an attached SVG logo and the resulting coloured sign](docs/images/ai-attachment.png)

An SVG logo and a picture attached in the AI panel; the answer is a 60 mm sign with the raised circle and square – in
the colours of the logo, as nine features that can be edited or undone in one step.

### Feature dialog with live preview

| Sketch | Circular pattern |
|---|---|
| ![A sketch on the front plane](docs/images/sketch.png) | ![The dialog of the circular pattern](docs/images/feature-dialog.png) |

Every feature has a small dialog; the model updates while you type.

### More

| Measure | Dark |
|---|---|
| ![A measured distance](docs/images/measure.png) | ![The editor in the dark theme](docs/images/studio-dark.png) |

| Documents | Versions |
|---|---|
| ![The documents with thumbnails](docs/images/documents.png) | ![The versions of a document](docs/images/versions.png) |

| Revolve | Viewed through a link |
|---|---|
| ![A revolved part](docs/images/revolve.png) | ![A document through its link, view only](docs/images/link-view.png) |

| AI assistant | AI profile (free models only) |
|---|---|
| ![The AI built a plate with holes and repaired it itself](docs/images/ai-assistant.png) | ![An OpenRouter profile with the free models loaded](docs/images/ai-profile.png) |

| Phone | | |
|---|---|---|
| ![The editor on a phone](docs/images/phone-studio.png) | ![The feature list as a drawer](docs/images/phone-features.png) | ![Documents on a phone](docs/images/phone-documents.png) |

## Quick start

Ready-made images (amd64 + arm64) are published to the GitHub Container Registry:

| Tag | Built from | Use it for |
|---|---|---|
| `ghcr.io/real-ttx/matshape:latest` | `main` | releases |
| `ghcr.io/real-ttx/matshape:nightly` | `dev` | the newest features |

### 1. Just run it

Copy this into `docker-compose.yml` and start it – nothing else needed:

```yaml
name: matshape

services:
  web:
    image: ghcr.io/real-ttx/matshape:latest
    restart: unless-stopped
    ports:
      - "3939:3939"
    volumes:
      - web-data:/data
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: matshape
      POSTGRES_USER: matshape
      POSTGRES_PASSWORD: matshape
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U matshape -d matshape"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  web-data:
  db-data:
```

```bash
docker compose up -d
```

Open **http://localhost:3939** and register – **the first account becomes the administrator**. After that, registration
is closed: an administrator adds accounts (*Administration → Users*) or opens registration (*Administration → System*).
An update is `docker compose pull && docker compose up -d`.

For the internet: change the database password and put a TLS proxy (Caddy, Traefik) in front that sets
`X-Forwarded-Proto` / `X-Forwarded-Host`.

### 2. From source

| File | Branch | Image | Services |
|---|---|---|---|
| `docker-compose.yml` | main | `ghcr.io/real-ttx/matshape:latest` | web, db |
| `docker-compose.dev.yml` | dev | `ghcr.io/real-ttx/matshape:nightly` | web, db, pgAdmin (3940) |
| `docker-compose.local.yml` | – | built locally | web, db (3941), pgAdmin (3940) |

```bash
docker compose -f docker-compose.local.yml up -d --build   # or ./scripts/redeploy.ps1 (-Clean = empty volumes)
```

Every file is a stack of its own (`matshape`, `matshape-dev`, `matshape-local`) and needs no variables.

### Settings that matter

None of them is required; without them MatShape runs with its own accounts and without e-mail. **Mattiverse** sets them
when it installs MatShape.

| Variable | Meaning |
|---|---|
| `ConnectionStrings__Default` | PostgreSQL (default in the image: `Host=db;Database=matshape;Username=matshape;Password=matshape`) |
| `MAT_API_KEY` | Key for the platform API `/api/*` (header `X-Api-Key`) |
| `MATIDENTITY_AUTHORITY`, `MATIDENTITY_CLIENT_ID`, `MATIDENTITY_CLIENT_SECRET`, `MATIDENTITY_INTERNAL_URL` | Sign-in through **MatIdentity** |
| `MATSMTP_HOST`, `MATSMTP_PORT`, `MATSMTP_USERNAME`, `MATSMTP_PASSWORD`, `MATSMTP_FROM`, `MATSMTP_TLS` | E-mail through **MatSMTP** ("a document was shared with you") |

### After the first sign-in

*Administration* holds **users**, **system** (registration, public address) and **AI**: add a profile (provider, key,
*Load models*, *Test*, *Activate*), set limits for tokens per person and month, and look at every run. Keys and ChatGPT
sign-ins are stored **encrypted in the `/data` volume**, never in the database or the browser.

### The volumes

```
web-data  (/data)   session keys, encrypted AI secrets ({data}/secrets/ai)
db-data             PostgreSQL 17: accounts, documents, Part Studios (jsonb), versions, AI runs
```

## Mat platform: API and sign-in through MatIdentity

MatShape follows the platform contract of the Mat apps ([MatDesign `docs/PLATFORM.md`](https://github.com/Real-TTX/MatDesign/blob/main/docs/PLATFORM.md),
package MatPlatform 1.4.0 in `src/MatShape/MatPlatform`, a copy that is never edited here).

| Endpoint | Access | What it is |
|---|---|---|
| `GET /api` | anonymous | the description: pages *Overview* and *Settings*, tiles, fields, actions, roles `admin` / `user` |
| `GET /api/health` | anonymous | `ok` / `degraded` (no active administrator) / `down` (database gone) |
| `GET /api/state[/{key}]` | key or token | tiles: active users, documents, shared documents, documents with a link, Part Studios, versions, changed in 7 days, registration, last change |
| `GET` / `PUT /api/configure` | key or token | registration open, public address |
| `POST /api/actions/cleanUp` | key or token | removes ended sessions and documents deleted more than 30 days ago |

**Sign-in through MatIdentity** is on when `MATIDENTITY_AUTHORITY` is set: OpenID Connect with PKCE, back-channel logout
at `/signout-backchannel`; the local form stays at `/Account/Login?local=1`. **E-mail through MatSMTP** is on with
`MATSMTP_HOST`: a note when a document is shared with someone (can be switched off in the profile).

## Status

| Milestone | Content | Status |
|---|---|---|
| M0 | Skeleton, Docker, CI, versioning, logo | ✅ |
| M1 | Accounts, documents, sharing, link, versions, PWA, offline | ✅ |
| M2 | Editor: features, expressions, history, rollback, export | ✅ |
| M3 | View cube, view themes, shortcuts, colours, 3MF | ✅ |
| M4 | AI assistant with profiles, limits, repair rounds | ✅ |
| M5 | **Constraint sketcher**: solver, constraint tools and symbols, dimensions by picks, conflicts | ✅ |
| M6 | **AI attachments**: rebuild from pictures, logos as templates | ✅ |
| M7 | Fillet / chamfer, shell, sketch from an image as a tracing background, assemblies | open |

## Development

```bash
dotnet build MatShape.slnx
dotnet test                       # unit tests
```

With `MATSHAPE_TEST_DB` set (e.g. `Host=localhost;Port=3941;Username=matshape;Password=matshape;Database=postgres` while
the local stack runs), the database tests run too – each creates, migrates and drops a database of its own. A test checks
that every text key of the server and the editor exists in English and German.

The real tests are end to end in a browser (Playwright with the installed Edge): register, sketch with the mouse,
constraints and dimensions, extrude, undo, offline, the link as a guest, a phone, dark mode. The geometry can also be
tested in Node: import `wwwroot/js/cad/model.js` with a Manifold kernel and call `regenerate(kernel, content, 'mm')`.

Migrations: `dotnet ef migrations add <Name> -p src/MatShape -o Data/Migrations` (applied at start-up).
Texts: `src/MatShape/Resources/Texts/*.json` (`{"en": …, "de": …}`). More on the architecture in [CLAUDE.md](CLAUDE.md).

## How it is built

- **ASP.NET Core 10** (Razor Pages + minimal API), **EF Core** with **PostgreSQL** (the history of a Part Studio is `jsonb`)
- Business logic in static classes with a permission check in every function; a document you may not see answers 404
- The editor is **plain JavaScript** (ES modules, no build step): `model.js` runs the features with Manifold,
  `sketchsolve.js` solves the sketches, `sketcher.js` is the sketch editor, `viewport.js` the three.js view
- The server never runs geometry: it stores and validates the feature list and saves with a revision check in the
  UPDATE itself (no lost update)
- CSP without inline script or style (`'wasm-unsafe-eval'` for the kernel only), antiforgery header on every change

## Branches & versioning

| Branch | Purpose | Version | Image tags |
|---|---|---|---|
| `main` | Release | `0.1.<build>-<yyyyMMdd>` | `<version>`, `latest`, `release` |
| `dev` | Development | `nightly-<build>-<yyyyMMdd>` | `<version>`, `nightly` |
| local | – | `local-<yyyyMMdd>` | – |

`Major`/`Minor` live in [`Directory.Build.props`](Directory.Build.props), the build number comes from the GitHub action
(`.github/workflows/build.yml`, which builds, tests and publishes the images). The version at the foot of the menu leads to
the *About* page.

## Logo

| Favicon (16–32 px) | App icon | Maskable (PWA) | Logo light | Logo dark | Mono |
|---|---|---|---|---|---|
| <img src="docs/logo/matshape-favicon.svg" width="32"> | <img src="docs/logo/matshape-mark.svg" width="64"> | <img src="docs/logo/matshape-maskable.svg" width="64"> | <img src="docs/logo/matshape-logo.svg" width="200"> | <img src="docs/logo/matshape-logo-dark.svg" width="200"> | <img src="docs/logo/matshape-mono.svg" width="64"> |

An isometric block with a hole and a dimension on MatShape green **#3CB764** – close to the typical CAD green, but a
little lighter and more yellow. Text on the green is near black (7.3 : 1); links and accent text use the darker
**#1D7A3C** (dark mode **#5FD384**).
