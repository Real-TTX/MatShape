using System.Text.Json;
using MatShape.Data;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Ai;

/// <summary>
/// The settings of the AI of the installation (kept as JSON in <c>SystemSetting.AiSettings</c>): whether it is on, the instruction of the site and the limits that keep the costs in check.
/// A limit of 0 means: no limit. The defaults are for settings that were never saved.
/// </summary>
public sealed class AiSettings
{
    public bool Enabled { get; set; } = true;

    /// <summary>Added to the built-in instruction of the modelling assistant (house rules: "Use metric sizes", "Wall thickness at least 2 mm" ...). Empty = none.</summary>
    public string Instruction { get; set; } = string.Empty;

    /// <summary>Tokens one person may use per day. A request of the assistant costs about 6 000 to 20 000 tokens (the instruction, the Part Studio, the answer).</summary>
    public int UserDailyTokens { get; set; } = 1_000_000;

    /// <summary>Tokens one person may use per month.</summary>
    public int UserMonthlyTokens { get; set; } = 15_000_000;

    /// <summary>Tokens all people together may use per month.</summary>
    public int MonthlyTokens { get; set; } = 100_000_000;

    /// <summary>Calls one address may make per minute.</summary>
    public int PerMinutePerAddress { get; set; } = 20;

    /// <summary>The length cap of one answer (a reasoning model thinks inside it).</summary>
    public int MaxTokens { get; set; } = 16_000;

    public int TimeoutSeconds { get; set; } = 240;

    /// <summary>How often the editor sends a result that does not build back to the AI to fix it, by itself.</summary>
    public int RepairRounds { get; set; } = 2;

    /// <summary>The 3D generation (Meshy): its own switch, address, model and limits. Its key lies in <see cref="AiSecretStore"/> like the keys of the profiles.</summary>
    public MeshSettings Mesh { get; set; } = new();

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static AiSettings Parse(string? json)
    {
        try
        {
            return JsonSerializer.Deserialize<AiSettings>(string.IsNullOrWhiteSpace(json) ? "{}" : json, Json) ?? new AiSettings();
        }
        catch (JsonException)
        {
            return new AiSettings();
        }
    }

    public string ToJson() => JsonSerializer.Serialize(this, Json);

    /// <summary>The settings as they are saved (no right needed to read them: they hold no secret).</summary>
    public static async Task<AiSettings> LoadAsync(AppDbContext db, CancellationToken ct = default)
    {
        var settings = Parse(await db.SystemSettings.AsNoTracking().Where(s => s.Id == 1).Select(s => s.AiSettings).FirstOrDefaultAsync(ct));
        settings.Mesh ??= new MeshSettings();
        return settings;
    }
}

/// <summary>
/// The 3D generation: a picture (or up to four views of one thing) or a text becomes a mesh at Meshy, which the editor makes a solid part of. A generation costs credits there
/// (about 20 with the current model, 5 with "meshy-6-lite"), so the limits count generations, not tokens. A limit of 0 means: no limit.
/// </summary>
public sealed class MeshSettings
{
    public bool Enabled { get; set; } = true;

    /// <summary>The address of the API; another one only for a proxy or a test server.</summary>
    public string BaseUrl { get; set; } = MeshyClient.DefaultBaseUrl;

    /// <summary>"latest", "meshy-6" or "meshy-6-lite" (cheaper, coarser).</summary>
    public string Model { get; set; } = "latest";

    /// <summary>The triangles of a result (Meshy remeshes to about this many): enough for a figure, light enough for the kernel.</summary>
    public int Polycount { get; set; } = 30_000;

    /// <summary>Generations one person may start per day.</summary>
    public int UserDaily { get; set; } = 10;

    /// <summary>Generations all people together may start per month.</summary>
    public int Monthly { get; set; } = 300;
}
