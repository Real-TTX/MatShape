using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Accounts;
using MatShape.Services.Models;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Ai;

/// <summary>
/// The 3D generation (like Meshy's own app): a person who may change a model sends a picture, up to four views of one thing, or a text; Meshy makes a mesh of it in a minute or two.
/// Every generation is an <see cref="AiRun"/> (action <see cref="AiAction.Mesh"/>) that follows the task there: only the person who started it asks for its state and fetches its files,
/// through the server (the key stays here, the page may only talk to its own address). The limits count generations (they cost credits at Meshy), per person per day and for all
/// per month; failed ones are not counted (Meshy gives their credits back).
/// </summary>
public static class MeshService
{
    public static class Codes
    {
        public const string Denied = "denied";
        public const string Invalid = "invalid";
        public const string Disabled = "disabled";
        public const string NotConfigured = "not-configured";
        public const string Limit = "limit";
        public const string Failed = "failed";
    }

    public sealed record Picture(string? MediaType, string? Data);

    /// <summary>What the editor sends: kind "image" (pictures, the first is the front) or "text" (prompt).</summary>
    public sealed record StartRequest(string? Kind, IReadOnlyList<Picture>? Images, string? Prompt);

    public sealed record Failure(string Message, string Code);

    /// <summary>The state for the editor: "pending" | "running" | "done" | "failed" | "cancelled", the progress, the reason, whether a thumbnail can be fetched.</summary>
    public sealed record State(string Status, int Progress, string? Error, bool Thumbnail);

    private static readonly string[] ImageTypes = ["image/png", "image/jpeg", "image/webp"];

    private const int MaxImageBytes = 12 * 1024 * 1024;

    /// <summary>Whether the editor offers the generation: the AI and the generation switched on, and the key stored.</summary>
    public static async Task<bool> IsAvailableAsync(AppDbContext db, IServiceProvider services, CancellationToken ct = default)
    {
        var settings = await AiSettings.LoadAsync(db, ct);
        return settings.Enabled && settings.Mesh.Enabled && services.GetRequiredService<AiSecretStore>().Has(AiSecretStore.Installation, AiSecretStore.Meshy);
    }

    /// <summary>The job of a request, or a sentence what is wrong with it.</summary>
    public static (MeshyClient.Job? Job, string? Problem) Read(StartRequest request)
    {
        if (request.Kind == "text")
        {
            var prompt = (request.Prompt ?? string.Empty).Trim();
            return prompt.Length == 0
                ? (null, Text.T("Ai.Mesh.Error.NoPrompt"))
                : (new MeshyClient.Job("text", [], prompt.Length > MeshyClient.MaxPrompt ? prompt[..MeshyClient.MaxPrompt] : prompt), null);
        }

        var images = request.Images ?? [];
        if (images.Count == 0)
        {
            return (null, Text.T("Ai.Mesh.Error.NoPicture"));
        }

        if (images.Count > MeshyClient.MaxImages)
        {
            return (null, Text.T("Ai.Mesh.Error.TooManyPictures", MeshyClient.MaxImages));
        }

        var uris = new List<string>();
        foreach (var image in images)
        {
            var type = (image.MediaType ?? string.Empty).ToLowerInvariant();
            var data = image.Data ?? string.Empty;
            if (!ImageTypes.Contains(type))
            {
                return (null, Text.T("Ai.Mesh.Error.PictureType"));
            }

            Span<byte> probe = new byte[Math.Min(data.Length, 64)];
            if (data.Length == 0 || data.Length / 4 * 3 > MaxImageBytes || !Convert.TryFromBase64String(data[..(Math.Min(data.Length, 64) / 4 * 4)], probe, out _))
            {
                return (null, Text.T("Ai.Mesh.Error.PictureSize"));
            }

            uris.Add($"data:{type};base64,{data}");
        }

        return (new MeshyClient.Job("image", uris, null), null);
    }

    public static async Task<(long? RunId, Failure? Failure)> StartAsync(AppDbContext db, IServiceProvider services, long userId, long studioId, StartRequest request, string? address, CancellationToken ct = default)
    {
        var studio = await db.PartStudios.AsNoTracking().Where(s => s.Id == studioId).Select(s => new { s.Id, s.ModelId }).FirstOrDefaultAsync(ct);
        if (studio is null || await ModelAccess.FindAsync(db, Actor.Of(userId), studio.ModelId, ModelRole.Editor, ct: ct) is null)
        {
            return (null, new Failure(Text.T("Errors.NotFound.Text"), Codes.Denied));
        }

        var (job, problem) = Read(request);
        if (job is null)
        {
            return (null, new Failure(problem!, Codes.Invalid));
        }

        var settings = await AiSettings.LoadAsync(db, ct);
        if (!settings.Enabled || !settings.Mesh.Enabled)
        {
            return (null, new Failure(Text.T("Ai.Mesh.Error.Off"), Codes.Disabled));
        }

        var key = await services.GetRequiredService<AiSecretStore>().LoadAsync(AiSecretStore.Installation, AiSecretStore.Meshy, ct);
        if (string.IsNullOrEmpty(key))
        {
            return (null, new Failure(Text.T("Ai.Mesh.Error.NoKey"), Codes.NotConfigured));
        }

        var limiter = services.GetRequiredService<AiRateLimiter>();
        if (!limiter.TryTake(address, settings.PerMinutePerAddress))
        {
            return (null, new Failure(Text.T("Ai.Limit.Minute"), Codes.Limit));
        }

        var now = DateTime.UtcNow;
        if (await LimitReasonAsync(db, settings.Mesh, userId, now, ct) is { } limit)
        {
            return (null, new Failure(limit, Codes.Limit));
        }

        var run = new AiRun
        {
            Action = AiAction.Mesh,
            ModelId = studio.ModelId,
            StudioId = studio.Id,
            UserId = userId,
            AddressHash = address is null ? null : limiter.Hash(address),
            StartDate = now,
            CreateUserId = userId,
            ProfileName = "Meshy",
            Model = settings.Mesh.Model,
            Prompt = job.Kind == "text" ? job.Prompt : Text.T("Ai.Mesh.RunPictures", job.Images.Count),
        };
        db.AiRuns.Add(run);
        var number = 0;
        void Step(AiStepKind kind, string text) => run.Steps.Add(new AiRunStep { Kind = kind, Text = text, Number = ++number, OccurredDate = DateTime.UtcNow, CreateUserId = userId });

        // the log names the request, never the pictures themselves
        var logged = MeshyClient.BodyOf(job with { Images = [.. job.Images.Select(i => $"{i[..i.IndexOf(',')]},… ({i.Length * 3 / 4 / 1024} KB)")] }, settings.Mesh);
        Step(AiStepKind.Message, $"POST {MeshyClient.PathOf(job)}\n{logged.ToJsonString(new JsonSerializerOptions { WriteIndented = true })}");
        string? path, error;
        try
        {
            (path, error) = await MeshyClient.CreateAsync(Http(services), settings.Mesh.BaseUrl, key, job, settings.Mesh, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            (path, error) = (null, Text.T("Ai.Mesh.Error.Unreachable", ex.Message));
        }

        if (path is null)
        {
            run.Status = AiRunStatus.Error;
            run.Error = error;
            run.EndDate = DateTime.UtcNow;
            Step(AiStepKind.Warning, error ?? string.Empty);
            await db.SaveChangesAsync(CancellationToken.None);
            return (null, new Failure(error ?? Text.T("Ai.Mesh.Error.Failed"), Codes.Failed));
        }

        run.ResultJson = new JsonObject { ["provider"] = "meshy", ["task"] = path }.ToJsonString();
        Step(AiStepKind.Result, "task " + path);
        await db.SaveChangesAsync(CancellationToken.None);
        return (run.Id, null);
    }

    /// <summary>The generations that count against the limits: running and done (a failed one costs nothing at Meshy).</summary>
    private static IQueryable<AiRun> Counted(AppDbContext db) => db.AiRuns.Where(r => r.Action == AiAction.Mesh && (r.Status == AiRunStatus.Running || r.Status == AiRunStatus.Done));

    private static async Task<string?> LimitReasonAsync(AppDbContext db, MeshSettings settings, long userId, DateTime now, CancellationToken ct)
    {
        var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        if (settings.Monthly > 0 && await Counted(db).CountAsync(r => r.StartDate >= monthStart, ct) >= settings.Monthly)
        {
            return Text.T("Ai.Mesh.Limit.Month", settings.Monthly);
        }

        return settings.UserDaily > 0 && await Counted(db).CountAsync(r => r.UserId == userId && r.StartDate >= now.Date, ct) >= settings.UserDaily
            ? Text.T("Ai.Mesh.Limit.Day", settings.UserDaily)
            : null;
    }

    /// <summary>The state of a generation of this person (null: not theirs, or none). A running one asks Meshy and records the end.</summary>
    public static async Task<State?> StatusAsync(AppDbContext db, IServiceProvider services, long userId, long runId, CancellationToken ct = default)
    {
        var run = await db.AiRuns.FirstOrDefaultAsync(r => r.Id == runId && r.UserId == userId && r.Action == AiAction.Mesh, ct);
        if (run is null)
        {
            return null;
        }

        var info = Info(run);
        switch (run.Status)
        {
            case AiRunStatus.Done:
                return new State("done", 100, null, info["thumbnail"] is not null);
            case AiRunStatus.Cancelled:
                return new State("cancelled", 0, run.Error, false);
            case not AiRunStatus.Running:
                return new State("failed", 0, run.Error, false);
        }

        var settings = await AiSettings.LoadAsync(db, ct);
        var key = await services.GetRequiredService<AiSecretStore>().LoadAsync(AiSecretStore.Installation, AiSecretStore.Meshy, ct);
        var task = info["task"]?.GetValue<string>();
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(task))
        {
            return await EndAsync(db, run, AiRunStatus.Error, Text.T("Ai.Mesh.Error.NoKey"));
        }

        MeshyClient.TaskState? state;
        string? error;
        try
        {
            (state, error) = await MeshyClient.GetAsync(Http(services), settings.Mesh.BaseUrl, key, task, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            (state, error) = (null, ex.Message);
        }

        if (state is null)
        {
            // Meshy could not be asked this time: the editor asks again; a run that is far too old ends
            if (run.StartDate < DateTime.UtcNow.AddHours(-2))
            {
                return await EndAsync(db, run, AiRunStatus.Error, Text.T("Ai.Mesh.Error.Timeout"));
            }

            services.GetRequiredService<ILoggerFactory>().CreateLogger("Ai").LogWarning("Meshy could not be asked for run {Run}: {Error}", run.Id, error);
            return new State("running", (int?)info["progress"] ?? 0, null, false);
        }

        if (state.State == "done")
        {
            info["glb"] = state.Glb;
            info["stl"] = state.Stl;
            info["thumbnail"] = state.Thumbnail;
            info["progress"] = 100;
            run.ResultJson = info.ToJsonString();
            run.Steps.Add(new AiRunStep { Kind = AiStepKind.Result, Text = $"SUCCEEDED: {string.Join(", ", new[] { state.Glb is null ? null : "glb", state.Stl is null ? null : "stl" }.OfType<string>())}", Number = await NextStepAsync(db, run.Id, ct), OccurredDate = DateTime.UtcNow, CreateUserId = userId });
            await EndAsync(db, run, AiRunStatus.Done, null);
            return new State("done", 100, null, state.Thumbnail is not null);
        }

        if (state.State == "failed")
        {
            await EndAsync(db, run, AiRunStatus.Error, state.Error);
            return new State("failed", state.Progress, state.Error, false);
        }

        if ((int?)info["progress"] != state.Progress)
        {
            info["progress"] = state.Progress;
            run.ResultJson = info.ToJsonString();
            await db.SaveChangesAsync(CancellationToken.None);
        }

        return new State(state.State, state.Progress, null, false);
    }

    /// <summary>
    /// A file of a finished generation of this person: "model" (the GLB, else the STL), "stl", or "thumbnail" (PNG). Null when it is not theirs, not done, or no longer at Meshy (three days).
    /// </summary>
    public static async Task<(byte[] Bytes, string ContentType, string Format)?> FileAsync(AppDbContext db, IServiceProvider services, long userId, long runId, string what, CancellationToken ct = default)
    {
        var run = await db.AiRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId && r.UserId == userId && r.Action == AiAction.Mesh && r.Status == AiRunStatus.Done, ct);
        if (run is null)
        {
            return null;
        }

        var info = Info(run);
        var (url, type, format) = what switch
        {
            "thumbnail" => (info["thumbnail"]?.GetValue<string>(), "image/png", "png"),
            "stl" => (info["stl"]?.GetValue<string>(), "model/stl", "stl"),
            _ when info["glb"] is not null => (info["glb"]?.GetValue<string>(), "model/gltf-binary", "glb"),
            _ => (info["stl"]?.GetValue<string>(), "model/stl", "stl"),
        };
        if (string.IsNullOrEmpty(url))
        {
            return null;
        }

        try
        {
            var bytes = await MeshyClient.DownloadAsync(Http(services), url, ct);
            return bytes is null ? null : (bytes, type, format);
        }
        catch (HttpRequestException)
        {
            return null;
        }
    }

    /// <summary>Stops a running generation of this person (a task that still waits gives its credits back at Meshy).</summary>
    public static async Task<bool> CancelAsync(AppDbContext db, IServiceProvider services, long userId, long runId, CancellationToken ct = default)
    {
        var run = await db.AiRuns.FirstOrDefaultAsync(r => r.Id == runId && r.UserId == userId && r.Action == AiAction.Mesh, ct);
        if (run is null)
        {
            return false;
        }

        if (run.Status != AiRunStatus.Running)
        {
            return true;
        }

        var settings = await AiSettings.LoadAsync(db, ct);
        var key = await services.GetRequiredService<AiSecretStore>().LoadAsync(AiSecretStore.Installation, AiSecretStore.Meshy, ct);
        if (!string.IsNullOrEmpty(key) && Info(run)["task"]?.GetValue<string>() is { Length: > 0 } task)
        {
            try
            {
                await MeshyClient.DeleteAsync(Http(services), settings.Mesh.BaseUrl, key, task, ct);
            }
            catch (HttpRequestException)
            {
                // the task runs out at Meshy; here it is stopped either way
            }
        }

        await EndAsync(db, run, AiRunStatus.Cancelled, Text.T("Ai.Cancelled"));
        return true;
    }

    // ---- administration ---------------------------------------------------------------------------------------------------------

    /// <summary>The page of the administration: the settings, whether a key is stored, the generations of this month. Null for anyone but an administrator.</summary>
    public static async Task<(MeshSettings Settings, bool HasKey, int ThisMonth)?> AdminAsync(AiContext c, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var now = DateTime.UtcNow;
        var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        return ((await AiSettings.LoadAsync(c.Db, ct)).Mesh, HasKey(c.Services), await Counted(c.Db).CountAsync(r => r.StartDate >= monthStart, ct));
    }

    public static bool HasKey(IServiceProvider services) => services.GetRequiredService<AiSecretStore>().Has(AiSecretStore.Installation, AiSecretStore.Meshy);

    /// <summary>Saves the settings of the generation (the others stay) and the key: a typed key replaces the stored one, an empty field keeps it, <paramref name="removeKey"/> deletes it.</summary>
    public static async Task<(bool Denied, List<FieldError> Errors)> SaveAsync(AiContext c, MeshSettings input, string? key, bool removeKey, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return (true, []);
        }

        var errors = new List<FieldError>();
        var baseUrl = (input.BaseUrl ?? string.Empty).Trim();
        if (baseUrl.Length == 0)
        {
            baseUrl = MeshyClient.DefaultBaseUrl;
        }

        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            errors.Add(new FieldError(nameof(MeshSettings.BaseUrl), Text.T("Ai.Mesh.BaseUrl.Invalid")));
        }

        if (!MeshyClient.Models.Contains(input.Model))
        {
            errors.Add(new FieldError(nameof(MeshSettings.Model), Text.T("Ai.Mesh.Model.Invalid")));
        }

        key = key?.Trim();
        if (key is { Length: > 400 } || key?.Any(char.IsWhiteSpace) == true)
        {
            errors.Add(new FieldError("ApiKey", Text.T("Ai.Mesh.Key.Invalid")));
        }

        if (errors.Count > 0)
        {
            return (false, errors);
        }

        var settings = await AiSettings.LoadAsync(c.Db, ct);
        settings.Mesh = new MeshSettings
        {
            Enabled = input.Enabled,
            BaseUrl = baseUrl.TrimEnd('/'),
            Model = input.Model,
            Polycount = Math.Clamp(input.Polycount, 1000, 300_000),
            UserDaily = Math.Max(0, input.UserDaily),
            Monthly = Math.Max(0, input.Monthly),
        };
        var row = await c.Services.GetRequiredService<AccountService>().SettingsAsync();
        row.AiSettings = settings.ToJson();
        await c.Db.SaveChangesAsync(ct);
        var store = c.Services.GetRequiredService<AiSecretStore>();
        if (removeKey)
        {
            await store.SaveAsync(AiSecretStore.Installation, AiSecretStore.Meshy, null, ct);
        }
        else if (!string.IsNullOrEmpty(key))
        {
            await store.SaveAsync(AiSecretStore.Installation, AiSecretStore.Meshy, key, ct);
        }

        return (false, []);
    }

    /// <summary>Tests the stored key against the address of the settings (lists one task: no credits). Null for anyone but an administrator.</summary>
    public static async Task<(bool Ok, string Text)?> TestAsync(AiContext c, CancellationToken ct = default)
    {
        if (!await UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var settings = await AiSettings.LoadAsync(c.Db, ct);
        var key = await c.Services.GetRequiredService<AiSecretStore>().LoadAsync(AiSecretStore.Installation, AiSecretStore.Meshy, ct);
        if (string.IsNullOrEmpty(key))
        {
            return (false, Text.T("Ai.Mesh.Error.NoKey"));
        }

        try
        {
            var error = await MeshyClient.CheckAsync(Http(c.Services), settings.Mesh.BaseUrl, key, ct);
            return error is null ? (true, Text.T("Ai.Mesh.Test.Ok", settings.Mesh.BaseUrl)) : (false, error);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return (false, Text.T("Ai.Mesh.Error.Unreachable", ex.Message));
        }
    }

    // ---- helpers --------------------------------------------------------------------------------------------------------------

    private static HttpClient Http(IServiceProvider services) => services.GetRequiredService<IHttpClientFactory>().CreateClient("ai");

    private static JsonObject Info(AiRun run)
    {
        try
        {
            return JsonNode.Parse(string.IsNullOrWhiteSpace(run.ResultJson) ? "{}" : run.ResultJson) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static async Task<int> NextStepAsync(AppDbContext db, long runId, CancellationToken ct)
        => (await db.AiRunSteps.Where(s => s.AiRunId == runId).MaxAsync(s => (int?)s.Number, ct) ?? 0) + 1;

    private static async Task<State> EndAsync(AppDbContext db, AiRun run, AiRunStatus status, string? error)
    {
        run.Status = status;
        run.Error = error is { Length: > 2000 } e ? e[..2000] : error;
        run.EndDate = DateTime.UtcNow;
        if (error is not null)
        {
            run.Steps.Add(new AiRunStep { Kind = AiStepKind.Warning, Text = error, Number = await NextStepAsync(db, run.Id, CancellationToken.None), OccurredDate = DateTime.UtcNow, CreateUserId = run.UserId });
        }

        await db.SaveChangesAsync(CancellationToken.None);
        return new State(status == AiRunStatus.Cancelled ? "cancelled" : status == AiRunStatus.Done ? "done" : "failed", 0, error, false);
    }
}
