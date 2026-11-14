using System.Text.RegularExpressions;
using MatPlatform;
using MatShape.Platform;

namespace MatShape.Tests.Platform;

/// <summary>
/// The definition of MatShape (no database needed): valid for MatPlatform's validator in both languages against MatShape's copy of the MatUi sprite, also with a
/// public address; contract 2 with what MatShape consumes and what it adds to a home screen.
/// </summary>
public sealed partial class PlatformDefinitionTests
{
    [Theory]
    [InlineData("de")]
    [InlineData("en")]
    public void The_description_is_valid(string language)
    {
        var sprite = MatPlatformValidator.ReadSprite(Repo.Sprite);
        Assert.Empty(MatPlatformValidator.Validate(MatPlatformBuilder.Build(MatShapePlatform.Describe, language), sprite));
        Assert.Empty(MatPlatformValidator.Validate(MatPlatformBuilder.Build(o => MatShapePlatform.Describe(o, "https://cad.example.com"), language), sprite));
    }

    [Fact]
    public void MatShape_consumes_the_sign_in_and_the_mail_both_optional()
    {
        var definition = MatPlatformBuilder.Build(MatShapePlatform.Describe, "en");
        Assert.Equal(MatApiDefinition.ContractVersion, definition.Contract);
        Assert.Equal(2, definition.Contract);
        Assert.Empty(definition.Provides);
        Assert.Equal([MatCapabilities.IdentityOidc, MatCapabilities.MailSmtp], definition.Consumes.Select(c => c.Capability));
        Assert.All(definition.Consumes, c => Assert.True(c.Optional));
    }

    [Fact]
    public void MatShape_contributes_its_launcher_the_document_views_and_two_admin_widgets()
    {
        var definition = MatPlatformBuilder.Build(MatShapePlatform.Describe, "en");
        var contributes = definition.Contributes!;

        var launcher = Assert.Single(contributes.Launchers);
        Assert.Equal(("models", "MatShape", "/Models"), (launcher.Id, launcher.Label, launcher.Url));
        Assert.True(File.Exists(Path.Combine(Repo.Web, "wwwroot", launcher.Icon.TrimStart('/'))), launcher.Icon);
        Assert.Equal(definition.App.Icon, launcher.Icon);

        // a new model and the lists of the menu, all pages of MatShape
        Assert.Equal(["/Models/Edit", "/Models", "/Models?scope=shared"], contributes.QuickActions.Select(q => q.Url));
        Assert.All(contributes.QuickActions, q => Assert.Equal("models", q.Launcher));
        Assert.All(contributes.QuickActions, q => Assert.Null(q.Action));
        var routes = Routes();
        Assert.All(
            contributes.QuickActions.Select(q => q.Url!).Append(launcher.Url),
            url => Assert.Contains(url.Split('?')[0], routes));

        // widgets only from the tiles of the overview, only for administrators (the figures of the whole installation)
        Assert.Equal(["models", "users"], contributes.Widgets.Select(w => w.Id));
        Assert.All(contributes.Widgets, w => Assert.Equal(MatAudience.Admin, w.Audience));
        Assert.Equal((MatWidgetKinds.Tiles, "medium"), (contributes.Widgets[0].Kind, contributes.Widgets[0].Size));
        Assert.Equal(["models", "sharedModels", "linkedModels", "changedLast7Days"], contributes.Widgets[0].Items);
        Assert.Equal(MatWidgetKinds.Stat, contributes.Widgets[1].Kind);
        Assert.Equal(["users"], contributes.Widgets[1].Items);
        var tiles = definition.Pages.Single(p => p.Id == "overview").Sections.Single(s => s.Kind == "tiles").Items;
        Assert.All(contributes.Widgets.SelectMany(w => w.Items), key => Assert.Contains(key, tiles));
        Assert.All(contributes.Widgets, w => Assert.Contains(w.Url!, routes));
    }

    [Fact]
    public void The_overview_links_to_the_Connections_area_and_every_link_is_a_page()
    {
        var definition = MatPlatformBuilder.Build(MatShapePlatform.Describe, "en");
        Assert.Equal(["openApp", "openUsers", "openConnections", "openSystem", "cleanUp"], definition.Actions.Select(a => a.Id));
        Assert.Equal(["/Models", "/Admin/Users", "/Admin/Connections", "/Admin/System", null], definition.Actions.Select(a => a.Url));
        var overview = definition.Pages.Single(p => p.Id == "overview").Sections.Single(s => s.Kind == "actions").Items;
        Assert.Contains("openConnections", overview);

        var routes = Routes();
        Assert.All(definition.Actions.Where(a => a.Url is not null), a => Assert.Contains(a.Url!, routes));
    }

    [Fact]
    public void MAT_PUBLIC_URL_fixes_the_public_address()
    {
        Assert.Null(MatPlatformBuilder.Build(MatShapePlatform.Describe, "en").Configure.Single(f => f.Key == "publicUrl").Fixed);
        foreach (var language in new[] { "de", "en" })
        {
            var field = MatPlatformBuilder.Build(o => MatShapePlatform.Describe(o, "https://cad.example.com"), language).Configure.Single(f => f.Key == "publicUrl");
            Assert.True(field.Fixed);
            Assert.Contains("MAT_PUBLIC_URL", field.Hint, StringComparison.Ordinal);
        }
    }

    /// <summary>The routes of the Razor pages (<c>@page "/Models/Edit"</c>).</summary>
    private static HashSet<string> Routes()
        => Directory.EnumerateFiles(Path.Combine(Repo.Web, "Pages"), "*.cshtml", SearchOption.AllDirectories)
            .Select(f => PageRegex().Match(File.ReadAllText(f)))
            .Where(m => m.Success)
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);

    [GeneratedRegex("""^@page "([^"]+)"\r?$""", RegexOptions.Multiline)]
    private static partial Regex PageRegex();
}
