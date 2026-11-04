using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Documents;

/// <summary>A Part Studio as the editor gets it.</summary>
public sealed record StudioData(long Id, string Name, int Position, long Revision, string Content, DateTime UpdateDate);

/// <summary>A document as the editor opens it: who may do what, its unit and every Part Studio (or the Part Studios of a version, read-only).</summary>
public sealed record EditorData(long Id, string Name, string Units, DocumentRole Role, IReadOnlyList<StudioData> Studios, long? VersionId, string? VersionName)
{
    public bool CanEdit => Role >= DocumentRole.Editor && VersionId is null;
}

public enum SaveStatus
{
    Saved,

    /// <summary>Somebody else saved in between: the browser gets the newer content and decides (it never overwrites silently).</summary>
    Conflict,

    Invalid,
    Denied,
}

public sealed record SaveResult(SaveStatus Status, long Revision, string? Content = null, string? Problem = null);

/// <summary>
/// The Part Studios of a document: open, save (with the revision the browser started from, so two people never overwrite each other unnoticed), add, rename, copy,
/// move and delete the tabs. Looking needs the viewer right, every change the editor right; both are checked here, not in the endpoints.
/// </summary>
public static class StudioService
{
    public const int NameMax = 80;

    /// <summary>The name of a new Part Studio: "Part Studio 2".</summary>
    public static string DefaultName(int number) => Text.T("Studios.DefaultName", number);

    /// <summary>Everything the editor needs to open a document, or <c>null</c> when the actor may not see it. With a version: the Part Studios of that version.</summary>
    public static async Task<EditorData?> OpenAsync(AppDbContext db, Actor actor, long documentId, long? versionId = null, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, actor, documentId, ct: ct) is not { } access)
        {
            return null;
        }

        var document = access.Document;
        if (versionId is { } vid)
        {
            var version = await db.DocumentVersions.AsNoTracking().Where(v => v.Id == vid && v.DocumentId == documentId).Select(v => new { v.Id, v.Name, v.Content, v.CreateDate }).FirstOrDefaultAsync(ct);
            if (version is null)
            {
                return null;
            }

            var snapshot = VersionService.ReadSnapshot(version.Content);
            var studios = snapshot.Select((s, i) => new StudioData(-(i + 1), s.Name, i, 0, s.Content, version.CreateDate)).ToList();
            return new EditorData(document.Id, document.Name, document.Units, DocumentRole.Viewer, studios, version.Id, version.Name);
        }

        var rows = await db.PartStudios.AsNoTracking().Where(s => s.DocumentId == documentId).OrderBy(s => s.Position).ThenBy(s => s.Id)
            .Select(s => new StudioData(s.Id, s.Name, s.Position, s.Revision, s.Content, s.UpdateDate)).ToListAsync(ct);
        return new EditorData(document.Id, document.Name, document.Units, access.Role, rows, null, null);
    }

    /// <summary>Saves the content of a Part Studio when the browser started from the newest revision. Editors only.</summary>
    public static async Task<SaveResult> SaveAsync(AppDbContext db, long userId, long studioId, long baseRevision, string content, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, studioId, DocumentRole.Editor, ct) is not { } studio)
        {
            return new SaveResult(SaveStatus.Denied, 0);
        }

        if (StudioContent.Validate(content) is { } problem)
        {
            return new SaveResult(SaveStatus.Invalid, studio.Revision, Problem: problem);
        }

        if (studio.Revision != baseRevision)
        {
            return new SaveResult(SaveStatus.Conflict, studio.Revision, studio.Content);
        }

        // the revision is the guard: the update only happens when nobody saved in between (two requests at the same moment)
        var next = baseRevision + 1;
        var now = DateTime.UtcNow;
        var changed = await db.PartStudios.Where(s => s.Id == studioId && s.Revision == baseRevision).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.Content, content)
            .SetProperty(x => x.Revision, next)
            .SetProperty(x => x.UpdateDate, now)
            .SetProperty(x => x.UpdateUserId, userId)
            .SetProperty(x => x.UpdateState, SoftEntity.Updated), ct);
        if (changed == 0)
        {
            var current = await db.PartStudios.AsNoTracking().Where(s => s.Id == studioId).Select(s => new { s.Revision, s.Content }).FirstAsync(ct);
            return new SaveResult(SaveStatus.Conflict, current.Revision, current.Content);
        }

        await TouchAsync(db, userId, studio.DocumentId, ct);
        return new SaveResult(SaveStatus.Saved, next);
    }

    /// <summary>The revision of a Part Studio and who changed it last (the editor asks now and then whether somebody else worked on it), or <c>null</c>.</summary>
    public static async Task<(long Revision, string? By)?> RevisionAsync(AppDbContext db, Actor actor, long studioId, CancellationToken ct = default)
    {
        var row = await db.PartStudios.AsNoTracking().Where(s => s.Id == studioId).Select(s => new { s.DocumentId, s.Revision, s.UpdateUserId }).FirstOrDefaultAsync(ct);
        if (row is null || await DocumentAccess.FindAsync(db, actor, row.DocumentId, ct: ct) is null)
        {
            return null;
        }

        var by = row.UpdateUserId is { } uid ? await db.Users.AsNoTracking().Where(u => u.Id == uid).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) : null;
        return (row.Revision, by);
    }

    /// <summary>A new, empty Part Studio at the end of the tabs. Editors only.</summary>
    public static async Task<Outcome<StudioData>> AddAsync(AppDbContext db, long userId, long documentId, string? name, string? content = null, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Editor, ct: ct) is null)
        {
            return Outcome<StudioData>.Denied();
        }

        var body = content ?? StudioContent.Empty;
        if (StudioContent.Validate(body) is not null)
        {
            return Outcome<StudioData>.Fail(Text.T("Studios.Invalid"));
        }

        var count = await db.PartStudios.CountAsync(s => s.DocumentId == documentId, ct);
        var last = await db.PartStudios.Where(s => s.DocumentId == documentId).MaxAsync(s => (int?)s.Position, ct) ?? -1;
        var studio = new PartStudio
        {
            DocumentId = documentId,
            Name = CleanName(name) ?? DefaultName(count + 1),
            Position = last + 1,
            Content = body,
            CreateUserId = userId,
        };
        db.PartStudios.Add(studio);
        await db.SaveChangesAsync(ct);
        await TouchAsync(db, userId, documentId, ct);
        return Outcome<StudioData>.Success(new StudioData(studio.Id, studio.Name, studio.Position, studio.Revision, studio.Content, studio.UpdateDate));
    }

    /// <summary>A copy of a Part Studio, right after it. Editors only.</summary>
    public static async Task<Outcome<StudioData>> DuplicateAsync(AppDbContext db, long userId, long studioId, string copyWord, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, studioId, DocumentRole.Editor, ct) is not { } source)
        {
            return Outcome<StudioData>.Denied();
        }

        var name = $"{source.Name} ({copyWord})";
        return await AddAsync(db, userId, source.DocumentId, name.Length > NameMax ? name[..NameMax] : name, source.Content, ct);
    }

    /// <summary>Renames a Part Studio. Editors only.</summary>
    public static async Task<Outcome<StudioData>> RenameAsync(AppDbContext db, long userId, long studioId, string name, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, studioId, DocumentRole.Editor, ct, track: true) is not { } studio)
        {
            return Outcome<StudioData>.Denied();
        }

        if (CleanName(name) is not { } clean)
        {
            return Outcome<StudioData>.Fail(Text.T("Common.NameRequired"));
        }

        studio.Name = clean;
        await db.SaveChangesAsync(ct);
        return Outcome<StudioData>.Success(new StudioData(studio.Id, studio.Name, studio.Position, studio.Revision, studio.Content, studio.UpdateDate));
    }

    /// <summary>Moves a tab one place to the left (-1) or right (+1). Editors only.</summary>
    public static async Task<bool> MoveAsync(AppDbContext db, long userId, long studioId, int step, CancellationToken ct = default)
    {
        if (step is not (-1 or 1) || await FindAsync(db, userId, studioId, DocumentRole.Editor, ct) is not { } studio)
        {
            return false;
        }

        var all = await db.PartStudios.Where(s => s.DocumentId == studio.DocumentId).OrderBy(s => s.Position).ThenBy(s => s.Id).ToListAsync(ct);
        var index = all.FindIndex(s => s.Id == studioId);
        var other = index + step;
        if (other < 0 || other >= all.Count)
        {
            return true;
        }

        (all[index], all[other]) = (all[other], all[index]);
        for (var i = 0; i < all.Count; i++)
        {
            all[i].Position = i;
        }

        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Deletes a Part Studio; the last one of a document stays (a document always has one). Editors only.</summary>
    public static async Task<Outcome<bool>> DeleteAsync(AppDbContext db, long userId, long studioId, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, studioId, DocumentRole.Editor, ct, track: true) is not { } studio)
        {
            return Outcome<bool>.Denied();
        }

        if (await db.PartStudios.CountAsync(s => s.DocumentId == studio.DocumentId, ct) <= 1)
        {
            return Outcome<bool>.Fail(Text.T("Studios.LastOne"));
        }

        db.PartStudios.Remove(studio);
        await db.SaveChangesAsync(ct);
        await TouchAsync(db, userId, studio.DocumentId, ct);
        return Outcome<bool>.Success(true);
    }

    /// <summary>A Part Studio when the person has at least <paramref name="minimum"/> on its document, else <c>null</c>.</summary>
    private static async Task<PartStudio?> FindAsync(AppDbContext db, long userId, long studioId, DocumentRole minimum, CancellationToken ct, bool track = false)
    {
        var query = track ? db.PartStudios : db.PartStudios.AsNoTracking();
        var studio = await query.FirstOrDefaultAsync(s => s.Id == studioId, ct);
        if (studio is null || await DocumentAccess.FindAsync(db, Actor.Of(userId), studio.DocumentId, minimum, ct: ct) is null)
        {
            return null;
        }

        return studio;
    }

    /// <summary>The document was changed now (the list sorts by it).</summary>
    private static Task TouchAsync(AppDbContext db, long userId, long documentId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        return db.Documents.Where(d => d.Id == documentId).ExecuteUpdateAsync(s => s.SetProperty(d => d.UpdateDate, now).SetProperty(d => d.UpdateUserId, userId), ct);
    }

    private static string? CleanName(string? name)
    {
        var trimmed = (name ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        return trimmed.Length > NameMax ? trimmed[..NameMax] : trimmed;
    }
}
