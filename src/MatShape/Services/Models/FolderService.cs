using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Models;

/// <summary>A folder of the person (the tree is made from these).</summary>
public sealed record FolderRow(long Id, string Name, long? ParentId);

/// <summary>A folder as the list shows it: how many models and folders lie directly in it.</summary>
public sealed record FolderTile(long Id, string Name, int Models, int Folders, DateTime UpdateDate);

/// <summary>
/// The folders of a person. They are private: everybody files the models they see (their own on <see cref="Model.FolderId"/>, the ones shared with them on
/// <see cref="ModelMember.FolderId"/>) in folders of their own. Every function checks that the folder belongs to the person; a folder of somebody else is "not there".
/// Filing a model is not a change of its design: the date of its last change stays.
/// </summary>
public static class FolderService
{
    public const int NameMax = 120;

    /// <summary>How deep folders may lie in each other.</summary>
    public const int DepthMax = 12;

    /// <summary>Every folder of the person (few: the tree, the path and the choices are made from them in memory).</summary>
    public static async Task<IReadOnlyList<FolderRow>> AllAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => await db.Folders.AsNoTracking().Where(f => f.OwnerId == userId).OrderBy(f => f.Name).ThenBy(f => f.Id)
            .Select(f => new FolderRow(f.Id, f.Name, f.ParentId)).ToListAsync(ct);

    /// <summary>The folders from the top down to <paramref name="id"/> (for the path above the list); empty when it is not a folder of the person.</summary>
    public static IReadOnlyList<FolderRow> PathOf(IReadOnlyList<FolderRow> all, long? id)
    {
        var byId = all.ToDictionary(f => f.Id);
        var path = new List<FolderRow>();
        for (var at = id; at is { } current && byId.TryGetValue(current, out var folder) && path.Count <= DepthMax; at = folder.ParentId)
        {
            path.Add(folder);
        }

        path.Reverse();
        return path;
    }

    /// <summary>
    /// The folders as a tree for a choice ("Parts", "· Brackets" ...), in the order of the tree; <paramref name="without"/> leaves a folder and everything in it out
    /// (a folder cannot move into itself).
    /// </summary>
    public static IReadOnlyList<(long Id, string Label)> Tree(IReadOnlyList<FolderRow> all, long? without = null)
    {
        var result = new List<(long, string)>();
        var children = all.ToLookup(f => f.ParentId);

        void Walk(long? parent, int depth)
        {
            foreach (var f in children[parent].OrderBy(f => f.Name, StringComparer.CurrentCultureIgnoreCase))
            {
                if (f.Id == without || depth > DepthMax)
                {
                    continue;
                }

                result.Add((f.Id, new string(' ', depth * 3) + (depth > 0 ? "└ " : string.Empty) + f.Name));
                Walk(f.Id, depth + 1);
            }
        }

        Walk(null, 0);
        return result;
    }

    /// <summary>The folders that lie in <paramref name="parentId"/> (null = at the top), or – while searching – the folders whose name matches, wherever they are.</summary>
    public static async Task<IReadOnlyList<FolderTile>> ChildrenAsync(AppDbContext db, long userId, long? parentId, string? search = null, CancellationToken ct = default)
    {
        var folders = db.Folders.AsNoTracking().Where(f => f.OwnerId == userId);
        folders = string.IsNullOrWhiteSpace(search)
            ? folders.Where(f => f.ParentId == parentId)
            : folders.Where(f => EF.Functions.ILike(f.Name, ModelService.Like(search)));

        return await folders.OrderBy(f => f.Name.ToLower()).ThenBy(f => f.Id)
            .Select(f => new FolderTile(
                f.Id,
                f.Name,
                db.Models.Count(m => m.FolderId == f.Id) + db.ModelMembers.Count(m => m.FolderId == f.Id && m.Model!.UpdateState != SoftEntity.Deleted),
                db.Folders.Count(c => c.ParentId == f.Id),
                f.UpdateDate))
            .ToListAsync(ct);
    }

    /// <summary>One folder of the person, or <c>null</c>.</summary>
    public static Task<Folder?> FindAsync(AppDbContext db, long userId, long id, bool track = false, CancellationToken ct = default)
        => (track ? db.Folders : db.Folders.AsNoTracking()).FirstOrDefaultAsync(f => f.Id == id && f.OwnerId == userId, ct);

    /// <summary>Makes a folder in <paramref name="parentId"/> (null = at the top).</summary>
    public static async Task<Outcome<Folder>> CreateAsync(AppDbContext db, long userId, string name, long? parentId, CancellationToken ct = default)
    {
        if (Check(name) is { } error)
        {
            return Outcome<Folder>.Fail(error);
        }

        var all = await AllAsync(db, userId, ct);
        if (parentId is { } parent && all.All(f => f.Id != parent))
        {
            return Outcome<Folder>.Denied();
        }

        if (PathOf(all, parentId).Count + 1 > DepthMax)
        {
            return Outcome<Folder>.Fail(Text.T("Folders.TooDeep", DepthMax));
        }

        var folder = new Folder { OwnerId = userId, ParentId = parentId, Name = name.Trim(), CreateUserId = userId };
        db.Folders.Add(folder);
        await db.SaveChangesAsync(ct);
        return Outcome<Folder>.Success(folder);
    }

    /// <summary>Renames a folder and puts it into <paramref name="parentId"/> – never into itself or a folder inside it.</summary>
    public static async Task<Outcome<Folder>> UpdateAsync(AppDbContext db, long userId, long id, string name, long? parentId, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, id, track: true, ct) is not { } folder)
        {
            return Outcome<Folder>.Denied();
        }

        if (Check(name) is { } error)
        {
            return Outcome<Folder>.Fail(error);
        }

        if (folder.ParentId != parentId && await CanMoveAsync(db, userId, id, parentId, ct) is { } problem)
        {
            return problem.Length == 0 ? Outcome<Folder>.Denied() : Outcome<Folder>.Fail(problem);
        }

        folder.Name = name.Trim();
        folder.ParentId = parentId;
        await db.SaveChangesAsync(ct);
        return Outcome<Folder>.Success(folder);
    }

    /// <summary>Puts a folder into another one (or at the top: <paramref name="parentId"/> null) – never into itself or a folder inside it.</summary>
    public static async Task<Outcome<Folder>> MoveAsync(AppDbContext db, long userId, long id, long? parentId, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, id, track: true, ct) is not { } folder)
        {
            return Outcome<Folder>.Denied();
        }

        if (folder.ParentId == parentId)
        {
            return Outcome<Folder>.Success(folder);
        }

        if (await CanMoveAsync(db, userId, id, parentId, ct) is { } problem)
        {
            return problem.Length == 0 ? Outcome<Folder>.Denied() : Outcome<Folder>.Fail(problem);
        }

        folder.ParentId = parentId;
        await db.SaveChangesAsync(ct);
        return Outcome<Folder>.Success(folder);
    }

    /// <summary>
    /// Deletes a folder, nothing in it: its models and folders move up to where it was. Models stay where they are for everybody else (each person files on their own).
    /// </summary>
    public static async Task<bool> DeleteAsync(AppDbContext db, long userId, long id, CancellationToken ct = default)
    {
        if (await FindAsync(db, userId, id, ct: ct) is not { } folder)
        {
            return false;
        }

        var parent = folder.ParentId;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Folders.Where(f => f.OwnerId == userId && f.ParentId == id).ExecuteUpdateAsync(s => s.SetProperty(f => f.ParentId, parent), ct);
        await db.Models.IgnoreQueryFilters().Where(m => m.OwnerId == userId && m.FolderId == id).ExecuteUpdateAsync(s => s.SetProperty(m => m.FolderId, parent), ct);
        await db.ModelMembers.Where(m => m.UserId == userId && m.FolderId == id).ExecuteUpdateAsync(s => s.SetProperty(m => m.FolderId, parent), ct);
        await db.Folders.Where(f => f.Id == id && f.OwnerId == userId).ExecuteDeleteAsync(ct);
        await tx.CommitAsync(ct);
        return true;
    }

    /// <summary>Files a model the person sees in a folder of theirs (null = at the top): the owner on the model, a member on their membership.</summary>
    public static async Task<bool> FileAsync(AppDbContext db, long userId, long modelId, long? folderId, CancellationToken ct = default)
    {
        if (folderId is { } target && await FindAsync(db, userId, target, ct: ct) is null)
        {
            return false;
        }

        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ct: ct) is not { } access)
        {
            return false;
        }

        // not a change of the design: the date of the last change stays (ExecuteUpdate does not stamp)
        if (access.IsOwner)
        {
            await db.Models.Where(m => m.Id == modelId).ExecuteUpdateAsync(s => s.SetProperty(m => m.FolderId, folderId), ct);
        }
        else
        {
            await db.ModelMembers.Where(m => m.ModelId == modelId && m.UserId == userId).ExecuteUpdateAsync(s => s.SetProperty(m => m.FolderId, folderId), ct);
        }

        return true;
    }

    /// <summary>The folder a person filed a model in (null = at the top, or not theirs to see).</summary>
    public static async Task<long?> FolderOfAsync(AppDbContext db, long userId, long modelId, CancellationToken ct = default)
    {
        var owned = await db.Models.AsNoTracking().Where(m => m.Id == modelId && m.OwnerId == userId).Select(m => new { m.FolderId }).FirstOrDefaultAsync(ct);
        if (owned is not null)
        {
            return owned.FolderId;
        }

        return await db.ModelMembers.AsNoTracking().Where(m => m.ModelId == modelId && m.UserId == userId).Select(m => m.FolderId).FirstOrDefaultAsync(ct);
    }

    /// <summary>Whether a folder may go into <paramref name="parentId"/>: <c>null</c> = yes, "" = the target is not the person's, else the problem.</summary>
    private static async Task<string?> CanMoveAsync(AppDbContext db, long userId, long id, long? parentId, CancellationToken ct)
    {
        if (parentId is null)
        {
            return null;
        }

        var all = await AllAsync(db, userId, ct);
        if (all.All(f => f.Id != parentId))
        {
            return string.Empty;
        }

        var path = PathOf(all, parentId);
        if (path.Any(f => f.Id == id))
        {
            return Text.T("Folders.IntoItself");
        }

        return path.Count + Height(all, id) > DepthMax ? Text.T("Folders.TooDeep", DepthMax) : null;
    }

    /// <summary>How many levels a folder has, itself included.</summary>
    private static int Height(IReadOnlyList<FolderRow> all, long id)
    {
        var children = all.ToLookup(f => f.ParentId);
        int Of(long folder, int guard) => guard > DepthMax ? 1 : 1 + children[folder].Select(c => Of(c.Id, guard + 1)).DefaultIfEmpty(0).Max();
        return Of(id, 0);
    }

    private static string? Check(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return Text.T("Common.NameRequired");
        }

        return name.Trim().Length > NameMax ? Text.T("Models.NameTooLong", NameMax) : null;
    }
}
