using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Models;

/// <summary>One row of the versions of a model.</summary>
public sealed record VersionRow(long Id, string Name, string? Description, string? CreatedBy, DateTime CreateDate, int Studios, int Features);

/// <summary>What the list of versions is asked for: <c>Sort</c> is <c>created</c> or <c>name</c>.</summary>
public sealed record VersionQuery(string? Search, string Sort, bool Descending);

public sealed record VersionPage(IReadOnlyList<VersionRow> Rows, int Total, int Matching);

/// <summary>A Part Studio inside a version.</summary>
public sealed record SnapshotStudio(string Name, string Content);

/// <summary>
/// The versions of a model: a named copy of every Part Studio at one moment. Viewers see them, editors make and restore them, the owner deletes them.
/// Restoring replaces the Part Studios of the model by the ones of the version (the state before is kept as a version of its own first, so nothing is lost).
/// </summary>
public static class VersionService
{
    public const int NameMax = 120;
    public const int DescriptionMax = 1000;

    public static async Task<VersionPage?> ListAsync(AppDbContext db, Actor actor, long modelId, VersionQuery query, int page, int pageSize, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, actor, modelId, ct: ct) is null)
        {
            return null;
        }

        var all = db.ModelVersions.AsNoTracking().Where(v => v.ModelId == modelId);
        var total = await all.CountAsync(ct);
        var filtered = all;
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var like = $"%{query.Search.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";
            filtered = filtered.Where(v => EF.Functions.ILike(v.Name, like) || (v.Description != null && EF.Functions.ILike(v.Description, like)));
        }

        var matching = await filtered.CountAsync(ct);
        var ordered = (query.Sort, query.Descending) switch
        {
            ("name", false) => filtered.OrderBy(v => v.Name.ToLower()).ThenBy(v => v.Id),
            ("name", true) => filtered.OrderByDescending(v => v.Name.ToLower()).ThenBy(v => v.Id),
            (_, false) => filtered.OrderBy(v => v.CreateDate).ThenBy(v => v.Id),
            _ => filtered.OrderByDescending(v => v.CreateDate).ThenByDescending(v => v.Id),
        };

        var rows = await ordered.Skip((page - 1) * pageSize).Take(pageSize)
            .Select(v => new { v.Id, v.Name, v.Description, v.CreateUserId, v.CreateDate, v.Content })
            .ToListAsync(ct);
        var people = await NamesAsync(db, rows.Select(r => r.CreateUserId), ct);
        var list = rows.Select(r =>
        {
            var snapshot = ReadSnapshot(r.Content);
            return new VersionRow(r.Id, r.Name, r.Description, r.CreateUserId is { } u ? people.GetValueOrDefault(u) : null, r.CreateDate, snapshot.Count,
                snapshot.Sum(s => StudioContent.CountFeatures(s.Content)));
        }).ToList();
        return new VersionPage(list, total, matching);
    }

    /// <summary>The newest versions (the panel of the editor). Viewers too.</summary>
    public static async Task<IReadOnlyList<VersionRow>?> RecentAsync(AppDbContext db, Actor actor, long modelId, int take, CancellationToken ct = default)
        => (await ListAsync(db, actor, modelId, new VersionQuery(null, "created", true), 1, take, ct))?.Rows;

    /// <summary>One version for its edit page. Viewers see it, only editors may change it (the page asks <see cref="ModelAccessInfo.CanEdit"/>).</summary>
    public static async Task<(ModelVersion Version, ModelAccessInfo Access)?> GetAsync(AppDbContext db, long userId, long versionId, CancellationToken ct = default)
    {
        var version = await db.ModelVersions.AsNoTracking().FirstOrDefaultAsync(v => v.Id == versionId, ct);
        if (version is null || await ModelAccess.FindAsync(db, Actor.Of(userId), version.ModelId, ct: ct) is not { } access)
        {
            return null;
        }

        return (version, access);
    }

    /// <summary>Makes a version of the model as it is now. Editors only.</summary>
    public static async Task<Outcome<ModelVersion>> CreateAsync(AppDbContext db, long userId, long modelId, string name, string? description, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Editor, ct: ct) is null)
        {
            return Outcome<ModelVersion>.Denied();
        }

        if (Check(name, description) is { } error)
        {
            return Outcome<ModelVersion>.Fail(error);
        }

        var version = new ModelVersion
        {
            ModelId = modelId,
            Name = name.Trim(),
            Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim(),
            Content = await SnapshotAsync(db, modelId, ct),
            CreateUserId = userId,
        };
        db.ModelVersions.Add(version);
        await db.SaveChangesAsync(ct);
        return Outcome<ModelVersion>.Success(version);
    }

    /// <summary>Changes name and description of a version (its content never changes). Editors only.</summary>
    public static async Task<Outcome<ModelVersion>> UpdateAsync(AppDbContext db, long userId, long versionId, string name, string? description, CancellationToken ct = default)
    {
        var version = await db.ModelVersions.FirstOrDefaultAsync(v => v.Id == versionId, ct);
        if (version is null || await ModelAccess.FindAsync(db, Actor.Of(userId), version.ModelId, ModelRole.Editor, ct: ct) is null)
        {
            return Outcome<ModelVersion>.Denied();
        }

        if (Check(name, description) is { } error)
        {
            return Outcome<ModelVersion>.Fail(error);
        }

        version.Name = name.Trim();
        version.Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        await db.SaveChangesAsync(ct);
        return Outcome<ModelVersion>.Success(version);
    }

    /// <summary>Deletes a version. Owner only.</summary>
    public static async Task<bool> DeleteAsync(AppDbContext db, long userId, long versionId, CancellationToken ct = default)
    {
        var version = await db.ModelVersions.FirstOrDefaultAsync(v => v.Id == versionId, ct);
        if (version is null || await ModelAccess.FindAsync(db, Actor.Of(userId), version.ModelId, ModelRole.Owner, ct: ct) is null)
        {
            return false;
        }

        db.ModelVersions.Remove(version);
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// Brings the model back to a version: the current state is kept as a version first ("<paramref name="backupName"/>"), then the Part Studios are replaced by the
    /// ones of the version. Editors only.
    /// </summary>
    public static async Task<Outcome<long>> RestoreAsync(AppDbContext db, long userId, long versionId, string backupName, CancellationToken ct = default)
    {
        var version = await db.ModelVersions.AsNoTracking().FirstOrDefaultAsync(v => v.Id == versionId, ct);
        if (version is null || await ModelAccess.FindAsync(db, Actor.Of(userId), version.ModelId, ModelRole.Editor, ct: ct) is null)
        {
            return Outcome<long>.Denied();
        }

        var snapshot = ReadSnapshot(version.Content);
        if (snapshot.Count == 0)
        {
            return Outcome<long>.Fail(Text.T("Versions.Empty"));
        }

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        db.ModelVersions.Add(new ModelVersion
        {
            ModelId = version.ModelId,
            Name = backupName.Length > NameMax ? backupName[..NameMax] : backupName,
            Content = await SnapshotAsync(db, version.ModelId, ct),
            CreateUserId = userId,
        });

        var current = await db.PartStudios.Where(s => s.ModelId == version.ModelId).ToListAsync(ct);
        db.PartStudios.RemoveRange(current);
        for (var i = 0; i < snapshot.Count; i++)
        {
            db.PartStudios.Add(new PartStudio { ModelId = version.ModelId, Name = snapshot[i].Name, Position = i, Content = snapshot[i].Content, Revision = 1, CreateUserId = userId });
        }

        var model = await db.Models.FirstAsync(d => d.Id == version.ModelId, ct);
        model.UpdateDate = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return Outcome<long>.Success(version.ModelId);
    }

    /// <summary>The Part Studios stored in a version (an empty list for anything that cannot be read).</summary>
    public static IReadOnlyList<SnapshotStudio> ReadSnapshot(string json)
    {
        try
        {
            if (JsonNode.Parse(json) is not JsonArray array)
            {
                return [];
            }

            var list = new List<SnapshotStudio>();
            foreach (var item in array.OfType<JsonObject>())
            {
                var name = item["name"]?.GetValue<string>() ?? StudioService.DefaultName(list.Count + 1);
                var content = item["content"]?.ToJsonString() ?? StudioContent.Empty;
                list.Add(new SnapshotStudio(name, StudioContent.Validate(content) is null ? content : StudioContent.Empty));
            }

            return list;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
        {
            return [];
        }
    }

    /// <summary>Every Part Studio of the model as the JSON of a version.</summary>
    private static async Task<string> SnapshotAsync(AppDbContext db, long modelId, CancellationToken ct)
    {
        var studios = await db.PartStudios.AsNoTracking().Where(s => s.ModelId == modelId).OrderBy(s => s.Position).ThenBy(s => s.Id)
            .Select(s => new { s.Name, s.Content }).ToListAsync(ct);
        var array = new JsonArray();
        foreach (var s in studios)
        {
            array.Add(new JsonObject { ["name"] = s.Name, ["content"] = JsonNode.Parse(s.Content) });
        }

        return array.ToJsonString();
    }

    private static async Task<Dictionary<long, string>> NamesAsync(AppDbContext db, IEnumerable<long?> ids, CancellationToken ct)
    {
        var wanted = ids.OfType<long>().Distinct().ToList();
        return wanted.Count == 0
            ? []
            : await db.Users.IgnoreQueryFilters().AsNoTracking().Where(u => wanted.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
    }

    private static string? Check(string name, string? description)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return Text.T("Common.NameRequired");
        }

        if (name.Trim().Length > NameMax)
        {
            return Text.T("Models.NameTooLong", NameMax);
        }

        return description is { Length: > DescriptionMax } ? Text.T("Models.DescriptionTooLong", DescriptionMax) : null;
    }
}
