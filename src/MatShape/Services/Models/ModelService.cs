using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Models;

/// <summary>One row of the list of models.</summary>
public sealed record ModelRow(
    long Id, string Name, string? Description, string Units, string OwnerName, ModelRole Role, int Members, int Studios, bool HasThumbnail, DateTime UpdateDate, DateTime CreateDate)
{
    public bool Mine => Role == ModelRole.Owner;
}

/// <summary>
/// What the list of models is asked for: <c>Scope</c> is <c>all</c>, <c>mine</c> or <c>shared</c>; <c>Sort</c> is <c>name</c>, <c>changed</c> or <c>created</c>. Without a search and
/// a scope the list is browsed by folder (<c>Folder</c>: null = the top); a search or a scope looks through every folder.
/// </summary>
public sealed record ModelQuery(string? Search, string? Scope, string Sort, bool Descending, long? Folder = null)
{
    public bool Browsing => string.IsNullOrWhiteSpace(Search) && Scope is null;
}

public sealed record ModelPage(IReadOnlyList<ModelRow> Rows, int Total, int Matching);

/// <summary>A person a model is shared with, as the owner sees them.</summary>
public sealed record MemberRow(long UserId, string Name, string Email, ModelRole Role);

/// <summary>
/// The models: list, create, change, delete, copy, who they are shared with, the link and the picture of the list. Every function checks the right of the person first
/// (<see cref="ModelAccess"/>); nothing here trusts the page. Only the owner changes a model's settings, its members and its link.
/// </summary>
public static class ModelService
{
    public const int NameMax = 120;
    public const int DescriptionMax = 1000;

    /// <summary>The largest picture of a model that is kept (a PNG of a few hundred pixels is far smaller).</summary>
    public const int ThumbnailMax = 400_000;

    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>The models a person sees, filtered, sorted and cut to a page.</summary>
    public static async Task<ModelPage> ListAsync(AppDbContext db, long userId, ModelQuery query, int page, int pageSize, CancellationToken ct = default)
    {
        var visible = ModelAccess.Visible(db, userId);
        var total = await visible.CountAsync(ct);

        var filtered = visible;
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var like = Like(query.Search);
            filtered = filtered.Where(d => EF.Functions.ILike(d.Name, like) || (d.Description != null && EF.Functions.ILike(d.Description, like)));
        }

        if (query.Browsing)
        {
            // where the person filed it: the owner on the model, a member on their membership
            var folder = query.Folder;
            filtered = filtered.Where(d => (d.OwnerId == userId && d.FolderId == folder)
                || (d.OwnerId != userId && d.Members.Any(m => m.UserId == userId && m.FolderId == folder)));
        }

        filtered = query.Scope switch
        {
            "mine" => filtered.Where(d => d.OwnerId == userId),
            "shared" => filtered.Where(d => d.OwnerId != userId),
            _ => filtered,
        };

        var matching = await filtered.CountAsync(ct);
        var ordered = (query.Sort, query.Descending) switch
        {
            ("name", false) => filtered.OrderBy(d => d.Name.ToLower()).ThenBy(d => d.Id),
            ("name", true) => filtered.OrderByDescending(d => d.Name.ToLower()).ThenBy(d => d.Id),
            ("created", false) => filtered.OrderBy(d => d.CreateDate).ThenBy(d => d.Id),
            ("created", true) => filtered.OrderByDescending(d => d.CreateDate).ThenBy(d => d.Id),
            (_, false) => filtered.OrderBy(d => d.UpdateDate).ThenBy(d => d.Id),
            _ => filtered.OrderByDescending(d => d.UpdateDate).ThenBy(d => d.Id),
        };

        var rows = await ordered.Skip((page - 1) * pageSize).Take(pageSize)
            .Select(d => new
            {
                d.Id,
                d.Name,
                d.Description,
                d.Units,
                OwnerName = d.Owner!.DisplayName,
                d.OwnerId,
                MemberRole = d.Members.Where(m => m.UserId == userId).Select(m => (ModelRole?)m.Role).FirstOrDefault(),
                Members = d.Members.Count,
                Studios = d.Studios.Count(s => s.UpdateState != SoftEntity.Deleted),
                HasThumbnail = d.Thumbnail != null,
                d.UpdateDate,
                d.CreateDate,
            })
            .AsNoTracking().ToListAsync(ct);

        return new ModelPage(
            rows.Select(r => new ModelRow(
                r.Id, r.Name, r.Description, r.Units, r.OwnerName, r.OwnerId == userId ? ModelRole.Owner : r.MemberRole ?? ModelRole.Viewer,
                r.Members, r.Studios, r.HasThumbnail, r.UpdateDate, r.CreateDate)).ToList(),
            total,
            matching);
    }

    /// <summary>The models a person worked on last (the menu).</summary>
    public static async Task<IReadOnlyList<(long Id, string Name)>> RecentAsync(AppDbContext db, long userId, int take, CancellationToken ct = default)
    {
        var rows = await ModelAccess.Visible(db, userId).OrderByDescending(d => d.UpdateDate).Take(take).Select(d => new { d.Id, d.Name }).AsNoTracking().ToListAsync(ct);
        return rows.Select(r => (r.Id, r.Name)).ToList();
    }

    /// <summary>How many models a person owns and how many are shared with them (the badges of the menu).</summary>
    public static async Task<(int Mine, int Shared)> CountsAsync(AppDbContext db, long userId, CancellationToken ct = default)
    {
        var visible = ModelAccess.Visible(db, userId);
        return (await visible.CountAsync(d => d.OwnerId == userId, ct), await visible.CountAsync(d => d.OwnerId != userId, ct));
    }

    /// <summary>A pattern for ILIKE that finds the text anywhere (its own % and _ are taken literally).</summary>
    public static string Like(string search) => $"%{search.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";

    /// <summary>Creates a model owned by <paramref name="userId"/>, with one empty Part Studio, in a folder of the person (null, or a folder not theirs = at the top).</summary>
    public static async Task<Outcome<Model>> CreateAsync(
        AppDbContext db, long userId, string name, string? description, string? units, long? folderId = null, CancellationToken ct = default)
    {
        if (Check(name, description) is { } error)
        {
            return Outcome<Model>.Fail(error);
        }

        if (folderId is { } folder && await FolderService.FindAsync(db, userId, folder, ct: ct) is null)
        {
            folderId = null;
        }

        var model = new Model
        {
            OwnerId = userId,
            Name = name.Trim(),
            Description = Clean(description),
            Units = ModelUnits.IsUnit(units) ? units! : ModelUnits.Default,
            FolderId = folderId,
            CreateUserId = userId,
        };
        model.Studios.Add(new PartStudio { Name = StudioService.DefaultName(1), Position = 0, Content = StudioContent.Empty, CreateUserId = userId });
        db.Models.Add(model);
        await db.SaveChangesAsync(ct);
        return Outcome<Model>.Success(model);
    }

    /// <summary>Changes name, description and units of a model. Owner only.</summary>
    public static async Task<Outcome<Model>> UpdateAsync(AppDbContext db, long userId, long modelId, string name, string? description, string? units, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Owner, track: true, ct: ct) is not { } access)
        {
            return Outcome<Model>.Denied();
        }

        if (Check(name, description) is { } error)
        {
            return Outcome<Model>.Fail(error);
        }

        var model = access.Model;
        model.Name = name.Trim();
        model.Description = Clean(description);
        if (ModelUnits.IsUnit(units))
        {
            model.Units = units!;
        }

        await db.SaveChangesAsync(ct);
        return Outcome<Model>.Success(model);
    }

    /// <summary>Deletes a model with its Part Studios and versions (soft: the housekeeping removes it for good later). Owner only.</summary>
    public static async Task<bool> DeleteAsync(AppDbContext db, long userId, long modelId, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Owner, track: true, ct: ct) is not { } access)
        {
            return false;
        }

        db.Models.Remove(access.Model);
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// A copy of a model (its Part Studios, not its members, versions or link) owned by the person, in the folder where they see the original. Anybody who may see the
    /// original may copy it.
    /// </summary>
    public static async Task<Outcome<Model>> DuplicateAsync(AppDbContext db, long userId, long modelId, string copyWord, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ct: ct) is not { } access)
        {
            return Outcome<Model>.Denied();
        }

        var name = $"{access.Model.Name} ({copyWord})";
        var copy = new Model
        {
            OwnerId = userId,
            Name = name.Length > NameMax ? name[..NameMax] : name,
            Description = access.Model.Description,
            Units = access.Model.Units,
            Thumbnail = access.Model.Thumbnail,
            FolderId = await FolderService.FolderOfAsync(db, userId, modelId, ct),
            CreateUserId = userId,
        };

        var studios = await db.PartStudios.AsNoTracking().Where(s => s.ModelId == modelId).OrderBy(s => s.Position).ThenBy(s => s.Id).ToListAsync(ct);
        foreach (var studio in studios)
        {
            copy.Studios.Add(new PartStudio { Name = studio.Name, Position = studio.Position, Content = studio.Content, CreateUserId = userId });
        }

        db.Models.Add(copy);
        await db.SaveChangesAsync(ct);
        return Outcome<Model>.Success(copy);
    }

    // ---- the picture of the list --------------------------------------------------------------------------------------------------

    /// <summary>Keeps the picture the editor made of the model. Editors only; anything that is not a PNG of a sensible size is refused.</summary>
    public static async Task<bool> SetThumbnailAsync(AppDbContext db, long userId, long modelId, byte[] png, CancellationToken ct = default)
    {
        if (png.Length is 0 or > ThumbnailMax || !png.AsSpan().StartsWith(PngSignature))
        {
            return false;
        }

        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Editor, ct: ct) is null)
        {
            return false;
        }

        // the picture is not a change of the design: the date of the last change stays
        await db.Models.Where(d => d.Id == modelId).ExecuteUpdateAsync(s => s.SetProperty(d => d.Thumbnail, png), ct);
        return true;
    }

    /// <summary>The picture of a model for somebody who may see it, or <c>null</c>.</summary>
    public static async Task<byte[]?> ThumbnailAsync(AppDbContext db, Actor actor, long modelId, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, actor, modelId, ct: ct) is null)
        {
            return null;
        }

        return await db.Models.AsNoTracking().Where(d => d.Id == modelId).Select(d => d.Thumbnail).FirstOrDefaultAsync(ct);
    }

    // ---- members ------------------------------------------------------------------------------------------------------------------

    /// <summary>The people a model is shared with. Owner only.</summary>
    public static async Task<IReadOnlyList<MemberRow>?> MembersAsync(AppDbContext db, long userId, long modelId, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Owner, ct: ct) is null)
        {
            return null;
        }

        var rows = await db.ModelMembers.AsNoTracking().Where(m => m.ModelId == modelId)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, m.Role }).ToListAsync(ct);
        return rows.OrderBy(r => r.DisplayName, StringComparer.CurrentCultureIgnoreCase).Select(r => new MemberRow(r.UserId, r.DisplayName, r.Email, r.Role)).ToList();
    }

    /// <summary>Shares a model with the person who has this address. Owner only; the role is viewer or editor.</summary>
    public static async Task<Outcome<MemberRow>> AddMemberAsync(AppDbContext db, long userId, long modelId, string email, ModelRole role, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Owner, ct: ct) is not { } access)
        {
            return Outcome<MemberRow>.Denied();
        }

        if (role is not (ModelRole.Viewer or ModelRole.Editor))
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.RoleInvalid"));
        }

        var address = AccountService.Normalize(email);
        var person = await db.Users.AsNoTracking().Where(u => u.Email == address && u.IsActive).Select(u => new { u.Id, u.DisplayName, u.Email }).FirstOrDefaultAsync(ct);
        if (person is null)
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.NoAccount"));
        }

        if (person.Id == access.Model.OwnerId)
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.IsOwner"));
        }

        if (await db.ModelMembers.AnyAsync(m => m.ModelId == modelId && m.UserId == person.Id, ct))
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.AlreadyMember"));
        }

        db.ModelMembers.Add(new ModelMember { ModelId = modelId, UserId = person.Id, Role = role, CreateUserId = userId });
        await db.SaveChangesAsync(ct);
        return Outcome<MemberRow>.Success(new MemberRow(person.Id, person.DisplayName, person.Email, role));
    }

    /// <summary>Gives a member another role. Owner only.</summary>
    public static async Task<bool> SetMemberRoleAsync(AppDbContext db, long userId, long modelId, long memberUserId, ModelRole role, CancellationToken ct = default)
    {
        if (role is not (ModelRole.Viewer or ModelRole.Editor)
            || await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Owner, ct: ct) is null)
        {
            return false;
        }

        var member = await db.ModelMembers.FirstOrDefaultAsync(m => m.ModelId == modelId && m.UserId == memberUserId, ct);
        if (member is null)
        {
            return false;
        }

        member.Role = role;
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Takes a person off a model: the owner removes anybody, a member removes themselves (leaves).</summary>
    public static async Task<bool> RemoveMemberAsync(AppDbContext db, long userId, long modelId, long memberUserId, CancellationToken ct = default)
    {
        var model = await db.Models.AsNoTracking().FirstOrDefaultAsync(d => d.Id == modelId, ct);
        if (model is null || (model.OwnerId != userId && memberUserId != userId))
        {
            return false;
        }

        var removed = await db.ModelMembers.Where(m => m.ModelId == modelId && m.UserId == memberUserId).ExecuteDeleteAsync(ct);
        return removed > 0;
    }

    // ---- the link -----------------------------------------------------------------------------------------------------------------

    /// <summary>Switches the link of a model (off, view) and, when asked, makes a new secret so the old address stops working. Owner only.</summary>
    public static async Task<Model?> SetLinkAsync(AppDbContext db, long userId, long modelId, LinkMode mode, bool renew, CancellationToken ct = default)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(userId), modelId, ModelRole.Owner, track: true, ct: ct) is not { } access)
        {
            return null;
        }

        access.Model.LinkMode = mode;
        if (renew)
        {
            access.Model.ShareToken = Guid.NewGuid();
        }

        await db.SaveChangesAsync(ct);
        return access.Model;
    }

    /// <summary>Does the person want a mail when a model is shared with them?</summary>
    public static async Task<bool> WantsShareMailAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.MailOnShare).FirstOrDefaultAsync(ct);

    /// <summary>The language of a person (their account, else the default of the app): the language their mails are written in.</summary>
    public static async Task<string> LanguageOfAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => Languages.Normalize(await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Language).FirstOrDefaultAsync(ct));

    /// <summary>The unit a person starts new models with.</summary>
    public static async Task<string> DefaultUnitsAsync(AppDbContext db, long userId, CancellationToken ct = default)
    {
        var units = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DefaultUnits).FirstOrDefaultAsync(ct);
        return ModelUnits.IsUnit(units) ? units! : ModelUnits.Default;
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

    private static string? Clean(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
