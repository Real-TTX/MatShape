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
        => Parse(await db.SystemSettings.AsNoTracking().Where(s => s.Id == 1).Select(s => s.AiSettings).FirstOrDefaultAsync(ct));
}
