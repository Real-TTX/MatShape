using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using Microsoft.AspNetCore.Antiforgery;

namespace MatShape.Services.Ai;

/// <summary>
/// The JSON addresses of the AI: the assistant of the editor (<c>POST /live/studios/{id}/ai</c>, the editor right is checked in <see cref="ModelAssistant"/>), the 3D generation
/// (<c>/live/studios/{id}/ai/mesh</c>, <c>/live/ai/mesh/{run}</c>: <see cref="MeshService"/>) and the helpers of the profile page for
/// administrators (the models of a provider, the state of a ChatGPT sign-in; checked in <see cref="AiAdmin"/>). A key typed into the page goes as a header, never in the address.
/// </summary>
public static class AiEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapAiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/live/studios/{id:long}/ai", async (long id, AssistBody body, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var errors = body.Errors?.Select(e => new ModelAssistant.RepairError(e.Id ?? string.Empty, e.Name, e.Message ?? string.Empty)).ToList();
            var (result, failure) = await ModelAssistant.AssistAsync(db, http.RequestServices, me.RequiredId, id,
                new ModelAssistant.Request(body.Prompt ?? string.Empty, body.Content, errors, body.Language, body.Attachments, body.Overlaps, body.Detail), http.Connection.RemoteIpAddress?.ToString(), me.IsAdmin, http.RequestAborted);
            if (failure is not null)
            {
                return failure.Code == "denied"
                    ? Results.NotFound()
                    : Results.Json(new { error = failure.Message, code = failure.Code, settingsUrl = failure.SettingsUrl }, Json, statusCode: StatusCodes.Status422UnprocessableEntity);
            }

            var settings = await AiSettings.LoadAsync(db, http.RequestAborted);
            return Results.Text(new JsonObject
            {
                ["message"] = result!.Message,
                ["content"] = JsonNode.Parse(result.Content),
                ["changed"] = new JsonArray([.. result.Changed.Select(c => (JsonNode)c)]),
                ["removed"] = new JsonArray([.. (result.Removed ?? []).Select(c => (JsonNode)c)]),
                ["runId"] = result.RunId,
                ["tokens"] = result.Tokens,
                ["repairRounds"] = settings.RepairRounds,
            }.ToJsonString(), "application/json");
        }).AddEndpointFilter(Antiforgery);

        // ---- the 3D generation (Meshy): start (editor right on the Part Studio), state, files and stop of a run of one's own ----
        app.MapPost("/live/studios/{id:long}/ai/mesh", async (long id, MeshService.StartRequest body, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var (run, failure) = await MeshService.StartAsync(db, http.RequestServices, me.RequiredId, id, body, http.Connection.RemoteIpAddress?.ToString(), http.RequestAborted);
            if (failure is not null)
            {
                return failure.Code == MeshService.Codes.Denied
                    ? Results.NotFound()
                    : Results.Json(new { error = failure.Message, code = failure.Code }, Json, statusCode: StatusCodes.Status422UnprocessableEntity);
            }

            return Results.Json(new { run }, Json);
        }).AddEndpointFilter(Antiforgery);

        app.MapGet("/live/ai/mesh/{run:long}", async (long run, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var state = await MeshService.StatusAsync(db, http.RequestServices, me.RequiredId, run, http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return state is null ? Results.NotFound() : Results.Json(new { status = state.Status, progress = state.Progress, error = state.Error, thumbnail = state.Thumbnail }, Json);
        });

        app.MapGet("/live/ai/mesh/{run:long}/{what:regex(^(model|stl|thumbnail)$)}", async (long run, string what, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var file = await MeshService.FileAsync(db, http.RequestServices, me.RequiredId, run, what, http.RequestAborted);
            http.Response.Headers.CacheControl = "private, max-age=3600";
            if (file is not { } f)
            {
                return Results.NotFound();
            }

            http.Response.Headers["X-Mesh-Format"] = f.Format;
            return Results.Bytes(f.Bytes, f.ContentType);
        });

        app.MapDelete("/live/ai/mesh/{run:long}", async (long run, HttpContext http, AppDbContext db, CurrentUser me)
            => await MeshService.CancelAsync(db, http.RequestServices, me.RequiredId, run, http.RequestAborted) ? Results.NoContent() : Results.NotFound()).AddEndpointFilter(Antiforgery);

        app.MapGet("/live/ai/models", async (AiProvider provider, long? id, string? baseUrl, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var (models, error) = await AiAdmin.ModelsAsync(new AiContext(db, http.RequestServices, me.RequiredId), id, provider, baseUrl, http.Request.Headers["X-Ai-Key"].ToString(), http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { models = models?.Select(m => new { m.Id, m.Name, m.Free }), error }, Json);
        });

        app.MapGet("/live/ai/profiles/{id:long}/chatgpt", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var status = await AiAdmin.ChatGptStatusAsync(new AiContext(db, http.RequestServices, me.RequiredId), id, poll: true, http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return status is null ? Results.NotFound() : Results.Json(ChatGptAccount.StatusJson(status), Json);
        });
    }

    private static async ValueTask<object?> Antiforgery(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        try
        {
            await http.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(http);
        }
        catch (AntiforgeryValidationException)
        {
            return Results.BadRequest();
        }

        return await next(context);
    }

    public sealed record AssistBody(
        string? Prompt, JsonElement Content, IReadOnlyList<ErrorBody>? Errors, string? Language, IReadOnlyList<ModelAssistant.Attachment>? Attachments,
        IReadOnlyList<ModelAssistant.Overlap>? Overlaps = null, string? Detail = null);

    public sealed record ErrorBody(string? Id, string? Name, string? Message);
}
