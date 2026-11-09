using System.Text.Json;
using MatShape.Services;
using MatPlatform;

namespace MatShape.Platform;

/// <summary>
/// MatShape as an app of the platform contract (MatDesign docs/PLATFORM.md, contract 2) on the shared package MatPlatform (the folder <c>MatPlatform/</c>, a copy):
/// how a consumer such as Mattiverse shows MatShape (<see cref="Describe"/>: tiles, the few settings, buttons), what it consumes (the sign-in of MatIdentity and the
/// mail of MatSMTP, both optional), what it adds to a shell (the launcher MatShape with its document views, two widgets for administrators), its values and what its
/// buttons do. The settings are the two of the admin page System (registration, public address), kept in the same place (<see cref="InstanceService"/>).
/// The values come from the services (no DbContext here: this is the web layer).
/// </summary>
public sealed class MatShapePlatform(InstanceService instance, MatPlatformSettings settings, ILogger<MatShapePlatform> log)
    : IMatPlatformState, IMatPlatformConfiguration, IMatPlatformActions, IMatPlatformHealth
{
    /// <summary>The id of MatShape in the platform (and the default client id at MatIdentity), as in MatDesign <c>AppRegistry.cs</c>.</summary>
    public const string AppId = "matshape";

    /// <summary>The accent of MatShape (a fresh green in the family of the CAD tools on the web, but its own; see <c>wwwroot/css/app.css</c>).</summary>
    public const string Accent = "#3cb764";

    /// <summary>The MatApiDefinition of MatShape (<c>GET /api</c>) without <c>MAT_PUBLIC_URL</c>.</summary>
    public static void Describe(MatPlatformBuilder o) => Describe(o, null);

    /// <summary>
    /// The MatApiDefinition of MatShape (<c>GET /api</c>); <c>auth</c> and <c>endpoints</c> are set by MatPlatform. <paramref name="publicUrl"/> is the value of
    /// <c>MAT_PUBLIC_URL</c>: while it is set, the field <c>publicUrl</c> is fixed.
    /// </summary>
    public static void Describe(MatPlatformBuilder o, string? publicUrl)
    {
        var T = o.T;

        o.App(AppId, "MatShape", T("3D-CAD im Browser: parametrische Teile modellieren", "3D CAD in the browser: model parametric parts"), AppInfo.Version, "/img/logo/matshape-mark.svg", Accent, "/Documents");

        // What MatShape uses from other apps: the sign-in through MatIdentity and the mail through MatSMTP (the mail when a document is shared), each set by its variables.
        o.Consumes(MatCapabilities.IdentityOidc, optional: true);
        o.Consumes(MatCapabilities.MailSmtp, optional: true);

        // What MatShape adds to the home screen of a shell (Mattiverse): its icon with a new document and the lists of its menu, and two widgets for administrators.
        o.Launcher("documents", "MatShape", "/img/logo/matshape-mark.svg", "/Documents");
        o.QuickAction("documents", T("Neues Dokument", "New document"), "plus", url: "/Documents/Edit");
        o.QuickAction("documents", T("Alle Dokumente", "All documents"), "box", url: "/Documents");
        o.QuickAction("documents", T("Mit mir geteilt", "Shared with me"), "users", url: "/Documents?scope=shared");
        o.Widget(new MatWidget("documents", T("Dokumente", "Documents"), MatWidgetKinds.Tiles, "medium")
        {
            Items = ["documents", "sharedDocuments", "linkedDocuments", "changedLast7Days"],
            Icon = "box",
            Url = "/Admin/System",
            Audience = MatAudience.Admin,
        });
        o.Widget(new MatWidget("users", T("Aktive Benutzer", "Active users"), MatWidgetKinds.Stat)
        {
            Items = ["users"],
            Icon = "users",
            Url = "/Admin/Users",
            Audience = MatAudience.Admin,
        });

        o.Page("overview", T("Übersicht", "Overview"), "dashboard",
            MatSection.Tiles("users", "documents", "sharedDocuments", "linkedDocuments", "studios", "versions", "changedLast7Days", "registration", "lastActivity"),
            MatSection.Actions("openApp", "openUsers", "openConnections", "openSystem", "cleanUp"));
        o.Page("settings", T("Einstellungen", "Settings"), "settings",
            MatSection.Form(T("Allgemein", "General"), "registrationOpen", "publicUrl"));

        o.Tile("users", T("Aktive Benutzer", "Active users"), icon: "users");
        o.Tile("documents", T("Dokumente", "Documents"), icon: "box");
        o.Tile("sharedDocuments", T("Geteilte Dokumente", "Shared documents"), icon: "users");
        o.Tile("linkedDocuments", T("Dokumente mit Link", "Documents with a link"), icon: "link");
        o.Tile("studios", T("Part Studios", "Part Studios"), icon: "layers");
        o.Tile("versions", T("Versionen", "Versions"), icon: "git");
        o.Tile("changedLast7Days", T("Geändert in 7 Tagen", "Changed in 7 days"), icon: "activity");
        o.Tile("registration", T("Registrierung", "Sign-up"), "status", icon: "user");
        o.Tile("lastActivity", T("Letzte Änderung an einem Dokument", "Last change to a document"), "time", icon: "activity");

        o.Field(new MatField("registrationOpen", T("Registrierung offen", "Open sign-up"), "bool")
        {
            Hint = T("Aus: nur Administratoren legen Konten an.", "Off: only administrators create accounts."),
        });
        var address = new MatField("publicUrl", T("Öffentliche Adresse", "Public address"), "url")
        {
            Max = 300,
            Placeholder = "https://cad.example.com",
            Hint = T("Für die Adressen in E-Mails; leer: die Adresse des Aufrufs.", "For the addresses in mails; empty: the address of the request."),
        };
        o.Field(publicUrl is null ? address : address with
        {
            Fixed = true,
            Hint = T("Festgelegt durch MAT_PUBLIC_URL (Mattiverse); hier lässt sie sich nicht ändern.", "Set by MAT_PUBLIC_URL (Mattiverse); it cannot be changed here."),
        });

        o.LinkAction("openApp", T("Öffnen", "Open"), "external", "/Documents");
        o.LinkAction("openUsers", T("Benutzer", "Users"), "users", "/Admin/Users");
        o.LinkAction("openConnections", T("Verbindungen", "Connections"), "plug", "/Admin/Connections");
        o.LinkAction("openSystem", T("System", "System"), "settings", "/Admin/System");
        o.PostAction(
            "cleanUp",
            T("Aufräumen", "Clean up"),
            "broom",
            T("Beendete Sitzungen und vor mehr als 30 Tagen gelöschte Dokumente jetzt endgültig entfernen?",
              "Remove ended sessions and the documents deleted more than 30 days ago for good now?"));

        o.Role("admin", T("Administrator", "Administrator"));
        o.Role("user", T("Benutzer", "User"));
    }

    public async Task<IReadOnlyList<MatHealthCheck>> CheckHealthAsync(MatPlatformCall call, CancellationToken ct)
    {
        if (!await instance.CanConnectAsync(ct))
        {
            return [new MatHealthCheck("database", "down", call.T("Die Datenbank ist nicht erreichbar.", "The database cannot be reached."))];
        }

        var checks = new List<MatHealthCheck> { new("database", "ok") };
        if (await instance.AnyUserAsync() && (await instance.SnapshotAsync(ct)).Admins == 0)
        {
            checks.Add(new MatHealthCheck("administrators", "degraded", call.T("Kein aktiver Administrator.", "No active administrator.")));
        }

        return checks;
    }

    public async Task<IReadOnlyDictionary<string, MatStateValue>> GetStateAsync(MatPlatformCall call, CancellationToken ct)
    {
        var s = await instance.SnapshotAsync(ct);
        var (open, _) = await instance.SettingsAsync();
        return new Dictionary<string, MatStateValue>
        {
            ["users"] = new(s.Users),
            ["documents"] = new(s.Documents),
            ["sharedDocuments"] = new(s.SharedDocuments),
            ["linkedDocuments"] = new(s.LinkedDocuments),
            ["studios"] = new(s.Studios),
            ["versions"] = new(s.Versions),
            ["changedLast7Days"] = new(s.ChangedLast7Days),
            ["registration"] = open
                ? new MatStateValue("info", Text: call.T("Offen", "Open"))
                : new MatStateValue("ok", Text: call.T("Geschlossen", "Closed")),
            ["lastActivity"] = new(s.LastActivityUtc is { } last ? new DateTimeOffset(DateTime.SpecifyKind(last, DateTimeKind.Utc)) : null),
        };
    }

    public async Task<IReadOnlyDictionary<string, object?>> GetConfigurationAsync(MatPlatformCall call, CancellationToken ct)
    {
        var (open, url) = await instance.SettingsAsync();
        return new Dictionary<string, object?>
        {
            ["registrationOpen"] = open,
            ["publicUrl"] = url ?? string.Empty,
        };
    }

    /// <summary>The values are checked against the definition already (MatPlatform, <c>CheckValues</c>); the address is checked once more like on the admin page.</summary>
    public async Task<IReadOnlyDictionary<string, string>> ConfigureAsync(IReadOnlyDictionary<string, JsonElement> values, MatPlatformCall call, CancellationToken ct)
    {
        var errors = new Dictionary<string, string>();
        bool? open = null;
        string? url = null;
        foreach (var (key, value) in values)
        {
            switch (key)
            {
                case "registrationOpen" when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                    open = value.GetBoolean();
                    break;
                case "publicUrl" when settings.AppPublicUrl is not null:
                    errors[key] = call.T("Festgelegt durch MAT_PUBLIC_URL.", "Set by MAT_PUBLIC_URL.");
                    break;
                case "publicUrl" when value.ValueKind is JsonValueKind.String:
                    url = value.GetString()!;
                    break;
                case "publicUrl" when value.ValueKind is JsonValueKind.Null:
                    url = string.Empty;
                    break;
                default:
                    errors[key] = call.T("Dieser Wert passt nicht.", "This value does not fit.");
                    break;
            }
        }

        if (url is not null && InstanceService.NormalizePublicUrl(url) is { } normalized && !InstanceService.IsPublicUrl(normalized))
        {
            errors["publicUrl"] = call.T("Eine vollständige Adresse mit http:// oder https://.", "A complete address with http:// or https://.");
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        await instance.SaveSettingsAsync(open, url);

        // MatShape has no activity log of its own: the change (the keys, no values) goes to the log of the app.
        log.LogInformation("Settings changed through the platform API by {Caller}: {Keys}", call.Caller, string.Join(", ", values.Keys));
        return errors;
    }

    public async Task<MatActionResult?> RunActionAsync(string id, MatPlatformCall call, CancellationToken ct)
    {
        if (id != "cleanUp")
        {
            return null;
        }

        var result = await instance.CleanUpAsync(ct);
        log.LogInformation("Clean-up through the platform API by {Caller}: {Sessions} sessions, {Documents} documents", call.Caller, result.Sessions, result.Documents);
        return new MatActionResult(true, call.T(
            $"Aufgeräumt: {result.Sessions} Sitzungen, {result.Documents} Dokumente.",
            $"Cleaned up: {result.Sessions} sessions, {result.Documents} documents."));
    }
}
