using System.Net;
using System.Text;
using System.Text.Json;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Ai;
using MatShape.Services.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace MatShape.Tests;

/// <summary>
/// The 3D generation (Meshy): the requests that are sent, how a task of Meshy is read, the errors in words, what the editor may send; and with a database the whole way
/// through a fake Meshy – only administrators store the key, only editors start, only the person who started asks and fetches, the limits count generations.
/// </summary>
public sealed class MeshTests
{
    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    [Fact]
    public void A_task_of_Meshy_is_read_as_its_state()
    {
        Assert.Equal("pending", MeshyClient.ParseTask(Json("""{"status":"PENDING","progress":0}"""))!.State);
        var running = MeshyClient.ParseTask(Json("""{"status":"IN_PROGRESS","progress":42}"""))!;
        Assert.Equal(("running", 42), (running.State, running.Progress));

        var done = MeshyClient.ParseTask(Json("""{"status":"SUCCEEDED","progress":100,"model_urls":{"glb":"https://assets.meshy.ai/x.glb","stl":"https://assets.meshy.ai/x.stl"},"thumbnail_url":"https://assets.meshy.ai/x.png"}"""))!;
        Assert.Equal("done", done.State);
        Assert.Equal("https://assets.meshy.ai/x.glb", done.Glb);
        Assert.Equal("https://assets.meshy.ai/x.png", done.Thumbnail);

        Assert.Equal("failed", MeshyClient.ParseTask(Json("""{"status":"SUCCEEDED","model_urls":{}}"""))!.State);
        var failed = Languages.In("en", () => MeshyClient.ParseTask(Json("""{"status":"FAILED","task_error":{"type":"invalid_input","message":"image_too_complex"}}""")))!;
        Assert.Equal("failed", failed.State);
        Assert.Contains("image_too_complex", failed.Error);
    }

    [Fact]
    public void The_request_fits_the_kind_of_generation()
    {
        var settings = new MeshSettings { Model = "meshy-6-lite", Polycount = 12_000 };
        var one = MeshyClient.BodyOf(new MeshyClient.Job("image", ["data:image/png;base64,AAAA"], null), settings);
        Assert.Equal("data:image/png;base64,AAAA", (string?)one["image_url"]);
        Assert.False((bool)one["should_texture"]!);
        Assert.Equal(12_000, (int)one["target_polycount"]!);
        Assert.Equal("meshy-6-lite", (string?)one["ai_model"]);
        Assert.Equal("openapi/v1/image-to-3d", MeshyClient.PathOf(new MeshyClient.Job("image", ["a"], null)));

        var views = new MeshyClient.Job("image", ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"], null);
        Assert.Equal(2, MeshyClient.BodyOf(views, settings)["image_urls"]!.AsArray().Count);
        Assert.Equal("openapi/v1/multi-image-to-3d", MeshyClient.PathOf(views));

        var text = new MeshyClient.Job("text", [], "a lion mascot");
        var body = MeshyClient.BodyOf(text, settings);
        Assert.Equal(("preview", "a lion mascot"), ((string?)body["mode"], (string?)body["prompt"]));
        Assert.Null(body["should_texture"]);
        Assert.Equal("openapi/v2/text-to-3d", MeshyClient.PathOf(text));
    }

    [Fact]
    public void Errors_of_Meshy_are_sentences()
    {
        Languages.In("en", () =>
        {
            Assert.Equal(Text.T("Ai.Mesh.Error.Key"), MeshyClient.ErrorOf(HttpStatusCode.Unauthorized, """{"message":"Invalid API key"}"""));
            Assert.Equal(Text.T("Ai.Mesh.Error.Credits"), MeshyClient.ErrorOf(HttpStatusCode.PaymentRequired, "{}"));
            Assert.Contains("target_polycount", MeshyClient.ErrorOf(HttpStatusCode.BadRequest, """{"message":"target_polycount out of range"}"""));
            Assert.Contains("503", MeshyClient.ErrorOf(HttpStatusCode.ServiceUnavailable, "not json"));
            return 0;
        });
    }

    [Fact]
    public void What_the_editor_may_send()
    {
        Assert.NotNull(MeshService.Read(new MeshService.StartRequest("text", null, "  ")).Problem);
        Assert.Equal("a fox", MeshService.Read(new MeshService.StartRequest("text", null, " a fox ")).Job!.Prompt);
        Assert.Equal(MeshyClient.MaxPrompt, MeshService.Read(new MeshService.StartRequest("text", null, new string('x', 2000))).Job!.Prompt!.Length);

        Assert.NotNull(MeshService.Read(new MeshService.StartRequest("image", [], null)).Problem);
        Assert.NotNull(MeshService.Read(new MeshService.StartRequest("image", [new("image/gif", Png)], null)).Problem);
        Assert.NotNull(MeshService.Read(new MeshService.StartRequest("image", [new("image/png", "not base64 !!")], null)).Problem);
        Assert.NotNull(MeshService.Read(new MeshService.StartRequest("image", [.. Enumerable.Repeat(new MeshService.Picture("image/png", Png), 5)], null)).Problem);

        var job = MeshService.Read(new MeshService.StartRequest("image", [new("image/png", Png), new("image/jpeg", Png)], null)).Job!;
        Assert.Equal(["data:image/png;base64," + Png, "data:image/jpeg;base64," + Png], job.Images);
    }

    [Fact]
    public void The_settings_of_the_generation_are_kept_with_the_others()
    {
        var old = AiSettings.Parse("""{"enabled":true,"repairRounds":3}""");
        Assert.NotNull(old.Mesh);
        Assert.Equal(MeshyClient.DefaultBaseUrl, old.Mesh.BaseUrl);
        var s = AiSettings.Parse(new AiSettings { Mesh = new MeshSettings { Enabled = false, Model = "meshy-6", UserDaily = 3 } }.ToJson());
        Assert.False(s.Mesh.Enabled);
        Assert.Equal(("meshy-6", 3), (s.Mesh.Model, s.Mesh.UserDaily));
    }

    [DbFact]
    public async Task A_generation_goes_through_the_server_for_the_person_who_started_it()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada", UserRole.Admin);
        var bob = await t.AddUserAsync("Bob");
        var meshy = new FakeMeshy();
        var services = Services(t.Db, meshy);
        var asAda = new AiContext(t.Db, services, ada.Id);

        // only an administrator stores the key; without it nothing is offered
        Assert.False(await MeshService.IsAvailableAsync(t.Db, services));
        Assert.True((await MeshService.SaveAsync(new AiContext(t.Db, services, bob.Id), new MeshSettings(), "msy_x", false)).Denied);
        var (denied, errors) = await MeshService.SaveAsync(asAda, new MeshSettings { BaseUrl = "https://meshy.test", Model = "latest", Polycount = 30_000, UserDaily = 2, Monthly = 10 }, "msy_secret", false);
        Assert.False(denied);
        Assert.Empty(errors);
        Assert.True(await MeshService.IsAvailableAsync(t.Db, services));
        Assert.True((await MeshService.TestAsync(asAda))!.Value.Ok);
        Assert.Equal("Bearer msy_secret", meshy.LastAuthorization);

        // the model of Ada: Bob may not start a generation on it
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Mascot", null, null)).Value!;
        var studio = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios[0];
        var picture = new MeshService.StartRequest("image", [new("image/png", Png)], null);
        Assert.Equal(MeshService.Codes.Denied, (await MeshService.StartAsync(t.Db, services, bob.Id, studio.Id, picture, "10.0.0.2")).Failure!.Code);

        var (runId, failure) = await MeshService.StartAsync(t.Db, services, ada.Id, studio.Id, picture, "10.0.0.1");
        Assert.Null(failure);
        Assert.Equal("POST /openapi/v1/image-to-3d", meshy.Requests[^1]);
        Assert.Contains("data:image/png;base64,", meshy.LastBody);

        // waiting, then done; Bob cannot see it
        meshy.Status = """{"status":"IN_PROGRESS","progress":40}""";
        var waiting = (await MeshService.StatusAsync(t.Db, services, ada.Id, runId!.Value))!;
        Assert.Equal(("running", 40), (waiting.Status, waiting.Progress));
        Assert.Null(await MeshService.StatusAsync(t.Db, services, bob.Id, runId.Value));
        Assert.Null(await MeshService.FileAsync(t.Db, services, ada.Id, runId.Value, "model"));
        meshy.Status = """{"status":"SUCCEEDED","progress":100,"model_urls":{"glb":"https://assets.meshy.test/m.glb"},"thumbnail_url":"https://assets.meshy.test/m.png"}""";
        var done = (await MeshService.StatusAsync(t.Db, services, ada.Id, runId.Value))!;
        Assert.Equal("done", done.Status);
        Assert.True(done.Thumbnail);
        var file = (await MeshService.FileAsync(t.Db, services, ada.Id, runId.Value, "model"))!.Value;
        Assert.Equal(("glb", "glTF"), (file.Format, Encoding.ASCII.GetString(file.Bytes, 0, 4)));
        Assert.Null(await MeshService.FileAsync(t.Db, services, bob.Id, runId.Value, "model"));

        // the run says what was asked (never the picture itself) and how it ended
        var run = t.Db.AiRuns.Single(r => r.Id == runId.Value);
        Assert.Equal((AiAction.Mesh, AiRunStatus.Done), (run.Action, run.Status));
        Assert.DoesNotContain(t.Db.AiRunSteps.Where(s => s.AiRunId == run.Id).AsEnumerable(), s => s.Text.Contains(Png, StringComparison.Ordinal));

        // a failed generation does not count; two done ones use up the day of Ada
        meshy.Status = """{"status":"FAILED","task_error":{"type":"invalid_input","message":"no object"}}""";
        var (failedRun, _) = await MeshService.StartAsync(t.Db, services, ada.Id, studio.Id, picture, "10.0.0.1");
        Assert.Equal("failed", (await MeshService.StatusAsync(t.Db, services, ada.Id, failedRun!.Value))!.Status);
        meshy.Status = """{"status":"PENDING","progress":0}""";
        var (second, _) = await MeshService.StartAsync(t.Db, services, ada.Id, studio.Id, new MeshService.StartRequest("text", null, "a lion"), "10.0.0.1");
        Assert.NotNull(second);
        Assert.Equal("POST /openapi/v2/text-to-3d", meshy.Requests[^1]);
        Assert.Equal(MeshService.Codes.Limit, (await MeshService.StartAsync(t.Db, services, ada.Id, studio.Id, picture, "10.0.0.1")).Failure!.Code);

        // stopping a waiting one deletes the task at Meshy
        Assert.True(await MeshService.CancelAsync(t.Db, services, ada.Id, second!.Value));
        Assert.StartsWith("DELETE /openapi/v2/text-to-3d/", meshy.Requests[^1], StringComparison.Ordinal);
        Assert.Equal("cancelled", (await MeshService.StatusAsync(t.Db, services, ada.Id, second.Value))!.Status);
    }

    private static ServiceProvider Services(AppDbContext db, FakeMeshy meshy)
    {
        var data = Path.Combine(Path.GetTempPath(), "matshape-mesh-" + Guid.NewGuid().ToString("N"));
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDataProtection();
        services.AddHttpClient("ai").ConfigurePrimaryHttpMessageHandler(() => meshy);
        services.AddSingleton<Microsoft.Extensions.Configuration.IConfiguration>(new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["DataDirectory"] = data }).Build());
        services.AddSingleton<AiSecretStore>();
        services.AddSingleton<AiRateLimiter>();
        services.AddSingleton(db);
        services.AddSingleton<PasswordService>();
        services.AddSingleton<AccountService>();
        return services.BuildServiceProvider();
    }

    /// <summary>Meshy as far as the server uses it: create (a task id), the state (whatever <see cref="Status"/> says), delete, the list (for the key test), the files.</summary>
    private sealed class FakeMeshy : HttpMessageHandler
    {
        public string Status { get; set; } = """{"status":"PENDING","progress":0}""";

        public List<string> Requests { get; } = [];

        public string? LastAuthorization { get; private set; }

        public string LastBody { get; private set; } = string.Empty;

        private int _tasks;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            Requests.Add($"{request.Method} {path}");
            if (request.RequestUri.Host == "assets.meshy.test")
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(path.EndsWith(".glb", StringComparison.Ordinal) ? Encoding.ASCII.GetBytes("glTF....") : [137, 80, 78, 71]) };
            }

            LastAuthorization = request.Headers.Authorization?.ToString();
            if (LastAuthorization != "Bearer msy_secret")
            {
                return Answer(HttpStatusCode.Unauthorized, """{"message":"Invalid API key"}""");
            }

            if (request.Method == HttpMethod.Post)
            {
                LastBody = await request.Content!.ReadAsStringAsync(cancellationToken);
                return Answer(HttpStatusCode.OK, $$"""{"result":"task-{{++_tasks}}"}""");
            }

            if (request.Method == HttpMethod.Delete)
            {
                return Answer(HttpStatusCode.OK, string.Empty);
            }

            return Answer(HttpStatusCode.OK, path.EndsWith("-to-3d", StringComparison.Ordinal) ? "[]" : Status);
        }

        private static HttpResponseMessage Answer(HttpStatusCode status, string json) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }
}
