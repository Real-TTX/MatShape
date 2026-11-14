using System.Text.Json;
using MatShape.Data;
using MatShape.Services.Ai;
using MatShape.Services.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace MatShape.Tests;

/// <summary>The AI: how an answer is merged into a Part Studio (and what is refused), the settings, and that only administrators manage profiles.</summary>
public sealed class AiTests
{
    private const string Current = """{"features":[{"id":"v","type":"variable","name":"w","params":{"name":"w","value":"10"}}],"parts":{},"rollback":null}""";

    private static JsonElement Answer(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void Append_adds_at_the_end_and_names_what_changed()
    {
        var (content, changed, _, problem) = ModelAssistant.Merge(Current, Answer("""
            {"message":"ok","mode":"append","features":[
              {"id":"ai_s","type":"sketch","name":"Plate","params":{"plane":{"kind":"std","name":"top"},"entities":[{"id":"r","t":"rect","a":[0,0],"b":[80,40]}]}},
              {"id":"ai_e","type":"extrude","name":"Plate","params":{"sketch":"ai_s","depth":"#w","op":"new"}}],
             "parts":{"ai_e":{"name":"Plate"}}}
            """));
        Assert.Null(problem);
        Assert.Equal(["ai_s", "ai_e"], changed);
        using var doc = JsonDocument.Parse(content!);
        Assert.Equal(3, doc.RootElement.GetProperty("features").GetArrayLength());
        Assert.Equal("Plate", doc.RootElement.GetProperty("parts").GetProperty("ai_e").GetProperty("name").GetString());
    }

    [Fact]
    public void Patch_replaces_in_place()
    {
        var (content, _, _, problem) = ModelAssistant.Merge(Current, Answer("""{"mode":"patch","features":[{"id":"v","type":"variable","name":"w","params":{"name":"w","value":"25"}}]}"""));
        Assert.Null(problem);
        using var doc = JsonDocument.Parse(content!);
        var features = doc.RootElement.GetProperty("features");
        Assert.Equal(1, features.GetArrayLength());
        Assert.Equal("25", features[0].GetProperty("params").GetProperty("value").GetString());
    }

    [Fact]
    public void Append_goes_before_a_moved_rollback_bar()
    {
        const string rolled = """{"features":[{"id":"a","type":"variable"},{"id":"b","type":"variable"}],"parts":{},"rollback":1}""";
        var (content, _, _, _) = ModelAssistant.Merge(rolled, Answer("""{"mode":"append","features":[{"id":"n","type":"variable"}]}"""));
        using var doc = JsonDocument.Parse(content!);
        Assert.Equal("n", doc.RootElement.GetProperty("features")[1].GetProperty("id").GetString());
        Assert.Equal(2, doc.RootElement.GetProperty("rollback").GetInt32());
    }

    [Theory]
    [InlineData("""{"message":"no"}""")]
    [InlineData("""{"features":[{"type":"sketch"}]}""")]
    [InlineData("""{"mode":"append","features":[{"id":"v","type":"variable"}]}""")]
    [InlineData("""{"features":[{"id":"x","type":"script"}]}""")]
    public void Answers_that_do_not_fit_are_refused(string json)
    {
        var (content, _, _, problem) = ModelAssistant.Merge(Current, Answer(json));
        Assert.Null(content);
        Assert.NotNull(problem);
    }

    [Fact]
    public void Replace_takes_the_list_as_it_is()
    {
        var (content, _, _, problem) = ModelAssistant.Merge(Current, Answer("""{"mode":"replace","features":[]}"""));
        Assert.Null(problem);
        Assert.Equal(0, StudioContent.CountFeatures(content));
    }

    [Fact]
    public void Remove_deletes_features_with_any_mode_and_keeps_the_rollback_bar_after_the_same_ones()
    {
        const string three = """
            {"features":[{"id":"a","type":"variable","name":"a","params":{"name":"a","value":"1"}},{"id":"b","type":"variable","name":"b","params":{"name":"b","value":"2"}},
            {"id":"c","type":"variable","name":"c","params":{"name":"c","value":"3"}}],"parts":{},"rollback":2}
            """;

        // only a removal: "features" may be missing
        var (content, changed, removed, problem) = ModelAssistant.Merge(three, Answer("""{"remove":["a","nothing"]}"""));
        Assert.Null(problem);
        Assert.Equal(["a"], removed);
        Assert.Empty(changed);
        Assert.Equal(2, StudioContent.CountFeatures(content));
        Assert.Contains("\"rollback\":1", content, StringComparison.Ordinal);

        // a patch and a removal together; what is removed is not "changed"
        (content, changed, removed, problem) = ModelAssistant.Merge(three, Answer("""
            {"mode":"patch","features":[{"id":"b","type":"variable","name":"b","params":{"name":"b","value":"20"}},{"id":"c","type":"variable","name":"c","params":{}}],"remove":["c"]}
            """));
        Assert.Null(problem);
        Assert.Equal(["b"], changed);
        Assert.Equal(["c"], removed);
        Assert.DoesNotContain("\"id\":\"c\"", content, StringComparison.Ordinal);
        Assert.Contains("\"value\":\"20\"", content, StringComparison.Ordinal);

        // without features and without a removal it is no answer
        Assert.NotNull(ModelAssistant.Merge(three, Answer("""{"message":"hi"}""")).Problem);
    }

    [Fact]
    public void A_repair_names_the_overlapping_parts_and_the_level_of_detail_is_asked_for()
    {
        var model = new Model { Name = "Box", Units = "mm" };
        var text = ModelAssistant.Situation(model, "Part Studio 1", Current, "a box with a lid", null,
            [new ModelAssistant.Overlap("ai_box", "Box", "ai_lid", "Lid", 125.5)], "fine");
        Assert.Contains("REPAIR", text, StringComparison.Ordinal);
        Assert.Contains("part ai_box (Box) and part ai_lid (Lid): 125.5 mm³", text, StringComparison.Ordinal);
        Assert.Contains("op \"add\"", text, StringComparison.Ordinal);
        Assert.Contains(ModelAssistant.Details["fine"], text, StringComparison.Ordinal);

        // no repair: the request, at the normal level when nothing (or something unknown) is chosen
        var plain = ModelAssistant.Situation(model, "Part Studio 1", Current, "a box", null, null, "whatever");
        Assert.DoesNotContain("REPAIR", plain, StringComparison.Ordinal);
        Assert.Contains(ModelAssistant.Details["normal"], plain, StringComparison.Ordinal);
    }

    [Fact]
    public void The_instruction_describes_every_kind_of_feature()
    {
        var text = ModelAssistant.SystemText(new AiSettings { Instruction = "Wall thickness at least 2 mm" }, "de");
        foreach (var type in StudioContent.FeatureTypes)
        {
            Assert.Contains($"- {type}:", text.Replace("- deletepart:{", "- deletepart: {"), StringComparison.Ordinal);
        }

        Assert.Contains("Wall thickness at least 2 mm", text, StringComparison.Ordinal);
        Assert.Contains("German", text, StringComparison.Ordinal);

        // deleting, one solid per part, and the sizes of a designer are part of it
        Assert.Contains("\"remove\"", text, StringComparison.Ordinal);
        Assert.Contains("must NEVER overlap", text, StringComparison.Ordinal);
        Assert.Contains("clearance holes M3 3.4", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Settings_survive_bad_json()
    {
        Assert.True(AiSettings.Parse("not json").Enabled);
        var s = AiSettings.Parse(new AiSettings { Enabled = false, RepairRounds = 4 }.ToJson());
        Assert.False(s.Enabled);
        Assert.Equal(4, s.RepairRounds);
    }

    [DbFact]
    public async Task Only_administrators_manage_profiles_and_the_assistant_needs_the_editor_right()
    {
        await using var t = await TestDatabase.CreateAsync();
        var admin = await t.AddUserAsync("Ada", UserRole.Admin);
        var bob = await t.AddUserAsync("Bob");
        var services = Services();

        var asBob = new AiContext(t.Db, services, bob.Id);
        Assert.Null(await AiAdmin.ProfilesAsync(asBob));
        Assert.True((await AiAdmin.SaveAsync(asBob, null, new AiProfileInput("X", AiProvider.OpenAiCompatible, "openrouter", "https://openrouter.ai/api/v1", "m", "k", false, null))).Denied);

        var asAda = new AiContext(t.Db, services, admin.Id);
        var (saved, errors, _) = await AiAdmin.SaveAsync(asAda, null, new AiProfileInput("OpenRouter free", AiProvider.OpenAiCompatible, "openrouter", "https://openrouter.ai/api/v1", "deepseek/x:free", null, false, null));
        Assert.Empty(errors);
        Assert.True(saved!.IsActive);
        Assert.False(await AiService.IsAvailableAsync(t.Db, services)); // no key yet

        // the model of Ada: Bob may not use the assistant on it
        var model = (await ModelService.CreateAsync(t.Db, admin.Id, "Plate", null, null)).Value!;
        var studio = (await StudioService.OpenAsync(t.Db, Actor.Of(admin.Id), model.Id))!.Studios[0];
        var (result, failure) = await ModelAssistant.AssistAsync(t.Db, services, bob.Id, studio.Id, new ModelAssistant.Request("a plate", Answer(StudioContent.Empty), null, "en"), "127.0.0.1", false);
        Assert.Null(result);
        Assert.Equal("denied", failure!.Code);

        // Ada may, but without a key nothing is sent: the run says why
        (result, failure) = await ModelAssistant.AssistAsync(t.Db, services, admin.Id, studio.Id, new ModelAssistant.Request("a plate", Answer(StudioContent.Empty), null, "en"), "127.0.0.1", true);
        Assert.Null(result);
        Assert.Equal(AiService.Codes.NotConfigured, failure!.Code);
        Assert.Equal("/Admin/Ai/Profiles", failure.SettingsUrl);
        Assert.Single(t.Db.AiRuns);
    }

    private static ServiceProvider Services()
    {
        var data = Path.Combine(Path.GetTempPath(), "matshape-ai-" + Guid.NewGuid().ToString("N"));
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDataProtection();
        services.AddHttpClient();
        services.AddSingleton<Microsoft.Extensions.Configuration.IConfiguration>(new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["DataDirectory"] = data }).Build());
        services.AddSingleton<AiSecretStore>();
        services.AddSingleton<AiRateLimiter>();
        services.AddSingleton<ChatGptLoginStates>();
        return services.BuildServiceProvider();
    }
}
