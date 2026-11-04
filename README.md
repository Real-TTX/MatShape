<div align="center">

<img src="docs/logo/matshape-mark.svg" width="96" alt="MatShape" />

# MatShape

**3D-CAD im Browser – parametrische Teile aus Skizzen und Features, im Stil der CAD-Werkzeuge im Web, aber selbst gehostet.**

Ein App-Container und PostgreSQL. Port **3939**.

</div>

![Eine Flansch-Konstruktion: Variablen, Skizzen, Extrudieren, Rotieren, Kreismuster und eine Boolesche Operation in der Feature-Liste](docs/images/studio.png)

---

## Auf einen Blick

**Modellieren**
- **Dokumente** mit mehreren **Part Studios** (Tabs am unteren Rand: anlegen, umbenennen, duplizieren, verschieben, löschen)
- **Skizzen** auf den Ebenen Oben/Vorne/Rechts, auf versetzten Ebenen oder direkt auf **ebenen Flächen** eines Teils: Linie (als Linienzug), Rechteck, Mittelpunkt-Rechteck, Kreis, 3-Punkt-Bogen, Polygon, Punkt, **Konstruktionsgeometrie**
- Fangen an Endpunkten, Mittelpunkten, Kantenmitten und am Raster, waagerecht/senkrecht-Einrasten, Enden und ganze Formen ziehen (verbundene Enden bleiben zusammen), **exakte Maße** im Panel
- **Features**: Extrudieren (Blind, Symmetrisch, Durch alles; Neu / Hinzufügen / Entfernen / Schnittmenge), Rotieren (um Skizzenachse oder Linie), Boolesch (Vereinigen, Abziehen, Schnittmenge), Verschieben/Drehen/Kopieren, Spiegeln, Lineares Muster, Kreismuster, Teilen an einer Ebene, Teil löschen, Ebene (versetzt), **Variable**
- Jedes Feld nimmt **Ausdrücke mit Einheiten**: `25`, `2.5 cm`, `1 in`, `#d / 8`, `sqrt(#a^2 + #b^2)`, `30 deg` – eine Variable ändern, das Modell folgt
- **Feature-Historie**: bearbeiten (Doppelklick), umbenennen, unterdrücken, verschieben, löschen, **Rollback-Leiste**; Live-Vorschau während des Bearbeitens; Fehler stehen am Feature
- **Rückgängig / Wiederholen** (Strg+Z / Strg+Y), Tastenkürzel wie Umschalt+S/E/W, F, I, M
- Geometriekern: **[Manifold](https://github.com/elalish/manifold)** (WebAssembly, robuste Boolesche Operationen), Darstellung: **[three.js](https://threejs.org)** – beides als Kopie im Projekt, kein CDN

**Ansehen, messen, ausgeben**
- Orthografische 3D-Ansicht mit Achsenkreuz, Standardansichten, Einpassen, schattiert / ohne Kanten / durchsichtig, Ebenen ein/aus
- Maus: Ziehen oder rechts Ziehen dreht, Mitte oder Umschalt+Ziehen verschiebt, Mausrad zoomt zum Zeiger; **Touch**: ein Finger dreht, zwei verschieben und zoomen
- **Teile** benennen, einfärben, ausblenden, isolieren; **Masseeigenschaften** (Volumen, Oberfläche, Größe); **Messen** von Abständen
- **Export**: STL (3D-Druck), OBJ, PNG der Ansicht, Part Studio als JSON

**Zusammen arbeiten**
- **Teilen** mit Personen, die ein Konto haben – als *Bearbeiter* oder *Betrachter*, auf Wunsch mit E-Mail (MatSMTP) – oder per **Link** zum Ansehen (drehen, messen, exportieren; nie ändern)
- **Automatisches Speichern** mit Revisionsschutz: hat jemand anderes inzwischen gespeichert, wird nichts stillschweigend überschrieben (eigenen Stand behalten oder fremden laden); Änderungen anderer erscheinen von selbst
- **Versionen**: benannte Stände des ganzen Dokuments, schreibgeschützt öffnen, wiederherstellen (der Stand davor wird vorher gesichert)
- **Offline**: zuletzt geöffnete Dokumente bleiben verfügbar, Änderungen warten auf dem Gerät und werden bei Wiederverbindung gespeichert

**Oberfläche**
- **Deutsch und Englisch**, **hell / dunkel**, Farbschemata (Standard, Papier, hoher Kontrast, OLED)
- Dokumentliste als **Bilder** (Vorschau des Modells) oder **Tabelle**, mit Suche, Filter und Sortierung
- **PWA**: installierbar (Android, iOS, Desktop), Safe Areas, kein ungewolltes Zoomen; am Smartphone wird die Feature-Liste zur Schublade
- **Deine Daten (DSGVO)**: alles als JSON herunterladen und das Konto endgültig löschen
- Design von [MatDesign](https://github.com/Real-TTX/MatDesign) (MatUi 0.9.3). Das erste Konto ist der Administrator

## Screenshots

| Skizze mit Linienzug und Bogen | Feature-Dialog mit Live-Vorschau |
|---|---|
| ![Eine Skizze auf der vorderen Ebene](docs/images/sketch.png) | ![Der Dialog des Kreismusters](docs/images/feature-dialog.png) |

| Messen | Dunkel |
|---|---|
| ![Ein gemessener Abstand](docs/images/measure.png) | ![Der Editor im dunklen Design](docs/images/studio-dark.png) |

| Dokumente | Versionen |
|---|---|
| ![Die Liste der Dokumente mit Vorschaubildern](docs/images/documents.png) | ![Die Versionen eines Dokuments](docs/images/versions.png) |

| Rotieren | Per Link ansehen |
|---|---|
| ![Ein rotiertes Teil](docs/images/revolve.png) | ![Ein Dokument über den Link, nur ansehen](docs/images/link-view.png) |

| Dokument bearbeiten | Link teilen |
|---|---|
| ![Name, Beschreibung und Einheit](docs/images/document-edit.png) | ![Der Link eines Dokuments](docs/images/document-share.png) |

| Smartphone | | |
|---|---|---|
| ![Der Editor auf dem Smartphone](docs/images/phone-studio.png) | ![Die Feature-Liste als Schublade](docs/images/phone-features.png) | ![Dokumente auf dem Smartphone](docs/images/phone-documents.png) |

## Starten

```bash
docker compose up -d                                       # Release (Branch main, Image :latest)
docker compose -f docker-compose.dev.yml up -d             # Development (Branch dev, Image :nightly) mit pgAdmin auf 3940
docker compose -f docker-compose.local.yml up -d --build   # lokal aus dem Quellcode, mit pgAdmin (3940) und Postgres auf 3941
```

Dann **http://localhost:3939** öffnen und registrieren – das erste Konto ist Administrator. Danach ist die Registrierung **geschlossen**: weitere Konten legt ein Administrator an (*Administration → Benutzer*), oder er öffnet die Registrierung (*Administration → System*).

| Datei | Branch | Image | Dienste |
|---|---|---|---|
| `docker-compose.yml` | main | `ghcr.io/real-ttx/matshape:latest` | web, db |
| `docker-compose.dev.yml` | dev | `ghcr.io/real-ttx/matshape:nightly` | web, db, pgadmin |
| `docker-compose.local.yml` | – | lokal gebaut (`matshape:local`) | web, db, pgadmin |

Jede Datei ist ein eigener Stack (`matshape`, `matshape-dev`, `matshape-local`). Volumes je Stack: `web-data` (Schlüssel der Sitzungen) und `db-data` (PostgreSQL 17), bei dev/local zusätzlich `pgadmin-data`. Die Compose-Dateien brauchen **keine** Variablen. Für den Betrieb im Internet das Datenbank-Passwort ändern und einen TLS-Proxy (Caddy, Traefik) davorsetzen, der `X-Forwarded-Proto` / `X-Forwarded-Host` setzt.

### Einstellungen (Umgebung)

Keine davon ist nötig; ohne sie läuft MatShape allein mit eigenen Konten und ohne E-Mails. **Mattiverse** setzt sie, wenn es MatShape installiert.

| Variable | Bedeutung |
|---|---|
| `ConnectionStrings__Default` | Verbindung zu PostgreSQL (Standard im Image: `Host=db;Database=matshape;Username=matshape;Password=matshape`) |
| `MAT_API_KEY` | Schlüssel für die Plattform-API `/api/*` (Header `X-Api-Key`) |
| `MATIDENTITY_AUTHORITY`, `MATIDENTITY_CLIENT_ID`, `MATIDENTITY_CLIENT_SECRET`, `MATIDENTITY_INTERNAL_URL` | Anmeldung über **MatIdentity** |
| `MATSMTP_HOST`, `MATSMTP_PORT`, `MATSMTP_USERNAME`, `MATSMTP_PASSWORD`, `MATSMTP_FROM`, `MATSMTP_TLS` | E-Mails über **MatSMTP** („Ein Dokument wurde mit dir geteilt“) |

## Plattform (Mattiverse, MatIdentity, MatSMTP)

MatShape erfüllt den Plattform-Vertrag der Mat-Apps ([MatDesign `docs/PLATFORM.md`](https://github.com/Real-TTX/MatDesign/blob/main/docs/PLATFORM.md), Paket MatPlatform 1.4.0 in `src/MatShape/MatPlatform`, eine Kopie).

| Endpunkt | Inhalt | Zugriff |
|---|---|---|
| `GET /api` | Beschreibung: Seiten *Übersicht* und *Einstellungen*, Kacheln, Felder, Schaltflächen, Rollen `admin`/`user` | anonym |
| `GET /api/health` | `ok` / `degraded` (kein aktiver Administrator) / `down` (Datenbank weg) | anonym |
| `GET /api/state[/{key}]` | Kacheln: aktive Benutzer, Dokumente, geteilte Dokumente, Dokumente mit Link, Part Studios, Versionen, geändert in 7 Tagen, Registrierung, letzte Änderung | Schlüssel oder Token |
| `GET`/`PUT /api/configure` | Registrierung offen, öffentliche Adresse | Schlüssel oder Token |
| `POST /api/actions/cleanUp` | beendete Sitzungen und vor über 30 Tagen gelöschte Dokumente endgültig entfernen | Schlüssel oder Token |

**Anmeldung über MatIdentity** (nur mit `MATIDENTITY_AUTHORITY`): OpenID Connect mit PKCE, Back-Channel-Logout unter `/signout-backchannel`. Lokale Anmeldung bleibt unter `/Account/Login?local=1` erreichbar. **E-Mails über MatSMTP** (nur mit `MATSMTP_HOST`): Benachrichtigung, wenn ein Dokument mit jemandem geteilt wird (abschaltbar im Profil).

## Entwicklung

- .NET 10, ASP.NET Core **Razor Pages**, EF Core + **PostgreSQL**, MatUi-Toolkit von MatDesign (kopiert nach `wwwroot/matui`)
- Der Editor ist JavaScript als ES-Module ohne Build-Schritt (`wwwroot/js/cad/*.js`); three.js und Manifold liegen als Kopie unter `wwwroot/lib` (Lizenzen daneben). Die Geometrie wird im Browser aus der Feature-Liste berechnet; der Server speichert und prüft die Feature-Liste (JSON) und entscheidet über die Rechte
- Geschäftslogik in statischen Klassen mit Rechteprüfung in jeder Funktion (`Services/Documents`, `Services/Accounts`); keine Datenbankabfragen in Seiten
- `dotnet build MatShape.slnx`, `dotnet test` – mit `MATSHAPE_TEST_DB` (z. B. `Host=localhost;Port=3941;Username=matshape;Password=matshape;Database=postgres`) laufen auch die Datenbank-Tests, jeder in einer eigenen Datenbank
- `./scripts/redeploy.ps1` baut den Container neu und startet den lokalen Stack (`-Clean` = leere Datenbank)
- Migrationen: `dotnet ef migrations add <Name> -p src/MatShape -o Data/Migrations` (werden beim Start angewendet)
- Texte: `src/MatShape/Resources/Texts/*.json` (`{"en": …, "de": …}`); Tests prüfen, dass jeder benutzte Schlüssel – auch die des Editors – in beiden Sprachen existiert
- Mehr zur Architektur in [CLAUDE.md](CLAUDE.md)

### Versionierung und Branches

| Branch | Kanal | Version | Image-Tags |
|---|---|---|---|
| `main` | Release | `0.1.<build>-<datum>` | `<version>`, `latest`, `release` |
| `dev` | Nightly | `nightly-<build>-<datum>` | `<version>`, `nightly` |
| andere / lokal | Local | `local-<datum>` | – |

Major/Minor stehen in `Directory.Build.props`; die GitHub Action `.github/workflows/build.yml` baut, testet und veröffentlicht die Images (amd64 + arm64) nach `ghcr.io/real-ttx/matshape`. Die Version steht unten im Menü und führt zur *Über*-Seite.

## Logo

| Favicon (16–32 px) | App-Icon | Maskable (PWA) | Logo hell | Logo dunkel | Einfarbig |
|---|---|---|---|---|---|
| <img src="docs/logo/matshape-favicon.svg" width="32"> | <img src="docs/logo/matshape-mark.svg" width="64"> | <img src="docs/logo/matshape-maskable.svg" width="64"> | <img src="docs/logo/matshape-logo.svg" width="200"> | <img src="docs/logo/matshape-logo-dark.svg" width="200"> | <img src="docs/logo/matshape-mono.svg" width="64"> |

Ein isometrischer Block mit Bohrung und Bemaßung auf dem MatShape-Grün **#3CB764** – im Umfeld des typischen CAD-Grüns, aber etwas heller und gelblicher. Text auf dem Grün ist fast schwarz (7,3 : 1); Links und Akzenttext nutzen das dunklere **#1D7A3C** (im Dunkelmodus **#5FD384**). Das Favicon lässt Bemaßung und Lochwand weg, das Einfarbige ist nur Kontur.

Die Farbe muss noch in die Registry von MatDesign (`AppRegistry.cs`, `matui.apps.css`) eingetragen werden; bis dahin setzt `wwwroot/css/app.css` sie selbst.
