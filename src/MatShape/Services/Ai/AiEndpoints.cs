using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using Microsoft.AspNetCore.Antiforgery;

namespace MatShape.Services.Ai;

/// <summary>
/// The JSON addresses of the AI: the assistant of the editor (<c>POST /live/studios/{id}/ai</c>, the editor right is checked in <see cref="ModelAssistant"/>) and the helpers of the profile page for
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
                new ModelAssistant.Request(body.Prompt ?? string.Empty, body.Content, errors, body.Language, body.Attachments), http.Connection.RemoteIpAddress?.ToString(), me.IsAdmin, http.RequestAborted);
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
                ["runId"] = result.RunId,
                ["tokens"] = result.Tokens,
                ["repairRounds"] = settings.RepairRounds,
            }.ToJsonString(), "application/json");
        }).AddEndpointFilter(Antiforgery);

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

    public sealed record AssistBody(string? Prompt, JsonElement Content, IReadOnlyList<ErrorBody>? Errors, string? Language, IReadOnlyList<ModelAssistant.Attachment>? Attachments);

    public sealed record ErrorBody(string? Id, string? Name, string? Message);
}
