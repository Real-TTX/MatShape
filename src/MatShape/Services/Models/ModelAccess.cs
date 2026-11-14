using MatShape.Data;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Models;

/// <summary>
/// Who asks: a signed-in person, somebody who holds the link of a model (a guest, <see cref="UserId"/> is null) or both (a person who opens the link of a model
/// they are a member of gets the better of the two).
/// </summary>
public readonly record struct Actor(long? UserId, Guid? LinkToken = null)
{
    public static Actor Of(long userId) => new(userId);

    public static Actor Guest(Guid token) => new(null, token);

    public Actor WithLink(Guid token) => this with { LinkToken = token };
}

/// <summary>A model together with what the asking person may do with it.</summary>
public sealed record ModelAccessInfo(Model Model, ModelRole Role)
{
    public bool CanEdit => Role >= ModelRole.Editor;

    public bool IsOwner => Role == ModelRole.Owner;
}

/// <summary>
/// The one place that decides who may see and change a model. Every function of the business layer starts here. A model the person may not see answers
/// <c>null</c> exactly like one that does not exist, so nobody learns which models exist. The administrator of the installation has no access to the models
/// of others: a design is private to its owner and the people it is shared with.
/// </summary>
public static class ModelAccess
{
    /// <summary>
    /// The model with the role of <paramref name="actor"/> on it, or <c>null</c> when it does not exist or the role is below <paramref name="minimum"/>.
    /// The returned model is not tracked unless <paramref name="track"/> is set.
    /// </summary>
    public static async Task<ModelAccessInfo?> FindAsync(AppDbContext db, Actor actor, long modelId, ModelRole minimum = ModelRole.Viewer, bool track = false, CancellationToken ct = default)
    {
        var query = track ? db.Models : db.Models.AsNoTracking();
        var model = await query.FirstOrDefaultAsync(d => d.Id == modelId, ct);
        if (model is null)
        {
            return null;
        }

        var role = await RoleAsync(db, actor, model, ct);
        return role >= minimum && role > ModelRole.None ? new ModelAccessInfo(model, role) : null;
    }

    /// <summary>The model a link opens (with the role the link gives), or <c>null</c> when no model has this link or it is switched off.</summary>
    public static async Task<ModelAccessInfo?> FindByLinkAsync(AppDbContext db, Guid token, CancellationToken ct = default)
    {
        var model = await db.Models.AsNoTracking().FirstOrDefaultAsync(d => d.ShareToken == token && d.LinkMode != LinkMode.Off, ct);
        return model is null ? null : new ModelAccessInfo(model, LinkRole(model.LinkMode));
    }

    /// <summary>The role of the actor on a model: the owner, a member, the link, whichever is best.</summary>
    public static async Task<ModelRole> RoleAsync(AppDbContext db, Actor actor, Model model, CancellationToken ct = default)
    {
        var role = ModelRole.None;
        if (actor.UserId is { } userId)
        {
            if (model.OwnerId == userId)
            {
                return ModelRole.Owner;
            }

            var member = await db.ModelMembers.AsNoTracking()
                .Where(m => m.ModelId == model.Id && m.UserId == userId)
                .Select(m => (ModelRole?)m.Role)
                .FirstOrDefaultAsync(ct);
            if (member is { } memberRole)
            {
                role = memberRole;
            }
        }

        if (actor.LinkToken is { } token && token == model.ShareToken && LinkRole(model.LinkMode) > role)
        {
            role = LinkRole(model.LinkMode);
        }

        return role;
    }

    /// <summary>The role a link gives: looking only.</summary>
    public static ModelRole LinkRole(LinkMode mode) => mode == LinkMode.View ? ModelRole.Viewer : ModelRole.None;

    /// <summary>The models a person owns or is a member of.</summary>
    public static IQueryable<Model> Visible(AppDbContext db, long userId)
        => db.Models.Where(d => d.OwnerId == userId || d.Members.Any(m => m.UserId == userId));
}
