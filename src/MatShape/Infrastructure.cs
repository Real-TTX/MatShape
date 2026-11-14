using System.Text.RegularExpressions;
using MatShape.Data;
using MatShape.Services;
using Microsoft.EntityFrameworkCore;

namespace MatShape;

/// <summary>
/// Docker <c>HEALTHCHECK</c> without curl: the app asks its own <c>/api/health</c> (platform contract: 200 for ok and degraded, 503 for down, so a degraded app is not
/// restarted) and answers with an exit code.
/// </summary>
public static partial class HealthCheck
{
    [GeneratedRegex(@":(\d+)")]
    private static partial Regex PortRegex();

    public static async Task<int> RunAsync()
    {
        var urls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
        var match = PortRegex().Match(urls ?? string.Empty);
        var port = match.Success ? match.Groups[1].Value : "3939";

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var response = await http.GetAsync($"http://localhost:{port}/api/health");
            return response.IsSuccessStatusCode ? 0 : 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return 1;
        }
    }
}

public static class Database
{
    /// <summary>Creates and updates the tables. The database container may still be starting: try again for a while before giving up.</summary>
    public static async Task MigrateWithRetryAsync(WebApplication app)
    {
        const int attempts = 30;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var scope = app.Services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await db.Database.MigrateAsync();
                app.Logger.LogInformation("The database is up to date.");
                return;
            }
            catch (Exception ex) when (attempt < attempts)
            {
                app.Logger.LogWarning("The database is not ready yet (attempt {Attempt}/{Attempts}): {Message}", attempt, attempts, ex.Message);
                await Task.Delay(TimeSpan.FromSeconds(3));
            }
        }
    }
}

/// <summary>Headers every response carries: no inline script or style (the toolkit needs none), nothing from another site, no guessing of types. The geometry kernel is WebAssembly ('wasm-unsafe-eval' allows compiling it, not eval of script).</summary>
public sealed class SecurityHeaders(RequestDelegate next)
{
    private const string Policy =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; " +
        "frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    /// <summary>
    /// Only for the files of the STEP / IGES / BREP reader (/lib/occt, OpenCascade as WebAssembly): it runs in a Web Worker and its embind code builds
    /// functions at run time, so this worker may evaluate script. A worker takes the policy of its own script, so every page keeps the strict policy above.
    /// </summary>
    private const string OcctWorkerPolicy =
        "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

    public Task InvokeAsync(HttpContext context)
    {
        var headers = context.Response.Headers;

        headers["Content-Security-Policy"] = context.Request.Path.StartsWithSegments("/lib/occt", StringComparison.Ordinal) ? OcctWorkerPolicy : Policy;
        headers["X-Content-Type-Options"] = "nosniff";
        headers["X-Frame-Options"] = "DENY";
        headers["Referrer-Policy"] = "same-origin";
        headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
        return next(context);
    }
}

/// <summary>
/// The addresses from the time models were called documents: a page (<c>/Documents/...</c>, bookmarks, the installed app) is sent to <c>/Models/...</c> for good; a request of
/// an editor that was still open (<c>/live/documents/...</c>) is answered by the new address directly, so its changes are not lost.
/// </summary>
public sealed class OldAddresses(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        if (request.Path.StartsWithSegments("/Documents", StringComparison.OrdinalIgnoreCase, out var rest))
        {
            context.Response.Redirect("/Models" + rest + request.QueryString, permanent: true, preserveMethod: !HttpMethods.IsGet(request.Method));
            return Task.CompletedTask;
        }

        if (request.Path.StartsWithSegments("/live/documents", StringComparison.OrdinalIgnoreCase, out var live))
        {
            request.Path = "/live/models" + live;
        }

        return next(context);
    }
}

/// <summary>The housekeeping that runs by itself: old sessions go, and a model that was deleted more than 30 days ago is removed for good.</summary>
public sealed class MaintenanceService(IServiceScopeFactory scopes, ILogger<MaintenanceService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await RunOnceAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "The housekeeping failed; it tries again later.");
                }

                await Task.Delay(TimeSpan.FromHours(6), stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // the app stops
        }
    }

    public async Task RunOnceAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var result = await scope.ServiceProvider.GetRequiredService<InstanceService>().CleanUpAsync(ct);
        logger.LogInformation("Housekeeping: {Sessions} old sessions and {Models} models removed.", result.Sessions, result.Models);
    }
}

/// <summary>
/// A text that is posted empty is an empty string, not <c>null</c>: the properties of the page models are not nullable, so the code never meets a null in a text.
/// </summary>
public sealed class EmptyStringBinderProvider : Microsoft.AspNetCore.Mvc.ModelBinding.IModelBinderProvider
{
    public Microsoft.AspNetCore.Mvc.ModelBinding.IModelBinder? GetBinder(Microsoft.AspNetCore.Mvc.ModelBinding.ModelBinderProviderContext context)
        => context.Metadata.ModelType == typeof(string) ? new EmptyStringBinder() : null;

    private sealed class EmptyStringBinder : Microsoft.AspNetCore.Mvc.ModelBinding.IModelBinder
    {
        public Task BindModelAsync(Microsoft.AspNetCore.Mvc.ModelBinding.ModelBindingContext bindingContext)
        {
            var result = bindingContext.ValueProvider.GetValue(bindingContext.ModelName);
            if (result == Microsoft.AspNetCore.Mvc.ModelBinding.ValueProviderResult.None)
            {
                return Task.CompletedTask;
            }

            bindingContext.ModelState.SetModelValue(bindingContext.ModelName, result);
            bindingContext.Result = Microsoft.AspNetCore.Mvc.ModelBinding.ModelBindingResult.Success(result.FirstValue ?? string.Empty);
            return Task.CompletedTask;
        }
    }
}
