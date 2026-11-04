using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using MatShape.Localization;
using Microsoft.AspNetCore.Antiforgery;

namespace MatShape.Services.Documents;

/// <summary>
/// The addresses the editor talks to (JSON under <c>/live</c>). Reading is open to the anonymous request on purpose, because a link gives guests a look: what a request
/// may see is decided by the business layer (the cookie of a person and/or the secret of the link in <c>?t=</c>), and a document that is not theirs answers 404.
/// Every change needs a signed-in person, the editor right (checked in the business layer) and the anti-forgery token of the page (header <c>RequestVerificationToken</c>).
/// </summary>
public static class DocumentEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapDocumentEndpoints(this IEndpointRouteBuilder app)
    {
        var live = app.MapGroup("/live");

        live.MapGet("/documents/{id:long}", async (long id, long? v, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var data = await StudioService.OpenAsync(db, ActorOf(http, me), id, v, http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return data is null ? Results.NotFound() : Results.Text(EditorJson(data).ToJsonString(), "application/json");
        }).AllowAnonymous();

        live.MapGet("/documents/{id:long}/thumbnail", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var png = await DocumentService.ThumbnailAsync(db, ActorOf(http, me), id, http.RequestAborted);
            if (png is null)
            {
                return Results.NotFound();
            }

            // the picture changes without the document changing: the browser asks every time, an unchanged picture answers 304
            var tag = new Microsoft.Net.Http.Headers.EntityTagHeaderValue($"\"{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(png))[..16]}\"");
            http.Response.Headers.CacheControl = "private, no-cache";
            return Results.File(png, "image/png", entityTag: tag);
        }).AllowAnonymous();

        live.MapPut("/documents/{id:long}/thumbnail", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            using var buffer = new MemoryStream();
            await http.Request.Body.CopyToAsync(buffer, http.RequestAborted);
            if (buffer.Length > DocumentService.ThumbnailMax)
            {
                return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            }

            return await DocumentService.SetThumbnailAsync(db, me.RequiredId, id, buffer.ToArray(), http.RequestAborted) ? Results.NoContent() : Results.NotFound();
        }).AddEndpointFilter(Antiforgery);

        live.MapGet("/studios/{id:long}/revision", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var revision = await StudioService.RevisionAsync(db, ActorOf(http, me), id, http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return revision is { } r ? Results.Json(new { revision = r.Revision, by = r.By }, Json) : Results.NotFound();
        }).AllowAnonymous();

        live.MapPut("/studios/{id:long}", async (long id, SaveRequest body, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var content = body.Content.ValueKind == JsonValueKind.Undefined ? null : body.Content.GetRawText();
            var result = await StudioService.SaveAsync(db, me.RequiredId, id, body.Revision, content ?? string.Empty, http.RequestAborted);
            return result.Status switch
            {
                SaveStatus.Saved => Results.Json(new { revision = result.Revision }, Json),
                SaveStatus.Conflict => Results.Text(new JsonObject { ["revision"] = result.Revision, ["content"] = JsonNode.Parse(result.Content!) }.ToJsonString(), "application/json", statusCode: StatusCodes.Status409Conflict),
                SaveStatus.Invalid => Results.Json(new { error = result.Problem }, Json, statusCode: StatusCodes.Status422UnprocessableEntity),
                _ => Results.NotFound(),
            };
        }).AddEndpointFilter(Antiforgery);

        live.MapPost("/documents/{id:long}/studios", async (long id, NameRequest body, HttpContext http, AppDbContext db, CurrentUser me) =>
            Answer(await StudioService.AddAsync(db, me.RequiredId, id, body.Name, ct: http.RequestAborted))).AddEndpointFilter(Antiforgery);

        live.MapPost("/studios/{id:long}/duplicate", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
            Answer(await StudioService.DuplicateAsync(db, me.RequiredId, id, Text.T("Documents.CopyWord"), http.RequestAborted))).AddEndpointFilter(Antiforgery);

        live.MapPatch("/studios/{id:long}", async (long id, NameRequest body, HttpContext http, AppDbContext db, CurrentUser me) =>
            Answer(await StudioService.RenameAsync(db, me.RequiredId, id, body.Name ?? string.Empty, http.RequestAborted))).AddEndpointFilter(Antiforgery);

        live.MapPost("/studios/{id:long}/move", async (long id, MoveRequest body, HttpContext http, AppDbContext db, CurrentUser me) =>
            await StudioService.MoveAsync(db, me.RequiredId, id, body.Step, http.RequestAborted) ? Results.NoContent() : Results.NotFound()).AddEndpointFilter(Antiforgery);

        live.MapDelete("/studios/{id:long}", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var deleted = await StudioService.DeleteAsync(db, me.RequiredId, id, http.RequestAborted);
            return deleted.NotAllowed ? Results.NotFound() : deleted.Ok ? Results.NoContent() : Results.Json(new { error = deleted.Error }, Json, statusCode: StatusCodes.Status409Conflict);
        }).AddEndpointFilter(Antiforgery);

        live.MapGet("/documents/{id:long}/versions", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var rows = await VersionService.RecentAsync(db, ActorOf(http, me), id, 50, http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return rows is null ? Results.NotFound() : Results.Json(rows.Select(r => new { r.Id, r.Name, r.Description, r.CreatedBy, r.CreateDate }), Json);
        }).AllowAnonymous();

        live.MapPost("/documents/{id:long}/versions", async (long id, VersionRequest body, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var created = await VersionService.CreateAsync(db, me.RequiredId, id, body.Name ?? string.Empty, body.Description, http.RequestAborted);
            return created.NotAllowed ? Results.NotFound()
                : created.Ok ? Results.Json(new { created.Value!.Id, created.Value.Name }, Json)
                : Results.Json(new { error = created.Error }, Json, statusCode: StatusCodes.Status422UnprocessableEntity);
        }).AddEndpointFilter(Antiforgery);
    }

    /// <summary>The person of the cookie (if any) and the secret of the link (if one is given).</summary>
    public static Actor ActorOf(HttpContext http, CurrentUser me)
    {
        var actor = new Actor(me.Id);
        return Guid.TryParse(http.Request.Query["t"], out var token) ? actor.WithLink(token) : actor;
    }

    /// <summary>The document as the editor reads it; the content of each Part Studio is put in as JSON (it was checked when it was saved).</summary>
    public static JsonObject EditorJson(EditorData data)
    {
        var studios = new JsonArray();
        foreach (var s in data.Studios)
        {
            studios.Add(new JsonObject
            {
                ["id"] = s.Id,
                ["name"] = s.Name,
                ["position"] = s.Position,
                ["revision"] = s.Revision,
                ["content"] = JsonNode.Parse(s.Content),
            });
        }

        return new JsonObject
        {
            ["id"] = data.Id,
            ["name"] = data.Name,
            ["units"] = data.Units,
            ["role"] = data.Role.ToString().ToLowerInvariant(),
            ["canEdit"] = data.CanEdit,
            ["versionId"] = data.VersionId,
            ["versionName"] = data.VersionName,
            ["studios"] = studios,
        };
    }

    private static IResult Answer(Outcome<StudioData> outcome)
    {
        if (outcome.NotAllowed)
        {
            return Results.NotFound();
        }

        if (!outcome.Ok)
        {
            return Results.Json(new { error = outcome.Error }, Json, statusCode: StatusCodes.Status422UnprocessableEntity);
        }

        var s = outcome.Value!;
        return Results.Text(new JsonObject
        {
            ["id"] = s.Id,
            ["name"] = s.Name,
            ["position"] = s.Position,
            ["revision"] = s.Revision,
            ["content"] = JsonNode.Parse(s.Content),
        }.ToJsonString(), "application/json");
    }

    /// <summary>A change needs a signed-in person and the anti-forgery token of the page (another site cannot post with the cookie of a person).</summary>
    private static async ValueTask<object?> Antiforgery(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (http.User.Identity?.IsAuthenticated != true)
        {
            return Results.Unauthorized();
        }

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

    public sealed record SaveRequest(long Revision, JsonElement Content);

    public sealed record NameRequest(string? Name);

    public sealed record MoveRequest(int Step);

    public sealed record VersionRequest(string? Name, string? Description);
}
