using System.Net;
using System.Text.RegularExpressions;
using MatPlatform;
using MatShape.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Net.Http.Headers;
using Npgsql;

namespace MatShape.Tests.Platform;

/// <summary>
/// The tests that start the whole app. The factories hand their settings to Program through environment variables (Program reads them before the host is built), so
/// these classes run one after another and after the rest of the suite (which runs in parallel and reads none of these variables).
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class AppCollection
{
    public const string Name = "The app in memory";
}

/// <summary>
/// The whole app in memory (<see cref="WebApplicationFactory{TEntryPoint}"/>) on a database of its own on the server of <c>MATSHAPE_TEST_DB</c> (the app creates
/// and migrates it at the start, the factory drops it) and an empty data folder, with the first account, the administrator (<see cref="AdminEmail"/>).
/// The background work (mail, housekeeping) stays off. <see cref="ApiKey"/> is <c>MAT_API_KEY</c> unless <c>withKey</c> is false; no MatIdentity, no MatSMTP.
/// </summary>
public class MatShapeFactory : WebApplicationFactory<Program>
{
    public const string ApiKey = "test-key-0123456789";
    public const string AdminEmail = "admin@example.com";
    public const string AdminPassword = "Start12345";

    private static readonly string[] Unset =
    [
        MatPlatformSettings.AuthorityVariable, MatPlatformSettings.ClientIdVariable, MatPlatformSettings.ClientSecretVariable, MatPlatformSettings.InternalUrlVariable,
        MatPlatformSettings.AppInternalUrlVariable, MatFrameAncestors.Variable,
        MatSmtpSettings.HostVariable, MatSmtpSettings.PortVariable, MatSmtpSettings.UsernameVariable, MatSmtpSettings.PasswordVariable, MatSmtpSettings.FromVariable,
        MatSmtpSettings.TlsVariable,
    ];

    private readonly string _data = Path.Combine(Path.GetTempPath(), "matshape-tests-" + Guid.NewGuid().ToString("N"));
    private readonly string _database = "matshape_t_" + Guid.NewGuid().ToString("N")[..12];

    public MatShapeFactory()
        : this(withKey: true)
    {
    }

    protected MatShapeFactory(bool withKey, string? publicUrl = null)
    {
        Directory.CreateDirectory(_data);

        var connection = TestDatabase.Admin is { Length: > 0 } admin
            ? new NpgsqlConnectionStringBuilder(admin) { Database = _database }.ConnectionString
            : null;
        Environment.SetEnvironmentVariable("ConnectionStrings__Default", connection);
        Environment.SetEnvironmentVariable("DataDirectory", _data);
        Environment.SetEnvironmentVariable(MatPlatformSettings.ApiKeyVariable, withKey ? ApiKey : null);
        Environment.SetEnvironmentVariable(MatPlatformSettings.PublicUrlVariable, publicUrl);
        foreach (var variable in Unset)
        {
            Environment.SetEnvironmentVariable(variable, null);
        }
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureTestServices(services =>
        {
            // No mail or housekeeping in the background: the tests look at the numbers they put in.
            foreach (var worker in services.Where(d => d.ServiceType == typeof(IHostedService)).ToList())
            {
                services.Remove(worker);
            }
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        var host = base.CreateHost(builder);
        using var scope = host.Services.CreateScope();
        var (user, error) = scope.ServiceProvider.GetRequiredService<AccountService>()
            .RegisterAsync(AdminEmail, "Administrator", AdminPassword).GetAwaiter().GetResult();
        Assert.True(user is not null, error?.Message);
        return host;
    }

    /// <summary>A client with the key (no redirects followed).</summary>
    public HttpClient Api()
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add("X-Api-Key", ApiKey);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        NpgsqlConnection.ClearAllPools();

        if (TestDatabase.Admin is { Length: > 0 } admin)
        {
            try
            {
                using var connection = new NpgsqlConnection(admin);
                connection.Open();
                using var command = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{_database}\" WITH (FORCE)", connection);
                command.ExecuteNonQuery();
            }
            catch (NpgsqlException)
            {
                // the server is gone already
            }
        }

        try
        {
            Directory.Delete(_data, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // a key file may still be open; the temp folder is cleaned by the system
        }
    }
}

/// <summary>Without <c>MAT_API_KEY</c>: the protected endpoints answer 401 to everyone.</summary>
public sealed class NoKeyFactory() : MatShapeFactory(withKey: false);

/// <summary>With <c>MAT_PUBLIC_URL</c>, as a broker (Mattiverse) sets it once the app has an address of its own.</summary>
public sealed class PublicUrlFactory() : MatShapeFactory(withKey: true, publicUrl: PublicUrl + "/")
{
    public const string PublicUrl = "https://cad.example.com";
}

/// <summary>Where the repository is, for the files the tests read (the sprite, the logo, the pages).</summary>
public static class Repo
{
    public static string Root
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "MatShape.slnx")))
            {
                dir = dir.Parent;
            }

            return dir?.FullName ?? throw new InvalidOperationException("MatShape.slnx not found above " + AppContext.BaseDirectory);
        }
    }

    /// <summary>The web project.</summary>
    public static string Web => Path.Combine(Root, "src", "MatShape");

    /// <summary>MatShape's copy of the MatUi sprite: the icons a consumer such as Mattiverse can draw.</summary>
    public static string Sprite => Path.Combine(Web, "wwwroot", "matui", "matui-icons.svg");
}

/// <summary>
/// A browser with its own cookie jar (no redirects followed). Each browser comes from an address of its own (<c>X-Forwarded-For</c>, which MatShape reads), so the
/// rate limit of the sign-in form counts it alone.
/// </summary>
public sealed partial class Browser(MatShapeFactory site)
{
    private static int _next;
    private readonly HttpClient _client = site.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
    private readonly Dictionary<string, string> _cookies = [];
    private readonly string _address = NextAddress();

    public Task<HttpResponseMessage> GetAsync(string path) => SendAsync(new HttpRequestMessage(HttpMethod.Get, path));

    public Task<HttpResponseMessage> PostAsync(string path, Dictionary<string, string> form)
        => SendAsync(new HttpRequestMessage(HttpMethod.Post, path) { Content = new FormUrlEncodedContent(form) });

    /// <summary>The local sign-in form, filled in and sent; it must answer with the redirect of a successful sign-in.</summary>
    public async Task SignInAsync(string email, string password)
    {
        var html = await (await GetAsync("/Account/Login")).Content.ReadAsStringAsync();
        var response = await PostAsync("/Account/Login", new Dictionary<string, string>
        {
            ["__RequestVerificationToken"] = Antiforgery(html),
            ["Email"] = email,
            ["Password"] = password,
            ["Remember"] = "true",
        });
        Assert.True(response.StatusCode == HttpStatusCode.Redirect, $"The sign-in answered {(int)response.StatusCode}: {await ReasonAsync(response)}");
    }

    public static string Antiforgery(string html)
    {
        var token = AntiforgeryRegex().Match(html).Groups[1].Value;
        Assert.False(string.IsNullOrEmpty(token), "No antiforgery token");
        return token;
    }

    /// <summary>Why a page failed, for the message of an assertion: the exception of the developer exception page (the factory runs in Development), else the start of the answer.</summary>
    public static async Task<string> ReasonAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        var error = ErrorRegex().Match(body);
        return WebUtility.HtmlDecode(error.Success ? error.Groups[1].Value : body[..Math.Min(body.Length, 600)]);
    }

    private static string NextAddress()
    {
        var n = Interlocked.Increment(ref _next);
        return $"10.9.{n / 250 % 250}.{n % 250 + 1}";
    }

    [GeneratedRegex(@"name=""__RequestVerificationToken"" type=""hidden"" value=""([^""]+)""")]
    private static partial Regex AntiforgeryRegex();

    [GeneratedRegex(@"class=""stackerror""[^>]*>([^<]+)<")]
    private static partial Regex ErrorRegex();

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request)
    {
        request.Headers.Add("X-Forwarded-For", _address);
        if (_cookies.Count > 0)
        {
            request.Headers.Add("Cookie", string.Join("; ", _cookies.Select(c => c.Key + "=" + c.Value)));
        }

        var response = await _client.SendAsync(request);
        if (response.Headers.TryGetValues("Set-Cookie", out var values))
        {
            foreach (var cookie in SetCookieHeaderValue.ParseList(values.ToList()))
            {
                var name = cookie.Name.Value!;
                if (string.IsNullOrEmpty(cookie.Value.Value) || cookie.Expires < DateTimeOffset.UtcNow)
                {
                    _cookies.Remove(name);
                }
                else
                {
                    _cookies[name] = cookie.Value.Value!;
                }
            }
        }

        return response;
    }
}
