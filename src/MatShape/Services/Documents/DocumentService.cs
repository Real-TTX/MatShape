using MatShape.Data;
using MatShape.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Documents;

/// <summary>One row of the list of documents.</summary>
public sealed record DocumentRow(
    long Id, string Name, string? Description, string Units, string OwnerName, DocumentRole Role, int Members, int Studios, bool HasThumbnail, DateTime UpdateDate, DateTime CreateDate)
{
    public bool Mine => Role == DocumentRole.Owner;
}

/// <summary>What the list of documents is asked for: <c>Scope</c> is <c>all</c>, <c>mine</c> or <c>shared</c>; <c>Sort</c> is <c>name</c>, <c>changed</c> or <c>created</c>.</summary>
public sealed record DocumentQuery(string? Search, string? Scope, string Sort, bool Descending);

public sealed record DocumentPage(IReadOnlyList<DocumentRow> Rows, int Total, int Matching);

/// <summary>A person a document is shared with, as the owner sees them.</summary>
public sealed record MemberRow(long UserId, string Name, string Email, DocumentRole Role);

/// <summary>
/// The documents: list, create, change, delete, copy, who they are shared with, the link and the picture of the list. Every function checks the right of the person first
/// (<see cref="DocumentAccess"/>); nothing here trusts the page. Only the owner changes a document's settings, its members and its link.
/// </summary>
public static class DocumentService
{
    public const int NameMax = 120;
    public const int DescriptionMax = 1000;

    /// <summary>The largest picture of a document that is kept (a PNG of a few hundred pixels is far smaller).</summary>
    public const int ThumbnailMax = 400_000;

    private static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>The documents a person sees, filtered, sorted and cut to a page.</summary>
    public static async Task<DocumentPage> ListAsync(AppDbContext db, long userId, DocumentQuery query, int page, int pageSize, CancellationToken ct = default)
    {
        var visible = DocumentAccess.Visible(db, userId);
        var total = await visible.CountAsync(ct);

        var filtered = visible;
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var like = $"%{query.Search.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";
            filtered = filtered.Where(d => EF.Functions.ILike(d.Name, like) || (d.Description != null && EF.Functions.ILike(d.Description, like)));
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
                MemberRole = d.Members.Where(m => m.UserId == userId).Select(m => (DocumentRole?)m.Role).FirstOrDefault(),
                Members = d.Members.Count,
                Studios = d.Studios.Count(s => s.UpdateState != SoftEntity.Deleted),
                HasThumbnail = d.Thumbnail != null,
                d.UpdateDate,
                d.CreateDate,
            })
            .AsNoTracking().ToListAsync(ct);

        return new DocumentPage(
            rows.Select(r => new DocumentRow(
                r.Id, r.Name, r.Description, r.Units, r.OwnerName, r.OwnerId == userId ? DocumentRole.Owner : r.MemberRole ?? DocumentRole.Viewer,
                r.Members, r.Studios, r.HasThumbnail, r.UpdateDate, r.CreateDate)).ToList(),
            total,
            matching);
    }

    /// <summary>The documents a person worked on last (the menu).</summary>
    public static async Task<IReadOnlyList<(long Id, string Name)>> RecentAsync(AppDbContext db, long userId, int take, CancellationToken ct = default)
    {
        var rows = await DocumentAccess.Visible(db, userId).OrderByDescending(d => d.UpdateDate).Take(take).Select(d => new { d.Id, d.Name }).AsNoTracking().ToListAsync(ct);
        return rows.Select(r => (r.Id, r.Name)).ToList();
    }

    /// <summary>How many documents a person owns and how many are shared with them (the badges of the menu).</summary>
    public static async Task<(int Mine, int Shared)> CountsAsync(AppDbContext db, long userId, CancellationToken ct = default)
    {
        var visible = DocumentAccess.Visible(db, userId);
        return (await visible.CountAsync(d => d.OwnerId == userId, ct), await visible.CountAsync(d => d.OwnerId != userId, ct));
    }

    /// <summary>Creates a document owned by <paramref name="userId"/>, with one empty Part Studio.</summary>
    public static async Task<Outcome<Document>> CreateAsync(AppDbContext db, long userId, string name, string? description, string? units, CancellationToken ct = default)
    {
        if (Check(name, description) is { } error)
        {
            return Outcome<Document>.Fail(error);
        }

        var document = new Document
        {
            OwnerId = userId,
            Name = name.Trim(),
            Description = Clean(description),
            Units = DocumentUnits.IsUnit(units) ? units! : DocumentUnits.Default,
            CreateUserId = userId,
        };
        document.Studios.Add(new PartStudio { Name = StudioService.DefaultName(1), Position = 0, Content = StudioContent.Empty, CreateUserId = userId });
        db.Documents.Add(document);
        await db.SaveChangesAsync(ct);
        return Outcome<Document>.Success(document);
    }

    /// <summary>Changes name, description and units of a document. Owner only.</summary>
    public static async Task<Outcome<Document>> UpdateAsync(AppDbContext db, long userId, long documentId, string name, string? description, string? units, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Owner, track: true, ct: ct) is not { } access)
        {
            return Outcome<Document>.Denied();
        }

        if (Check(name, description) is { } error)
        {
            return Outcome<Document>.Fail(error);
        }

        var document = access.Document;
        document.Name = name.Trim();
        document.Description = Clean(description);
        if (DocumentUnits.IsUnit(units))
        {
            document.Units = units!;
        }

        await db.SaveChangesAsync(ct);
        return Outcome<Document>.Success(document);
    }

    /// <summary>Deletes a document with its Part Studios and versions (soft: the housekeeping removes it for good later). Owner only.</summary>
    public static async Task<bool> DeleteAsync(AppDbContext db, long userId, long documentId, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Owner, track: true, ct: ct) is not { } access)
        {
            return false;
        }

        db.Documents.Remove(access.Document);
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>A copy of a document (its Part Studios, not its members, versions or link) owned by the person. Anybody who may see the original may copy it.</summary>
    public static async Task<Outcome<Document>> DuplicateAsync(AppDbContext db, long userId, long documentId, string copyWord, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, ct: ct) is not { } access)
        {
            return Outcome<Document>.Denied();
        }

        var name = $"{access.Document.Name} ({copyWord})";
        var copy = new Document
        {
            OwnerId = userId,
            Name = name.Length > NameMax ? name[..NameMax] : name,
            Description = access.Document.Description,
            Units = access.Document.Units,
            Thumbnail = access.Document.Thumbnail,
            CreateUserId = userId,
        };

        var studios = await db.PartStudios.AsNoTracking().Where(s => s.DocumentId == documentId).OrderBy(s => s.Position).ThenBy(s => s.Id).ToListAsync(ct);
        foreach (var studio in studios)
        {
            copy.Studios.Add(new PartStudio { Name = studio.Name, Position = studio.Position, Content = studio.Content, CreateUserId = userId });
        }

        db.Documents.Add(copy);
        await db.SaveChangesAsync(ct);
        return Outcome<Document>.Success(copy);
    }

    // ---- the picture of the list --------------------------------------------------------------------------------------------------

    /// <summary>Keeps the picture the editor made of the model. Editors only; anything that is not a PNG of a sensible size is refused.</summary>
    public static async Task<bool> SetThumbnailAsync(AppDbContext db, long userId, long documentId, byte[] png, CancellationToken ct = default)
    {
        if (png.Length is 0 or > ThumbnailMax || !png.AsSpan().StartsWith(PngSignature))
        {
            return false;
        }

        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Editor, ct: ct) is null)
        {
            return false;
        }

        // the picture is not a change of the design: the date of the last change stays
        await db.Documents.Where(d => d.Id == documentId).ExecuteUpdateAsync(s => s.SetProperty(d => d.Thumbnail, png), ct);
        return true;
    }

    /// <summary>The picture of a document for somebody who may see it, or <c>null</c>.</summary>
    public static async Task<byte[]?> ThumbnailAsync(AppDbContext db, Actor actor, long documentId, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, actor, documentId, ct: ct) is null)
        {
            return null;
        }

        return await db.Documents.AsNoTracking().Where(d => d.Id == documentId).Select(d => d.Thumbnail).FirstOrDefaultAsync(ct);
    }

    // ---- members ------------------------------------------------------------------------------------------------------------------

    /// <summary>The people a document is shared with. Owner only.</summary>
    public static async Task<IReadOnlyList<MemberRow>?> MembersAsync(AppDbContext db, long userId, long documentId, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Owner, ct: ct) is null)
        {
            return null;
        }

        var rows = await db.DocumentMembers.AsNoTracking().Where(m => m.DocumentId == documentId)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, m.Role }).ToListAsync(ct);
        return rows.OrderBy(r => r.DisplayName, StringComparer.CurrentCultureIgnoreCase).Select(r => new MemberRow(r.UserId, r.DisplayName, r.Email, r.Role)).ToList();
    }

    /// <summary>Shares a document with the person who has this address. Owner only; the role is viewer or editor.</summary>
    public static async Task<Outcome<MemberRow>> AddMemberAsync(AppDbContext db, long userId, long documentId, string email, DocumentRole role, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Owner, ct: ct) is not { } access)
        {
            return Outcome<MemberRow>.Denied();
        }

        if (role is not (DocumentRole.Viewer or DocumentRole.Editor))
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.RoleInvalid"));
        }

        var address = AccountService.Normalize(email);
        var person = await db.Users.AsNoTracking().Where(u => u.Email == address && u.IsActive).Select(u => new { u.Id, u.DisplayName, u.Email }).FirstOrDefaultAsync(ct);
        if (person is null)
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.NoAccount"));
        }

        if (person.Id == access.Document.OwnerId)
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.IsOwner"));
        }

        if (await db.DocumentMembers.AnyAsync(m => m.DocumentId == documentId && m.UserId == person.Id, ct))
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.AlreadyMember"));
        }

        db.DocumentMembers.Add(new DocumentMember { DocumentId = documentId, UserId = person.Id, Role = role, CreateUserId = userId });
        await db.SaveChangesAsync(ct);
        return Outcome<MemberRow>.Success(new MemberRow(person.Id, person.DisplayName, person.Email, role));
    }

    /// <summary>Gives a member another role. Owner only.</summary>
    public static async Task<bool> SetMemberRoleAsync(AppDbContext db, long userId, long documentId, long memberUserId, DocumentRole role, CancellationToken ct = default)
    {
        if (role is not (DocumentRole.Viewer or DocumentRole.Editor)
            || await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Owner, ct: ct) is null)
        {
            return false;
        }

        var member = await db.DocumentMembers.FirstOrDefaultAsync(m => m.DocumentId == documentId && m.UserId == memberUserId, ct);
        if (member is null)
        {
            return false;
        }

        member.Role = role;
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Takes a person off a document: the owner removes anybody, a member removes themselves (leaves).</summary>
    public static async Task<bool> RemoveMemberAsync(AppDbContext db, long userId, long documentId, long memberUserId, CancellationToken ct = default)
    {
        var document = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.Id == documentId, ct);
        if (document is null || (document.OwnerId != userId && memberUserId != userId))
        {
            return false;
        }

        var removed = await db.DocumentMembers.Where(m => m.DocumentId == documentId && m.UserId == memberUserId).ExecuteDeleteAsync(ct);
        return removed > 0;
    }

    // ---- the link -----------------------------------------------------------------------------------------------------------------

    /// <summary>Switches the link of a document (off, view) and, when asked, makes a new secret so the old address stops working. Owner only.</summary>
    public static async Task<Document?> SetLinkAsync(AppDbContext db, long userId, long documentId, LinkMode mode, bool renew, CancellationToken ct = default)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(userId), documentId, DocumentRole.Owner, track: true, ct: ct) is not { } access)
        {
            return null;
        }

        access.Document.LinkMode = mode;
        if (renew)
        {
            access.Document.ShareToken = Guid.NewGuid();
        }

        await db.SaveChangesAsync(ct);
        return access.Document;
    }

    /// <summary>Does the person want a mail when a document is shared with them?</summary>
    public static async Task<bool> WantsShareMailAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.MailOnShare).FirstOrDefaultAsync(ct);

    /// <summary>The language of a person (their account, else the default of the app): the language their mails are written in.</summary>
    public static async Task<string> LanguageOfAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => Languages.Normalize(await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Language).FirstOrDefaultAsync(ct));

    /// <summary>The unit a person starts new documents with.</summary>
    public static async Task<string> DefaultUnitsAsync(AppDbContext db, long userId, CancellationToken ct = default)
    {
        var units = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DefaultUnits).FirstOrDefaultAsync(ct);
        return DocumentUnits.IsUnit(units) ? units! : DocumentUnits.Default;
    }

    private static string? Check(string name, string? description)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return Text.T("Common.NameRequired");
        }

        if (name.Trim().Length > NameMax)
        {
            return Text.T("Documents.NameTooLong", NameMax);
        }

        return description is { Length: > DescriptionMax } ? Text.T("Documents.DescriptionTooLong", DescriptionMax) : null;
    }

    private static string? Clean(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
