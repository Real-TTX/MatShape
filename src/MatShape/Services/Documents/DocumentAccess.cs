using MatShape.Data;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Documents;

/// <summary>
/// Who asks: a signed-in person, somebody who holds the link of a document (a guest, <see cref="UserId"/> is null) or both (a person who opens the link of a document
/// they are a member of gets the better of the two).
/// </summary>
public readonly record struct Actor(long? UserId, Guid? LinkToken = null)
{
    public static Actor Of(long userId) => new(userId);

    public static Actor Guest(Guid token) => new(null, token);

    public Actor WithLink(Guid token) => this with { LinkToken = token };
}

/// <summary>A document together with what the asking person may do with it.</summary>
public sealed record DocumentAccessInfo(Document Document, DocumentRole Role)
{
    public bool CanEdit => Role >= DocumentRole.Editor;

    public bool IsOwner => Role == DocumentRole.Owner;
}

/// <summary>
/// The one place that decides who may see and change a document. Every function of the business layer starts here. A document the person may not see answers
/// <c>null</c> exactly like one that does not exist, so nobody learns which documents exist. The administrator of the installation has no access to the documents
/// of others: a design is private to its owner and the people it is shared with.
/// </summary>
public static class DocumentAccess
{
    /// <summary>
    /// The document with the role of <paramref name="actor"/> on it, or <c>null</c> when it does not exist or the role is below <paramref name="minimum"/>.
    /// The returned document is not tracked unless <paramref name="track"/> is set.
    /// </summary>
    public static async Task<DocumentAccessInfo?> FindAsync(AppDbContext db, Actor actor, long documentId, DocumentRole minimum = DocumentRole.Viewer, bool track = false, CancellationToken ct = default)
    {
        var query = track ? db.Documents : db.Documents.AsNoTracking();
        var document = await query.FirstOrDefaultAsync(d => d.Id == documentId, ct);
        if (document is null)
        {
            return null;
        }

        var role = await RoleAsync(db, actor, document, ct);
        return role >= minimum && role > DocumentRole.None ? new DocumentAccessInfo(document, role) : null;
    }

    /// <summary>The document a link opens (with the role the link gives), or <c>null</c> when no document has this link or it is switched off.</summary>
    public static async Task<DocumentAccessInfo?> FindByLinkAsync(AppDbContext db, Guid token, CancellationToken ct = default)
    {
        var document = await db.Documents.AsNoTracking().FirstOrDefaultAsync(d => d.ShareToken == token && d.LinkMode != LinkMode.Off, ct);
        return document is null ? null : new DocumentAccessInfo(document, LinkRole(document.LinkMode));
    }

    /// <summary>The role of the actor on a document: the owner, a member, the link, whichever is best.</summary>
    public static async Task<DocumentRole> RoleAsync(AppDbContext db, Actor actor, Document document, CancellationToken ct = default)
    {
        var role = DocumentRole.None;
        if (actor.UserId is { } userId)
        {
            if (document.OwnerId == userId)
            {
                return DocumentRole.Owner;
            }

            var member = await db.DocumentMembers.AsNoTracking()
                .Where(m => m.DocumentId == document.Id && m.UserId == userId)
                .Select(m => (DocumentRole?)m.Role)
                .FirstOrDefaultAsync(ct);
            if (member is { } memberRole)
            {
                role = memberRole;
            }
        }

        if (actor.LinkToken is { } token && token == document.ShareToken && LinkRole(document.LinkMode) > role)
        {
            role = LinkRole(document.LinkMode);
        }

        return role;
    }

    /// <summary>The role a link gives: looking only.</summary>
    public static DocumentRole LinkRole(LinkMode mode) => mode == LinkMode.View ? DocumentRole.Viewer : DocumentRole.None;

    /// <summary>The documents a person owns or is a member of.</summary>
    public static IQueryable<Document> Visible(AppDbContext db, long userId)
        => db.Documents.Where(d => d.OwnerId == userId || d.Members.Any(m => m.UserId == userId));
}
