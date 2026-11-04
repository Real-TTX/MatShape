using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services;

/// <summary>The numbers of the installation (the platform tiles, the admin page System). Nothing here says what is in a document: only how many.</summary>
public sealed record InstanceSnapshot(
    int Users,
    int Admins,
    int Documents,
    int SharedDocuments,
    int LinkedDocuments,
    int Studios,
    int Versions,
    int ChangedLast7Days,
    DateTime? LastActivityUtc);

/// <summary>What the housekeeping removed.</summary>
public sealed record CleanUpResult(int Sessions, int Documents);

/// <summary>
/// The installation as a whole: its numbers, the few settings of the system (registration, public address), the state of the database and the housekeeping.
/// The admin page System, the platform contract (<c>Platform/MatShapePlatform</c>) and the background housekeeping go through it, so none of them needs the database itself.
/// </summary>
public sealed class InstanceService(AppDbContext db, AccountService accounts)
{
    /// <summary>Can the database be reached (the health check)?</summary>
    public async Task<bool> CanConnectAsync(CancellationToken ct = default)
    {
        try
        {
            return await db.Database.CanConnectAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>The numbers of the installation.</summary>
    public async Task<InstanceSnapshot> SnapshotAsync(CancellationToken ct = default)
    {
        var weekAgo = DateTime.UtcNow.AddDays(-7);
        return new InstanceSnapshot(
            Users: await db.Users.CountAsync(u => u.IsActive, ct),
            Admins: await db.Users.CountAsync(u => u.IsActive && u.Role == UserRole.Admin, ct),
            Documents: await db.Documents.CountAsync(ct),
            SharedDocuments: await db.Documents.CountAsync(d => d.Members.Any(), ct),
            LinkedDocuments: await db.Documents.CountAsync(d => d.LinkMode != LinkMode.Off, ct),
            Studios: await db.PartStudios.CountAsync(ct),
            Versions: await db.DocumentVersions.CountAsync(ct),
            ChangedLast7Days: await db.Documents.CountAsync(d => d.UpdateDate >= weekAgo, ct),
            LastActivityUtc: await db.Documents.MaxAsync(d => (DateTime?)d.UpdateDate, ct));
    }

    /// <summary>Has anybody registered yet?</summary>
    public Task<bool> AnyUserAsync() => accounts.AnyUserAsync();

    /// <summary>Where the data is: <c>PostgreSQL host:port/database</c> (for the admin page; never in the platform API).</summary>
    public string DatabaseName()
    {
        var cs = new Npgsql.NpgsqlConnectionStringBuilder(db.Database.GetConnectionString());
        return $"PostgreSQL {cs.Host}:{cs.Port}/{cs.Database}";
    }

    /// <summary>The settings of the system.</summary>
    public async Task<(bool RegistrationOpen, string? PublicUrl)> SettingsAsync()
    {
        var s = await accounts.SettingsAsync();
        return (s.RegistrationOpen, s.PublicUrl);
    }

    /// <summary>
    /// Saves the settings of the system; a <c>null</c> leaves a value as it is, an empty address clears it. Answers the message for a public address that is not
    /// an absolute http(s) address (nothing is saved then), else <c>null</c>.
    /// </summary>
    public async Task<string?> SaveSettingsAsync(bool? registrationOpen, string? publicUrl)
    {
        string? url = null;
        if (publicUrl is not null)
        {
            url = NormalizePublicUrl(publicUrl);
            if (url is not null && !IsPublicUrl(url))
            {
                return Text.T("System.PublicUrl.Invalid");
            }
        }

        var s = await accounts.SettingsAsync();
        if (registrationOpen is { } open)
        {
            s.RegistrationOpen = open;
        }

        if (publicUrl is not null)
        {
            s.PublicUrl = url;
        }

        await db.SaveChangesAsync();
        return null;
    }

    /// <summary>The address without spaces and the last slash; <c>null</c> when empty.</summary>
    public static string? NormalizePublicUrl(string? url)
    {
        var trimmed = (url ?? string.Empty).Trim().TrimEnd('/');
        return trimmed.Length == 0 ? null : trimmed;
    }

    public static bool IsPublicUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";

    /// <summary>The housekeeping: ended and old sessions go, and a document or Part Studio that was deleted more than 30 days ago is removed for good.</summary>
    public async Task<CleanUpResult> CleanUpAsync(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var limit = now.AddDays(-30);
        var sessions = await db.Sessions.Where(s => s.IsRevoked || s.ExpiresDate < now.AddDays(-1)).ExecuteDeleteAsync(ct);
        await db.PartStudios.IgnoreQueryFilters().Where(s => s.UpdateState == SoftEntity.Deleted && s.UpdateDate < limit).ExecuteDeleteAsync(ct);
        var documents = await db.Documents.IgnoreQueryFilters().Where(d => d.UpdateState == SoftEntity.Deleted && d.UpdateDate < limit).ExecuteDeleteAsync(ct);
        return new CleanUpResult(sessions, documents);
    }
}
