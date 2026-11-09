using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MatPlatform;
using MatShape.Data;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.Extensions.DependencyInjection;

namespace MatShape.Tests.Platform;

/// <summary>The platform contract of MatDesign docs/PLATFORM.md (contract 2) as MatShape answers it: shapes, status codes, access (the whole app, PostgreSQL).</summary>
[Collection(AppCollection.Name)]
public sealed class PlatformApiTests(MatShapeFactory site) : IClassFixture<MatShapeFactory>
{
    private static readonly string[] Protected = ["/api/state", "/api/state/documents", "/api/configure", "/api/connections"];

    [DbFact]
    public async Task Health_answers_without_a_key()
    {
        var response = await site.CreateClient().GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("ok", doc.RootElement.GetProperty("status").GetString());
        Assert.Equal("matshape", doc.RootElement.GetProperty("app").GetString());
        Assert.Contains(doc.RootElement.GetProperty("checks").EnumerateArray(),
            c => c.GetProperty("name").GetString() == "database" && c.GetProperty("status").GetString() == "ok");
    }

    [DbFact]
    public async Task The_served_definition_is_contract_2_valid_and_without_a_secret()
    {
        var response = await site.CreateClient().GetAsync("/api");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync();
        Assert.Empty(MatPlatformValidator.Validate(text, MatPlatformValidator.ReadSprite(Repo.Sprite)));

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        Assert.Equal(2, root.GetProperty("contract").GetInt32());
        Assert.Equal("matshape", root.GetProperty("app").GetProperty("id").GetString());
        Assert.Equal(
            [MatCapabilities.IdentityOidc, MatCapabilities.MailSmtp],
            root.GetProperty("consumes").EnumerateArray().Select(c => c.GetProperty("capability").GetString()));
        var contributes = root.GetProperty("contributes");
        Assert.Equal("documents", contributes.GetProperty("launchers")[0].GetProperty("id").GetString());
        Assert.Equal(3, contributes.GetProperty("quickActions").GetArrayLength());
        Assert.Equal(2, contributes.GetProperty("widgets").GetArrayLength());
        Assert.True(root.GetProperty("auth").GetProperty("apiKey").GetBoolean());
        Assert.Contains("/api/connections", root.GetProperty("endpoints").EnumerateArray().Select(e => e.GetString()));

        // Never the key, a user or the database.
        Assert.DoesNotContain(MatShapeFactory.ApiKey, text);
        Assert.DoesNotContain(MatShapeFactory.AdminEmail, text);
        Assert.DoesNotContain("matshape_t_", text);
    }

    [DbFact]
    public async Task State_configure_connections_and_actions_need_the_key()
    {
        var anonymous = site.CreateClient();
        foreach (var path in Protected)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(path)).StatusCode);
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsync("/api/actions/cleanUp", null)).StatusCode);

        var api = site.Api();
        foreach (var path in Protected)
        {
            Assert.Equal(HttpStatusCode.OK, (await api.GetAsync(path)).StatusCode);
        }
    }

    [DbFact]
    public async Task The_state_has_the_numbers_of_the_installation()
    {
        using var doc = JsonDocument.Parse(await site.Api().GetStringAsync("/api/state"));
        var values = doc.RootElement.GetProperty("values");
        Assert.Equal(1, values.GetProperty("users").GetProperty("value").GetInt32());
        foreach (var key in new[] { "documents", "sharedDocuments", "linkedDocuments", "changedLast7Days" })
        {
            Assert.True(values.GetProperty(key).GetProperty("value").GetInt32() >= 0, key);
        }
    }

    [DbFact]
    public async Task Configure_saves_the_public_address_and_refuses_a_wrong_one()
    {
        var api = site.Api();
        var saved = await api.PutAsJsonAsync("/api/configure", new { values = new { publicUrl = "https://cad.example.org/" } });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        using (var doc = JsonDocument.Parse(await api.GetStringAsync("/api/configure")))
        {
            Assert.Equal("https://cad.example.org", doc.RootElement.GetProperty("values").GetProperty("publicUrl").GetString());
        }

        var wrong = await api.PutAsJsonAsync("/api/configure", new { values = new { publicUrl = "ftp://cad.example.org" } });
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

        var cleared = await api.PutAsJsonAsync("/api/configure", new { values = new { publicUrl = string.Empty } });
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        using (var doc = JsonDocument.Parse(await api.GetStringAsync("/api/configure")))
        {
            Assert.Equal(string.Empty, doc.RootElement.GetProperty("values").GetProperty("publicUrl").GetString());
        }
    }
}

/// <summary>MatShape without <c>MAT_API_KEY</c>: the protected endpoints, the Connections area's JSON among them, answer 401 even to a key.</summary>
[Collection(AppCollection.Name)]
public sealed class PlatformWithoutKeyTests(NoKeyFactory site) : IClassFixture<NoKeyFactory>
{
    [DbFact]
    public async Task Without_MAT_API_KEY_only_the_anonymous_endpoints_answer()
    {
        var client = site.CreateClient();
        client.DefaultRequestHeaders.Add("X-Api-Key", MatShapeFactory.ApiKey);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/state")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/configure")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/connections")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/health")).StatusCode);

        using var doc = JsonDocument.Parse(await client.GetStringAsync("/api"));
        Assert.False(doc.RootElement.GetProperty("auth").GetProperty("apiKey").GetBoolean());
    }
}

/// <summary>MatShape with <c>MAT_PUBLIC_URL</c>: the address in force everywhere, fixed in the definition, on the admin page and in the platform API.</summary>
[Collection(AppCollection.Name)]
public sealed class PlatformPublicUrlTests(PublicUrlFactory site) : IClassFixture<PublicUrlFactory>
{
    [DbFact]
    public async Task MAT_PUBLIC_URL_is_the_address_and_cannot_be_changed()
    {
        var api = site.Api();
        using (var doc = JsonDocument.Parse(await api.GetStringAsync("/api")))
        {
            var field = doc.RootElement.GetProperty("configure").EnumerateArray().Single(f => f.GetProperty("key").GetString() == "publicUrl");
            Assert.True(field.GetProperty("fixed").GetBoolean());
        }

        using (var doc = JsonDocument.Parse(await api.GetStringAsync("/api/configure")))
        {
            Assert.Equal(PublicUrlFactory.PublicUrl, doc.RootElement.GetProperty("values").GetProperty("publicUrl").GetString());
        }

        var refused = await api.PutAsJsonAsync("/api/configure", new { values = new { publicUrl = "https://other.example.com" } });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

        // the admin page shows it read-only; a post leaves it as it is and keeps the stored value apart
        var admin = new Browser(site);
        await admin.SignInAsync(MatShapeFactory.AdminEmail, MatShapeFactory.AdminPassword);
        var html = await (await admin.GetAsync("/Admin/System")).Content.ReadAsStringAsync();
        Assert.Contains("value=\"" + PublicUrlFactory.PublicUrl + "\"", html);
        Assert.Contains("MAT_PUBLIC_URL", html);
        var saved = await admin.PostAsync("/Admin/System", new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = Browser.Antiforgery(html),
            ["RegistrationOpen"] = "false",
            ["PublicUrl"] = "https://other.example.com",
        });
        Assert.Equal(HttpStatusCode.Redirect, saved.StatusCode);
        using (var scope = site.Services.CreateScope())
        {
            Assert.Equal(PublicUrlFactory.PublicUrl, (await scope.ServiceProvider.GetRequiredService<InstanceService>().SettingsAsync()).PublicUrl);
            Assert.Null((await scope.ServiceProvider.GetRequiredService<AccountService>().SettingsAsync()).PublicUrl);
        }

        // the link of a document is built from it
        long id;
        using (var scope = site.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var owner = db.Users.Single(u => u.Email == MatShapeFactory.AdminEmail).Id;
            var created = await DocumentService.CreateAsync(db, owner, "Bracket", null, null);
            Assert.True(created.Ok, created.Error);
            id = created.Value!.Id;
            Assert.NotNull(await DocumentService.SetLinkAsync(db, owner, id, LinkMode.View, renew: false));
        }

        var share = await (await admin.GetAsync($"/Documents/Share?id={id}")).Content.ReadAsStringAsync();
        Assert.Contains("value=\"" + PublicUrlFactory.PublicUrl + "/s/", share);
    }
}

/// <summary>
/// The Connections area of MatShape (MatPlatform's <c>&lt;mat-connections /&gt;</c>): for administrators only, it says what MatShape uses and adds to a home screen.
/// A class (and so an app and a database) of its own: it registers a second person, which would change the numbers the other classes look at.
/// </summary>
[Collection(AppCollection.Name)]
public sealed class ConnectionsTests(MatShapeFactory site) : IClassFixture<MatShapeFactory>
{
    [DbFact]
    public async Task The_Connections_area_is_for_administrators_and_says_what_MatShape_uses()
    {
        var api = site.Api();
        using (var doc = JsonDocument.Parse(await api.GetStringAsync("/api/connections")))
        {
            var uses = doc.RootElement.GetProperty("uses").EnumerateArray()
                .Select(u => (u.GetProperty("capability").GetString(), u.GetProperty("source").GetString(), u.GetProperty("optional").GetBoolean()))
                .ToList();
            Assert.Equal([(MatCapabilities.IdentityOidc, "none", true), (MatCapabilities.MailSmtp, "none", true)], uses);
            Assert.Empty(doc.RootElement.GetProperty("offers").EnumerateArray());
            Assert.Equal("documents", doc.RootElement.GetProperty("contributes").GetProperty("launchers")[0].GetProperty("id").GetString());
        }

        var admin = new Browser(site);
        await admin.SignInAsync(MatShapeFactory.AdminEmail, MatShapeFactory.AdminPassword);
        var page = await admin.GetAsync("/Admin/Connections");
        Assert.True(page.StatusCode == HttpStatusCode.OK, await Browser.ReasonAsync(page));
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("data-connections", html);
        Assert.Contains("href=\"/Admin/Connections\"", html);

        // a person who is not an administrator gets neither the page nor the menu entry
        var name = "u" + Guid.NewGuid().ToString("N")[..10];
        using (var scope = site.Services.CreateScope())
        {
            var (user, error) = await scope.ServiceProvider.GetRequiredService<AccountService>().RegisterAsync(name + "@example.com", name, "Correct-Horse-Battery");
            Assert.True(user is not null, error?.Message);
            Assert.Equal(UserRole.User, user.Role);
        }

        var person = new Browser(site);
        await person.SignInAsync(name + "@example.com", "Correct-Horse-Battery");
        Assert.NotEqual(HttpStatusCode.OK, (await person.GetAsync("/Admin/Connections")).StatusCode);
        var documents = await person.GetAsync("/Documents");
        Assert.Equal(HttpStatusCode.OK, documents.StatusCode);
        Assert.DoesNotContain("href=\"/Admin/Connections\"", await documents.Content.ReadAsStringAsync());
    }
}
