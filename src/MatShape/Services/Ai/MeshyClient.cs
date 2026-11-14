using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Localization;

namespace MatShape.Services.Ai;

/// <summary>
/// The REST API of Meshy (https://docs.meshy.ai): a task is created (image to 3D, multi-image to 3D with up to four views, text to 3D as a preview, which is the untextured mesh),
/// then asked for its state until it has succeeded; the files lie at signed addresses of Meshy for three days. Untextured meshes in triangles, remeshed to the polycount of the settings:
/// the editor makes a solid of them, colours come from the parts. The key never leaves the server and is never written to a log.
/// </summary>
public static class MeshyClient
{
    public const string DefaultBaseUrl = "https://api.meshy.ai";

    public const int MaxImages = 4;

    public const int MaxPrompt = 800;

    /// <summary>The models that can be chosen (Meshy maps "latest" to its newest).</summary>
    public static readonly IReadOnlyList<string> Models = ["latest", "meshy-6", "meshy-6-lite"];

    private const long MaxDownload = 96L * 1024 * 1024;

    /// <summary>What is generated: "image" (one picture or several views, as data URIs) or "text" (a description).</summary>
    public sealed record Job(string Kind, IReadOnlyList<string> Images, string? Prompt);

    /// <summary>The state of a task: "pending" | "running" | "done" | "failed", its progress (0–100), the files when done and the reason when failed.</summary>
    public sealed record TaskState(string State, int Progress, string? Glb, string? Stl, string? Thumbnail, string? Error);

    /// <summary>The path of the task kind (the task id is appended for its state).</summary>
    public static string PathOf(Job job) => job.Kind == "text" ? "openapi/v2/text-to-3d" : job.Images.Count > 1 ? "openapi/v1/multi-image-to-3d" : "openapi/v1/image-to-3d";

    /// <summary>The body of the request that creates the task.</summary>
    public static JsonObject BodyOf(Job job, MeshSettings settings)
    {
        var body = new JsonObject();
        if (job.Kind == "text")
        {
            body["mode"] = "preview";
            body["prompt"] = job.Prompt;
        }
        else
        {
            if (job.Images.Count > 1)
            {
                body["image_urls"] = new JsonArray([.. job.Images.Select(i => (JsonNode)i)]);
            }
            else
            {
                body["image_url"] = job.Images[0];
            }

            body["should_texture"] = false;
        }

        body["ai_model"] = settings.Model;
        body["should_remesh"] = true;
        body["topology"] = "triangle";
        body["target_polycount"] = settings.Polycount;
        body["target_formats"] = new JsonArray("glb", "stl");
        return body;
    }

    /// <summary>Creates the task; the path to ask for its state ("openapi/v1/image-to-3d/{id}"), or a sentence why not.</summary>
    public static async Task<(string? Path, string? Error)> CreateAsync(HttpClient http, string baseUrl, string key, Job job, MeshSettings settings, CancellationToken ct)
    {
        var path = PathOf(job);
        using var request = new HttpRequestMessage(HttpMethod.Post, Url(baseUrl, path))
        {
            Content = new StringContent(BodyOf(job, settings).ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var response = await http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            return (null, ErrorOf(response.StatusCode, text));
        }

        var id = Read(text, root => root.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : null);
        return string.IsNullOrWhiteSpace(id) || id.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            ? (null, Text.T("Ai.Mesh.Error.Answer"))
            : ($"{path}/{id}", null);
    }

    /// <summary>The state of a task (null: Meshy could not be asked this time, the caller asks again later).</summary>
    public static async Task<(TaskState? State, string? Error)> GetAsync(HttpClient http, string baseUrl, string key, string path, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Url(baseUrl, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var response = await http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return (new TaskState("failed", 0, null, null, null, Text.T("Ai.Mesh.Error.Gone")), null);
        }

        return response.IsSuccessStatusCode ? (Read(text, ParseTask), null) : (null, ErrorOf(response.StatusCode, text));
    }

    /// <summary>A task object of Meshy as its state.</summary>
    public static TaskState? ParseTask(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var status = Str(root, "status") ?? string.Empty;
        var progress = root.TryGetProperty("progress", out var p) && p.TryGetInt32(out var v) ? Math.Clamp(v, 0, 100) : 0;
        string? glb = null, stl = null;
        if (root.TryGetProperty("model_urls", out var urls) && urls.ValueKind == JsonValueKind.Object)
        {
            glb = Str(urls, "glb");
            stl = Str(urls, "stl");
        }

        var error = root.TryGetProperty("task_error", out var e) && e.ValueKind == JsonValueKind.Object ? Str(e, "message") : null;
        return status switch
        {
            "SUCCEEDED" when glb is not null || stl is not null => new TaskState("done", 100, glb, stl, Str(root, "thumbnail_url"), null),
            "SUCCEEDED" => new TaskState("failed", 100, null, null, null, Text.T("Ai.Mesh.Error.NoFile")),
            "FAILED" or "CANCELED" => new TaskState("failed", progress, null, null, null, string.IsNullOrWhiteSpace(error) ? Text.T("Ai.Mesh.Error.Failed") : Text.T("Ai.Mesh.Error.FailedWhy", error)),
            "IN_PROGRESS" => new TaskState("running", progress, null, null, null, null),
            _ => new TaskState("pending", progress, null, null, null, null),
        };
    }

    /// <summary>Deletes a task (a waiting one gives its credits back); errors do not matter.</summary>
    public static async Task DeleteAsync(HttpClient http, string baseUrl, string key, string path, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, Url(baseUrl, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var response = await http.SendAsync(request, ct);
    }

    /// <summary>Tests the key: the list of the own tasks (one), which costs nothing.</summary>
    public static async Task<string?> CheckAsync(HttpClient http, string baseUrl, string key, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Url(baseUrl, "openapi/v1/image-to-3d?page_size=1"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var response = await http.SendAsync(request, ct);
        return response.IsSuccessStatusCode ? null : ErrorOf(response.StatusCode, await response.Content.ReadAsStringAsync(ct));
    }

    /// <summary>A file of a finished task (the mesh or the thumbnail) from its signed address; null when it cannot be had (expired, too big, not http).</summary>
    public static async Task<byte[]?> DownloadAsync(HttpClient http, string url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxDownload)
        {
            return null;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var memory = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (memory.Length + read > MaxDownload)
            {
                return null;
            }

            memory.Write(buffer, 0, read);
        }

        return memory.ToArray();
    }

    /// <summary>A sentence for an answer that is not a success: the key, the credits, too many at once, or what Meshy says.</summary>
    public static string ErrorOf(HttpStatusCode status, string body)
    {
        var message = Read(body, root => Str(root, "message")) ?? string.Empty;
        if (message.Length > 300)
        {
            message = message[..300];
        }

        return status switch
        {
            HttpStatusCode.Unauthorized => Text.T("Ai.Mesh.Error.Key"),
            HttpStatusCode.PaymentRequired => Text.T("Ai.Mesh.Error.Credits"),
            HttpStatusCode.TooManyRequests => Text.T("Ai.Mesh.Error.Busy"),
            HttpStatusCode.BadRequest or HttpStatusCode.Forbidden or HttpStatusCode.UnprocessableEntity => Text.T("Ai.Mesh.Error.Refused", message.Length > 0 ? message : ((int)status).ToString(System.Globalization.CultureInfo.InvariantCulture)),
            _ => Text.T("Ai.Mesh.Error.Status", (int)status, message),
        };
    }

    private static Uri Url(string baseUrl, string path) => new(baseUrl.TrimEnd('/') + "/" + path);

    private static string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s ? s : null;

    private static T? Read<T>(string text, Func<JsonElement, T?> read)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "null" : text);
            return read(doc.RootElement);
        }
        catch (JsonException)
        {
            return default;
        }
    }
}
