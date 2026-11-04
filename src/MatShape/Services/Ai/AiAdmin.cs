using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Accounts;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Ai;

/// <summary>Who asks and with what: the database, the services (secrets, HTTP, the ChatGPT sign-in states) and the person.</summary>
public sealed record AiContext(AppDbContext Db, IServiceProvider Services, long ActorId);

/// <summary>The templates of the address of a profile. OpenRouter has free models (the filter "only free" on the profile page shows them).</summary>
public static class AiPresets
{
    public sealed record Preset(string Id, string Label, string Url, string ModelHint, string Region);

    public static readonly IReadOnlyList<Preset> All =
    [
        new("openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o-mini", "USA"),
        new("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat-v3-0324:free", "USA"),
        new("mistral", "Mistral", "https://api.mistral.ai/v1", "mistral-small-latest", "EU"),
        new("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat", "CN"),
        new("custom", "Custom server", string.Empty, string.Empty, "–"),
    ];

    public static Preset? Find(string? id) => All.FirstOrDefault(p => p.Id == id);
}

/// <summary>A profile as the pages show it: the row and whether its key (or sign-in) is stored.</summary>
public sealed record AiProfileRow(AiProfile Profile, bool HasSecret);

public sealed record AiProfileInput(string Name, AiProvider Provider, string? Preset, string BaseUrl, string Model, string? ApiKey, bool RemoveKey, string? Note);

/// <summary>
/// The administration of the AI: the profiles (named connections, exactly one active), the settings and limits, the list of runs. Every function checks that the actor is an active administrator;
/// the key of a profile lies in <see cref="AiSecretStore"/>, never in the database and never in a page.
/// </summary>
public static class AiAdmin
{
    public const string UserAgent = "MatShape/0.1";

    // ---- profiles -----------------------------------------------------------------------------------------------------------

    public static async Task<IReadOnlyList<AiProfileRow>?> ProfilesAsync(AiContext c, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var rows = await c.Db.AiProfiles.AsNoTracking().OrderByDescending(p => p.IsActive).ThenBy(p => p.Name).ToListAsync(ct);
        return rows.Select(p => new AiProfileRow(p, HasSecret(c, p))).ToList();
    }

    public static async Task<AiProfileRow?> ProfileAsync(AiContext c, long id, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var p = await c.Db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        return p is null ? null : new AiProfileRow(p, HasSecret(c, p));
    }

    public static bool HasSecret(AiContext c, AiProfile p)
        => c.Services.GetRequiredService<AiSecretStore>().Has(p.SecretToken, p.Provider == AiProvider.ChatGpt ? AiSecretStore.ChatGpt : AiSecretStore.ApiKey);

    /// <summary>Creates or changes a profile. The errors name the field of the form. The first profile is active at once.</summary>
    public static async Task<(AiProfile? Saved, List<FieldError> Errors, bool Denied)> SaveAsync(AiContext c, long? id, AiProfileInput input, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return (null, [], true);
        }

        var errors = new List<FieldError>();
        var name = (input.Name ?? string.Empty).Trim();
        if (name.Length == 0)
        {
            errors.Add(new FieldError("Name", Text.T("Common.NameRequired")));
        }
        else if (name.Length > 80)
        {
            errors.Add(new FieldError("Name", Text.T("Documents.NameTooLong", 80)));
        }
        else if (await c.Db.AiProfiles.AnyAsync(p => p.Name == name && p.Id != id, ct))
        {
            errors.Add(new FieldError("Name", Text.T("Ai.Profile.NameTaken")));
        }

        var baseUrl = (input.BaseUrl ?? string.Empty).Trim().TrimEnd('/');
        if (input.Provider == AiProvider.OpenAiCompatible && (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http")))
        {
            errors.Add(new FieldError("BaseUrl", Text.T("Ai.Profile.UrlInvalid")));
        }

        if (string.IsNullOrWhiteSpace(input.Model))
        {
            errors.Add(new FieldError("Model", Text.T("Ai.Profile.ModelRequired")));
        }

        AiProfile? profile = null;
        if (id is { } existing)
        {
            profile = await c.Db.AiProfiles.FirstOrDefaultAsync(p => p.Id == existing, ct);
            if (profile is null)
            {
                return (null, [], true);
            }
        }

        if (errors.Count > 0)
        {
            return (null, errors, false);
        }

        var secrets = c.Services.GetRequiredService<AiSecretStore>();
        if (profile is not null && profile.Provider != input.Provider)
        {
            // a profile that changes its kind loses what belonged to the old kind
            secrets.DeleteAll(profile.SecretToken);
        }

        profile ??= new AiProfile { CreateUserId = c.ActorId, IsActive = !await c.Db.AiProfiles.AnyAsync(ct) };
        profile.Name = name;
        profile.Provider = input.Provider;
        profile.Preset = AiPresets.Find(input.Preset)?.Id;
        profile.BaseUrl = input.Provider == AiProvider.ChatGpt ? ChatGptEndpoints.Default.BackendBase : baseUrl;
        profile.Model = input.Model.Trim();
        profile.Note = string.IsNullOrWhiteSpace(input.Note) ? null : input.Note.Trim();
        if (profile.Id == 0)
        {
            c.Db.AiProfiles.Add(profile);
        }

        await c.Db.SaveChangesAsync(ct);
        if (input.Provider == AiProvider.OpenAiCompatible)
        {
            if (input.RemoveKey)
            {
                await secrets.SaveAsync(profile.SecretToken, AiSecretStore.ApiKey, null, ct);
            }
            else if (!string.IsNullOrWhiteSpace(input.ApiKey))
            {
                await secrets.SaveAsync(profile.SecretToken, AiSecretStore.ApiKey, input.ApiKey.Trim(), ct);
            }
        }

        return (profile, [], false);
    }

    /// <summary>Makes a profile the active one; it applies at once for everybody.</summary>
    public static async Task<bool> ActivateAsync(AiContext c, long id, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return false;
        }

        var all = await c.Db.AiProfiles.ToListAsync(ct);
        if (all.All(p => p.Id != id))
        {
            return false;
        }

        foreach (var p in all)
        {
            p.IsActive = p.Id == id;
        }

        await c.Db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>A copy of a profile, without its key or sign-in (a sign-in is never copied).</summary>
    public static async Task<AiProfile?> DuplicateAsync(AiContext c, long id, string copyWord, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var source = await c.Db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);
        if (source is null)
        {
            return null;
        }

        var name = $"{source.Name} ({copyWord})";
        for (var i = 2; await c.Db.AiProfiles.AnyAsync(p => p.Name == name, ct); i++)
        {
            name = $"{source.Name} ({copyWord} {i})";
        }

        var copy = new AiProfile { Name = name.Length > 80 ? name[..80] : name, Provider = source.Provider, Preset = source.Preset, BaseUrl = source.BaseUrl, Model = source.Model, Note = source.Note, CreateUserId = c.ActorId };
        c.Db.AiProfiles.Add(copy);
        await c.Db.SaveChangesAsync(ct);
        return copy;
    }

    public static async Task<bool> DeleteAsync(AiContext c, long id, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return false;
        }

        var profile = await c.Db.AiProfiles.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (profile is null)
        {
            return false;
        }

        profile.IsActive = false;
        c.Db.AiProfiles.Remove(profile);
        await c.Db.SaveChangesAsync(ct);
        c.Services.GetRequiredService<AiSecretStore>().DeleteAll(profile.SecretToken);
        return true;
    }

    /// <summary>
    /// The models of a provider (<c>GET /models</c>): an address and a key typed into the page but not saved yet may be used; without a typed key the saved one of the profile is taken.
    /// "Free" only when the provider says so (OpenRouter: the price 0, or an id ending in <c>:free</c>).
    /// </summary>
    public static async Task<(List<ChatCompletionsClient.ModelInfo>? Models, string? Error)> ModelsAsync(AiContext c, long? id, AiProvider provider, string? baseUrl, string? typedKey, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return (null, Text.T("Errors.Forbidden.Text"));
        }

        var profile = id is { } pid ? await c.Db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.Id == pid, ct) : null;
        if (provider == AiProvider.ChatGpt)
        {
            if (profile is null)
            {
                return (null, Text.T("Ai.ChatGpt.SaveFirst"));
            }

            var models = await Account(c.Services, profile).ListModelsAsync(ct);
            return models.Count == 0 ? (null, Text.T("Ai.ChatGpt.NoModels")) : ([.. models.Select(m => new ChatCompletionsClient.ModelInfo(m.Slug, m.Name, false))], null);
        }

        var key = !string.IsNullOrWhiteSpace(typedKey) ? typedKey.Trim()
            : profile is null ? string.Empty : await c.Services.GetRequiredService<AiSecretStore>().LoadAsync(profile.SecretToken, AiSecretStore.ApiKey, ct) ?? string.Empty;
        var http = c.Services.GetRequiredService<IHttpClientFactory>().CreateClient("ai");
        return await ChatCompletionsClient.ListModelsAsync(http, string.IsNullOrWhiteSpace(baseUrl) ? profile?.BaseUrl ?? string.Empty : baseUrl, key, ct);
    }

    // ---- the ChatGPT sign-in of a profile -------------------------------------------------------------------------------------

    public static ChatGptAccount Account(IServiceProvider services, AiProfile profile)
    {
        var secrets = services.GetRequiredService<AiSecretStore>();
        var states = services.GetRequiredService<ChatGptLoginStates>();
        var http = services.GetRequiredService<IHttpClientFactory>();
        var logger = services.GetRequiredService<ILoggerFactory>().CreateLogger("ChatGpt");
        return new ChatGptAccount(secrets.ChatGptStore(profile.SecretToken), () => http.CreateClient("ai"), ChatGptEndpoints.Default, states.For(profile.SecretToken.ToString("N")),
            UserAgent, "matshape", Text.T("Ai.ChatGpt.Where"), m => logger.LogInformation("{Message}", m));
    }

    private static async Task<AiProfile?> ChatGptProfileAsync(AiContext c, long id, CancellationToken ct)
        => await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct)
            ? await c.Db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id && p.Provider == AiProvider.ChatGpt, ct)
            : null;

    public static async Task<(ChatGptAccount.PendingLogin? Pending, string? Error)?> StartChatGptLoginAsync(AiContext c, long id, CancellationToken ct = default)
        => await ChatGptProfileAsync(c, id, ct) is { } p ? await Account(c.Services, p).StartLoginAsync(ct) : null;

    public static async Task<ChatGptAccount.Status?> ChatGptStatusAsync(AiContext c, long id, bool poll, CancellationToken ct = default)
        => await ChatGptProfileAsync(c, id, ct) is { } p ? await Account(c.Services, p).GetStatusAsync(poll, ct) : null;

    public static async Task<bool> ChatGptLogoutAsync(AiContext c, long id, CancellationToken ct = default)
    {
        if (await ChatGptProfileAsync(c, id, ct) is not { } p)
        {
            return false;
        }

        await Account(c.Services, p).LogoutAsync(ct);
        return true;
    }

    // ---- settings -----------------------------------------------------------------------------------------------------------

    public static async Task<AiSettings?> SettingsAsync(AiContext c, CancellationToken ct = default)
        => await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct) ? await AiSettings.LoadAsync(c.Db, ct) : null;

    public static async Task<bool> SaveSettingsAsync(AiContext c, AiSettings settings, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return false;
        }

        settings.Instruction = (settings.Instruction ?? string.Empty).Trim();
        if (settings.Instruction.Length > 4000)
        {
            settings.Instruction = settings.Instruction[..4000];
        }

        settings.UserDailyTokens = Math.Max(0, settings.UserDailyTokens);
        settings.UserMonthlyTokens = Math.Max(0, settings.UserMonthlyTokens);
        settings.MonthlyTokens = Math.Max(0, settings.MonthlyTokens);
        settings.PerMinutePerAddress = Math.Max(0, settings.PerMinutePerAddress);
        settings.MaxTokens = Math.Clamp(settings.MaxTokens, 1000, 128_000);
        settings.TimeoutSeconds = Math.Clamp(settings.TimeoutSeconds, 20, 900);
        settings.RepairRounds = Math.Clamp(settings.RepairRounds, 0, 5);
        var row = await c.Services.GetRequiredService<AccountService>().SettingsAsync();
        row.AiSettings = settings.ToJson();
        await c.Db.SaveChangesAsync(ct);
        return true;
    }

    // ---- runs ---------------------------------------------------------------------------------------------------------------

    public sealed record RunRow(long Id, AiAction Action, AiRunStatus Status, string ProfileName, string Model, int Tokens, bool Estimated, DateTime StartDate, string? UserName, string? Prompt, string? Error);

    public sealed record RunPage(IReadOnlyList<RunRow> Rows, int Total, int Matching, int TokensThisMonth);

    public static async Task<RunPage?> RunsAsync(AiContext c, string? search, string? status, int page, int pageSize, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var all = c.Db.AiRuns.AsNoTracking();
        var total = await all.CountAsync(ct);
        var filtered = all;
        if (Enum.TryParse<AiRunStatus>(status, out var st))
        {
            filtered = filtered.Where(r => r.Status == st);
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            var like = $"%{search.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";
            filtered = filtered.Where(r => (r.Prompt != null && EF.Functions.ILike(r.Prompt, like)) || EF.Functions.ILike(r.ProfileName, like) || EF.Functions.ILike(r.Model, like));
        }

        var matching = await filtered.CountAsync(ct);
        var rows = await filtered.OrderByDescending(r => r.StartDate).ThenByDescending(r => r.Id).Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct);
        var ids = rows.Select(r => r.UserId).OfType<long>().Distinct().ToList();
        var names = await c.Db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var now = DateTime.UtcNow;
        var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var month = await c.Db.AiRuns.Where(r => r.StartDate >= monthStart).SumAsync(r => r.PromptTokens + r.CompletionTokens, ct);
        return new RunPage(
            rows.Select(r => new RunRow(r.Id, r.Action, r.Status, r.ProfileName, r.Model, r.TotalTokens, r.TokensEstimated, r.StartDate, r.UserId is { } u ? names.GetValueOrDefault(u) : null, r.Prompt, r.Error)).ToList(),
            total, matching, month);
    }

    public static async Task<(AiRun Run, string? UserName)?> RunAsync(AiContext c, long id, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var run = await c.Db.AiRuns.AsNoTracking().Include(r => r.Steps.OrderBy(s => s.Number)).FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null)
        {
            return null;
        }

        var name = run.UserId is { } u ? await c.Db.Users.IgnoreQueryFilters().AsNoTracking().Where(x => x.Id == u).Select(x => x.DisplayName).FirstOrDefaultAsync(ct) : null;
        return (run, name);
    }
}
