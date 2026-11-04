using System.Text.Json;
using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Ai;

/// <summary>
/// One call of the AI with the boundary around it: switched on, the brake per address, the token budgets (all checked before anything is sent), the transport (the active profile, or the
/// profile being tested), one JSON object as the answer, read leniently, at most two nudges when the answer has another shape. Every step is written to the run.
/// </summary>
public static class AiService
{
    public static class Codes
    {
        public const string Disabled = "disabled";
        public const string NotConfigured = "not-configured";
        public const string Limit = "limit";
        public const string Failed = "failed";
    }

    /// <summary>What a run is asked: the action, the messages (system first), the field the JSON answer must have, what it works on, who asks and from where.</summary>
    public sealed record Call(AiAction Action, IReadOnlyList<AiMessage> Messages, string RequiredField, long? DocumentId, long? StudioId, long? UserId, string? Address, string? Prompt, long? ProfileId = null);

    public sealed record Outcome(AiRun Run, JsonElement? Result, string? Error, string? Code = null)
    {
        public bool Ok => Error is null && Result is not null;
    }

    /// <summary>One way to reach a model.</summary>
    public sealed record Transport(string Name, string Model, Func<AiRequest, CancellationToken, Task<AiResponse>> Complete);

    public static async Task<Outcome> RunAsync(AppDbContext db, IServiceProvider services, Call call, CancellationToken ct = default)
    {
        var settings = await AiSettings.LoadAsync(db, ct);
        var limiter = services.GetRequiredService<AiRateLimiter>();
        var now = DateTime.UtcNow;
        var run = new AiRun
        {
            Action = call.Action,
            DocumentId = call.DocumentId,
            StudioId = call.StudioId,
            UserId = call.UserId,
            AddressHash = call.Address is null ? null : limiter.Hash(call.Address),
            StartDate = now,
            CreateUserId = call.UserId,
            Prompt = call.Prompt is { Length: > 4000 } p ? p[..4000] : call.Prompt,
        };
        db.AiRuns.Add(run);
        var number = 0;
        void Step(AiStepKind kind, string text) => run.Steps.Add(new AiRunStep { Kind = kind, Text = text.Length > 60_000 ? text[..60_000] : text, Number = ++number, OccurredDate = DateTime.UtcNow, CreateUserId = call.UserId });

        async Task<Outcome> End(AiRunStatus status, string? error, string? code = null, JsonElement? result = null)
        {
            run.Status = status;
            run.Error = error is { Length: > 2000 } e ? e[..2000] : error;
            run.EndDate = DateTime.UtcNow;
            if (error is not null)
            {
                Step(AiStepKind.Warning, error);
            }

            await db.SaveChangesAsync(CancellationToken.None);
            return new Outcome(run, result, error, code);
        }

        // ---- before anything is sent ----
        if (!settings.Enabled && call.ProfileId is null)
        {
            return await End(AiRunStatus.Cancelled, Text.T("Ai.Disabled"), Codes.Disabled);
        }

        if (!limiter.TryTake(call.Address, settings.PerMinutePerAddress))
        {
            return await End(AiRunStatus.LimitReached, Text.T("Ai.Limit.Minute"), Codes.Limit);
        }

        if (await BudgetReasonAsync(db, settings, call.UserId, now, ct) is { } budget)
        {
            return await End(AiRunStatus.LimitReached, budget, Codes.Limit);
        }

        var transport = await TransportAsync(db, services, settings, call.ProfileId, ct);
        if (transport is null)
        {
            return await End(AiRunStatus.Error, Text.T(call.ProfileId is null ? "Ai.NotConfigured" : "Ai.ProfileIncomplete"), Codes.NotConfigured);
        }

        run.ProfileName = transport.Name;
        run.Model = transport.Model;
        var messages = call.Messages.ToList();
        Step(AiStepKind.Message, string.Join("\n\n---\n\n", messages.Select(m => $"[{m.Role}]\n{m.Content}" + AttachmentLine(m))));

        try
        {
            for (var attempt = 0; ; attempt++)
            {
                var response = await transport.Complete(new AiRequest { Messages = messages, Json = true, MaxTokens = settings.MaxTokens }, ct);
                var estimated = response.PromptTokens == 0 && response.CompletionTokens == 0;
                run.PromptTokens += estimated ? TokenEstimate.Of(messages) : response.PromptTokens;
                run.CompletionTokens += estimated ? TokenEstimate.Of(response.Text) : response.CompletionTokens;
                run.TokensEstimated |= estimated;
                if (!response.Ok)
                {
                    return await End(AiRunStatus.Error, response.Error ?? Text.T("Ai.NoAnswer"), Codes.Failed);
                }

                Step(AiStepKind.Result, response.Text ?? string.Empty);
                if (response.Note is { Length: > 0 } note)
                {
                    Step(AiStepKind.Warning, note);
                }

                var obj = LenientJson.FirstObject(response.Text);
                if (obj is { } o && o.TryGetProperty(call.RequiredField, out _))
                {
                    run.ResultJson = JsonSerializer.Serialize(o);
                    return await End(AiRunStatus.Done, null, null, o);
                }

                if (attempt >= 2)
                {
                    return await End(AiRunStatus.Stuck, Text.T("Ai.WrongShape"), Codes.Failed);
                }

                messages.Add(AiMessage.Assistant(response.Text ?? string.Empty));
                messages.Add(AiMessage.User($"Answer with exactly ONE JSON object that has the field \"{call.RequiredField}\" – no other text, no Markdown."));
                Step(AiStepKind.Warning, "No JSON object with the required field: nudged.");
            }
        }
        catch (OperationCanceledException)
        {
            return await End(AiRunStatus.Cancelled, Text.T("Ai.Cancelled"), Codes.Failed);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            services.GetRequiredService<ILoggerFactory>().CreateLogger("Ai").LogWarning(ex, "AI run failed");
            return await End(AiRunStatus.Error, Text.T("Ai.Failed", ex.Message), Codes.Failed);
        }
    }

    /// <summary>The token budgets: all people per month, this person per day and per month. The sentence of the one that is used up, or null.</summary>
    private static async Task<string?> BudgetReasonAsync(AppDbContext db, AiSettings settings, long? userId, DateTime now, CancellationToken ct)
    {
        var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        if (settings.MonthlyTokens > 0 && await db.AiRuns.Where(r => r.StartDate >= monthStart).SumAsync(r => r.PromptTokens + r.CompletionTokens, ct) >= settings.MonthlyTokens)
        {
            return Text.T("Ai.Limit.AllMonth", settings.MonthlyTokens.ToString("N0", Languages.UiCulture(Languages.Current)));
        }

        if (userId is not { } uid)
        {
            return null;
        }

        if (settings.UserDailyTokens > 0 && await db.AiRuns.Where(r => r.UserId == uid && r.StartDate >= now.Date).SumAsync(r => r.PromptTokens + r.CompletionTokens, ct) >= settings.UserDailyTokens)
        {
            return Text.T("Ai.Limit.UserDay", settings.UserDailyTokens.ToString("N0", Languages.UiCulture(Languages.Current)));
        }

        if (settings.UserMonthlyTokens > 0 && await db.AiRuns.Where(r => r.UserId == uid && r.StartDate >= monthStart).SumAsync(r => r.PromptTokens + r.CompletionTokens, ct) >= settings.UserMonthlyTokens)
        {
            return Text.T("Ai.Limit.UserMonth", settings.UserMonthlyTokens.ToString("N0", Languages.UiCulture(Languages.Current)));
        }

        return null;
    }

    /// <summary>The transport of a call: the profile with this id (the one being tested, active or not), else the active profile; null when it is not complete (no key, not signed in).</summary>
    /// <summary>For the log of a run: the names, types and sizes of the attachments of a message (never their content).</summary>
    private static string AttachmentLine(AiMessage m) => m.Attachments.Count == 0
        ? string.Empty
        : "\n[attachments: " + string.Join(", ", m.Attachments.Select(a => $"{a.Name} ({a.MediaType}, {a.Data.Length * 3 / 4 / 1024} KB)")) + "]";

    public static async Task<Transport?> TransportAsync(AppDbContext db, IServiceProvider services, AiSettings settings, long? profileId, CancellationToken ct)
    {
        var profile = profileId is { } wanted
            ? await db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.Id == wanted, ct)
            : await db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.IsActive, ct);
        if (profile is null)
        {
            return null;
        }

        var logger = services.GetRequiredService<ILoggerFactory>().CreateLogger("Ai");
        if (profile.Provider == AiProvider.ChatGpt)
        {
            var account = AiAdmin.Account(services, profile);
            return await account.IsConnectedAsync(ct)
                ? new Transport(profile.Name, profile.Model, (r, c) => account.CompleteAsync(profile.Model, r.Messages, c, r.OnDelta))
                : null;
        }

        if (await services.GetRequiredService<AiSecretStore>().LoadAsync(profile.SecretToken, AiSecretStore.ApiKey, ct) is not { Length: > 0 } key)
        {
            return null;
        }

        var http = services.GetRequiredService<IHttpClientFactory>();
        return new Transport(profile.Name, profile.Model, (r, c) =>
            ChatCompletionsClient.CompleteAsync(http.CreateClient("ai"), profile.BaseUrl, key, profile.Model, r, settings.MaxTokens, m => logger.LogWarning("{Message}", m.Replace(key, "***")), c, settings.TimeoutSeconds));
    }

    /// <summary>Whether the assistant can be offered at all: switched on and an active profile with its key or sign-in.</summary>
    public static async Task<bool> IsAvailableAsync(AppDbContext db, IServiceProvider services, CancellationToken ct = default)
    {
        if (!(await AiSettings.LoadAsync(db, ct)).Enabled)
        {
            return false;
        }

        var profile = await db.AiProfiles.AsNoTracking().FirstOrDefaultAsync(p => p.IsActive, ct);
        return profile is not null && services.GetRequiredService<AiSecretStore>().Has(profile.SecretToken, profile.Provider == AiProvider.ChatGpt ? AiSecretStore.ChatGpt : AiSecretStore.ApiKey);
    }

    /// <summary>Tests a profile (the button on its page): a short question, the answer as a sentence.</summary>
    public static async Task<(bool Ok, string Text)?> TestAsync(AiContext c, long profileId, string? address, CancellationToken ct = default)
    {
        if (!await Accounts.UserAdmin.IsAdminAsync(c.Db, c.ActorId, ct))
        {
            return null;
        }

        var messages = new[] { AiMessage.System("You test a connection. Answer with one JSON object {\"message\": \"...\"} that says in a few words that you can be reached."), AiMessage.User("Are you there?") };
        var outcome = await RunAsync(c.Db, c.Services, new Call(AiAction.Test, messages, "message", null, null, c.ActorId, address, "Test", profileId), ct);
        return outcome.Ok
            ? (true, Text.T("Ai.Test.Ok", outcome.Run.ProfileName, outcome.Run.Model, outcome.Result!.Value.GetProperty("message").ToString()))
            : (false, Text.T("Ai.Test.Failed", outcome.Error ?? string.Empty));
    }
}
