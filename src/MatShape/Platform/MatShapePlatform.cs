using System.Text.Json;
using MatShape.Services;
using MatPlatform;

namespace MatShape.Platform;

/// <summary>
/// MatShape as an app of the platform contract (MatDesign docs/PLATFORM.md) on the shared package MatPlatform (the folder <c>MatPlatform/</c>, a copy):
/// how a consumer such as Mattiverse shows MatShape (<see cref="Describe"/>: tiles, the few settings, buttons), its values and what its buttons do.
/// The settings are the two of the admin page System (registration, public address), kept in the same place (<see cref="InstanceService"/>).
/// The values come from the services (no DbContext here: this is the web layer).
/// </summary>
public sealed class MatShapePlatform(InstanceService instance, ILogger<MatShapePlatform> log)
    : IMatPlatformState, IMatPlatformConfiguration, IMatPlatformActions, IMatPlatformHealth
{
    /// <summary>The id of MatShape in the platform (and the default client id at MatIdentity), as in MatDesign <c>AppRegistry.cs</c>.</summary>
    public const string AppId = "matshape";

    /// <summary>The accent of MatShape (a fresh green in the family of the CAD tools on the web, but its own; see <c>wwwroot/css/app.css</c>).</summary>
    public const string Accent = "#3cb764";

    /// <summary>The MatApiDefinition of MatShape (<c>GET /api</c>); <c>auth</c> and <c>endpoints</c> are set by MatPlatform.</summary>
    public static void Describe(MatPlatformBuilder o)
    {
        var T = o.T;

        o.App(AppId, "MatShape", T("3D-CAD im Browser: parametrische Teile modellieren", "3D CAD in the browser: model parametric parts"), AppInfo.Version, "/img/logo/matshape-mark.svg", Accent, "/Models");

        o.Page("overview", T("Übersicht", "Overview"), "dashboard",
            MatSection.Tiles("users", "models", "sharedModels", "linkedModels", "studios", "versions", "changedLast7Days", "registration", "lastActivity"),
            MatSection.Actions("openApp", "openUsers", "openSystem", "cleanUp"));
        o.Page("settings", T("Einstellungen", "Settings"), "settings",
            MatSection.Form(T("Allgemein", "General"), "registrationOpen", "publicUrl"));

        o.Tile("users", T("Aktive Benutzer", "Active users"), icon: "users");
        o.Tile("models", T("Modelle", "Models"), icon: "box");
        o.Tile("sharedModels", T("Geteilte Modelle", "Shared models"), icon: "users");
        o.Tile("linkedModels", T("Modelle mit Link", "Models with a link"), icon: "link");
        o.Tile("studios", T("Part Studios", "Part Studios"), icon: "layers");
        o.Tile("versions", T("Versionen", "Versions"), icon: "git");
        o.Tile("changedLast7Days", T("Geändert in 7 Tagen", "Changed in 7 days"), icon: "activity");
        o.Tile("registration", T("Registrierung", "Sign-up"), "status", icon: "user");
        o.Tile("lastActivity", T("Letzte Änderung an einem Modell", "Last change to a model"), "time", icon: "activity");

        o.Field(new MatField("registrationOpen", T("Registrierung offen", "Open sign-up"), "bool")
        {
            Hint = T("Aus: nur Administratoren legen Konten an.", "Off: only administrators create accounts."),
        });
        o.Field(new MatField("publicUrl", T("Öffentliche Adresse", "Public address"), "url")
        {
            Max = 300,
            Placeholder = "https://cad.example.com",
            Hint = T("Für die Adressen in E-Mails; leer: die Adresse des Aufrufs.", "For the addresses in mails; empty: the address of the request."),
        });

        o.LinkAction("openApp", T("Öffnen", "Open"), "external", "/Models");
        o.LinkAction("openUsers", T("Benutzer", "Users"), "users", "/Admin/Users");
        o.LinkAction("openSystem", T("System", "System"), "settings", "/Admin/System");
        o.PostAction(
            "cleanUp",
            T("Aufräumen", "Clean up"),
            "broom",
            T("Beendete Sitzungen und vor mehr als 30 Tagen gelöschte Modelle jetzt endgültig entfernen?",
              "Remove ended sessions and the models deleted more than 30 days ago for good now?"));

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
            ["models"] = new(s.Models),
            ["sharedModels"] = new(s.SharedModels),
            ["linkedModels"] = new(s.LinkedModels),
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
        log.LogInformation("Clean-up through the platform API by {Caller}: {Sessions} sessions, {Models} models", call.Caller, result.Sessions, result.Models);
        return new MatActionResult(true, call.T(
            $"Aufgeräumt: {result.Sessions} Sitzungen, {result.Models} Modelle.",
            $"Cleaned up: {result.Sessions} sessions, {result.Models} models."));
    }
}
